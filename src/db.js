const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// SSL stays on by default (matches the previous behaviour for Supabase).
// Set DATABASE_SSL=disable only for a local test database.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

if (pool) {
  pool.on("error", (error) => console.error("Unexpected database pool error:", error.message));
}

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
let migrationPromise = null;

// Applies numbered .sql files once each, in order. Additive only: files are
// never edited after release, and nothing here drops or rewrites data.
async function runMigrations() {
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }
    return true;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
}

// Same contract as the old ensureSchema(): false when no database is
// configured, true once the schema is ready. Retries after a failure.
function ensureSchema() {
  if (!pool) return Promise.resolve(false);
  if (!migrationPromise) {
    migrationPromise = runMigrations().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

module.exports = { pool, ensureSchema, runMigrations };
