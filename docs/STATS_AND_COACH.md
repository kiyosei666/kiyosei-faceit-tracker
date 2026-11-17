# Stats engine and Gemini AI coach

## Data flow
`faceit_matches` (read-only) → `src/stats/engine.js` (deterministic) → JSON → `src/coach.js` (Gemini interprets) → validation → `coach_reports` cache → frontend.

Gemini never sees raw rows and never produces numbers: every number in its prose must appear in the facts it was sent
(rounding to the shown precision is allowed). Reports that fail validation are discarded, never shown.

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/stats` | none | Full deterministic analysis (overall, last 10/20/50 vs earlier, maps, patterns, role tendencies, insights with evidence, coverage/metadata) |
| GET | `/api/stats/inventory` | none | What the stored FACEIT stats really contain: every key with coverage, mapped/unmapped, unsupported metrics |
| GET | `/api/stats/match/:id` | none | One match vs the 50 matches before it (`latest` accepted) |
| GET | `/api/coach/overview` | none | Analysis + Gemini overview (cached; refreshes at most every `COACH_MIN_INTERVAL_MIN`) |
| GET | `/api/coach/match/:id` | none | Match comparison + Gemini post-match report (only the newest `COACH_MATCH_RECENT_LIMIT` matches generate) |
| POST | `/api/coach/generate` | `x-sync-secret` | Force a fresh overview + latest-match report (still bounded by the daily limit) |

## Environment variables
| Name | Required | Default |
|---|---|---|
| `GEMINI_API_KEY` | for AI reports | none (engine works without it) |
| `GEMINI_MODEL` | no | `gemini-3.6-flash` |
| `GEMINI_MAX_OUTPUT_TOKENS` | no | `4096` |
| `GEMINI_TIMEOUT_MS` | no | `45000` |
| `COACH_DAILY_LIMIT` | no | `20` Gemini-backed reports per rolling 24h |
| `COACH_MIN_INTERVAL_MIN` | no | `60` |
| `COACH_MATCH_RECENT_LIMIT` | no | `5` |

## Cost controls
Identical facts → cached (SHA-256 of facts). New data within the refresh interval → previous report. Concurrent requests share one call.
Rejected drafts are not retried for 6h. Daily cap. 2-minute backoff after an API failure. Compact facts (no raw rows).

## Limits (honest)
- Stored stats are FACEIT's per-match player stats: no positional/demo data, so roles are statistical tendencies only.
- KAST and CT/T splits are reported as unsupported unless such keys exist in stored data (`/api/stats/inventory` decides).
- Metrics beyond K/D, K/R, ADR, HS%, kills/deaths/assists appear only if their keys are present.
- Significance labels use normal-approximation tests across several comparisons; "possible" can be chance.
