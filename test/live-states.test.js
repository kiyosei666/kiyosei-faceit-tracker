// Pure tests: transition rules, status mapping, payload extraction. SYNTHETIC payloads only;
// they prove the logic, not compatibility with real FACEIT deliveries.
const assert = require("assert");
const { decideTransition, stateFromStatus, inGameStatuses, EVENT_TO_STATE, STATES } = require("../src/live/states");
const { extractEvent, findValue, dedupeKey, safeHeaders, MATCH_EVENTS } = require("../src/live/extract");
const { secretMatches } = require("../src/live/ingest");

// transitions
const d = decideTransition;
assert.strictEqual(d(null, "MATCH_DETECTED", "webhook").action, "apply");
assert.strictEqual(d(null, "READY", "webhook").action, "apply", "a missed earlier event must not block a later one");
assert.strictEqual(d("MATCH_DETECTED", "CONFIGURING", "webhook").action, "apply");
assert.strictEqual(d("CONFIGURING", "READY", "webhook").action, "apply");
assert.strictEqual(d("READY", "READY", "webhook").action, "noop");
assert.deepStrictEqual([d("READY", "CONFIGURING", "webhook").action, d("READY", "CONFIGURING", "webhook").fillTimestamp], ["ignore", true], "older events never regress state");
assert.strictEqual(d("IN_GAME", "READY", "reconcile").action, "ignore");
assert.strictEqual(d("READY", "IN_GAME", "webhook").action, "reject", "no webhook can establish IN_GAME");
assert.strictEqual(d("READY", "IN_GAME", "reconcile").action, "apply");
assert.strictEqual(d("CONFIGURING", "IN_GAME", "reconcile").action, "apply");
for (const t of ["ENDED", "ABORTED", "CANCELLED"]) assert.strictEqual(d("IN_GAME", t, "webhook").action, "apply");
assert.strictEqual(d("ENDED", "ENDED", "webhook").action, "noop");
assert.strictEqual(d("ENDED", "READY", "webhook").action, "ignore");
assert.strictEqual(d("ENDED", "IN_GAME", "reconcile").action, "ignore", "terminal is absorbing");
assert.strictEqual(d("ENDED", "ABORTED", "webhook").action, "anomaly");
assert.strictEqual(d("READY", "BOGUS", "webhook").action, "reject");
assert.deepStrictEqual(STATES.length, 7);

// event / status mapping
assert.strictEqual(EVENT_TO_STATE.match_status_finished, "ENDED");
assert.strictEqual(EVENT_TO_STATE.match_demo_ready, undefined, "demo_ready carries no state");
assert.strictEqual(stateFromStatus("READY", {}), "READY", "READY is never IN_GAME");
assert.strictEqual(stateFromStatus(" finished ", {}), "ENDED");
assert.strictEqual(stateFromStatus("CANCELED", {}), "CANCELLED");
assert.strictEqual(stateFromStatus("VOTING", {}), null, "unrecognised status -> no transition");
assert.strictEqual(stateFromStatus(null, {}), null);
assert.strictEqual(stateFromStatus("ONGOING", {}), "IN_GAME");
assert.strictEqual(stateFromStatus("ONGOING", { FACEIT_INGAME_STATUSES: "" }), null, "candidate can be disabled");
assert.strictEqual(stateFromStatus("LIVE", { FACEIT_INGAME_STATUSES: "live, ongoing" }), "IN_GAME");
assert.deepStrictEqual(inGameStatuses({ FACEIT_INGAME_STATUSES: "a, B" }), ["A", "B"]);

// extraction (SYNTHETIC shape; paths are recorded so real captures can correct them)
const ex = extractEvent({ event: "match_status_ready", event_id: "e1", payload: { id: "1-abc-123" } });
assert.deepStrictEqual([ex.eventType, ex.eventId, ex.matchId, ex.known], ["match_status_ready", "e1", "1-abc-123", true]);
assert.deepStrictEqual(ex.extraction, { eventPath: "event", eventIdPath: "event_id", matchIdPath: "payload.id" });
assert.strictEqual(extractEvent({ event: "hub_created", payload: { id: "x1234" } }).known, false);
assert.strictEqual(extractEvent({ payload: {} }).eventType, null);
assert.strictEqual(extractEvent({ event: "match_status_ready", payload: { id: "bad id with spaces" } }).matchId, null, "unsafe ids rejected");
assert.strictEqual(extractEvent({ event: "x", payload: { match_id: "m-1234", id: "other-999" } }).matchId, "m-1234");
assert(MATCH_EVENTS.length === 7);
assert.strictEqual(findValue({ a: [{ b: "P1" }] }, "P1"), "a[0].b");
assert.strictEqual(findValue({ a: ["x"] }, "P1"), null);
assert.strictEqual(findValue({ a: "P1" }, ""), null);

// idempotency keys
assert.strictEqual(dedupeKey({ eventId: "e1", eventType: "t", matchId: "m" }, "r"), "id:e1");
assert.strictEqual(dedupeKey({ eventId: null, eventType: "t", matchId: "m" }, "r"), "evt:t:m");
assert(dedupeKey({ eventId: null, eventType: null, matchId: null }, "raw").startsWith("raw:"));

// headers never keep credentials
const h = safeHeaders({ "X-Kiyosei-Webhook-Secret": "s3cret", Authorization: "Bearer z", "User-Agent": "faceit", "x-api-key": "k", Cookie: "c", "X-Custom": "ok" }, "x-kiyosei-webhook-secret");
assert.deepStrictEqual(h, { "user-agent": "faceit", "x-custom": "ok" });

// constant-time compare behaves
assert(secretMatches("abc", "abc")); assert(!secretMatches("abd", "abc")); assert(!secretMatches("", "abc")); assert(!secretMatches(undefined, "abc")); assert(!secretMatches("abcd", "abc"));
console.log("✓ live state/extraction unit tests passed");
