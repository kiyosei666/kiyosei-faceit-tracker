// Role / playstyle tendencies from MULTIPLE indicators with confidence.
// FACEIT match stats have no positional or demo data, so these are statistical
// tendencies, not observed behaviour. Reference ranges are fixed heuristics
// (documented here), NOT FACEIT population percentiles.
const { clamp01, round } = require("./math");

const ROLE_DEFS = {
  entry: {
    label: "Entry fragger", direct: true,
    indicators: [
      { key: "entryAttemptsPerRound", lo: 0.05, hi: 0.18 },
      { key: "entryWinRate", lo: 0.35, hi: 0.60 },
      { key: "firstKillsPerRound", lo: 0.06, hi: 0.18 }
    ]
  },
  rifler: {
    label: "Rifler", direct: true,
    indicators: [
      { key: "kr", lo: 0.55, hi: 0.90 },
      { key: "adr", lo: 60, hi: 90 },
      { key: "hsPct", lo: 35, hi: 60 },
      { key: "multiKillRoundsPerRound", lo: 0.06, hi: 0.20 },
      { key: "sniperKillShare", lo: 0, hi: 0.30, invert: true }
    ]
  },
  support: {
    label: "Support", direct: false,
    indicators: [
      { key: "utilityDamagePerRound", lo: 2, hi: 12 },
      { key: "enemiesFlashedPerRound", lo: 0.1, hi: 0.45 },
      { key: "assistsPerRound", lo: 0.08, hi: 0.22 },
      { key: "entryAttemptsPerRound", lo: 0.05, hi: 0.18, invert: true }
    ]
  },
  lurker: {
    label: "Lurker", direct: false,
    indicators: [
      { key: "clutchAttemptsPerRound", lo: 0.02, hi: 0.10 },
      { key: "entryAttemptsPerRound", lo: 0.05, hi: 0.18, invert: true },
      { key: "assistsPerRound", lo: 0.08, hi: 0.22, invert: true }
    ]
  }
};

const LEVELS = ["low", "medium", "high"];

function classifyRole(overall, meta) {
  const scores = {};
  for (const [id, def] of Object.entries(ROLE_DEFS)) {
    const used = [];
    for (const ind of def.indicators) {
      const m = overall[ind.key];
      if (!m || m.supported === false || m.value == null) continue;
      let s = clamp01((m.value - ind.lo) / (ind.hi - ind.lo));
      if (ind.invert) s = 1 - s;
      used.push({ key: ind.key, value: m.value, scaled: round(s, 3), inverted: Boolean(ind.invert), n: m.n });
    }
    scores[id] = used.length >= 2
      ? { label: def.label, score: round(used.reduce((a, b) => a + b.scaled, 0) / used.length, 3), indicatorsUsed: used.length, indicatorsPossible: def.indicators.length, evidenceType: def.direct ? "direct stats" : "indirect proxies", indicators: used }
      : { label: def.label, score: null, status: "insufficient_indicators", indicatorsUsed: used.length, indicatorsPossible: def.indicators.length };
  }
  const ranked = Object.entries(scores).filter(([, v]) => v.score !== null).sort((a, b) => b[1].score - a[1].score);
  if (!ranked.length) {
    return { status: "insufficient_data", reason: "Fewer than two usable indicators exist for any role in the stored stats.", scores, confidence: { level: "low", reasons: ["no role has two or more usable indicators"] } };
  }
  const [topId, top] = ranked[0];
  const second = ranked[1];
  const margin = second ? round(top.score - second[1].score, 3) : null;
  const hybrid = second && margin < 0.07;

  const n = meta.matchesWithStats;
  let level = n >= 150 ? 2 : n >= 50 ? 1 : 0;
  const reasons = [`${n} matches with stats`];
  if (top.indicatorsUsed < 3) { level = Math.min(level, 1); reasons.push(`only ${top.indicatorsUsed} indicators available for ${top.label}`); }
  if (ROLE_DEFS[topId].direct === false) { level = Math.min(level, topId === "lurker" ? 0 : 1); reasons.push(`${top.label} is inferred from indirect proxies, not positional data`); }
  if (hybrid) { level = Math.max(0, level - 1); reasons.push(`top two roles are within ${margin} of each other`); }

  return {
    status: "ok",
    primary: { id: topId, label: top.label, score: top.score },
    secondary: second ? { id: second[0], label: second[1].label, score: second[1].score } : null,
    margin,
    profile: hybrid ? `Hybrid: ${top.label} / ${second[1].label}` : top.label,
    hybrid: Boolean(hybrid),
    scores,
    confidence: { level: LEVELS[level], reasons },
    method: "Mean of indicator values scaled 0-1 against fixed reference ranges; a role needs at least two indicators. Not positional data.",
    referenceNote: "Reference ranges are fixed heuristics, not FACEIT population percentiles."
  };
}

module.exports = { classifyRole, ROLE_DEFS };
