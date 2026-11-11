const { pool, ensureSchema } = require("./db");
const { faceitGet, getPlayerOutcome, getPlayerMatchStats } = require("./faceit");

// The 1,680 comeback baseline. Inserted once as the first snapshot and never
// updated or deleted by any code path.
const BASELINE_ELO = 1680;
const BASELINE_AT = "2026-11-11T00:00:00+08:00";

async function persistMatches(historyItems, playerId, nickname, currentElo) {
  if (!(await ensureSchema())) return { configured: false, saved: 0 };
  const latestSnapshot = await pool.query(
    "SELECT elo FROM elo_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1"
  );
  let previousElo = latestSnapshot.rows[0]?.elo ?? null;
  const isFirstSync = previousElo === null;

  if (isFirstSync) {
    await pool.query(
      "INSERT INTO elo_snapshots (elo, captured_at) VALUES ($1, $2)",
      [BASELINE_ELO, BASELINE_AT]
    );
    previousElo = BASELINE_ELO;
  }

  const known = await pool.query("SELECT match_id FROM faceit_matches");
  const knownIds = new Set(known.rows.map((row) => row.match_id));
  const newItems = (historyItems || []).filter((item) => item.match_id && !knownIds.has(item.match_id));
  const chronological = [...newItems].reverse();
  let saved = 0;

  for (let index = 0; index < chronological.length; index++) {
    const match = chronological[index];
    let matchStats = null;
    let matchMap = match.map || match.competition_name || "FACEIT match";
    let score = null;

    try {
      const statsData = await faceitGet(`/matches/${encodeURIComponent(match.match_id)}/stats`);
      const parsed = getPlayerMatchStats(statsData, playerId, nickname);
      matchStats = parsed.stats;
      matchMap = parsed.map || matchMap;
      score = parsed.score;
    } catch (error) {
      console.warn(`Could not fetch stats for match ${match.match_id}: ${error.message}`);
    }

    // FACEIT's public player-history response does not expose a dependable
    // per-match ELO delta. Attribute a delta only when exactly one new match
    // appeared between two known ELO snapshots.
    const canAttributeElo = !isFirstSync && chronological.length === 1 && Number.isFinite(Number(currentElo));
    const eloBefore = canAttributeElo ? previousElo : null;
    const eloAfter = canAttributeElo ? Number(currentElo) : null;
    const eloChange = canAttributeElo ? Number(currentElo) - previousElo : null;

    await pool.query(
      `INSERT INTO faceit_matches
        (match_id, finished_at, map, outcome, score, stats, elo_before, elo_after, elo_change)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (match_id) DO NOTHING`,
      [match.match_id, match.finished_at || match.started_at || null, matchMap,
       getPlayerOutcome(match, playerId), score, matchStats ? JSON.stringify(matchStats) : null,
       eloBefore, eloAfter, eloChange]
    );
    saved++;
  }

  const current = Number(currentElo);
  if (Number.isFinite(current)) {
    const last = await pool.query(
      "SELECT elo FROM elo_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1"
    );
    if (!last.rows.length || last.rows[0].elo !== current) {
      await pool.query("INSERT INTO elo_snapshots (elo) VALUES ($1)", [current]);
    }
  }
  return { configured: true, saved, firstSync: isFirstSync };
}

async function readTrackingData() {
  if (!(await ensureSchema())) return { configured: false, snapshots: [], matches: [] };
  const [snapshots, matches] = await Promise.all([
    pool.query("SELECT elo, captured_at FROM elo_snapshots ORDER BY captured_at ASC"),
    pool.query("SELECT match_id, finished_at, map, outcome, score, stats, elo_before, elo_after, elo_change FROM faceit_matches ORDER BY finished_at DESC NULLS LAST LIMIT 50")
  ]);
  return { configured: true, snapshots: snapshots.rows, matches: matches.rows };
}

module.exports = { persistMatches, readTrackingData, BASELINE_ELO, BASELINE_AT };
