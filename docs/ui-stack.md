# Web UI stack: Tailwind 4 and shadcn/ui on Base UI

Results of the T02 stack spike (UI plan, decision D2), measured on 2026-10-08 at `80ac538`.

## What is installed

| Package | Version | Kind | Published |
| --- | --- | --- | --- |
| `tailwindcss` | 4.3.3 | dev | 2026-07-16 |
| `@tailwindcss/vite` | 4.3.3 | dev | 2026-07-16 |
| `@base-ui/react` | 1.8.0 | runtime | 2026-09-04 |
| `clsx` | 2.1.1 | runtime | 2024-04-23 |
| `tailwind-merge` | 3.7.0 | runtime | 2026-09-12 |

All versions are exact and were at least 14 days old at install. The lockfile pins the one transitive
package that was younger (`enhanced-resolve`, under `@tailwindcss/node`) to 5.25.1, which is 25 days old.
No `tw-animate-css` and no `lucide-react`: motion is our own CSS and icons will be vendored (T06).

## How it is wired

- `apps/web/vite.config.ts` runs the Tailwind plugin and resolves the `@/` alias from `tsconfig.json`
  (`"@/*": ["./src/*"]`). The root `vitest.config.ts` resolves it the same way.
- `src/ui/stack.css` is the first stylesheet `main.tsx` imports. It declares
  `@layer theme, base, components, utilities` and brings in Tailwind's theme and utilities.
- Every stylesheet outside `src/ui/` (the legacy CSS) is wrapped in `@layer components` at build time by
  the `localdot:legacy-layer` plugin in `vite.config.ts`, so kit utilities override legacy rules and a
  reset stays beneath them. The plugin keeps `@custom-media` at the top level and restates the layer
  order in each file, so import order cannot change it. It goes when T29 deletes the legacy CSS.
- Tailwind scans `src/` except tests and `src/ui/_spike`. Biome parses Tailwind directives
  (`css.parser.tailwindDirectives`).
- `apps/web/components.json` configures the shadcn generator (`base-vega` style, aliases under `@/ui`).
- The preflight reset is **not** in the app yet; see "Preflight" below.

## The spike gallery

`src/ui/_spike/` holds the generated components (Button, Dialog, Select, Combobox, Popover, Menu,
Tooltip, Toast, Sheet, Drawer), a `KitProvider`, and a gallery page. The gallery is its own Vite root
(`vite.spike.config.ts`). The app's `index.html` never imports it, and the build test checks that no
gallery or Base UI code reaches `dist`.

The gallery maps shadcn's semantic colour names (`popover`, `muted-foreground`, `input`, `ring`, …) onto
the UI plan §4.1 roles in `spike.css`. T03 owns the real token layer.

Run the gates: `pnpm --filter @localdot/web exec playwright test e2e/ui-stack-spike.spec.ts` (builds the
gallery, serves it through the daemon's own `serveUi` with the production CSP on a free port, and drives
Chrome and WebKit). Unit check: `pnpm exec vitest run apps/web/src/ui`.

## Gate results

| # | Gate | Result |
| --- | --- | --- |
| 1 | Vite 8.3.1 production build with the Tailwind plugin; layers `theme, base, components, utilities`, legacy CSS in `components` | **Pass.** Built CSS order: `properties` (Tailwind's `@property` fallbacks), `theme`, `base` (empty), `components` (all legacy CSS), `utilities`. Checked by `ui-stack-spike.spec.ts`. App JS is byte-identical; app CSS grows 57.6 → 62.7 kB (11.6 → 12.7 kB gz). Before/after screenshots of Watch, Settings, Keys, Replay and sign-in (Chrome 1440 and 390, WebKit 1440 and 390) differ only in live content (timer, fake desktop frame). |
| 2 | Zero `securitypolicyviolation` under the production CSP, Chrome and WebKit, for Select, Combobox, Popover, Menu, Dialog, Tooltip, Toast (plus Sheet and Drawer); no library injects `<style>` | **Pass, with one required setting.** Base UI renders an inline `<style>` (a scrollbar-hiding rule) from `Select.Popup`/`Select.List` and `ScrollArea`. Under our CSP that is blocked and reported. `KitProvider` wraps the tree in `<CSPProvider disableStyleElements>` and the kit stylesheet carries the rule (`.base-ui-disable-scrollbar`). With that, every overlay opens and closes with zero violations and zero `<style>` insertions at 1440 and at 390 with touch, in both engines. A negative control (`?inline-styles`) shows the check does catch Base UI's element in both engines. |
| 2b | Scroll lock without injected styles | **Pass.** Base UI locks through CSSOM inline styles on `<html>`/`<body>` (and a `data-base-ui-scroll-locked` attribute). Wheel input does not move the page under an open dialog; the position is restored on close; no `<style>` is added. |
| 2c | Focus trap and return | **Pass** for Dialog, Sheet (Dialog) and Drawer in both engines: Tab and Shift+Tab stay inside (no page element receives focus), Escape closes, focus returns to the trigger. Base UI wraps through focus guards beside the popup for one frame, so tests poll the active element. |
| 3 | WebKit (and Chrome) 390 touch: tap the Select trigger, tap an option, the value commits; no click-through; Escape and outside taps inside an open Sheet close only the popup and keep the Sheet's state | **Pass** in both engines. A button lying under the open list stays at 0 presses after an option is tapped (and counts a direct tap). Inside the Sheet, Escape, a tap on the Sheet outside the list, and a tap on the dim area outside the Sheet each close only the list; the typed note and the chosen value survive. The same dim-area tap with no list open closes the Sheet. |
| 4 | The kit adds ≤45 kB gz JS and ≤12 kB gz CSS | **CSS pass, JS fail.** See below. |
| 5 | Typecheck (TS 7), Biome (`noDefaultExport`), Vitest with jsdom | **Pass.** `KitProvider.test.tsx` renders an open Select in jsdom: no `<style>` with the provider, one without it. |
| 6 | Preflight before/after on FS10 and FS24 | Not run: needs the T01 harness. Measured informally below. |

### Gate 4: bundle cost

Each row is a production build of a page that renders only that piece, minus a React-only page
(67.7 kB gz). JS gzip level 9, kilobytes.

| Piece | Added JS (gz) |
| --- | --- |
| `cn` (clsx + tailwind-merge) | 8.4 |
| `KitProvider` (CSP, Tooltip and Toast providers) | 4.9 |
| Dialog | 29.1 (20.7 with clsx only) |
| Toast | 18.5 |
| Tooltip | 36.8 (28.5 with clsx only) |
| Drawer | 37.9 |
| Popover | 43.1 (34.7 with clsx only) |
| Select | 48.9 (40.5 with clsx only) |
| Menu | 51.4 |
| Combobox | 53.1 |
| Select, Combobox, Dialog, Popover, Menu, Tooltip together | 83.5 (74.4 with clsx only) |
| Everything in the gallery, demo code included | 101.3 |
| Gallery CSS (preflight, theme, utilities for every piece) | 6.0 |

Roughly 20–25 kB gz of every popup is shared Base UI and Floating UI infrastructure
(`floating-ui-react`, internals, utils). One overlay fits in 45 kB, but any useful set (Select, Dialog and
Popover at least) does not, so the budget cannot be met with Base UI for the core overlays. Options,
cheapest first:

1. **Raise the JS budget to about 80 kB gz** for Select, Combobox, Dialog, Popover, Menu and Tooltip on
   Base UI (the parts with the hardest accessibility work: typeahead, positioning, focus, nested
   dismissal), and keep the rest small:
   - **Toast: own.** §4.2 wants one stage-anchored toast with a queue and an `Announcer`, which is a
     few hundred lines. Saves about 9 kB (Base UI Toast is ~10 kB on its own).
   - **Bottom sheet: own drag on top of Dialog.** §4.2 specifies 1:1 tracking, velocity projection and
     a ζ 0.8 flick; Base UI's Drawer costs ~9 kB over Dialog for gestures we would restyle anyway.
   - **Drop tailwind-merge.** Wrappers own their variants, so `cn` can be `clsx` alone. Saves ~9 kB.
2. **Load the overlay layer lazily.** Sheets, menus and the combobox open on demand; a dynamic import
   behind the `ui/` wrappers would keep first load near today's and pay the ~75 kB on first use.
3. **Build all overlays zero-dependency** behind the same wrapper API (the audit's original plan). It
   saves ~75 kB but moves the accessibility risk to us and grows T08 well beyond 4 days.

Recommendation: option 1, with option 2 in T08 if first-load time on the phone matters. The budget is
the controller's call; nothing in T03–T07 depends on it.

### Decision table

| Component | Gates 2–3 | Plan |
| --- | --- | --- |
| Select | pass | Base UI (needs `KitProvider`) |
| Combobox | pass | Base UI |
| Popover | pass | Base UI |
| Menu | pass | Base UI |
| Tooltip | pass | Base UI |
| Dialog / Sheet | pass | Base UI Dialog |
| Drawer (bottom sheet) | pass | own drag over Dialog if the budget holds (gate 4) |
| Toast | pass | own if the budget holds (gate 4) |

No component failed the CSP or touch gates, so none is "own" for those reasons.

## Preflight

Tailwind's preflight was built into the app as an experiment and compared with the stack build
(Chrome 1440, WebKit 390). It changes legacy surfaces that rely on browser defaults:

- the Usage panel's `<h3>` loses its weight and size (`h1`–`h6 { font: inherit }`);
- its lists lose their bullets (`ol, ul { list-style: none }`);
- the composer's "Choose files" button loses its native chip and reads as plain text;
- input placeholders get dimmer (`color-mix(currentcolor 50%)`).

So the preflight joins with T03's `base.css`, where gate 6 compares FS10 and FS24 on the T01 harness and
these four are restyled deliberately.

## Notes for the tasks that build on this

- **Generator:** shadcn 4.21.0 writes `import { cn } from "cn"` and installs the unrelated npm package
  `cn` when `utils` points at `@/ui/cn`. Run it in a scratch project (`pnpm dlx shadcn@4.21.0 add …`
  with the same `components.json`) and port the files by hand, as the spike did. Never run it in the
  repo.
- **Motion:** the generated `animate-in`/`zoom-in-95` classes need `tw-animate-css`. The spike replaced
  them with transitions on Base UI's `data-starting-style`/`data-ending-style`.
- **Touch targets:** the spike's controls use `pointer-coarse:min-h-11`; text inputs use 16 px type on
  coarse pointers so iOS does not zoom.
- **Testing under the CSP in WebKit:** Playwright's WebKit screenshots inject a `<style>` element, which
  the CSP reports. Collect violations before any screenshot, or keep CSP checks in screenshot-free tests.
  Quick scripted typing right after a tap can also race WebKit's delayed click; wait for the popup first.
- **Notices:** Tailwind's MIT banner ships in the built stylesheet. When kit code first ships in `dist`
  (T06), extend `scripts/notices.mjs` to ship the MIT notices of Base UI and Floating UI (and
  tailwind-merge if kept).
