// Run: node test/retry.test.js  (offline; uses a throwaway local server)
const http = require("http");
const assert = require("assert");
let hits = 0, mode = "flaky";
const srv = http.createServer((req, res) => {
  hits++;
  if (mode === "flaky" && hits <= 2) { res.writeHead(429, { "retry-after": "0" }); return res.end("{}"); }
  if (mode === "unauthorized") { res.writeHead(401); return res.end("{}"); }
  res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
});
srv.listen(4020, async () => {
  process.env.FACEIT_API_BASE = "http://localhost:4020";
  process.env.FACEIT_API_KEY = "k";
  const { faceitGet } = require("../src/faceit");
  try {
    assert.deepStrictEqual(await faceitGet("/x", { baseDelayMs: 5 }), { ok: true });
    assert.strictEqual(hits, 3, "should retry twice after 429 then succeed");
    hits = 0; mode = "unauthorized";
    await assert.rejects(() => faceitGet("/x", { baseDelayMs: 5 }), /rejected the API key/);
    assert.strictEqual(hits, 1, "401 must not be retried");
    console.log("retry tests passed");
  } catch (e) { console.error("FAILED:", e.message); process.exitCode = 1; }
  srv.close();
});
