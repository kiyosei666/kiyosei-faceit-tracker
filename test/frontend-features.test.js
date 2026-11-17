// Pure-logic tests for the browser feature modules (no DOM needed).
const assert = require("assert");
const { computeLevelProgress } = require("../public/js/features/level-ring.js");
const { computeStreak } = require("../public/js/features/streak.js");
const { computeInsights } = require("../public/js/features/coach.js");
const { newMilestones, levelOf, reachedTargets } = require("../public/js/features/celebrations.js");

// --- level ring
assert.strictEqual(computeLevelProgress(null), null);
assert.strictEqual(computeLevelProgress("abc"), null);
let r = computeLevelProgress(1927);
assert.strictEqual(r.level, 9); assert.strictEqual(r.next, 2001); assert.strictEqual(r.remaining, 74);
assert.ok(Math.abs(r.progress - (1927 - 1751) / 250) < 1e-9);
assert.strictEqual(computeLevelProgress(1751).progress, 0);
assert.strictEqual(computeLevelProgress(2001).max, true);
assert.strictEqual(computeLevelProgress(2600).level, 10);
assert.strictEqual(computeLevelProgress(50).level, 1);
assert.strictEqual(computeLevelProgress(50).progress, 0);
console.log("✓ level ring tests passed");

// --- streak (newest first)
const m = (o) => ({ outcome: o });
assert.deepStrictEqual(computeStreak([m("win"), m("win"), m("win"), m("loss")]).length, 3);
assert.strictEqual(computeStreak([m("loss"), m("loss"), m("win")]).type, "loss");
assert.strictEqual(computeStreak([m("win"), m("Win"), m("")]).length, 2);          // case-insensitive
assert.strictEqual(computeStreak([m(""), m("win")]).type, null);                   // unknown newest -> no streak
assert.strictEqual(computeStreak([]).sample, 0);
assert.strictEqual(computeStreak(undefined).length, 0);
const dots = computeStreak([m("win"), m("loss")]).last;
assert.deepStrictEqual(dots, ["loss", "win"]);                                      // oldest -> newest
assert.strictEqual(computeStreak(Array.from({ length: 30 }, () => m("win"))).last.length, 10);
console.log("✓ streak tests passed");

// --- coach insights
const mk = (outcome, map, kills, deaths, adr, hs, change) =>
  ({ outcome, map, elo_change: change, stats: { Kills: kills, Deaths: deaths, ADR: adr, "Headshots %": hs } });
assert.strictEqual(computeInsights([mk("win", "a", 10, 5, 80, 40, 20)], {}).enough, false);
const recent = Array.from({ length: 10 }, (_, i) => mk(i % 2 ? "loss" : "win", "de_mirage", 20, 10, 90, 50, i % 2 ? -22 : 24));
const older = Array.from({ length: 12 }, (_, i) => mk(i % 2 ? "loss" : "win", "de_nuke", 12, 12, 70, 40, i % 2 ? -22 : 24));
const ins = computeInsights([...recent, ...older], { elo: 1927, targets: [1800, 1900, 2000] });
assert.ok(ins.enough);
const kd = ins.rows.find((x) => x.key === "kd");
assert.strictEqual(kd.trend, "up"); assert.ok(Math.abs(kd.recent - 2) < 1e-9); assert.ok(Math.abs(kd.base - 1) < 1e-9);
assert.ok(/suggests/.test(ins.summary) && /not proof/.test(ins.summary));
assert.strictEqual(ins.maps.best.map === "de_mirage" || ins.maps.best.map === "de_nuke", true);
assert.strictEqual(ins.pace.target, 2000); assert.ok(ins.pace.estimate > 0);
// no baseline -> no claims
const few = computeInsights(recent, { elo: 1927, targets: [2000] });
assert.ok(few.rows.every((x) => x.trend === "none")); assert.ok(/baseline/i.test(few.summary));
// missing stats are skipped, not zero
const sparse = computeInsights([...recent.map((x) => ({ ...x, stats: {} })), ...older], { elo: 1800, targets: [] });
assert.strictEqual(sparse.rows.find((x) => x.key === "adr").recent, null);
assert.strictEqual(sparse.pace, null);
console.log("✓ coach insight tests passed");

// --- milestones
assert.strictEqual(levelOf(1927), 9);
const V = (o) => ({ v: 2, ...o });
let res = newMilestones(1927, [1800, 1900, 2000], null, 2274);
assert.ok(res.first && res.fire.length === 0 && res.elo.length === 2);            // first visit: silent
res = newMilestones(1927, [1800, 1900, 2000], { elo: [1800], level: 8 }, 2274);   // old (v1) saved state: adopted silently
assert.ok(res.first && res.fire.length === 0);
res = newMilestones(2005, [1800, 1900, 2000], V({ elo: [1800, 1900], level: 9, peak: 2274 }), 2274);
assert.deepStrictEqual(res.fire.map((f) => f.label), ["2,000 ELO", "LEVEL 10"]);
assert.strictEqual(res.newPeak, null);
res = newMilestones(1950, [1800, 1900, 2000], V({ elo: [1800, 1900], level: 9, peak: 2274 }), 2274);
assert.strictEqual(res.fire.length, 0);                                            // nothing new
res = newMilestones(1850, [1800, 1900, 2000], V({ elo: [1800, 1900], level: 9, peak: 2274 }), 2274);
assert.strictEqual(res.fire.length, 0);                                            // dipped below: no repeat
// hundreds above 2,000
assert.deepStrictEqual(reachedTargets(2230, [1800, 1900, 2000]), [1800, 1900, 2000, 2100, 2200]);
res = newMilestones(2105, [1800, 1900, 2000], V({ elo: [1800, 1900, 2000], level: 10, peak: 2274 }), 2274);
assert.deepStrictEqual(res.fire.map((f) => f.label), ["2,100 ELO"]);
// new all-time peak
res = newMilestones(2290, [1800, 1900, 2000], V({ elo: [1800, 1900, 2000, 2100, 2200], level: 10, peak: 2274 }), 2290);
assert.strictEqual(res.newPeak, 2290);
res = newMilestones(2274, [1800, 1900, 2000], V({ elo: [1800, 1900, 2000, 2100, 2200], level: 10, peak: 2274 }), 2274);
assert.strictEqual(res.newPeak, null);                                             // equal is not a new peak
res = newMilestones(2000, [1800, 1900, 2000], V({ elo: [1800, 1900, 2000], level: 9, peak: null }), 2274);
assert.strictEqual(res.newPeak, null);                                             // peak not known yet when stored: adopt, don't fire
console.log("✓ milestone tests passed");

// --- goal stage
const { computeGoalStage } = require("../public/js/features/goal-bar.js");
const O = { baseline: 1680, goal: 2000, targets: [1800, 1900, 2000] };
let g = computeGoalStage(1927, 2274, O);
assert.strictEqual(g.kind, "goal"); assert.strictEqual(g.end, 2000); assert.deepStrictEqual(g.ticks, [1680, 1800, 1900, 2000]);
g = computeGoalStage(2000, 2274, O);
assert.strictEqual(g.kind, "peak"); assert.strictEqual(g.start, 2000); assert.strictEqual(g.end, 2274);
assert.deepStrictEqual(g.ticks, [2000, 2100, 2200, 2274]);
g = computeGoalStage(2150, 2274, O);
assert.strictEqual(g.kind, "peak");
g = computeGoalStage(2274, 2274, O);
assert.strictEqual(g.kind, "beyond"); assert.ok(g.atPeak); assert.strictEqual(g.start, 2200); assert.strictEqual(g.end, 2300);
g = computeGoalStage(2310, 2310, O);
assert.strictEqual(g.start, 2300); assert.strictEqual(g.end, 2400); assert.ok(g.atPeak);
g = computeGoalStage(2050, null, O);                                               // no peak known
assert.strictEqual(g.kind, "beyond"); assert.strictEqual(g.start, 2000); assert.strictEqual(g.end, 2100);
g = computeGoalStage(2050, 1990, O);                                               // peak below goal is ignored
assert.strictEqual(g.kind, "beyond");
assert.strictEqual(computeGoalStage(null, 2274, O), null);
assert.strictEqual(computeGoalStage(NaN, 2274, O), null);
console.log("✓ goal stage tests passed");
console.log("All frontend feature tests passed successfully!");
