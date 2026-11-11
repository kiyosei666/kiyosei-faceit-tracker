const $ = (id) => document.getElementById(id);
const BASELINE = 1680, GOAL = 2000, TARGETS = [1800, 1900, 2000];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

let recorded = [];
let matchOffset = 0;
let hasMoreMatches = false;
let loadingMoreMatches = false;
let filter = "all";
let historyRange = "all";
let toastTimer = null;
let currentElo = null;
let peakElo = null;
let currentPlayer = null;

function stat(stats, ...keys) {
  for (const key of keys) {
    if (stats && stats[key] !== undefined && stats[key] !== null) return stats[key];
  }
  return null;
}

function number(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function toast(message, { error = false, ms = 5000 } = {}) {
  const el = $("notice");
  if (!el) return;
  clearTimeout(toastTimer);
  if (!message) {
    el.classList.remove("show");
    return;
  }
  el.textContent = message;
  el.classList.toggle("err", error);
  el.classList.add("show");
  if (ms) toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function countUp(el, to) {
  if (!el) return;
  if (!Number.isFinite(to)) {
    el.textContent = "—";
    return;
  }
  const from = Number(el.dataset.v) || Math.max(0, to - 120);
  el.dataset.v = to;
  if (REDUCED || from === to) {
    el.textContent = to.toLocaleString();
    return;
  }
  const t0 = performance.now(), dur = 1000;
  (function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))).toLocaleString();
    if (p < 1) requestAnimationFrame(frame);
  })(t0);
}

// FACEIT Level & Icon Helpers
function getSkillLevel(elo) {
  const val = Number(elo);
  if (!Number.isFinite(val) || val <= 500) return 1;
  if (val <= 750) return 2;
  if (val <= 900) return 3;
  if (val <= 1050) return 4;
  if (val <= 1200) return 5;
  if (val <= 1350) return 6;
  if (val <= 1530) return 7;
  if (val <= 1750) return 8;
  if (val <= 2000) return 9;
  return 10;
}

function getLevelIcon(level, isChallenger = false) {
  if (isChallenger || Number(level) >= 11) return "/assets/faceit/challenger.svg";
  const lvl = Math.max(1, Math.min(10, Math.round(Number(level) || 1)));
  return `/assets/faceit/${lvl}.svg`;
}

function getEloNeededText(elo) {
  const val = Number(elo);
  if (!Number.isFinite(val)) return "ELO NEEDED: —";
  const THRESHOLDS = [
    { lvl: 2, elo: 501 },
    { lvl: 3, elo: 751 },
    { lvl: 4, elo: 901 },
    { lvl: 5, elo: 1051 },
    { lvl: 6, elo: 1201 },
    { lvl: 7, elo: 1351 },
    { lvl: 8, elo: 1531 },
    { lvl: 9, elo: 1751 },
    { lvl: 10, elo: 2001 }
  ];
  const next = THRESHOLDS.find((t) => val < t.elo);
  if (next) {
    const diff = next.elo - val;
    return `ELO NEEDED +${diff} TO ${next.elo}`;
  }
  const nextHundred = (Math.floor(val / 100) + 1) * 100;
  return `ELO NEEDED +${nextHundred - val} TO ${nextHundred}`;
}

// ==========================================================================
// CURRENT FORM – LAST 30 MATCHES CALCULATION
// ==========================================================================

function renderCurrentForm(matches) {
  const last30 = matches.slice(0, 30);
  if (!last30.length) {
    $("form-kd").textContent = "—";
    $("form-kda-vals").textContent = "NO SAVED MATCHES";
    $("form-winrate").textContent = "—%";
    $("form-record").textContent = "0W - 0L";
    $("form-adr").textContent = "—";
    $("form-hs").textContent = "—%";
    $("form-kda-ratio").textContent = "—";
    $("form-streak").textContent = "NO DATA";
    $("form-pips").innerHTML = '<span class="empty">PLAY AND SYNC TO POPULATE FORM</span>';
    return;
  }

  let totalKills = 0, totalDeaths = 0, totalAssists = 0;
  let hasKda = false;
  let wins = 0, losses = 0;
  let totalAdr = 0, adrCount = 0;
  let totalHs = 0, hsCount = 0;

  last30.forEach((m) => {
    const outcome = (m.outcome || "").toLowerCase();
    if (outcome === "win") wins++;
    else if (outcome === "loss") losses++;

    const s = m.stats || {};
    const k = Number(stat(s, "Kills", "K"));
    const d = Number(stat(s, "Deaths", "D"));
    const a = Number(stat(s, "Assists", "A"));

    if (Number.isFinite(k)) { totalKills += k; hasKda = true; }
    if (Number.isFinite(d)) { totalDeaths += d; hasKda = true; }
    if (Number.isFinite(a)) { totalAssists += a; hasKda = true; }

    const adr = Number(stat(s, "ADR"));
    if (Number.isFinite(adr)) { totalAdr += adr; adrCount++; }

    const hs = Number(stat(s, "Headshots %", "Headshots"));
    if (Number.isFinite(hs)) { totalHs += hs; hsCount++; }
  });

  // K/D & Total K/D/A
  if (hasKda) {
    const kd = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : totalKills.toFixed(2);
    $("form-kd").textContent = kd;
    $("form-kda-vals").textContent = `${totalKills.toLocaleString()} / ${totalDeaths.toLocaleString()} / ${totalAssists.toLocaleString()}`;
    const kdaRatio = totalDeaths > 0 ? ((totalKills + totalAssists) / totalDeaths).toFixed(2) : "—";
    $("form-kda-ratio").textContent = kdaRatio;
  } else {
    $("form-kd").textContent = "—";
    $("form-kda-vals").textContent = "SYNCING STATS...";
    $("form-kda-ratio").textContent = "—";
  }

  // Win Rate
  const totalCompleted = wins + losses;
  const winRate = totalCompleted > 0 ? Math.round((wins / totalCompleted) * 100) : 0;
  $("form-winrate").textContent = `${winRate}%`;
  const unknown = last30.length - totalCompleted;
  $("form-record").textContent = `${wins}W - ${losses}L${unknown ? ` · ${unknown} UNKNOWN` : ""} (${last30.length} GP)`;

  // ADR & HS
  $("form-adr").textContent = adrCount > 0 ? (totalAdr / adrCount).toFixed(1) : "—";
  $("form-hs").textContent = hsCount > 0 ? `${Math.round(totalHs / hsCount)}%` : "—";

  // Streak Calculation (most recent first)
  let streakCount = 0;
  let streakType = "";
  for (const m of last30) {
    const out = (m.outcome || "").toLowerCase();
    if (out !== "win" && out !== "loss") continue;
    if (!streakType) {
      streakType = out;
      streakCount = 1;
    } else if (out === streakType) {
      streakCount++;
    } else {
      break;
    }
  }
  $("form-streak").textContent = streakType
    ? `STREAK: ${streakCount}${streakType === "win" ? "W" : "L"}`
    : "STREAK: —";

  // Sequence Pills (last 16 visible, newest first)
  const pips = last30.slice(0, 16).map((m) => {
    const out = (m.outcome || "").toLowerCase();
    const isWin = out === "win";
    const isLoss = out === "loss";
    const letter = isWin ? "W" : isLoss ? "L" : "?";
    const cls = isWin ? "w" : isLoss ? "l" : "unknown";
    const date = m.finished_at ? new Date(Number(m.finished_at) * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
    const tooltip = `${m.map || "Match"} · ${m.score || ""} · ${isWin ? "Win" : isLoss ? "Loss" : "Result unknown"} ${date}`;
    return `<span class="form-pip-pill ${cls}" title="${escapeHtml(tooltip)}">${letter}</span>`;
  });
  $("form-pips").innerHTML = pips.join("");
}

// ==========================================================================
// MATCH HISTORY TABLE
// ==========================================================================

function matchRow(match) {
  const dateValue = match.finished_at || match.date;
  const date = dateValue ? new Date(Number(dateValue) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Recent";
  const result = (match.outcome || "Unknown").toUpperCase();
  const isWin = result === "WIN";
  const isLoss = result === "LOSS";
  const cls = isWin ? "win" : isLoss ? "loss" : "";

  const s = match.stats || {};
  const kills = stat(s, "Kills", "K");
  const deaths = stat(s, "Deaths", "D");
  const assists = stat(s, "Assists", "A");
  const kd = stat(s, "K/D Ratio", "K/D");
  const adr = stat(s, "ADR");
  const hs = stat(s, "Headshots %", "Headshots");
  const change = match.elo_change;

  const eloMarkup = change === null || change === undefined
    ? '<span class="match-elo-delta unavailable">—</span>'
    : `<span class="match-elo-delta ${Number(change) >= 0 ? "pos" : "neg"}">${Number(change) > 0 ? "+" : ""}${Number(change)}</span>`;

  const kda = [kills, deaths, assists].every((v) => v !== null && v !== undefined)
    ? `${number(kills, 0)} / ${number(deaths, 0)} / ${number(assists, 0)}`
    : "K/D/A —";
  const performance = [
    kd !== null ? `${number(kd, 2)} KD` : null,
    adr !== null ? `${number(adr, 0)} ADR` : null,
    hs !== null ? `${number(hs, 0)}% HS` : null
  ].filter(Boolean).join(" · ") || "STATS PENDING";

  return `<article class="match-item ${cls}">
    <span class="match-result-mark" aria-label="${escapeHtml(result)}"><span></span></span>
    <div class="match-main">
      <strong class="match-map" title="${escapeHtml(match.map || "FACEIT match")}">${escapeHtml(match.map || "FACEIT MATCH")}</strong>
      <span class="match-date">${escapeHtml(date)}</span>
    </div>
    <div class="match-score-block">
      <strong class="match-score">${escapeHtml(match.score || "—")}</strong>
      <span class="match-kda-line">${kda}</span>
    </div>
    <span class="match-performance">${performance}</span>
    <div class="match-elo-block">${eloMarkup}<span class="match-elo-label">ELO</span></div>
  </article>`;
}

function renderMatches(append = false) {
  const root = $("matches");
  if (!recorded.length) {
    root.innerHTML = '<p class="empty">NO MATCHES SAVED YET. THEY WILL SYNC AUTOMATICALLY.</p>';
    return;
  }
  const rows = recorded.filter((m) => filter === "all" || (m.outcome || "").toLowerCase() === filter);
  const markup = rows.length
    ? rows.map(matchRow).join("")
    : `<p class="empty">NO ${filter.toUpperCase()} IN RECORDED MATCHES.</p>`;
  if (append) root.insertAdjacentHTML("beforeend", markup);
  else root.innerHTML = markup;
  const more = $("matches-load-more");
  if (more) {
    more.hidden = !hasMoreMatches;
    more.disabled = loadingMoreMatches;
    more.textContent = loadingMoreMatches ? "LOADING…" : `LOAD OLDER MATCHES · ${Math.max(0, (window.matchTotal || 0) - recorded.length)} REMAINING`;
  }
}

// ==========================================================================
// ELO PROGRESSION CHART
// ==========================================================================

function renderEloHistory(snapshots, range = "all") {
  const root = $("elo-chart"), sum = $("history-summary");
  $("history-count").textContent = `${snapshots.length} SNAPSHOT${snapshots.length === 1 ? "" : "S"}`;
  const pts = snapshots.map((s) => ({ v: Number(s.elo), t: new Date(s.captured_at) })).filter((p) => Number.isFinite(p.v));

  if (!pts.length) {
    const rangeMsg = range === "7d" ? "IN THE LAST 7 DAYS" : range === "30d" ? "IN THE LAST 30 DAYS" : "YET";
    root.innerHTML = `<p class="empty">NO ELO SNAPSHOTS ${rangeMsg}. SNAPSHOTS ARE RECORDED WHEN ELO CHANGES ARE DETECTED.</p>`;
    sum.innerHTML = "";
    return;
  }
  if (pts.length === 1) {
    const single = pts[0];
    root.innerHTML = `<div class="empty" style="padding:2rem 1rem">
      <p style="font-size:1.1rem;margin-bottom:0.5rem"><strong>${single.v.toLocaleString()} ELO</strong> RECORDED ON ${single.t.toLocaleDateString([], { month: "short", day: "numeric" })}</p>
      <p style="color:var(--text-dim);font-size:0.9rem">INSUFFICIENT DATA IN THIS TIME RANGE TO RENDER A TREND LINE. PLAY MORE MATCHES AND YOUR ELO PROGRESSION WILL APPEAR HERE.</p>
    </div>`;
    sum.innerHTML = `<div>RECORDED<strong>${single.v.toLocaleString()}</strong></div><div>DATE<strong>${single.t.toLocaleDateString([], { month: "short", day: "numeric" })}</strong></div>`;
    return;
  }

  const W = 900, H = 260, L = 48, R = 20, T = 20, B = 34;
  const vals = pts.map((p) => p.v);
  const minVal = Math.min(...vals, BASELINE);
  const maxVal = Math.max(...vals, BASELINE);
  const lo = Math.floor((minVal - 20) / 20) * 20;
  const hi = Math.ceil((maxVal + 20) / 20) * 20;

  const x = (i) => pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const fmt = (d) => d.toLocaleDateString([], { month: "short", day: "numeric" });

  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)} ${H - B} L${x(0).toFixed(1)} ${H - B} Z`;

  const ticks = [0, 1, 2, 3, 4].map((k) => Math.round(lo + ((hi - lo) * k) / 4));
  const grid = ticks.map((v) => `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${L - 10}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");

  const refs = [`<line class="chart-base" x1="${L}" x2="${W - R}" y1="${y(BASELINE)}" y2="${y(BASELINE)}"/>`]
    .concat(TARGETS.filter((t) => t > lo && t < hi).map((t) => `<line class="chart-tgt" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`)).join("");

  const dots = pts.length <= 40
    ? pts.map((p, i) => `<circle class="chart-pt" cx="${x(i)}" cy="${y(p.v)}" r="4.5"/>`).join("")
    : `<circle class="chart-pt" cx="${x(pts.length - 1)}" cy="${y(vals[vals.length - 1])}" r="5"/>`;

  root.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="ELO Progression Chart">
    <defs>
      <linearGradient id="eloGlowArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ff5500" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#ff5500" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    ${refs}
    <path class="chart-area" fill="url(#eloGlowArea)" d="${area}"/>
    <path class="chart-line" pathLength="1" d="${line}"/>
    ${dots}
    <g class="chart-hov" id="chart-hov">
      <line class="chart-crosshair" id="chart-cross" y1="${T}" y2="${H - B}"/>
      <circle class="chart-pt" id="chart-hp" r="6"/>
    </g>
    <text class="chart-axis" x="${L}" y="${H - 10}">${fmt(pts[0].t)}</text>
    <text class="chart-axis" x="${W - R}" y="${H - 10}" text-anchor="end">${fmt(pts[pts.length - 1].t)}</text>
  </svg>
  <div class="chart-tip" id="chart-tip"></div>`;

  const svg = root.querySelector("svg"), tip = $("chart-tip"), hov = $("chart-hov");
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let idx = 0, best = Infinity;
    pts.forEach((_, i) => { const d = Math.abs(x(i) - px); if (d < best) { best = d; idx = i; } });
    const p = pts[idx];
    $("chart-cross").setAttribute("x1", x(idx));
    $("chart-cross").setAttribute("x2", x(idx));
    $("chart-hp").setAttribute("cx", x(idx));
    $("chart-hp").setAttribute("cy", y(p.v));

    tip.innerHTML = `<b>${p.v.toLocaleString()} ELO</b><span>${p.t.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>`;
    tip.style.left = `${(x(idx) / W) * rect.width}px`;
    tip.style.top = `${(y(p.v) / H) * rect.height}px`;
    hov.style.opacity = 1;
    tip.style.opacity = 1;
  };

  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => {
    hov.style.opacity = 0;
    tip.style.opacity = 0;
  });

  const first = vals[0], latest = vals[vals.length - 1], change = latest - first;
  const maxRecorded = Math.max(...vals);

  sum.innerHTML = `
    <div>START RECORDED<strong>${first.toLocaleString()}</strong></div>
    <div>LATEST SNAPSHOT<strong>${latest.toLocaleString()}</strong></div>
    <div>PEAK RECORDED<strong>${maxRecorded.toLocaleString()}</strong></div>
    <div>NET PROGRESS<strong class="${change >= 0 ? "pos" : "neg"}">${change > 0 ? "+" : ""}${change.toLocaleString()}</strong></div>
  `;
}

// ==========================================================================
// API DATA LOADERS
// ==========================================================================

async function loadHistory(range = historyRange) {
  try {
    matchOffset = 0;
    const response = await fetch(`/api/history?range=${encodeURIComponent(range)}&offset=0&limit=100`);
    if (!response.ok) throw new Error("History unavailable");
    const data = await response.json();

    if (!data.configured) {
      $("history-count").textContent = "NO DATABASE";
      $("elo-chart").innerHTML = '<p class="empty">CONNECT A DATABASE TO SAVE ELO SNAPSHOTS.</p>';
      $("matches").innerHTML = '<p class="empty">MATCH HISTORY NEEDS DATABASE CONNECTION.</p>';
      renderCurrentForm([]);
      return;
    }

    const snapshots = data.snapshots || [];
    renderEloHistory(snapshots, range);

    recorded = data.matches || [];
    matchOffset = recorded.length;
    hasMoreMatches = Boolean(data.hasMoreMatches);
    window.matchTotal = Number(data.totalMatches || recorded.length);
    renderMatches();
    renderCurrentForm(recorded);

    // Compute Peak ELO from Supabase DB snapshots & matches
    const allElo = [
      ...snapshots.map((s) => Number(s.elo)),
      ...recorded.map((m) => Number(m.elo_after)),
      ...recorded.map((m) => Number(m.elo_before)),
      Number(currentElo)
    ].filter((v) => Number.isFinite(v) && v > 0);

    peakElo = allElo.length ? Math.max(...allElo) : (currentElo || 2127);
    countUp($("peak-elo"), peakElo);

    const peakLvl = getSkillLevel(peakElo);
    $("peak-level-icon").src = getLevelIcon(peakLvl, peakLvl >= 11);
    $("peak-level-icon").alt = `Level ${peakLvl}`;

  } catch (error) {
    $("history-count").textContent = "OFFLINE";
    $("elo-chart").innerHTML = '<p class="empty">COULD NOT LOAD HISTORY. RETRYING SHORTLY.</p>';
  }
}

async function load() {
  try {
    const response = await fetch("/api/player");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load FACEIT profile.");

    const player = data.player;
    currentPlayer = player;
    currentElo = Number(player.elo);
    const skillLevel = Number(player.skillLevel);

    // Status Indicator
    $("connection").textContent = "FACEIT CONNECTED";
    $("dot").classList.add("on");

    // Profile Details
    $("nickname").textContent = (player.nickname || "KIYOSEI").toUpperCase();
    if (player.faceitUrl) $("faceit-link").href = player.faceitUrl;

    // Avatar Priority: Live FACEIT Profile Avatar, fallback to extracted anime avatar
    const avatarImg = $("avatar-img");
    if (player.avatar) {
      avatarImg.src = player.avatar;
    } else {
      avatarImg.src = "/assets/avatar-fallback.jpg";
    }

    // Current ELO & Level Icon
    countUp($("current-elo"), currentElo);
    const currLvl = Number.isFinite(skillLevel) ? skillLevel : getSkillLevel(currentElo);
    $("current-level-icon").src = getLevelIcon(currLvl, currLvl >= 11);
    $("current-level-icon").alt = `Level ${currLvl}`;

    // ELO Needed Pill
    $("elo-needed-text").textContent = getEloNeededText(currentElo);

    // Sync Timestamp
    $("updated").textContent = `SYNCED ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }).toUpperCase()}`;

    // Load History & Form from DB
    await loadHistory();

  } catch (error) {
    $("connection").textContent = "NOT CONNECTED";
    $("dot").classList.remove("on");
    toast(error.message, { error: true, ms: 7000 });
    $("matches").innerHTML = '<p class="empty">COULD NOT LOAD FACEIT DATA. CHECK SERVER API KEY.</p>';
    $("elo-chart").innerHTML = '<p class="empty">COULD NOT LOAD FACEIT DATA.</p>';
    renderCurrentForm([]);
  }
}

// Filter buttons
document.querySelectorAll(".seg-pills button").forEach((btn) => {
  btn.addEventListener("click", () => {
    filter = btn.dataset.f;
    document.querySelectorAll(".seg-pills button").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", b === btn);
    });
    renderMatches();
  });
});


async function loadMoreMatches() {
  if (loadingMoreMatches || !hasMoreMatches) return;
  loadingMoreMatches = true;
  renderMatches();
  try {
    const response = await fetch(`/api/history?range=all&offset=${matchOffset}&limit=100`);
    if (!response.ok) throw new Error("Could not load older matches.");
    const data = await response.json();
    const next = data.matches || [];
    recorded = recorded.concat(next);
    matchOffset += next.length;
    hasMoreMatches = Boolean(data.hasMoreMatches);
    window.matchTotal = Number(data.totalMatches || window.matchTotal || recorded.length);
    renderMatches(true);
  } catch (error) {
    toast(error.message, { error: true });
  } finally {
    loadingMoreMatches = false;
    renderMatches();
  }
}

// ELO history range controls
document.querySelectorAll("#history-range button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    historyRange = btn.dataset.range;
    document.querySelectorAll("#history-range button").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", b === btn);
    });
    await loadHistory(historyRange);
  });
});

$("matches-load-more")?.addEventListener("click", loadMoreMatches);

// Initial load & 5 minute periodic sync
load();
setInterval(load, 5 * 60 * 1000);
