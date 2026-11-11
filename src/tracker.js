const { pool, ensureSchema } = require("./db");
const { faceitGet, getPlayerOutcome, getPlayerMatchStats, classifyMatchStats } = require("./faceit");

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

  const known = await pool.query("SELECT match_id, stats_status FROM faceit_matches");
  const knownMap = new Map(known.rows.map((row) => [row.match_id, row.stats_status]));
  const newItems = (historyItems || []).filter((item) => item.match_id && !knownMap.has(item.match_id));
  const chronological = [...newItems].reverse();
  let saved = 0;

  for (let index = 0; index < chronological.length; index++) {
    const match = chronological[index];
    let matchStats = null;
    let statsStatus = "pending";
    let matchMap = match.map || match.competition_name || "FACEIT match";
    let score = null;

    try {
      const statsData = await faceitGet(`/matches/${encodeURIComponent(match.match_id)}/stats`);
      const parsed = getPlayerMatchStats(statsData, playerId, nickname);
      const classified = classifyMatchStats(parsed);
      matchStats = classified.stats;
      matchMap = classified.map || matchMap;
      score = classified.score;
      statsStatus = classified.status;
    } catch (error) {
      if (error.status === 404) {
        statsStatus = "unavailable";
      } else {
        statsStatus = "pending";
      }
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
        (match_id, finished_at, map, outcome, score, stats, stats_status, elo_before, elo_after, elo_change)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (match_id) DO NOTHING`,
      [match.match_id, match.finished_at || match.started_at || null, matchMap,
       getPlayerOutcome(match, playerId), score, matchStats ? JSON.stringify(matchStats) : null,
       statsStatus, eloBefore, eloAfter, eloChange]
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

async function readTrackingData(range = "all", offset = 0, limit = 100) {
  if (!(await ensureSchema())) return { configured: false, snapshots: [], matches: [], baseline: BASELINE_ELO, range };
  const normalizedRange = String(range || "all").toLowerCase();
  let snapshotQuery = "SELECT elo, captured_at FROM elo_snapshots";
  if (normalizedRange === "7d") snapshotQuery += " WHERE captured_at >= NOW() - INTERVAL '7 days'";
  else if (normalizedRange === "30d") snapshotQuery += " WHERE captured_at >= NOW() - INTERVAL '30 days'";
  snapshotQuery += " ORDER BY captured_at ASC";
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 100));
  const [snapshotResult, matchResult, chartMatchResult, countResult, peakResult] = await Promise.all([
    pool.query(snapshotQuery),
    pool.query("SELECT match_id, finished_at, map, outcome, score, stats, stats_status, elo_before, elo_after, elo_change FROM faceit_matches ORDER BY finished_at DESC NULLS LAST, match_id DESC LIMIT $1 OFFSET $2", [safeLimit, safeOffset]),
    pool.query(
      `SELECT elo_before, elo_after, started_at, finished_at
       FROM faceit_matches
       WHERE elo_before IS NOT NULL OR elo_after IS NOT NULL
       ORDER BY finished_at ASC NULLS FIRST`
    ),
    pool.query("SELECT COUNT(*)::int AS total FROM faceit_matches"),
    pool.query(
      `SELECT elo, source FROM (
         SELECT elo, 'snapshot'::text AS source FROM elo_snapshots
         UNION ALL
         SELECT elo_before, 'match'::text FROM faceit_matches WHERE elo_before IS NOT NULL
         UNION ALL
         SELECT elo_after, 'match'::text FROM faceit_matches WHERE elo_after IS NOT NULL
         UNION ALL
         SELECT elo, source FROM elo_records WHERE record_key = 'all_time_peak'
       ) candidates
       WHERE elo IS NOT NULL AND elo > 0
       ORDER BY elo DESC
       LIMIT 1`
    )
  ]);

  // Include exact per-match ELO values when the tracker could safely attribute
  // a single match between two observed player-profile snapshots. The public
  // FACEIT history endpoint does not expose historical per-match ELO, so older
  // imported matches without these values remain intentionally absent.
  const chartPoints = [...snapshotResult.rows];
  for (const match of chartMatchResult.rows) {
    if (match.elo_before !== null && match.started_at) {
      chartPoints.push({ elo: match.elo_before, captured_at: match.started_at });
    }
    if (match.elo_after !== null && match.finished_at) {
      chartPoints.push({ elo: match.elo_after, captured_at: match.finished_at });
    }
  }

  const seenPoints = new Set();
  const mergedSnapshots = chartPoints
    .filter((point) => point.captured_at && Number.isFinite(Number(point.elo)))
    .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
    .filter((point) => {
      const key = `${new Date(point.captured_at).toISOString()}:${Number(point.elo)}`;
      if (seenPoints.has(key)) return false;
      seenPoints.add(key);
      return true;
    })
    .filter((point) => {
      if (normalizedRange === "7d") return new Date(point.captured_at) >= new Date(Date.now() - 7 * 86400000);
      if (normalizedRange === "30d") return new Date(point.captured_at) >= new Date(Date.now() - 30 * 86400000);
      return true;
    });

  return {
    configured: true,
    snapshots: mergedSnapshots,
    matches: matchResult.rows,
    totalMatches: countResult.rows[0]?.total || 0,
    matchOffset: safeOffset,
    matchLimit: safeLimit,
    hasMoreMatches: safeOffset + matchResult.rows.length < (countResult.rows[0]?.total || 0),
    peakElo: peakResult.rows[0]?.elo ?? null,
    peakEloSource: peakResult.rows[0]?.source ?? null,
    baseline: BASELINE_ELO,
    range: normalizedRange
  };
}

module.exports = { persistMatches, readTrackingData, BASELINE_ELO, BASELINE_AT };
