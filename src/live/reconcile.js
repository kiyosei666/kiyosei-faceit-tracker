// Reconciles our lifecycle state with FACEIT's own view using the documented
// GET /matches/{match_id} endpoint through the existing client (retries, 429 Retry-After).
const { pool } = require("../db");
const { faceitGet } = require("../faceit");
const { stateFromStatus } = require("./states");
const { applyState, closeMatch } = require("./lifecycle");
const { getTrackedPlayer } = require("./player");

async function fetchDetails(matchId) {
  return faceitGet(`/matches/${encodeURIComponent(matchId)}`, { retries: 2 });
}

const rosterOf = (team) => [...(Array.isArray(team?.roster) ? team.roster : []), ...(Array.isArray(team?.substitutes) ? team.substitutes : [])];

function rosterPlayerIds(details) {
  const ids = new Set();
  for (const team of Object.values(details?.teams || {})) for (const p of rosterOf(team)) if (p && p.player_id) ids.add(p.player_id);
  return ids;
}

// Documented timestamps are integers; tolerate seconds or milliseconds.
function toDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
}

/** Reduced, documented-fields-only team metadata, labelled ours/opponent. */
function summarizeTeams(details, playerId) {
  const out = { ours: null, opponents: [] };
  for (const [faction, team] of Object.entries(details?.teams || {})) {
    const roster = rosterOf(team);
    const summary = {
      faction, name: team?.name || null,
      rating: team?.stats?.rating ?? null,
      averageSkillLevel: team?.stats?.skillLevel?.average ?? null,
      winProbability: team?.stats?.winProbability ?? null,
      players: roster.map((p) => ({ playerId: p.player_id || null, nickname: p.nickname || null, skillLevel: p.game_skill_level ?? null }))
    };
    if (roster.some((p) => p && p.player_id === playerId)) out.ours = summary; else out.opponents.push(summary);
  }
  return out;
}

async function observeStatus(statusRaw, mapped, matchId) {
  if (typeof statusRaw !== "string" || !statusRaw) return;
  await pool.query(
    `INSERT INTO faceit_live_status_observations (status_raw, mapped_state, last_match_id) VALUES ($1,$2,$3)
     ON CONFLICT (status_raw) DO UPDATE SET last_seen_at = NOW(), seen_count = faceit_live_status_observations.seen_count + 1,
       mapped_state = EXCLUDED.mapped_state, last_match_id = EXCLUDED.last_match_id`,
    [statusRaw, mapped, matchId]);
}

/** Persist what GET /matches/{id} returned for a match we already track. */
async function recordDetails(matchId, details, playerId) {
  const mapped = stateFromStatus(details?.status);
  await observeStatus(details?.status, mapped, matchId);
  await pool.query(
    `UPDATE faceit_live_matches SET status_raw=$2, map=COALESCE($3, map), teams=$4, details=$5,
       faceit_configured_at=COALESCE($6, faceit_configured_at), faceit_started_at=COALESCE($7, faceit_started_at),
       faceit_finished_at=COALESCE($8, faceit_finished_at),
       last_reconciled_at=NOW(), last_reconcile_attempt_at=NOW(), reconcile_failures=0, reconcile_error=NULL, updated_at=NOW()
     WHERE match_id=$1`,
    [matchId, typeof details?.status === "string" ? details.status : null,
      typeof details?.map === "string" ? details.map : null,
      JSON.stringify(summarizeTeams(details, playerId)), JSON.stringify(details),
      toDate(details?.configured_at), toDate(details?.started_at), toDate(details?.finished_at)]);
  return mapped;
}

async function recordFailure(matchId, error) {
  await pool.query(
    `UPDATE faceit_live_matches SET reconcile_failures = reconcile_failures + 1, reconcile_error = $2,
       last_reconcile_attempt_at = NOW(), updated_at = NOW() WHERE match_id = $1`,
    [matchId, String(error?.message || error).slice(0, 300)]);
}

/** Record fetched details and apply the status they imply. Shared by reconciliation and event processing. */
async function applyDetails(matchId, details, player, { attribution = null } = {}) {
  const mapped = await recordDetails(matchId, details, player.playerId);
  if (!mapped) return { ok: true, unknownStatus: details?.status ?? null };
  const result = await applyState({ matchId, playerId: player.playerId, attribution, target: mapped, source: "reconcile" });
  return { ok: true, status: details.status, mapped, result };
}

/** Fetch status from FACEIT and apply it. Never throws for FACEIT/network failures. */
async function reconcileMatch(matchId) {
  const player = await getTrackedPlayer();
  let details;
  try { details = await fetchDetails(matchId); }
  catch (error) { await recordFailure(matchId, error); return { ok: false, error: error.message, status: error.status || null }; }

  const roster = rosterPlayerIds(details);
  if (roster.size && !roster.has(player.playerId)) {
    await closeMatch(matchId, "unrelated");
    return { ok: true, unrelated: true };
  }
  return applyDetails(matchId, details, player, { attribution: roster.size ? "roster" : null });
}

module.exports = { applyDetails, fetchDetails, rosterPlayerIds, summarizeTeams, recordDetails, recordFailure, reconcileMatch, toDate };
