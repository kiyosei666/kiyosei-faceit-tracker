// Database access for the stats engine. READ-ONLY: only SELECT queries run here.
const { pool, ensureSchema } = require("../db");
const { analyze, analyzeMatch } = require("./engine");
const { inventory } = require("./keys");

const TTL_MS = 60 * 1000;
let cache = { at: 0, rows: null, loading: null };

async function loadRows() {
  if (!(await ensureSchema())) { const e = new Error("Database is not configured."); e.status = 503; throw e; }
  if (cache.rows && Date.now() - cache.at < TTL_MS) return cache.rows;
  if (cache.loading) return cache.loading;
  cache.loading = pool.query("SELECT match_id, finished_at, map, outcome, score, stats, stats_status FROM faceit_matches")
    .then((r) => { cache = { at: Date.now(), rows: r.rows, loading: null }; return r.rows; })
    .catch((e) => { cache.loading = null; throw e; });
  return cache.loading;
}

async function getAnalysis() { return analyze(await loadRows()); }
async function getInventory() { return inventory(await loadRows()); }
async function getMatchAnalysis(matchId) {
  const rows = await loadRows();
  if (matchId === "latest") {
    const { normalizeMatch } = require("./engine");
    const newest = rows.map(normalizeMatch).filter((x) => x.time !== null).sort((a, b) => b.time - a.time)[0];
    if (!newest) return null;
    matchId = newest.id;
  }
  return analyzeMatch(rows, matchId);
}
function invalidate() { cache = { at: 0, rows: null, loading: null }; }

module.exports = { getAnalysis, getInventory, getMatchAnalysis, loadRows, invalidate };
