/**
 * Comprehensive PostgreSQL Integration Tests for Career Importer
 *
 * Requirements covered:
 * 1. Successful page import.
 * 2. Genuine PostgreSQL transaction rollback after insertion failure:
 *    At least one match INSERT succeeds inside BEGIN, then a DB error occurs (e.g. check constraint violation).
 *    Verify neither the inserted match nor sync_state cursor commits.
 * 3. Successful resume after interruption across separate importCareer invocations.
 * 4. Duplicate handling across overlapping pages & durable boundary tracking.
 * 5. Timestamp ties without premature completion or skipped matches.
 * 6. HTTP 404 statistics handling (marked 'unavailable').
 * 7. Explicit HTTP 500 retry and recovery test.
 * 8. Explicit network failure (socket hang up / ECONNRESET) retry and recovery test.
 * 9. Explicit HTTP 429 retry and recovery test.
 * 10. Backfilling previously imported matches with pending statistics.
 * 11. Re-importing completed history without duplicating records or inflating counters.
 */

const http = require("http");
const assert = require("assert");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/tracker_test";
process.env.DATABASE_SSL = "disable";
process.env.FACEIT_API_KEY = "test-key";
process.env.FACEIT_API_BASE = "http://localhost:4030";

const { pool, runMigrations } = require("../src/db");
const { importCareer, syncStatus } = require("../src/sync");
const { persistMatches } = require("../src/tracker");

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

    const res1 = await importCareer({ maxPages: 1, delayMs: 1 });
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
    // Test 2: Genuine PostgreSQL mid-transaction failure and rollback
    // Match 1 inserts successfully inside transaction; Match 2 triggers a DB failure
    // (via a temporary trigger or constraint). Verify Match 1 and cursor are rolled back.
    // -------------------------------------------------------------
    console.log("Test 2: Genuine PostgreSQL failure mid-transaction and rollback");
    await resetDatabase();

    // Attach a PostgreSQL trigger that fails specifically on match_id = 'db-fail-2'
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_on_match_2() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.match_id = 'db-fail-2' THEN
          RAISE EXCEPTION 'Simulated database failure mid-transaction';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_fail_on_match_2 ON faceit_matches;
      CREATE TRIGGER trg_fail_on_match_2
        BEFORE INSERT ON faceit_matches
        FOR EACH ROW EXECUTE FUNCTION fail_on_match_2();
    `);

    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [createMatch("db-fail-1", 1700005000), createMatch("db-fail-2", 1700004000)] });
    };

    await assert.rejects(
      async () => importCareer({ maxPages: 1, delayMs: 1 }),
      /Simulated database failure mid-transaction/
    );

    // Verify Match 1 was rolled back and is NOT present in faceit_matches
    const dbRollbackMatches = (await pool.query("SELECT * FROM faceit_matches")).rows;
    assert.strictEqual(dbRollbackMatches.length, 0, "Match 1 must be rolled back when transaction fails");

    // Verify cursor was NOT advanced or committed in sync_state
    const dbRollbackState = (await pool.query("SELECT value FROM sync_state WHERE key = 'career_import'")).rows[0]?.value;
    assert.strictEqual(dbRollbackState, undefined, "Cursor must not be committed when transaction fails");

    // Drop the test trigger
    await pool.query("DROP TRIGGER IF EXISTS trg_fail_on_match_2 ON faceit_matches; DROP FUNCTION IF EXISTS fail_on_match_2;");
    console.log("✓ Test 2 passed");

    // -------------------------------------------------------------
    // Test 3: Successful resume after interruption across separate invocations
    // -------------------------------------------------------------
    console.log("Test 3: Successful resume after interruption across separate invocations");
    await resetDatabase();

    // Page 1: 100 items
    const fullP1 = Array.from({ length: 100 }, (_, i) => createMatch(`res-p1-${i}`, 1700100000 - i * 100));
    const oldestP1 = Number(fullP1[99].started_at || fullP1[99].finished_at);

    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: fullP1 });
    };

    // Page 2: 100 items starting from oldestP1
    const fullP2 = Array.from({ length: 100 }, (_, i) => createMatch(`res-p2-${i}`, oldestP1 - i * 100));
    mockResponses[`/players/test-player-1111/history?game=cs2&limit=100&to=${oldestP1}`] = (req, res, send) => {
      send(200, { items: fullP2 });
    };

    // Invocation 1: import page 1
    const rRun1 = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(rRun1.saved, 100);
    assert.strictEqual(rRun1.state.done, false);
    assert.strictEqual(rRun1.state.cursor, oldestP1);

    // Invocation 2: resumes from cursor, imports page 2
    const rRun2 = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(rRun2.saved, 100);
    assert.strictEqual(rRun2.state.imported, 200);

    const totalRes = (await pool.query("SELECT COUNT(*)::int AS cnt FROM faceit_matches")).rows[0].cnt;
    assert.strictEqual(totalRes, 200, "All 200 matches from both pages must be saved");
    console.log("✓ Test 3 passed");

    // -------------------------------------------------------------
    // Test 4 & 5: Duplicate handling, overlapping pages, timestamp ties
    // -------------------------------------------------------------
    console.log("Test 4 & 5: Duplicate handling, overlapping pages & timestamp ties");
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
    console.log("✓ Test 4 & 5 passed");

    // -------------------------------------------------------------
    // Test 6: HTTP 404 statistics (marked unavailable)
    // -------------------------------------------------------------
    console.log("Test 6: HTTP 404 statistics (marked 'unavailable')");
    await resetDatabase();

    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [createMatch("m-404", 1700001000)] });
    };
    mockResponses["/matches/m-404/stats"] = (req, res, send) => {
      send(404, { message: "Match stats not found on FACEIT" });
    };

    const res404 = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(res404.ok, true);
    assert.strictEqual(res404.saved, 1);

    const row404 = (await pool.query("SELECT match_id, stats, stats_status FROM faceit_matches WHERE match_id = 'm-404'")).rows[0];
    assert.strictEqual(row404.stats, null);
    assert.strictEqual(row404.stats_status, "unavailable", "404 stats must be marked unavailable, not pending");
    delete mockResponses["/matches/m-404/stats"];
    console.log("✓ Test 6 passed");

    // -------------------------------------------------------------
    // Test 6b: HTTP 200 with missing rounds, missing player, or unexpected structure
    // Must NOT be marked 'unavailable'; must be marked 'pending' to preserve retryability.
    // -------------------------------------------------------------
    console.log("Test 6b: Incomplete HTTP 200 payloads marked 'pending'");
    await resetDatabase();

    // m-no-rounds: rounds is empty array []
    // m-no-player: rounds has teams/players but test player is missing
    // m-malformed: response is {} or unexpected structure
    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, {
        items: [
          createMatch("m-no-rounds", 1700003000),
          createMatch("m-no-player", 1700002000),
          createMatch("m-malformed", 1700001000)
        ]
      });
    };

    mockResponses["/matches/m-no-rounds/stats"] = (req, res, send) => {
      send(200, { rounds: [] });
    };
    mockResponses["/matches/m-no-player/stats"] = (req, res, send) => {
      send(200, {
        rounds: [{
          round_stats: { Map: "de_dust2" },
          teams: [{ players: [{ player_id: "other-player", player_stats: { "K/D": "1.0" } }] }]
        }]
      });
    };
    mockResponses["/matches/m-malformed/stats"] = (req, res, send) => {
      send(200, { unexpected_field: true });
    };

    const resIncomplete = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(resIncomplete.ok, true);
    assert.strictEqual(resIncomplete.saved, 3);

    const rowsIncomplete = (await pool.query("SELECT match_id, stats, stats_status FROM faceit_matches WHERE match_id IN ('m-no-rounds', 'm-no-player', 'm-malformed')")).rows;
    for (const r of rowsIncomplete) {
      assert.strictEqual(r.stats, null, `Stats for ${r.match_id} should be null`);
      assert.strictEqual(r.stats_status, "pending", `Incomplete response for ${r.match_id} must be 'pending', not 'unavailable'`);
    }

    delete mockResponses["/matches/m-no-rounds/stats"];
    delete mockResponses["/matches/m-no-player/stats"];
    delete mockResponses["/matches/m-malformed/stats"];
    console.log("✓ Test 6b passed");

    // -------------------------------------------------------------
    // Test 7: HTTP 500 retry and recovery
    // -------------------------------------------------------------
    console.log("Test 7: HTTP 500 retry and recovery");
    await resetDatabase();

    let attempts500 = 0;
    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [createMatch("m-500", 1700001000)] });
    };
    mockResponses["/matches/m-500/stats"] = (req, res, send) => {
      attempts500++;
      if (attempts500 === 1) {
        send(500, { message: "Internal server error on FACEIT stats" });
        return;
      }
      send(200, {
        rounds: [{
          round_stats: { Map: "de_nuke" },
          teams: [
            {
              team_stats: { "Final Score": "13" },
              players: [{ player_id: TEST_PLAYER_ID, nickname: "kiyosei", player_stats: { "K/D Ratio": "1.3" } }]
            },
            { team_stats: { "Final Score": "7" }, players: [] }
          ]
        }]
      });
    };

    const res500 = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(res500.ok, true);
    assert.strictEqual(attempts500, 2, "Should retry after 500 and succeed on subsequent attempt");
    const row500 = (await pool.query("SELECT stats_status FROM faceit_matches WHERE match_id = 'm-500'")).rows[0];
    assert.strictEqual(row500.stats_status, "available");
    delete mockResponses["/matches/m-500/stats"];
    console.log("✓ Test 7 passed");

    // -------------------------------------------------------------
    // Test 7b: Explicit timeout retry and recovery
    // -------------------------------------------------------------
    console.log("Test 7b: Explicit timeout retry and recovery");
    await resetDatabase();

    let attemptsTimeout = 0;
    process.env.FACEIT_TIMEOUT_MS = "150"; // low timeout for fast test

    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [createMatch("m-timeout", 1700001000)] });
    };

    mockResponses["/matches/m-timeout/stats"] = (req, res, send) => {
      attemptsTimeout++;
      if (attemptsTimeout === 1) {
        // Delay response beyond timeout threshold to trigger AbortSignal timeout
        setTimeout(() => {
          if (!res.writableEnded) send(200, { rounds: [] });
        }, 300);
        return;
      }
      send(200, {
        rounds: [{
          round_stats: { Map: "de_anubis" },
          teams: [
            {
              team_stats: { "Final Score": "13" },
              players: [{ player_id: TEST_PLAYER_ID, nickname: "kiyosei", player_stats: { "K/D Ratio": "1.8" } }]
            },
            { team_stats: { "Final Score": "10" }, players: [] }
          ]
        }]
      });
    };

    const resTimeout = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(resTimeout.ok, true);
    assert.strictEqual(attemptsTimeout, 2, "Should retry after timeout and succeed on second attempt");
    const rowTimeout = (await pool.query("SELECT stats_status FROM faceit_matches WHERE match_id = 'm-timeout'")).rows[0];
    assert.strictEqual(rowTimeout.stats_status, "available");

    delete mockResponses["/matches/m-timeout/stats"];
    delete process.env.FACEIT_TIMEOUT_MS;
    console.log("✓ Test 7b passed");

    // -------------------------------------------------------------
    // Test 8: Network failure (socket hang up) retry and recovery
    // -------------------------------------------------------------
    console.log("Test 8: Network failure (socket hang up) retry and recovery");
    await resetDatabase();

    let attemptsNet = 0;
    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [createMatch("m-net", 1700001000)] });
    };
    mockResponses["/matches/m-net/stats"] = (req, res) => {
      attemptsNet++;
      if (attemptsNet === 1) {
        // Destroy client socket immediately to simulate network disconnection / ECONNRESET
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        rounds: [{
          round_stats: { Map: "de_vertigo" },
          teams: [
            {
              team_stats: { "Final Score": "13" },
              players: [{ player_id: TEST_PLAYER_ID, nickname: "kiyosei", player_stats: { "K/D Ratio": "1.4" } }]
            },
            { team_stats: { "Final Score": "8" }, players: [] }
          ]
        }]
      }));
    };

    const resNet = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(resNet.ok, true);
    assert.strictEqual(attemptsNet, 2, "Should retry after socket drop and succeed on second attempt");
    const rowNet = (await pool.query("SELECT stats_status FROM faceit_matches WHERE match_id = 'm-net'")).rows[0];
    assert.strictEqual(rowNet.stats_status, "available");
    delete mockResponses["/matches/m-net/stats"];
    console.log("✓ Test 8 passed");

    // -------------------------------------------------------------
    // Test 9: HTTP 429 retry and recovery
    // -------------------------------------------------------------
    console.log("Test 9: HTTP 429 retry and recovery");
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

    const res429 = await importCareer({ maxPages: 1, delayMs: 1 });
    assert.strictEqual(res429.ok, true);
    assert.strictEqual(attempts429, 2, "Should retry after 429 and then succeed");
    const row429 = (await pool.query("SELECT stats_status FROM faceit_matches WHERE match_id = 'm-429'")).rows[0];
    assert.strictEqual(row429.stats_status, "available");
    delete mockResponses["/matches/m-429/stats"];
    console.log("✓ Test 9 passed");

    // -------------------------------------------------------------
    // Test 10: Backfilling previously imported matches with pending statistics & anti-starvation
    // Regression test: match 1 fails transiently, but match 2 proceeds and succeeds.
    // -------------------------------------------------------------
    console.log("Test 10: Backfill with anti-starvation (first fails transiently, second succeeds)");
    await pool.query(
      `INSERT INTO faceit_matches (match_id, finished_at, map, outcome, stats, stats_status, source)
       VALUES
       ('m-pending-fail', 1700000600, 'de_mirage', 'Loss', NULL, 'pending', 'career_import'),
       ('m-pending-succeed', 1700000500, 'de_ancient', 'Win', NULL, 'pending', 'career_import')`
    );

    // Mock history to return empty (history exhausted) so importCareer runs repair
    mockResponses["/players/test-player-1111/history?game=cs2&limit=100&offset=0"] = (req, res, send) => {
      send(200, { items: [] });
    };

    // Match 1 throws 500
    mockResponses["/matches/m-pending-fail/stats"] = (req, res, send) => {
      send(500, { error: "Stats service down for this match" });
    };

    // Match 2 succeeds
    mockResponses["/matches/m-pending-succeed/stats"] = (req, res, send) => {
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

    const resRepair = await importCareer({ maxPages: 1, delayMs: 1, backfillPending: true });
    assert.strictEqual(resRepair.repaired, 1, "Should have repaired 1 match despite the first failing");

    const rowFailed = (await pool.query("SELECT stats_status FROM faceit_matches WHERE match_id = 'm-pending-fail'")).rows[0];
    assert.strictEqual(rowFailed.stats_status, "pending", "First match should remain pending for future attempts");

    const rowSucceeded = (await pool.query("SELECT stats_status, stats FROM faceit_matches WHERE match_id = 'm-pending-succeed'")).rows[0];
    assert.strictEqual(rowSucceeded.stats_status, "available", "Second match must be backfilled to available");
    assert.notStrictEqual(rowSucceeded.stats, null);

    delete mockResponses["/matches/m-pending-fail/stats"];
    delete mockResponses["/matches/m-pending-succeed/stats"];
    console.log("✓ Test 10 passed");

    // -------------------------------------------------------------
    // Test 10b: Regular persistMatches() live tracker path classification
    // -------------------------------------------------------------
    console.log("Test 10b: Live tracker persistMatches() classification consistency");
    await resetDatabase();

    const liveMatches = [
      createMatch("live-avail", 1700009000),
      createMatch("live-404", 1700008000),
      createMatch("live-empty", 1700007000)
    ];

    mockResponses["/matches/live-avail/stats"] = (req, res, send) => {
      send(200, {
        rounds: [{
          round_stats: { Map: "de_mirage" },
          teams: [{ players: [{ player_id: TEST_PLAYER_ID, nickname: "kiyosei", player_stats: { "K/D Ratio": "1.3" } }] }]
        }]
      });
    };
    mockResponses["/matches/live-404/stats"] = (req, res, send) => {
      send(404, { message: "Not found" });
    };
    mockResponses["/matches/live-empty/stats"] = (req, res, send) => {
      send(200, { rounds: [{ teams: [{ players: [{ player_id: TEST_PLAYER_ID, player_stats: {} }] }] }] });
    };

    const persistRes = await persistMatches(liveMatches, TEST_PLAYER_ID, "kiyosei", 1750);
    assert.strictEqual(persistRes.saved, 3);

    const liveRows = (await pool.query("SELECT match_id, stats_status FROM faceit_matches WHERE match_id LIKE 'live-%' ORDER BY match_id")).rows;
    const liveMap = new Map(liveRows.map(r => [r.match_id, r.stats_status]));

    assert.strictEqual(liveMap.get("live-avail"), "available", "Valid stats must be available");
    assert.strictEqual(liveMap.get("live-404"), "unavailable", "404 must be unavailable");
    assert.strictEqual(liveMap.get("live-empty"), "pending", "Empty stats must be pending");

    // Verify 1680 baseline snapshot was created
    const baselineRow = (await pool.query("SELECT elo FROM elo_snapshots ORDER BY captured_at ASC, id ASC LIMIT 1")).rows[0];
    assert.strictEqual(baselineRow.elo, 1680, "1,680 ELO baseline must be preserved");

    delete mockResponses["/matches/live-avail/stats"];
    delete mockResponses["/matches/live-404/stats"];
    delete mockResponses["/matches/live-empty/stats"];
    console.log("✓ Test 10b passed");

    // -------------------------------------------------------------
    // Test 11: Re-importing completed history without duplicate records or counter inflation
    // -------------------------------------------------------------
    console.log("Test 11: Re-importing completed history without duplicate records");
    const statusBefore = await syncStatus();
    const countBefore = statusBefore.matches.total;

    // Run import when state.done is true
    const resCompleted = await importCareer({ maxPages: 1, delayMs: 1, backfillPending: false });
    assert.strictEqual(resCompleted.done, true);
    assert.strictEqual(resCompleted.saved, 0);

    const statusAfter = await syncStatus();
    assert.strictEqual(statusAfter.matches.total, countBefore, "Total match count should not change when re-running completed history");
    console.log("✓ Test 11 passed");

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
