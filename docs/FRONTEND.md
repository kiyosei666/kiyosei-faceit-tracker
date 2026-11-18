# Frontend guide

Front end only: `public/`. Nothing here touches the API, database or data shapes.

## File map
| File | Purpose |
|---|---|
| `public/css/tokens.css` | **Theme.** Flat monochrome surfaces, text, borders, win/loss colours, radii, layout sizes, K/D tier colours. Retheme here. |
| `public/css/base.css` | Reset, type helpers, focus/reduced-motion rules |
| `public/css/components.css` | `.card`, `.panel`, `.pill` (+ variants), `.seg`, `.tile`, toast, skeletons |
| `public/css/layout.css` | Sticky top bar with pill nav, 12-column dashboard grid, breakpoints |
| `public/css/sections.css` | Overview hero, ELO chart, match history, current form |
| `public/css/features.css` | Styles for the feature modules below |
| `public/css/live-match.css` | Live match center (idle / `.is-active`) and AI briefing |
| `public/js/ui.js` | UI-only behaviour (nav highlight, refresh) |
| `public/js/features/*.js` | One file per feature (ring, streak, coach, celebrations, live match) |
| `public/app.js` | Data loading + rendering |

## Design rules
Dark, flat, monochrome. Depth = surface steps (`--surface-1/2/3`), hairline borders, type and spacing.
**Never** add gradients, blur, glow, shadows or accent hues. `--win` / `--loss` (muted) are reserved for
wins, losses and errors. Pills are part of the language: `.pill` (outline), `.pill--solid`, `.pill--active`
(white, dark text), `.pill--primary`, `.pill--win/--loss`, `.seg` for segmented controls.
FACEIT level badges are greyscaled in `.level-icon` (one `filter` line in `components.css` to revert).

## Layout
`.dash` is a 12-column grid. Overview, Live match → full width; ELO progression (8) + Current form (4);
Match history (7) + AI coach (5, sticky). Below 1180px the middle row stacks; below 960px everything is one
column; below 760px the top bar becomes brand/actions plus a horizontally scrolling pill nav.

## Common edits
- **Change surfaces / text:** `--bg`, `--surface-*`, `--text*`, `--border*` in `tokens.css`.
- **Rounder/squarer:** `--r-*` radii.
- **Change font:** `--font-display` / `--font-body` + the Google Fonts `<link>` in `index.html`.
- **Goal bar range:** uses `BASELINE`, `TARGETS`, `GOAL` at the top of `app.js`; ticks redraw automatically.
- **K/D rank colours:** `--tier-*` tokens. Rank names/thresholds stay in `getFormTier()` in `app.js`.

## Add a new section (e.g. AI Coach)
1. Add as a direct child of `.dash` in `index.html` (full width by default; add a `.dash__*` span rule in `layout.css` to share a row):
   ```html
   <section class="card panel" id="ai-coach" data-section="ai-coach">
     <div class="panel__head"><h2 class="panel__title">AI COACH</h2></div>
     ...
   </section>
   ```
2. Add a nav link in the top bar: `data-nav="ai-coach"`. Highlighting is automatic.
3. Add a `<symbol id="i-...">` to the icon sprite if you need a new icon.
4. Section-specific CSS goes in a new block of `sections.css`; reuse components first.

## Conventions
- No raw colours/radii/blur in component files; use tokens.
- Element IDs are the contract with `app.js`. Rename an ID only together with its `$("...")` usage.

## Feature modules (`public/js/features/`)
`app.js` loads data and then calls `publishData()`, which fires a `kiyosei:data` event with
`{ ready, elo, level, peakElo, matches, totalMatches, targets, baseline, goal }` (matches newest first).
Feature files only listen to that event; they never call the API. To add a feature: create
`js/features/<name>.js`, listen for `kiyosei:data`, add a `<script>` before `app.js`, add styles to `features.css`.

| Module | What it does |
|---|---|
| `goal-bar.js` | Goal bar that moves with you: road to 2,000 → road back to your peak → next hundred past it. Reads `peakElo` from the data; nothing hardcoded |
| `level-ring.js` | Ring around the level icon = progress inside the current FACEIT level (bands in `LEVEL_STARTS`) |
| `streak.js` | Current win/loss streak + last-10 dots from saved matches |
| `coach.js` | AI Coach panel. **Live insights** (last 10 vs earlier matches, best/worst map, ELO pace) are plain calculations, not an AI model |
| `celebrations.js` | Confetti + banner when you cross a target in `TARGETS` (then every 100 above 2,000), move up a level, or set a NEW ALL-TIME PEAK |

### Milestone celebrations
Each milestone fires once per browser (stored in `localStorage` key `kiyosei:milestones:v1`).
The first visit records current progress silently. Preview any time with `?celebrate=1900`
(or `?celebrate=level`, `?celebrate=peak`), or `KiyoseiCelebrate.demo("2,000 ELO")` in the console.
To replay: `localStorage.removeItem("kiyosei:milestones:v1")`.

### AI Coach: connecting a real daily report later
The panel already has a report slot. When a backend report exists, call `KiyoseiCoach.renderReport(report)`
or set `REPORT_ENDPOINT` at the top of `coach.js`. Expected shape (strings or `{ text }` items, max 6 each):
```json
{ "date": "2026-11-16", "summary": "…", "strengths": [], "weaknesses": [], "patterns": [], "priorities": [] }
```
Invalid or non-JSON responses are ignored and the panel stays on live insights. All text is HTML-escaped.

## Navigation highlight rules (`ui.js`)
- Active section = last section whose top has passed a line just under the header; bottom of page = last section.
- Two-column layout: follows the main column; FORM and COACH (side column) light up when clicked and stay lit until you scroll ~100px.
- One-column layout: all sections take part in page order.
- The only scroll offset is `[data-section] { scroll-margin-top }` in `layout.css`.

## All-time peak
The peak shown is always the highest of: your ELO snapshots, ELO recorded on matches, and the stored record
(`elo_records`, 2,274, source `user_confirmed` after migration 005). When you pass it, the tracker's own recorded
ELO becomes the new peak automatically. FACEIT's official API does not provide peak ELO or ELO history.
