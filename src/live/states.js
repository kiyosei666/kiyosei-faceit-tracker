// Pure lifecycle rules (no I/O). See docs/LIVE_DETECTION.md.
const STATES = Object.freeze(["MATCH_DETECTED", "CONFIGURING", "READY", "IN_GAME", "ENDED", "ABORTED", "CANCELLED"]);
const RANK = Object.freeze({ MATCH_DETECTED: 1, CONFIGURING: 2, READY: 3, IN_GAME: 4, ENDED: 10, ABORTED: 10, CANCELLED: 10 });
const TERMINAL = Object.freeze(["ENDED", "ABORTED", "CANCELLED"]);
const isTerminal = (s) => TERMINAL.includes(s);

// Documented webhook events -> state. match_demo_ready intentionally has no state.
const EVENT_TO_STATE = Object.freeze({
  match_object_created: "MATCH_DETECTED",
  match_status_configuring: "CONFIGURING",
  match_status_ready: "READY",
  match_status_finished: "ENDED",
  match_status_aborted: "ABORTED",
  match_status_cancelled: "CANCELLED"
});

// GET /matches/{id} `status` strings. FACEIT does not document the value set. The
// first group mirrors the documented webhook event names; ONGOING is a CANDIDATE for
// "in game" that has NOT been verified. Real values are recorded in
// faceit_live_status_observations and exposed by GET /api/live for Phase 0 verification.
const STATUS_TO_STATE = Object.freeze({
  CONFIGURING: "CONFIGURING", READY: "READY",
  FINISHED: "ENDED", ABORTED: "ABORTED", CANCELLED: "CANCELLED", CANCELED: "CANCELLED"
});
const DEFAULT_INGAME_STATUSES = ["ONGOING"];

function inGameStatuses(env = process.env) {
  const raw = env.FACEIT_INGAME_STATUSES;
  const list = raw === undefined ? DEFAULT_INGAME_STATUSES : String(raw).split(",");
  return list.map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/** Maps a raw FACEIT status string to a lifecycle state, or null when unrecognised (no transition). */
function stateFromStatus(statusRaw, env = process.env) {
  if (typeof statusRaw !== "string") return null;
  const s = statusRaw.trim().toUpperCase();
  if (inGameStatuses(env).includes(s)) return "IN_GAME";
  return STATUS_TO_STATE[s] || null;
}

/**
 * Decide what to do when `target` is observed for a match currently in `current`
 * (null = match not seen before). `source` is 'webhook' or 'reconcile'.
 * Only reconciliation may establish IN_GAME: no documented webhook event says a match is ongoing.
 */
function decideTransition(current, target, source) {
  if (!STATES.includes(target)) return { action: "reject", reason: "unknown_target_state" };
  if (target === "IN_GAME" && source !== "reconcile") return { action: "reject", reason: "in_game_requires_reconciliation" };
  if (!current) return { action: "apply", reason: "first_observation" };
  if (isTerminal(current)) {
    if (current === target) return { action: "noop", reason: "duplicate_terminal" };
    if (isTerminal(target)) return { action: "anomaly", reason: `conflicting_terminal:${current}->${target}` };
    return { action: "ignore", reason: "match_already_terminal" };
  }
  if (RANK[target] === RANK[current]) return { action: "noop", reason: "same_state" };
  if (RANK[target] < RANK[current]) return { action: "ignore", reason: "older_than_current", fillTimestamp: true };
  return { action: "apply", reason: "forward" };
}

module.exports = { STATES, RANK, TERMINAL, isTerminal, EVENT_TO_STATE, STATUS_TO_STATE, stateFromStatus, inGameStatuses, decideTransition };
