// Turns stored webhook events into lifecycle transitions. Safe to run from any
// number of workers: events are claimed with a lease, and transitions are idempotent.
const { pool } = require("../db");
const { extractEvent, findValue } = require("./extract");
const { EVENT_TO_STATE } = require("./states");
const { applyState, markDemoReady } = require("./lifecycle");
const { getTrackedPlayer } = require("./player");
const { fetchDetails, rosterPlayerIds, applyDetails } = require("./reconcile");

const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 60;
let running = false;

const backoffSeconds = (attempts) => Math.min(900, 15 * 2 ** Math.max(0, attempts - 1));

async function claim(limit, onlyId) {
  const r = await pool.query(
    `UPDATE faceit_webhook_events SET attempts = attempts + 1, next_attempt_at = NOW() + ($1 || ' seconds')::interval
     WHERE id IN (
       SELECT id FROM faceit_webhook_events
       WHERE processing_status IN ('pending','failed') AND attempts < $2
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) AND ($3::bigint IS NULL OR id = $3)
       ORDER BY id LIMIT $4 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [String(LEASE_SECONDS), MAX_ATTEMPTS, onlyId ?? null, limit]);
  return r.rows.sort((a, b) => Number(a.id) - Number(b.id));
}

const finish = (id, status, error = null, extra = {}) => pool.query(
  `UPDATE faceit_webhook_events SET processing_status=$2, processing_error=$3, processed_at=NOW(), next_attempt_at=NULL,
     player_id=COALESCE($4, player_id), attribution=COALESCE($5, attribution) WHERE id=$1`,
  [id, status, error, extra.playerId || null, extra.attribution || null]);

async function processEvent(row) {
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return finish(row.id, "unparsed", "payload is not a JSON object");
  const ex = extractEvent(payload);
  if (!ex.eventType || !ex.matchId) {
    return finish(row.id, "unparsed", `could not find ${!ex.eventType ? "event type" : "match id"} (paths tried are recorded in extraction)`);
  }
  if (!ex.known) return finish(row.id, "ignored", `unrecognised event type: ${ex.eventType.slice(0, 60)}`);

  const player = await getTrackedPlayer();
  let attribution = findValue(payload, player.playerId) ? "payload" : null;
  let details = null;
  if (!attribution) {
    // The payload doesn't name our player: confirm membership from the documented match details.
    details = await fetchDetails(ex.matchId);              // throws -> retried with backoff
    const roster = rosterPlayerIds(details);
    if (!roster.has(player.playerId)) return finish(row.id, "ignored", "match roster does not include the tracked player", { playerId: null });
    attribution = "roster";
  }

  if (ex.eventType === "match_demo_ready") {
    const known = await markDemoReady(ex.matchId);
    return finish(row.id, "processed", known ? null : "demo_ready for a match with no tracked lifecycle", { playerId: player.playerId, attribution });
  }

  const result = await applyState({ matchId: ex.matchId, playerId: player.playerId, attribution, target: EVENT_TO_STATE[ex.eventType], source: "webhook", eventRowId: row.id });
  await finish(row.id, "processed", result.action === "apply" ? null : `${result.action}: ${result.reason}`, { playerId: player.playerId, attribution });

  // Best effort: capture match details (opponents, status string) and let FACEIT's own status
  // confirm or advance the state (this is the only path that can establish IN_GAME).
  try {
    details = details || await fetchDetails(ex.matchId);
    await applyDetails(ex.matchId, details, player, { attribution });
  } catch (e) { /* the worker reconciles active matches on its next tick */ }
}

async function processPending({ limit = 25, onlyId } = {}) {
  if (running && onlyId === undefined) return { skipped: true };
  const wasRunning = running; running = true;
  let handled = 0;
  try {
    for (const row of await claim(limit, onlyId)) {
      handled++;
      try { await processEvent(row); }
      catch (error) {
        const exhausted = row.attempts >= MAX_ATTEMPTS;
        await pool.query(
          `UPDATE faceit_webhook_events SET processing_status = $2, processing_error = $3,
             next_attempt_at = CASE WHEN $2 = 'failed' AND NOT $4 THEN NOW() + ($5 || ' seconds')::interval ELSE NULL END WHERE id = $1`,
          [row.id, "failed", String(error.message || error).slice(0, 300), exhausted, String(backoffSeconds(row.attempts))]);
      }
    }
  } finally { running = wasRunning; }
  return { handled };
}

module.exports = { processPending, processEvent, MAX_ATTEMPTS };
