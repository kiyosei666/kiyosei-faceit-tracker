/* Level progress ring — progress inside the current FACEIT level (CS2 ELO bands).
   Listens to "kiyosei:data". Pure helper exported for tests. */
(function () {
  // First ELO of each level 1..10. Level 10 has no upper bound here.
  const LEVEL_STARTS = [100, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];

  function computeLevelProgress(elo) {
    const v = Number(elo);
    if (elo === null || elo === undefined || !Number.isFinite(v)) return null;
    let i = 0;
    for (let k = 0; k < LEVEL_STARTS.length; k++) if (v >= LEVEL_STARTS[k]) i = k;
    const start = LEVEL_STARTS[i];
    const next = LEVEL_STARTS[i + 1] ?? null;
    if (next === null) return { level: i + 1, start, next, progress: 1, remaining: 0, max: true };
    const progress = Math.max(0, Math.min(1, (v - start) / (next - start)));
    return { level: i + 1, start, next, progress, remaining: next - v, max: false };
  }

  function render(detail) {
    const ring = document.getElementById("level-ring");
    const caption = document.getElementById("ring-caption");
    if (!ring) return;
    const info = computeLevelProgress(detail && detail.elo);
    if (!info) {
      ring.style.setProperty("--p", 0);
      if (caption) caption.textContent = "";
      return;
    }
    const pct = Math.round(info.progress * 100);
    ring.style.setProperty("--p", (info.progress * 100).toFixed(2));
    const text = info.max
      ? `LEVEL ${info.level} · TOP SKILL LEVEL`
      : `LEVEL ${info.level} → ${info.level + 1} · ${pct}%`;
    if (caption) caption.textContent = text;
    ring.setAttribute("aria-label", info.max ? `Level ${info.level}, highest skill level` : `Level ${info.level} progress: ${pct}%, ${info.remaining} ELO to level ${info.level + 1}`);
    ring.title = info.max ? `Level ${info.level}` : `${info.remaining} ELO to level ${info.level + 1}`;
  }

  if (typeof document !== "undefined") document.addEventListener("kiyosei:data", (e) => render(e.detail));
  if (typeof module !== "undefined" && module.exports) module.exports = { computeLevelProgress, LEVEL_STARTS };
})();
