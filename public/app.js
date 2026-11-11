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
function renderMatches(matches) {
  const root = $("matches");
  if (!matches.length) {
    root.innerHTML = '<p class="empty">No recent matches returned by FACEIT.</p>';
    return;
  }
  root.innerHTML = matches.map((match) => {
    const date = match.date ? new Date(Number(match.date) * 1000).toLocaleDateString() : "Recent";
    const result = match.outcome || "Unknown";
    const cls = result.toLowerCase() === "win" ? "win" : result.toLowerCase() === "loss" ? "loss" : "";
    return `<div class="match-row"><span>${escapeHtml(match.map || "FACEIT match")}</span><span class="result ${cls}">${escapeHtml(result.toUpperCase())}</span><time>${escapeHtml(date)}</time></div>`;
  }).join("");
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
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
    renderMatches(data.matches);
    $("updated").textContent = `UPDATED ${new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;
    $("notice").textContent = "";
  } catch (error) {
    $("connection").textContent = "NOT CONNECTED";
    $("notice").textContent = error.message;
    $("matches").innerHTML = '<p class="empty">Connect your FACEIT API key in the deployment environment to load matches.</p>';
  }
}
load();
setInterval(load, 5 * 60 * 1000);
