// Boots the real server.js (routes mounted, worker started) and exercises the public contract over HTTP.
const assert = require("assert");
const { spawn } = require("child_process");
const PORT = 4177, WH = "smoke-webhook-secret", SYNC = "smoke-sync-secret";
const env = { ...process.env, PORT: String(PORT), DATABASE_SSL: "disable", FACEIT_WEBHOOK_SECRET: WH, SYNC_SECRET: SYNC, FACEIT_API_KEY: "smoke-key", FACEIT_API_BASE: "http://127.0.0.1:9", FACEIT_PLAYER_ID: "P-SMOKE" };
env.DATABASE_URL = env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/tracker_test";
const child = spawn("node", ["server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
const wait = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 150)); } throw new Error("server did not start:\n" + out); };
(async () => {
  const url = (p) => `http://127.0.0.1:${PORT}${p}`;
  await wait(async () => (await fetch(url("/api/health"))).ok);
  assert.strictEqual((await fetch(url("/api/live/health"))).status, 401);
  assert.strictEqual((await fetch(url("/api/live"))).status, 401);
  assert.strictEqual((await fetch(url("/api/faceit/webhook"), { method: "POST", body: "{}" })).status, 401);
  const ok = await fetch(url("/api/faceit/webhook"), { method: "POST", headers: { "content-type": "application/json", "x-kiyosei-webhook-secret": WH }, body: JSON.stringify({ event: "hub_created", event_id: `smoke-${Date.now()}`, payload: { id: "hub-smoke-1" } }) });
  assert.strictEqual(ok.status, 200);
  const health = await (await fetch(url("/api/live/health"), { headers: { "x-sync-secret": SYNC } })).json();
  assert.strictEqual(health.receiver.secretConfigured, true); assert.strictEqual(health.processor.workerRunning, true);
  assert(!JSON.stringify(health).includes(WH) && !JSON.stringify(health).includes(SYNC));
  assert((await (await fetch(url("/api/live"), { headers: { "x-sync-secret": SYNC } })).json()).state);
  assert(!out.includes(WH) && !out.includes(SYNC), "secrets never reach server output");
  console.log("✓ live server smoke test passed");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  child.kill();
  const { Pool } = require("pg"); const p = new Pool({ connectionString: env.DATABASE_URL, ssl: false });
  await p.query("DELETE FROM faceit_webhook_events WHERE event_id LIKE 'smoke-%'").catch(() => {}); await p.end();
});
