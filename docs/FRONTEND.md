# Frontend guide

Front end only: `public/`. Nothing here touches the API, database or data shapes.

## File map
| File | Purpose |
|---|---|
| `public/css/tokens.css` | **Theme.** Colours, blur, radii, fonts, layout sizes, K/D tier colours. Retheme here. |
| `public/css/base.css` | Reset, background orbs, focus/reduced-motion rules |
| `public/css/components.css` | `.glass`, `.panel`, `.pill`, `.seg`, `.tile`, `.icon-btn`, toast, skeletons |
| `public/css/layout.css` | Top pill nav, left rail, content grid, floating dock, breakpoints |
| `public/css/sections.css` | Hero, ELO chart, match history, current form |
| `public/css/features.css` | Styles for the feature modules below |
| `public/js/ui.js` | UI-only behaviour (nav highlight, refresh, back-to-top) |
| `public/js/features/*.js` | One file per feature (ring, streak, coach, celebrations) |
| `public/app.js` | Data loading + rendering (unchanged logic) |

## Common edits
- **Change accent colour:** `--accent` / `--accent-soft` in `tokens.css`.
- **More/less frosted glass:** `--glass-panel`, `--blur-md`, `--blur-lg`.
- **Rounder/squarer:** `--r-*` radii.
- **Change display font:** `--font-display` + the Google Fonts `<link>` in `index.html`.
  Coolvetica is intentionally not used and its files were removed: the free licence covers desktop/static
  use only, not web fonts. Only use a webfont you hold a web licence for (or an open-licence one).
- **Goal bar range:** uses `BASELINE`, `TARGETS`, `GOAL` at the top of `app.js`; ticks redraw automatically.
- **K/D rank colours:** `--tier-*` tokens. Rank names/thresholds stay in `getFormTier()` in `app.js`.

## Add a new section (e.g. AI Coach)
1. Add inside `.layout__main` (or `.layout__side`) in `index.html`:
   ```html
   <section class="glass panel" id="ai-coach" data-section="ai-coach">
     <div class="panel__head"><h2 class="panel__title">AI COACH</h2></div>
     ...
   </section>
   ```
   Add `glass--mesh` for the colourful detail-panel look.
2. Add a nav link in the top bar and rail: `data-nav="ai-coach"`. Highlighting is automatic.
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
