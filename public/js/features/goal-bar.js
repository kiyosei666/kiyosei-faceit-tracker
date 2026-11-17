/* ==========================================================================
   Goal bar. The target moves with you:
     below the goal (2,000)        -> road to the goal, from the 1,680 baseline
     goal reached, below your peak -> road back to your all-time peak
     at / past your peak           -> next hundred above you (new-peak territory)
   Reads kiyosei:data ({ elo, peakElo, baseline, goal, targets }). No hardcoded peak.
   ========================================================================== */
(function () {
  const fmt = (n) => Number(n).toLocaleString();

  function computeGoalStage(elo, peak, opts) {
    const o = opts || {};
    const baseline = Number.isFinite(o.baseline) ? o.baseline : 1680;
    const goal = Number.isFinite(o.goal) ? o.goal : 2000;
    const targets = Array.isArray(o.targets) ? o.targets : [1800, 1900, 2000];
    const v = Number(elo);
    if (elo === null || elo === undefined || !Number.isFinite(v)) return null;
    const p = Number(peak);
    const hasPeak = peak !== null && peak !== undefined && Number.isFinite(p) && p > goal;

    if (v < goal) {
      return { kind: "goal", start: baseline, end: goal, endName: fmt(goal),
        ticks: [baseline, ...targets.filter((t) => t > baseline && t < goal), goal], label: `ROAD TO ${fmt(goal)}` };
    }
    if (hasPeak && v < p) {
      const mid = [];
      for (let h = Math.floor(goal / 100) * 100 + 100; h < p; h += 100) mid.push(h);
      return { kind: "peak", start: goal, end: p, endName: "YOUR PEAK", ticks: [goal, ...mid, p], label: "ROAD BACK TO YOUR PEAK" };
    }
    const start = Math.floor(v / 100) * 100;
    const end = start + 100;
    const atPeak = hasPeak && v === p;
    return { kind: "beyond", start, end, endName: fmt(end), ticks: [start, end],
      label: atPeak ? "AT YOUR ALL-TIME PEAK" : hasPeak ? "NEW PEAK TERRITORY" : `PAST ${fmt(goal)}`, atPeak: atPeak || (hasPeak && v > p) };
  }

  function render(detail) {
    const bar = document.getElementById("goal-bar");
    if (!bar) return;
    const stage = computeGoalStage(detail && detail.elo, detail && detail.peakElo,
      { baseline: detail && detail.baseline, goal: detail && detail.goal, targets: detail && detail.targets });
    const label = document.getElementById("goal-label");
    const remaining = document.getElementById("goal-remaining");
    const ticks = document.getElementById("goal-ticks");
    if (!stage) {
      bar.style.setProperty("--p", 0);
      if (label) label.textContent = "";
      if (remaining) remaining.textContent = "";
      if (ticks) ticks.innerHTML = "";
      bar.removeAttribute("data-stage");
      return;
    }
    const v = Number(detail.elo);
    const span = stage.end - stage.start;
    const pct = (x) => Math.max(0, Math.min(100, ((x - stage.start) / span) * 100));
    bar.style.setProperty("--p", pct(v).toFixed(2));
    bar.dataset.stage = stage.kind;
    bar.classList.toggle("goal--peak", !!stage.atPeak);
    if (label) label.textContent = stage.label;
    if (remaining) {
      const left = stage.end - v;
      remaining.textContent = `${fmt(left)} ELO TO ${stage.endName}`;
    }
    if (ticks) {
      ticks.innerHTML = stage.ticks.map((t) =>
        `<span class="goal__tick${v >= t ? " is-reached" : ""}" style="left:${pct(t)}%">${fmt(t)}</span>`).join("");
    }
    bar.setAttribute("aria-label", `${stage.label}: ${fmt(v)} ELO, ${fmt(stage.end - v)} to ${stage.endName}`);
  }

  if (typeof document !== "undefined") document.addEventListener("kiyosei:data", (e) => render(e.detail));
  if (typeof module !== "undefined" && module.exports) module.exports = { computeGoalStage };
})();
