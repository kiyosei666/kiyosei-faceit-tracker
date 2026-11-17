// Gemini AI coach. The deterministic stats engine is the only source of numbers:
// Gemini receives computed facts, returns structured JSON, and every number in its
// prose is checked against those facts before anything is shown or stored.
const crypto = require("crypto");
const { pool, ensureSchema } = require("./db");
const stats = require("./stats/service");

const num = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };
const config = () => ({
  apiKey: process.env.GEMINI_API_KEY || "",
  model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  maxOutputTokens: num("GEMINI_MAX_OUTPUT_TOKENS", 4096),
  timeoutMs: num("GEMINI_TIMEOUT_MS", 45000),
  dailyLimit: num("COACH_DAILY_LIMIT", 20),
  minIntervalMin: num("COACH_MIN_INTERVAL_MIN", 60),
  matchRecentLimit: num("COACH_MATCH_RECENT_LIMIT", 5),
  rejectedCooldownHours: 6
});

/* ------------------------------ facts ------------------------------ */

const pickMetric = (m) => (m && m.supported !== false ? { value: m.value, n: m.n } : null);

function buildOverviewFacts(a) {
  const o = a.overall;
  const facts = {
    sample: { totalMatches: a.meta.totalMatches, matchesWithStats: a.meta.matchesWithStats, windowSizes: a.meta.windows },
    overall: {
      winRate: pickMetric(o.winRate), kd: pickMetric(o.kd), kr: pickMetric(o.kr), adr: pickMetric(o.adr), hsPct: pickMetric(o.hsPct),
      entryWinRate: pickMetric(o.entryWinRate), firstKillsPerRound: pickMetric(o.firstKillsPerRound), clutch: pickMetric(o.clutch)
    },
    windows: Object.fromEntries(Object.entries(a.windows).map(([k, w]) => [k, {
      matches: w.size, winRate: pickMetric(w.metrics.winRate), kd: pickMetric(w.metrics.kd), adr: pickMetric(w.metrics.adr),
      vsEarlier: Object.fromEntries(Object.entries(w.vsEarlier).filter(([, c]) => !c.status).map(([mk, c]) => [mk, { recent: c.recent, earlier: c.earlier, delta: c.delta, significance: c.significance }]))
    }])),
    role: a.role.status === "ok" ? { profile: a.role.profile, confidence: a.role.confidence.level, confidenceReasons: a.role.confidence.reasons, primaryScore: a.role.primary.score, secondary: a.role.secondary && a.role.secondary.label } : { status: "insufficient_data" },
    maps: a.maps.filter((m) => m.reliability !== "insufficient").slice(0, 8).map((m) => ({ map: m.map, decidedMatches: m.decided, winRate: m.winRate.value, verdict: m.verdict, reliability: m.reliability })),
    insights: a.insights.map((i) => ({ id: i.id, type: i.type, significance: i.significance, confidence: i.confidence, statement: i.statement })),
    unavailableMetrics: ["KAST", ...(a.sideSplit.supported === false ? ["CT/T side splits"] : [])]
      .concat(Object.entries(o).filter(([, v]) => v && v.supported === false && !["kast"].includes(v)).map(([k]) => k).filter((k) => ["firstKillsPerRound", "entryWinRate", "clutch", "utilityDamagePerRound"].includes(k)))
  };
  return facts;
}

function buildMatchFacts(m) {
  return {
    match: { map: m.match.map, outcome: m.match.outcome, score: m.match.score, rounds: m.match.rounds },
    raw: m.raw,
    compareWithPrevious: Object.fromEntries(Object.entries(m.compare).map(([k, c]) => [k, c.status ? { status: c.status, value: c.value } : { value: c.value, baselineMean: c.baselineMean, band: c.band, percentile: c.percentile }])),
    baselineMatches: m.baseline.size,
    mapHistory: m.mapHistory
  };
}

const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const hashOf = (v) => crypto.createHash("sha256").update(stable(v)).digest("hex");

/* ----------------------------- prompts ----------------------------- */

const SYSTEM = [
  "You are Kiyosei's CS2 performance coach. You interpret statistics that a deterministic engine already computed.",
  "HARD RULES:",
  "1. Use ONLY numbers that appear verbatim in the FACTS JSON. Never calculate, sum, subtract, average, round differently, estimate or infer any number. If a figure you want is not in FACTS, describe it in words without a number.",
  "2. Never claim to have watched gameplay, demos, replays or footage, and never describe positioning, crosshair placement, utility usage or decisions as observed. You only see aggregate statistics.",
  "3. Respect significance and confidence labels. 'possible' or 'low' means tentative; say so. 'none' means no meaningful change. Never present a tentative finding as certain.",
  "4. Role statements are statistical tendencies, not observed behaviour; mention the stated confidence.",
  "5. Every strength, weakness, pattern and recommendation must cite insight ids from FACTS.insights that actually support it. Do not invent insight ids.",
  "6. Recommendations must be specific to the cited evidence and say which stat to track. No generic advice (e.g. 'aim better'). If evidence is thin, recommend gathering more matches instead.",
  "7. Do not mention dates, ELO changes or any metric listed in unavailableMetrics as if known.",
  "Write in plain, direct language. Keep each text field to 1-3 sentences."
].join("\n");

const strArr = { type: "ARRAY", items: { type: "STRING" } };
const textRef = { type: "OBJECT", properties: { text: { type: "STRING" }, insightIds: strArr }, required: ["text", "insightIds"] };
const OVERVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" }, assessment: { type: "STRING" }, recentForm: { type: "STRING" }, roleProfile: { type: "STRING" },
    strengths: { type: "ARRAY", items: textRef }, weaknesses: { type: "ARRAY", items: textRef }, recurringPatterns: { type: "ARRAY", items: textRef },
    recommendations: { type: "ARRAY", items: { type: "OBJECT", properties: { action: { type: "STRING" }, rationale: { type: "STRING" }, insightIds: strArr, trackMetric: { type: "STRING" } }, required: ["action", "rationale", "insightIds", "trackMetric"] } },
    caveats: strArr
  },
  required: ["headline", "assessment", "recentForm", "roleProfile", "strengths", "weaknesses", "recurringPatterns", "recommendations", "caveats"]
};
const MATCH_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" }, summary: { type: "STRING" },
    wentWell: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, metrics: strArr }, required: ["text", "metrics"] } },
    toImprove: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, metrics: strArr }, required: ["text", "metrics"] } },
    takeaway: { type: "STRING" }, caveats: strArr
  },
  required: ["headline", "summary", "wentWell", "toImprove", "takeaway", "caveats"]
};

const overviewPrompt = (facts) => `Write the coaching overview from these FACTS.\nFACTS:\n${JSON.stringify(facts)}`;
const matchPrompt = (facts) => `Write a post-match report. 'compareWithPrevious' compares this match with the player's previous matches; 'band' says whether it was unusual. Cite metrics by their keys in compareWithPrevious or raw.\nFACTS:\n${JSON.stringify(facts)}`;

/* --------------------------- validation ---------------------------- */

function collectNumbers(value, acc = new Set()) {
  if (typeof value === "number" && Number.isFinite(value)) { acc.add(value); if (Math.abs(value) <= 1) acc.add(value * 100); }
  else if (typeof value === "string") for (const t of numberTokens(value)) { acc.add(t.value); if (Math.abs(t.value) <= 1) acc.add(t.value * 100); }
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, acc));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, acc));
  return acc;
}

function numberTokens(text) {
  const cleaned = String(text).replace(/\bde_[a-z0-9]+\b/gi, " ").replace(/\b1v[1-5]\b/gi, " ").replace(/\b(?:CS2|CS:?GO)\b/gi, " ").replace(/\b[a-z]+\.[a-z0-9.]+\b/gi, " ");
  const tokens = [];
  for (const m of cleaned.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?/g)) {
    const decimals = (m[0].split(".")[1] || "").length;
    tokens.push({ raw: m[0], value: Number(m[0]), decimals });
  }
  return tokens;
}

function ungroundedNumbers(text, allowed) {
  const bad = [];
  for (const t of numberTokens(text)) {
    if (Number.isInteger(t.value) && t.value >= 0 && t.value <= 3) continue; // "one to three"-style counts
    const tol = 0.5 * 10 ** -t.decimals + 1e-9;
    let ok = false;
    for (const v of allowed) { if (Math.abs(Math.abs(t.value) - Math.abs(v)) <= tol) { ok = true; break; } }
    if (!ok) bad.push(t.raw);
  }
  return bad;
}

const CLAIMS_WATCHED = /\b(?:i|we)\s+(?:watched|saw|reviewed|looked at|studied)\b[^.]{0,40}\b(?:demo|replay|gameplay|footage|vod|rounds?)\b|\bin (?:the|your) (?:demo|replay|footage)\b|\bwatching (?:your )?(?:demo|replay|gameplay)\b/i;

function proseOf(report) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === "string") { if (!["insightIds", "metrics", "trackMetric"].includes(key)) out.push(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(report, "");
  return out;
}

function validateReport(kind, report, facts) {
  const problems = [];
  const isStr = (s, max = 600) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
  if (!report || typeof report !== "object" || Array.isArray(report)) return ["response is not a JSON object"];
  const allowed = collectNumbers(facts);
  const ids = new Set((facts.insights || []).map((i) => i.id));
  const metricKeys = new Set([...Object.keys(facts.compareWithPrevious || {}), ...Object.keys(facts.raw || {}), "outcome", "mapHistory"]);

  if (kind === "overview") {
    for (const f of ["headline", "assessment", "recentForm", "roleProfile"]) if (!isStr(report[f])) problems.push(`${f} missing or too long`);
    for (const [f, max] of [["strengths", 4], ["weaknesses", 4], ["recurringPatterns", 3]]) {
      if (!Array.isArray(report[f]) || report[f].length > max) { problems.push(`${f} must be an array of at most ${max}`); continue; }
      report[f].forEach((it, i) => {
        if (!it || !isStr(it.text)) problems.push(`${f}[${i}].text invalid`);
        if (!it || !Array.isArray(it.insightIds) || !it.insightIds.length || !it.insightIds.every((x) => ids.has(x))) problems.push(`${f}[${i}] must cite valid insight ids`);
      });
    }
    if (!Array.isArray(report.recommendations) || report.recommendations.length < 1 || report.recommendations.length > 5) problems.push("recommendations must contain 1-5 items");
    else report.recommendations.forEach((r, i) => {
      if (!r || !isStr(r.action) || !isStr(r.rationale) || !isStr(r.trackMetric, 120)) problems.push(`recommendations[${i}] incomplete`);
      if (!r || !Array.isArray(r.insightIds) || !r.insightIds.length || !r.insightIds.every((x) => ids.has(x))) problems.push(`recommendations[${i}] must cite valid insight ids`);
    });
    if (!Array.isArray(report.caveats)) problems.push("caveats must be an array");
  } else {
    for (const f of ["headline", "summary", "takeaway"]) if (!isStr(report[f])) problems.push(`${f} missing or too long`);
    for (const f of ["wentWell", "toImprove"]) {
      if (!Array.isArray(report[f]) || report[f].length > 4) { problems.push(`${f} must be an array of at most 4`); continue; }
      report[f].forEach((it, i) => {
        if (!it || !isStr(it.text)) problems.push(`${f}[${i}].text invalid`);
        if (!it || !Array.isArray(it.metrics) || !it.metrics.length || !it.metrics.every((x) => metricKeys.has(x))) problems.push(`${f}[${i}] must cite metrics present in the facts`);
      });
    }
    if (!Array.isArray(report.caveats)) problems.push("caveats must be an array");
  }
  const prose = proseOf(report);
  const bad = new Set();
  for (const p of prose) { ungroundedNumbers(p, allowed).forEach((n) => bad.add(n)); if (CLAIMS_WATCHED.test(p)) problems.push("claims to have watched gameplay"); }
  if (bad.size) problems.push(`numbers not present in the facts: ${[...bad].slice(0, 8).join(", ")}`);
  return problems;
}

/* ----------------------------- Gemini ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini({ system, user, schema }, { fetchImpl = fetch, cfg = config() } = {}) {
  if (!cfg.apiKey) { const e = new Error("GEMINI_API_KEY is not configured on the server."); e.code = "not_configured"; throw e; }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  // Sampling parameters are intentionally omitted: current Gemini models reject or ignore them.
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, maxOutputTokens: cfg.maxOutputTokens }
  };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs)
      });
      if (res.ok) {
        const data = await res.json();
        const cand = data.candidates && data.candidates[0];
        const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map((p) => p.text || "").join("") : "";
        if (!text) { const e = new Error(`Gemini returned no content${cand && cand.finishReason ? ` (finishReason ${cand.finishReason})` : ""}.`); e.code = "empty"; throw e; }
        if (cand.finishReason && cand.finishReason !== "STOP") { const e = new Error(`Gemini stopped early (${cand.finishReason}).`); e.code = "truncated"; throw e; }
        let parsed;
        try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()); }
        catch { const e = new Error("Gemini returned invalid JSON."); e.code = "bad_json"; throw e; }
        return { json: parsed, usage: data.usageMetadata || null, model: data.modelVersion || cfg.model };
      }
      let detail = "";
      try { detail = String((await res.json())?.error?.message || "").slice(0, 200); } catch { /* ignore */ }
      const e = new Error(res.status === 401 || res.status === 403 ? "Gemini rejected the API key." : res.status === 429 ? "Gemini rate limit or quota reached." : `Gemini API returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      e.status = res.status; e.code = "http";
      if (res.status !== 429 && res.status < 500) throw e;
      lastError = e;
    } catch (error) {
      if (error.code === "http" && error.status < 500 && error.status !== 429) throw error;
      if (["not_configured", "empty", "truncated", "bad_json"].includes(error.code)) throw error;
      if (error.name === "TimeoutError" || error.name === "AbortError") error.message = `Gemini request timed out after ${cfg.timeoutMs}ms.`;
      lastError = error;
    }
    if (attempt < 2) await sleep(1500 * 2 ** attempt);
  }
  throw lastError;
}

/** Generate + validate; one corrective retry; never returns an unvalidated report. */
async function generateValidated(kind, facts, opts = {}) {
  const prompt = kind === "overview" ? overviewPrompt(facts) : matchPrompt(facts);
  const schema = kind === "overview" ? OVERVIEW_SCHEMA : MATCH_SCHEMA;
  const usage = [];
  let problems = [];
  let user = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callGemini({ system: SYSTEM, user, schema }, opts);
    usage.push(out.usage);
    problems = validateReport(kind, out.json, facts);
    if (!problems.length) return { ok: true, report: out.json, usage, model: out.model };
    user = `${prompt}\n\nYour previous answer was rejected for these reasons: ${problems.join("; ")}. Rewrite it using only numbers present in FACTS and valid insight ids/metric keys.`;
  }
  return { ok: false, problems, usage };
}

/* ------------------------ caching / orchestration ------------------------ */

const inflight = new Map();
let lastApiFailureAt = 0;

async function dailyCount() {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM coach_reports WHERE created_at > NOW() - INTERVAL '24 hours'");
  return r.rows[0].n;
}

async function resolveReport(kind, subjectKey, facts, { force = false, allowGenerate = true, opts } = {}) {
  const cfg = (opts && opts.cfg) || config();
  if (!cfg.apiKey) return { status: "not_configured", message: "AI coach is not configured (GEMINI_API_KEY is missing). Deterministic statistics are still shown." };
  await ensureSchema();
  const inputHash = hashOf(facts);
  const cached = await pool.query("SELECT status, report, model, created_at, error FROM coach_reports WHERE kind=$1 AND subject_key=$2 AND input_hash=$3", [kind, subjectKey, inputHash]);
  const hit = cached.rows[0];
  if (hit && hit.status === "ok") return { status: "cached", report: hit.report, model: hit.model, generatedAt: hit.created_at };
  const latest = (await pool.query("SELECT report, model, created_at FROM coach_reports WHERE kind=$1 AND subject_key=$2 AND status='ok' ORDER BY created_at DESC LIMIT 1", [kind, subjectKey])).rows[0];
  const stale = (message) => (latest ? { status: "stale", report: latest.report, model: latest.model, generatedAt: latest.created_at, message } : { status: "unavailable", message });

  if (hit && hit.status === "rejected" && Date.now() - new Date(hit.created_at).getTime() < cfg.rejectedCooldownHours * 3600000 && !force) return stale("The last AI draft for this data failed validation; showing the previous report.");
  if (!allowGenerate) return stale("AI reports are generated only for recent matches.");
  if (!force && kind === "overview" && latest && Date.now() - new Date(latest.created_at).getTime() < cfg.minIntervalMin * 60000) return stale(`Report refreshes at most every ${cfg.minIntervalMin} minutes.`);
  if (Date.now() - lastApiFailureAt < 2 * 60000) return stale("Gemini was unreachable moments ago; try again shortly.");
  if ((await dailyCount()) >= cfg.dailyLimit) return stale("Daily AI report limit reached.");

  const key = `${kind}:${subjectKey}:${inputHash}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    try {
      const out = await generateValidated(kind, facts, opts);
      if (out.ok) {
        await pool.query(
          `INSERT INTO coach_reports (kind, subject_key, input_hash, model, status, report, usage) VALUES ($1,$2,$3,$4,'ok',$5,$6)
           ON CONFLICT (kind, subject_key, input_hash) DO UPDATE SET status='ok', report=EXCLUDED.report, usage=EXCLUDED.usage, model=EXCLUDED.model, error=NULL, created_at=NOW()`,
          [kind, subjectKey, inputHash, out.model, JSON.stringify(out.report), JSON.stringify(out.usage)]);
        return { status: "generated", report: out.report, model: out.model, generatedAt: new Date().toISOString() };
      }
      await pool.query(
        `INSERT INTO coach_reports (kind, subject_key, input_hash, status, error, usage) VALUES ($1,$2,$3,'rejected',$4,$5)
         ON CONFLICT (kind, subject_key, input_hash) DO UPDATE SET status='rejected', error=EXCLUDED.error, usage=EXCLUDED.usage, created_at=NOW()`,
        [kind, subjectKey, inputHash, out.problems.join("; ").slice(0, 500), JSON.stringify(out.usage)]);
      return stale("The AI draft failed validation (unsupported numbers or claims) and was discarded.");
    } catch (error) {
      lastApiFailureAt = Date.now();
      console.error("Coach generation failed:", error.message);
      return stale(error.message);
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, job);
  return job;
}

async function getOverview({ force = false, opts } = {}) {
  const analysis = await stats.getAnalysis();
  const facts = buildOverviewFacts(analysis);
  const ai = await resolveReport("overview", "player", facts, { force, opts });
  return { analysis, ai };
}

async function getMatchReport(matchId, { force = false, opts } = {}) {
  const match = await stats.getMatchAnalysis(matchId);
  if (!match) return null;
  const rows = await stats.loadRows();
  const { normalizeMatch } = require("./stats/engine");
  const order = rows.map(normalizeMatch).filter((x) => x.time !== null).sort((a, b) => b.time - a.time).map((x) => x.id);
  const rank = order.indexOf(match.match.id);
  const cfg = config();
  const facts = buildMatchFacts(match);
  // buildMatchFacts has no insight ids; metric keys are validated instead.
  facts.insights = [];
  const ai = await resolveReport("match", match.match.id, facts, { force, opts, allowGenerate: rank !== -1 && rank < cfg.matchRecentLimit });
  return { match, ai };
}

module.exports = {
  getOverview, getMatchReport, buildOverviewFacts, buildMatchFacts, validateReport, generateValidated, callGemini,
  collectNumbers, ungroundedNumbers, hashOf, config, SYSTEM, OVERVIEW_SCHEMA, MATCH_SCHEMA
};
