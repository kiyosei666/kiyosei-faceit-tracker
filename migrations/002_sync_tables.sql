-- Additive only: new tables plus nullable columns. Nothing is dropped or rewritten.
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  matches_seen INTEGER NOT NULL DEFAULT 0,
  matches_saved INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at DESC);
ALTER TABLE faceit_matches ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE faceit_matches ADD COLUMN IF NOT EXISTS started_at BIGINT;
