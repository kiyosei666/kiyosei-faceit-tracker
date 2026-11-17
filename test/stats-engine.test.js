// Pure unit tests for the deterministic stats engine (no database, no network).
const assert = require("assert");
const { analyze, analyzeMatch, parseRounds } = require("../src/stats/engine");
const { inventory, resolveStats } = require("../src/stats/keys");
const { wilson, welchZ, significance } = require("../src/stats/math");
const { makeRows } = require("./stats-fixtures");

const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === "object" && deepFreeze(v)); return Object.freeze(o); };

// --- math
assert.deepStrictEqual(wilson(0, 0), null);
const ci = wilson(50, 100); assert(ci[0] < 0.5 && ci[1] > 0.5 && ci[0] > 0.39 && ci[1] < 0.61);
assert.strictEqual(significance(2.7), "clear"); assert.strictEqual(significance(2.1), "likely");
assert.strictEqual(significance(1.6), "possible"); assert.strictEqual(significance(0.3), "none"); assert.strictEqual(significance(null), "insufficient");
assert.strictEqual(welchZ([1], [1, 2]), null);

// --- key resolution: no zero-filling, % vs count disambiguated
const r = resolveStats({ Kills: "20", "Headshots %": "45", Headshots: "9", ADR: "", Deaths: "abc", "K/D Ratio": "1.25" });
assert.deepStrictEqual(r, { kills: 20, hsPct: 45, headshots: 9, kd: 1.25 });
assert.strictEqual(parseRounds("13-9"), 22); assert.strictEqual(parseRounds("13"), null); assert.strictEqual(parseRounds(null), null);

// --- analysis on a realistic set; engine never mutates input
const rows = deepFreeze(makeRows({ n: 300, kdShiftLast: 0.25 }));
const a = analyze(rows);
assert.strictEqual(a.meta.totalMatches, 300);
assert.strictEqual(a.meta.matchesWithStats, 288, "rows with null stats are excluded from stat aggregates");
assert.strictEqual(a.overall.winRate.n, 300, "outcomes still count when stats are missing");
assert.strictEqual(a.overall.winRate.wins + a.overall.winRate.losses, 300);
assert.strictEqual(a.overall.kast.supported, false, "KAST must be reported unsupported, not invented");
assert.strictEqual(a.sideSplit.supported, false);
assert(a.overall.kd.value > 0.8 && a.overall.kd.value < 1.3);
assert(a.overall.adr.method === "round-weighted mean");
for (const k of ["last10", "last20", "last50"]) assert(a.windows[k].size === +k.slice(4));
assert.strictEqual(a.windows.last20.vsEarlier.adr.significance, "clear", "a +40%-ish ADR shift must be detected");
assert(a.insights.some((i) => i.id === "form.last20.adr" && i.evidence.length && i.evidence.every((e) => e.path)), "insights carry traceable evidence");
assert(a.insights.every((i) => i.statement && i.evidence.length), "every insight has evidence");
const nuke = a.maps.find((m) => m.map === "de_nuke");
assert.strictEqual(nuke.verdict, "below_average", "a genuinely weak map is flagged");
assert(a.insights.some((i) => i.id === "map.nuke" && i.type === "weakness"));
assert.strictEqual(a.role.status, "ok"); assert(["low", "medium", "high"].includes(a.role.confidence.level));
assert(a.role.scores.lurker.evidenceType === "indirect proxies");

// --- stable data: no spurious shift insight
const flat = analyze(makeRows({ n: 300, seed: 11, kdShiftLast: 0 }));
assert(!flat.insights.some((i) => i.type === "trend" && ["clear", "likely"].includes(i.significance) && /last(10|20)\./.test(i.id) && i.id.endsWith("adr")), "no clear ADR shift on stationary data");

// --- small samples are honest
const small = analyze(makeRows({ n: 12 }));
assert.strictEqual(small.windows.last10.vsEarlier.kd.status, "insufficient_sample");
assert(small.maps.every((m) => m.reliability === "insufficient" || m.reliability === "tentative"));
assert(!small.insights.some((i) => i.id.startsWith("map.")), "no map verdicts from tiny samples");

// --- missing stats entirely / sparse keys / empty
const noStats = analyze(makeRows({ n: 60, withStats: false }));
assert.strictEqual(noStats.overall.kd.supported, false);
assert.strictEqual(noStats.role.status, "insufficient_data");
assert(noStats.insights.some((i) => i.id === "data.limits"));
const sparse = analyze(makeRows({ n: 120, extraKeys: false }));
assert.strictEqual(sparse.overall.entryWinRate.supported, false);
assert.strictEqual(sparse.overall.clutch.supported, false);
assert.strictEqual(analyze([]).meta.totalMatches, 0);

// --- inventory reflects reality
const inv = inventory(rows);
assert.strictEqual(inv.canonical.kast.supported, false);
assert.strictEqual(inv.canonical.kills.supported, true);
assert(inv.keys.find((k) => k.key === "ADR").coverage > 0.9);
assert.strictEqual(inv.sideSplit.supported, false);
const withSide = inventory([{ stats: { Kills: "1", "CT Kills": "1" }, stats_status: "available" }]);
assert.strictEqual(withSide.sideSplit.supported, true);

// --- per-match report
const rep = analyzeMatch(rows, "m299");
assert.strictEqual(rep.match.id, "m299");
assert(rep.compare.kd.baselineN === 48 || rep.compare.kd.baselineN === 50);
assert.strictEqual(analyzeMatch(rows, "nope"), null);
const oldest = analyzeMatch(rows, "m0");
assert.strictEqual(oldest.baseline.size, 0, "the oldest match has no earlier matches to compare with");
assert.strictEqual(oldest.compare.kd.status, "not_available", "m0 has no stored stats in the fixture");
assert.strictEqual(analyzeMatch(rows, "m3").compare.kd.status, "insufficient_baseline", "3 prior matches is too few to judge");
const mid = analyzeMatch(rows, "m100");
assert.strictEqual(mid.baseline.size, 50, "baseline is the 50 matches before this one, never later ones");

// --- historical outcomes are read, never rewritten
const unknownRow = { match_id: "x", finished_at: "1760000000", map: "de_mirage", outcome: "Unknown", score: null, stats: null, stats_status: "pending" };
const u = analyze([unknownRow]);
assert.strictEqual(u.overall.winRate.supported, false);

// --- scale / determinism
const big = makeRows({ n: 3305, seed: 3 });
const t0 = Date.now(); const b1 = analyze(big, { now: 1 }); const ms = Date.now() - t0;
assert(ms < 3000, `analysis of 3,305 matches took ${ms}ms`);
assert.strictEqual(JSON.stringify(b1), JSON.stringify(analyze(big, { now: 1 })), "same input -> identical output");
console.log(`✓ stats engine tests passed (3,305-match analysis: ${ms}ms)`);
