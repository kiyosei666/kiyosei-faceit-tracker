// Mounts the live-detection routes and runs the background worker.
const express = require("express");
const { pool, ensureSchema } = require("../db");
const ingest = require("./ingest");
const { processPending } = require("./processor");
const { reconcileMatch } = require("./reconcile");
const { closeMatch } = require("./lifecycle");
const { getTrackedPlayer, peekCached } = require("./player");
const { inGameStatuses } = require("./states");

const num = (name, dflt, min, max) => { const v = Number(process.env[name]); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt; };
const pollMs = () => num("LIVE_POLL_INTERVAL_SECONDS", 45, 30, 120) * 1000;   // 30-120 s, never aggressive
const maxMatchMs = () => num("LIVE_MAX_MATCH_MINUTES", 360, 60, 1440) * 60000;
const LOCK_ID = 727002;

const worker = { running: false, ticks: 0, lastTickAt: null, lastTickMs: null, lastError: null, timer: null };

/** One worker pass: process queued events, reconcile active matches, close impossible ones. */
async function tick() {
  if (!pool || !(await ensureSchema())) return { skipped: "no database" };
  const client = await pool.connect();
  const started = Date.now();
  try {
    const locked = (await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID])).rows[0].ok;
    if (!locked) return { skipped: "another worker holds the lock" };
    try {
      await processPending();
      const active = (await pool.query("SELECT * FROM faceit_live_matches WHERE closed_reason IS NULL ORDER BY created_at DESC LIMIT 3")).rows;
      for (const m of active) {
        // Exponential back-off per match while FACEIT is failing (45 s -> 90 s -> 180 s -> 360 s).
        const wait = pollMs() * 2 ** Math.min(m.reconcile_failures, 3);
        const last = m.last_reconcile_attempt_at ? new Date(m.last_reconcile_attempt_at).getTime() : 0;
        if (Date.now() - last >= wait) await reconcileMatch(m.match_id);
      }
      // A CS2 match cannot last this long; stop tracking anything FACEIT never closed for us.
      const stale = await pool.query("SELECT match_id FROM faceit_live_matches WHERE closed_reason IS NULL AND created_at < NOW() - ($1 || ' milliseconds')::interval", [String(maxMatchMs())]);
      for (const m of stale.rows) await closeMatch(m.match_id, "stale");
    } finally { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {}); }
    worker.lastError = null;
    return { ok: true };
  } catch (error) {
    worker.lastError = String(error.message || error).slice(0, 200);
    console.error("[live] worker tick failed:", worker.lastError);
    return { ok: false, error: worker.lastError };
  } finally {
    worker.ticks++; worker.lastTickAt = new Date().toISOString(); worker.lastTickMs = Date.now() - started;
    client.release();
  }
}

/** Starts the interval loop. Idle cost: one cheap DB query per tick, no FACEIT calls without an active match or queued event. */
function startWorker() {
  if (worker.timer || !pool) return;
  worker.running = true;
  setTimeout(() => tick().catch(() => {}), 5000).unref();                  // catch-up right after boot/wake
  worker.timer = setInterval(() => tick().catch(() => {}), pollMs());
  worker.timer.unref();
}
function stopWorker() { if (worker.timer) clearInterval(worker.timer); worker.timer = null; worker.running = false; }

const iso = (v) => (v ? new Date(v).toISOString() : null);
function shapeMatch(m) {
  if (!m) return null;
  return {
    matchId: m.match_id, state: m.state, closedReason: m.closed_reason, attribution: m.attribution,
    faceitStatus: m.status_raw, map: m.map, mapNote: m.map ? null : "Not exposed by GET /matches/{id} for this match (yet).",
    startedAt: iso(m.faceit_started_at), configuredAt: iso(m.faceit_configured_at), finishedAt: iso(m.faceit_finished_at),
    teams: m.teams,
    observed: { detected: iso(m.detected_at), configuring: iso(m.configuring_at), ready: iso(m.ready_at), inGame: iso(m.in_game_at), ended: iso(m.ended_at), aborted: iso(m.aborted_at), cancelled: iso(m.cancelled_at), demoReady: iso(m.demo_ready_at) },
    lastEventAt: iso(m.last_event_at), lastReconciledAt: iso(m.last_reconciled_at), reconcileFailures: m.reconcile_failures, reconcileError: m.reconcile_error,
    anomalies: m.anomalies
  };
}

async function health() {
  const configured = Boolean(process.env.FACEIT_WEBHOOK_SECRET);
  const dbOk = pool ? await ensureSchema().then(() => pool.query("SELECT 1")).then(() => true).catch(() => false) : false;
  let events = { total: 0, pending: 0, failed: 0, unparsed: 0, lastReceivedAt: null };
  let active = 0;
  if (dbOk) {
    const r = (await pool.query(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE processing_status='pending')::int pending,
              COUNT(*) FILTER (WHERE processing_status='failed')::int failed, COUNT(*) FILTER (WHERE processing_status='unparsed')::int unparsed,
              MAX(received_at) last FROM faceit_webhook_events`)).rows[0];
    events = { total: r.total, pending: r.pending, failed: r.failed, unparsed: r.unparsed, lastReceivedAt: iso(r.last) };
    active = (await pool.query("SELECT COUNT(*)::int n FROM faceit_live_matches WHERE closed_reason IS NULL")).rows[0].n;
  }
  const player = peekCached();
  const tickAge = worker.lastTickAt ? Date.now() - new Date(worker.lastTickAt).getTime() : null;
  const reasons = [];
  if (!configured) reasons.push("FACEIT_WEBHOOK_SECRET is not set; the receiver rejects all deliveries.");
  if (!process.env.FACEIT_API_KEY) reasons.push("FACEIT_API_KEY is not set; reconciliation is unavailable.");
  if (!dbOk) reasons.push("Database unavailable.");
  if (!player) reasons.push("Tracked player ID not resolved yet (resolved on first event or worker pass).");
  if (events.failed) reasons.push(`${events.failed} event(s) failed processing.`);
  if (events.unparsed) reasons.push(`${events.unparsed} event(s) could not be parsed; inspect /api/live/events.`);
  if (worker.lastError) reasons.push(`Worker error: ${worker.lastError}`);
  if (active && worker.running && tickAge !== null && tickAge > pollMs() * 3) reasons.push("Worker has not run recently while a match is active.");
  const hard = !configured || !dbOk || !process.env.FACEIT_API_KEY;
  return {
    ok: !hard,
    status: hard ? "unconfigured" : reasons.some((r) => !r.startsWith("Tracked player")) ? "degraded" : "healthy",
    reasons,
    receiver: { secretConfigured: configured, authHeader: ingest.AUTH_HEADER, ...ingest.metrics, events },
    processor: { workerRunning: worker.running, pollIntervalSeconds: pollMs() / 1000, ticks: worker.ticks, lastTickAt: worker.lastTickAt, lastTickMs: worker.lastTickMs, lastError: worker.lastError },
    player: { resolved: Boolean(player), source: player ? player.source : null },
    database: { ok: dbOk }, activeMatches: active
  };
}

function mount(app, { requireSecret }) {
  const handler = ingest.createHandler({ afterStore: (id) => processPending({ onlyId: id }).catch((e) => console.error("[live] immediate processing failed:", e.message)) });
  app.post("/api/faceit/webhook", express.raw({ type: () => true, limit: ingest.MAX_BODY }), handler);
  app.use("/api/faceit/webhook", (err, _req, res, next) => {          // body-parser failures (too large, aborted)
    if (!err) return next();
    ingest.metrics.malformed++;
    return res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "Payload too large." : "Invalid request body." });
  });

  // Public, read-only projection for the dashboard. Never expose SYNC_SECRET to browser code.
  app.get("/api/live/public", async (_req, res) => {
    try {
      if (!(await ensureSchema())) return res.status(503).json({ ok: false, error: "Live detection database unavailable." });
      const rows = (await pool.query(
        "SELECT * FROM faceit_live_matches ORDER BY (closed_reason IS NULL) DESC, created_at DESC LIMIT 2"
      )).rows;
      const current = rows.find((r) => r.closed_reason === null) || null;
      const last = current ? null : rows[0] || null;
      const match = current || last;
      res.set("Cache-Control", "no-store");
      return res.json({
        ok: true,
        state: current ? current.state : "INACTIVE",
        inMatch: Boolean(current),
        inGame: Boolean(current && current.state === "IN_GAME"),
        match: match ? {
          matchId: match.match_id,
          state: match.state,
          closedReason: match.closed_reason,
          faceitStatus: match.status_raw,
          map: match.map,
          teams: match.teams,
          detectedAt: match.detected_at ? new Date(match.detected_at).toISOString() : null,
          configuringAt: match.faceit_configured_at ? new Date(match.faceit_configured_at).toISOString() : null,
          readyAt: match.ready_at ? new Date(match.ready_at).toISOString() : null,
          inGameAt: match.in_game_at ? new Date(match.in_game_at).toISOString() : null,
          endedAt: match.ended_at ? new Date(match.ended_at).toISOString() : null,
          lastEventAt: match.last_event_at ? new Date(match.last_event_at).toISOString() : null
        } : null,
        serverTime: new Date().toISOString()
      });
    } catch (error) {
      console.error("[live] public status failed:", error.message);
      return res.status(500).json({ ok: false, error: "Unable to read live status." });
    }
  });

  // On-demand Gemini briefing for the active match. The server keeps the API key private.
  const briefing = require("./briefing");
  app.post("/api/live/briefing", async (_req, res) => {
    try {
      if (!(await ensureSchema())) return res.status(503).json({ error: "Live detection database unavailable." });
      const active = (await pool.query(
        "SELECT * FROM faceit_live_matches WHERE closed_reason IS NULL ORDER BY created_at DESC LIMIT 1"
      )).rows[0];
      if (!active) return res.status(409).json({ error: "No active FACEIT match detected yet. Queue first and wait for match detection." });
      const result = await briefing.generate(active);
      res.set("Cache-Control", "no-store");
      return res.json(result);
    } catch (error) {
      const status = error.status || (error.code === "not_configured" ? 503 : 502);
      console.error("[live] Gemini briefing failed:", error.message);
      return res.status(status).json({ error: error.message || "Could not generate the live briefing." });
    }
  });

  app.get("/api/live", requireSecret, async (_req, res) => {
    try {
      if (!(await ensureSchema())) return res.status(503).json({ error: "Database is not configured." });
      const rows = (await pool.query("SELECT * FROM faceit_live_matches ORDER BY (closed_reason IS NULL) DESC, created_at DESC LIMIT 2")).rows;
      const current = rows.find((r) => r.closed_reason === null) || null;
      const last = current ? rows.find((r) => r.match_id !== current.match_id) || null : rows[0] || null;
      const [ev, obs, transitions] = await Promise.all([
        pool.query("SELECT MAX(received_at) last FROM faceit_webhook_events"),
        pool.query("SELECT status_raw, mapped_state, seen_count, first_seen_at, last_seen_at FROM faceit_live_status_observations ORDER BY last_seen_at DESC"),
        current ? pool.query("SELECT from_state, to_state, source, at FROM faceit_live_transitions WHERE match_id=$1 ORDER BY id", [current.match_id]) : { rows: [] }
      ]);
      const h = await health();
      const candidates = inGameStatuses();
      res.json({
        state: current ? current.state : "INACTIVE",
        inMatch: Boolean(current),
        inGame: Boolean(current && current.state === "IN_GAME"),
        matchId: current ? current.match_id : null,
        match: shapeMatch(current),
        previousMatch: shapeMatch(last),
        transitions: transitions.rows,
        lastWebhookAt: iso(ev.rows[0].last),
        lastReconciliationAt: current ? iso(current.last_reconciled_at) : null,
        detection: {
          status: h.status, reasons: h.reasons,
          inGameStatusCandidates: candidates,
          inGameStatusObserved: obs.rows.some((o) => o.mapped_state === "IN_GAME"),
          note: "FACEIT documents no webhook for 'match started'. IN_GAME is set only when GET /matches/{id} returns a status in inGameStatusCandidates. Check observedStatuses to confirm real values.",
          observedStatuses: obs.rows
        }
      });
    } catch (e) { console.error("[live] /api/live failed:", e.message); res.status(500).json({ error: "Unable to read live state." }); }
  });

  app.get("/api/live/events", requireSecret, async (req, res) => {
    try {
      if (!(await ensureSchema())) return res.status(503).json({ error: "Database is not configured." });
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
      const status = typeof req.query.status === "string" ? req.query.status : null;
      const withRaw = req.query.raw === "1";
      const r = await pool.query(
        `SELECT id, event_id, event_type, match_id, player_id, attribution, extraction, payload, headers, received_at, duplicate_count,
                processing_status, processing_error, attempts, processed_at ${withRaw ? ", raw_text" : ""}
         FROM faceit_webhook_events WHERE ($1::text IS NULL OR processing_status = $1) ORDER BY id DESC LIMIT $2`, [status, limit]);
      res.json({ count: r.rows.length, events: r.rows.map((e) => ({ ...e, id: String(e.id), received_at: iso(e.received_at), processed_at: iso(e.processed_at) })) });
    } catch (e) { console.error("[live] /api/live/events failed:", e.message); res.status(500).json({ error: "Unable to read events." }); }
  });

  app.get("/api/live/health", requireSecret, async (_req, res) => {
    try { const h = await health(); res.status(h.ok ? 200 : 503).json(h); }
    catch (e) { res.status(500).json({ ok: false, error: "Health check failed." }); }
  });
}

module.exports = { mount, startWorker, stopWorker, tick, health, worker, getTrackedPlayer };
