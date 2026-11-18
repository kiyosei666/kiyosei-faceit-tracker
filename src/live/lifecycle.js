// Persistent per-match lifecycle state machine. All writes for one match are
// serialised with an advisory lock, so duplicate/concurrent/out-of-order
// deliveries cannot race each other.
const { pool } = require("../db");
const { RANK, isTerminal, decideTransition } = require("./states");

const TS_COLUMN = {
  MATCH_DETECTED: "detected_at", CONFIGURING: "configuring_at", READY: "ready_at",
  IN_GAME: "in_game_at", ENDED: "ended_at", ABORTED: "aborted_at", CANCELLED: "cancelled_at"
};

const listeners = [];
/** Register an action to run exactly once per (match, state). Used by later phases (briefings, imports). */
function onTransition(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); }

async function emit(info) {
  for (const fn of [...listeners]) {
    try { await fn(info); } catch (e) { console.error("[live] transition listener failed:", e.message); }
  }
}

/**
 * Apply an observed state for a match.
 * Returns { action, reason, from, to, firstTime }.
 */
async function applyState({ matchId, playerId = null, attribution = null, target, source, eventRowId = null }) {
  const client = await pool.connect();
  let result;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`live:${matchId}`]);
    const found = await client.query("SELECT * FROM faceit_live_matches WHERE match_id = $1", [matchId]);
    const row = found.rows[0] || null;

    if (row && row.player_id && playerId && row.player_id !== playerId) {
      await appendAnomaly(client, matchId, { reason: "player_mismatch", target, source });
      await client.query("COMMIT");
      return { action: "reject", reason: "player_mismatch", from: row.state, to: target, firstTime: false };
    }
    if (row && row.closed_reason === "unrelated") {
      await client.query("COMMIT");
      return { action: "ignore", reason: "match_unrelated", from: row.state, to: target, firstTime: false };
    }

    const decision = decideTransition(row ? row.state : null, target, source);
    const from = row ? row.state : null;
    let firstTime = false;

    // Closed (superseded/stale) matches may still receive their terminal event, nothing else.
    if (decision.action === "apply" && row && row.closed_reason && row.closed_reason !== "terminal" && !isTerminal(target)) {
      result = { action: "ignore", reason: `match_closed:${row.closed_reason}`, from, to: target, firstTime: false };
    } else if (decision.action === "apply") {
      const col = TS_COLUMN[target];
      if (!row) {
        await client.query(
          `INSERT INTO faceit_live_matches (match_id, player_id, state, state_rank, attribution, ${col}, last_event_at, closed_reason)
           VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),$6)`,
          [matchId, playerId, target, RANK[target], attribution, isTerminal(target) ? "terminal" : null]);
        // A genuinely new, non-terminal match ends any older match we still consider active.
        if (!isTerminal(target)) {
          await client.query(
            "UPDATE faceit_live_matches SET closed_reason = 'superseded', updated_at = NOW() WHERE closed_reason IS NULL AND match_id <> $1", [matchId]);
        }
      } else {
        await client.query(
          `UPDATE faceit_live_matches SET state=$2, state_rank=$3, ${col}=COALESCE(${col}, NOW()), last_event_at=NOW(), updated_at=NOW(),
             player_id=COALESCE(player_id,$4), attribution=COALESCE(attribution,$5),
             closed_reason = CASE WHEN $6 THEN 'terminal' ELSE closed_reason END
           WHERE match_id=$1`,
          [matchId, target, RANK[target], playerId, attribution, isTerminal(target)]);
      }
      const t = await client.query(
        `INSERT INTO faceit_live_transitions (match_id, from_state, to_state, source, event_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (match_id, to_state) DO NOTHING RETURNING id`,
        [matchId, from, target, source, eventRowId]);
      firstTime = t.rowCount > 0;
      result = { action: "apply", reason: decision.reason, from, to: target, firstTime };
    } else {
      if (decision.fillTimestamp && row) {
        const col = TS_COLUMN[target];
        await client.query(`UPDATE faceit_live_matches SET ${col}=COALESCE(${col}, NOW()), updated_at=NOW() WHERE match_id=$1`, [matchId]);
      }
      if (decision.action === "anomaly" || decision.action === "reject") {
        await appendAnomaly(client, matchId, { reason: decision.reason, target, source });
      }
      result = { action: decision.action, reason: decision.reason, from, to: target, firstTime: false };
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (result.action === "apply" && result.firstTime) await emit({ matchId, from: result.from, to: result.to, source, playerId });
  return result;
}

async function appendAnomaly(client, matchId, entry) {
  await client.query(
    "UPDATE faceit_live_matches SET anomalies = anomalies || $2::jsonb, updated_at = NOW() WHERE match_id = $1",
    [matchId, JSON.stringify([{ at: new Date().toISOString(), ...entry }])]);
}

async function markDemoReady(matchId) {
  const r = await pool.query("UPDATE faceit_live_matches SET demo_ready_at = COALESCE(demo_ready_at, NOW()), updated_at = NOW() WHERE match_id = $1", [matchId]);
  return r.rowCount > 0;
}

async function closeMatch(matchId, reason) {
  await pool.query("UPDATE faceit_live_matches SET closed_reason = $2, updated_at = NOW() WHERE match_id = $1 AND closed_reason IS NULL", [matchId, reason]);
}

module.exports = { applyState, markDemoReady, closeMatch, onTransition, TS_COLUMN };
