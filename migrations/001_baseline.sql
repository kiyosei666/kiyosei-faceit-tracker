-- Baseline: mirrors the tables the app already created at runtime.
-- Idempotent on purpose so existing Supabase data is untouched.
CREATE TABLE IF NOT EXISTS elo_snapshots (
  id BIGSERIAL PRIMARY KEY,
  elo INTEGER NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS faceit_matches (
  match_id TEXT PRIMARY KEY,
  finished_at BIGINT,
  map TEXT,
  outcome TEXT,
  score TEXT,
  stats JSONB,
  elo_before INTEGER,
  elo_after INTEGER,
  elo_change INTEGER,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
