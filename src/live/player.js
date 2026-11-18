// Identifies the tracked FACEIT player once and persists the GUID in the existing
// sync_state table. Matches are attributed to this ID only.
const { pool } = require("../db");
const { faceitGet } = require("../faceit");

const KEY = "faceit_player";
let cached = null;

const nickname = () => process.env.FACEIT_NICKNAME || "kiyosei";

async function getTrackedPlayer({ force = false } = {}) {
  if (process.env.FACEIT_PLAYER_ID) return { playerId: process.env.FACEIT_PLAYER_ID, nickname: nickname(), source: "env" };
  if (cached && !force && cached.nickname === nickname()) return cached;
  const stored = (await pool.query("SELECT value FROM sync_state WHERE key = $1", [KEY])).rows[0]?.value;
  if (stored && stored.playerId && stored.nickname === nickname() && !force) {
    cached = { ...stored, source: "database" };
    return cached;
  }
  // Same documented lookup the rest of the app uses (GET /players?nickname=&game=).
  const player = await faceitGet(`/players?nickname=${encodeURIComponent(nickname())}&game=cs2`);
  if (!player || !player.player_id) throw new Error("FACEIT did not return a player ID for the configured nickname.");
  const value = { playerId: player.player_id, nickname: nickname(), resolvedAt: new Date().toISOString() };
  await pool.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [KEY, JSON.stringify(value)]);
  cached = { ...value, source: "faceit-api" };
  return cached;
}

const peekCached = () => (process.env.FACEIT_PLAYER_ID ? { playerId: process.env.FACEIT_PLAYER_ID, source: "env" } : cached);
const resetCache = () => { cached = null; };

module.exports = { getTrackedPlayer, peekCached, resetCache };
