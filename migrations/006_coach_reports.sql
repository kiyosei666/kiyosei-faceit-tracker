-- Additive only: cache of generated AI coach reports so identical inputs never
-- trigger a second Gemini call. Touches no existing table or row.
CREATE TABLE IF NOT EXISTS coach_reports (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'overview' | 'match'
  subject_key TEXT NOT NULL,          -- 'player' for overview, match_id for a match report
  input_hash TEXT NOT NULL,           -- SHA-256 of the facts sent to the model
  model TEXT,
  status TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'rejected'
  report JSONB,
  usage JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS coach_reports_input_uidx ON coach_reports (kind, subject_key, input_hash);
CREATE INDEX IF NOT EXISTS coach_reports_recent_idx ON coach_reports (kind, subject_key, created_at DESC);
