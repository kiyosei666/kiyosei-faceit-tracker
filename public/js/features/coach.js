/* ==========================================================================
   AI COACH panel.

   Three layers:
   1) ENGINE (server): GET /api/coach/overview returns the deterministic stats
      analysis (windows, maps, role tendencies, insights with evidence) plus an
      optional Gemini report. Every number shown here comes from the backend
      engine; Gemini only interprets them and its output is validated server-side.
   2) POST-MATCH: GET /api/coach/match/latest compares the newest match with the
      matches before it and adds a Gemini post-match report when available.
   3) FALLBACK: if the server endpoints are unavailable, the original in-browser
      comparison (last 10 vs earlier) is shown. No AI is involved there.
   ========================================================================== */
(function () {
  const OVERVIEW_ENDPOINT = "/api/coach/overview", MATCH_ENDPOINT = "/api/coach/match/latest";
  let serverLoaded = false;
  const RECENT = 10, MIN_RECENT = 5, MIN_BASE = 10, MAP_MIN_GAMES = 3;

  const pick = (s, ...keys) => {
    for (const k of keys) if (s && s[k] !== undefined && s[k] !== null && String(s[k]).trim() !== "") return s[k];
    return null;
  };
  const num = (v) => {
    if (v === null || v === undefined || String(v).trim() === "") return null;
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : null;
  };
  const outcome = (m) => String((m && m.outcome) || "").toLowerCase();
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function summarize(list) {
    let kills = 0, deaths = 0, kdN = 0, adrS = 0, adrN = 0, hsS = 0, hsN = 0, wins = 0, losses = 0;
    for (const m of list) {
      const s = m.stats || {};
      const k = num(pick(s, "Kills", "K")), d = num(pick(s, "Deaths", "D"));
      if (k !== null && d !== null) { kills += k; deaths += d; kdN++; }
      const adr = num(pick(s, "ADR"));
      if (adr !== null) { adrS += adr; adrN++; }
      const hs = num(pick(s, "Headshots %", "Headshots"));
      if (hs !== null && hs <= 100) { hsS += hs; hsN++; }
      const o = outcome(m);
      if (o === "win") wins++; else if (o === "loss") losses++;
    }
    return {
      matches: list.length,
      kd:  kdN && deaths > 0 ? { v: kills / deaths, n: kdN } : null,
      adr: adrN ? { v: adrS / adrN, n: adrN } : null,
      hs:  hsN ? { v: hsS / hsN, n: hsN } : null,
      winRate: wins + losses ? { v: (wins / (wins + losses)) * 100, n: wins + losses } : null
    };
  }

  const METRICS = [
    { key: "kd",      label: "K/D",        digits: 2, unit: "",  step: 0.05 },
    { key: "adr",     label: "ADR",        digits: 1, unit: "",  step: 2 },
    { key: "hs",      label: "HEADSHOT %", digits: 0, unit: "%", step: 2 },
    { key: "winRate", label: "WIN RATE",   digits: 0, unit: "%", step: 5 }
  ];

  function compare(recent, base) {
    return METRICS.map((m) => {
      const r = recent[m.key], b = base ? base[m.key] : null;
      const usable = r && b && r.n >= 3 && b.n >= 5;
      const delta = usable ? r.v - b.v : null;
      const trend = !usable ? "none" : Math.abs(delta) < m.step ? "steady" : delta > 0 ? "up" : "down";
      return { ...m, recent: r ? r.v : null, base: b ? b.v : null, delta, trend, ratio: usable ? Math.abs(delta) / m.step : 0 };
    });
  }

  function mapStats(matches) {
    const by = new Map();
    for (const m of matches) {
      const o = outcome(m);
      if (!m.map || (o !== "win" && o !== "loss")) continue;
      const e = by.get(m.map) || { map: m.map, wins: 0, games: 0 };
      e.games++; if (o === "win") e.wins++;
      by.set(m.map, e);
    }
    const list = [...by.values()].filter((e) => e.games >= MAP_MIN_GAMES)
      .map((e) => ({ ...e, rate: (e.wins / e.games) * 100 }))
      .sort((a, b) => b.rate - a.rate || b.games - a.games);
    if (!list.length) return { best: null, worst: null };
    const best = list[0], worst = list[list.length - 1];
    return { best, worst: worst.map === best.map ? null : worst };
  }

  function pace(matches, elo, targets, recentRate) {
    const nextTarget = (targets || []).find((t) => elo !== null && t > elo);
    if (!nextTarget) return null;
    const sample = matches.slice(0, 20).filter((m) => m.elo_change !== null && m.elo_change !== undefined && Number.isFinite(Number(m.elo_change)));
    const w = sample.filter((m) => Number(m.elo_change) > 0).map((m) => Number(m.elo_change));
    const l = sample.filter((m) => Number(m.elo_change) < 0).map((m) => Math.abs(Number(m.elo_change)));
    if (w.length < 3 || l.length < 1 || recentRate === null) return { target: nextTarget, estimate: null, reason: "NOT ENOUGH ELO DATA YET", sample: sample.length };
    const avgW = w.reduce((a, b) => a + b, 0) / w.length, avgL = l.reduce((a, b) => a + b, 0) / l.length;
    const rate = recentRate / 100;
    const net = rate * avgW - (1 - rate) * avgL;
    if (net <= 0) return { target: nextTarget, estimate: null, reason: "RECENT TREND IS FLAT OR NEGATIVE", avgW, avgL, sample: sample.length };
    return { target: nextTarget, estimate: Math.ceil((nextTarget - elo) / net), avgW, avgL, net, sample: sample.length };
  }

  function computeInsights(matches, state) {
    const list = Array.isArray(matches) ? matches : [];
    const decided = list.filter((m) => ["win", "loss"].includes(outcome(m))).length;
    if (decided < MIN_RECENT) return { enough: false, decided };
    const recent = summarize(list.slice(0, RECENT));
    const baseList = list.slice(RECENT);
    const base = baseList.length >= MIN_BASE ? summarize(baseList) : null;
    const rows = compare(recent, base);
    const moves = rows.filter((r) => r.trend === "up" || r.trend === "down").sort((a, b) => b.ratio - a.ratio);

    let summary;
    if (!base) {
      summary = `Building your baseline: ${baseList.length} of ${MIN_BASE} earlier matches saved. Comparisons appear once there are enough.`;
    } else if (!moves.length) {
      summary = `Your last ${recent.matches} matches look in line with your earlier average. No clear change in K/D, ADR, headshot % or win rate.`;
    } else {
      const top = moves[0];
      const fmt = (v) => v.toFixed(top.digits) + top.unit;
      summary = `${top.label} is ${top.trend} ${Math.abs(top.delta).toFixed(top.digits)}${top.unit} over your last ${recent.matches} matches (${fmt(top.recent)} vs ${fmt(top.base)} earlier). This suggests a shift, but it is a small sample, not proof.`;
    }
    const elo = state && Number.isFinite(Number(state.elo)) ? Number(state.elo) : null;
    return {
      enough: true, decided, recentCount: recent.matches, baseCount: baseList.length,
      rows, summary, maps: mapStats(list),
      pace: pace(list, elo, state && state.targets, recent.winRate ? recent.winRate.v : null)
    };
  }

  const fmtVal = (r, v) => (v === null || v === undefined ? "—" : v.toFixed(r.digits) + r.unit);

  function renderInsights(ins) {
    if (!ins.enough) {
      return `<p class="empty empty--roomy">NEED AT LEAST ${MIN_RECENT} SAVED MATCHES FOR INSIGHTS.<br>${ins.decided} SO FAR.</p>`;
    }
    const rows = ins.rows.map((r) => {
      const arrow = r.trend === "up" ? "▲" : r.trend === "down" ? "▼" : r.trend === "steady" ? "●" : "–";
      const delta = r.delta === null ? "NO BASELINE" : (r.trend === "steady" ? "STEADY" : `${arrow} ${Math.abs(r.delta).toFixed(r.digits)}${r.unit}`);
      return `<div class="coach-row">
        <span class="coach-row__label">${r.label}</span>
        <span class="coach-row__now">${fmtVal(r, r.recent)}</span>
        <span class="coach-row__base">${r.base === null ? "" : "VS " + fmtVal(r, r.base)}</span>
        <span class="coach-delta coach-delta--${r.trend}">${delta}</span>
      </div>`;
    }).join("");

    const mapTile = (label, e, cls) => e
      ? `<div class="tile ${cls}"><span class="tile__label">${label}</span><strong class="tile__value coach__map">${esc(String(e.map).toUpperCase())}</strong><span class="tile__sub">${Math.round(e.rate)}% WIN · ${e.games} GAMES</span></div>`
      : "";
    const maps = mapTile("STRONGEST MAP", ins.maps.best, "coach-tile--good") + mapTile("WEAKEST MAP", ins.maps.worst, "coach-tile--bad");

    let paceHtml = "";
    if (ins.pace) {
      const p = ins.pace;
      const value = p.estimate ? `~${p.estimate}` : "—";
      const sub = p.estimate
        ? `MATCHES TO ${p.target.toLocaleString()} ELO · ESTIMATE`
        : `TO ${p.target.toLocaleString()} ELO · ${p.reason}`;
      const detail = p.avgW ? `<span class="tile__sub">AVG +${Math.round(p.avgW)} WIN / −${Math.round(p.avgL)} LOSS · LAST ${p.sample} MATCHES</span>` : "";
      paceHtml = `<div class="tile coach__pace"><span class="tile__label">ELO PACE</span><strong class="tile__value">${value}</strong><span class="tile__sub">${sub}</span>${detail}</div>`;
    }

    return `<p class="coach__summary">${esc(ins.summary)}</p>
      <div class="coach-rows" aria-label="Last ${ins.recentCount} matches compared with earlier matches">${rows}</div>
      ${maps ? `<div class="coach__tiles">${maps}</div>` : ""}
      ${paceHtml}`;
  }

  function listOf(items) {
    return (Array.isArray(items) ? items : [])
      .map((i) => (typeof i === "string" ? i : i && typeof i.text === "string" ? i.text : null))
      .filter(Boolean).slice(0, 6);
  }

  function renderReport(report, modeLabel) {
    const box = document.getElementById("coach-report");
    const mode = document.getElementById("coach-mode");
    if (!box) return false;
    const valid = report && typeof report === "object" && typeof report.summary === "string" && report.summary.trim();
    if (!valid) { box.hidden = true; box.innerHTML = ""; if (mode) mode.textContent = "LIVE INSIGHTS"; return false; }
    const section = (title, items) => {
      const li = listOf(items);
      return li.length ? `<div class="coach-report__group"><h3>${title}</h3><ul>${li.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "";
    };
    const note = (title, text) => (typeof text === "string" && text.trim() ? `<div class="coach-report__group"><h3>${title}</h3><p class="coach__text">${esc(text)}</p></div>` : "");
    box.innerHTML = `${report.headline ? `<h3 class="coach__headline">${esc(report.headline)}</h3>` : ""}<p class="coach__summary">${esc(report.summary)}</p>
      ${note("RECENT FORM", report.recentForm)}${note("ROLE PROFILE", report.roleProfile)}
      ${section("STRENGTHS", report.strengths)}${section("WEAKNESSES", report.weaknesses)}
      ${section("PATTERNS", report.patterns)}${section("PRIORITIES", report.priorities)}${section("CAVEATS", report.caveats)}`;
    box.hidden = false;
    if (mode) mode.textContent = modeLabel || (report.date ? `AI REPORT · ${String(report.date).slice(0, 10)}` : "AI REPORT");
    return true;
  }

  const SIG = { clear: "CLEAR", likely: "LIKELY", possible: "POSSIBLE", none: "NO CHANGE" };
  const pctf = (v, d = 0) => (v === null || v === undefined ? "—" : (v * 100).toFixed(d) + "%");

  function engineRows(a) {
    const w = a.windows && a.windows.last20 && a.windows.last20.vsEarlier;
    if (!w) return "";
    const fmt = { kd: (v) => v.toFixed(2), adr: (v) => v.toFixed(1), kr: (v) => v.toFixed(2), hs: (v) => v.toFixed(0) + "%", winRate: (v) => pctf(v, 1) };
    return ["kd", "adr", "kr", "hs", "winRate"].map((k) => {
      const c = w[k];
      if (!c) return "";
      if (c.status) return `<div class="coach-row"><span class="coach-row__label">${esc(c.label)}</span><span class="coach-row__now">—</span><span class="coach-row__base">LAST 20</span><span class="coach-delta coach-delta--none">SMALL SAMPLE</span></div>`;
      const trend = c.significance === "none" ? "steady" : c.delta > 0 ? "up" : "down";
      const arrow = trend === "up" ? "▲" : trend === "down" ? "▼" : "●";
      return `<div class="coach-row"><span class="coach-row__label">${esc(c.label)}</span><span class="coach-row__now">${fmt[k](c.recent)}</span><span class="coach-row__base">VS ${fmt[k](c.earlier)}</span><span class="coach-delta coach-delta--${trend}">${arrow} ${SIG[c.significance] || ""}</span></div>`;
    }).join("");
  }

  function renderEngine(a) {
    const box = document.getElementById("coach-body");
    if (!box) return;
    const o = a.overall || {};
    const tile = (label, v, sub) => `<div class="tile"><span class="tile__label">${label}</span><strong class="tile__value">${v}</strong><span class="tile__sub">${sub}</span></div>`;
    const kd = o.kd && o.kd.supported !== false ? o.kd.value.toFixed(2) : "—";
    const adr = o.adr && o.adr.supported !== false ? o.adr.value.toFixed(1) : "—";
    const wr = o.winRate && o.winRate.supported !== false ? pctf(o.winRate.value, 1) : "—";
    const role = a.role && a.role.status === "ok"
      ? tile("PLAYSTYLE TENDENCY", esc(a.role.profile.toUpperCase()), `${esc(a.role.confidence.level.toUpperCase())} CONFIDENCE · FROM STATS, NOT POSITIONAL DATA`)
      : tile("PLAYSTYLE TENDENCY", "—", "NOT ENOUGH STAT INDICATORS");
    const last = (k) => { const m = a.windows && a.windows[k] && a.windows[k].metrics && a.windows[k].metrics.kd; return m && m.supported !== false ? m.value.toFixed(2) : "—"; };
    const insights = Array.isArray(a.insights) ? a.insights : [];
    const group = (title, type) => {
      const items = insights.filter((i) => i.type === type).slice(0, 4);
      return items.length ? `<div class="coach-report__group"><h3>${title}</h3><ul>${items.map((i) => `<li>${esc(i.statement)}</li>`).join("")}</ul></div>` : "";
    };
    const limits = insights.find((i) => i.id === "data.limits");
    const trendItems = insights.filter((i) => i.type === "trend").slice(0, 3);
    box.innerHTML = `<div class="coach__tiles">${tile("K/D · ALL", kd, `${a.meta.matchesWithStats} MATCHES WITH STATS`)}${tile("ADR · ALL", adr, "ROUND-WEIGHTED")}${tile("WIN RATE · ALL", wr, `${a.meta.totalMatches} MATCHES`)}${role}</div>
      <div class="coach-rows" aria-label="Last 20 matches compared with earlier matches">${engineRows(a)}</div>
      <p class="coach__note coach__note--inline">K/D LAST 10 / 20 / 50: ${last("last10")} / ${last("last20")} / ${last("last50")}. SHIFT LABELS COME FROM A STATISTICAL TEST, NOT A FIXED THRESHOLD.</p>
      ${trendItems.length ? `<div class="coach-report__group"><h3>RECENT FORM</h3><ul>${trendItems.map((i) => `<li>${esc(i.statement)}</li>`).join("")}</ul></div>` : ""}
      ${group("STRENGTHS", "strength")}${group("WEAKNESSES", "weakness")}${group("PATTERNS", "pattern")}
      ${limits ? `<p class="coach__note">${esc(limits.statement.toUpperCase())}</p>` : ""}`;
  }

  function aiToReport(ai, analysis) {
    if (!ai || !ai.report || typeof ai.report !== "object") return null;
    const r = ai.report;
    const t = (arr) => (Array.isArray(arr) ? arr.map((x) => (x && x.text) || x) : []);
    return {
      headline: r.headline, summary: r.assessment, recentForm: r.recentForm, roleProfile: r.roleProfile,
      strengths: t(r.strengths), weaknesses: t(r.weaknesses), patterns: t(r.recurringPatterns),
      priorities: (Array.isArray(r.recommendations) ? r.recommendations : []).map((x) => `${x.action} — ${x.rationale}${x.trackMetric ? ` (Track: ${x.trackMetric})` : ""}`),
      caveats: Array.isArray(r.caveats) ? r.caveats : []
    };
  }

  function renderMatch(data) {
    const box = document.getElementById("coach-match");
    if (!box) return;
    if (!data || !data.match) { box.hidden = true; box.innerHTML = ""; return; }
    const m = data.match;
    const rows = Object.values(m.compare || {}).filter((c) => !c.status).map((c) => {
      const cls = c.band === "well above usual" ? "up" : c.band === "well below usual" ? "down" : "steady";
      return `<div class="coach-row"><span class="coach-row__label">${esc(c.label)}</span><span class="coach-row__now">${c.value}</span><span class="coach-row__base">USUAL ${c.baselineMean}</span><span class="coach-delta coach-delta--${cls}">${esc(c.band.toUpperCase())}</span></div>`;
    }).join("");
    const ai = data.ai && data.ai.report;
    const list = (title, items) => (Array.isArray(items) && items.length ? `<div class="coach-report__group"><h3>${title}</h3><ul>${items.map((i) => `<li>${esc(i.text || i)}</li>`).join("")}</ul></div>` : "");
    const result = m.match.outcome ? `${m.match.outcome.toUpperCase()}${m.match.score ? " " + esc(m.match.score) : ""}` : "RESULT UNKNOWN";
    box.innerHTML = `<h3 class="coach__headline">LATEST MATCH · ${esc(String(m.match.map || "").toUpperCase())} · ${result}</h3>
      ${ai ? `<p class="coach__summary">${esc(ai.headline)} ${esc(ai.summary)}</p>` : ""}
      ${rows ? `<div class="coach-rows">${rows}</div><p class="coach__note coach__note--inline">COMPARED WITH THE ${m.baseline.size} MATCHES BEFORE IT.</p>` : '<p class="coach__note">NO STORED STATS FOR THIS MATCH YET.</p>'}
      ${ai ? list("WENT WELL", ai.wentWell) + list("TO IMPROVE", ai.toImprove) + (ai.takeaway ? `<div class="coach-report__group"><h3>TAKEAWAY</h3><p class="coach__text">${esc(ai.takeaway)}</p></div>` : "") : ""}`;
    box.hidden = false;
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function loadServer() {
    try {
      const data = await getJson(OVERVIEW_ENDPOINT);
      if (!data || !data.analysis || !data.analysis.meta || !data.analysis.meta.totalMatches) return;
      serverLoaded = true;
      renderEngine(data.analysis);
      const report = aiToReport(data.ai, data.analysis);
      const mode = document.getElementById("coach-mode");
      const noteEl = document.getElementById("coach-note");
      if (report) {
        renderReport(report, "AI COACH");
      } else if (mode) {
        mode.textContent = "ENGINE INSIGHTS";
        const box = document.getElementById("coach-report");
        if (box && data.ai && data.ai.message) { box.hidden = false; box.innerHTML = `<p class="coach__note">${esc(String(data.ai.message).toUpperCase())}</p>`; }
      }
      if (noteEl) noteEl.textContent = "ALL NUMBERS ARE COMPUTED BY THE BACKEND STATS ENGINE FROM YOUR SAVED MATCHES. THE AI ONLY INTERPRETS THEM, AND ITS NUMBERS ARE VALIDATED AGAINST THE ENGINE. IT SEES STATISTICS ONLY, NEVER YOUR GAMEPLAY OR DEMOS. SMALL SAMPLES ARE SIGNALS, NOT PROOF.";
    } catch { return; /* keep the in-browser fallback */ }
    try { renderMatch(await getJson(MATCH_ENDPOINT)); } catch { renderMatch(null); }
  }

  function render(detail) {
    const body = document.getElementById("coach-body");
    if (!body || serverLoaded) return;
    body.innerHTML = renderInsights(computeInsights(detail && detail.matches, detail));
  }

  if (typeof document !== "undefined") {
    document.addEventListener("kiyosei:data", (e) => { render(e.detail); });
    loadServer();
    window.KiyoseiCoach = { renderReport, computeInsights };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { computeInsights, summarize };
})();
