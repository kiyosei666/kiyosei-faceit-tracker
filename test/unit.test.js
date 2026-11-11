// Unit tests for FACEIT API client, stats parsing, classification, and timeout validation
const http = require("http");
const assert = require("assert");

const {
  getPlayerMatchStats,
  classifyMatchStats,
  normalizeTimeoutMs,
  getPlayerOutcome,
  faceitGet
} = require("../src/faceit");

console.log("Starting unit tests...");

// -------------------------------------------------------------
// 1. Timeout Normalization
// -------------------------------------------------------------
assert.strictEqual(normalizeTimeoutMs(5000), 5000, "Should use valid positive number");
assert.strictEqual(normalizeTimeoutMs(0), 10000, "Should fallback on 0");
assert.strictEqual(normalizeTimeoutMs(-100), 10000, "Should fallback on negative number");
assert.strictEqual(normalizeTimeoutMs(NaN), 10000, "Should fallback on NaN");
assert.strictEqual(normalizeTimeoutMs(Infinity), 10000, "Should fallback on Infinity");
assert.strictEqual(normalizeTimeoutMs("invalid"), 10000, "Should fallback on non-numeric string");
assert.strictEqual(normalizeTimeoutMs(null), 10000, "Should fallback on null");
assert.strictEqual(normalizeTimeoutMs(undefined), 10000, "Should fallback on undefined");
console.log("✓ normalizeTimeoutMs tests passed");

// -------------------------------------------------------------
// 2. Hardened getPlayerMatchStats parsing
// -------------------------------------------------------------
const meId = "p-1", meNick = "kiyosei";

// 2a. Malformed structures do not throw and return null stats
assert.deepStrictEqual(getPlayerMatchStats(null, meId, meNick), { stats: null, map: null, score: null });
assert.deepStrictEqual(getPlayerMatchStats("invalid_json", meId, meNick), { stats: null, map: null, score: null });
assert.deepStrictEqual(getPlayerMatchStats({}, meId, meNick), { stats: null, map: null, score: null });
assert.deepStrictEqual(getPlayerMatchStats({ rounds: "corrupted" }, meId, meNick), { stats: null, map: null, score: null });
assert.deepStrictEqual(getPlayerMatchStats({ rounds: [null] }, meId, meNick), { stats: null, map: null, score: null });
assert.deepStrictEqual(getPlayerMatchStats({ rounds: [{ teams: "corrupted" }] }, meId, meNick), { stats: null, map: null, score: null });
assert.deepStrictEqual(getPlayerMatchStats({ rounds: [{ teams: [null] }] }, meId, meNick), { stats: null, map: null, score: null });
assert.deepStrictEqual(getPlayerMatchStats({ rounds: [{ teams: [{ players: "bad" }] }] }, meId, meNick), { stats: null, map: null, score: null });
assert.deepStrictEqual(getPlayerMatchStats({ rounds: [{ teams: [{ players: [null] }] }] }, meId, meNick), { stats: null, map: null, score: null });

// 2b. Empty or invalid player_stats returns null stats
const mkPayload = (playerStats, map = "de_mirage", score = "13-11") => ({
  rounds: [{
    round_stats: { Map: map },
    teams: [
      { team_stats: { "Final Score": score.split("-")[0] }, players: [{ player_id: meId, nickname: meNick, player_stats: playerStats }] },
      { team_stats: { "Final Score": score.split("-")[1] }, players: [] }
    ]
  }]
});

assert.strictEqual(getPlayerMatchStats(mkPayload({}), meId, meNick).stats, null, "Empty object stats must be null");
assert.strictEqual(getPlayerMatchStats(mkPayload(null), meId, meNick).stats, null, "Null stats must be null");
assert.strictEqual(getPlayerMatchStats(mkPayload("invalid"), meId, meNick).stats, null, "String stats must be null");
assert.strictEqual(getPlayerMatchStats(mkPayload([1, 2, 3]), meId, meNick).stats, null, "Array stats must be null");
assert.strictEqual(getPlayerMatchStats(mkPayload(42), meId, meNick).stats, null, "Number stats must be null");

// 2c. Valid player_stats returns parsed stats and preserves map/score
const validPayload = mkPayload({ "K/D Ratio": "1.5", ADR: "90" }, "de_ancient", "13-9");
const validParsed = getPlayerMatchStats(validPayload, meId, meNick);
assert.deepStrictEqual(validParsed.stats, { "K/D Ratio": "1.5", ADR: "90" });
assert.strictEqual(validParsed.map, "de_ancient");
assert.strictEqual(validParsed.score, "13-9");
console.log("✓ getPlayerMatchStats tests passed");

// -------------------------------------------------------------
// 3. Shared classifyMatchStats helper
// -------------------------------------------------------------
assert.deepStrictEqual(classifyMatchStats({ stats: { "K/D Ratio": "1.2" }, map: "de_mirage", score: "13-5" }), {
  stats: { "K/D Ratio": "1.2" },
  map: "de_mirage",
  score: "13-5",
  status: "available"
});
assert.deepStrictEqual(classifyMatchStats({ stats: null, map: "de_dust2", score: null }), {
  stats: null,
  map: "de_dust2",
  score: null,
  status: "pending"
});
assert.deepStrictEqual(classifyMatchStats({ stats: {}, map: null, score: null }), {
  stats: null,
  map: null,
  score: null,
  status: "pending"
});

const err404 = new Error("Not found");
err404.status = 404;
assert.deepStrictEqual(classifyMatchStats(null, err404), {
  stats: null,
  map: null,
  score: null,
  status: "unavailable"
});

const err500 = new Error("Server exploded");
err500.status = 500;
assert.throws(() => classifyMatchStats(null, err500), /Server exploded/);
console.log("✓ classifyMatchStats tests passed");

// -------------------------------------------------------------
// 4. faceitGet retry & HTTP 401 fail-fast (offline mock)
// -------------------------------------------------------------
let hits = 0, mode = "flaky";
const srv = http.createServer((req, res) => {
  hits++;
  if (mode === "flaky" && hits <= 2) {
    res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
    return res.end("{}");
  }
  if (mode === "unauthorized") {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end("{}");
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
});

srv.listen(4022, async () => {
  process.env.FACEIT_API_BASE = "http://localhost:4022";
  process.env.FACEIT_API_KEY = "test-key";
  try {
    assert.deepStrictEqual(await faceitGet("/x", { baseDelayMs: 5 }), { ok: true });
    assert.strictEqual(hits, 3, "should retry twice after 429 then succeed");
    hits = 0;
    mode = "unauthorized";
    await assert.rejects(() => faceitGet("/x", { baseDelayMs: 5 }), /rejected the API key/);
    assert.strictEqual(hits, 1, "401 must not be retried");
    console.log("✓ faceitGet retry and 401 tests passed");
    console.log("All unit tests passed successfully!");
  } catch (e) {
    console.error("UNIT TEST FAILED:", e);
    process.exitCode = 1;
  } finally {
    srv.close();
  }
});
