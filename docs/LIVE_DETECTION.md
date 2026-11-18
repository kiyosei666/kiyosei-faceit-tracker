# Live FACEIT match lifecycle detection (Phase 0)

Detects when the tracked player's FACEIT match is created, configured, ready, in progress, finished, aborted or cancelled.
No GSI, no companion app, no screen/memory access, no unofficial endpoints. Only the documented FACEIT Webhooks and `GET /matches/{match_id}`.

## FACEIT App Studio setup
| Field | Value |
|---|---|
| Subscription type | User -> **My user** |
| Events | match_object_created, match_status_configuring, match_status_ready, match_status_finished, match_status_aborted, match_status_cancelled, match_demo_ready |
| Callback URL | `https://kiyosei-faceit-tracker.onrender.com/api/faceit/webhook` |
| Authentication | **Header name:** `X-Kiyosei-Webhook-Secret` / **Header value:** the value of `FACEIT_WEBHOOK_SECRET` |

(Use a header, not a query-string parameter: query strings tend to end up in access logs.)

## Environment variables (Render)
| Name | Required | Purpose |
|---|---|---|
| `FACEIT_WEBHOOK_SECRET` | yes | Shared secret the receiver compares (constant time). Without it the receiver answers 503 to everything. |
| `FACEIT_API_KEY` | yes (already set) | Used for `GET /matches/{id}` reconciliation |
| `SYNC_SECRET` | yes (already set) | Protects `/api/live*` via the existing `x-sync-secret` header |
| `FACEIT_PLAYER_ID` | optional | Pin your player GUID; otherwise resolved once from `FACEIT_NICKNAME` and stored in `sync_state.faceit_player` |
| `FACEIT_INGAME_STATUSES` | optional | Comma list of `GET /matches/{id}` status strings meaning "in progress". Default `ONGOING` (**unverified candidate**) |
| `LIVE_POLL_INTERVAL_SECONDS` | optional | Reconciliation cadence while a match is active. Default 45, clamped 30-120 |
| `LIVE_MAX_MATCH_MINUTES` | optional | Active matches older than this are closed as `stale`. Default 360 |

## Endpoints
| Method | Path | Auth | |
|---|---|---|---|
| POST | `/api/faceit/webhook` | `X-Kiyosei-Webhook-Secret` | Receiver: authenticate, validate, store raw, answer 200 |
| GET | `/api/live` | `x-sync-secret` | State, match id, status, teams/opponents, timestamps, last webhook / reconciliation, detection status, observed FACEIT status strings |
| GET | `/api/live/events?limit=&status=&raw=1` | `x-sync-secret` | Recent stored webhook events (payload, headers, extraction paths, processing result) |
| GET | `/api/live/health` | `x-sync-secret` | Receiver/worker/player/DB health. 503 when the secret, FACEIT key or DB is missing |

Receiver responses: `200 {ok, duplicate}`, `401` bad/missing secret, `400` malformed body, `413` over 256 KB, `503` not configured or DB unavailable (non-2xx so the sender may retry).

## State machine
`INACTIVE` (no active match) -> `MATCH_DETECTED` -> `CONFIGURING` -> `READY` -> `IN_GAME` -> `ENDED` | `ABORTED` | `CANCELLED`

- State is stored **per match** (`faceit_live_matches`), so a new match never inherits an old one's state.
- Forward-only. A late older event is ignored (its timestamp is still filled). Terminal states are absorbing; a conflicting second terminal is recorded as an anomaly.
- Skipping states is allowed (a missed event never blocks a later one).
- **FACEIT documents no webhook for "match started".** `READY` never implies `IN_GAME`. `IN_GAME` is set only when `GET /matches/{id}` returns a status listed in `FACEIT_INGAME_STATUSES`.
- Each `(match, state)` transition is recorded once (`faceit_live_transitions`, unique). Later actions (briefing, import) register with `onTransition()` and fire exactly once even if FACEIT retries.
- A new non-terminal match supersedes any older still-active one (`closed_reason='superseded'`; its terminal event is still recorded if it arrives).

## Reconciliation and Render Free
- Events are acknowledged immediately; processing is asynchronous and retried with backoff (up to 8 attempts), then left `failed` for inspection.
- While a match is active the worker calls `GET /matches/{id}` every 45 s (back-off x2 per consecutive failure up to x8; the existing client honours `Retry-After` on 429). With no active match and no queued events it makes **no FACEIT calls**.
- On boot/wake the worker reconciles active matches after ~5 s, so a missed terminal webhook is recovered when the service wakes.
- Render Free sleeps after inactivity. A sleeping service may delay or miss deliveries; whether FACEIT retries is undocumented. Mitigations in place: catch-up on wake, 15-minute scheduled sync still imports finished matches. Not in place: a guarantee of live latency while asleep.

## Receiver infrastructure (Option C evaluated)
A Supabase Edge Function or Cloudflare Worker could accept the POST and insert into `faceit_webhook_events` (the table and dedupe key are designed for this: the processor claims `pending` rows regardless of who inserted them). It would remove the cold-start risk for delivery, at the cost of a second deployment, a second place for the secret and Postgres credentials, and duplicated validation. Phase 0 uses the direct Render receiver because delivery/retry behaviour is still unobserved. Revisit after capturing real deliveries (check `retry_count`-style fields and whether FACEIT retries on non-2xx/timeouts).

## What is NOT verified yet
Real payload field names, header names FACEIT sends, event ordering/latency/retries, the real `status` strings from `GET /matches/{id}` (especially for in-game), whether `GET /matches/{id}` exposes the map, and whether history/stats expose anything mid-match. Synthetic test payloads prove our logic only. After the first real match: inspect `/api/live/events?raw=1` and `/api/live` -> `detection.observedStatuses`, then finalise `src/live/extract.js` paths and `FACEIT_INGAME_STATUSES`.
