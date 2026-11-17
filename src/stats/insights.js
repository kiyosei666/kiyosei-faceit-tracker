// Rule-based insights. Every insight carries the evidence (metric, value, sample
// size, path into the analysis JSON) it was derived from. Wording is generated here
// from computed values, so nothing can drift from the numbers.
const { round } = require("./math");

const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const SIG_RANK = { clear: 3, likely: 2, possible: 1, descriptive: 0, none: -1, insufficient: -1 };

function deriveInsights(a) {
  const out = [];
  const add = (i) => out.push(i);

  // 1) Form shifts: strongest per metric across windows.
  const labels = { kd: "K/D", adr: "ADR", kr: "K/R", hs: "Headshot %", winRate: "Win rate" };
  const best = {};
  for (const [wk, w] of Object.entries(a.windows)) {
    for (const [mk, c] of Object.entries(w.vsEarlier)) {
      if (!c || c.status || !["clear", "likely", "possible"].includes(c.significance)) continue;
      if (!best[mk] || SIG_RANK[c.significance] > SIG_RANK[best[mk].c.significance] || (SIG_RANK[c.significance] === SIG_RANK[best[mk].c.significance] && Math.abs(c.z) > Math.abs(best[mk].c.z))) best[mk] = { wk, c, size: w.size };
    }
  }
  for (const [mk, { wk, c, size }] of Object.entries(best)) {
    const up = c.delta > 0, isRate = mk === "winRate";
    const fmt = (v) => (isRate ? pct(v, 1) : mk === "hs" ? `${v.toFixed(1)}%` : v.toFixed(mk === "adr" ? 1 : 2));
    add({
      id: `form.${wk}.${mk}`, type: "trend", polarity: up ? "positive" : "negative", significance: c.significance, confidence: c.significance === "possible" ? "low" : c.significance === "likely" ? "medium" : "high",
      title: `${labels[mk]} ${up ? "up" : "down"} over the last ${size} matches`,
      statement: `${labels[mk]} is ${fmt(c.recent)} over the last ${size} matches versus ${fmt(c.earlier)} before that (${c.significance} shift, z=${c.z}).`,
      evidence: [{ metric: `${labels[mk]} (last ${size})`, value: c.recent, comparison: c.earlier, n: c.nRecent, path: `windows.${wk}.vsEarlier.${mk}` }, { metric: `${labels[mk]} (earlier)`, value: c.earlier, n: c.nEarlier, path: `windows.${wk}.vsEarlier.${mk}` }]
    });
  }
  const shiftCount = Object.keys(best).length;
  if (!shiftCount && a.windows.last20.vsEarlier.kd && !a.windows.last20.vsEarlier.kd.status) {
    const k = a.windows.last20.vsEarlier.kd;
    add({ id: "form.stable", type: "trend", polarity: "neutral", significance: "none", confidence: "medium",
      title: "Recent form matches your baseline",
      statement: `No statistically meaningful change in K/D, ADR, K/R, headshot % or win rate between your recent windows and earlier matches (last 20 K/D ${k.recent} vs ${k.earlier}).`,
      evidence: [{ metric: "K/D (last 20)", value: k.recent, comparison: k.earlier, n: k.nRecent, path: "windows.last20.vsEarlier.kd" }] });
  }

  // 2) Maps.
  for (const m of a.maps) {
    if (m.verdict === "inconclusive" || m.reliability === "insufficient") continue;
    const above = m.verdict === "above_average";
    const overallWr = a.overall.winRate.value;
    const name = String(m.map).replace(/^de_/, "");
    add({
      id: `map.${name}`, type: above ? "strength" : "weakness", polarity: above ? "positive" : "negative",
      significance: m.reliability === "reliable" ? "likely" : "possible", confidence: m.reliability === "reliable" ? "medium" : "low",
      title: `${name}: ${above ? "above" : "below"} your average win rate`,
      statement: `${name}: ${pct(m.winRate.value, 1)} win rate over ${m.decided} decided matches (95% interval ${pct(m.winRate.ci95[0])}-${pct(m.winRate.ci95[1])}) versus ${pct(overallWr, 1)} overall.`,
      evidence: [{ metric: `Win rate on ${name}`, value: m.winRate.value, comparison: overallWr, n: m.decided, path: `maps[map=${m.map}].winRate` }]
    });
  }

  // 3) Opening duels (interval against a coin flip).
  const ew = a.overall.entryWinRate;
  if (ew && ew.supported !== false && ew.attempts >= 100) {
    const { wilson } = require("./math");
    const wins = Math.round(ew.value * ew.attempts);
    const ci = wilson(wins, ew.attempts);
    if (ci[1] < 0.5 || ci[0] > 0.5) {
      const good = ci[0] > 0.5;
      add({ id: "opening.entryWinRate", type: good ? "strength" : "weakness", polarity: good ? "positive" : "negative", significance: "likely", confidence: "medium",
        title: `Entry duels: ${good ? "winning" : "losing"} more than half`,
        statement: `You win ${pct(ew.value, 1)} of entry duels across ${ew.attempts} attempts (95% interval ${pct(ci[0])}-${pct(ci[1])}), ${good ? "above" : "below"} an even 50%.`,
        evidence: [{ metric: "Entry win rate", value: ew.value, comparison: 0.5, n: ew.attempts, path: "overall.entryWinRate" }] });
    }
  }

  // 4) Session patterns.
  const f = a.patterns.fatigueTest;
  if (f && !f.status && ["clear", "likely", "possible"].includes(f.significance) && f.lateWinRate < f.earlyWinRate) {
    add({ id: "pattern.longSessions", type: "pattern", polarity: "negative", significance: f.significance, confidence: f.significance === "possible" ? "low" : "medium",
      title: "Win rate drops late in long sessions",
      statement: `Win rate is ${pct(f.lateWinRate, 1)} from the 5th match of a session onward versus ${pct(f.earlyWinRate, 1)} in the first two (${f.nLate} vs ${f.nEarly} matches, ${f.significance}, z=${f.z}).`,
      evidence: [{ metric: "Win rate, match 5+ of session", value: f.lateWinRate, comparison: f.earlyWinRate, n: f.nLate, path: "patterns.fatigueTest" }] });
  }
  const ar = a.patterns.afterResult;
  if (ar.afterWin && ar.afterLoss && ar.z !== null && ["clear", "likely", "possible"].includes(require("./math").significance(ar.z)) && ar.afterLoss.winRate < ar.afterWin.winRate) {
    add({ id: "pattern.afterLoss", type: "pattern", polarity: "negative", significance: require("./math").significance(ar.z), confidence: "low",
      title: "Results dip right after a loss",
      statement: `Win rate in the next match is ${pct(ar.afterLoss.winRate, 1)} after a loss (n=${ar.afterLoss.n}) versus ${pct(ar.afterWin.winRate, 1)} after a win (n=${ar.afterWin.n}); same-session matches only.`,
      evidence: [{ metric: "Win rate after loss", value: ar.afterLoss.winRate, comparison: ar.afterWin.winRate, n: ar.afterLoss.n, path: "patterns.afterResult" }] });
  }

  // 5) Fluctuation (descriptive).
  const fl = a.patterns.fluctuation;
  if (fl && !fl.status) {
    add({ id: "pattern.fluctuation", type: "pattern", polarity: "neutral", significance: "descriptive", confidence: "medium",
      title: "Rolling 10-match K/D range",
      statement: `Across ${fl.windows} rolling 10-match windows, K/D has ranged from ${fl.kdMin} to ${fl.kdMax} (sd ${fl.kdSd}).`,
      evidence: [{ metric: "Rolling K/D min", value: fl.kdMin, n: fl.windows, path: "patterns.fluctuation" }, { metric: "Rolling K/D max", value: fl.kdMax, n: fl.windows, path: "patterns.fluctuation" }] });
  }

  // 6) Role profile.
  if (a.role && a.role.status === "ok") {
    add({ id: "role.profile", type: "pattern", polarity: "neutral", significance: "descriptive", confidence: a.role.confidence.level,
      title: `Playstyle tendency: ${a.role.profile}`,
      statement: `Stat pattern points to ${a.role.profile} (score ${a.role.primary.score}; confidence ${a.role.confidence.level}). Inferred from statistics, not positional data.`,
      evidence: a.role.scores[a.role.primary.id].indicators.map((i) => ({ metric: i.key, value: i.value, n: i.n, path: `role.scores.${a.role.primary.id}` })) });
  }

  // 7) Data limits (always honest about what is missing).
  const missing = [];
  if (a.overall.kast.supported === false) missing.push("KAST");
  if (a.sideSplit.supported === false) missing.push("CT/T side splits");
  for (const k of ["firstKillsPerRound", "entryWinRate", "clutch", "utilityDamagePerRound"]) if (a.overall[k] && a.overall[k].supported === false) missing.push(k);
  if (a.meta.statsCoverage < 0.95) missing.push(`stats for ${a.meta.totalMatches - a.meta.matchesWithStats} matches`);
  if (missing.length) {
    add({ id: "data.limits", type: "data", polarity: "neutral", significance: "descriptive", confidence: "high",
      title: "Metrics unavailable in stored data",
      statement: `Not available in the stored FACEIT stats: ${missing.join(", ")}. Analysis excludes them rather than estimating.`,
      evidence: [{ metric: "Stats coverage", value: a.meta.statsCoverage, n: a.meta.totalMatches, path: "meta.statsCoverage" }] });
  }

  out.sort((x, y) => (SIG_RANK[y.significance] ?? -1) - (SIG_RANK[x.significance] ?? -1));
  return out.slice(0, 16).map((i) => ({ ...i, evidence: i.evidence.map((e) => ({ ...e, value: typeof e.value === "number" ? round(e.value, 4) : e.value })) }));
}

module.exports = { deriveInsights };
