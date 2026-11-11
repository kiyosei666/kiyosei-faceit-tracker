const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://open.faceit.com/data/v4";
const PLAYER_NICKNAME = process.env.FACEIT_NICKNAME || "kiyosei";
const GAME_ID = "cs2";
const BASELINE_ELO = 1680;
const BASELINE_AT = "2026-11-11T00:00:00+08:00";

app.use(express.static(path.join(__dirname, "public")));

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

if (pool) {
  pool.on("error", (error) => console.error("Unexpected database pool error:", error.message));
}

let schemaReady = false;

async function ensureSchema() {
  if (!pool) return false;
  if (schemaReady) return true;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS elo_snapshots (
      id BIGSERIAL PRIMARY KEY,
      elo INTEGER NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS faceit_matches (
      match_id TEXT PRIMARY KEY,
      finished_at BIGINT,
      map TEXT,
      outcome TEXT,
      score TEXT,
      stats JSONB,
      elo_before INTEGER,
      elo_after INTEGER,
      elo_change INTEGER,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  schemaReady = true;
  return true;
}

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

function getPlayerOutcome(match, playerId) {
  const winner = match.results?.winner;
  for (const [teamName, team] of Object.entries(match.teams || {})) {
    if ((team.roster || []).some((member) => member.player_id === playerId)) {
      return winner ? (winner === teamName ? "Win" : "Loss") : "Unknown";
    }
  }
  return "Unknown";
}

function getPlayerMatchStats(data, playerId, nickname) {
  const round = data?.rounds?.[0];
  if (!round) return { stats: null, map: null, score: null };
  let found = null;
  for (const team of round.teams || []) {
    found = (team.players || []).find((player) =>
      player.player_id === playerId || player.nickname?.toLowerCase() === nickname.toLowerCase()
    );
    if (found) break;
  }
  const score = (round.teams || []).map((team) => team.team_stats?.["Final Score"]).filter(Boolean).join("-");
  return {
    stats: found?.player_stats || null,
    map: round.round_stats?.Map || null,
    score: score || null
  };
}

async function persistMatches(historyItems, playerId, nickname, currentElo) {
  if (!(await ensureSchema())) return { configured: false, saved: 0 };
  const latestSnapshot = await pool.query(
    "SELECT elo FROM elo_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1"
  );
  let previousElo = latestSnapshot.rows[0]?.elo ?? null;
  const isFirstSync = previousElo === null;

  if (isFirstSync) {
    await pool.query(
      "INSERT INTO elo_snapshots (elo, captured_at) VALUES ($1, $2)",
      [BASELINE_ELO, BASELINE_AT]
    );
    previousElo = BASELINE_ELO;
  }

  const known = await pool.query("SELECT match_id FROM faceit_matches");
  const knownIds = new Set(known.rows.map((row) => row.match_id));
  const newItems = (historyItems || []).filter((item) => item.match_id && !knownIds.has(item.match_id));
  const chronological = [...newItems].reverse();
  let saved = 0;

  for (let index = 0; index < chronological.length; index++) {
    const match = chronological[index];
    let matchStats = null;
    let matchMap = match.map || match.competition_name || "FACEIT match";
    let score = null;

    try {
      const statsData = await faceitGet(`/matches/${encodeURIComponent(match.match_id)}/stats`);
      const parsed = getPlayerMatchStats(statsData, playerId, nickname);
      matchStats = parsed.stats;
      matchMap = parsed.map || matchMap;
      score = parsed.score;
    } catch (error) {
      console.warn(`Could not fetch stats for match ${match.match_id}: ${error.message}`);
    }

    // FACEIT's public player-history response does not expose a dependable
    // per-match ELO delta. Attribute a delta only when exactly one new match
    // appeared between two known ELO snapshots.
    const canAttributeElo = !isFirstSync && chronological.length === 1 && Number.isFinite(Number(currentElo));
    const eloBefore = canAttributeElo ? previousElo : null;
    const eloAfter = canAttributeElo ? Number(currentElo) : null;
    const eloChange = canAttributeElo ? Number(currentElo) - previousElo : null;

    await pool.query(
      `INSERT INTO faceit_matches
        (match_id, finished_at, map, outcome, score, stats, elo_before, elo_after, elo_change)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (match_id) DO NOTHING`,
      [match.match_id, match.finished_at || match.started_at || null, matchMap,
       getPlayerOutcome(match, playerId), score, matchStats ? JSON.stringify(matchStats) : null,
       eloBefore, eloAfter, eloChange]
    );
    saved++;
  }

  const current = Number(currentElo);
  if (Number.isFinite(current)) {
    const last = await pool.query(
      "SELECT elo FROM elo_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1"
    );
    if (!last.rows.length || last.rows[0].elo !== current) {
      await pool.query("INSERT INTO elo_snapshots (elo) VALUES ($1)", [current]);
    }
  }
  return { configured: true, saved, firstSync: isFirstSync };
}

async function readTrackingData() {
  if (!(await ensureSchema())) return { configured: false, snapshots: [], matches: [] };
  const [snapshots, matches] = await Promise.all([
    pool.query("SELECT elo, captured_at FROM elo_snapshots ORDER BY captured_at ASC"),
    pool.query("SELECT match_id, finished_at, map, outcome, score, stats, elo_before, elo_after, elo_change FROM faceit_matches ORDER BY finished_at DESC NULLS LAST LIMIT 50")
  ]);
  return { configured: true, snapshots: snapshots.rows, matches: matches.rows };
}

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

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Kiyosei FACEIT Tracker listening on port ${PORT}`));
