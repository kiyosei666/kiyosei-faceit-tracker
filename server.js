const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://open.faceit.com/data/v4";
const PLAYER_NICKNAME = process.env.FACEIT_NICKNAME || "kiyosei";
const GAME_ID = "cs2";

app.use(express.static(path.join(__dirname, "public")));

async function faceitGet(endpoint) {
  if (!process.env.FACEIT_API_KEY) {
    const error = new Error("FACEIT_API_KEY is not configured on the server.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.FACEIT_API_KEY}`, Accept: "application/json" }
  });
  if (!response.ok) {
    const message = response.status === 401 ? "FACEIT rejected the API key."
      : response.status === 403 ? "FACEIT denied access to this API resource."
      : response.status === 429 ? "FACEIT rate limit reached. Try again shortly."
      : `FACEIT API returned HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.FACEIT_API_KEY) });
});

app.get("/api/player", async (_req, res) => {
  try {
    const player = await faceitGet(`/players?nickname=${encodeURIComponent(PLAYER_NICKNAME)}&game=${GAME_ID}`);
    const playerId = player.player_id;
    if (!playerId) throw new Error("FACEIT did not return a player ID for this nickname.");
    const [stats, history] = await Promise.all([
      faceitGet(`/players/${playerId}/stats/${GAME_ID}`).catch(() => null),
      faceitGet(`/players/${playerId}/history?game=${GAME_ID}&offset=0&limit=20`).catch(() => ({ items: [] }))
    ]);
    const game = player.games?.[GAME_ID] || {};
    const matches = (history.items || []).map((match) => {
      const teams = match.teams || {};
      const winner = match.results?.winner;
      let outcome = "Unknown";
      for (const [teamName, team] of Object.entries(teams)) {
        if ((team.roster || []).some((member) => member.player_id === playerId) && winner) {
          outcome = winner === teamName ? "Win" : "Loss";
        }
      }
      return { id: match.match_id, date: match.finished_at || match.started_at || null,
        outcome, map: match.map || match.competition_name || "FACEIT match" };
    });
    res.json({
      player: { nickname: player.nickname, playerId, avatar: player.avatar || null,
        country: player.country || null, elo: game.faceit_elo ?? null,
        skillLevel: game.skill_level ?? null,
        faceitUrl: `https://www.faceit.com/en/players/${encodeURIComponent(player.nickname)}` },
      lifetime: stats?.lifetime || {}, matches
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Unable to load FACEIT data." });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Kiyosei FACEIT Tracker listening on port ${PORT}`));
