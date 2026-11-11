-- Keep historical peak records separate from dated ELO snapshots.
-- The initial value is explicitly user-reported; it is not presented as a dated
-- snapshot or used to fabricate points on the ELO progression chart.
CREATE TABLE IF NOT EXISTS elo_records (
  record_key TEXT PRIMARY KEY,
  elo INTEGER NOT NULL CHECK (elo > 0),
  source TEXT NOT NULL,
  captured_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO elo_records (record_key, elo, source, captured_at, notes)
VALUES (
  'all_time_peak',
  2274,
  'user_reported',
  NULL,
  'Historical all-time peak previously reported by the player; exact achievement date is not available.'
)
ON CONFLICT (record_key) DO NOTHING;
