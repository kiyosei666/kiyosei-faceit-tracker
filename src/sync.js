const { pool, ensureSchema } = require("./db");
const { faceitGet, getPlayerOutcome, getPlayerMatchStats, classifyMatchStats } = require("./faceit");
const { persistMatches } = require("./tracker");

const NICKNAME = () => process.env.FACEIT_NICKNAME || "kiyosei";
const GAME = "cs2";
const PAGE_SIZE = 100; // documented FACEIT maximum per history request
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_KEY = 727002;

async function getState(key) {
  const r = await pool.query("SELECT value FROM sync_state WHERE key = $1", [key]);
  return r.rows[0]?.value || null;
}

async function setState(key, value) {
  await pool.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// Only one sync/import runs at a time (cron overlap, double clicks, etc.).
async function withLock(fn) {
  const client = await pool.connect();
  try {
    const got = (await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY])).rows[0].ok;
    if (!got) { const e = new Error("Another sync is already running."); e.status = 409; throw e; }
    try { return await fn(); }
    finally { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {}); }
  } finally { client.release(); }
}

async function startRun(kind) {
  const r = await pool.query("INSERT INTO sync_runs (kind) VALUES ($1) RETURNING id", [kind]);
  return r.rows[0].id;
}

async function finishRun(id, status, seen, saved, error) {
  await pool.query(
    "UPDATE sync_runs SET status=$2, finished_at=NOW(), matches_seen=$3, matches_saved=$4, error=$5 WHERE id=$1",
    [id, status, seen, saved, error ? String(error).slice(0, 500) : null]
  );
}

async function loadPlayer() {
  const player = await faceitGet(`/players?nickname=${encodeURIComponent(NICKNAME())}&game=${GAME}`);
  if (!player.player_id) throw new Error("FACEIT did not return a player ID for this nickname.");
  return player;
}

// Incremental sync: newest 100 matches, deduplicated by match_id.
async function syncRecent() {
  if (!(await ensureSchema())) { const e = new Error("Database is not configured."); e.status = 503; throw e; }
  return withLock(async () => {
    const runId = await startRun("recent");
    let seen = 0, saved = 0;
    try {
      const player = await loadPlayer();
      const history = await faceitGet(`/players/${player.player_id}/history?game=${GAME}&offset=0&limit=${PAGE_SIZE}`);
      const game = player.games?.[GAME] || {};
      seen = (history.items || []).length;
      const result = await persistMatches(history.items || [], player.player_id, player.nickname || NICKNAME(), game.faceit_elo);
      saved = result.saved;
      await finishRun(runId, "ok", seen, saved, null);
      await setState("last_success", { at: new Date().toISOString(), kind: "recent", seen, saved });
      return { ok: true, seen, saved };
    } catch (error) {
      await finishRun(runId, "error", seen, saved, error.message);
      throw error;
    }
  });
}

/**
 * Fetch stats for a match.
 * Classification rules:
 * - Confirmed HTTP 404 responses are classified as 'unavailable'.
 * - Valid responses containing player stats are classified as 'available'.
 * - HTTP 200 responses with missing rounds, missing player entries, malformed structures,
 *   or unexpected payloads must NOT automatically be marked 'unavailable'.
 *   Instead, they remain 'pending' so they can be retried on subsequent sync/backfill runs.
 * - Transient errors (429, 5xx, timeout, network failure) re-throw so the caller can retry/abort.
 */
async function fetchMatchStatsSafe(matchId, playerId, nickname) {
  try {
    const statsData = await faceitGet(`/matches/${encodeURIComponent(matchId)}/stats`);
    const parsed = getPlayerMatchStats(statsData, playerId, nickname);
    return classifyMatchStats(parsed);
  } catch (error) {
    return classifyMatchStats(null, error);
  }
}

/**
 * Resumable career import.
 *
 * Pagination behavior:
 * - Walks backwards in time using FACEIT's `to` parameter (timestamp).
 * - Since `to` is inclusive on FACEIT, the boundary match can repeat on the next page.
 * - Durable tracking of seen boundary matches and consecutive stalls across resumed runs:
 *   - `state.seenBoundaryIds`: array of match IDs from recent pages to detect duplicate pages.
 *   - `state.consecutiveStalls`: count of stalls persisted in sync_state so resumption does not loop.
 * - Completion rules:
 *   - An empty page (`items.length === 0`) confirms exhaustion -> `done = true`.
 *   - A short page (`items.length < PAGE_SIZE`) only marks completion if probe confirmed no new matches,
 *     or if the oldest timestamp cannot progress and no new matches appeared in the page.
 *   - Timestamp ties (multiple matches at identical timestamp) do not cause premature completion.
 *
 * Atomicity:
 * - History items and their stats are fetched outside DB transaction.
 * - DB insertion for all matches in the page + cursor & state update occur inside a single client transaction.
 * - Rollback on any failure ensures no partial page commits or desynced cursor.
 * - Supports repairing previously imported matches with pending statistics.
 */
async function importCareer({ maxPages = 5, delayMs = 250, backfillPending = true } = {}) {
  if (!(await ensureSchema())) { const e = new Error("Database is not configured."); e.status = 503; throw e; }
  return withLock(async () => {
    const runId = await startRun("career_import");
    let totalSeen = 0, totalSaved = 0, totalRepaired = 0;
    try {
      const player = await loadPlayer();
      const nickname = player.nickname || NICKNAME();
      const state = (await getState("career_import")) || {
        done: false,
        cursor: null,
        pages: 0,
        imported: 0,
        seenBoundaryIds: [],
        consecutiveStalls: 0
      };

      if (!Array.isArray(state.seenBoundaryIds)) {
        state.seenBoundaryIds = [];
      }
      if (typeof state.consecutiveStalls !== "number") {
        state.consecutiveStalls = 0;
      }

      if (state.done && !backfillPending) {
        await finishRun(runId, "ok", 0, 0, null);
        return { ok: true, done: true, seen: 0, saved: 0, state };
      }

      // Step A: Backfill any existing pending stats matches (if requested and present)
      // Uses deterministic ordering to avoid starvation and processes each match independently.
      // Transient failures on one match do NOT stop other pending matches from being attempted.
      if (backfillPending) {
        const pendingRows = await pool.query(
          `SELECT match_id, map, score FROM faceit_matches
           WHERE stats_status = 'pending'
           ORDER BY finished_at DESC NULLS LAST, match_id ASC
           LIMIT 50`
        );
        for (const row of pendingRows.rows) {
          try {
            const res = await fetchMatchStatsSafe(row.match_id, player.player_id, nickname);
            // If successfully fetched as available or confirmed unavailable, update DB
            if (res.status === "available" || res.status === "unavailable") {
              await pool.query(
                `UPDATE faceit_matches
                 SET stats = $1, stats_status = $2, map = COALESCE($3, map), score = COALESCE($4, score)
                 WHERE match_id = $5`,
                [res.stats ? JSON.stringify(res.stats) : null, res.status, res.map, res.score, row.match_id]
              );
              totalRepaired++;
            }
            await sleep(delayMs);
          } catch (err) {
            // Transient failure on this specific match: log warning and continue to next pending match
            console.warn(`Backfill skipped temporarily for match ${row.match_id}: ${err.message}`);
          }
        }
      }

      if (state.done) {
        await finishRun(runId, "ok", 0, totalSaved, null);
        return { ok: true, done: true, seen: 0, saved: totalSaved, repaired: totalRepaired, state };
      }

      const durableSeen = new Set(state.seenBoundaryIds);

      for (let page = 0; page < maxPages; page++) {
        const q = `/players/${player.player_id}/history?game=${GAME}&limit=${PAGE_SIZE}` +
          (state.cursor ? `&to=${state.cursor}` : "&offset=0");

        const history = await faceitGet(q);
        const items = history.items || [];
        totalSeen += items.length;

        // Evidence of exhaustion: empty response from API
        if (!items.length) {
          state.done = true;
          await setState("career_import", state);
          break;
        }

        const pageItemIds = items.map((i) => i.match_id).filter(Boolean);
        const newInThisPage = pageItemIds.filter((id) => !durableSeen.has(id));
        pageItemIds.forEach((id) => durableSeen.add(id));
        state.seenBoundaryIds = Array.from(durableSeen).slice(-500); // keep recent boundary ids bounded

        // Find existing matches in database
        const existingRows = await pool.query(
          "SELECT match_id, stats_status FROM faceit_matches WHERE match_id = ANY($1)",
          [pageItemIds]
        );
        const existingMap = new Map(existingRows.rows.map((r) => [r.match_id, r.stats_status]));

        // Fetch stats for unimported or pending matches outside DB transaction
        const preparedBatch = [];
        for (const item of items) {
          if (!item.match_id) continue;
          const statusInDb = existingMap.get(item.match_id);

          if (statusInDb === "available" || statusInDb === "unavailable") {
            continue;
          }

          let stats = null, map = item.map || item.competition_name || "FACEIT match", score = null;
          let statsStatus = "pending";

          try {
            const res = await fetchMatchStatsSafe(item.match_id, player.player_id, nickname);
            stats = res.stats;
            map = res.map || map;
            score = res.score || score;
            statsStatus = res.status;
          } catch (error) {
            // Transient error: do not proceed with committing a broken page
            throw new Error(`Failed fetching stats for match ${item.match_id}: ${error.message}`);
          }

          preparedBatch.push({
            matchId: item.match_id,
            finishedAt: item.finished_at || null,
            startedAt: item.started_at || null,
            map,
            outcome: getPlayerOutcome(item, player.player_id),
            score,
            stats: stats ? JSON.stringify(stats) : null,
            statsStatus
          });

          await sleep(delayMs);
        }

        // Calculate oldest timestamp for pagination cursor
        const timestamps = items
          .map((i) => Number(i.started_at || i.finished_at))
          .filter(Number.isFinite);
        const oldestTimestamp = timestamps.length ? Math.min(...timestamps) : null;

        // Execute atomic database transaction for this page
        const client = await pool.connect();
        let pageSavedCount = 0;
        try {
          await client.query("BEGIN");

          for (const match of preparedBatch) {
            const r = await client.query(
              `INSERT INTO faceit_matches
                (match_id, finished_at, started_at, map, outcome, score, stats, stats_status, source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'career_import')
               ON CONFLICT (match_id) DO UPDATE SET
                 stats = COALESCE(EXCLUDED.stats, faceit_matches.stats),
                 stats_status = EXCLUDED.stats_status,
                 map = COALESCE(EXCLUDED.map, faceit_matches.map),
                 score = COALESCE(EXCLUDED.score, faceit_matches.score)
               WHERE faceit_matches.stats_status = 'pending'`,
              [match.matchId, match.finishedAt, match.startedAt, match.map,
               match.outcome, match.score, match.stats, match.statsStatus]
            );
            if (r.rowCount > 0 && !existingMap.has(match.matchId)) {
              pageSavedCount++;
            }
          }

          state.pages += 1;
          state.imported += pageSavedCount;
          totalSaved += pageSavedCount;

          // Check stopping / loop conditions
          if (oldestTimestamp === null) {
            state.done = true;
          } else if (state.cursor && oldestTimestamp >= Number(state.cursor)) {
            // Oldest timestamp did not move backwards (e.g. boundary repeat or timestamp tie)
            if (newInThisPage.length === 0) {
              state.consecutiveStalls = (state.consecutiveStalls || 0) + 1;
              if (state.consecutiveStalls >= 2) {
                // Verified repeated page with zero new matches across invocations -> finished
                state.done = true;
              }
            } else {
              state.consecutiveStalls = 0;
            }
          } else {
            state.consecutiveStalls = 0;
            state.cursor = oldestTimestamp;
          }

          // If a page returns fewer than PAGE_SIZE items, verify whether any new items were found.
          // If no new items exist on a short page, history is exhausted.
          // Otherwise, if new items were found, advance cursor and do not prematurely mark done
          // unless the subsequent request confirms 0 items or stall.
          if (items.length < PAGE_SIZE && newInThisPage.length === 0) {
            state.done = true;
          }

          await client.query(
            `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            ["career_import", JSON.stringify(state)]
          );

          await client.query("COMMIT");
        } catch (dbError) {
          await client.query("ROLLBACK").catch(() => {});
          throw dbError;
        } finally {
          client.release();
        }

        if (state.done) break;
      }

      await finishRun(runId, "ok", totalSeen, totalSaved, null);
      return { ok: true, done: Boolean(state.done), seen: totalSeen, saved: totalSaved, repaired: totalRepaired, state };
    } catch (error) {
      await finishRun(runId, "error", totalSeen, totalSaved, error.message);
      throw error;
    }
  });
}

async function syncStatus() {
  if (!(await ensureSchema())) return { configured: false };
  const [runs, last, career, counts] = await Promise.all([
    pool.query("SELECT id, kind, status, started_at, finished_at, matches_seen, matches_saved, error FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 10"),
    getState("last_success"), getState("career_import"),
    pool.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE source = 'career_import')::int AS imported,
      COUNT(*) FILTER (WHERE stats_status = 'pending')::int AS pending_stats,
      COUNT(*) FILTER (WHERE stats_status = 'unavailable')::int AS unavailable_stats,
      COUNT(*) FILTER (WHERE stats_status = 'available')::int AS available_stats
      FROM faceit_matches`)
  ]);
  return { configured: true, lastSuccess: last, careerImport: career, matches: counts.rows[0], recentRuns: runs.rows };
}

module.exports = { syncRecent, importCareer, syncStatus, fetchMatchStatsSafe };
