-- The player confirmed that 2,274 is their real all-time peak.
-- The value is unchanged; only its source label and note are updated so the app no
-- longer describes it as an unverified report. Idempotent: does nothing if the record
-- was already changed, and never lowers or replaces a higher tracked peak (the peak
-- shown is always the highest of snapshots, match ELO and this record).
UPDATE elo_records
SET source = 'user_confirmed',
    notes = 'All-time peak confirmed by the player on 2026-11-17; exact achievement date is not available.'
WHERE record_key = 'all_time_peak'
  AND elo = 2274
  AND source = 'user_reported';
