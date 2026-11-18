// Tolerant extraction from webhook bodies. FACEIT's payload schema is NOT documented
// on the Webhooks page, so nothing here is a guaranteed field name: each value is
// looked up on an ordered list of candidate paths, and the path that matched is
// recorded with the event so real captures can confirm or replace these guesses.
const crypto = require("crypto");

// Documented event names (docs.faceit.com/docs/webhooks, "Events" table).
const MATCH_EVENTS = Object.freeze([
  "match_object_created", "match_status_configuring", "match_status_ready",
  "match_status_finished", "match_status_aborted", "match_status_cancelled", "match_demo_ready"
]);

const EVENT_PATHS = [["event"], ["event_type"], ["event_name"], ["type"]];
const EVENT_ID_PATHS = [["event_id"], ["transaction_id"], ["id_event"]];
const MATCH_ID_PATHS = [["payload", "match_id"], ["payload", "id"], ["match_id"], ["payload", "match", "id"]];

const getPath = (obj, path) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
const asId = (v) => (typeof v === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(v) ? v : null);

function firstMatch(body, paths, validate) {
  for (const p of paths) {
    const v = validate(getPath(body, p));
    if (v) return { value: v, path: p.join(".") };
  }
  return { value: null, path: null };
}

/** Returns the dotted path of the first string value equal to `needle`, or null. Depth/size bounded. */
function findValue(node, needle, path = "", depth = 0, budget = { n: 0 }) {
  if (!needle || depth > 12 || budget.n++ > 20000) return null;
  if (typeof node === "string") return node === needle ? path || "(root)" : null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) { const r = findValue(node[i], needle, `${path}[${i}]`, depth + 1, budget); if (r) return r; }
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) { const r = findValue(v, needle, path ? `${path}.${k}` : k, depth + 1, budget); if (r) return r; }
  }
  return null;
}

function extractEvent(body) {
  const ev = firstMatch(body, EVENT_PATHS, (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null));
  const id = firstMatch(body, EVENT_ID_PATHS, (v) => (typeof v === "string" || typeof v === "number") && String(v).length <= 200 ? String(v) : null);
  const match = firstMatch(body, MATCH_ID_PATHS, asId);
  return {
    eventType: ev.value, eventId: id.value, matchId: match.value,
    known: ev.value ? MATCH_EVENTS.includes(ev.value) : false,
    extraction: { eventPath: ev.path, eventIdPath: id.path, matchIdPath: match.path }
  };
}

// Idempotency key: the provider's event id when present; otherwise the semantic
// identity of a lifecycle event (type + match); otherwise a hash of the raw body.
function dedupeKey({ eventId, eventType, matchId }, rawText) {
  if (eventId) return `id:${eventId}`;
  if (eventType && matchId) return `evt:${eventType}:${matchId}`;
  return `raw:${crypto.createHash("sha256").update(rawText).digest("hex")}`;
}

const SENSITIVE_HEADER = /auth|secret|token|cookie|key|signature-secret/i;
/** Header snapshot for debugging (keeps unknown FACEIT headers, drops anything credential-like). */
function safeHeaders(headers, authHeaderName) {
  const out = {};
  const skip = String(authHeaderName || "").toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase();
    if (name === skip || SENSITIVE_HEADER.test(name)) continue;
    out[name] = Array.isArray(v) ? v.join(", ") : String(v).slice(0, 300);
  }
  return out;
}

module.exports = { MATCH_EVENTS, extractEvent, findValue, dedupeKey, safeHeaders };
