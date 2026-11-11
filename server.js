const express = require("express");
const path = require("path");
const { pool, ensureSchema } = require("./src/db");
const { faceitGet, getPlayerOutcome } = require("./src/faceit");
const { persistMatches, readTrackingData } = require("./src/tracker");
const { syncRecent, importCareer, syncStatus } = require("./src/sync");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const PLAYER_NICKNAME = process.env.FACEIT_NICKNAME || "kiyosei";
const GAME_ID = "cs2";

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (_req, res) => {
  let database = false;
  let databaseError = null;
  try {
    database = await ensureSchema();
    if (database) await pool.query("SELECT 1");
  } catch (error) {
    databaseError = error.message;
    console.error("Database health check:", error.message);
  }
  res.json({
    ok: true,
    configured: Boolean(process.env.FACEIT_API_KEY),
    databaseConfigured: database,
    ...(databaseError ? { databaseError } : {})
  });
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
    let tracking = { configured: false, saved: 0 };
    try {
      tracking = await persistMatches(history.items || [], playerId, player.nickname || PLAYER_NICKNAME, game.faceit_elo);
    } catch (error) {
      console.error("Match history sync failed:", error.message);
    }
    res.json({
      player: { nickname: player.nickname, playerId, avatar: player.avatar || null,
        country: player.country || null, elo: game.faceit_elo ?? null,
        skillLevel: game.skill_level ?? null,
        faceitUrl: `https://www.faceit.com/en/players/${encodeURIComponent(player.nickname)}` },
      lifetime: stats?.lifetime || {},
      matches: (history.items || []).map((match) => ({
        id: match.match_id, date: match.finished_at || match.started_at || null,
        outcome: getPlayerOutcome(match, playerId),
        map: match.map || match.competition_name || "FACEIT match"
      })),
      tracking
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Unable to load FACEIT data." });
  }
});

app.get("/api/history", async (_req, res) => {
  try {
    res.json(await readTrackingData());
  } catch (error) {
    console.error("History read failed:", error.message);
    res.status(500).json({ error: "Could not read saved match history." });
  }
});


// Protects write/trigger endpoints. The scheduler sends the shared secret.
function requireSecret(req, res, next) {
  const expected = process.env.SYNC_SECRET;
  if (!expected) return res.status(503).json({ error: "SYNC_SECRET is not configured on the server." });
  const given = String(req.get("x-sync-secret") || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized." });
  next();
}
const fail = (res, error) => res.status(error.status || 500).json({ error: error.message || "Request failed." });

app.get("/api/sync/status", async (_req, res) => {
  try { res.json(await syncStatus()); } catch (e) { fail(res, e); }
});
app.post("/api/sync", requireSecret, async (_req, res) => {
  try { res.json(await syncRecent()); } catch (e) { fail(res, e); }
});
app.post("/api/career/import", requireSecret, async (req, res) => {
  try { res.json(await importCareer({ maxPages: Math.min(Number(req.query.pages) || 5, 20) })); } catch (e) { fail(res, e); }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Kiyosei FACEIT Tracker listening on port ${PORT}`));
