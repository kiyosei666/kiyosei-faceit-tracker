const $ = (id) => document.getElementById(id);
const BASELINE = 1680, GOAL = 2000, TARGETS = [1800, 1900, 2000];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LEVEL_COLORS = [null, "#eeeeee", "#1ce400", "#1ce400", "#ffc800", "#ffc800", "#ffc800", "#ffc800", "#ff6309", "#ff6309", "#fe1f00"];
let recorded = [], filter = "all", toastTimer;

function stat(stats, ...keys) {
  for (const key of keys) if (stats && stats[key] !== undefined) return stats[key];
  return null;
}
function number(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function toast(message, { error = false, ms = 6000 } = {}) {
  const el = $("notice");
  clearTimeout(toastTimer);
  if (!message) { el.classList.remove("show"); return; }
  el.textContent = message;
  el.classList.toggle("err", error);
  el.classList.add("show");
  if (ms) toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
function countUp(el, to) {
  if (!Number.isFinite(to)) { el.textContent = "—"; return; }
  const from = Number(el.dataset.v) || Math.max(0, to - 120);
  el.dataset.v = to;
  if (REDUCED || from === to) { el.textContent = to.toLocaleString(); return; }
  const t0 = performance.now(), dur = 1100;
  (function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))).toLocaleString();
    if (p < 1) requestAnimationFrame(frame);
  })(t0);
}
const pct = (v) => Math.max(0, Math.min(100, ((v - BASELINE) / (GOAL - BASELINE)) * 100));

function renderRoad(elo) {
  const progress = pct(elo);
  requestAnimationFrame(() => { $("progress-fill").style.width = `${progress}%`; });
  $("progress-label").textContent = `${Math.round(progress)}% from ${BASELINE.toLocaleString()}`;
  $("milestones").innerHTML = TARGETS.map((t) =>
    `<i class="mark${elo >= t ? " done" : ""}" style="left:${pct(t)}%"><span>${t.toLocaleString()}${elo >= t ? " ✓" : ""}</span></i>`
  ).join("");
}
function renderForm(matches) {
  $("form").innerHTML = matches.slice(0, 10).reverse().map((m) => {
    const r = (m.outcome || "").toLowerCase();
    return `<span class="pip ${r === "win" || r === "loss" ? r : ""}" title="${escapeHtml(m.outcome || "Unknown")}"></span>`;
  }).join("");
}
function matchRow(match) {
  const dateValue = match.finished_at || match.date;
  const date = dateValue ? new Date(Number(dateValue) * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : "Recent";
  const result = match.outcome || "Unknown";
  const cls = result.toLowerCase() === "win" ? "win" : result.toLowerCase() === "loss" ? "loss" : "";
  const s = match.stats || {};
  const kd = stat(s, "K/D Ratio", "K/D"), adr = stat(s, "ADR"), hs = stat(s, "Headshots %", "Headshots");
  const change = match.elo_change;
  const elo = change === null || change === undefined ? '<span class="dim elo-chg">–</span>'
    : `<span class="elo-chg ${Number(change) >= 0 ? "pos" : "neg"}">${Number(change) > 0 ? "+" : ""}${Number(change)}</span>`;
  return `<div class="mr ${cls}">
    <span class="res">${escapeHtml(result)}</span>
    <span class="map">${escapeHtml(match.map || "FACEIT match")}</span>
    <span class="score">${escapeHtml(match.score || "–")}</span>
    <div class="st"><span data-l="K/D">${kd !== null ? number(kd, 2) : "–"}</span><span data-l="ADR">${adr !== null ? number(adr, 0) : "–"}</span><span data-l="HS">${hs !== null ? number(hs, 0) + "%" : "–"}</span></div>
    ${elo}<time>${escapeHtml(date)}</time>
  </div>`;
}
function renderMatches() {
  const root = $("matches");
  if (!recorded.length) {
    root.innerHTML = '<p class="empty">No matches saved yet. Keep this page open while you play and it will save each new match automatically.</p>';
    return;
  }
  const rows = recorded.filter((m) => filter === "all" || (m.outcome || "").toLowerCase() === filter);
  root.innerHTML = rows.length
    ? `<div class="mh"><span>Result</span><span>Map</span><span>Score</span><span>K/D</span><span>ADR</span><span>HS</span><span>ELO</span><span style="text-align:right">Date</span></div>${rows.map(matchRow).join("")}`
    : `<p class="empty">No ${filter === "win" ? "wins" : "losses"} in the saved matches.</p>`;
}
function renderEloHistory(snapshots) {
  const root = $("elo-chart"), sum = $("history-summary");
  $("history-count").textContent = `${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"}`;
  const pts = snapshots.map((s) => ({ v: Number(s.elo), t: new Date(s.captured_at) })).filter((p) => Number.isFinite(p.v));
  if (!pts.length) {
    root.innerHTML = '<p class="empty">No ELO snapshots yet. The first sync saves one automatically.</p>';
    sum.innerHTML = "";
    return;
  }
  const W = 900, H = 300, L = 46, R = 16, T = 14, B = 30;
  const vals = pts.map((p) => p.v);
  const lo = Math.floor((Math.min(...vals, BASELINE) - 15) / 20) * 20;
  const hi = Math.ceil((Math.max(...vals, BASELINE) + 15) / 20) * 20;
  const x = (i) => pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const fmt = (d) => d.toLocaleDateString([], { month: "short", day: "numeric" });
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)} ${H - B} L${x(0).toFixed(1)} ${H - B} Z`;
  const ticks = [0, 1, 2, 3, 4].map((k) => Math.round(lo + ((hi - lo) * k) / 4));
  const grid = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
  const refs = [`<line class="base" x1="${L}" x2="${W - R}" y1="${y(BASELINE)}" y2="${y(BASELINE)}"/>`]
    .concat(TARGETS.filter((t) => t > lo && t < hi).map((t) => `<line class="tgt" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`)).join("");
  const dots = pts.length <= 30 ? pts.map((p, i) => `<circle class="pt" cx="${x(i)}" cy="${y(p.v)}" r="4"/>`).join("")
    : `<circle class="pt" cx="${x(pts.length - 1)}" cy="${y(vals[vals.length - 1])}" r="4"/>`;
  root.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="ELO history chart, ${pts.length} snapshots from ${vals[0]} to ${vals[vals.length - 1]}">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5500" stop-opacity=".35"/><stop offset="1" stop-color="#ff5500" stop-opacity="0"/></linearGradient></defs>
    ${grid}${refs}
    <path class="area" fill="url(#ga)" d="${area}"/><path class="ln" pathLength="1" d="${line}"/>${dots}
    <g class="hov" id="hov"><line class="cross" id="cross" y1="${T}" y2="${H - B}"/><circle class="pt" id="hp" r="5.5"/></g>
    <text class="ax" x="${L}" y="${H - 8}">${fmt(pts[0].t)}</text><text class="ax" x="${W - R}" y="${H - 8}" text-anchor="end">${fmt(pts[pts.length - 1].t)}</text>
  </svg><div class="tip" id="tip"></div>`;
  const svg = root.querySelector("svg"), tip = $("tip"), hov = $("hov");
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let idx = 0, best = Infinity;
    pts.forEach((_, i) => { const d = Math.abs(x(i) - px); if (d < best) { best = d; idx = i; } });
    const p = pts[idx];
    $("cross").setAttribute("x1", x(idx)); $("cross").setAttribute("x2", x(idx));
    $("hp").setAttribute("cx", x(idx)); $("hp").setAttribute("cy", y(p.v));
    tip.innerHTML = `<b>${p.v.toLocaleString()} ELO</b>${p.t.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    tip.style.left = `${(x(idx) / W) * rect.width}px`;
    tip.style.top = `${(y(p.v) / H) * rect.height}px`;
    hov.style.opacity = 1; tip.style.opacity = 1;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { hov.style.opacity = 0; tip.style.opacity = 0; });
  const first = vals[0], latest = vals[vals.length - 1], change = latest - first;
  sum.innerHTML = `<div>First saved<strong>${first.toLocaleString()}</strong></div><div>Latest<strong>${latest.toLocaleString()}</strong></div><div>Peak<strong>${Math.max(...vals).toLocaleString()}</strong></div><div>Change<strong class="${change >= 0 ? "pos" : "neg"}">${change > 0 ? "+" : ""}${change.toLocaleString()}</strong></div>`;
}
async function loadHistory() {
  try {
    const response = await fetch("/api/history");
    if (!response.ok) throw new Error("History unavailable");
    const data = await response.json();
    if (!data.configured) {
      $("history-count").textContent = "Database not connected";
      $("elo-chart").innerHTML = '<p class="empty">Connect a database to save ELO snapshots and match history.</p>';
      $("matches").innerHTML = '<p class="empty">Match history needs the database connection.</p>';
      return;
    }
    renderEloHistory(data.snapshots || []);
    recorded = data.matches || [];
    renderMatches();
  } catch (error) {
    $("history-count").textContent = "History offline";
    $("elo-chart").innerHTML = '<p class="empty">Could not load saved history. It will retry on the next sync.</p>';
  }
}
async function load() {
  try {
    const response = await fetch("/api/player");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load FACEIT profile.");
    const player = data.player, elo = Number(player.elo), level = Number(player.skillLevel);
    $("connection").textContent = "FACEIT connected";
    $("dot").classList.add("on");
    $("nickname").textContent = player.nickname || "Kiyosei";
    $("profile-meta").textContent = player.country ? `FACEIT player · ${player.country.toUpperCase()}` : "FACEIT player";
    $("faceit-link").href = player.faceitUrl;
    if (player.avatar) $("avatar").innerHTML = `<img src="${escapeHtml(player.avatar)}" alt="${escapeHtml(player.nickname || "Player")} avatar"><b class="lvl" id="level-badge">–</b>`;
    document.documentElement.style.setProperty("--lc", LEVEL_COLORS[level] || "var(--orange)");
    $("level").textContent = Number.isFinite(level) ? level : "—";
    $("level-badge").textContent = Number.isFinite(level) ? level : "–";
    countUp($("elo"), elo);
    renderRoad(Number.isFinite(elo) ? elo : BASELINE);
    const lifetime = data.lifetime || {};
    const wr = stat(lifetime, "Win Rate %", "Win Rate"), hs = stat(lifetime, "Average Headshots %", "Headshots");
    $("winrate").textContent = wr !== null ? `${number(wr)}%` : "—";
    $("kd").textContent = number(stat(lifetime, "Average K/D Ratio", "K/D Ratio"), 2);
    $("hs").textContent = hs !== null ? `${number(hs)}%` : "—";
    $("matches-count").textContent = data.matches.length;
    renderForm(data.matches);
    $("updated").textContent = `· Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (!data.tracking?.configured) toast("Database not connected. Showing the live profile only.", { ms: 8000 });
    else if (data.tracking.saved) toast(`Saved ${data.tracking.saved} new match${data.tracking.saved === 1 ? "" : "es"}`);
    else toast("");
    await loadHistory();
  } catch (error) {
    $("connection").textContent = "Not connected";
    $("dot").classList.remove("on");
    toast(error.message, { error: true, ms: 0 });
    $("matches").innerHTML = '<p class="empty">Could not load FACEIT data. Check the server configuration and API key.</p>';
    $("elo-chart").innerHTML = '<p class="empty">Could not load FACEIT data.</p>';
  }
}
document.querySelectorAll(".seg button").forEach((btn) => btn.addEventListener("click", () => {
  filter = btn.dataset.f;
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", b === btn));
  renderMatches();
}));
load();
setInterval(load, 5 * 60 * 1000);
