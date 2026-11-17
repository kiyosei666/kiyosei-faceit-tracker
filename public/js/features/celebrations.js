/* ==========================================================================
   Milestone celebrations — confetti + banner when you
     - cross an ELO target (data.targets, then every 100 above 2,000),
     - move up a FACEIT level, or
     - set a NEW ALL-TIME PEAK (data.peakElo rises above the stored one).

   - Each milestone fires once; progress is remembered in localStorage.
   - The first time this browser sees the dashboard, milestones you already
     passed are recorded silently (no surprise confetti on load).
   - If localStorage is unavailable nothing fires (it would repeat every visit).
   - prefers-reduced-motion: banner only, no confetti.
   Preview any time:  add ?celebrate=1900  or  ?celebrate=level  to the URL,
   ?celebrate=peak, or run KiyoseiCelebrate.demo("1,900 ELO") in the console.
   ========================================================================== */
(function () {
  const KEY = "kiyosei:milestones:v1";
  const STATE_VERSION = 2;   // older saved state is adopted silently (no surprise confetti after an update)
  const COLORS = ["#ff5500", "#ffb020", "#22c55e", "#3b82f6", "#8b5cf6", "#e0408a", "#ffffff"];
  let banner = null, hideTimer = null, rafId = null, canvas = null;

  function levelOf(elo) {
    const starts = [100, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];
    let lvl = 1; starts.forEach((s, i) => { if (elo >= s) lvl = i + 1; });
    return lvl;
  }

  function read() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
  function write(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch { return false; } }

  /* ELO targets that count as reached: the configured ones plus every 100 above 2,000 */
  function reachedTargets(elo, targets) {
    const list = (targets || []).filter((t) => elo >= t);
    for (let h = 2100; h <= elo; h += 100) if (!list.includes(h)) list.push(h);
    return list;
  }

  /* Pure decision: what is newly reached compared with what is stored? */
  function newMilestones(elo, targets, stored, peak) {
    const reached = reachedTargets(elo, targets);
    const level = levelOf(elo);
    const peakNow = Number.isFinite(Number(peak)) && peak !== null ? Number(peak) : null;
    if (!stored || stored.v !== STATE_VERSION) {
      return { first: true, elo: reached, level, peak: peakNow, fire: [], newPeak: null };
    }
    const seen = new Set(stored.elo || []);
    const fire = reached.filter((t) => !seen.has(t)).map((t) => ({ kind: "elo", label: `${t.toLocaleString()} ELO` }));
    if (level > (stored.level || 0)) fire.push({ kind: "level", label: `LEVEL ${level}` });
    const newPeak = peakNow !== null && stored.peak !== null && stored.peak !== undefined && peakNow > stored.peak ? peakNow : null;
    return { first: false, elo: reached, level, peak: peakNow, fire, newPeak };
  }

  function showBanner(label, eyebrow) {
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "milestone glass";
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      document.body.appendChild(banner);
    }
    banner.innerHTML = `<span class="milestone__eyebrow"></span><strong class="milestone__label"></strong>`;
    banner.querySelector("span").textContent = eyebrow || "MILESTONE UNLOCKED";
    banner.querySelector("strong").textContent = label;
    requestAnimationFrame(() => banner.classList.add("show"));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => banner && banner.classList.remove("show"), 5200);
  }

  function confetti() {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    cancelAnimationFrame(rafId);
    if (canvas) canvas.remove();
    canvas = document.createElement("canvas");
    canvas.className = "confetti";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = (canvas.width = innerWidth * dpr), H = (canvas.height = innerHeight * dpr);
    const parts = Array.from({ length: 150 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.25, y: H * 0.28,
      vx: (Math.random() - 0.5) * 16 * dpr, vy: (-Math.random() * 13 - 3) * dpr,
      w: (6 + Math.random() * 7) * dpr, h: (4 + Math.random() * 5) * dpr,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
      color: COLORS[(Math.random() * COLORS.length) | 0]
    }));
    const start = performance.now(), DURATION = 3400;
    (function frame(now) {
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.42 * dpr; p.vx *= 0.992; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - t / DURATION);
        ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      }
      if (t < DURATION) rafId = requestAnimationFrame(frame);
      else { canvas.remove(); canvas = null; }
    })(start);
  }

  function celebrate(label, eyebrow) { showBanner(label, eyebrow); confetti(); }

  let demoDone = false;
  function check(detail) {
    if (!detail || !detail.ready || !Number.isFinite(detail.elo)) return;
    // ?celebrate=… preview: runs once, never touches stored progress
    const param = new URLSearchParams(location.search).get("celebrate");
    if (param !== null && !demoDone) {
      demoDone = true;
      const n = Number(param);
      if (param === "peak") celebrate(`${(detail.peakElo || detail.elo).toLocaleString()} ELO`, "NEW ALL-TIME PEAK");
      else celebrate(param === "level" ? `LEVEL ${levelOf(detail.elo)}` : Number.isFinite(n) && n > 0 ? `${n.toLocaleString()} ELO` : "2,000 ELO");
      return;
    }
    const stored = read();
    const res = newMilestones(detail.elo, detail.targets, stored, detail.peakElo);
    const base = { v: STATE_VERSION, elo: res.elo, level: res.level, peak: res.peak };
    if (res.first) {
      // adopt current progress silently, keeping anything older state already knew
      write({ ...base, elo: [...new Set([...(stored && stored.elo || []), ...res.elo])], level: Math.max(res.level, (stored && stored.level) || 0) });
      return;
    }
    const merged = {
      v: STATE_VERSION,
      elo: [...new Set([...(stored.elo || []), ...res.elo])],
      level: res.level < (stored.level || 0) ? res.level : Math.max(res.level, stored.level || 0), // a drop re-arms level-ups
      peak: Math.max(res.peak || 0, stored.peak || 0) || null
    };
    if (!res.fire.length && !res.newPeak) { write(merged); return; }
    if (!write(merged)) return;   // can't remember -> don't celebrate (it would repeat every visit)
    if (res.newPeak) celebrate(`${res.newPeak.toLocaleString()} ELO`, "NEW ALL-TIME PEAK");
    else celebrate(res.fire.map((f) => f.label).join(" · "));
  }

  if (typeof document !== "undefined") {
    document.addEventListener("kiyosei:data", (e) => check(e.detail));
    window.KiyoseiCelebrate = { demo: (label) => celebrate(label || "2,000 ELO") };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { newMilestones, levelOf, reachedTargets };
})();
