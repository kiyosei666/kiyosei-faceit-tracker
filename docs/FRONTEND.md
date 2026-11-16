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
| `public/js/ui.js` | UI-only behaviour (scroll-spy, refresh button) |
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
