const $ = (id) => document.getElementById(id);
const BASELINE = 1680;
const TARGETS = [1800, 1900, 2000];

function stat(stats, ...keys) {
  for (const key of keys) if (stats && stats[key] !== undefined) return stats[key];
  return null;
}
function number(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}
function renderMilestones(elo) {
  $("milestones").innerHTML = TARGETS.map((target) =>
    `<span class="${elo >= target ? "done" : ""}">${target.toLocaleString()} ${elo >= target ? "✓" : ""}</span>`
  ).join("");
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
function renderMatches(matches) {
  const root = $("matches");
  if (!matches.length) {
    root.innerHTML = '<p class="empty">No matches saved yet. Keep this dashboard open while you play; it syncs with FACEIT every five minutes.</p>';
    return;
  }
  root.innerHTML = matches.map((match) => {
    const dateValue = match.finished_at || match.date;
    const date = dateValue ? new Date(Number(dateValue) * 1000).toLocaleDateString() : "Recent";
    const result = match.outcome || "Unknown";
    const cls = result.toLowerCase() === "win" ? "win" : result.toLowerCase() === "loss" ? "loss" : "";
    const stats = match.stats || {};
    const kd = stat(stats, "K/D Ratio", "K/D");
    const adr = stat(stats, "ADR");
    const hs = stat(stats, "Headshots %", "Headshots");
    const detail = [kd !== null ? `K/D ${number(kd, 2)}` : null,
      adr !== null ? `ADR ${number(adr, 0)}` : null,
      hs !== null ? `HS ${number(hs, 0)}%` : null].filter(Boolean).join(" · ");
    const elo = match.elo_change === null || match.elo_change === undefined ? "" :
      `<span class="elo-change ${Number(match.elo_change) >= 0 ? "positive" : "negative"}">${Number(match.elo_change) > 0 ? "+" : ""}${Number(match.elo_change)}</span>`;
    return `<div class="match-row">
      <div class="match-main"><strong>${escapeHtml(match.map || "FACEIT match")}</strong><small>${escapeHtml(detail || "Match stats unavailable")}</small></div>
      <span class="result ${cls}">${escapeHtml(result.toUpperCase())}</span>
      <div class="match-meta">${elo}<time>${escapeHtml(date)}</time></div>
    </div>`;
  }).join("");
}
function renderEloHistory(snapshots) {
  const root = $("elo-chart");
  $("history-count").textContent = `${snapshots.length} SNAPSHOT${snapshots.length === 1 ? "" : "S"}`;
  if (!snapshots.length) {
    root.innerHTML = '<p class="empty">No ELO snapshots recorded yet.</p>';
    $("history-summary").textContent = "";
    return;
  }
  const values = snapshots.map((point) => Number(point.elo)).filter(Number.isFinite);
  if (!values.length) return;
  const width = 900, height = 220, pad = 24;
  const min = Math.min(...values, BASELINE) - 20;
  const max = Math.max(...values, BASELINE) + 20;
  const range = Math.max(1, max - min);
  const coords = values.map((value, index) => ({
    x: values.length === 1 ? width / 2 : pad + index * (width - pad * 2) / (values.length - 1),
    y: height - pad - ((value - min) / range) * (height - pad * 2),
    value
  }));
  const line = coords.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const circles = coords.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${point.value} ELO</title></circle>`).join("");
  const first = values[0], latest = values[values.length - 1], change = latest - first;
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="ELO history chart">
    <line class="chart-baseline" x1="0" y1="${height - pad}" x2="${width}" y2="${height - pad}"></line>
    <path class="chart-line" d="${line}"></path><g class="chart-points">${circles}</g>
    <text x="4" y="15">${Math.max(...values)}</text><text x="4" y="${height - 8}">${Math.min(...values)}</text>
  </svg>`;
  $("history-summary").innerHTML = `<span>FIRST SAVED <strong>${first.toLocaleString()}</strong></span><span>LATEST <strong>${latest.toLocaleString()}</strong></span><span>CHANGE <strong class="${change >= 0 ? "positive" : "negative"}">${change > 0 ? "+" : ""}${change.toLocaleString()}</strong></span>`;
}
async function loadHistory() {
  try {
    const response = await fetch("/api/history");
    if (!response.ok) throw new Error("History unavailable");
    const data = await response.json();
    if (!data.configured) {
      $("history-count").textContent = "DATABASE NOT CONNECTED";
      return;
    }
    renderEloHistory(data.snapshots || []);
    renderMatches(data.matches || []);
  } catch (error) {
    $("history-count").textContent = "HISTORY OFFLINE";
  }
}
async function load() {
  try {
    const response = await fetch("/api/player");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load FACEIT profile.");
    const player = data.player;
    const elo = Number(player.elo);
    $("connection").textContent = "FACEIT CONNECTED";
    document.querySelector(".live-dot").classList.add("online");
    $("nickname").textContent = (player.nickname || "kiyosei").toUpperCase();
    $("profile-meta").textContent = player.country ? `FACEIT PLAYER · ${player.country.toUpperCase()}` : "FACEIT PLAYER PROFILE";
    $("faceit-link").href = player.faceitUrl;
    if (player.avatar) $("avatar").innerHTML = `<img src="${escapeHtml(player.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover">`;
    $("elo").textContent = Number.isFinite(elo) ? elo.toLocaleString() : "—";
    $("level").textContent = player.skillLevel ?? "—";
    const progress = Math.max(0, Math.min(100, ((elo - BASELINE) / (2000 - BASELINE)) * 100));
    $("progress-fill").style.width = `${progress}%`;
    $("progress-label").textContent = `${Math.round(progress)}% FROM ${BASELINE.toLocaleString()}`;
    renderMilestones(elo);
    const lifetime = data.lifetime || {};
    $("winrate").textContent = stat(lifetime, "Win Rate %", "Win Rate") !== null ? `${number(stat(lifetime, "Win Rate %", "Win Rate"))}%` : "—";
    $("kd").textContent = number(stat(lifetime, "Average K/D Ratio", "K/D Ratio"));
    $("hs").textContent = stat(lifetime, "Average Headshots %", "Headshots") !== null ? `${number(stat(lifetime, "Average Headshots %", "Headshots"))}%` : "—";
    $("matches-count").textContent = data.matches.length;
    $("updated").textContent = `UPDATED ${new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;
    $("notice").textContent = data.tracking?.configured
      ? (data.tracking.saved ? `SAVED ${data.tracking.saved} NEW MATCH${data.tracking.saved === 1 ? "" : "ES"}` : "")
      : "DATABASE NOT CONNECTED — LIVE PROFILE ONLY";
    await loadHistory();
  } catch (error) {
    $("connection").textContent = "NOT CONNECTED";
    $("notice").textContent = error.message;
    $("matches").innerHTML = '<p class="empty">Could not load FACEIT data. Check the server configuration.</p>';
  }
}
load();
setInterval(load, 5 * 60 * 1000);