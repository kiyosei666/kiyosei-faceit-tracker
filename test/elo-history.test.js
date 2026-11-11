// Unit tests for ELO history range filtering, chronological ordering, and baseline preservation
const assert = require("assert");

console.log("Starting ELO history unit tests...");

// 1. Test range parameter parsing logic (mirrors server.js)
function normalizeRange(raw) {
  const r = String(raw || "all").toLowerCase();
  return (r === "7d" || r === "30d") ? r : "all";
}

assert.strictEqual(normalizeRange("7d"), "7d");
assert.strictEqual(normalizeRange("7D"), "7d");
assert.strictEqual(normalizeRange("30d"), "30d");
assert.strictEqual(normalizeRange("30D"), "30d");
assert.strictEqual(normalizeRange("all"), "all");
assert.strictEqual(normalizeRange(null), "all");
assert.strictEqual(normalizeRange(undefined), "all");
assert.strictEqual(normalizeRange("invalid"), "all");
console.log("✓ Range parameter normalization tests passed");

// 2. Test chronological sorting and boundary preservation
const mockSnapshots = [
  { elo: 1734, captured_at: "2026-11-11T02:56:33.664Z" },
  { elo: 1680, captured_at: "2026-11-10T16:00:00.000Z" },
  { elo: 1710, captured_at: "2026-11-11T01:00:00.000Z" }
];

const sorted = [...mockSnapshots].sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
assert.strictEqual(sorted[0].elo, 1680, "Baseline 1,680 must be first chronologically");
assert.strictEqual(sorted[sorted.length - 1].elo, 1734, "Latest ELO 1,734 must be last chronologically");
console.log("✓ Chronological sorting tests passed");

// 3. Test calculation of first, latest, peak, and change values
const vals = sorted.map((s) => Number(s.elo));
const first = vals[0];
const latest = vals[vals.length - 1];
const peak = Math.max(...vals);
const change = latest - first;

assert.strictEqual(first, 1680);
assert.strictEqual(latest, 1734);
assert.strictEqual(peak, 1734);
assert.strictEqual(change, 54);
console.log("✓ Summary metrics calculation tests passed");

// 4. Test range filtering in memory
const now = new Date("2026-11-11T12:00:00Z").getTime();
const dayMs = 24 * 60 * 60 * 1000;
const historySamples = [
  { elo: 1550, captured_at: new Date(now - 45 * dayMs).toISOString() }, // > 30 days
  { elo: 1600, captured_at: new Date(now - 20 * dayMs).toISOString() }, // within 30 days
  { elo: 1680, captured_at: new Date(now - 1 * dayMs).toISOString() },  // within 7 days
  { elo: 1734, captured_at: new Date(now - 2 * 60 * 1000).toISOString() } // current
];

function filterSnapshots(items, range, refTime = now) {
  if (range === "7d") {
    return items.filter((s) => new Date(s.captured_at).getTime() >= refTime - 7 * dayMs);
  }
  if (range === "30d") {
    return items.filter((s) => new Date(s.captured_at).getTime() >= refTime - 30 * dayMs);
  }
  return [...items];
}

const res7d = filterSnapshots(historySamples, "7d");
const res30d = filterSnapshots(historySamples, "30d");
const resAll = filterSnapshots(historySamples, "all");

assert.strictEqual(res7d.length, 2, "7D range must contain exactly 2 snapshots");
assert.strictEqual(res30d.length, 3, "30D range must contain exactly 3 snapshots");
assert.strictEqual(resAll.length, 4, "All range must contain all 4 snapshots");
console.log("✓ Range filtering logic tests passed");

// 5. Test empty / single snapshot behavior messaging
function getEmptyMessage(range) {
  const rangeMsg = range === "7d" ? "in the last 7 days" : range === "30d" ? "in the last 30 days" : "yet";
  return `No ELO snapshots ${rangeMsg}. Snapshots are recorded when ELO changes are detected.`;
}

assert.strictEqual(getEmptyMessage("7d"), "No ELO snapshots in the last 7 days. Snapshots are recorded when ELO changes are detected.");
assert.strictEqual(getEmptyMessage("30d"), "No ELO snapshots in the last 30 days. Snapshots are recorded when ELO changes are detected.");
assert.strictEqual(getEmptyMessage("all"), "No ELO snapshots yet. Snapshots are recorded when ELO changes are detected.");
console.log("✓ Empty state message tests passed");

console.log("All ELO history unit tests passed successfully!");
