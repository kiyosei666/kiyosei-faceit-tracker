const getApiBase = () => process.env.FACEIT_API_BASE || "https://open.faceit.com/data/v4";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function friendlyMessage(status) {
  return status === 401 ? "FACEIT rejected the API key."
    : status === 403 ? "FACEIT denied access to this API resource."
    : status === 429 ? "FACEIT rate limit reached. Try again shortly."
    : `FACEIT API returned HTTP ${status}.`;
}

/**
 * Validates and normalizes timeout duration in milliseconds.
 * Safe fallback: 10,000ms if null, undefined, <= 0, NaN, or non-finite.
 */
function normalizeTimeoutMs(value) {
  const n = Number(value !== undefined && value !== null ? value : process.env.FACEIT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

// Retries only transient failures (429, 5xx, timeouts, network errors) with
// exponential backoff. 4xx errors such as 401/403/404 fail immediately.
async function faceitGet(endpoint, { retries = 3, baseDelayMs = 800, timeoutMs } = {}) {
  const effectiveTimeout = normalizeTimeoutMs(timeoutMs);
  if (!process.env.FACEIT_API_KEY) {
    const error = new Error("FACEIT_API_KEY is not configured on the server.");
    error.status = 503;
    throw error;
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const signal = typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(effectiveTimeout)
        : undefined;

      const response = await fetch(`${getApiBase()}${endpoint}`, {
        headers: { Authorization: `Bearer ${process.env.FACEIT_API_KEY}`, Accept: "application/json" },
        signal
      });
      if (response.ok) return await response.json();
      const error = new Error(friendlyMessage(response.status));
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      const retryAfter = Number(response.headers.get("retry-after"));
      error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
      lastError = error;
    } catch (error) {
      if (error.status && error.status < 500 && error.status !== 429) throw error;
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        error.isTimeout = true;
        error.message = `FACEIT request timed out after ${effectiveTimeout}ms.`;
      }
      lastError = error;
    }
    if (attempt < retries) {
      await sleep(lastError.retryAfterMs ?? baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function getPlayerOutcome(match, playerId) {
  if (!match || typeof match !== "object" || !playerId) return "Unknown";
  const winner = match.results?.winner == null ? "" : String(match.results.winner);
  const teams = match.teams && typeof match.teams === "object" ? match.teams : {};
  const targetId = String(playerId);
  for (const [teamName, team] of Object.entries(teams)) {
    const members = [
      ...(Array.isArray(team?.players) ? team.players : []),
      ...(Array.isArray(team?.roster) ? team.roster : [])
    ];
    const isPlayerOnTeam = members.some((member) =>
      member && member.player_id != null && String(member.player_id) === targetId
    );
    if (isPlayerOnTeam) {
      if (!winner) return "Unknown";
      return winner === String(teamName) || winner === String(team?.team_id) ? "Win" : "Loss";
    }
  }
  return "Unknown";
}
/**
 * Hardened match stats extraction from FACEIT API response.
 * Handles missing rounds, non-array structures, null elements, and empty/invalid player_stats.
 */
function getPlayerMatchStats(data, playerId, nickname) {
  if (!data || typeof data !== "object") {
    return { stats: null, map: null, score: null };
  }

  const rounds = Array.isArray(data.rounds) ? data.rounds : [];
  const round = rounds[0];
  if (!round || typeof round !== "object") {
    return { stats: null, map: null, score: null };
  }

  const teams = Array.isArray(round.teams) ? round.teams : [];
  let found = null;

  for (const team of teams) {
    if (!team || typeof team !== "object") continue;
    const players = Array.isArray(team.players) ? team.players : [];
    for (const player of players) {
      if (!player || typeof player !== "object") continue;
      const matchId = player.player_id && player.player_id === playerId;
      const matchNick = nickname && typeof player.nickname === "string" &&
        player.nickname.toLowerCase() === nickname.toLowerCase();
      if (matchId || matchNick) {
        found = player;
        break;
      }
    }
    if (found) break;
  }

  const scoreList = teams
    .map((team) => team?.team_stats?.["Final Score"])
    .filter(Boolean);
  const score = scoreList.length ? scoreList.join("-") : null;
  const map = typeof round.round_stats?.Map === "string" ? round.round_stats.Map : null;

  // Validate player_stats is a non-null, non-array object with at least one key
  const rawStats = found?.player_stats;
  const isValidStats = rawStats &&
    typeof rawStats === "object" &&
    !Array.isArray(rawStats) &&
    Object.keys(rawStats).length > 0;

  return {
    stats: isValidStats ? rawStats : null,
    map,
    score
  };
}

/**
 * Shared classification helper for match statistics.
 * Ensures consistent behavior across sync.js and tracker.js:
 * - Confirmed HTTP 404: 'unavailable' (stats = null)
 * - Non-empty valid stats: 'available' (stats populated)
 * - Empty {}, missing, or malformed stats on HTTP 200: 'pending' (stats = null)
 */
function classifyMatchStats(parsed, error = null) {
  if (error) {
    if (error.status === 404) {
      return { stats: null, map: null, score: null, status: "unavailable" };
    }
    // Transient or other error
    throw error;
  }

  const stats = parsed?.stats || null;
  const isValid = stats && typeof stats === "object" && !Array.isArray(stats) && Object.keys(stats).length > 0;

  return {
    stats: isValid ? stats : null,
    map: parsed?.map || null,
    score: parsed?.score || null,
    status: isValid ? "available" : "pending"
  };
}

module.exports = {
  faceitGet,
  getPlayerOutcome,
  getPlayerMatchStats,
  classifyMatchStats,
  normalizeTimeoutMs
};
