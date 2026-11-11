// Frontend only. API usage is unchanged: GET /api/player and GET /api/history every
// five minutes (as before) plus one read-only GET /api/sync/status on page load.
const $ = (id) => document.getElementById(id);
const BASELINE = 1680, GOAL = 2000, TARGETS = [1800, 1900, 2000], SEGMENT = 20;
const PAGE = 15, RECENT = 20;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LEVEL_COLORS = [null, "#eeeeee", "#1ce400", "#1ce400", "#ffc800", "#ffc800", "#ffc800", "#ffc800", "#ff6309", "#ff6309", "#fe1f00"];
let recorded = [], snapshots = [], total = null;
let resultFilter = "all", mapFilter = "all", range = "all", shown = PAGE;
let toastTimer, chartAnimated = false;

/* ---------- helpers ---------- */
function stat(stats, ...keys) {
  for (const key of keys) if (stats && stats[key] !== undefined && stats[key] !== null && stats[key] !== "") return stats[key];
  return null;
}
function number(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}
const finite = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const signed = (n, digits = 0) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pct = (v) => clamp(((v - BASELINE) / (GOAL - BASELINE)) * 100, 0, 100);
const outcomeOf = (m) => String(m.outcome || "").toLowerCase();
function mapName(raw) {
  const s = String(raw || "").replace(/^(de|cs|ar)_/i, "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "FACEIT match";
}
function relTime(seconds) {
  if (!seconds) return { text: "Recent", title: "" };
  const d = new Date(Number(seconds) * 1000), diff = (Date.now() - d.getTime()) / 1000;
  const title = d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  if (diff < 3600) return { text: `${Math.max(1, Math.round(diff / 60))}m ago`, title };
  if (diff < 86400) return { text: `${Math.round(diff / 3600)}h ago`, title };
  if (diff < 7 * 86400) return { text: `${Math.round(diff / 86400)}d ago`, title };
  return { text: d.toLocaleDateString([], { month: "short", day: "numeric" }), title };
}
function setDelta(id, value, text) {
  const el = $(id);
  el.textContent = value === null ? "" : text;
  el.className = value === null ? "" : value > 0.0001 ? "pos" : value < -0.0001 ? "neg" : "";
}

/* ---------- hero ---------- */
function renderGauge(elo) {
  const segments = (GOAL - BASELINE) / SEGMENT;
  const bars = Array.from({ length: segments }, (_, i) => {
    const lo = BASELINE + i * SEGMENT;
    const f = clamp((elo - lo) / SEGMENT, 0, 1);
    return `<span class="seg-b${f >= 1 ? " full" : ""}" style="--f:${(f * 100).toFixed(0)}%"></span>`;
  }).join("");
  const x = pct(elo);
  $("gauge").innerHTML = `${bars}<span class="flag" style="--x:${REDUCED ? x : 0}%">${elo.toLocaleString()}</span>`;
  if (!REDUCED) requestAnimationFrame(() => requestAnimationFrame(() => { const f = $("gauge").querySelector(".flag"); if (f) f.style.setProperty("--x", `${x}%`); }));
  const marks = [BASELINE, ...TARGETS];
  $("gauge-scale").innerHTML = marks.map((t) => `<span class="${elo >= t ? "hit" : ""}" style="left:${t === BASELINE ? 0 : pct(t)}%">${t.toLocaleString()}</span>`).join("");
  $("progress-label").textContent = `${Math.round(pct(elo))}%`;
  $("remaining").textContent = elo >= GOAL ? "Goal reached" : `${(GOAL - elo).toLocaleString()} ELO to go`;
  $("gauge").setAttribute("aria-label", `${elo.toLocaleString()} ELO, ${Math.round(pct(elo))}% of the way from ${BASELINE.toLocaleString()} to ${GOAL.toLocaleString()}`);
}
function renderSince(elo) {
  const d = elo - BASELINE;
  $("since").innerHTML = `<b class="${d > 0 ? "pos" : d < 0 ? "neg" : ""}">${signed(d)} ELO</b> since the ${BASELINE.toLocaleString()} baseline`;
}
function renderForm(matches) {
  $("form").innerHTML = matches.slice(0, 10).reverse().map((m) => {
    const r = outcomeOf(m);
    return `<span class="pip ${r === "win" || r === "loss" ? r : ""}" title="${escapeHtml(m.outcome || "Unknown")}"></span>`;
  }).join("");
}
function renderStreak(matches) {
  const el = $("fact-streak");
  const first = outcomeOf(matches[0] || {});
  if (first !== "win" && first !== "loss") { el.textContent = "—"; el.className = ""; return; }
  let n = 0;
  while (n < matches.length && outcomeOf(matches[n]) === first) n++;
  el.textContent = `${n} ${first}${n === 1 ? "" : "s"}`;
  el.className = first === "win" ? "pos" : "neg";
}
function renderPeak() {
  const vals = snapshots.map((s) => Number(s.elo)).filter(Number.isFinite);
  $("fact-peak").textContent = vals.length ? Math.max(...vals).toLocaleString() : "—";
}

/* ---------- recent form + maps (derived from saved matches) ---------- */
function renderRecent(lifetime) {
  const sample = recorded.filter((m) => ["win", "loss"].includes(outcomeOf(m))).slice(0, RECENT);
  $("recent-n").textContent = sample.length ? `Last ${sample.length} saved matches` : "";
  if (!sample.length) {
    ["r-winrate", "r-kd", "r-adr", "r-hs"].forEach((id) => { $(id).textContent = "—"; });
    ["r-winrate-d", "r-kd-d", "r-hs-d"].forEach((id) => setDelta(id, null));
    $("r-winrate-d").textContent = "No saved matches yet";
    return;
  }
  const wr = (sample.filter((m) => outcomeOf(m) === "win").length / sample.length) * 100;
  const vals = (...keys) => sample.map((m) => stat(m.stats, ...keys)).filter(finite).map(Number);
  const kd = mean(vals("K/D Ratio", "K/D")), adr = mean(vals("ADR")), hs = mean(vals("Headshots %", "Headshots"));
  $("r-winrate").textContent = `${number(wr, 0)}%`;
  $("r-kd").textContent = kd === null ? "—" : number(kd, 2);
  $("r-adr").textContent = adr === null ? "—" : number(adr, 0);
  $("r-hs").textContent = hs === null ? "—" : `${number(hs, 0)}%`;
  const L = lifetime || {};
  const lwr = stat(L, "Win Rate %", "Win Rate"), lkd = stat(L, "Average K/D Ratio", "K/D Ratio"), lhs = stat(L, "Average Headshots %", "Headshots");
  setDelta("r-winrate-d", finite(lwr) ? wr - Number(lwr) : null, `${signed(wr - Number(lwr), 1)} pts vs career`);
  setDelta("r-kd-d", kd !== null && finite(lkd) ? kd - Number(lkd) : null, `${signed(kd - Number(lkd), 2)} vs career`);
  setDelta("r-hs-d", hs !== null && finite(lhs) ? hs - Number(lhs) : null, `${signed(hs - Number(lhs), 1)} pts vs career`);
}
function renderMaps() {
  const root = $("map-list");
  const groups = new Map();
  for (const m of recorded) {
    const o = outcomeOf(m);
    if (!m.map || (o !== "win" && o !== "loss")) continue;
    const g = groups.get(m.map) || { map: m.map, n: 0, w: 0, kd: [], adr: [] };
    g.n++; if (o === "win") g.w++;
    const kd = stat(m.stats, "K/D Ratio", "K/D"), adr = stat(m.stats, "ADR");
    if (finite(kd)) g.kd.push(Number(kd));
    if (finite(adr)) g.adr.push(Number(adr));
    groups.set(m.map, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.n - a.n || b.w / b.n - a.w / a.n);
  $("maps-sub").textContent = rows.length ? `Across ${recorded.length} saved matches` : "Built from your saved matches";
  if (!rows.length) { root.innerHTML = '<p class="empty">Map statistics appear once matches have been saved.</p>'; return; }
  root.innerHTML = `<div class="mp head"><span>Map</span><span class="r">Matches</span><span>Win rate</span><span class="r">K/D</span><span class="r">ADR</span></div>` +
    rows.map((g) => {
      const wr = (g.w / g.n) * 100, kd = mean(g.kd), adr = mean(g.adr);
      return `<div class="mp${g.n < 3 ? " small" : ""}">
        <span class="nm">${escapeHtml(mapName(g.map))}${g.n < 3 ? "<small>Small sample</small>" : ""}</span>
        <span class="r c-n">${g.n}</span>
        <span class="wr" role="img" aria-label="${g.w} wins from ${g.n} matches"><span class="track"><i class="${wr < 50 ? "low" : ""}" style="width:${wr.toFixed(0)}%"></i></span><b>${wr.toFixed(0)}%</b></span>
        <span class="r c-kd">${kd === null ? '<span class="dim">–</span>' : number(kd, 2)}</span>
        <span class="r c-adr">${adr === null ? '<span class="dim">–</span>' : number(adr, 0)}</span>
      </div>`;
    }).join("");
}

/* ---------- match history ---------- */
function kdClass(v) { return Number(v) >= 1.2 ? "kd-hi" : Number(v) < 0.9 ? "kd-lo" : ""; }
function matchRow(match) {
  const when = relTime(match.finished_at || match.date);
  const o = outcomeOf(match), cls = o === "win" ? "win" : o === "loss" ? "loss" : "";
  const label = o === "win" ? "Win" : o === "loss" ? "Loss" : (match.outcome || "—");
  const s = match.stats || {};
  const kd = stat(s, "K/D Ratio", "K/D"), adr = stat(s, "ADR"), hs = stat(s, "Headshots %", "Headshots");
  const k = stat(s, "Kills"), d = stat(s, "Deaths"), a = stat(s, "Assists");
  const kda = finite(k) && finite(d) ? `${Number(k)}-${Number(d)}${finite(a) ? "-" + Number(a) : ""}` : null;
  const dash = '<span class="dim">–</span>';
  const change = match.elo_change;
  const elo = !finite(change) ? dash
    : `<span class="elo-chg ${Number(change) >= 0 ? "pos" : "neg"}">${signed(Number(change))}</span>`;
  const hasStats = kd !== null || adr !== null || hs !== null;
  const score = escapeHtml(match.score || "–");
  return `<tr class="${cls}">
    <td class="res c-res"><span class="badge">${escapeHtml(label)}</span></td>
    <td class="mapn c-map">${escapeHtml(mapName(match.map))}<span class="sc">${score}</span></td>
    <td class="c-score num">${score}</td>
    <td class="r c-kd num"><span class="${finite(kd) ? kdClass(kd) : ""}">${finite(kd) ? number(kd, 2) : dash}</span></td>
    <td class="r c-adr num">${finite(adr) ? number(adr, 0) : dash}</td>
    <td class="r c-hs num">${finite(hs) ? number(hs, 0) + "%" : dash}</td>
    <td class="r c-kda num">${kda || dash}</td>
    <td class="r c-elo num">${elo}</td>
    <td class="r c-date"><time title="${escapeHtml(when.title)}">${escapeHtml(when.text)}</time></td>
    <td class="c-m">${hasStats
      ? `<span data-l="K/D" class="${finite(kd) ? kdClass(kd) : ""}">${finite(kd) ? number(kd, 2) : "–"}</span><span data-l="ADR">${finite(adr) ? number(adr, 0) : "–"}</span><span data-l="HS">${finite(hs) ? number(hs, 0) + "%" : "–"}</span>`
      : '<span class="pend">Stats pending</span>'}</td>
  </tr>`;
}
function renderMatches() {
  const root = $("match-table"), more = $("more");
  if (!recorded.length) {
    $("matches-sub").textContent = "No saved matches yet";
    root.innerHTML = '<p class="empty">No matches saved yet. They are added automatically as you play and as the career history imports.</p>';
    more.hidden = true;
    return;
  }
  const rows = recorded.filter((m) => (resultFilter === "all" || outcomeOf(m) === resultFilter) && (mapFilter === "all" || m.map === mapFilter));
  if (!rows.length) {
    root.innerHTML = '<p class="empty">No saved matches fit these filters.</p>';
    more.hidden = true;
    return;
  }
  const visible = rows.slice(0, shown);
  root.innerHTML = `<table><thead><tr><th>Result</th><th>Map</th><th>Score</th><th class="r">K/D</th><th class="r">ADR</th><th class="r">HS</th><th class="r">K-D-A</th><th class="r">ELO</th><th class="r">Played</th></tr></thead><tbody>${visible.map(matchRow).join("")}</tbody></table>`;
  more.hidden = rows.length <= shown;
  more.textContent = `Show ${Math.min(PAGE, rows.length - shown)} more`;
  $("matches-sub").textContent = total && total > recorded.length
    ? `Showing the latest ${recorded.length} of ${total.toLocaleString()} recorded matches`
    : `${recorded.length} saved match${recorded.length === 1 ? "" : "es"}`;
}
function fillMapFilter() {
  const sel = $("map-filter"), maps = [...new Set(recorded.map((m) => m.map).filter(Boolean))].sort();
  if (mapFilter !== "all" && !maps.includes(mapFilter)) mapFilter = "all";
  sel.innerHTML = `<option value="all">All maps</option>${maps.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(mapName(m))}</option>`).join("")}`;
  sel.value = mapFilter;
}

/* ---------- ELO chart ---------- */
function inRange(all) {
  if (range === "all") return all;
  const cutoff = Date.now() - Number(range) * 86400e3;
  const kept = all.filter((p) => p.t.getTime() >= cutoff);
  return kept.length ? kept : all.slice(-1);
}
function renderEloHistory() {
  const root = $("elo-chart"), sum = $("history-summary");
  const all = snapshots.map((s) => ({ v: Number(s.elo), t: new Date(s.captured_at) })).filter((p) => Number.isFinite(p.v) && !isNaN(p.t));
  $("history-count").textContent = `${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"} saved`;
  if (!all.length) {
    root.innerHTML = '<p class="empty">No ELO snapshots yet. The first sync saves one automatically.</p>';
    sum.innerHTML = "";
    return;
  }
  const pts = inRange(all), vals = pts.map((p) => p.v);
  const W = Math.max(280, Math.round(root.clientWidth || 800)), narrow = W < 520;
  const H = narrow ? 230 : 320, L = narrow ? 42 : 52, R = narrow ? 12 : 18, T = 18, B = 32;
  const lo = Math.floor((Math.min(...vals, BASELINE) - 15) / 20) * 20;
  const hi = Math.ceil((Math.max(...vals, BASELINE) + 15) / 20) * 20;
  const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const spanMs = pts[pts.length - 1].t - pts[0].t;
  const fmt = (d) => (spanMs < 36 * 3600e3 ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)} ${H - B} L${x(0).toFixed(1)} ${H - B} Z`;
  const ticks = [0, 1, 2, 3, 4].map((k) => Math.round(lo + ((hi - lo) * k) / 4));
  const grid = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 10}" y="${y(v) + 4}" text-anchor="end">${v.toLocaleString()}</text>`).join("");
  const refs = `<line class="base" x1="${L}" x2="${W - R}" y1="${y(BASELINE)}" y2="${y(BASELINE)}"/><text class="ref" x="${W - R}" y="${y(BASELINE) - 6}" text-anchor="end">Baseline ${BASELINE.toLocaleString()}</text>` +
    TARGETS.filter((t) => t > lo && t < hi).map((t) => `<line class="tgt" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="ref" x="${W - R}" y="${y(t) - 6}" text-anchor="end">${t.toLocaleString()}</text>`).join("");
  const peakI = vals.indexOf(Math.max(...vals)), lastI = pts.length - 1;
  const dots = pts.length <= 24 ? pts.map((p, i) => (i === lastI || i === peakI ? "" : `<circle class="pt" cx="${x(i)}" cy="${y(p.v)}" r="3.5"/>`)).join("") : "";
  const peakDot = pts.length > 2 && peakI !== lastI ? `<circle class="peak" cx="${x(peakI)}" cy="${y(vals[peakI])}" r="5.5"><title>Peak ${vals[peakI]}</title></circle>` : "";
  const labelIdx = pts.length < 2 ? [0] : [0, 1, 2, 3].map((k) => Math.round((k * (pts.length - 1)) / 3)).filter((v, i, a) => a.indexOf(v) === i);
  const xl = labelIdx.map((i, n) => `<text class="ax" x="${x(i)}" y="${H - 8}" text-anchor="${n === 0 && labelIdx.length > 1 ? "start" : n === labelIdx.length - 1 && labelIdx.length > 1 ? "end" : "middle"}">${fmt(pts[i].t)}</text>`).join("");
  root.innerHTML = `<svg class="${chartAnimated || REDUCED ? "" : "anim"}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="ELO history chart, ${pts.length} snapshots from ${vals[0]} to ${vals[lastI]}">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5a1f" stop-opacity=".32"/><stop offset="1" stop-color="#ff5a1f" stop-opacity="0"/></linearGradient></defs>
    ${grid}${refs}
    <path class="area" fill="url(#ga)" d="${area}"/><path class="ln" pathLength="1" d="${line}"/>${dots}${peakDot}
    <circle class="pt" cx="${x(lastI)}" cy="${y(vals[lastI])}" r="5" style="fill:var(--orange)"/>
    <g class="hov" id="hov"><line class="cross" id="cross" y1="${T}" y2="${H - B}"/><circle class="pt" id="hp" r="5.5"/></g>
    ${xl}
  </svg><div class="tip" id="tip"></div>`;
  chartAnimated = true;
  const svg = root.querySelector("svg"), tip = $("tip"), hov = $("hov");
  const move = (e) => {
    const rect = svg.getBoundingClientRect(), px = ((e.clientX - rect.left) / rect.width) * W;
    let idx = 0, best = Infinity;
    pts.forEach((_, i) => { const dist = Math.abs(x(i) - px); if (dist < best) { best = dist; idx = i; } });
    const p = pts[idx], prev = pts[idx - 1];
    $("cross").setAttribute("x1", x(idx)); $("cross").setAttribute("x2", x(idx));
    $("hp").setAttribute("cx", x(idx)); $("hp").setAttribute("cy", y(p.v));
    const step = prev ? ` <span class="${p.v - prev.v >= 0 ? "pos" : "neg"}">${signed(p.v - prev.v)}</span>` : "";
    tip.innerHTML = `<b>${p.v.toLocaleString()} ELO${step}</b>${escapeHtml(p.t.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}`;
    const px2 = (x(idx) / W) * rect.width;
    tip.style.left = `${clamp(px2, 70, rect.width - 70)}px`;
    tip.style.top = `${(y(p.v) / H) * rect.height}px`;
    hov.style.opacity = 1; tip.style.opacity = 1;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { hov.style.opacity = 0; tip.style.opacity = 0; });
  const first = vals[0], latest = vals[lastI], change = latest - first;
  sum.innerHTML = `<div>${range === "all" ? "First saved" : "Start of range"}<strong>${first.toLocaleString()}</strong></div><div>Latest<strong>${latest.toLocaleString()}</strong></div><div>Peak<strong>${Math.max(...vals).toLocaleString()}</strong></div><div>Change<strong class="${change > 0 ? "pos" : change < 0 ? "neg" : ""}">${signed(change)}</strong></div>`;
}

/* ---------- data loading ---------- */
let lifetimeCache = {};
async function loadHistory() {
  try {
    const response = await fetch("/api/history");
    if (!response.ok) throw new Error("History unavailable");
    const data = await response.json();
    if (!data.configured) {
      $("history-count").textContent = "Database not connected";
      $("elo-chart").innerHTML = '<p class="empty">Connect a database to save ELO snapshots and match history.</p>';
      $("history-summary").innerHTML = "";
      $("match-table").innerHTML = '<p class="empty">Match history needs the database connection.</p>';
      $("map-list").innerHTML = '<p class="empty">Map statistics need the database connection.</p>';
      $("matches-sub").textContent = "Unavailable";
      return;
    }
    snapshots = data.snapshots || [];
    recorded = data.matches || [];
    renderPeak();
    renderEloHistory();
    renderRecent(lifetimeCache);
    renderMaps();
    fillMapFilter();
    renderMatches();
  } catch (error) {
    $("history-count").textContent = "History offline";
    $("elo-chart").innerHTML = '<p class="empty">Could not load saved history. It will retry on the next sync.</p>';
    $("match-table").innerHTML = '<p class="empty">Could not load saved matches. It will retry on the next sync.</p>';
    $("map-list").innerHTML = '<p class="empty">Could not load map statistics.</p>';
  }
}
async function loadCoverage() {
  // Read-only, fetched once per page load; failures are silent.
  try {
    const response = await fetch("/api/sync/status");
    if (!response.ok) return;
    const s = await response.json();
    if (!s.configured) return;
    const count = Number(s.matches?.total);
    if (Number.isFinite(count) && count > 0) { total = count; if (recorded.length) renderMatches(); }
    if (s.lastSuccess?.at) {
      const mins = Math.max(0, Math.round((Date.now() - new Date(s.lastSuccess.at).getTime()) / 60000));
      const ago = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
      $("foot-sync").textContent = `Last sync ${ago}. Syncs with FACEIT every five minutes.`;
    }
  } catch { /* optional */ }
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
    let country = "";
    try { country = player.country ? new Intl.DisplayNames(["en"], { type: "region" }).of(player.country.toUpperCase()) : ""; } catch { country = player.country.toUpperCase(); }
    $("profile-meta").textContent = country ? `FACEIT player from ${country}` : "FACEIT player";
    $("faceit-link").href = player.faceitUrl;
    if (player.avatar) $("avatar").innerHTML = `<img src="${escapeHtml(player.avatar)}" alt="${escapeHtml(player.nickname || "Player")} avatar">`;
    document.documentElement.style.setProperty("--lc", LEVEL_COLORS[level] || "var(--orange)");
    $("level-chip").hidden = !Number.isFinite(level);
    $("level").textContent = Number.isFinite(level) ? level : "–";
    countUp($("elo"), elo);
    const eloOrBase = Number.isFinite(elo) ? elo : BASELINE;
    renderGauge(eloOrBase);
    renderSince(eloOrBase);
    lifetimeCache = data.lifetime || {};
    const lwr = stat(lifetimeCache, "Win Rate %", "Win Rate"), lhs = stat(lifetimeCache, "Average Headshots %", "Headshots");
    $("winrate").textContent = lwr !== null ? `${number(lwr)}%` : "—";
    $("kd").textContent = number(stat(lifetimeCache, "Average K/D Ratio", "K/D Ratio"), 2);
    $("hs").textContent = lhs !== null ? `${number(lhs)}%` : "—";
    const played = stat(lifetimeCache, "Matches");
    $("played").textContent = finite(played) ? Number(played).toLocaleString() : "—";
    const live = data.matches || [];
    renderForm(live);
    renderStreak(live);
    $("updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (!data.tracking?.configured) toast("Database not connected. Showing the live profile only.", { ms: 8000 });
    else if (data.tracking.saved) toast(`Saved ${data.tracking.saved} new match${data.tracking.saved === 1 ? "" : "es"}`);
    else toast("");
    await loadHistory();
  } catch (error) {
    $("connection").textContent = "Not connected";
    $("dot").classList.remove("on");
    toast(error.message, { error: true, ms: 0 });
    $("match-table").innerHTML = '<p class="empty">Could not load FACEIT data. Check the server configuration and API key.</p>';
    $("elo-chart").innerHTML = '<p class="empty">Could not load FACEIT data.</p>';
    $("map-list").innerHTML = '<p class="empty">Could not load FACEIT data.</p>';
  }
}

/* ---------- controls ---------- */
function bindSegment(id, key, apply) {
  const group = $(id);
  group.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => {
    group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    apply(btn.dataset[key]);
  }));
}
bindSegment("result-filter", "f", (v) => { resultFilter = v; shown = PAGE; renderMatches(); });
bindSegment("range", "r", (v) => { range = v; renderEloHistory(); });
$("map-filter").addEventListener("change", (e) => { mapFilter = e.target.value; shown = PAGE; renderMatches(); });
$("more").addEventListener("click", () => { shown += PAGE; renderMatches(); });

let resizeTimer, lastWidth = 0;
new ResizeObserver(() => {
  const w = $("elo-chart").clientWidth;
  if (!snapshots.length || Math.abs(w - lastWidth) < 2) return;
  lastWidth = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderEloHistory, 120);
}).observe($("elo-chart"));

load().then(loadCoverage);
setInterval(load, 5 * 60 * 1000);
