// Win/loss detection: both FACEIT team shapes, plus the stats "Result" fallback.
const assert = require("assert");
const { getPlayerOutcome, outcomeFromPlayerStats, resolveOutcome } = require("../src/faceit");
const ME = "player-me";

const withKey = (key) => ({
  results: { winner: "faction1" },
  teams: { faction1: { [key]: [{ player_id: "x" }, { player_id: ME }] }, faction2: { [key]: [{ player_id: "y" }] } }
});
for (const key of ["roster", "players", "playing_players"]) {
  assert.strictEqual(getPlayerOutcome(withKey(key), ME), "Win", `win via ${key}`);
}
const lost = withKey("players"); lost.results.winner = "faction2";
assert.strictEqual(getPlayerOutcome(lost, ME), "Loss");
const noWinner = withKey("players"); delete noWinner.results;
assert.strictEqual(getPlayerOutcome(noWinner, ME), "Unknown");
assert.strictEqual(getPlayerOutcome(withKey("players"), "someone-else"), "Unknown");
assert.strictEqual(getPlayerOutcome(null, ME), "Unknown");
assert.strictEqual(getPlayerOutcome({ teams: { faction1: null }, results: { winner: "faction1" } }, ME), "Unknown");

assert.strictEqual(outcomeFromPlayerStats({ Result: "1" }), "Win");
assert.strictEqual(outcomeFromPlayerStats({ Result: 0 }), "Loss");
assert.strictEqual(outcomeFromPlayerStats({ Result: " Win " }), "Win");
assert.strictEqual(outcomeFromPlayerStats({ Result: "2" }), "Unknown");
assert.strictEqual(outcomeFromPlayerStats({}), "Unknown");
assert.strictEqual(outcomeFromPlayerStats(null), "Unknown");

// history item says nothing useful -> stats decide; a definite history answer is never overridden
const blind = { results: { winner: "faction1" }, teams: {} };
assert.strictEqual(resolveOutcome(blind, ME, { Result: "1" }), "Win");
assert.strictEqual(resolveOutcome(blind, ME, null), "Unknown");
assert.strictEqual(resolveOutcome(lost, ME, { Result: "1" }), "Loss");
console.log("✓ outcome detection tests passed");
