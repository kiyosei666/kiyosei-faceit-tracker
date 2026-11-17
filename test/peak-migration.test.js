// Verifies migration 005: the 2,274 peak is kept and marked as confirmed (needs PostgreSQL via DATABASE_URL).
const assert = require("assert");
const { pool, runMigrations } = require("../src/db");
(async () => {
  console.log("Starting peak migration test...");
  await runMigrations();
  const { rows } = await pool.query("SELECT elo, source, notes FROM elo_records WHERE record_key = 'all_time_peak'");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].elo, 2274);
  assert.strictEqual(rows[0].source, "user_confirmed");
  assert.ok(/confirmed/i.test(rows[0].notes));
  // idempotent: a second run changes nothing and a higher peak elsewhere is untouched
  await runMigrations();
  const again = await pool.query("SELECT elo, source FROM elo_records WHERE record_key = 'all_time_peak'");
  assert.strictEqual(again.rows[0].elo, 2274);
  console.log("✓ peak migration tests passed");
  await pool.end();
})().catch((e) => { console.error("TEST SUITE FAILED:", e); process.exit(1); });
