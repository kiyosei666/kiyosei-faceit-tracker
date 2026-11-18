#!/usr/bin/env node
/**
 * READ-ONLY data-quality audit for the tracker database.
 *
 *   DATABASE_URL=postgres://... node scripts/audit-data.js
 *   (set DATABASE_SSL=disable only for a local database)
 *
 * Safety: runs inside a READ ONLY transaction, never runs migrations and never
 * writes. It does not call the FACEIT API. Prints findings; changes nothing.
 */
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL first (the same value your Render service uses).");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  max: 1
});

const out = [];
const ok = (m) => out.push(`  ✓ ${m}`);
const warn = (m) => out.push(`  ⚠ ${m}`);
const info = (m) => out.push(`    ${m}`);
const head = (m) => out.push(`\n${m}\n${"-".repeat(m.length)}`);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
const day = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString().slice(0, 10) : "n/a");

async function main() {
  const client = await pool.connect();
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  try {
    await client.query("BEGIN READ ONLY");

    // ---- 1. Overview ----------------------------------------------------
    head("1. MATCH HISTORY OVERVIEW");
    const [t] = await q(`SELECT COUNT(*)::int AS total, MIN(finished_at) AS first, MAX(finished_at) AS last,
      COUNT(*) FILTER (WHERE finished_at IS NULL)::int AS no_date FROM faceit_matches`);
    info(`Saved matches: ${t.total}   (first: ${day(t.first)}, latest: ${day(t.last)})`);
    if (!t.total) { warn("No matches saved at all."); }
    t.no_date ? warn(`${t.no_date} matches have no finish date (sort order unreliable).`) : ok("Every match has a finish date.");
    const [odd] = await q(`SELECT COUNT(*)::int AS n FROM faceit_matches
      WHERE finished_at IS NOT NULL AND (finished_at < 1325376000 OR finished_at > EXTRACT(EPOCH FROM NOW())::bigint + 86400)`);
    odd.n ? warn(`${odd.n} matches have an implausible date (before 2012 or in the future).`) : ok("No implausible dates.");
    for (const r of await q(`SELECT COALESCE(source,'live sync') AS src, COUNT(*)::int AS n FROM faceit_matches GROUP BY 1 ORDER BY 2 DESC`)) info(`Source "${r.src}": ${r.n}`);

    // ---- 2. Outcomes ----------------------------------------------------
    head("2. WIN / LOSS RESULTS");
    const outcomes = await q(`SELECT COALESCE(outcome,'(null)') AS o, COUNT(*)::int AS n FROM faceit_matches GROUP BY 1 ORDER BY 2 DESC`);
    outcomes.forEach((r) => info(`${r.o}: ${r.n} (${pct(r.n, t.total)})`));
    const unknown = outcomes.filter((r) => !["Win", "Loss"].includes(r.o)).reduce((a, r) => a + r.n, 0);
    unknown ? warn(`${unknown} matches (${pct(unknown, t.total)}) have no win/loss result. They break streaks and are excluded from win rate.`) : ok("All matches have a win/loss result.");

    // ---- 3. Detailed stats ---------------------------------------------
    head("3. DETAILED STATS (K/D, ADR, HS%)");
    for (const r of await q(`SELECT COALESCE(stats_status,'(null)') AS s, COUNT(*)::int AS n FROM faceit_matches GROUP BY 1 ORDER BY 2 DESC`)) info(`${r.s}: ${r.n} (${pct(r.n, t.total)})`);
    const [pend] = await q(`SELECT COUNT(*)::int AS n, MIN(finished_at) AS oldest FROM faceit_matches WHERE stats_status = 'pending'`);
    pend.n ? warn(`${pend.n} matches are stuck "pending" (oldest ${day(pend.oldest)}). The normal sync never retries them; only the career-import backfill does (50 per run).`) : ok("No matches waiting on stats.");
    const [thin] = await q(`SELECT COUNT(*)::int AS n FROM faceit_matches WHERE stats_status = 'available'
      AND (stats->>'Kills' IS NULL OR stats->>'Deaths' IS NULL OR stats->>'ADR' IS NULL)`);
    thin.n ? warn(`${thin.n} "available" matches lack Kills, Deaths or ADR.`) : ok("Every available match has Kills, Deaths and ADR.");

    // ---- 4. ELO per match ----------------------------------------------
    head("4. PER-MATCH ELO (drives the chart and the coach's ELO pace)");
    const [e] = await q(`SELECT COUNT(*) FILTER (WHERE elo_change IS NOT NULL)::int AS with_elo,
      COUNT(*) FILTER (WHERE elo_change IS NULL)::int AS without_elo FROM faceit_matches`);
    info(`With ELO change: ${e.with_elo} (${pct(e.with_elo, t.total)})   Without: ${e.without_elo}`);
    const [rec] = await q(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE elo_change IS NULL)::int AS missing
      FROM faceit_matches WHERE finished_at >= EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days')::bigint`);
    info(`Last 30 days: ${rec.n} matches, ${rec.missing} without ELO (${pct(rec.missing, rec.n)})`);
    e.without_elo ? warn(`${pct(e.without_elo, t.total)} of matches have no ELO change. ELO is only attributed when exactly one new match appeared between two syncs.`) : ok("Every match has an ELO change.");
    const [mismatch] = await q(`SELECT COUNT(*)::int AS n FROM faceit_matches
      WHERE elo_change IS NOT NULL AND elo_before IS NOT NULL AND elo_after IS NOT NULL AND elo_after - elo_before <> elo_change`);
    mismatch.n ? warn(`${mismatch.n} matches where elo_after − elo_before ≠ elo_change.`) : ok("elo_change always equals after − before.");
    const [wrongSign] = await q(`SELECT COUNT(*)::int AS n FROM faceit_matches
      WHERE (outcome='Win' AND elo_change < 0) OR (outcome='Loss' AND elo_change > 0)`);
    wrongSign.n ? warn(`${wrongSign.n} matches where the ELO change contradicts the result (win with negative ELO, or loss with positive).`) : ok("No win/loss result contradicts its ELO change.");
    const [zero] = await q(`SELECT COUNT(*)::int AS n FROM faceit_matches WHERE elo_change = 0`);
    zero.n ? warn(`${zero.n} matches recorded an ELO change of exactly 0. A decided match almost always moves ELO, so this usually means FACEIT's ELO had not updated yet when the match was saved.`) : ok("No matches recorded with a 0 ELO change.");
    const [big] = await q(`SELECT COUNT(*)::int AS n FROM faceit_matches WHERE ABS(elo_change) > 60`);
    big.n ? warn(`${big.n} matches changed ELO by more than 60. A single match is usually about ±15 to ±35, so these may span several matches.`) : ok("No single-match ELO change above 60.");
    const [chain] = await q(`SELECT COUNT(*)::int AS n FROM (
      SELECT elo_after, LEAD(elo_before) OVER (ORDER BY finished_at) AS next_before
      FROM faceit_matches WHERE elo_before IS NOT NULL AND elo_after IS NOT NULL) x
      WHERE next_before IS NOT NULL AND next_before <> elo_after`);
    chain.n ? info(`${chain.n} places where one match's ELO-after differs from the next match's ELO-before (normal if matches were skipped between them).`) : ok("ELO chain is continuous between consecutive attributed matches.");

    // ---- 5. Snapshots ---------------------------------------------------
    head("5. ELO SNAPSHOTS");
    const snaps = await q(`SELECT elo, captured_at FROM elo_snapshots ORDER BY captured_at, id`);
    info(`Snapshots: ${snaps.length}${snaps.length ? `   (first ${snaps[0].captured_at.toISOString().slice(0, 10)}, latest ${snaps[snaps.length - 1].captured_at.toISOString().slice(0, 10)})` : ""}`);
    snaps.length && snaps[0].elo === 1680 ? ok("Baseline snapshot (1,680) is present as the first point.") : warn("First snapshot is not the 1,680 baseline.");
    let jumps = 0, repeats = 0;
    for (let i = 1; i < snaps.length; i++) {
      if (Math.abs(snaps[i].elo - snaps[i - 1].elo) > 100) jumps++;
      if (snaps[i].elo === snaps[i - 1].elo) repeats++;
    }
    jumps ? warn(`${jumps} jumps of more than 100 ELO between consecutive snapshots (likely periods with no sync).`) : ok("No large jumps between snapshots.");
    repeats ? warn(`${repeats} consecutive snapshots with identical ELO.`) : ok("No duplicate consecutive snapshots.");

    // ---- 6. Gaps in coverage -------------------------------------------
    head("6. COVERAGE GAPS (days with no saved match)");
    const gaps = await q(`SELECT to_timestamp(prev)::date AS from_day, to_timestamp(finished_at)::date AS to_day,
        ROUND((finished_at - prev) / 86400.0, 1) AS days FROM (
        SELECT finished_at, LAG(finished_at) OVER (ORDER BY finished_at) AS prev FROM faceit_matches WHERE finished_at IS NOT NULL) g
      WHERE finished_at - prev > 3 * 86400 ORDER BY (finished_at - prev) DESC LIMIT 5`);
    gaps.length
      ? (warn("Longest gaps over 3 days (could be real breaks from playing, or missed syncs):"), gaps.forEach((g) => info(`${g.from_day.toISOString().slice(0, 10)} → ${g.to_day.toISOString().slice(0, 10)}  (${g.days} days)`)))
      : ok("No gap longer than 3 days.");

    // ---- 7. Sync health -------------------------------------------------
    head("7. SYNC HEALTH");
    const last = await q(`SELECT value, updated_at FROM sync_state WHERE key = 'last_success'`);
    last.length
      ? info(`Last successful scheduled/manual sync: ${last[0].updated_at.toISOString()} (${JSON.stringify(last[0].value)})`)
      : warn("No scheduled sync has ever succeeded (sync_state.last_success is empty). Matches are only saved when someone opens the site.");
    const runs = await q(`SELECT kind, status, started_at, matches_seen, matches_saved, error FROM sync_runs ORDER BY started_at DESC LIMIT 5`);
    runs.length ? runs.forEach((r) => info(`${r.started_at.toISOString().slice(0, 16)}  ${r.kind}  ${r.status}  seen ${r.matches_seen} saved ${r.matches_saved}${r.error ? "  ERROR: " + r.error : ""}`)) : info("No sync runs recorded.");
    const career = await q(`SELECT value FROM sync_state WHERE key = 'career_import'`);
    career.length ? info(`Career import: ${career[0].value.done ? "finished" : "NOT finished"} (${career[0].value.imported || 0} imported, ${career[0].value.pages || 0} pages)`) : warn("Career import has never been run.");

    // ---- 8. Peak --------------------------------------------------------
    head("8. ALL-TIME PEAK");
    const peak = await q(`SELECT elo, source FROM elo_records WHERE record_key='all_time_peak'`);
    const [mx] = await q(`SELECT GREATEST(COALESCE((SELECT MAX(elo) FROM elo_snapshots),0), COALESCE((SELECT MAX(elo_after) FROM faceit_matches),0)) AS m`);
    peak.length ? info(`Stored peak: ${peak[0].elo} (${peak[0].source}). Highest tracked value: ${mx.m}.`) : warn("No stored all-time peak record.");

    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`DATA QUALITY AUDIT  (${new Date().toISOString()})  read-only${out.join("\n")}\n`);
}

main().catch((e) => { console.error("Audit failed:", e.message); process.exit(1); });
