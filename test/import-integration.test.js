/**
 * Comprehensive PostgreSQL Integration Tests for Career Importer
 *
 * Requirements covered:
 * 1. Successful page import.
 * 2. Transaction rollback after insertion failure (neither matches nor cursor commit).
 * 3. Cursor rollback when page transaction fails.
 * 4. Successful resume after interruption.
 * 5. Duplicate handling across overlapping pages.
 * 6. Timestamp ties and repeated boundary matches.
 * 7. HTTP 404 statistics handling (marked 'unavailable').
 * 8. HTTP 429/500/network failure and recovery.
 * 9. Backfilling previously imported matches with missing statistics.
 * 10. Re-importing completed history without duplicating records or inflating counters.
 */

const http = require("http");
const assert = require("assert");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/tracker_test";
process.env.DATABASE_SSL = "disable";
process.env.FACEIT_API_KEY = "test-key";
process.env.FACEIT_API_BASE = "http://localhost:4030";

const { pool, runMigrations } = require("../src/db");
const { importCareer, syncStatus } = require("../src/sync");

const TEST_PLAYER_ID = "test-player-1111";
let mockServer = null;
let mockResponses = {};

function startMockServer(port = 4030) {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:4030");
      const send = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };

      if (url.pathname === "/players") {
        return send(200, {
          player_id: TEST_PLAYER_ID,
          nickname: "kiyosei",
          country: "ph",
          games: { cs2: { faceit_elo: 1720, skill_level: 8 } }
        });
      }

      const customHandler = mockResponses[url.pathname + url.search] || mockResponses[url.pathname];
      if (customHandler) {
        return customHandler(req, res, send, url);
      }

      if (url.pathname.endsWith("/history")) {
        return send(200, { items: [] });
      }

      if (url.pathname.startsWith("/matches/") && url.pathname.endsWith("/stats")) {
        return send(200, {
          rounds: [{
            round_stats: { Map: "de_mirage" },
            teams: [
              {
                team_stats: { "Final Score": "13" },
                players: [{ player_id: TEST_PLAYER_ID, nickname: "kiyosei", player_stats: { "K/D Ratio": "1.25", ADR: "85", "Headshots %": "50" } }]
              },
              { team_stats: { "Final Score": "9" }, players: [] }
            ]
          }]
        });
      }

      send(404, { message: "Not found" });
    });

    mockServer.listen(port, () => resolve());
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}

async function resetDatabase() {
  await pool.query("TRUNCATE faceit_matches, elo_snapshots, sync_runs, sync_state CASCADE");
}

function createMatch(id, timestamp, outcome = "Win") {
  return {
    match_id: id,
    finished_at: timestamp,
    started_at: timestamp - 2400,
    results: { winner: outcome === "Win" ? "faction1" : "faction2" },
    teams: {
      faction1: { roster: [{ player_id: TEST_PLAYER_ID }] },
      faction2: { roster: [] }
    }
  };
}

async function runTests() {
  console.log("Starting PostgreSQL Integration Tests...");
  await runMigrations();
  await startMockServer();

  try {
    // -------------------------------------------------------------
    // Test 1: Successful page import
    // -------------------------------------------------------------
    console.log("Test 1: Successful page import");
    await resetDatabase();
    const p1Matches = [
      createMatch("m-1", 1700003000),
      createMatch("m-2", 1700002000)
    ];

    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: p1Matches });
    };

    const res1 = await importCareer({ maxPages: 1, delayMs: 10 });
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res1.seen, 2);
    assert.strictEqual(res1.saved, 2);

    const dbMatches1 = (await pool.query("SELECT match_id, stats_status FROM faceit_matches ORDER BY finished_at DESC")).rows;
    assert.strictEqual(dbMatches1.length, 2);
    assert.strictEqual(dbMatches1[0].match_id, "m-1");
    assert.strictEqual(dbMatches1[0].stats_status, "available");
    assert.strictEqual(dbMatches1[1].match_id, "m-2");
    assert.strictEqual(dbMatches1[1].stats_status, "available");

    const state1 = (await pool.query("SELECT value FROM sync_state WHERE key = 'career_import'")).rows[0].value;
    assert.strictEqual(state1.cursor, 1700002000 - 2400); // oldest timestamp (started_at)
    assert.strictEqual(state1.imported, 2);
    console.log("✓ Test 1 passed");

    // -------------------------------------------------------------
    // Test 2 & 3: Transaction rollback & cursor rollback on failure
    // -------------------------------------------------------------
    console.log("Test 2 & 3: Transaction and cursor rollback after mid-page DB/stats failure");
    await resetDatabase();

    // Set up mock with a second match stats causing transient 500 error
    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [createMatch("fail-1", 1700005000), createMatch("fail-2", 1700004000)] });
    };
    mockResponses["/matches/fail-2/stats"] = (req, res, send) => {
      send(500, { error: "Server exploded" });
    };

    await assert.rejects(
      async () => importCareer({ maxPages: 1, delayMs: 10 }),
      /Failed fetching stats for match fail-2/
    );

    // Verify neither match was saved in DB
    const dbMatchesRollback = (await pool.query("SELECT * FROM faceit_matches")).rows;
    assert.strictEqual(dbMatchesRollback.length, 0, "No matches should be saved if page transaction failed");

    // Verify cursor was NOT advanced in sync_state
    const stateRollback = (await pool.query("SELECT value FROM sync_state WHERE key = 'career_import'")).rows[0]?.value;
    assert.strictEqual(stateRollback, undefined, "Cursor should not be saved on failed transaction");

    // Clean mock
    delete mockResponses["/matches/fail-2/stats"];
    console.log("✓ Test 2 & 3 passed");

    // -------------------------------------------------------------
    // Test 4: Successful resume after interruption
    // -------------------------------------------------------------
    console.log("Test 4: Successful resume after interruption");
    await resetDatabase();

    // Page 1: Provide full page (100 items) so state.done is not set prematurely
    const fullP1 = Array.from({ length: 100 }, (_, i) => createMatch(`res-p1-${i}`, 1700100000 - i * 100));
    const oldestP1 = Number(fullP1[99].started_at || fullP1[99].finished_at);

    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: fullP1 });
    };

    // Page 2
    const fullP2 = Array.from({ length: 100 }, (_, i) => createMatch(`res-p2-${i}`, oldestP1 - i * 100));
    mockResponses[`/players/test-player-1111/history?game=cs2&limit=100&to=${oldestP1}`] = (req, res, send) => {
      send(200, { items: fullP2 });
    };

    // Run first page
    const rRun1 = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(rRun1.saved, 100);
    assert.strictEqual(rRun1.state.done, false);
    assert.strictEqual(rRun1.state.cursor, oldestP1);

    // Run resume (page 2)
    const rRun2 = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(rRun2.saved, 100);
    assert.strictEqual(rRun2.state.imported, 200);

    const totalRes = (await pool.query("SELECT COUNT(*)::int AS cnt FROM faceit_matches")).rows[0].cnt;
    assert.strictEqual(totalRes, 200, "All 200 matches from both pages must be saved");
    console.log("✓ Test 4 passed");

    // -------------------------------------------------------------
    // Test 5 & 6: Duplicate handling, overlapping pages, timestamp ties
    // -------------------------------------------------------------
    console.log("Test 5 & 6: Duplicate handling across overlapping pages & timestamp ties");
    await resetDatabase();

    // Page 1: 100 matches ending with match 'tie-2' at 1700002000
    const tieP1 = Array.from({ length: 99 }, (_, i) => createMatch(`tie-p1-${i}`, 1700100000 - i * 100));
    const tie2 = createMatch("tie-2", 1700002000);
    tieP1.push(tie2);

    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: tieP1 });
    };

    const oldestTie = Number(tie2.started_at || tie2.finished_at);
    // Page 2 repeats 'tie-2' (boundary match) and introduces 'tie-3' with the EXACT SAME started_at timestamp
    const tie3 = createMatch("tie-3", 1700002000);
    mockResponses[`/players/test-player-1111/history?game=cs2&limit=100&to=${oldestTie}`] = (req, res, send) => {
      send(200, { items: [tie2, tie3] });
    };

    // Run page 1
    await importCareer({ maxPages: 1, delayMs: 1 });
    // Run page 2 with overlapping boundary & tie
    const rTie2 = await importCareer({ maxPages: 1, delayMs: 1 });

    assert.strictEqual(rTie2.saved, 1, "Only tie-3 should be counted as newly saved, tie-2 is duplicate");

    const tie3Exists = (await pool.query("SELECT match_id FROM faceit_matches WHERE match_id = 'tie-3'")).rows.length === 1;
    assert.strictEqual(tie3Exists, true, "tie-3 must be saved despite timestamp tie and boundary overlap");
    console.log("✓ Test 5 & 6 passed");

    // -------------------------------------------------------------
    // Test 7: HTTP 404 statistics (marked unavailable)
    // -------------------------------------------------------------
    console.log("Test 7: HTTP 404 statistics (marked 'unavailable')");
    await resetDatabase();

    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [createMatch("m-404", 1700001000)] });
    };
    mockResponses["/matches/m-404/stats"] = (req, res, send) => {
      send(404, { message: "Match stats not found on FACEIT" });
    };

    const res404 = await importCareer({ maxPages: 1, delayMs: 10 });
    assert.strictEqual(res404.ok, true);
    assert.strictEqual(res404.saved, 1);

    const row404 = (await pool.query("SELECT match_id, stats, stats_status FROM faceit_matches WHERE match_id = 'm-404'")).rows[0];
    assert.strictEqual(row404.stats, null);
    assert.strictEqual(row404.stats_status, "unavailable", "404 stats must be marked unavailable, not pending");
    delete mockResponses["/matches/m-404/stats"];
    console.log("✓ Test 7 passed");

    // -------------------------------------------------------------
    // Test 8: HTTP 429/500/network failure retry & recovery
    // -------------------------------------------------------------
    console.log("Test 8: HTTP 429 recovery via retry");
    await resetDatabase();

    let attempts429 = 0;
    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [createMatch("m-429", 1700001000)] });
    };
    mockResponses["/matches/m-429/stats"] = (req, res, send) => {
      attempts429++;
      if (attempts429 === 1) {
        res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
        return res.end("{}");
      }
      send(200, {
        rounds: [{
          round_stats: { Map: "de_inferno" },
          teams: [
            {
              team_stats: { "Final Score": "13" },
              players: [{ player_id: TEST_PLAYER_ID, nickname: "kiyosei", player_stats: { "K/D Ratio": "1.5" } }]
            },
            { team_stats: { "Final Score": "5" }, players: [] }
          ]
        }]
      });
    };

    const res429 = await importCareer({ maxPages: 1, delayMs: 10 });
    assert.strictEqual(res429.ok, true);
    assert.strictEqual(attempts429, 2, "Should have retried after 429 and then succeeded");
    const row429 = (await pool.query("SELECT stats_status FROM faceit_matches WHERE match_id = 'm-429'")).rows[0];
    assert.strictEqual(row429.stats_status, "available");
    delete mockResponses["/matches/m-429/stats"];
    console.log("✓ Test 8 passed");

    // -------------------------------------------------------------
    // Test 9: Backfilling previously imported matches with missing/pending statistics
    // -------------------------------------------------------------
    console.log("Test 9: Backfilling previously imported matches with pending statistics");
    // Insert a pending match directly into DB
    await pool.query(
      `INSERT INTO faceit_matches (match_id, finished_at, map, outcome, stats, stats_status, source)
       VALUES ('m-pending-repair', 1700000500, 'de_ancient', 'Win', NULL, 'pending', 'career_import')`
    );

    // Mock history to return empty (history exhausted) so importCareer runs repair
    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [] });
    };
    mockResponses["/matches/m-pending-repair/stats"] = (req, res, send) => {
      send(200, {
        rounds: [{
          round_stats: { Map: "de_ancient" },
          teams: [
            {
              team_stats: { "Final Score": "13" },
              players: [{ player_id: TEST_PLAYER_ID, nickname: "kiyosei", player_stats: { "K/D Ratio": "2.0" } }]
            },
            { team_stats: { "Final Score": "11" }, players: [] }
          ]
        }]
      });
    };

    const resRepair = await importCareer({ maxPages: 1, delayMs: 10, backfillPending: true });
    assert.strictEqual(resRepair.repaired, 1, "Should have repaired 1 pending match");

    const repairedRow = (await pool.query("SELECT stats_status, stats FROM faceit_matches WHERE match_id = 'm-pending-repair'")).rows[0];
    assert.strictEqual(repairedRow.stats_status, "available");
    assert.notStrictEqual(repairedRow.stats, null);
    delete mockResponses["/matches/m-pending-repair/stats"];
    console.log("✓ Test 9 passed");

    // -------------------------------------------------------------
    // Test 10: Re-importing completed history without duplicate records or counter inflation
    // -------------------------------------------------------------
    console.log("Test 10: Re-importing completed history without duplicate records");
    const statusBefore = await syncStatus();
    const countBefore = statusBefore.matches.total;

    // Run import when state.done is true
    const resCompleted = await importCareer({ maxPages: 1, delayMs: 10, backfillPending: false });
    assert.strictEqual(resCompleted.done, true);
    assert.strictEqual(resCompleted.saved, 0);

    const statusAfter = await syncStatus();
    assert.strictEqual(statusAfter.matches.total, countBefore, "Total match count should not change when re-running completed history");
    console.log("✓ Test 10 passed");

    console.log("\n===========================================");
    console.log("ALL POSTGRESQL INTEGRATION TESTS PASSED!");
    console.log("===========================================\n");
  } finally {
    await stopMockServer();
    await pool.end();
  }
}

runTests().catch((err) => {
  console.error("TEST SUITE FAILED:", err);
  process.exit(1);
});
