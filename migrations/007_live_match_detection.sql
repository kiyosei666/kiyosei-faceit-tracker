-- Live FACEIT match lifecycle detection. Additive only: new tables, no changes to
-- faceit_matches or any existing table.

-- Every webhook delivery, preserved raw for verification. Idempotent via dedupe_key.
CREATE TABLE IF NOT EXISTS faceit_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  event_id TEXT,
  event_type TEXT,
  match_id TEXT,
  player_id TEXT,
  attribution TEXT,                       -- 'payload' | 'roster' | NULL (not yet established)
  extraction JSONB,                       -- which payload paths the parser used (for verifying real captures)
  raw_text TEXT NOT NULL,
  payload JSONB,
  headers JSONB,                          -- non-secret request headers only
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  last_duplicate_at TIMESTAMPTZ,
  processing_status TEXT NOT NULL DEFAULT 'pending',  -- pending | processed | ignored | unparsed | failed
  processing_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS faceit_webhook_events_dedupe_uidx ON faceit_webhook_events (dedupe_key);
CREATE INDEX IF NOT EXISTS faceit_webhook_events_received_idx ON faceit_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS faceit_webhook_events_pending_idx ON faceit_webhook_events (processing_status, next_attempt_at);

-- One row per FACEIT match that involved the tracked player. State is per match,
-- so a new match can never inherit a previous match's state.
CREATE TABLE IF NOT EXISTS faceit_live_matches (
  match_id TEXT PRIMARY KEY,
  player_id TEXT,
  state TEXT NOT NULL,                    -- MATCH_DETECTED | CONFIGURING | READY | IN_GAME | ENDED | ABORTED | CANCELLED
  state_rank INTEGER NOT NULL,
  closed_reason TEXT,                     -- NULL while active; 'terminal' | 'superseded' | 'stale' | 'unrelated'
  attribution TEXT,                       -- how the match was tied to the tracked player
  status_raw TEXT,                        -- last status string FACEIT returned from GET /matches/{id}
  map TEXT,                               -- only if GET /matches/{id} exposes it
  detected_at TIMESTAMPTZ, configuring_at TIMESTAMPTZ, ready_at TIMESTAMPTZ, in_game_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ, aborted_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, demo_ready_at TIMESTAMPTZ,
  faceit_configured_at TIMESTAMPTZ, faceit_started_at TIMESTAMPTZ, faceit_finished_at TIMESTAMPTZ,
  teams JSONB,                            -- reduced team/opponent metadata from match details
  details JSONB,                          -- latest full GET /matches/{id} response (raw, for parser finalisation)
  anomalies JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_event_at TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  last_reconcile_attempt_at TIMESTAMPTZ,
  reconcile_failures INTEGER NOT NULL DEFAULT 0,
  reconcile_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS faceit_live_matches_active_idx ON faceit_live_matches (updated_at DESC) WHERE closed_reason IS NULL;
CREATE INDEX IF NOT EXISTS faceit_live_matches_created_idx ON faceit_live_matches (created_at DESC);

-- Each (match, state) transition happens at most once, so follow-up actions
-- (briefings, imports) cannot fire twice for duplicate or replayed events.
CREATE TABLE IF NOT EXISTS faceit_live_transitions (
  id BIGSERIAL PRIMARY KEY,
  match_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  source TEXT NOT NULL,                   -- 'webhook' | 'reconcile'
  event_id BIGINT,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS faceit_live_transitions_once_uidx ON faceit_live_transitions (match_id, to_state);

-- Distinct status strings FACEIT actually returned, so we map real values, not guesses.
CREATE TABLE IF NOT EXISTS faceit_live_status_observations (
  status_raw TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count INTEGER NOT NULL DEFAULT 1,
  mapped_state TEXT,
  last_match_id TEXT
);
