const API_BASE = process.env.FACEIT_API_BASE || "https://open.faceit.com/data/v4";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function friendlyMessage(status) {
  return status === 401 ? "FACEIT rejected the API key."
    : status === 403 ? "FACEIT denied access to this API resource."
    : status === 429 ? "FACEIT rate limit reached. Try again shortly."
    : `FACEIT API returned HTTP ${status}.`;
}

// Retries only transient failures (429, 5xx, timeouts, network errors) with
// exponential backoff. 4xx errors such as 401/403/404 fail immediately.
const getTimeoutMs = () => Number(process.env.FACEIT_TIMEOUT_MS) || 10000;

async function faceitGet(endpoint, { retries = 3, baseDelayMs = 800, timeoutMs } = {}) {
  const effectiveTimeout = timeoutMs || getTimeoutMs();
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

      const response = await fetch(`${API_BASE}${endpoint}`, {
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
      // Mark timeout/abort errors with clear message
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

module.exports = { faceitGet, getPlayerOutcome, getPlayerMatchStats };
