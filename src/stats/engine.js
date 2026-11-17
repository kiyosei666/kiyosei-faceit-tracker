// Deterministic stats engine. Pure functions over stored match rows: no database,
// no network, no randomness. Every number the AI coach ever sees comes from here.
const { resolveStats, inventory } = require("./keys");
const { sum, mean, sd, round, wilson, welchZ, propZ, significance, percentRank } = require("./math");

const ENGINE_VERSION = "1.0.0";
const WINDOWS = [10, 20, 50];
const SESSION_GAP_MS = 2 * 3600 * 1000;
const MIN = { mapReliable: 15, mapTentative: 8, recent: 8, earlier: 20, bucket: 15 };

function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function parseRounds(score) {
  if (!score) return null;
  const nums = String(score).match(/\d+/g);
  if (!nums || nums.length !== 2) return null;
  const total = Number(nums[0]) + Number(nums[1]);
  return total >= 13 && total <= 80 ? total : null;
}

/** DB row -> normalized match. Outcome is read as stored and never altered. */
function normalizeMatch(row) {
  const o = String(row.outcome || "").toLowerCase();
  const m = resolveStats(row.stats);
  const rounds = parseRounds(row.score);
  return {
    id: row.match_id,
    time: toMs(row.finished_at),
    map: row.map || null,
    outcome: o === "win" ? "win" : o === "loss" ? "loss" : null,
    score: row.score || null,
    rounds,
    hasStats: Object.keys(m).length > 0,
    m
  };
}

const ratio = (a, b) => (b > 0 ? a / b : null);

// Per-match derived values used for variability tests (null when not derivable).
function perMatch(x) {
  const m = x.m;
  return {
    kd: m.kd ?? (m.kills != null && m.deaths > 0 ? m.kills / m.deaths : null),
    adr: m.adr ?? (m.damage != null && x.rounds ? m.damage / x.rounds : null),
    kr: m.kr ?? (m.kills != null && x.rounds ? m.kills / x.rounds : null),
    hs: m.hsPct ?? (m.headshots != null && m.kills > 0 ? (100 * m.headshots) / m.kills : null)
  };
}

const metric = (value, n, total, extra = {}) => ({ value, n, coverage: total ? round(n / total, 3) : 0, ...extra });
const unsupported = (reason) => ({ supported: false, reason });

/** Aggregate core metrics over a list of normalized matches. */
function aggregate(list) {
  const total = list.length;
  const withStats = list.filter((x) => x.hasStats);
  const decided = list.filter((x) => x.outcome);
  const wins = decided.filter((x) => x.outcome === "win").length;
  const pm = withStats.map(perMatch);
  const pick = (key) => withStats.map((x) => x.m[key]).filter((v) => v != null);
  const has = (key) => withStats.some((x) => x.m[key] != null);

  // Weighted sums over matches where all needed fields exist.
  const both = (a, b) => withStats.filter((x) => x.m[a] != null && x.m[b] != null);
  const kdSet = both("kills", "deaths");
  const out = { matches: total, matchesWithStats: withStats.length };

  out.winRate = decided.length
    ? metric(round(wins / decided.length, 4), decided.length, total, { wins, losses: decided.length - wins, ci95: wilson(wins, decided.length).map((v) => round(v, 4)) })
    : unsupported("no decided outcomes");

  out.kills = has("kills") ? metric(round(mean(pick("kills")), 2), pick("kills").length, total, { total: sum(pick("kills")), per: "match" }) : unsupported("Kills not stored");
  out.deaths = has("deaths") ? metric(round(mean(pick("deaths")), 2), pick("deaths").length, total, { total: sum(pick("deaths")), per: "match" }) : unsupported("Deaths not stored");
  out.assists = has("assists") ? metric(round(mean(pick("assists")), 2), pick("assists").length, total, { total: sum(pick("assists")), per: "match" }) : unsupported("Assists not stored");

  const kdVals = pm.map((p) => p.kd).filter((v) => v != null);
  out.kd = kdSet.length && sum(kdSet.map((x) => x.m.deaths)) > 0
    ? metric(round(sum(kdSet.map((x) => x.m.kills)) / sum(kdSet.map((x) => x.m.deaths)), 3), kdSet.length, total,
      { method: "sum(kills)/sum(deaths)", perMatchMean: round(mean(kdVals), 3), sd: round(sd(kdVals), 3) })
    : kdVals.length ? metric(round(mean(kdVals), 3), kdVals.length, total, { method: "mean of per-match K/D", sd: round(sd(kdVals), 3) })
    : unsupported("K/D inputs not stored");

  const krSet = withStats.filter((x) => x.m.kills != null && x.rounds);
  const krVals = pm.map((p) => p.kr).filter((v) => v != null);
  out.kr = krSet.length
    ? metric(round(sum(krSet.map((x) => x.m.kills)) / sum(krSet.map((x) => x.rounds)), 3), krSet.length, total, { method: "sum(kills)/sum(rounds)" })
    : krVals.length ? metric(round(mean(krVals), 3), krVals.length, total, { method: "mean of per-match K/R" })
    : unsupported("K/R inputs not stored");

  const adrSet = withStats.filter((x) => x.m.adr != null && x.rounds);
  const adrVals = pm.map((p) => p.adr).filter((v) => v != null);
  out.adr = adrSet.length
    ? metric(round(sum(adrSet.map((x) => x.m.adr * x.rounds)) / sum(adrSet.map((x) => x.rounds)), 2), adrSet.length, total, { method: "round-weighted mean", sd: round(sd(adrVals), 2) })
    : adrVals.length ? metric(round(mean(adrVals), 2), adrVals.length, total, { method: "mean of per-match ADR", sd: round(sd(adrVals), 2) })
    : unsupported("ADR not stored");

  const hsSet = withStats.filter((x) => x.m.kills > 0 && (x.m.headshots != null || x.m.hsPct != null));
  out.hsPct = hsSet.length
    ? metric(round(sum(hsSet.map((x) => (x.m.headshots != null ? x.m.headshots : (x.m.hsPct / 100) * x.m.kills))) / sum(hsSet.map((x) => x.m.kills)) * 100, 1), hsSet.length, total, { method: "kill-weighted" })
    : unsupported("Headshot data not stored");

  out.kast = has("kast") ? metric(round(mean(pick("kast")), 1), pick("kast").length, total, { method: "mean of per-match KAST" })
    : unsupported("KAST is not present in the stored FACEIT match stats");

  // Impact / opening duels (only when the inputs exist).
  const rd = (key) => withStats.filter((x) => x.m[key] != null && x.rounds);
  const perRound = (key) => { const s = rd(key); return s.length ? metric(round(sum(s.map((x) => x.m[key])) / sum(s.map((x) => x.rounds)), 4), s.length, total) : unsupported(`${key} or round count not stored`); };
  out.firstKillsPerRound = perRound("firstKills");
  out.entryAttemptsPerRound = perRound("entryCount");
  const entrySet = both("entryCount", "entryWins");
  const entryN = sum(entrySet.map((x) => x.m.entryCount));
  out.entryWinRate = entrySet.length && entryN > 0
    ? metric(round(sum(entrySet.map((x) => x.m.entryWins)) / entryN, 4), entrySet.length, total, { attempts: entryN })
    : unsupported("Entry duel counts not stored");
  out.mvpsPerRound = perRound("mvps");
  const mk = withStats.filter((x) => x.rounds && ["doubleKills", "tripleKills", "quadroKills", "pentaKills"].some((k) => x.m[k] != null));
  out.multiKillRoundsPerRound = mk.length
    ? metric(round(sum(mk.map((x) => (x.m.doubleKills || 0) + (x.m.tripleKills || 0) + (x.m.quadroKills || 0) + (x.m.pentaKills || 0))) / sum(mk.map((x) => x.rounds)), 4), mk.length, total)
    : unsupported("Multi-kill counts not stored");

  const c1 = both("v1Count", "v1Wins"), c2 = both("v2Count", "v2Wins");
  const clutchN = sum(c1.map((x) => x.m.v1Count)) + sum(c2.map((x) => x.m.v2Count));
  const clutchW = sum(c1.map((x) => x.m.v1Wins)) + sum(c2.map((x) => x.m.v2Wins));
  out.clutch = clutchN > 0 ? metric(round(clutchW / clutchN, 4), Math.max(c1.length, c2.length), total, { attempts: clutchN, wins: clutchW, scope: "1v1 and 1v2" }) : unsupported("Clutch counts not stored");
  out.clutchAttemptsPerRound = (() => {
    const s = withStats.filter((x) => x.rounds && (x.m.v1Count != null || x.m.v2Count != null));
    return s.length ? metric(round(sum(s.map((x) => (x.m.v1Count || 0) + (x.m.v2Count || 0))) / sum(s.map((x) => x.rounds)), 4), s.length, total) : unsupported("Clutch counts not stored");
  })();
  out.utilityDamagePerRound = perRound("utilityDamage");
  out.enemiesFlashedPerRound = perRound("enemiesFlashed");
  out.assistsPerRound = perRound("assists");
  const sk = withStats.filter((x) => x.m.sniperKills != null && x.m.kills > 0);
  out.sniperKillShare = sk.length ? metric(round(sum(sk.map((x) => x.m.sniperKills)) / sum(sk.map((x) => x.m.kills)), 4), sk.length, total) : unsupported("Sniper kills not stored");

  // Consistency: coefficient of variation of per-match K/D and ADR (lower = steadier).
  const cv = (vals) => (vals.length >= 10 && mean(vals) > 0 ? sd(vals) / mean(vals) : null);
  out.consistency = {
    kdCv: round(cv(kdVals), 3), adrCv: round(cv(adrVals), 3), n: kdVals.length,
    note: "Coefficient of variation of per-match values; lower means steadier. Not comparable to other players."
  };
  return out;
}

function compareWindow(recent, earlier) {
  const rpm = recent.filter((x) => x.hasStats).map(perMatch), epm = earlier.filter((x) => x.hasStats).map(perMatch);
  const series = (arr, k) => arr.map((p) => p[k]).filter((v) => v != null);
  const rows = {};
  const enough = (a, b) => a.length >= MIN.recent && b.length >= MIN.earlier;
  for (const [key, label] of [["kd", "K/D"], ["adr", "ADR"], ["kr", "K/R"], ["hs", "Headshot %"]]) {
    const a = series(rpm, key), b = series(epm, key);
    if (!enough(a, b)) { rows[key] = { label, status: "insufficient_sample", nRecent: a.length, nEarlier: b.length }; continue; }
    const z = welchZ(a, b);
    rows[key] = { label, recent: round(mean(a), 3), earlier: round(mean(b), 3), delta: round(mean(a) - mean(b), 3), z: round(z, 2), significance: significance(z), nRecent: a.length, nEarlier: b.length, basis: "per-match mean" };
  }
  const rd = recent.filter((x) => x.outcome), ed = earlier.filter((x) => x.outcome);
  if (rd.length >= MIN.recent && ed.length >= MIN.earlier) {
    const rw = rd.filter((x) => x.outcome === "win").length, ew = ed.filter((x) => x.outcome === "win").length;
    const z = propZ(rw, rd.length, ew, ed.length);
    rows.winRate = { label: "Win rate", recent: round(rw / rd.length, 4), earlier: round(ew / ed.length, 4), delta: round(rw / rd.length - ew / ed.length, 4), z: round(z, 2), significance: significance(z), nRecent: rd.length, nEarlier: ed.length };
  } else rows.winRate = { label: "Win rate", status: "insufficient_sample", nRecent: rd.length, nEarlier: ed.length };
  return rows;
}

function mapAnalysis(list, overall) {
  const by = new Map();
  for (const x of list) { if (!x.map) continue; if (!by.has(x.map)) by.set(x.map, []); by.get(x.map).push(x); }
  const overallPm = list.filter((x) => x.hasStats).map(perMatch).map((p) => p.kd).filter((v) => v != null);
  const overallWr = overall.winRate.supported === false ? null : overall.winRate.value;
  return [...by.entries()].map(([map, items]) => {
    const agg = aggregate(items);
    const decided = items.filter((x) => x.outcome).length;
    const reliability = decided >= MIN.mapReliable ? "reliable" : decided >= MIN.mapTentative ? "tentative" : "insufficient";
    const kdSeries = items.filter((x) => x.hasStats).map(perMatch).map((p) => p.kd).filter((v) => v != null);
    const kdZ = kdSeries.length >= MIN.mapTentative ? welchZ(kdSeries, overallPm) : null;
    let verdict = "inconclusive";
    if (reliability !== "insufficient" && agg.winRate.ci95 && overallWr !== null) {
      if (agg.winRate.ci95[0] > overallWr) verdict = "above_average";
      else if (agg.winRate.ci95[1] < overallWr) verdict = "below_average";
    }
    return { map, matches: items.length, decided, reliability, verdict, winRate: agg.winRate, kd: agg.kd, adr: agg.adr,
      kdVsOverall: kdZ === null ? null : { z: round(kdZ, 2), significance: significance(kdZ) } };
  }).sort((a, b) => b.decided - a.decided);
}

function sessionsOf(list) {
  const chrono = list.filter((x) => x.time !== null).sort((a, b) => a.time - b.time);
  const sessions = []; let cur = [];
  for (const x of chrono) {
    if (cur.length && x.time - cur[cur.length - 1].time > SESSION_GAP_MS) { sessions.push(cur); cur = []; }
    cur.push(x);
  }
  if (cur.length) sessions.push(cur);
  return sessions;
}

function patternAnalysis(list) {
  const out = {};
  // After a win vs after a loss (same-session only).
  const sessions = sessionsOf(list);
  const after = { win: { w: 0, n: 0 }, loss: { w: 0, n: 0 } };
  const buckets = { "1-2": [], "3-4": [], "5+": [] };
  for (const s of sessions) {
    s.forEach((x, i) => {
      const b = i < 2 ? "1-2" : i < 4 ? "3-4" : "5+";
      buckets[b].push(x);
      if (i > 0 && x.outcome && s[i - 1].outcome) { const k = s[i - 1].outcome; after[k].n++; if (x.outcome === "win") after[k].w++; }
    });
  }
  out.sessionDefinition = `A session is a run of matches with gaps under ${SESSION_GAP_MS / 3600000}h.`;
  out.sessions = { count: sessions.length, avgLength: round(mean(sessions.map((s) => s.length)), 2) };
  out.afterResult = {
    afterWin: after.win.n ? { winRate: round(after.win.w / after.win.n, 4), n: after.win.n, ci95: wilson(after.win.w, after.win.n).map((v) => round(v, 4)) } : null,
    afterLoss: after.loss.n ? { winRate: round(after.loss.w / after.loss.n, 4), n: after.loss.n, ci95: wilson(after.loss.w, after.loss.n).map((v) => round(v, 4)) } : null,
    z: after.win.n && after.loss.n ? round(propZ(after.win.w, after.win.n, after.loss.w, after.loss.n), 2) : null
  };
  out.bySessionPosition = {};
  for (const [name, items] of Object.entries(buckets)) {
    const a = aggregate(items);
    out.bySessionPosition[name] = { matches: items.length, winRate: a.winRate.supported === false ? null : { value: a.winRate.value, n: a.winRate.n, ci95: a.winRate.ci95 }, kd: a.kd.supported === false ? null : { value: a.kd.value, n: a.kd.n } };
  }
  const early = buckets["1-2"].filter((x) => x.outcome), late = buckets["5+"].filter((x) => x.outcome);
  out.fatigueTest = early.length >= MIN.bucket && late.length >= MIN.bucket
    ? (() => { const ew = early.filter((x) => x.outcome === "win").length, lw = late.filter((x) => x.outcome === "win").length; const z = propZ(lw, late.length, ew, early.length); return { lateWinRate: round(lw / late.length, 4), earlyWinRate: round(ew / early.length, 4), nLate: late.length, nEarly: early.length, z: round(z, 2), significance: significance(z) }; })()
    : { status: "insufficient_sample", nLate: late.length, nEarly: early.length };

  // Fluctuation: rolling 10-match K/D.
  const chrono = list.filter((x) => x.hasStats && x.time !== null).sort((a, b) => a.time - b.time);
  const rolling = [];
  for (let i = 10; i <= chrono.length; i++) { const a = aggregate(chrono.slice(i - 10, i)); if (a.kd.supported !== false) rolling.push({ end: chrono[i - 1].time, kd: a.kd.value }); }
  if (rolling.length >= 5) {
    const vals = rolling.map((r) => r.kd);
    const lo = rolling.reduce((a, b) => (b.kd < a.kd ? b : a)), hi = rolling.reduce((a, b) => (b.kd > a.kd ? b : a));
    out.fluctuation = { window: 10, windows: rolling.length, kdMin: round(lo.kd, 3), kdMax: round(hi.kd, 3), kdSd: round(sd(vals), 3), lowEndsAt: new Date(lo.end).toISOString(), highEndsAt: new Date(hi.end).toISOString() };
  } else out.fluctuation = { status: "insufficient_sample", windows: rolling.length };
  return out;
}

/** Full analysis from raw DB rows (any order). */
function analyze(rows, { now = Date.now() } = {}) {
  const list = rows.map(normalizeMatch);
  // newest first; rows without a timestamp go last so they never count as "recent"
  const newest = [...list].sort((a, b) => (b.time ?? -Infinity) - (a.time ?? -Infinity));
  const inv = inventory(rows);
  const overall = aggregate(newest);
  const windows = {};
  for (const n of WINDOWS) {
    const recent = newest.slice(0, n), earlier = newest.slice(n);
    windows[`last${n}`] = { size: recent.length, metrics: aggregate(recent), vsEarlier: compareWindow(recent, earlier) };
  }
  const maps = mapAnalysis(newest, overall);
  const patterns = patternAnalysis(newest);
  const result = {
    meta: {
      engineVersion: ENGINE_VERSION, generatedAt: new Date(now).toISOString(),
      totalMatches: list.length, matchesWithStats: overall.matchesWithStats,
      statsCoverage: list.length ? round(overall.matchesWithStats / list.length, 4) : 0,
      matchesWithRounds: list.filter((x) => x.rounds).length,
      latestMatch: newest[0] ? { id: newest[0].id, time: newest[0].time ? new Date(newest[0].time).toISOString() : null, map: newest[0].map, outcome: newest[0].outcome } : null,
      windows: WINDOWS, minimumSamples: MIN,
      notes: [
        "Rates are aggregated over matches where the needed fields exist; unsupported metrics are reported as supported:false, never as zero.",
        "Significance uses normal-approximation tests (Welch z / two-proportion z); several comparisons are shown, so single 'possible' results can be chance.",
        "FACEIT match stats contain no positional or demo data; role tendencies are inferred from statistic patterns only."
      ]
    },
    inventory: { canonical: inv.canonical, sideSplit: inv.sideSplit, statsStatus: inv.statsStatus, unmappedKeys: inv.unmappedKeys },
    overall, windows, maps, patterns,
    sideSplit: inv.sideSplit.supported ? { supported: true, note: "Side keys exist but are not mapped yet.", keys: inv.sideSplit.keys } : inv.sideSplit
  };
  const { classifyRole } = require("./roles");
  const { deriveInsights } = require("./insights");
  result.role = classifyRole(overall, result.meta);
  result.insights = deriveInsights(result);
  return result;
}

/** Compare one match against the player's previous matches (excluding itself and anything later). */
function analyzeMatch(rows, matchId, { baselineSize = 50 } = {}) {
  const list = rows.map(normalizeMatch).sort((a, b) => (b.time ?? -Infinity) - (a.time ?? -Infinity));
  const idx = list.findIndex((x) => x.id === matchId);
  if (idx === -1) return null;
  const match = list[idx];
  const prior = list.slice(idx + 1, idx + 1 + baselineSize);
  const priorStats = prior.filter((x) => x.hasStats);
  const mine = perMatch(match);
  const compare = {};
  const lines = [["kd", "K/D"], ["adr", "ADR"], ["kr", "K/R"], ["hs", "Headshot %"]];
  for (const [key, label] of lines) {
    const series = priorStats.map(perMatch).map((p) => p[key]).filter((v) => v != null);
    if (mine[key] == null || series.length < MIN.recent) { compare[key] = { label, status: mine[key] == null ? "not_available" : "insufficient_baseline", value: round(mine[key], 3), baselineN: series.length }; continue; }
    const m = mean(series), s = sd(series);
    const z = s > 0 ? (mine[key] - m) / s : null;
    compare[key] = { label, value: round(mine[key], 3), baselineMean: round(m, 3), baselineSd: round(s, 3), z: round(z, 2), percentile: round(percentRank(series, mine[key]), 3), band: z === null ? "typical" : z >= 1 ? "well above usual" : z <= -1 ? "well below usual" : "typical", baselineN: series.length };
  }
  const raw = {};
  for (const k of ["kills", "deaths", "assists", "firstKills", "entryCount", "entryWins", "mvps", "tripleKills", "quadroKills", "pentaKills", "v1Count", "v1Wins", "v2Count", "v2Wins", "utilityDamage", "enemiesFlashed"]) if (match.m[k] != null) raw[k] = match.m[k];
  const mapPrior = prior.filter((x) => x.map === match.map && x.outcome);
  return {
    match: { id: match.id, time: match.time ? new Date(match.time).toISOString() : null, map: match.map, outcome: match.outcome, score: match.score, rounds: match.rounds, hasStats: match.hasStats },
    raw, compare,
    baseline: { size: prior.length, withStats: priorStats.length, note: `Compared with the ${prior.length} matches before this one.` },
    mapHistory: { map: match.map, priorMatchesOnMap: mapPrior.length, priorWinRate: mapPrior.length ? round(mapPrior.filter((x) => x.outcome === "win").length / mapPrior.length, 4) : null },
    meta: { engineVersion: ENGINE_VERSION, minimumSamples: MIN }
  };
}

module.exports = { analyze, analyzeMatch, aggregate, normalizeMatch, parseRounds, perMatch, ENGINE_VERSION, MIN, WINDOWS };
