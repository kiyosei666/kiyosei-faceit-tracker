// Gemini coach tests: grounding/validation (pure) + caching/limits/fallbacks against a real
// PostgreSQL test database with a fake Gemini transport. No real API key or network is used.
const assert = require("assert");
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/tracker_test";
process.env.DATABASE_SSL = "disable";

const { pool, runMigrations } = require("../src/db");
const coach = require("../src/coach");
const stats = require("../src/stats/service");
const { analyze } = require("../src/stats/engine");
const { makeRows } = require("./stats-fixtures");

const SECRET_KEY = "AIza-test-secret-key-do-not-leak";
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const wrap = (json, extra = {}) => reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: "STOP", ...extra }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 300 }, modelVersion: "gemini-test" });
const factsFrom = (body) => JSON.parse(JSON.parse(body).contents[0].parts[0].text.split("FACTS:\n")[1].split("\n\nYour previous")[0]);

function goodOverview(facts) {
  const by = (t) => facts.insights.filter((i) => i.type === t);
  return {
    headline: "Solid baseline with a few measurable leaks", assessment: "Your numbers are stable overall.", recentForm: by("trend")[0] ? by("trend")[0].statement : "No meaningful change.", roleProfile: "Statistical tendencies only, not observed positioning.",
    strengths: by("strength").slice(0, 2).map((i) => ({ text: i.statement, insightIds: [i.id] })),
    weaknesses: by("weakness").slice(0, 2).map((i) => ({ text: i.statement, insightIds: [i.id] })),
    recurringPatterns: by("pattern").slice(0, 1).map((i) => ({ text: i.statement, insightIds: [i.id] })),
    recommendations: [{ action: "Review demos of your weakest map before queueing it.", rationale: "The map result is below your average.", insightIds: [facts.insights[0].id], trackMetric: "Win rate on that map" }],
    caveats: ["Statistics only; no gameplay was reviewed."]
  };
}
const goodMatch = () => ({ headline: "Typical output", summary: "Within your usual range.", wentWell: [{ text: "Damage output was typical.", metrics: ["adr"] }], toImprove: [{ text: "Nothing stands out statistically.", metrics: ["kd"] }], takeaway: "Keep tracking ADR.", caveats: [] });

(async () => {
  // ---------- pure: number grounding ----------
  const facts = { a: 0.507, b: 1.14, s: "win rate is 50.7% over 60 matches on de_dust2, 1v1 clutches", n: 288 };
  const allowed = coach.collectNumbers(facts);
  assert.deepStrictEqual(coach.ungroundedNumbers("K/D is 1.14 and win rate 50.7% across 288 matches on de_dust2 (1v1).", allowed), []);
  assert.deepStrictEqual(coach.ungroundedNumbers("That is 51% or about 1.1", allowed), [], "faithful roundings of facts (50.7 -> 51, 1.14 -> 1.1) are grounded");
  assert.deepStrictEqual(coach.ungroundedNumbers("That is 52% or about 1.3", allowed), ["52", "1.3"], "numbers that are not roundings of any fact are caught");
  assert.deepStrictEqual(coach.ungroundedNumbers("K/D is 1.31 and ADR 95.2", allowed), ["1.31", "95.2"], "invented numbers are caught");
  assert.deepStrictEqual(coach.ungroundedNumbers("one to three priorities, top 2", allowed), [], "tiny counts are allowed");

  // ---------- pure: report validation ----------
  const a = analyze(makeRows({ n: 300, kdShiftLast: 0.25 }));
  const f = coach.buildOverviewFacts(a);
  assert(f.insights.length && !JSON.stringify(f).includes("evidence"), "facts stay compact");
  assert.deepStrictEqual(coach.validateReport("overview", goodOverview(f), f), []);
  const invented = goodOverview(f); invented.assessment = "Your K/D is 1.87 now.";
  assert(coach.validateReport("overview", invented, f).some((p) => /numbers not present/.test(p)));
  const badId = goodOverview(f); badId.recommendations[0].insightIds = ["made.up"];
  assert(coach.validateReport("overview", badId, f).some((p) => /valid insight ids/.test(p)));
  const watched = goodOverview(f); watched.headline = "I watched your demo and your positioning is off.";
  assert(coach.validateReport("overview", watched, f).some((p) => /watched/.test(p)));
  assert(coach.validateReport("overview", "nope", f).length);

  // ---------- Gemini transport ----------
  const cfg = { ...coach.config(), apiKey: SECRET_KEY, timeoutMs: 5000 };
  let seen;
  const ok = await coach.callGemini({ system: "s", user: "u", schema: coach.OVERVIEW_SCHEMA }, { cfg, fetchImpl: async (url, init) => { seen = { url, init }; return wrap({ hello: "world" }); } });
  assert.deepStrictEqual(ok.json, { hello: "world" });
  assert(!seen.url.includes(SECRET_KEY), "API key never appears in the URL");
  assert.strictEqual(seen.init.headers["x-goog-api-key"], SECRET_KEY);
  const sent = JSON.parse(seen.init.body);
  assert(!("temperature" in sent.generationConfig) && !("topP" in sent.generationConfig) && !("topK" in sent.generationConfig), "deprecated sampling params are not sent");
  assert.strictEqual(sent.generationConfig.responseMimeType, "application/json");
  let calls = 0;
  const retried = await coach.callGemini({ system: "s", user: "u", schema: {} }, { cfg, fetchImpl: async () => (++calls === 1 ? reply({ error: { message: "slow down" } }, 429) : wrap({ ok: 1 })) });
  assert.strictEqual(calls, 2); assert.deepStrictEqual(retried.json, { ok: 1 });
  calls = 0;
  await assert.rejects(coach.callGemini({ system: "s", user: "u", schema: {} }, { cfg, fetchImpl: async () => { calls++; return reply({ error: { message: `bad key ${SECRET_KEY}` } }, 403); } }), (e) => { assert(!e.message.includes(SECRET_KEY)); return /rejected the API key/.test(e.message); });
  assert.strictEqual(calls, 1, "403 is not retried");
  await assert.rejects(coach.callGemini({ system: "s", user: "u", schema: {} }, { cfg, fetchImpl: async () => reply({ candidates: [{ content: { parts: [{ text: "{not json" }] }, finishReason: "STOP" }] }) }), /invalid JSON/);
  await assert.rejects(coach.callGemini({ system: "s", user: "u", schema: {} }, { cfg, fetchImpl: async () => wrap({ a: 1 }, { finishReason: "MAX_TOKENS" }) }), /stopped early/);
  await assert.rejects(coach.callGemini({ system: "s", user: "u", schema: {} }, { cfg: { ...cfg, apiKey: "" } }), /not configured/);

  // ---------- database-backed orchestration ----------
  await runMigrations();
  const seed = async (rows) => {
    await pool.query("DELETE FROM coach_reports"); await pool.query("DELETE FROM faceit_matches");
    for (const r of rows) await pool.query("INSERT INTO faceit_matches (match_id, finished_at, map, outcome, score, stats, stats_status) VALUES ($1,$2,$3,$4,$5,$6,$7)", [r.match_id, r.finished_at, r.map, r.outcome, r.score, r.stats ? JSON.stringify(r.stats) : null, r.stats_status]);
    stats.invalidate();
  };
  const rows = makeRows({ n: 300, kdShiftLast: 0.25 });
  await seed(rows);
  const before = (await pool.query("SELECT md5(string_agg(match_id||coalesce(outcome,'')||coalesce(stats::text,''), ',' ORDER BY match_id)) h, count(*)::int n FROM faceit_matches")).rows[0];

  delete process.env.GEMINI_API_KEY;
  assert.strictEqual((await coach.getOverview()).ai.status, "not_configured");
  const det = await coach.getOverview();
  assert(det.analysis.insights.length, "deterministic analysis is returned even with no AI configured");

  process.env.GEMINI_API_KEY = SECRET_KEY;
  let geminiCalls = 0;
  const fake = { fetchImpl: async (_u, init) => { geminiCalls++; const body = JSON.parse(init.body); const text = body.contents[0].parts[0].text; const fct = factsFrom(init.body); return wrap(text.includes("post-match") ? goodMatch() : goodOverview(fct)); } };

  const first = await coach.getOverview({ opts: fake });
  assert.strictEqual(first.ai.status, "generated"); assert.strictEqual(geminiCalls, 1);
  assert(first.ai.report.recommendations.length >= 1);
  const second = await coach.getOverview({ opts: fake });
  assert.strictEqual(second.ai.status, "cached"); assert.strictEqual(geminiCalls, 1, "identical facts never call Gemini twice");
  const par = await Promise.all([coach.getOverview({ opts: fake }), coach.getOverview({ opts: fake })]);
  assert(par.every((p) => p.ai.status === "cached") && geminiCalls === 1);

  // new data inside the refresh interval -> previous report, no spend
  await pool.query("INSERT INTO faceit_matches (match_id, finished_at, map, outcome, score, stats, stats_status) VALUES ('m_new', $1, 'de_mirage', 'Win', '13-7', $2, 'available')", [String(1760000000 + 9999999), JSON.stringify({ Kills: "25", Deaths: "10", "K/D Ratio": "2.5", ADR: "110", "Headshots %": "50", Headshots: "12" })]);
  stats.invalidate();
  const within = await coach.getOverview({ opts: fake });
  assert.strictEqual(within.ai.status, "stale"); assert.strictEqual(geminiCalls, 1);
  const forced = await coach.getOverview({ force: true, opts: fake });
  assert.strictEqual(forced.ai.status, "generated"); assert.strictEqual(geminiCalls, 2);

  // match reports: only recent matches generate
  const recent = await coach.getMatchReport("latest", { opts: fake });
  assert.strictEqual(recent.match.match.id, "m_new"); assert.strictEqual(recent.ai.status, "generated");
  const old = await coach.getMatchReport("m100", { opts: fake });
  assert.strictEqual(old.ai.status, "unavailable"); assert(old.match.compare.kd, "deterministic comparison still returned for old matches");
  assert.strictEqual(await coach.getMatchReport("missing", { opts: fake }), null);
  const callsAfterMatch = geminiCalls;

  // validation failure: model invents numbers -> discarded, not shown, not retried within cooldown
  await pool.query("DELETE FROM coach_reports"); geminiCalls = 0;
  const liar = { fetchImpl: async (_u, init) => { geminiCalls++; const r = goodOverview(factsFrom(init.body)); r.assessment = "Your K/D is 1.87 and ADR 123.4."; return wrap(r); } };
  const rejected = await coach.getOverview({ opts: liar });
  assert.strictEqual(rejected.ai.status, "unavailable"); assert.strictEqual(geminiCalls, 2, "one corrective retry, then discard");
  assert(!JSON.stringify(rejected).includes("1.87"), "invented numbers never reach the client");
  assert.strictEqual((await pool.query("SELECT status FROM coach_reports")).rows[0].status, "rejected");
  await coach.getOverview({ opts: liar });
  assert.strictEqual(geminiCalls, 2, "rejected input is not retried during cooldown");

  // self-correction on retry is accepted
  await pool.query("DELETE FROM coach_reports"); geminiCalls = 0;
  const corrects = { fetchImpl: async (_u, init) => { geminiCalls++; const r = goodOverview(factsFrom(init.body)); if (geminiCalls === 1) r.assessment = "K/D is 9.99."; return wrap(r); } };
  assert.strictEqual((await coach.getOverview({ opts: corrects })).ai.status, "generated"); assert.strictEqual(geminiCalls, 2);

  // daily cap
  await pool.query("DELETE FROM coach_reports"); geminiCalls = 0; process.env.COACH_DAILY_LIMIT = "1";
  await coach.getOverview({ opts: fake });
  const capped = await coach.getMatchReport("latest", { opts: fake });
  assert.strictEqual(capped.ai.status, "unavailable"); assert(/limit/i.test(capped.ai.message)); assert.strictEqual(geminiCalls, 1);
  delete process.env.COACH_DAILY_LIMIT;

  // API outage: deterministic data survives, no crash, backoff engaged
  await pool.query("DELETE FROM coach_reports");
  const down = await coach.getOverview({ opts: { cfg: { ...coach.config(), timeoutMs: 1000 }, fetchImpl: async () => reply({ error: { message: "boom" } }, 400) } });
  assert.strictEqual(down.ai.status, "unavailable"); assert(down.analysis.overall.kd.value > 0);
  assert(!JSON.stringify(down).includes(SECRET_KEY), "secret never appears in responses");

  // historical match records are untouched by all of the above (except the one match this test inserted)
  await pool.query("DELETE FROM faceit_matches WHERE match_id='m_new'");
  const after = (await pool.query("SELECT md5(string_agg(match_id||coalesce(outcome,'')||coalesce(stats::text,''), ',' ORDER BY match_id)) h, count(*)::int n FROM faceit_matches")).rows[0];
  assert.deepStrictEqual(after, before, "stats engine and coach never modify faceit_matches");

  await pool.query("DELETE FROM coach_reports"); await pool.query("DELETE FROM faceit_matches");
  await pool.end();
  console.log("✓ coach tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
