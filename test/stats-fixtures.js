// Deterministic synthetic match rows shaped like faceit_matches (stats = raw FACEIT keys).
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function makeRows({ n = 300, seed = 7, withStats = true, kdShiftLast = 0, extraKeys = true } = {}) {
  const r = rng(seed);
  const maps = ["de_mirage", "de_inferno", "de_ancient", "de_nuke", "de_dust2"];
  const rows = [];
  let t = 1760000000;
  for (let i = 0; i < n; i++) {
    t += i % 3 === 0 ? 3 * 3600 : 40 * 60; // sessions of ~3 matches
    const map = maps[i % maps.length];
    const recent = i >= n - 20;
    const rounds = 20 + Math.floor(r() * 8);
    const kills = Math.max(3, Math.round(16 + (r() - 0.5) * 10 + (recent ? kdShiftLast * 12 : 0)));
    const deaths = Math.max(3, Math.round(16 + (r() - 0.5) * 8));
    const win = r() < (map === "de_nuke" ? 0.3 : 0.52);
    const w = win ? 13 : Math.min(12, rounds - 13);
    const score = win ? `13-${rounds - 13}` : `${rounds - 13}-13`;
    const stats = withStats && !(i % 25 === 0) ? {
      Kills: String(kills), Deaths: String(deaths), Assists: String(Math.round(r() * 8)),
      "K/D Ratio": (kills / deaths).toFixed(2), "K/R Ratio": (kills / rounds).toFixed(2),
      ADR: String(Math.round(60 + r() * 40 + (recent ? kdShiftLast * 40 : 0))),
      "Headshots %": String(Math.round(35 + r() * 25)), Headshots: String(Math.round(kills * 0.45)), MVPs: String(Math.round(r() * 5)),
      "Triple Kills": String(Math.round(r() * 2)), "Quadro Kills": "0", "Penta Kills": "0", "Double Kills": String(Math.round(r() * 4)),
      Result: win ? "1" : "0",
      ...(extraKeys ? {
        "First Kills": String(Math.round(r() * 4)), "Match Entry Count": String(Math.round(r() * 5)), "Match Entry Wins": String(Math.round(r() * 2)),
        "1v1Count": String(Math.round(r() * 1.4)), "1v1Wins": String(Math.round(r() * 1)), "1v2Count": String(Math.round(r() * 0.8)), "1v2Wins": "0",
        "Sniper Kills": String(Math.round(r() * 2)), "Utility Damage": String(Math.round(r() * 120)), "Enemies Flashed": String(Math.round(r() * 8))
      } : {})
    } : null;
    rows.push({ match_id: `m${i}`, finished_at: String(t), map, outcome: win ? "Win" : "Loss", score: stats || withStats === false ? score : score, stats, stats_status: stats ? "available" : "pending" });
  }
  return rows;
}
module.exports = { makeRows };
