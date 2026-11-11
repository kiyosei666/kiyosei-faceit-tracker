#!/usr/bin/env node
/*
 * READ-ONLY validation of the FACEIT Data API for the career importer.
 * - Sends GET requests only. No database access. Writes only ./validation-report.json.
 * - Never prints or stores the API key.
 *
 * Usage (from the repo root):
 *   FACEIT_API_KEY=your_key node scripts/validate-faceit.js
 * Optional: FACEIT_NICKNAME=kiyosei  MAX_PAGES=100  DELAY_MS=300
 */
const fs = require("fs");
const { faceitGet } = require("../src/faceit");

const NICK = process.env.FACEIT_NICKNAME || "kiyosei";
const GAME = "cs2";
const LIMIT = 100;
const MAX_PAGES = Number(process.env.MAX_PAGES) || 100;
const DELAY = Number(process.env.DELAY_MS) || 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { generatedAt: new Date().toISOString(), nickname: NICK, game: GAME, requests: 0, checks: {} };

async function get(path) {
  report.requests++;
  await sleep(DELAY);
  return faceitGet(path);
}
async function attempt(name, fn) {
  try { report.checks[name] = { ok: true, ...(await fn()) }; }
  catch (e) { report.checks[name] = { ok: false, status: e.status || null, error: e.message }; }
  console.log(`${report.checks[name].ok ? "OK  " : "FAIL"} ${name}`);
}
function scanKeys(obj, re, path = "", out = []) {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (re.test(k)) out.push({ path: p, value: v && typeof v === "object" ? "[object]" : v });
      scanKeys(v, re, p, out);
    }
  }
  return out;
}
const PEAK_RE = /peak|season|highest|best.?elo|max.?elo|all.?time/i;
const ts = (m) => Number(m.started_at ?? m.finished_at);
const ids = (items) => items.map((m) => m.match_id);

(async () => {
  let player, playerId, region;
  await attempt("player_lookup", async () => {
    player = await get(`/players?nickname=${encodeURIComponent(NICK)}&game=${GAME}`);
    playerId = player.player_id; const g = player.games?.[GAME] || {}; region = g.region;
    return { playerFound: Boolean(playerId), elo: g.faceit_elo ?? null, skillLevel: g.skill_level ?? null, region: region ?? null,
      topLevelKeys: Object.keys(player), gameKeys: Object.keys(g),
      peakOrSeasonFields: scanKeys(player, PEAK_RE) };
  });
  if (!playerId) return finish();

  await attempt("lifetime_stats", async () => {
    const s = await get(`/players/${playerId}/stats/${GAME}`);
    const lifetime = s.lifetime || {};
    return { lifetimeKeys: Object.keys(lifetime), lifetimeMatches: lifetime.Matches ?? null,
      peakOrSeasonFields: scanKeys(s, PEAK_RE), segmentCount: (s.segments || []).length };
  });

  await attempt("game_skill_levels", async () => {
    const g = await get(`/games/${GAME}`);
    return { regions: g.regions ? Object.keys(g.regions) : null, skillLevels: g.skill_levels || null,
      peakOrSeasonFields: scanKeys(g, PEAK_RE) };
  });

  await attempt("ranking_endpoint", async () => {
    if (!region) throw new Error("no region on player profile");
    const r = await get(`/rankings/games/${GAME}/regions/${encodeURIComponent(region)}/players/${playerId}?limit=1`);
    return { keys: Object.keys(r), peakOrSeasonFields: scanKeys(r, PEAK_RE), position: r.position ?? null };
  });

  await attempt("games_stats_endpoint", async () => {
    const r = await get(`/players/${playerId}/games/${GAME}/stats?limit=${LIMIT}&offset=0`);
    const first = r.items?.[0]?.stats || {};
    return { itemCount: (r.items || []).length, statKeys: Object.keys(first), peakOrSeasonFields: scanKeys(first, /elo|season|peak/i) };
  });

  // ---- Pagination: offset walk (first 1000), then probe beyond ----
  const offsetItems = []; let offsetFailedAt = null;
  await attempt("offset_pagination", async () => {
    for (let off = 0; off < 1000; off += LIMIT) {
      const r = await get(`/players/${playerId}/history?game=${GAME}&offset=${off}&limit=${LIMIT}`);
      if (!(r.items || []).length) break;
      offsetItems.push(...r.items);
      if (r.items.length < LIMIT) break;
    }
    const probes = {};
    for (const off of [1000, 1100, 2000]) {
      try { const r = await get(`/players/${playerId}/history?game=${GAME}&offset=${off}&limit=${LIMIT}`); probes[off] = { status: 200, items: (r.items || []).length }; }
      catch (e) { probes[off] = { status: e.status || null, error: e.message }; offsetFailedAt = offsetFailedAt ?? off; }
    }
    return { itemsWalked: offsetItems.length, beyond1000: probes };
  });

  // ---- Pagination: timestamp cursor walk ----
  const walk = []; const pageLog = [];
  await attempt("timestamp_pagination", async () => {
    let cursor = null, prevIds = new Set(), stalled = false, hitMax = true;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = `/players/${playerId}/history?game=${GAME}&limit=${LIMIT}` + (cursor ? `&to=${cursor}` : "&offset=0");
      const r = await get(q); const items = r.items || [];
      if (!items.length) { hitMax = false; break; }
      const t = items.map(ts).filter(Number.isFinite);
      const overlap = items.filter((m) => prevIds.has(m.match_id)).length;
      const boundaryRepeated = cursor ? items.some((m) => ts(m) === Number(cursor)) : false;
      pageLog.push({ page, cursorIn: cursor, count: items.length, newest: Math.max(...t), oldest: Math.min(...t),
        overlapWithPreviousPage: overlap, boundaryMatchRepeated: boundaryRepeated,
        sortedNewestFirst: t.every((v, i) => i === 0 || t[i - 1] >= v) });
      walk.push(...items);
      prevIds = new Set(ids(items));
      const next = Math.min(...t);
      if (cursor && next >= Number(cursor)) { stalled = true; hitMax = false; break; }
      cursor = next;
      if (items.length < LIMIT) { hitMax = false; break; }
    }
    const uniq = new Set(ids(walk));
    const oldest = [...walk].sort((a, b) => ts(a) - ts(b))[0];
    return { pages: pageLog.length, totalItems: walk.length, uniqueMatches: uniq.size, duplicatesAcrossPages: walk.length - uniq.size,
      cursorStalled: stalled, stoppedBecauseMaxPages: hitMax,
      oldestAccessibleMatch: oldest ? { match_id: oldest.match_id, started_at: oldest.started_at ?? null,
        finished_at: oldest.finished_at ?? null, iso: new Date(ts(oldest) * 1000).toISOString() } : null,
      pageLog };
  });

  // ---- Cross-checks ----
  await attempt("cross_checks", async () => {
    const walkIds = new Set(ids(walk));
    const firstK = offsetItems.map((m) => m.match_id);
    const missingFromTimestampWalk = firstK.filter((id) => !walkIds.has(id)).length;
    const raw = report.checks.lifetime_stats?.lifetimeMatches;
    const lt = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    return { offsetMatchesMissingFromTimestampWalk: missingFromTimestampWalk,
      lifetimeMatchesStat: Number.isFinite(lt) ? lt : null, uniqueMatchesImportable: walkIds.size,
      historyCoversLifetime: Number.isFinite(lt) ? walkIds.size >= lt : null,
      note: "If importable < lifetime, FACEIT history does not expose every match (older matches may be unavailable)." };
  });

  // ---- Interruption recovery: resume from a saved cursor mid-walk ----
  await attempt("interruption_recovery", async () => {
    if (pageLog.length < 3) return { skipped: true, reason: "fewer than 3 pages available" };
    const savedCursor = pageLog[2].cursorIn; // what the importer would have persisted after page 2
    const expected = []; for (const [i, p] of pageLog.entries()) if (i >= 2) expected.push(p.count);
    const r = await get(`/players/${playerId}/history?game=${GAME}&limit=${LIMIT}&to=${savedCursor}`);
    const resumedIds = ids(r.items || []);
    const original = walk.slice(200, 200 + resumedIds.length).map((m) => m.match_id);
    return { resumedFromCursor: savedCursor, resumedPageSize: resumedIds.length, identicalToUninterruptedWalk: JSON.stringify(resumedIds) === JSON.stringify(original) };
  });

  // ---- Per-match stats availability: newest, evenly spaced, oldest ----
  await attempt("match_stats_availability", async () => {
    if (!walk.length) throw new Error("no matches walked");
    const sorted = [...walk].sort((a, b) => ts(b) - ts(a));
    const picks = [0, 0.25, 0.5, 0.75, 0.95, 1].map((f) => sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))]);
    const samples = [];
    for (const m of picks) {
      try {
        const s = await get(`/matches/${encodeURIComponent(m.match_id)}/stats`);
        const players = (s.rounds?.[0]?.teams || []).flatMap((t) => t.players || []);
        const me = players.find((p) => p.player_id === playerId);
        samples.push({ match_id: m.match_id, iso: new Date(ts(m) * 1000).toISOString(), status: 200, playerFound: Boolean(me),
          statKeys: me ? Object.keys(me.player_stats || {}) : null, eloFields: scanKeys(s, /elo/i).map((x) => x.path) });
      } catch (e) { samples.push({ match_id: m.match_id, iso: new Date(ts(m) * 1000).toISOString(), status: e.status || null, error: e.message }); }
    }
    return { samples };
  });

  finish();
})().catch((e) => { report.fatal = e.message; finish(); });

function finish() {
  const c = report.checks;
  const peakFields = [c.player_lookup, c.lifetime_stats, c.game_skill_levels, c.ranking_endpoint, c.games_stats_endpoint]
    .flatMap((x) => (x?.ok ? x.peakOrSeasonFields || [] : []));
  report.summary = {
    peakOrSeasonDataFoundInOfficialAPI: peakFields.length > 0,
    peakOrSeasonFieldsFound: peakFields,
    interpretation: peakFields.length
      ? "Fields matching peak/season were found. Inspect the values before treating them as peak ELO; a key name alone does not prove it."
      : "No peak ELO or season field appeared in any documented endpoint checked. Treat all-time and season peaks as UNAVAILABLE (not estimated)."
  };
  fs.writeFileSync("validation-report.json", JSON.stringify(report, null, 2));
  console.log(`\nRequests made: ${report.requests} (all GET, read-only)`);
  console.log(`Peak/season fields found: ${peakFields.length}`);
  console.log("Full results written to validation-report.json");
}
