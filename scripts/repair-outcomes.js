#!/usr/bin/env node
/**
 * Repairs matches stored with a win/loss result of "Unknown".
 *
 *   Dry run, saved stats only (no FACEIT calls):  node scripts/repair-outcomes.js
 *   Dry run + FACEIT history cross-check:         node scripts/repair-outcomes.js --history
 *   Save the changes (only after review):         add --apply
 *
 * Environment:  DATABASE_URL (required)
 *               FACEIT_API_KEY (required with --history)   FACEIT_NICKNAME (default "kiyosei")
 *               DATABASE_SSL=disable (local databases only)
 *               DELAY_MS (default 400)  MAX_PAGES (default 80)  BACKUP_DIR (default: current folder)
 *
 * Safety
 *  - Without --apply the whole run happens inside a READ ONLY transaction: it cannot write.
 *  - It only ever changes the `outcome` column, only on rows where it is exactly "Unknown",
 *    and only when the answer is definite.
 *  - If saved stats and FACEIT history DISAGREE for a match, that match is left alone.
 *  - Before saving, it writes a backup CSV (match_id, old, new, source) and aborts if it cannot.
 *  - Saving runs in one transaction: all changes or none.
 *  - It never prints the database password or the FACEIT key.
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { faceitGet, getPlayerOutcome, outcomeFromPlayerStats } = require("../src/faceit");

const APPLY = process.argv.includes("--apply");
const USE_HISTORY = process.argv.includes("--history");
const NICK = process.env.FACEIT_NICKNAME || "kiyosei";
const GAME = "cs2";
const PAGE_SIZE = 100;
const MAX_PAGES = Number(process.env.MAX_PAGES) || 80;
const DELAY = Number(process.env.DELAY_MS) || 400;
const BACKUP_DIR = process.env.BACKUP_DIR || process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL first."); process.exit(1); }
if (USE_HISTORY && !process.env.FACEIT_API_KEY) { console.error("--history needs FACEIT_API_KEY."); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  max: 1
});

const parseStats = (v) => {
  if (!v) return null;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return typeof v === "object" ? v : null;
};
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return "(unreadable address)"; } };
const line = (s = "") => console.log(s);

async function readHistory(unknownIds, report) {
  const lookup = await faceitGet(`/players?nickname=${encodeURIComponent(NICK)}&game=${GAME}`);
  const playerId = lookup.player_id;
  const found = new Map();            // match_id -> "Win" | "Loss"   (definite answers only)
  const seenUnknownIds = new Set();   // unknown rows that appeared in history at all
  const fieldNames = new Set();
  let cursor = null, pages = 0, stalls = 0, items = 0;
  while (pages < MAX_PAGES) {
    const q = `/players/${playerId}/history?game=${GAME}&limit=${PAGE_SIZE}` + (cursor ? `&to=${cursor}` : "&offset=0");
    await sleep(DELAY);
    const history = await faceitGet(q);
    const list = history.items || [];
    pages++;
    if (!list.length) break;
    items += list.length;
    for (const item of list) {
      for (const team of Object.values(item.teams || {})) Object.keys(team || {}).forEach((k) => fieldNames.add(k));
      if (!unknownIds.has(item.match_id)) continue;
      seenUnknownIds.add(item.match_id);
      const o = getPlayerOutcome(item, playerId);
      if (o !== "Unknown") found.set(item.match_id, o);
    }
    if (seenUnknownIds.size === unknownIds.size) break;       // everything we needed has been seen
    const stamps = list.map((i) => Number(i.started_at || i.finished_at)).filter(Number.isFinite);
    const oldest = stamps.length ? Math.min(...stamps) : null;
    if (oldest === null) break;
    if (cursor !== null && oldest >= cursor) { stalls++; cursor -= 1; if (stalls > 5) break; }
    else { stalls = 0; cursor = oldest; }
  }
  Object.assign(report, { pages, items, fieldNames: [...fieldNames].sort(), seenInHistory: seenUnknownIds.size });
  return found;
}

async function main() {
  line(APPLY ? "MODE: APPLY (changes will be saved)" : "MODE: DRY RUN (read-only, nothing can be changed)");
  line(`Database host: ${hostOf(process.env.DATABASE_URL)}`);
  line(`FACEIT history check: ${USE_HISTORY ? "ON" : "off (saved stats only)"}`);

  const client = await pool.connect();
  let unknown, totals;
  try {
    await client.query("BEGIN READ ONLY");
    unknown = (await client.query("SELECT match_id, stats, stats_status FROM faceit_matches WHERE outcome = 'Unknown'")).rows;
    totals = (await client.query(
      "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE outcome='Win')::int AS wins, COUNT(*) FILTER (WHERE outcome='Loss')::int AS losses FROM faceit_matches")).rows[0];
    await client.query("ROLLBACK");
  } finally { client.release(); }

  line("\n1. CURRENT STATE");
  line(`   Matches stored: ${totals.total}   Win: ${totals.wins}   Loss: ${totals.losses}   Unknown: ${unknown.length}`);
  if (!unknown.length) { line("\n   Nothing to repair."); return; }

  // ---- Route A: saved stats ----------------------------------------------
  line("\n2. ROUTE A – result flag inside your saved match stats (no FACEIT calls)");
  const fromStats = new Map();
  const resultValues = new Map();
  let withStats = 0, withResultKey = 0;
  for (const row of unknown) {
    const stats = parseStats(row.stats);
    if (!stats) continue;
    withStats++;
    if (Object.prototype.hasOwnProperty.call(stats, "Result")) {
      withResultKey++;
      const v = String(stats.Result);
      resultValues.set(v, (resultValues.get(v) || 0) + 1);
    }
    const o = outcomeFromPlayerStats(stats);
    if (o !== "Unknown") fromStats.set(row.match_id, o);
  }
  line(`   Unknown rows that have saved stats: ${withStats}  (no stats: ${unknown.length - withStats})`);
  line(`   ...of those, stats contain a "Result" field: ${withResultKey}`);
  if (resultValues.size) line(`   "Result" values found: ${[...resultValues].map(([k, n]) => `"${k}" × ${n}`).join(", ")}`);
  if (withStats && !withResultKey) {
    const sample = parseStats(unknown.find((r) => parseStats(r.stats)).stats);
    line(`   No "Result" field. Saved stat fields look like: ${Object.keys(sample).join(", ")}`);
  }
  line(`   Route A can fix: ${fromStats.size}`);

  // ---- Route B: FACEIT history -------------------------------------------
  let fromHistory = new Map();
  const hist = {};
  if (USE_HISTORY) {
    line("\n3. ROUTE B – FACEIT match history (read-only requests)");
    fromHistory = await readHistory(new Set(unknown.map((r) => r.match_id)), hist);
    line(`   History pages read: ${hist.pages}   history entries seen: ${hist.items}`);
    line(`   Team fields in history entries: ${hist.fieldNames.join(", ") || "(none)"}`);
    line(`   Unknown rows found in history: ${hist.seenInHistory} of ${unknown.length}`);
    line(`   Route B can fix: ${fromHistory.size}`);
  }

  if (!USE_HISTORY) line("\n3. ROUTE B – skipped (add --history to cross-check against FACEIT)");

  // ---- Decide -------------------------------------------------------------
  const plan = new Map();             // match_id -> { outcome, source }
  const conflicts = [];
  let both = 0, bothAgree = 0, onlyA = 0, onlyB = 0, neither = 0;
  for (const row of unknown) {
    const a = fromStats.get(row.match_id), b = fromHistory.get(row.match_id);
    if (a && b) {
      both++;
      if (a === b) { bothAgree++; plan.set(row.match_id, { outcome: a, source: "both" }); }
      else conflicts.push({ id: row.match_id, a, b });
    } else if (a) { onlyA++; plan.set(row.match_id, { outcome: a, source: "stats" }); }
    else if (b) { onlyB++; plan.set(row.match_id, { outcome: b, source: "history" }); }
    else neither++;
  }
  const wins = [...plan.values()].filter((p) => p.outcome === "Win").length;
  const losses = plan.size - wins;

  line("\n4. PLAN");
  if (USE_HISTORY) {
    line(`   Both routes answered and AGREE:   ${bothAgree}`);
    line(`   Both routes answered and DISAGREE: ${conflicts.length}   (left alone)`);
    line(`   Only saved stats answered:         ${onlyA}`);
    line(`   Only FACEIT history answered:      ${onlyB}`);
  } else {
    line(`   Fixable from saved stats:          ${onlyA}`);
  }
  line(`   Cannot be determined (stay Unknown): ${neither}`);
  line(`   TOTAL that would be set: ${plan.size}  (${wins} wins, ${losses} losses)`);
  const allW = totals.wins + wins, allL = totals.losses + losses;
  if (allW + allL) line(`   Overall win rate after repair: ${((allW / (allW + allL)) * 100).toFixed(1)}%  (${allW}W / ${allL}L)`);
  if (conflicts.length) {
    line("   Conflicts (first 10):");
    conflicts.slice(0, 10).forEach((c) => line(`     ${c.id}: stats say ${c.a}, history says ${c.b}`));
  }

  if (!APPLY) { line("\nDRY RUN COMPLETE. Nothing was changed. (--apply is not used.)"); return; }

  // ---- Apply --------------------------------------------------------------
  if (!plan.size) { line("\nNothing to save."); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `outcome-repair-backup-${stamp}.csv`);
  const csv = ["match_id,old_outcome,new_outcome,source", ...[...plan].map(([id, p]) => `${id},Unknown,${p.outcome},${p.source}`)].join("\n");
  fs.writeFileSync(backupPath, csv + "\n", { flag: "wx" });          // aborts if it cannot be written
  line(`\nBackup written: ${backupPath} (${plan.size} rows)`);

  const w = await pool.connect();
  try {
    await w.query("BEGIN");
    let changed = 0;
    for (const [id, p] of plan) {
      const r = await w.query("UPDATE faceit_matches SET outcome = $1 WHERE match_id = $2 AND outcome = 'Unknown'", [p.outcome, id]);
      changed += r.rowCount;
    }
    await w.query("COMMIT");
    line(`Saved: ${changed} matches updated${changed === plan.size ? "." : ` (planned ${plan.size}; some rows changed since the plan was made).`}`);
    line("To undo: set outcome back to 'Unknown' for the match_ids in the backup file.");
  } catch (e) {
    await w.query("ROLLBACK");
    throw e;
  } finally { w.release(); }
}

main().catch((e) => { console.error("Repair failed:", e.message); process.exitCode = 1; }).finally(() => pool.end());
