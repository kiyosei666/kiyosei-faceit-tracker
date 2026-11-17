// Maps FACEIT per-match player stat keys (stored verbatim in faceit_matches.stats)
// to canonical metric names, and inventories what the stored data really contains.
// Nothing is assumed: a canonical metric is "supported" only if a matching key
// appears in the stored stats.

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9%]/g, "");

// canonical name -> candidate FACEIT keys (first match wins)
const ALIASES = {
  kills: ["Kills"],
  deaths: ["Deaths"],
  assists: ["Assists"],
  kd: ["K/D Ratio"],
  kr: ["K/R Ratio"],
  adr: ["ADR", "Average Damage per Round"],
  damage: ["Damage", "Total Damage"],
  hsPct: ["Headshots %"],
  headshots: ["Headshots"],
  kast: ["KAST", "KAST %"],
  mvps: ["MVPs"],
  doubleKills: ["Double Kills"],
  tripleKills: ["Triple Kills"],
  quadroKills: ["Quadro Kills"],
  pentaKills: ["Penta Kills"],
  firstKills: ["First Kills"],
  entryCount: ["Match Entry Count", "Entry Count"],
  entryWins: ["Match Entry Wins", "Entry Wins"],
  clutchKills: ["Clutch Kills"],
  v1Count: ["1v1Count"],
  v1Wins: ["1v1Wins"],
  v2Count: ["1v2Count"],
  v2Wins: ["1v2Wins"],
  sniperKills: ["Sniper Kills"],
  utilityDamage: ["Utility Damage"],
  flashCount: ["Flash Count"],
  enemiesFlashed: ["Enemies Flashed"],
  flashSuccesses: ["Flash Successes"],
  utilityCount: ["Utility Count"],
  utilitySuccesses: ["Utility Successes"]
};

const ALIAS_INDEX = new Map(); // normalized key -> canonical
for (const [canonical, keys] of Object.entries(ALIASES)) {
  keys.forEach((k, i) => { if (!ALIAS_INDEX.has(norm(k))) ALIAS_INDEX.set(norm(k), { canonical, priority: i }); });
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/,/g, "");
  if (s === "" ) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Resolve all canonical metrics present in one stats object. Missing stays null (never 0). */
function resolveStats(stats) {
  const out = {};
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return out;
  const best = {};
  for (const [key, raw] of Object.entries(stats)) {
    const hit = ALIAS_INDEX.get(norm(key));
    if (!hit) continue;
    const n = toNumber(raw);
    if (n === null) continue;
    if (best[hit.canonical] === undefined || hit.priority < best[hit.canonical]) {
      best[hit.canonical] = hit.priority;
      out[hit.canonical] = n;
    }
  }
  return out;
}

/**
 * Inventory of what the stored stats contain: every raw key with its coverage,
 * which canonical metrics are supported, and which are not.
 */
function inventory(rows) {
  const total = rows.length;
  const withStats = rows.filter((r) => r.stats && typeof r.stats === "object" && Object.keys(r.stats).length);
  const keyInfo = new Map();
  const canonicalCount = {};
  for (const r of withStats) {
    for (const [key, raw] of Object.entries(r.stats)) {
      let info = keyInfo.get(key);
      if (!info) { info = { key, matches: 0, numeric: 0, sample: raw }; keyInfo.set(key, info); }
      info.matches++;
      if (toNumber(raw) !== null) info.numeric++;
    }
    for (const canonical of Object.keys(resolveStats(r.stats))) canonicalCount[canonical] = (canonicalCount[canonical] || 0) + 1;
  }
  const statusCounts = {};
  for (const r of rows) statusCounts[r.stats_status || "unknown"] = (statusCounts[r.stats_status || "unknown"] || 0) + 1;

  const keys = [...keyInfo.values()].map((k) => ({
    key: k.key, matches: k.matches, coverage: withStats.length ? +(k.matches / withStats.length).toFixed(4) : 0,
    numericShare: +(k.numeric / k.matches).toFixed(4), sample: k.sample,
    mappedTo: ALIAS_INDEX.get(norm(k.key))?.canonical || null
  })).sort((a, b) => b.matches - a.matches || a.key.localeCompare(b.key));

  const canonical = {};
  for (const name of Object.keys(ALIASES)) {
    const n = canonicalCount[name] || 0;
    canonical[name] = { supported: n > 0, matches: n, coverage: withStats.length ? +(n / withStats.length).toFixed(4) : 0 };
  }
  // Side-split detection is data driven: only reported as available if such keys exist.
  const sideKeys = keys.map((k) => k.key).filter((k) => /\b(ct|counter.?terrorist|terrorist)\b/i.test(k) || /\bt[ _-]?side\b/i.test(k));

  return {
    totalMatches: total,
    matchesWithStats: withStats.length,
    statsStatus: statusCounts,
    keys,
    canonical,
    unmappedKeys: keys.filter((k) => !k.mappedTo).map((k) => k.key),
    sideSplit: sideKeys.length
      ? { supported: true, keys: sideKeys }
      : { supported: false, reason: `No CT/T side keys exist in the ${withStats.length} stored match stat objects.` }
  };
}

module.exports = { ALIASES, norm, toNumber, resolveStats, inventory };
