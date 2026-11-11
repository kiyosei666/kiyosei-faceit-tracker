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
// CURRENT FORM – LAST 7 DAYS, PERFORMANCE-BASED
// Missing FACEIT stats are excluded rather than silently converted to zero.
function formNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getFormTier(kd) {
  if (!Number.isFinite(kd)) return { label: "AWAITING DATA", className: "pending" };
  if (kd < 0.5) return { label: "BOT", className: "bot" };
  if (kd < 0.8) return { label: "BOT WITH A BRAIN", className: "brain" };
  if (kd < 1.0) return { label: "WARMING UP", className: "warming" };
  if (kd < 1.2) return { label: "SOLID KIYOSEI", className: "solid" };
  if (kd < 1.5) return { label: "LOCKED IN", className: "locked" };
  if (kd < 1.9) return { label: "PRIME KIYOSEI", className: "prime" };
  if (kd < 2.2) return { label: "DONK-LIKE", className: "donk" };
  return { label: "GODLIKE", className: "godlike" };
}

function matchKd(match) {
  const stats = match.stats || {};
  const kills = formNumber(stat(stats, "Kills", "K"));
  const deaths = formNumber(stat(stats, "Deaths", "D"));
  if (kills === null || deaths === null || deaths === 0) return null;
  return kills / deaths;
}

function renderCurrentForm(matches) {
  const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekMatches = matches.filter((match) => {
    const raw = match.finished_at || match.date;
    if (!raw) return false;
    const timestamp = Number(raw);
    const finishedAt = Number.isFinite(timestamp)
      ? (timestamp < 1e12 ? timestamp * 1000 : timestamp)
      : new Date(raw).getTime();
    return Number.isFinite(finishedAt) && finishedAt >= weekStart;
  });
  const withStats = weekMatches.filter((match) => {
    const stats = match.stats || {};
    return formNumber(stat(stats, "Kills", "K")) !== null &&
      formNumber(stat(stats, "Deaths", "D")) !== null;
  });

  if (!weekMatches.length) {
    $("form-kd").textContent = "—";
    $("form-tier").textContent = "NO MATCHES THIS WEEK";
    $("form-tier").className = "form-tier pending";
    $("form-kda-vals").textContent = "NO MATCHES THIS WEEK";
    $("form-winrate").textContent = "—%";
    $("form-record").textContent = "PLAY AND SYNC TO BUILD YOUR FORM";
    $("form-adr").textContent = "—";
    $("form-hs").textContent = "—%";
    $("form-kda-ratio").textContent = "—";
    $("form-streak").textContent = "NO DATA";
    $("form-pips").innerHTML = '<span class="empty">YOUR PERFORMANCE TIMELINE WILL APPEAR HERE</span>';
    return;
  }

  let totalKills = 0, totalDeaths = 0, totalAssists = 0, kdaCount = 0;
  let totalAdr = 0, adrCount = 0, totalHs = 0, hsCount = 0;
  let wins = 0, losses = 0;
  for (const match of weekMatches) {
    const stats = match.stats || {};
    const kills = formNumber(stat(stats, "Kills", "K"));
    const deaths = formNumber(stat(stats, "Deaths", "D"));
    const assists = formNumber(stat(stats, "Assists", "A"));
    if (kills !== null && deaths !== null && assists !== null) {
      totalKills += kills;
      totalDeaths += deaths;
      totalAssists += assists;
      kdaCount++;
    }
    const adr = formNumber(stat(stats, "ADR"));
    if (adr !== null) { totalAdr += adr; adrCount++; }
    const hs = formNumber(stat(stats, "Headshots %"));
    if (hs !== null && hs <= 100) { totalHs += hs; hsCount++; }

    const outcome = (match.outcome || "").toLowerCase();
    if (outcome === "win") wins++;
    else if (outcome === "loss") losses++;
  }

  const kd = withStats.length && withStats.reduce((sum, match) =>
    sum + formNumber(stat(match.stats || {}, "Kills", "K")), 0) /
    (withStats.reduce((sum, match) =>
      sum + formNumber(stat(match.stats || {}, "Deaths", "D")), 0) || NaN);
  const tier = getFormTier(kd);
  $("form-kd").textContent = Number.isFinite(kd) ? kd.toFixed(2) : "—";
  $("form-tier").textContent = tier.label;
  $("form-tier").className = `form-tier ${tier.className}`;

  if (kdaCount) {
    $("form-kda-vals").textContent = `${totalKills.toLocaleString()} / ${totalDeaths.toLocaleString()} / ${totalAssists.toLocaleString()}`;
    $("form-kda-ratio").textContent = totalDeaths > 0
      ? ((totalKills + totalAssists) / totalDeaths).toFixed(2) : "—";
  } else {
    $("form-kda-vals").textContent = "STATS PENDING";
    $("form-kda-ratio").textContent = "—";
  }

  const completed = wins + losses;
  $("form-winrate").textContent = completed ? `${Math.round(wins / completed * 100)}%` : "—%";
  $("form-record").textContent = `${weekMatches.length} MATCHES · ${withStats.length} WITH K/D DATA`;
  $("form-adr").textContent = adrCount ? (totalAdr / adrCount).toFixed(1) : "—";
  $("form-hs").textContent = hsCount ? `${Math.round(totalHs / hsCount)}%` : "—";
  $("form-streak").textContent = `${withStats.length} MATCHES RATED`;

  // Each marker represents individual fragging performance, never the match result.
  const pips = weekMatches.slice(0, 16).map((match) => {
    const individualKd = matchKd(match);
    const matchTier = getFormTier(individualKd);
    const dateRaw = match.finished_at || match.date;
    const date = dateRaw ? new Date(Number(dateRaw) < 1e12 ? Number(dateRaw) * 1000 : dateRaw)
      .toLocaleDateString([], { month: "short", day: "numeric" }) : "";
    const rating = Number.isFinite(individualKd) ? `${individualKd.toFixed(2)} K/D · ${matchTier.label}` : "STATS PENDING";
    const tooltip = `${match.map || "Match"} · ${rating} · ${date}`;
    return `<span class="form-pip-pill ${matchTier.className}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(rating)}"></span>`;
  });
  $("form-pips").innerHTML = pips.join("");
}

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

function renderHistorySummary(pts, range, allTimePeak, peakSource) {
  const sum = $("history-summary");
  const first = pts[0] || null;
  const latest = pts[pts.length - 1] || null;
  const values = pts.map((point) => point.v);
  const trackedPeak = values.length ? Math.max(...values) : null;
  const progress = first && latest ? latest.v - first.v : null;
  const periodLabel = range === "all" ? "START OF TRACKING" : "START OF PERIOD";
  const progressLabel = range === "all" ? "COMEBACK PROGRESS" : "PERIOD PROGRESS";
  const peakNote = peakSource === "user_reported"
    ? "HISTORICAL PEAK · PLAYER REPORTED · DATE UNKNOWN"
    : "HIGHEST ELO IN SAVED RECORDS";
  sum.innerHTML = `
    <div>${periodLabel}<strong>${first ? first.v.toLocaleString() : "—"}</strong></div>
    <div>LATEST SNAPSHOT<strong>${latest ? latest.v.toLocaleString() : "—"}</strong></div>
    <div>TRACKED PEAK<strong>${trackedPeak === null ? "—" : trackedPeak.toLocaleString()}</strong></div>
    <div>${progressLabel}<strong class="${progress === null ? "" : progress >= 0 ? "pos" : "neg"}">${progress === null ? "—" : `${progress > 0 ? "+" : ""}${progress.toLocaleString()}`}</strong></div>
    <div title="${peakNote}">ALL-TIME PEAK<strong>${Number.isFinite(Number(allTimePeak)) && Number(allTimePeak) > 0 ? Number(allTimePeak).toLocaleString() : "—"}</strong></div>
  `;
}

function renderEloHistory(snapshots, range = "all", allTimePeak = null, peakSource = null) {
  const root = $("elo-chart");
  $("history-count").textContent = `${snapshots.length} SNAPSHOT${snapshots.length === 1 ? "" : "S"}`;
  const pts = snapshots.map((s) => ({ v: Number(s.elo), t: new Date(s.captured_at) }))
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t.getTime()));

  if (!pts.length) {
    const rangeMsg = range === "7d" ? "IN THE LAST 7 DAYS" : range === "30d" ? "IN THE LAST 30 DAYS" : "YET";
    root.innerHTML = `<p class="empty">NO ELO SNAPSHOTS ${rangeMsg}. SNAPSHOTS ARE RECORDED WHEN ELO CHANGES ARE DETECTED.</p>`;
    renderHistorySummary([], range, allTimePeak, peakSource);
    return;
  }
  if (pts.length === 1) {
    const single = pts[0];
    root.innerHTML = `<div class="empty" style="padding:2rem 1rem">
      <p style="font-size:1.1rem;margin-bottom:0.5rem"><strong>${single.v.toLocaleString()} ELO</strong> RECORDED ON ${single.t.toLocaleDateString([], { month: "short", day: "numeric" })}</p>
      <p style="color:var(--text-dim);font-size:0.9rem">INSUFFICIENT DATA IN THIS TIME RANGE TO RENDER A TREND LINE. PLAY MORE MATCHES AND YOUR ELO PROGRESSION WILL APPEAR HERE.</p>
    </div>`;
    renderHistorySummary(pts, range, allTimePeak, peakSource);
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

  renderHistorySummary(pts, range, allTimePeak, peakSource);
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
    renderEloHistory(snapshots, range, data.peakElo, data.peakEloSource);

    recorded = data.matches || [];
    matchOffset = recorded.length;
    hasMoreMatches = Boolean(data.hasMoreMatches);
    window.matchTotal = Number(data.totalMatches || recorded.length);
    renderMatches();
    renderCurrentForm(recorded);

    // Peak ELO comes from a server-side aggregate across the complete database,
    // plus the explicitly sourced historical record. It is independent of the
    // selected chart range and the currently paginated match-history window.
    peakElo = data.peakElo === null || data.peakElo === undefined
      ? null
      : Number(data.peakElo);

    if (Number.isFinite(peakElo) && peakElo > 0) {
      countUp($("peak-elo"), peakElo);
      const peakLvl = getSkillLevel(peakElo);
      $("peak-level-icon").src = getLevelIcon(peakLvl, peakLvl >= 11);
      $("peak-level-icon").alt = `Level ${peakLvl}`;
      $("peak-pill").title = data.peakEloSource === "user_reported"
        ? "All-time peak · historical value previously reported by you; exact date unavailable"
        : "All-time peak · highest value in recorded ELO data";
    } else {
      $("peak-elo").textContent = "—";
      $("peak-level-icon").src = getLevelIcon(getSkillLevel(currentElo));
      $("peak-level-icon").alt = "Current FACEIT level";
      $("peak-pill").title = "No historical peak data available yet";
    }

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
