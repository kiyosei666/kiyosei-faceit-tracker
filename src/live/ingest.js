// Webhook receiver: authenticate, validate, persist raw, acknowledge fast.
// Lifecycle processing happens afterwards (processor.js), never inside the request.
const crypto = require("crypto");
const { pool, ensureSchema } = require("../db");
const { extractEvent, dedupeKey, safeHeaders } = require("./extract");

const AUTH_HEADER = "x-kiyosei-webhook-secret";
const MAX_BODY = "256kb";

const metrics = { received: 0, accepted: 0, duplicates: 0, unauthorized: 0, malformed: 0, lastReceivedAt: null, lastRejectedAt: null };

function secretMatches(given, expected) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function bodyText(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return typeof req.body === "string" ? req.body : "";
}

function createHandler({ afterStore } = {}) {
  return async function webhookHandler(req, res) {
    metrics.received++;
    const expected = process.env.FACEIT_WEBHOOK_SECRET;
    if (!expected) return res.status(503).json({ error: "FACEIT_WEBHOOK_SECRET is not configured on the server." });
    if (!secretMatches(req.get(AUTH_HEADER), expected)) {
      metrics.unauthorized++; metrics.lastRejectedAt = new Date().toISOString();
      return res.status(401).json({ error: "Unauthorized." });
    }
    const raw = bodyText(req);
    let body;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    if (!raw.trim() || body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      metrics.malformed++; metrics.lastRejectedAt = new Date().toISOString();
      return res.status(400).json({ error: "Body must be a JSON object." });
    }
    try {
      if (!(await ensureSchema())) return res.status(503).json({ error: "Database is not configured." });
      const ex = extractEvent(body);
      const key = dedupeKey(ex, raw);
      const stored = await pool.query(
        `INSERT INTO faceit_webhook_events (dedupe_key, event_id, event_type, match_id, extraction, raw_text, payload, headers)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (dedupe_key) DO UPDATE SET duplicate_count = faceit_webhook_events.duplicate_count + 1, last_duplicate_at = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [key, ex.eventId, ex.eventType, ex.matchId, JSON.stringify(ex.extraction), raw, JSON.stringify(body),
          JSON.stringify(safeHeaders(req.headers, AUTH_HEADER))]);
      const { id, inserted } = stored.rows[0];
      metrics.lastReceivedAt = new Date().toISOString();
      if (inserted) { metrics.accepted++; if (afterStore) setImmediate(() => afterStore(id)); }
      else metrics.duplicates++;
      return res.status(200).json({ ok: true, duplicate: !inserted });
    } catch (error) {
      console.error("[live] webhook store failed:", error.message);
      return res.status(503).json({ error: "Temporarily unable to store the event." });   // non-2xx so the sender can retry
    }
  };
}

module.exports = { AUTH_HEADER, MAX_BODY, metrics, secretMatches, createHandler };
