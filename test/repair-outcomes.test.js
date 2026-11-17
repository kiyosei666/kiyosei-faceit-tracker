// Tests scripts/repair-outcomes.js against a LOCAL test database and a fake FACEIT API.
// Never touches production: it uses DATABASE_URL (default: local tracker_test) and a mock server.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");
const run = promisify(execFile);

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/tracker_test";
process.env.DATABASE_SSL = "disable";
const { pool, runMigrations } = require("../src/db");

const ME = "p-me";
const item = (id, i, winner) => ({
  match_id: id, started_at: 9000 - i * 100, finished_at: 9000 - i * 100 + 60,
  results: { winner },
  teams: { faction1: { players: [{ player_id: ME }] }, faction2: { players: [{ player_id: "o" }] } }
});
// history (FACEIT shape uses "players"): a1 win, m1 win, m2 loss, c1 says LOSS
const history = [item("a1", 1, "faction1"), item("m1", 2, "faction1"), item("m2", 3, "faction2"), item("c1", 4, "faction2"), item("keep", 5, "faction2")];

const srv = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/players?")) return res.end(JSON.stringify({ player_id: ME }));
  if (req.url.includes("/history")) {
    const to = (req.url.match(/to=(\d+)/) || [])[1];
    return res.end(JSON.stringify({ items: to ? history.filter((h) => h.started_at < Number(to)) : history }));
  }
  res.statusCode = 404; res.end("{}");
});

(async () => {
  console.log("Starting repair-outcomes tests...");
  await new Promise((r) => srv.listen(4041, r));
  await runMigrations();
  await pool.query("TRUNCATE faceit_matches RESTART IDENTITY");
  const ins = (id, outcome, stats) => pool.query(
    "INSERT INTO faceit_matches (match_id, finished_at, map, outcome, stats, stats_status) VALUES ($1, 1000, 'de_x', $2, $3, $4)",
    [id, outcome, stats ? JSON.stringify(stats) : null, stats ? "available" : "pending"]);
  await ins("s1", "Unknown", { Result: "1" });          // stats only -> Win
  await ins("s2", "Unknown", { Result: "0" });          // stats only -> Loss
  await ins("a1", "Unknown", { Result: "1" });          // stats Win + history Win -> Win (agree)
  await ins("m1", "Unknown", { Kills: "9" });           // no Result; history Win -> Win
  await ins("m2", "Unknown", null);                     // pending; history Loss -> Loss
  await ins("c1", "Unknown", { Result: "1" });          // stats Win, history Loss -> CONFLICT, left alone
  await ins("zz", "Unknown", null);                     // nowhere -> stays Unknown
  await ins("keep", "Win", { Result: "0" });            // already Win -> never changed

  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-"));
  const env = { ...process.env, FACEIT_API_BASE: "http://localhost:4041", FACEIT_API_KEY: "test", DELAY_MS: "1", FACEIT_TIMEOUT_MS: "3000", BACKUP_DIR: backupDir };
  const exec = async (...args) => (await run("node", ["scripts/repair-outcomes.js", ...args], { env, cwd: path.join(__dirname, "..") })).stdout;
  const snapshot = async () => Object.fromEntries((await pool.query("SELECT match_id, outcome FROM faceit_matches")).rows.map((r) => [r.match_id, r.outcome]));
  const before = await snapshot();

  // 1) dry runs never change anything
  let out = await exec();
  assert.ok(/DRY RUN/.test(out) && /Route A can fix: 4/.test(out), out);   // s1, s2, a1, c1 have a Result flag
  assert.deepStrictEqual(await snapshot(), before);
  out = await exec("--history");
  assert.ok(/Team fields in history entries: players/.test(out), out);
  assert.ok(/AGREE:\s+1/.test(out) && /DISAGREE:\s+1/.test(out), out);
  assert.ok(/Only saved stats answered:\s+2/.test(out) && /Only FACEIT history answered:\s+2/.test(out), out);
  assert.ok(/TOTAL that would be set: 5/.test(out), out);
  assert.deepStrictEqual(await snapshot(), before);
  assert.strictEqual(fs.readdirSync(backupDir).length, 0, "dry run must not write a backup");

  // 2) apply writes a backup and only the agreed rows
  out = await exec("--history", "--apply");
  assert.ok(/Backup written/.test(out) && /Saved: 5 matches updated/.test(out), out);
  const after = await snapshot();
  assert.deepStrictEqual(after, { s1: "Win", s2: "Loss", a1: "Win", m1: "Win", m2: "Loss", c1: "Unknown", zz: "Unknown", keep: "Win" });
  const files = fs.readdirSync(backupDir);
  assert.strictEqual(files.length, 1);
  const rows = fs.readFileSync(path.join(backupDir, files[0]), "utf8").trim().split("\n");
  assert.strictEqual(rows.length, 6); // header + 5
  assert.ok(rows.includes("a1,Unknown,Win,both") && rows.includes("s2,Unknown,Loss,stats") && rows.includes("m2,Unknown,Loss,history"));

  // 3) running it again changes nothing (only the conflict and unknown rows remain)
  out = await exec("--history", "--apply");
  assert.ok(/TOTAL that would be set: 0/.test(out) || /Nothing to save/.test(out), out);
  assert.deepStrictEqual(await snapshot(), after);

  console.log("✓ repair-outcomes tests passed");
  srv.close();
  await pool.end();
})().catch((e) => { console.error("TEST SUITE FAILED:", e); process.exit(1); });
