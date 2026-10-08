# Web UI stack: Tailwind 4 and shadcn/ui on Base UI

Results of the T02 stack spike (UI plan, decision D2), measured on 2026-10-08 at `80ac538`.

**Status: not accepted.** Gate 4 (bundle cost) fails, and the JS budget it calls for must be decided
before T06, the first task that ships kit code into the app. See "Gate 4" below.

## What is installed

| Package | Version | Kind | Published |
| --- | --- | --- | --- |
| `tailwindcss` | 4.3.3 | dev | 2026-07-16 |
| `@tailwindcss/vite` | 4.3.3 | dev | 2026-07-16 |
| `@base-ui/react` | 1.8.0 | runtime | 2026-09-04 |
| `clsx` | 2.1.1 | runtime | 2024-04-23 |
| `tailwind-merge` | 3.7.0 | runtime | 2026-09-12 |

All versions are exact and were at least 14 days old at install. One transitive package had a younger
release (`enhanced-resolve` 5.26.0 under `@tailwindcss/node`, published 2026-09-29); the lockfile
resolves it to 5.25.1, and `minimumReleaseAge: 20160` in `pnpm-workspace.yaml` keeps every later
resolution at least 14 days old, so a re-resolve cannot pull 5.26.0 early.
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
- Tailwind scans only `src/ui/`, without tests and `_spike` (`source(none)` plus `@source` in
  `stack.css`). Scanning all of `src/` minted about 20 utilities from legacy prose and identifiers
  (`.hidden`, `.fixed`, `.table`, `.shadow`, …), and its `.sr-only` outranked the legacy rules of the
  same name. A folder is added to `stack.css` when it moves onto the kit; the build test fails if any
  utility shares a name with a legacy class. Biome parses Tailwind directives
  (`css.parser.tailwindDirectives`).
- The shadcn generator's `components.json` lives only in a scratch project; see "Generator" below.
- `stack.css` imports the token layer between Tailwind's theme and its utilities: `tokens.css`,
  `base.css` and `motion.css`; see "Token layer" below. Tailwind's preflight is not used; see
  "Preflight".

## The spike gallery

`src/ui/_spike/` holds the generated components (Button, Dialog, Select, Combobox, Popover, Menu,
Tooltip, Toast, Sheet, Drawer), a `KitProvider`, and a gallery page. The gallery is its own Vite root
(`vite.spike.config.ts`). The app's `index.html` never imports it.

The build test checks two things about the app's `dist`:

- **Gallery isolation:** no gallery text reaches it.
- **No kit libraries yet:** its JS holds no Base UI or tailwind-merge code. The probes are strings each
  library always ships: every Base UI part that renders an element carries its production error URL
  (`base-ui.com`; confirmed for the 13 parts measured below, while the context providers alone carry
  none), and tailwind-merge's class-group table names `overscroll-x`. The same test finds both in the
  gallery's build, so the probes are known to fire. T06 replaces this check with the budget chosen
  under gate 4.

The gallery maps shadcn's semantic colour names (`popover`, `muted-foreground`, `input`, `ring`, …) onto
the UI plan §4.1 roles in `spike.css`. T03 owns the real token layer.

Run the gates: `pnpm --filter @localdot/web exec playwright test e2e/ui-stack-spike.spec.ts` (builds the
gallery, serves it through the daemon's own `serveUi` with the production CSP on a free port, and drives
Chrome and WebKit). Unit check: `pnpm exec vitest run apps/web/src/ui`.

## Gate results

| # | Gate | Result |
| --- | --- | --- |
| 1 | Vite 8.3.1 production build with the Tailwind plugin; layers `theme, base, components, utilities`, legacy CSS in `components` | **Pass.** Built CSS declares `theme, base` (both empty until T03), then the `components` block (all legacy CSS), then `utilities` (empty until the kit uses a utility). Checked by `ui-stack-spike.spec.ts`. App JS is unchanged (only the entry file's name hash, which covers its stylesheet, differs); app CSS grows 57.6 → 57.7 kB (11.6 → 11.7 kB gz), the Tailwind banner and the layer statements. Before/after screenshots of Watch, Settings, Keys, Replay and sign-in (Chrome 1440 and 390, WebKit 1440 and 390) differ only in live content (clock, timer, fake desktop frame). |
| 2 | Zero `securitypolicyviolation` under the production CSP, Chrome and WebKit, for Select, Combobox, Popover, Menu, Dialog, Tooltip, Toast (plus Sheet and Drawer); no library injects `<style>` | **Pass, with one required setting.** Base UI renders an inline `<style>` (a scrollbar-hiding rule) from `Select.Popup`/`Select.List` and `ScrollArea`. Under our CSP that is blocked and reported. `KitProvider` wraps the tree in `<CSPProvider disableStyleElements>` and the kit stylesheet carries the rule (`.base-ui-disable-scrollbar`). With that, every overlay opens and closes with zero violations and zero `<style>` insertions at 1440 and at 390 with touch, in both engines. A negative control (`?inline-styles`) shows the check does catch Base UI's element in both engines. |
| 2b | Scroll lock without injected styles | **Pass.** Base UI locks through CSSOM inline styles on `<html>`/`<body>` (and a `data-base-ui-scroll-locked` attribute). Wheel input does not move the page under an open dialog; the position is restored on close; no `<style>` is added. |
| 2c | Focus trap and return | **Pass** for Dialog, Sheet (Dialog) and Drawer in both engines: Tab and Shift+Tab stay inside (no page element receives focus), Escape closes, focus returns to the trigger. Base UI wraps through focus guards beside the popup for one frame, so tests poll the active element. |
| 3 | WebKit (and Chrome) 390 touch: tap the Select trigger, tap an option, the value commits; no click-through; Escape and outside taps inside an open Sheet close only the popup and keep the Sheet's state | **Pass** in both engines. A button lying under the open list stays at 0 presses after an option is tapped (and counts a direct tap). Inside the Sheet, a non-default choice ("Never ask") is made first; then Escape, a tap on the Sheet outside the list, and a tap on the dim area outside the Sheet each close only the list, and the typed note and that choice survive each one. The same dim-area tap with no list open closes the Sheet. |
| 4 | The kit adds ≤45 kB gz JS and ≤12 kB gz CSS | **CSS pass, JS fail; open.** See below. |
| 5 | Typecheck (TS 7), Biome (`noDefaultExport`), Vitest with jsdom | **Pass.** `KitProvider.test.tsx` renders an open Select in jsdom: no `<style>` with the provider, one without it. |
| 6 | Preflight before/after on FS10 and FS24 | Not run: needs the T01 harness. Measured informally below. |

### Gate 4: bundle cost

Each row is a production build of a page that renders only that piece, minus a React-only page
(67.7 kB gz). JS gzip level 9, kilobytes. Rows that use `cn` give the figure with clsx alone in
brackets.

| Piece | Added JS (gz) |
| --- | --- |
| `cn` (clsx + tailwind-merge) | 8.4 |
| `KitProvider` (CSP, Tooltip and Toast providers) | 4.9 |
| Dialog | 29.1 (20.7) |
| Toast | 18.5 |
| Tooltip | 36.8 (28.5) |
| Tooltip with the CSP and Tooltip providers (T06, inside every `IconButton`) | 37.7 (29.4) |
| Drawer | 37.9 |
| Popover | 43.1 (34.7) |
| Select | 48.9 (40.5) |
| Menu | 51.4 |
| Combobox | 53.1 |
| Checkbox, Switch, RadioGroup and Tabs (T07; no `cn`) | 16.6 |
| ScrollArea (T09; no `cn`) | 6.9 |
| The six overlays together: Select, Combobox, Dialog, Popover, Menu, Tooltip | 83.5 (74.4) |
| First paint: the T06 Tooltip, the four T07 parts and ScrollArea | 53.6 (45.2) |
| The same first paint without Tooltip | 20.8 |
| Every Base UI part §4.2 plans: the six overlays, the four T07 parts, ScrollArea | 96.2 (87.2) |
| Everything in the gallery, demo code included | 101.3 |
| Gallery CSS (preflight, theme, utilities for every piece) | 6.0 |

Roughly 20–25 kB gz of every popup is shared Base UI and Floating UI infrastructure
(`floating-ui-react`, internals, utils). One overlay fits in 45 kB, but any useful set (Select, Dialog and
Popover at least) does not, so the budget cannot be met with Base UI for the core overlays.

Tooltip is first-paint code, not overlay code. §4.2 builds a Tooltip into every `IconButton`, so Base UI
Tooltip and its Floating UI positioning load wherever an icon button renders: 29.4 kB gz with `cn` on
clsx alone, 37.7 kB with tailwind-merge. With T07's fields and T09's ScrollArea, which also render on the
main screens, first paint carries 45.2 kB (53.6 kB) before any overlay opens. Lazy loading cannot move
any of it.

Options, cheapest first:

1. **Raise the JS budget to about 90 kB gz** for every Base UI part §4.2 plans (87.2 kB with `cn` on
   clsx alone): Select, Combobox, Dialog, Popover, Menu and Tooltip (the parts with the hardest
   accessibility work: typeahead, positioning, focus, nested dismissal), plus Checkbox, Switch,
   RadioGroup, Tabs and ScrollArea. Keep the rest small:
   - **Toast: own.** §4.2 wants one stage-anchored toast with a queue and an `Announcer`, which is a
     few hundred lines. Saves about 9 kB (Base UI Toast is ~10 kB on its own).
   - **Bottom sheet: own drag on top of Dialog.** §4.2 specifies 1:1 tracking, velocity projection and
     a ζ 0.8 flick; Base UI's Drawer costs ~9 kB over Dialog for gestures we would restyle anyway.
   - **Drop tailwind-merge.** Wrappers own their variants, so `cn` can be `clsx` alone. Saves ~9 kB,
     all of it on first paint.
2. **Also load the overlay layer lazily.** Sheets, menus and the combobox open on demand; a dynamic
   import behind the `ui/` wrappers moves Select, Combobox, Dialog, Popover and Menu (about 42 kB) to
   first use. First paint still carries 45.2 kB, the whole of today's budget, because of Tooltip, the T07
   fields and ScrollArea. Owning Tooltip as well would bring first paint to about 21 kB.
3. **Build every primitive zero-dependency** behind the same wrapper API (the audit's original plan). It
   saves the ~87 kB, Tooltip's first-paint share included, but moves the accessibility risk to us and
   grows T06–T09, and T08 well beyond its 4 days.

Recommendation: option 1 (with tailwind-merge dropped), plus option 2 in T08 if first-load time on the
phone matters.

**Decide before T06.** T06 is the first task that ships kit code into `dist`: its Tooltip is Base UI
and loads on first paint with every `IconButton` (so option 2 cannot help it), and its `cn` is where
tailwind-merge (8.4 kB) would first ship. T07 then wraps Base UI Checkbox, Switch, RadioGroup and Tabs.
So the JS budget and whether tailwind-merge stays must be settled before T06 starts; T06 work begun
earlier is redone if the choice is option 3. A failed T02 gate is a user decision (UI plan,
Appendix B, item 4), and T02 stays not accepted until it is made. T03 (tokens and base layer) ships no
kit code and can go ahead.

### Decision table

| Component | Gates 2–3 | Plan |
| --- | --- | --- |
| Select | pass | Base UI (needs `KitProvider`) |
| Combobox | pass | Base UI |
| Popover | pass | Base UI |
| Menu | pass | Base UI |
| Tooltip | pass | Base UI, unless the gate 4 decision makes it own |
| Dialog / Sheet | pass | Base UI Dialog |
| Drawer (bottom sheet) | pass | own drag over Dialog, so the budget can hold |
| Toast | pass | own, so the budget can hold |
| ScrollArea | not in the spike | Base UI (needs `KitProvider`); T09 adds it to the CSP check |
| Checkbox, Switch, RadioGroup, Tabs | not in the spike | Base UI (§4.2); they render no `<style>` |

No component failed the CSP or touch gates, so none is "own" for those reasons. Only `Select.Popup`,
`Select.List` and `ScrollArea` (root and viewport) render a `<style>` element in Base UI 1.8.0.

## Preflight

Tailwind's preflight was built into the app as an experiment and compared with the stack build
(Chrome 1440, WebKit 390). It changes legacy surfaces that rely on browser defaults:

- the Usage panel's `<h3>` loses its weight and size (`h1`–`h6 { font: inherit }`);
- its lists lose their bullets (`ol, ul { list-style: none }`);
- the composer's "Choose files" button loses its native chip and reads as plain text;
- input placeholders get dimmer (`color-mix(currentcolor 50%)`).

T03 keeps it out. `src/ui/base.css` carries the part of a reset the kit needs and leaves list markers,
link styling, the display of media elements and the fonts of form controls alone, so the legacy screens
and chat markdown keep their lists, links and file button. Kit components set those themselves; Tailwind
4's border utilities set their own border style, so they do not need preflight's `border: 0 solid`.
The heading reset is T03's own (`h1`–`h6 { font: inherit }`): every legacy heading that relied on the
browser's bold now names its weight (600, the heaviest the type scale allows), and `ui/base.test.ts` fails
on a heading rule that sets a size without a weight.

## Token layer

T03 (UI plan §4.1). Files: `src/ui/tokens.css`, `base.css`, `motion.css`; tests in
`src/ui/tokens.test.ts`, `src/ui/base.test.ts` and `e2e/ui-tokens.spec.ts`.

- **One `@theme static` block.** Every token is a CSS variable from the start, before any utility uses
  it, because the legacy CSS reads them with `var()`. Tailwind's own palette, type scale, radii, shadows,
  eases and breakpoints are cleared (`--color-*: initial` and the like), so kit code can reach only the
  roles: `bg-raised`, `text-fg-2`, `text-body`, `rounded-lg`, `shadow-overlay`, `ease-spring`, and the
  `tablet:`, `laptop:` and `wide:` variants.
- **Custom media stay in the stack bundle.** Lightning CSS resolves `@custom-media` per stylesheet and
  passes an unknown name through, so `--phone`, `--tablet`, `--laptop`, `--wide` and `--coarse` work
  only in files that `stack.css` imports. Any other stylesheet restates the query (as `app.css` does
  with `--rails-collapse`); the unit test fails on a custom media name a file does not define.
- **Appearances.** Two ramps of the same OKLCH lightness steps, `--graphite-*` and `--midnight-*`. The
  roles point into Graphite on `:root` and into Midnight under `:root[data-appearance="midnight"]`.
  Midnight sits at hue 255. Its void and well keep chroma about .02; its raised, raised-2 and overlay
  steps carry about .038, because at .02 they sat .015 from Graphite in OKLab (below a just-noticeable
  difference), so the picker tiles looked the same and choosing Midnight barely changed the page. The
  unit test holds those steps, and the tiles' top band, at least .03 apart. xenon (chroma .12, hue 225)
  still reads as the accent on them. fg-2 and fg-3 are shared, so fg-2 against fg-3 is 1.59:1 in both
  (it was 1.24:1 in the old Midnight). The theme picker's preview tiles read the ramps directly.
- **Modes.** `prefers-contrast: more` brightens fg-2 and fg-3, turns hairlines into field lines, makes
  the HUD solid and widens the focus ring to 3 px. `prefers-reduced-transparency` makes the HUD solid.
  `motion.css` maps every duration into 120–150 ms under reduced motion.
- **HUD alpha .8, not .72.** At .72 the elapsed time (fg-2) on the HUD is 3.4:1 over a white frame; .8
  is the lowest alpha that keeps 4.5:1.
- **Legacy names are aliases** in `theme.css`: `--color-surface` → raised, `--color-surface-2` →
  raised-2, `--color-text`/`-2`/`-3` → fg-1/2/3. `--color-line` maps to the overlay step, not to
  hairline: legacy CSS uses it for dividers and field edges alike, and hairline would leave the Keys
  fields at 1.0:1 against the sheet. It keeps its old place on the ramp, one step above raised-2, until
  its uses split onto hairline and field-line. `theme.css` also keeps the legacy body size (13.5/1.55)
  over the base layer's 13/18.
- **A token is declared once, in `tokens.css`.** A legacy `:root` declaration of the same name sits in the
  components layer and would silently outrank it. The unit test checks the sources; the e2e spec checks
  every colour role as Chrome and WebKit resolve it from the production build, in both appearances, with
  and without more contrast.
- **Stage.** `stage/theme.ts` reads the label font (`--font-ui`) with the colours, so canvas labels use
  the same stack as the page.

## Notes for the tasks that build on this

- **Generator:** shadcn 4.21.0 writes `import { cn } from "cn"` and installs the unrelated npm package
  `cn` when `utils` points at `@/ui/cn`. It would also write CSS variables into the `tailwind.css`
  target and emit `lucide-react` imports. So `components.json` is kept out of the repo: run the
  generator in a scratch project (`pnpm dlx shadcn@4.21.0 add …`) with the config below, and port the
  files by hand, as the spike did. Never run it in the repo.

  ```json
  {
    "$schema": "https://ui.shadcn.com/schema.json",
    "style": "base-vega",
    "rsc": false,
    "tsx": true,
    "tailwind": { "config": "", "css": "src/index.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
    "iconLibrary": "lucide",
    "aliases": { "components": "@/ui", "utils": "@/ui/cn", "ui": "@/ui/_spike", "lib": "@/lib", "hooks": "@/hooks" }
  }
  ```

  When porting, replace the `lucide-react` imports with the vendored icons and `cn` from `@/ui/cn.ts`.
- **Kit stylesheet:** the `.base-ui-disable-scrollbar` rule lives only in `spike.css` today. The app's
  kit CSS must carry it from the task that first ships Select (T08) or ScrollArea (T09), and that task
  adds the part to the CSP check.
- **Every React root inside `KitProvider`:** without it, Select and ScrollArea render a `<style>` the
  CSP blocks. T04's guard can check that each `createRoot(…).render` is wrapped.
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
