// Integration tests: real Express routes + real PostgreSQL + a local FAKE FACEIT server reached through
// FACEIT_API_BASE (so the real src/faceit.js client runs). All payloads are SYNTHETIC: they verify our
// logic, NOT compatibility with real FACEIT deliveries (that needs captured payloads).
const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const express = require("express");

const WH = "whsec-test-0123456789", SYNC = "sync-test-secret", KEY = "faceit-key-test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/tracker_test";
process.env.DATABASE_SSL = "disable";
Object.assign(process.env, { FACEIT_WEBHOOK_SECRET: WH, SYNC_SECRET: SYNC, FACEIT_API_KEY: KEY, FACEIT_NICKNAME: "tester" });
delete process.env.FACEIT_PLAYER_ID; delete process.env.FACEIT_INGAME_STATUSES;

const logs = []; const origLog = console.log, origErr = console.error, origWarn = console.warn;
for (const [name, orig] of [["log", origLog], ["error", origErr], ["warn", origWarn]]) console[name] = (...a) => { logs.push(a.join(" ")); };

// ---- fake FACEIT
const ME = "P-ME", OTHER = "P-OTHER";
const fake = { calls: [], matches: {}, fail: {} };
const team = (name, ids) => ({ name, roster: ids.map((id, i) => ({ player_id: id, nickname: `n-${id}`, game_skill_level: 7 + i })), stats: { rating: 1500, skillLevel: { average: 7 }, winProbability: 0.5 } });
const mine = (status, extra = {}) => ({ status, teams: { faction1: team("team_me", [ME, "P-A"]), faction2: team("team_opp", ["P-B", "P-C"]) }, started_at: 1760000000, ...extra });
const notMine = (status) => ({ status, teams: { faction1: team("x", [OTHER]), faction2: team("y", ["P-Z"]) } });
const faceit = http.createServer((req, res) => {
  fake.calls.push(req.url);
  assert.strictEqual(req.headers.authorization, `Bearer ${KEY}`, "client must authenticate with the FACEIT key");
  const send = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
  if (req.url.startsWith("/players?")) return send(200, { player_id: ME, nickname: "tester" });
  const m = req.url.match(/^\/matches\/([^/?]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (fake.fail[id] > 0) { fake.fail[id]--; return send(500, { error: "boom" }); }
    return fake.matches[id] ? send(200, fake.matches[id]) : send(404, { error: "nf" });
  }
  send(404, {});
});

(async () => {
  await new Promise((r) => faceit.listen(0, r));
  process.env.FACEIT_API_BASE = `http://127.0.0.1:${faceit.address().port}`;

  const { pool, runMigrations } = require("../src/db");
  const live = require("../src/live");
  const { onTransition } = require("../src/live/lifecycle");
  const { reconcileMatch } = require("../src/live/reconcile");
  const { applyState } = require("../src/live/lifecycle");
  const { resetCache } = require("../src/live/player");
  await runMigrations();

  const wipe = async () => { for (const t of ["faceit_live_transitions", "faceit_live_status_observations", "faceit_live_matches", "faceit_webhook_events"]) await pool.query(`DELETE FROM ${t}`); await pool.query("DELETE FROM sync_state WHERE key='faceit_player'"); resetCache(); fake.matches = {}; fake.fail = {}; fake.calls.length = 0; };

  const app = express();
  const requireSecret = (req, res, next) => {            // identical contract to server.js
    const a = crypto.createHash("sha256").update(String(req.get("x-sync-secret") || "")).digest();
    const b = crypto.createHash("sha256").update(process.env.SYNC_SECRET).digest();
    return crypto.timingSafeEqual(a, b) ? next() : res.status(401).json({ error: "Unauthorized." });
  };
  live.mount(app, { requireSecret });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = (body, headers = { "x-kiyosei-webhook-secret": WH }, raw = false) =>
    fetch(`${base}/api/faceit/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw ? body : JSON.stringify(body) });
  const get = (path, secret = SYNC) => fetch(`${base}${path}`, { headers: secret ? { "x-sync-secret": secret } : {} });
  const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } throw new Error("timed out"); };
  const evRow = async (key) => (await pool.query("SELECT * FROM faceit_webhook_events WHERE dedupe_key=$1", [key])).rows[0];
  const settled = (key) => until(async () => { const r = await evRow(key); return r && r.processing_status !== "pending"; });
  const send = async (event, matchId, { id, withPlayer = true } = {}) => {
    const body = { event, ...(id ? { event_id: id } : {}), payload: { id: matchId, ...(withPlayer ? { teams: [{ players: [{ id: ME }] }] } : {}) } };
    const res = await post(body); assert.strictEqual(res.status, 200); const key = id ? `id:${id}` : `evt:${event}:${matchId}`;
    await settled(key); return { res: await res.clone().json().catch(() => null), row: await evRow(key) };
  };
  const matchRow = async (id) => (await pool.query("SELECT * FROM faceit_live_matches WHERE match_id=$1", [id])).rows[0];
  const liveNow = async () => (await get("/api/live")).json();
  const actions = []; const off = onTransition((t) => actions.push(`${t.matchId}:${t.to}`));

  // ===== A. authentication & validation =====
  await wipe();
  assert.strictEqual((await post({ event: "x" }, {})).status, 401, "missing secret header");
  assert.strictEqual((await post({ event: "x" }, { "x-kiyosei-webhook-secret": "wrong" })).status, 401);
  assert.strictEqual((await post({ event: "x" }, { authorization: `Bearer ${WH}` })).status, 401, "secret in the wrong header is not accepted");
  delete process.env.FACEIT_WEBHOOK_SECRET;
  assert.strictEqual((await post({ event: "x" })).status, 503, "no secret configured -> never accept unauthenticated deliveries");
  process.env.FACEIT_WEBHOOK_SECRET = WH;
  assert.strictEqual((await post("{not json", undefined, true)).status, 400);
  assert.strictEqual((await post("[1,2]", undefined, true)).status, 400, "array body");
  assert.strictEqual((await post("", undefined, true)).status, 400, "empty body");
  assert.strictEqual((await post("null", undefined, true)).status, 400);
  assert.strictEqual((await post("x".repeat(300 * 1024), undefined, true)).status, 413, "oversized body");
  assert.strictEqual((await pool.query("SELECT count(*)::int n FROM faceit_webhook_events")).rows[0].n, 0, "rejected requests store nothing");

  // ===== B. valid reception + full lifecycle =====
  fake.matches["M1"] = mine("CONFIGURING");
  let r = await send("match_object_created", "M1", { id: "e-1" });
  assert.strictEqual(r.row.processing_status, "processed"); assert.strictEqual(r.row.attribution, "payload"); assert.strictEqual(r.row.player_id, ME);
  assert.deepStrictEqual(Object.keys(r.row.headers).filter((k) => /secret|auth/.test(k)), [], "secret header never stored");
  assert.strictEqual(r.row.raw_text.includes("match_object_created"), true, "raw body preserved");
  assert.strictEqual(r.row.extraction.matchIdPath, "payload.id");
  assert.strictEqual((await matchRow("M1")).state, "CONFIGURING", "details status (CONFIGURING) advanced the state past MATCH_DETECTED");
  await send("match_status_configuring", "M1", { id: "e-2" });
  fake.matches["M1"] = mine("READY");
  await send("match_status_ready", "M1", { id: "e-3" });
  let s = await liveNow();
  assert.strictEqual(s.state, "READY"); assert.strictEqual(s.inGame, false, "READY must never be IN_GAME");
  assert.strictEqual(s.matchId, "M1"); assert.strictEqual(s.match.teams.ours.name, "team_me"); assert.strictEqual(s.match.teams.opponents[0].name, "team_opp");
  assert.strictEqual(s.match.startedAt, new Date(1760000000 * 1000).toISOString());
  assert.strictEqual(s.match.faceitStatus, "READY"); assert.strictEqual(s.detection.inGameStatusObserved, false);
  // FACEIT itself reports the match as ongoing -> IN_GAME (only via reconciliation)
  fake.matches["M1"] = mine("ONGOING");
  await reconcileMatch("M1");
  s = await liveNow(); assert.strictEqual(s.state, "IN_GAME"); assert.strictEqual(s.inGame, true);
  assert.strictEqual(s.detection.inGameStatusObserved, true);
  assert(s.detection.observedStatuses.some((o) => o.status_raw === "ONGOING"));
  fake.matches["M1"] = mine("FINISHED");
  await send("match_status_finished", "M1", { id: "e-4" });
  s = await liveNow(); assert.strictEqual(s.state, "INACTIVE"); assert.strictEqual(s.inMatch, false); assert.strictEqual(s.matchId, null);
  assert.strictEqual(s.previousMatch.state, "ENDED"); assert.strictEqual(s.previousMatch.closedReason, "terminal");
  const tr = (await pool.query("SELECT to_state FROM faceit_live_transitions WHERE match_id='M1' ORDER BY id")).rows.map((x) => x.to_state);
  assert.deepStrictEqual(tr, ["MATCH_DETECTED", "CONFIGURING", "READY", "IN_GAME", "ENDED"], "each state transition recorded exactly once, in order");
  assert.deepStrictEqual(actions.filter((a) => a.startsWith("M1:")).length, tr.length, "one action per transition");

  // ===== C. duplicates / retries =====
  const before = actions.length;
  const dup = await post({ event: "match_status_finished", event_id: "e-4", payload: { id: "M1" } });
  assert.strictEqual(dup.status, 200); assert.strictEqual((await dup.json()).duplicate, true);
  assert.strictEqual((await evRow("id:e-4")).duplicate_count, 1);
  fake.matches["MD"] = mine("CONFIGURING");
  await send("match_status_configuring", "MD");                                   // no event id: deduped on (type, match)
  const dup2 = await post({ event: "match_status_configuring", payload: { id: "MD", teams: [{ players: [{ id: ME }] }] } });
  assert.strictEqual((await dup2.json()).duplicate, true);
  assert.strictEqual((await pool.query("SELECT count(*)::int n FROM faceit_webhook_events WHERE match_id='MD'")).rows[0].n, 1);
  assert.strictEqual(actions.length - before, (await pool.query("SELECT count(*)::int n FROM faceit_live_transitions WHERE match_id='MD'")).rows[0].n, "duplicates trigger no extra actions");
  assert.strictEqual((await pool.query("SELECT count(*)::int n FROM faceit_live_transitions WHERE match_id='M1' AND to_state='ENDED'")).rows[0].n, 1);

  // ===== D. out-of-order delivery =====
  await wipe(); fake.matches["M2"] = mine("READY");
  await send("match_status_ready", "M2", { id: "o-1" });
  await send("match_status_configuring", "M2", { id: "o-2" });
  await send("match_object_created", "M2", { id: "o-3" });
  let m = await matchRow("M2");
  assert.strictEqual(m.state, "READY", "late older events never regress state");
  assert(m.configuring_at && m.detected_at, "but their timestamps are still recorded");
  fake.matches["M3"] = mine("FINISHED");
  await send("match_status_finished", "M3", { id: "o-4" });
  await send("match_status_ready", "M3", { id: "o-5" });
  assert.strictEqual((await matchRow("M3")).state, "ENDED", "terminal state is never overwritten by a late event");

  // ===== E. multiple matches =====
  await wipe(); fake.matches["A1"] = mine("READY"); fake.matches["B1"] = mine("CONFIGURING");
  await send("match_status_ready", "A1");
  await send("match_object_created", "B1");
  assert.strictEqual((await matchRow("A1")).closed_reason, "superseded");
  s = await liveNow(); assert.strictEqual(s.matchId, "B1"); assert.strictEqual(s.state, "CONFIGURING", "new match starts clean, no inherited state");
  fake.matches["A1"] = mine("FINISHED"); await send("match_status_finished", "A1");
  assert.strictEqual((await matchRow("A1")).state, "ENDED", "a superseded match still records its terminal event");
  assert.strictEqual((await liveNow()).matchId, "B1", "...without disturbing the current match");

  // ===== F. cancel / abort, G. conflicting terminals =====
  await wipe(); fake.matches["C1"] = mine("CANCELLED"); fake.matches["C2"] = mine("ABORTED");
  await send("match_object_created", "C1"); await send("match_status_cancelled", "C1");
  assert.strictEqual((await matchRow("C1")).state, "CANCELLED");
  await send("match_status_aborted", "C2");
  assert.strictEqual((await matchRow("C2")).state, "ABORTED");
  assert.strictEqual((await liveNow()).state, "INACTIVE");
  await send("match_status_aborted", "C1");
  m = await matchRow("C1"); assert.strictEqual(m.state, "CANCELLED"); assert(m.anomalies.some((a) => /conflicting_terminal/.test(a.reason)));

  // ===== H. reconciliation failures =====
  await wipe(); fake.matches["R1"] = mine("READY"); fake.fail["R1"] = 99;
  await post({ event: "match_status_ready", event_id: "r-1", payload: { id: "R1", teams: [{ players: [{ id: ME }] }] } }); await settled("id:r-1");
  const out = await reconcileMatch("R1");
  assert.strictEqual(out.ok, false); m = await matchRow("R1");
  assert.strictEqual(m.state, "READY", "FACEIT failure leaves state untouched"); assert(m.reconcile_failures >= 1 && /FACEIT API returned HTTP 500/.test(m.reconcile_error));
  const f1 = m.reconcile_failures; await pool.query("UPDATE faceit_live_matches SET last_reconcile_attempt_at = NOW() - interval '5 seconds' WHERE match_id='R1'");
  fake.calls.length = 0; await live.tick(); assert.strictEqual(fake.calls.length, 0, "failure back-off: no retry before the delay elapses");
  fake.fail["R1"] = 0; fake.matches["R1"] = mine("FINISHED");
  await pool.query("UPDATE faceit_live_matches SET last_reconcile_attempt_at = NOW() - interval '1 hour' WHERE match_id='R1'");
  await live.tick(); m = await matchRow("R1");
  assert.strictEqual(m.state, "ENDED", "worker recovered the terminal state from FACEIT"); assert.strictEqual(m.reconcile_failures, 0); assert(f1 >= 1);

  // ===== I. missing webhook events (only the first one arrived) =====
  await wipe(); fake.matches["X1"] = mine("CONFIGURING");
  await send("match_object_created", "X1"); fake.matches["X1"] = mine("FINISHED");
  await pool.query("UPDATE faceit_live_matches SET last_reconcile_attempt_at = NOW() - interval '1 hour' WHERE match_id='X1'");
  await live.tick();
  assert.strictEqual((await matchRow("X1")).state, "ENDED", "end detected from reconciliation despite missing terminal webhook");
  assert.strictEqual((await liveNow()).state, "INACTIVE");

  // ===== J. player identity =====
  await wipe(); fake.matches["U1"] = notMine("READY"); fake.matches["U2"] = mine("READY");
  r = await send("match_status_ready", "U1", { withPlayer: false });
  assert.strictEqual(r.row.processing_status, "ignored"); assert(/does not include the tracked player/.test(r.row.processing_error));
  assert.strictEqual(await matchRow("U1"), undefined, "unrelated match never creates lifecycle state");
  r = await send("match_status_ready", "U2", { withPlayer: false });
  assert.strictEqual(r.row.attribution, "roster"); assert.strictEqual((await matchRow("U2")).state, "READY");
  assert.strictEqual((await pool.query("SELECT value->>'playerId' p FROM sync_state WHERE key='faceit_player'")).rows[0].p, ME, "player GUID persisted");
  const mismatch = await applyState({ matchId: "U2", playerId: "P-INTRUDER", target: "ENDED", source: "webhook" });
  assert.strictEqual(mismatch.reason, "player_mismatch"); assert.strictEqual((await matchRow("U2")).state, "READY");
  await pool.query("INSERT INTO faceit_live_matches (match_id, player_id, state, state_rank) VALUES ('U3', $1, 'READY', 3)", [ME]);
  fake.matches["U3"] = notMine("READY"); await reconcileMatch("U3");
  assert.strictEqual((await matchRow("U3")).closed_reason, "unrelated", "reconciliation drops matches whose roster lacks the player");
  process.env.FACEIT_PLAYER_ID = "P-ENV"; fake.matches["U4"] = mine("READY");
  r = await send("match_status_ready", "U4", { withPlayer: false });
  assert.strictEqual(r.row.processing_status, "ignored", "FACEIT_PLAYER_ID overrides the lookup");
  delete process.env.FACEIT_PLAYER_ID;

  // ===== K. unknown status, L. unparsed/unknown events, M. demo_ready =====
  await wipe(); fake.matches["K1"] = mine("VOTING");
  await send("match_object_created", "K1");
  assert.strictEqual((await matchRow("K1")).state, "MATCH_DETECTED", "unrecognised status causes no transition");
  s = await liveNow(); assert(s.detection.observedStatuses.some((o) => o.status_raw === "VOTING" && o.mapped_state === null));
  let res = await post({ payload: { id: "whatever-1" } }); assert.strictEqual(res.status, 200);
  const unparsed = (await pool.query("SELECT * FROM faceit_webhook_events WHERE event_type IS NULL")).rows[0];
  await until(async () => (await pool.query("SELECT processing_status s FROM faceit_webhook_events WHERE id=$1", [unparsed.id])).rows[0].s !== "pending");
  assert.strictEqual((await pool.query("SELECT processing_status s FROM faceit_webhook_events WHERE id=$1", [unparsed.id])).rows[0].s, "unparsed");
  await post({ event: "hub_created", event_id: "h-1", payload: { id: "hub-1234" } }); await settled("id:h-1");
  assert.strictEqual((await evRow("id:h-1")).processing_status, "ignored");
  fake.matches["K1"] = mine("FINISHED"); await send("match_status_finished", "K1");
  await send("match_demo_ready", "K1", { id: "d-1" });
  m = await matchRow("K1"); assert.strictEqual(m.state, "ENDED"); assert(m.demo_ready_at);

  // ===== N. protected endpoints, secrets never leak =====
  for (const p of ["/api/live", "/api/live/events", "/api/live/health"]) {
    assert.strictEqual((await get(p, null)).status, 401, `${p} requires the shared secret`);
    assert.strictEqual((await get(p, "nope")).status, 401);
  }
  const h = await get("/api/live/health"); const hj = await h.json();
  assert.strictEqual(hj.receiver.secretConfigured, true); assert.strictEqual(hj.receiver.authHeader, "x-kiyosei-webhook-secret"); assert(hj.receiver.events.total > 0);
  const ev = await (await get("/api/live/events?limit=5&raw=1")).json();
  assert(ev.events.length && ev.events.length <= 5 && ev.events[0].raw_text);
  const everything = JSON.stringify([hj, ev, await liveNow()]);
  for (const secret of [WH, SYNC, KEY]) assert(!everything.includes(secret), "responses never contain secrets");
  assert.strictEqual((await get("/api/live/events?limit=1000")).status, 200);

  // ===== P. idle worker is free; Q. stale closure =====
  await wipe(); fake.calls.length = 0; await live.tick();
  assert.strictEqual(fake.calls.length, 0, "no active match and no queued events -> zero FACEIT calls");
  await pool.query("INSERT INTO faceit_live_matches (match_id, player_id, state, state_rank, created_at) VALUES ('S1', $1, 'READY', 3, NOW() - interval '8 hours')", [ME]);
  fake.matches["S1"] = mine("READY"); await live.tick();
  assert.strictEqual((await matchRow("S1")).closed_reason, "stale");

  // ===== O. no secret ever reached the logs =====
  for (const secret of [WH, SYNC, KEY]) assert(!logs.some((l) => l.includes(secret)), "secrets never logged");

  off(); server.close(); faceit.close(); await wipe(); await pool.end();
  console.log = origLog; console.error = origErr; console.warn = origWarn;
  console.log("✓ live webhook integration tests passed");
})().catch((e) => { console.log = origLog; console.error = origErr; console.error(e); process.exit(1); });
