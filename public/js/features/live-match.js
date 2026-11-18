(() => {
  const body = document.getElementById("live-match-body");
  const connection = document.getElementById("live-connection");
  const updated = document.getElementById("live-last-update");
  let briefingLoadedFor = null;
  let briefingBusy = false;
  let briefingHtml = "";
  if (!body || !connection || !updated) return;

  const labels = {
    INACTIVE: "WAITING FOR MATCH",
    MATCH_DETECTED: "MATCH DETECTED",
    CONFIGURING: "CONFIGURING",
    READY: "READY",
    IN_GAME: "IN GAME",
    ENDED: "MATCH ENDED",
    ABORTED: "MATCH ABORTED",
    CANCELLED: "MATCH CANCELLED"
  };
  const steps = ["MATCH_DETECTED", "CONFIGURING", "READY", "IN_GAME"];
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
  const time = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  function render(data) {
    connection.classList.toggle("is-online", Boolean(data && data.ok));
    connection.querySelector("span").textContent = data && data.ok ? "DETECTION ONLINE" : "SERVICE ISSUE";
    const state = data?.state || "INACTIVE";
    const match = data?.match;
    const active = Boolean(data?.inMatch && match);
    const label = labels[state] || state.replaceAll("_", " ");
    const stepIndex = steps.indexOf(state);
    const progress = steps.map((step, index) => {
      const done = stepIndex >= index && stepIndex !== -1;
      return '<span class="live-match__step ' + (done ? "is-done" : "") + '"><i></i>' + labels[step] + '</span>';
    }).join("");
    if (!active) {
      const ended = match && ["ENDED", "ABORTED", "CANCELLED"].includes(state);
      body.innerHTML = `
        <div class="live-match__empty">
          <span class="live-match__pulse" aria-hidden="true"></span>
          <div>
            <strong>${ended ? esc(label) : "NO ACTIVE MATCH DETECTED"}</strong>
            <p>${ended ? "Your previous match lifecycle was recorded. Ready for the next queue." : "Queue for a FACEIT match. Kiyosei will detect it automatically."}</p>
            ${match?.matchId ? '<small>LAST MATCH · ' + esc(match.matchId) + '</small>' : ""}
          </div>
        </div>`;
    } else {
      body.innerHTML = `
        <div class="live-match__status">
          <div><span class="live-match__state-label">MATCH STATUS</span><strong class="live-match__state">${esc(label)}</strong></div>
          <span class="live-match__live-tag ${state === "IN_GAME" ? "is-live" : ""}">${state === "IN_GAME" ? "● LIVE" : "TRACKING"}</span>
        </div>
        <div class="live-match__meta">
          <div><span>MAP</span><strong>${esc(match.map || "AWAITING MAP")}</strong></div>
          <div><span>FACEIT STATUS</span><strong>${esc(match.faceitStatus || label)}</strong></div>
          <div class="live-match__id"><span>MATCH ID</span><strong title="${esc(match.matchId)}">${esc(match.matchId || "—")}</strong></div>
        </div>
        <div class="live-match__steps">${progress}</div>
        <p class="live-match__hint">${state === "READY" ? "Server is ready. Waiting for FACEIT API to confirm the match is in progress." : state === "IN_GAME" ? "Match is confirmed in progress by FACEIT's match API." : "Kiyosei is tracking your FACEIT match lifecycle."}</p>
        <div class="live-ai">
          <div class="live-ai__toolbar">
            <strong>GEMINI MATCH INTELLIGENCE</strong>
            <button type="button" class="live-ai__button" data-live-briefing>GENERATE BRIEFING</button>
          </div>
          <div id="live-ai-briefing">${briefingHtml || '<p class="live-ai__placeholder">Generate an evidence-based briefing from your stats and available FACEIT match details.</p>'}</div>
        </div>`;
    }
    const activeMatchId = active ? match.matchId : null;
    if (activeMatchId !== briefingLoadedFor) {
      briefingLoadedFor = activeMatchId;
      briefingHtml = active ? '<p class="live-ai__placeholder">Match detected. Generate a Gemini briefing when map and team details are available.</p>' : "";
      const panel = document.getElementById("live-ai-briefing");
      if (panel) panel.innerHTML = active ? '<p class="live-ai__placeholder">Match detected. Generate a Gemini briefing when map and team details are available.</p>' : "";
    }
    updated.textContent = "LAST CHECK · " + time(data?.serverTime);
  }

  async function refresh() {
    try {
      const response = await fetch("/api/live/public", { cache: "no-store", headers: { "Accept": "application/json" } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Live status unavailable");
      render(data);
    } catch (_error) {
      connection.classList.remove("is-online");
      connection.querySelector("span").textContent = "RECONNECTING";
      body.innerHTML = '<div class="live-match__empty"><span class="live-match__pulse" aria-hidden="true"></span><div><strong>LIVE STATUS UNAVAILABLE</strong><p>Could not reach the detection service. It will retry automatically.</p></div></div>';
      updated.textContent = "WAITING FOR SERVICE";
    }
  }

  body.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-live-briefing]");
    if (!button || briefingBusy) return;
    const panel = document.getElementById("live-ai-briefing");
    briefingBusy = true;
    button.disabled = true;
    button.textContent = "ANALYZING MATCH…";
    if (panel) panel.innerHTML = '<p class="live-ai__placeholder">Gemini is analyzing your player data and available FACEIT match details…</p>';
    try {
      const response = await fetch("/api/live/briefing", { method: "POST", headers: { "Accept": "application/json" } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Briefing unavailable.");
      const b = data.briefing || {};
      const group = (title, items) => Array.isArray(items) && items.length
        ? '<section class="live-ai__group"><h4>' + title + '</h4><ul>' + items.map(x => '<li>' + esc(x) + '</li>').join("") + '</ul></section>' : "";
      briefingHtml = '<div class="live-ai__head"><span>GEMINI · ' + esc(data.model || "AI") + '</span><small>' + esc(data.map || "MAP UNKNOWN") + '</small></div>' +
        '<h3>' + esc(b.headline || "MATCH BRIEFING") + '</h3><p class="live-ai__plan">' + esc(b.mapPlan || "") + '</p>' +
        group("STRENGTHS TO LEAN ON", b.strengthsToLeanOn) +
        group("THREATS TO WATCH", b.threatsToWatch) +
        group("YOUR FOCUS", b.personalFocus) +
        group("DATA LIMITS", b.confidenceNotes);
      if (panel) panel.innerHTML = briefingHtml;
      button.textContent = "REFRESH BRIEFING";
    } catch (error) {
      briefingHtml = '<p class="live-ai__error">' + esc(error.message) + '</p>';
      if (panel) panel.innerHTML = briefingHtml;
      button.textContent = "TRY AGAIN";
    } finally {
      briefingBusy = false;
      button.disabled = false;
    }
  });

  refresh();
  window.setInterval(refresh, 12000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
