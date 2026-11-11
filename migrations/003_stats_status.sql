-- Migration 003: Add stats_status to faceit_matches
-- Tracks availability of detailed match statistics:
-- 'available'   : stats successfully retrieved and populated in stats column
-- 'unavailable' : stats confirmed unavailable from FACEIT (e.g. HTTP 404)
-- 'pending'     : stats could not be fetched due to transient errors or not yet fetched

ALTER TABLE faceit_matches ADD COLUMN IF NOT EXISTS stats_status TEXT DEFAULT 'pending';

-- Update existing rows based on presence of stats JSONB
UPDATE faceit_matches
SET stats_status = CASE
  WHEN stats IS NOT NULL THEN 'available'
  ELSE 'pending'
END
WHERE stats_status IS NULL OR stats_status = 'pending';

-- Add check constraint to guarantee valid values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'faceit_matches_stats_status_check'
  ) THEN
    ALTER TABLE faceit_matches
      ADD CONSTRAINT faceit_matches_stats_status_check
      CHECK (stats_status IN ('available', 'unavailable', 'pending'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS faceit_matches_stats_status_idx ON faceit_matches (stats_status);
