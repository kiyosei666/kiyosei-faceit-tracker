const { pool, ensureSchema } = require("./db");
const { faceitGet, getPlayerOutcome, getPlayerMatchStats } = require("./faceit");
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

// Incremental sync: newest 100 matches (was 20), deduplicated by match_id.
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

// Resumable career import. Walks backwards in time using the `to` timestamp
// cursor (count offsets are unreliable beyond ~1000). The cursor is saved
// after every page, so an interrupted run continues where it stopped.
// Imported rows have NULL ELO fields: FACEIT's official API gives no per-match ELO.
async function importCareer({ maxPages = 5, delayMs = 250 } = {}) {
  if (!(await ensureSchema())) { const e = new Error("Database is not configured."); e.status = 503; throw e; }
  return withLock(async () => {
    const runId = await startRun("career_import");
    let seen = 0, saved = 0;
    try {
      const player = await loadPlayer();
      const nickname = player.nickname || NICKNAME();
      const state = (await getState("career_import")) || { done: false, cursor: null, pages: 0, imported: 0 };
      if (state.done) { await finishRun(runId, "ok", 0, 0, null); return { ok: true, done: true, seen: 0, saved: 0, state }; }

      for (let page = 0; page < maxPages; page++) {
        const q = `/players/${player.player_id}/history?game=${GAME}&limit=${PAGE_SIZE}` +
          (state.cursor ? `&to=${state.cursor}` : "&offset=0");
        const history = await faceitGet(q);
        const items = history.items || [];
        if (!items.length) { state.done = true; await setState("career_import", state); break; }
        seen += items.length;
        const savedBefore = saved;

        const known = new Set((await pool.query(
          "SELECT match_id FROM faceit_matches WHERE match_id = ANY($1)", [items.map((i) => i.match_id)]
        )).rows.map((r) => r.match_id));

        for (const item of items) {
          if (!item.match_id || known.has(item.match_id)) continue;
          let stats = null, map = item.map || item.competition_name || "FACEIT match", score = null;
          try {
            const parsed = getPlayerMatchStats(await faceitGet(`/matches/${encodeURIComponent(item.match_id)}/stats`), player.player_id, nickname);
            stats = parsed.stats; map = parsed.map || map; score = parsed.score;
          } catch (error) {
            console.warn(`Import: no stats for ${item.match_id}: ${error.message}`);
          }
          const r = await pool.query(
            `INSERT INTO faceit_matches (match_id, finished_at, started_at, map, outcome, score, stats, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'career_import') ON CONFLICT (match_id) DO NOTHING`,
            [item.match_id, item.finished_at || null, item.started_at || null, map,
             getPlayerOutcome(item, player.player_id), score, stats ? JSON.stringify(stats) : null]
          );
          saved += r.rowCount;
          await sleep(delayMs);
        }

        const oldest = Math.min(...items.map((i) => Number(i.started_at || i.finished_at)).filter(Number.isFinite));
        state.pages += 1; state.imported += saved - savedBefore;
        // Stop if the cursor can't move backwards (guards against loops).
        if (!Number.isFinite(oldest) || (state.cursor && oldest >= Number(state.cursor))) { state.done = true; await setState("career_import", state); break; }
        state.cursor = oldest;
        if (items.length < PAGE_SIZE) state.done = true;
        await setState("career_import", state);
        if (state.done) break;
      }
      await finishRun(runId, "ok", seen, saved, null);
      return { ok: true, done: Boolean(state.done), seen, saved, state };
    } catch (error) {
      await finishRun(runId, "error", seen, saved, error.message);
      throw error;
    }
  });
}

async function syncStatus() {
  if (!(await ensureSchema())) return { configured: false };
  const [runs, last, career, counts] = await Promise.all([
    pool.query("SELECT id, kind, status, started_at, finished_at, matches_seen, matches_saved, error FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 10"),
    getState("last_success"), getState("career_import"),
    pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE source = 'career_import')::int AS imported FROM faceit_matches")
  ]);
  return { configured: true, lastSuccess: last, careerImport: career, matches: counts.rows[0], recentRuns: runs.rows };
}

module.exports = { syncRecent, importCareer, syncStatus };
