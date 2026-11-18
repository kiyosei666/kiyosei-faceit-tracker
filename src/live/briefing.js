// On-demand Gemini briefing for an active FACEIT match.
// Uses only the deterministic stats engine and documented FACEIT match metadata.
const coach = require("../coach");
const stats = require("../stats/service");

const cache = new Map();
const inflight = new Map();
const MAX_CACHE = 20;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    mapPlan: { type: "STRING" },
    strengthsToLeanOn: { type: "ARRAY", items: { type: "STRING" } },
    threatsToWatch: { type: "ARRAY", items: { type: "STRING" } },
    personalFocus: { type: "ARRAY", items: { type: "STRING" } },
    confidenceNotes: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["headline", "mapPlan", "strengthsToLeanOn", "threatsToWatch", "personalFocus", "confidenceNotes"]
};

const SYSTEM = [
  "You are Kiyosei, a direct CS2 pre-match analyst.",
  "Use only the supplied player statistics and FACEIT match metadata.",
  "Never invent player statistics, opponent tendencies, map tactics, roles, ranks, or numbers.",
  "Separate known facts from cautious hypotheses. If opponent history or useful map data is absent, say so explicitly.",
  "Do not claim to see live gameplay, positions, crosshair placement, utility, rounds, or the game screen.",
  "Give practical high-level map preparation, not fabricated site-specific opponent tendencies.",
  "Do not invent numeric values. Keep each item concise and actionable."
].join("\n");

function teamFacts(teams) {
  if (!teams || typeof teams !== "object") return { ourTeam: null, opponents: [] };
  const reduce = (t) => t ? ({
    name: t.name || null,
    rating: t.rating ?? null,
    averageSkillLevel: t.averageSkillLevel ?? null,
    winProbability: t.winProbability ?? null,
    players: (Array.isArray(t.players) ? t.players : []).map(p => ({
      nickname: p.nickname || null,
      skillLevel: p.skillLevel ?? null
    }))
  }) : null;
  return { ourTeam: reduce(teams.ours), opponents: (teams.opponents || []).map(reduce) };
}

async function generate(match) {
  if (!match || !match.match_id) {
    const e = new Error("No active FACEIT match is available yet."); e.status = 409; throw e;
  }
  const id = String(match.match_id);
  if (cache.has(id)) return cache.get(id);
  if (inflight.has(id)) return inflight.get(id);

  const job = (async () => {
    const analysis = await stats.getAnalysis();
    const playerFacts = coach.buildOverviewFacts(analysis);
    const currentMap = match.map || null;
    const mapHistory = currentMap ? playerFacts.maps.filter(m => String(m.map).toLowerCase() === String(currentMap).toLowerCase()) : [];
    const facts = {
      match: { map: currentMap, faceitStatus: match.status_raw || null, state: match.state },
      teams: teamFacts(match.teams),
      player: {
        sample: playerFacts.sample,
        overall: playerFacts.overall,
        role: playerFacts.role,
        mapHistory,
        relevantInsights: playerFacts.insights
      },
      dataLimits: [
        "No round-by-round telemetry or demo analysis is available.",
        "Opponent-specific historical statistics are not currently connected.",
        currentMap ? null : "FACEIT has not exposed the map for this match yet."
      ].filter(Boolean)
    };
    const user = "Create a pre-match briefing for this active FACEIT match. Prioritize the most useful, evidence-backed preparation. If the map is unknown, make that limitation clear.\nFACTS:\n" + JSON.stringify(facts);
    const result = await coach.callGemini({ system: SYSTEM, user, schema: SCHEMA });
    const briefing = result.json;
    for (const key of ["strengthsToLeanOn", "threatsToWatch", "personalFocus", "confidenceNotes"]) {
      if (!Array.isArray(briefing[key])) briefing[key] = [];
      briefing[key] = briefing[key].filter(x => typeof x === "string").slice(0, 4);
    }
    if (typeof briefing.headline !== "string" || typeof briefing.mapPlan !== "string") {
      throw new Error("Gemini returned an incomplete live briefing.");
    }
    const response = { status: "generated", matchId: id, map: currentMap, model: result.model, generatedAt: new Date().toISOString(), briefing };
    cache.set(id, response);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return response;
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

module.exports = { generate };
