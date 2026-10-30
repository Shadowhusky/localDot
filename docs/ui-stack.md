# Web UI stack: Tailwind 4 and shadcn/ui on Base UI

Results of the T02 stack spike (UI plan, decision D2), measured on 2026-10-08 at `80ac538`.

**Status:** gates 1–3 and 5 pass. Gate 4 (bundle cost) failed against 45 kB, and the controller settled it
on 2026-10-08 with a 110 kB gz budget for the kit, overlays and pickers code-split; see "Gate 4" below.
Gate 6 waits for T01's harness.

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
  `@layer theme, base, components, kit, utilities` and brings in Tailwind's theme and utilities. The
  `kit` layer (T06) holds the kit's own component rules; see "Kit atoms" below.
- Every stylesheet outside `src/ui/` (the legacy CSS) is wrapped in `@layer components` at build time by
  the `localdot:legacy-layer` plugin in `vite.config.ts`, so kit utilities override legacy rules and a
  reset stays beneath them. The plugin keeps `@custom-media` at the top level and restates the layer
  order in each file, so import order cannot change it. It goes when T29 deletes the legacy CSS.
- Tailwind scans only `src/ui/`, without tests, `_spike` and `gallery` (`source(none)` plus `@source` in
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
| 4 | The kit adds ≤45 kB gz JS and ≤12 kB gz CSS | **CSS pass, JS fail; decided.** The controller replaced the 45 kB limit with 110 kB gz for the kit, with heavy overlays and pickers code-split (2026-10-08). See below. |
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

**Decision (controller, 2026-10-08, binding).** The 45 kB limit is replaced by 110 kB gz for the kit.
localDot loads over loopback or the tailnet, so a larger kit is acceptable; heavy overlays and pickers
are still code-split so the first paint loads only what it shows. That is option 1 with option 2. It
came after T06 and before T07 started.

**What T06 and T07 shipped.** Neither ships Base UI code or tailwind-merge; app JS is unchanged, because
no screen uses the kit yet, and the build test's "no kit libraries" check still holds.

- T06's atoms, Tooltip included, are zero-dependency and use `clsx` directly, not `cn`. Owning Tooltip is
  option 2's "about 21 kB" first paint.
- T07's drawn controls (Checkbox, Switch, radio cards, segments, tabs) are own by design: native inputs
  and buttons carry their semantics, so Base UI would add first-paint JS for no accessibility gain.
- T07's Select and Combobox are own too. They were written on the premise that gate 4 was still open,
  which it was not. Both pass gates 2 and 3, and the T07 task puts a part that passes on Base UI, so they
  need an explicit ruling: move onto Base UI behind the same props (a lazy chunk of about 40–53 kB gz,
  inside `KitProvider` with `disableStyleElements` and `.base-ui-disable-scrollbar`, keeping the own
  bottom sheet on phones), or stay own. Until the ruling they stay own. Their unit and e2e specs drive
  them only through roles, keys, taps and the gallery, so they carry over to a port unchanged.
- Tooltip has the same open question, without the code-split: it renders on first paint.

### Decision table

| Component | Gates 2–3 | Plan |
| --- | --- | --- |
| Select | pass | own (T07, zero-dependency) until the controller rules; Base UI as a lazy chunk behind the same props is the alternative |
| Combobox | pass | own (T07, zero-dependency) until the controller rules; Base UI as a lazy chunk behind the same props is the alternative |
| Popover | pass | own (T08, zero-dependency) until the controller rules; Base UI as a lazy chunk behind the same API is the alternative |
| Menu | pass | own (T08, zero-dependency) until the controller rules; Base UI as a lazy chunk behind the same API is the alternative |
| Tooltip | pass | own (T06, zero-dependency, first paint) until the controller rules; Base UI behind the same API is the alternative |
| Dialog / Sheet | pass | own (T08, zero-dependency) until the controller rules; Base UI Dialog as a lazy chunk behind the same API is the alternative |
| Drawer (bottom sheet) | pass | own drag, part of the kit's `Sheet` (T08) |
| Toast | pass | own, so the budget can hold |
| ScrollArea | not in the spike | Base UI (needs `KitProvider`); T09 adds it to the CSP check |
| Checkbox, Switch, RadioGroup, Tabs | not in the spike | own (T07): native inputs and buttons carry the semantics, so Base UI would add first-paint JS for no accessibility gain |

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
- **Daylight.** A third ramp, `--daylight-*`, under `:root[data-appearance="daylight"]`, which also
  sets `color-scheme: light` (in `base.css`). Lift reverses: the void (`#f2f3f5`) is the floor, cards
  are white, and raised-2 is a grey tile or bubble. Every white alpha of the dark house becomes the
  same alpha of ink (`rgba(22, 23, 26, …)`); porcelain controls turn to ink faces with white words
  (and a switch's knob to white), so the one primary action stays the strongest thing on the page;
  xenon deepens to `#0b7fae` and amber to `#a8650c` to hold 3:1 on white, red to `#b72c29` to hold
  4.5:1 on its own tint. Glass is light (.8 holds fg-2 at 4.8:1 over a black frame). The curtain is
  pale cloth. What the stage paints over the picture and into a video reads `--color-stage-*`
  (`stage/theme.ts`), which follow the house in the dark appearances and keep Graphite's values in
  Daylight, so dot's marks and an exported video look the same whatever the page.
- **Choosing.** `onboarding/appearance.ts` keeps the choice (`localdot.appearance.v1`: `graphite`,
  `midnight`, `daylight` or `system`; anything else is Graphite, so nobody's page changes under them)
  and, apart, the dark appearance System shows while the device is dark (the dark one chosen last).
  `vite.config.ts` builds `appearance-boot.ts` on its own as a classic script and puts it in the head
  ahead of the stylesheets and the app (the page's policy refuses inline script), so the root's
  `data-appearance` and `color-scheme` are set before any frame is styled, and `theme-color` takes
  the void on the first frame that is; WebKit drew a styled frame before a script placed after the
  stylesheets had run. The app then follows `prefers-color-scheme` and other tabs
  (`followAppearance`). The export page keeps Graphite.
- **Tags.** A conversation's colour tag reads `--color-tag-*` (red, orange, yellow, green, blue,
  purple): one set for both dark appearances, a deeper one in Daylight, each at least 3:1 on the
  house, a lit row and a popover. None is xenon or attention, so a tag never reads as who has the
  computer or as a call for the user. It is a 3 px bar at the row's leading edge (`TagMark`),
  inside the status glyph's box, so it never covers the glyph and moves with it; a corner dot was
  tried and read as an unread badge.
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

## Kit atoms

T06 (UI plan §4.2). Files in `src/ui/`: `Button`, `IconButton`, `Icon` with `icons.ts`, `Kbd`, `Badge`,
`Tooltip` (`useTooltip`), `Spinner`, `Separator`, `VisuallyHidden`, plus `press.ts`, `merge.ts` and
`actions.css`. Unit tests sit beside them; `e2e/ui-atoms.spec.ts` drives the gallery in Chrome and WebKit
under the production CSP.

- **The kit layer.** `actions.css` puts the kit's rules in `@layer kit`, above the legacy `components`
  and below `utilities`. A kit control inside an older screen keeps its look whatever that screen's
  element selectors (`.composer button`, `.settings-sheet button`, …) say, and a caller can still place it
  with a utility. Legacy properties the kit does not set still reach it; the screen tasks remove those
  selectors as they move a screen onto the kit (T04 guard rule 5). The legacy global
  `button:active` rules (`scale(.97)`, and `opacity: .6` under reduced motion) do not reach a kit control:
  the kit holds its `transform` and `opacity`, because either would sink its face (see Targets).
- **Gallery.** The atoms are one gallery page, `AtomsPage` in `src/ui/gallery/`, which brings its own
  styles (`atoms.css`, classes `atoms-*`). Until T01's gallery reaches this branch,
  `vite.kit-gallery.config.ts` builds the page alone (output `e2e/out/kit-gallery`) inside a stand-in
  shell that loads the same legacy styles T01's gallery does; `?appearance=midnight` switches the
  appearance. None of it reaches `dist`. When T01's gallery is here, `AtomsPage` joins its page list and
  the stand-in (`index.html`, `main.tsx`, `shell.css` and the config) goes. Rest, pressed, unavailable
  and busy are on the page as specimens; hover, focus-visible and the open tooltip are live states, so a
  screenshot spec drives them for each shot.
- **Press.** `press.ts` writes `data-pressed` onto the element on pointer-down (and Space), so feedback is
  in the frame the pointer lands, without a render. It lets go when the pointer slides off and returns
  if it comes back. A control up to 120×44 px squeezes (`scale: .97` on its face and content, never on
  the button itself); a wider one only darkens. The plan says 40 px tall; 44 keeps the squeeze on coarse
  pointers, where buttons grow to 44.
- **Unavailable.** `disabledReason` makes a control `aria-disabled` (never native `disabled`), keeps it
  focusable, suppresses its click (and form submission), describes it through a hidden node, and shows
  the reason as a tooltip on hover, keyboard focus, a mouse press or a tap.
- **Tooltip.** Own, about 260 lines: 500 ms delay, then instant for 300 ms after one closes; closes on
  leave, blur, a press elsewhere, resize, Escape (Escape on a focused trigger is consumed so a parent
  layer stays open) and a scroll that can move its trigger: the page's or a scroller's around it, not a
  rail streaming beside it. The popup is `aria-hidden`: the trigger's name or `aria-describedby` already
  carries the text. Positioned with inline styles set through the CSSOM, so the CSP holds, and measured
  again after every render while open, so it stays centred when a label changes under the pointer.
  Grows from the trigger on `--ease-spring`; opacity only under reduced motion. While shown it is the
  topmost layer of T08's stack (see Overlays), so one Escape closes only the tooltip, wherever focus is.
- **Targets.** Buttons reach 6 px past their edge on fine pointers and grow to 44 px on coarse ones;
  icon buttons keep their visual size and reach to 44 px through `::after` at every size. Controls can
  sit closer than their reach, so the fill is drawn on a `::before` face that, with the control's
  content, sits at `z-index: 1`, above every reach at `auto`: a press just inside an edge lands on that
  control, and only the gap is shared. The button itself must never form a stacking context. Anything
  drawn over a control, such as a badge, needs `z-index: 2` (and `pointer-events: none` so taps reach the
  control); a sticky bar or panel that can cover kit controls in the same stacking context needs
  `z-index: 2` or its own stacking context. Today that is the Keys sheet's sticky `.keys-discard` bar,
  for T20.
- **Icons.** 37 Lucide 1.31.0 outlines (the plan's list, `search` for T07's Combobox and
  `chevron-left` for a sheet's Back), drawn at 16 px with a 1.5 px stroke at any size. The licence is
  in `vendor/lucide/LICENSE`.
- **Utilities minted by accident.** Words in kit sources mint `.grid`, `.hidden` and `.resize` into the
  app's utilities. No legacy class uses those names (the build test checks), so they are inert.
- **Cost.** App CSS grows 63.1 → 72.4 kB (13.1 → 14.9 kB gzip, as Vite reports it); app JS is
  unchanged.

## Fields and choices

T07 (UI plan §4.2), with T08's Select and Combobox brought forward because the provider and model
pickers need them. Files in `src/ui/`: `Field`, `TextField`, `TextArea`, `MoneyField`, `Checkbox`,
`Switch` (sharing `choice.tsx`), `RadioCards`, `SegmentedControl`, `Tabs`, `Select`, `Combobox`, and
their parts `listbox.ts` (search, highlight, typeahead), `Listbox`, `PickerPopup` and `picker.ts`;
styles in `fields.css` and `pickers.css`, in the kit layer. Unit tests sit beside them;
`e2e/ui-fields.spec.ts` drives the gallery's Fields page (`?page=fields`) in Chrome and WebKit, on a
desktop and on a touch phone, under the production CSP. No screen uses them yet; T19 moves Settings.

- **Zero-dependency, like the atoms.** Nothing here ships Base UI; "What T06 and T07 shipped" above
  says why, and which ruling Select and Combobox wait on. Checkbox, Switch and radio cards are native
  inputs under a drawn control (the input lies over the drawing, so touch exploration finds it where it
  shows); segments and tabs are buttons with roving focus. Select and Combobox follow the ARIA combobox
  pattern with `aria-activedescendant`, so focus stays on the trigger or the search field.
- **Field.** Label above (footnote 500, fg-2), and one message cell below: the description, an error
  (with an alert glyph, never colour alone) and an unavailable reason share it, so swapping one for
  another moves nothing under the field. A Field that can show an error (`validates`, on whenever an
  `error` prop is passed, even an empty one) holds that cell open at one line before any message
  exists, so the first error moves nothing either; an error longer than a line still grows it. The
  control takes its id, label, description, `aria-invalid` and availability from the Field. A click on
  the label focuses the control and never opens a picker.
- **Unavailable** follows the atoms: `aria-disabled`, focusable, a reason in place of the description
  (text fields become read-only; a segment gives its reason as a tooltip). React still reports the
  change of a checkbox whose click was cancelled, so the choice hook drops it.
- **Sizes.** Fields are 32 px, 36 in a sheet (`size="lg"`), and 44 on a coarse pointer, where text is
  17 px (the system reading size, which also keeps iOS from zooming a focused field). Choice rows,
  radio cards, segments and picker triggers reach 44 on touch; sheet rows are 48.
- **Motion.** The switch knob springs and stretches toward its side while held; the check draws in;
  the segmented thumb slides on `--ease-spring` and, being a CSS transition, an interruption sets off
  from where it is (the spec samples it every frame and finds no step over half a segment a frame,
  weighing a step by the frames it spans, so a dropped frame is not a jump). A popover
  grows out of its trigger and shrinks back faster; a sheet rises from the bottom and leaves the same
  way. Under reduced motion every one of these is an opacity change or a cut.
- **Pickers.** A mouse opens the list on press, so press, drag and release on a row chooses it, as a
  desktop pop-up menu does; a tap opens it on release, so a scroll that starts on the trigger never
  does. A row is chosen on release (or on a click from assistive technology), and the closing surface
  keeps taking taps until it is gone, so the click a touch sends afterwards never reaches the page.
  Escape and a press outside close only the list and are kept from whatever is beneath it: a sheet that
  closes on Escape stays open, and an outside press is spent whole (its `pointerup`, mouse events and
  click are swallowed until the next press or key), so a backdrop that closes on a click never sees it
  and a button under the press is not activated. While an input method composes, Enter and Escape are
  its own: neither chooses, closes or reaches a parent. On a phone (`width < 760px` and a coarse
  pointer) the list is a bottom sheet with a grabber and a close button; its head follows a drag 1:1
  and a release projected past a third of its height (deceleration .998) closes it, while a finger that
  stopped before lifting carries no speed. A flung sheet leaves within `--dur-sheet`, so it is gone
  before the surface unmounts. The Combobox adds a search field (every word must match the label, keywords or value;
  matches are marked), can offer the typed text as a value of its own, pinned last, and never moves
  the search field while the list filters: a popover below its trigger is anchored at the top, one above
  it holds its height, and the phone sheet is full height. Focus returns to the trigger after React's
  commit, which would otherwise hand it back to a search field it saw focused.
- **Legacy press rule.** `theme.css` scales any pressed `<button>` to .97. The picker trigger and the
  segments hold `transform: none`: in WebKit the rule shrank the trigger just as the list measured it
  to open, and the popover came out 3 % narrower than its trigger.
- **Gallery.** The stand-in gallery has a page switch (Atoms, Fields, Overlays); `parts.tsx` holds the shared
  section and specimen frames. The Fields page has a stand-in settings panel that closes on Escape or a
  click on its dimmed backdrop, to show the list keeping both from it, and RadioCards stands in for the
  theme picker. The page shows live specimens only; still hover, pressed and focus-visible specimens,
  and the `ui-<primitive>` VR baselines, wait for T01's gallery and harness.
- **Forced colours.** Field edges, checks, switches, chosen cards and segments, the focused field or
  trigger (a Highlight outline, since the ring is a shadow the mode drops), the chosen row's check
  (Highlight) and unavailable rows and fields (GrayText) all keep their state.
- **Utilities minted by accident.** Kit sources now also mint `.block` (`.fixed` and `.transition` are
  kept out by `stack.css`, see "Overlays"). No legacy class or markup uses that name, so it stays inert.
- **Cost.** App CSS grows 74.2 → 93.3 kB (15.4 → 18.1 kB gzip, as Vite reports it); app JS is
  unchanged, since no screen imports the kit yet. The review fixes (the held message line and the
  forced-colour states) add 0.4 kB (94.5 → 94.9 kB, 18.4 kB gzip, on top of the approval-card work
  merged since). `stack.css` loads `fields.css` and `pickers.css` on first paint for now; when the first
  screen adopts the pickers, `pickers.css` moves into their code-split chunk, per the gate 4 decision.

## Overlays

T08 (UI plan §4.2). Files in `src/ui/`: `LayerStack.tsx` (the stack, `useLayer`, `useExit`,
`LayerPortal`), `Sheet.tsx` with `sheet-drag.ts`, `Dialog.tsx`, `Popover.tsx` (also `Anchored`, the base
of every anchored popup, and `triggerProps`), `Menu.tsx`, `focus.ts`, `scroll-lock.ts`, `position.ts`,
`scrim.ts`, `media.ts`, `finished.ts` and `overlays.css`. Unit tests sit beside them; `e2e/ui-overlays.spec.ts` drives the gallery's Overlays
page (`?page=overlays`) under the production CSP in Chrome and WebKit, at 1440 and at 390 with touch.

- **Own, zero-dependency, until the controller rules.** Gate 4 was settled before this work began (110 kB
  gz for the kit, overlays and pickers code-split; see "Gate 4"), but the overlays were written on the
  premise that it was still open, so they ship no Base UI code. They need an explicit ruling: stay own, or
  move Dialog, Popover and Menu onto Base UI behind the same API as a lazy chunk, keeping the own
  bottom-sheet drag. For own: one stack already routes Escape, focus and stacking across the kit's
  Tooltip, the discard prompt, nested pages and menus inside sheets, which Base UI's dismissal would have
  to be bridged to; and Sheet, Dialog, Popover and Menu add 7.3 kB gz to the app (minified, over the
  atoms, with `@localdot/stage` and zod already loaded), against 20–51 kB gz for each Base UI part. For
  Base UI: it carries the accessibility risk D2 gives it, and §4.2 asks every primitive to wrap it. The
  unit and e2e specs drive the overlays through roles, keys, taps and the gallery, so they carry over to
  a port.
- **Pickers open through this stack.** Select and Combobox must register with it (`useLayer`, so a
  search field inside a trapping sheet counts as inside the topmost layer), use `Anchored` for the desktop
  popup and `Sheet` (or `attachSheetDrag` with the shared scrim and `lockScroll`) for the phone sheet,
  and draw with these class names rather than a second `.ui-popover` or `.ui-sheet`. A popup outside the
  stack loses focus to a trapping sheet beneath it, because the stack pulls focus that leaves the topmost
  trapping layer back in; then Enter lands on the sheet's close button. Once a listbox sits in a layer of
  its own, `lib/dismiss.ts` must stop treating it as a native picker that keeps Escape. Until then
  the pickers draw `.ui-picker-popover` and `.ui-picker-sheet`, so neither set of rules reaches the
  other's surfaces.
- **One stack.** Every open overlay, and a tooltip while shown, registers with the stack. One document
  `keydown` listener sends Escape to the topmost layer only. It leaves alone an Escape that something
  already handled, or that a native `select` or a listbox owns (`lib/dismiss.ts`). Escape in a menu
  inside a sheet closes the menu; Escape over a tooltip closes the tooltip. A sheet beside the page hears
  Escape only from inside it (or with nothing focused), so the page's composer and fields keep theirs.
- **Focus.** A modal sheet, a dialog and a popover keep Tab inside: they wrap at the ends and pull back
  focus that escapes (Safari tabs past the last field into the page). A menu closes on Tab. Opening
  focuses the sheet's first field (on fine pointers only, so a phone keeps its keyboard down), the
  dialog's first and safe choice, the popover's first control, or the menu's first item when it was
  opened from the keyboard (otherwise the menu itself, until an arrow key or the pointer). Closing puts
  focus back on the opener, `returnFocus` or the anchor, unless the user moved it elsewhere. The opener
  is taken once, on opening: a sheet that changes kind while open (widened from bottom sheet to
  inspector) registers again, by when focus is already inside it. That return
  runs in a passive effect: React restores focus to the element that had it when a commit began, which
  undoes a focus change made in a layout effect's cleanup.
- **Dismissal never loses edits.** With `dirty`, Escape, the close button, the dim area and a swipe show
  "Discard unsaved changes? · Keep editing · Discard" in a bar that covers the footer, so nothing moves;
  Escape again keeps editing. The footer and the bar hand over in turn (each fades out before the other
  fades in), so the two rows of buttons never show through each other. The dim area closes a sheet or dialog only on a click that both starts and
  ends on it. A mouse press there keeps focus inside; a touch's pointerdown is never cancelled, because
  WebKit then drops the tap's click.
- **Outside presses.** Popovers and menus lie on a transparent catcher, so a press outside only closes
  them and never reaches the control beneath, and a tap's late click has nowhere to land. Items commit on
  click. A closing layer stays mounted until its exit transitions have finished (`finished.ts` reads
  them, ignoring endless ones such as a spinner, and stops waiting after 1 s), so no JS copy of a duration
  token can cut an exit short; then it stays while a press is still down (at most 1 s more).
- **Modal or beside.** A modal sheet dims the page, traps focus and locks scroll; one beside the page
  does none of these. By default an inspector sits beside the page, so the HUD's Stop and incoming
  approvals stay in reach while Settings is open (§4.2), and a bottom sheet, which covers a phone, is
  modal; `modal` overrides either. A sheet beside the page has no dim area to dismiss it by.
- **Triggers.** `triggerProps("menu" | "dialog", open)` gives the control that opens a menu or popover
  its `aria-haspopup` and `aria-expanded`; the latter also keeps it lit while open. The control still
  passes its ref as `anchor`. A popover holds Tab, so it is `aria-modal`.
- **Scroll lock.** Inline styles through the CSSOM on `<html>` (`overflow: hidden`, `data-scroll-locked`)
  and body padding for a classic scrollbar, reference-counted. No `<style>` element.
- **Stacking.** Each layer is a fixed `.ui-layer` (z-index 50, like the tooltip) in its own portal in
  `body`, so later layers paint above earlier ones. Kit controls raise their faces to z-index 1, so each
  sheet region is its own stacking context (`isolation: isolate`) and the prompt can cover the footer.
  A modal opened over another pushes the lower one back (scale .97).
- **Motion.** Popovers and menus grow from their anchor (`transform-origin`), starting 4 px toward it.
  They are inserted holding that start state with no transition (`data-placing`), placed, then let go:
  `@starting-style` would fix the start at the first style flush, before the flip to the other side is
  known. The side sheet slides 24 px and fades in on `--ease-spring`; the bottom sheet rises from 100%
  on `--ease-spring` and leaves on `--ease-exit`. Exits retrace the entrance. Every movement is scaled
  by `--_motion` on `.ui-layer`, which reduced motion sets to 0, leaving opacity alone.
- **Bottom sheet drag.** Any pointer picks a sheet up by its grips (`data-sheet-grip`, `touch-action:
  none`): the grabber strip and the header below it, together at least 52 px tall; a press on a button,
  link, field or tab there stays the control's. A finger or pen also moves it by its content, as an iOS
  sheet does, and its first move decides (the browser commits to scrolling on the first touch move it is
  not stopped on): up, while the sheet rests below its top height (Activity's medium, a collapsed
  question), raises the sheet; down, once everything that scrolls under the finger is at its top, lowers
  it; any other move, sideways included, scrolls the content. A mouse on the content selects text. There
  is no hand-over within one gesture: a sheet raised to its top stretches rather than scrolling on. Past
  10 px of slop it follows the finger 1:1 from where it was grabbed; pulled up past rest it stretches by a
  rubber band that never exceeds the 48 px of surface below the screen's edge. A release is projected with
  deceleration .998: past 30% of the height it closes, otherwise it springs to the nearest height, with
  the release velocity handed to a closed-form spring from `@localdot/stage` (ζ 1, or ζ .8 after a
  flick). A sheet that may not close (a question, or unsaved changes, which ask) also rests at the height
  nearest its landing. A sheet still moving can be grabbed again from where it is. Moves are followed on
  the window, since the first ones can leave the sheet before the drag takes the pointer. The question
  sheet counts only an inset of 120 px or more as a keyboard, and reads it as a drag lets go, so Safari's
  toolbars resizing the viewport neither drop a drag nor force the sheet to full height.
  `e2e/ui/sheet-drag.spec.ts` drags the grips in both engines but the content only in Chromium:
  Playwright's WebKit sends no touch moves.
- **Nested pages.** `page` names the page on show and `back` gives it a Back above its title. A new
  page slides 24 px in from the right over the old one, which slides 24 px left and fades; Back runs the
  same path the other way. The pages a nested page was opened from stay mounted under it, faded out and
  inert, in the order they were first shown (a DOM move would drop scroll and focus), so Back finds each
  as it was: its state, its scroll position, and focus on the row that led on. A new page takes focus
  (its first field, else Back). A page is "back" when it is one of those held, so any depth unwinds one
  page at a time. A bottom sheet eases between the pages' heights. Escape and the close button still
  dismiss the whole sheet.
- **Phones.** `side="auto"` is a bottom sheet under 760 px. Menu rows grow to 44 px on coarse pointers
  and hide their shortcuts on touch screens. A menu item without an icon keeps its label in line with
  the items that have one. The sheet body keeps a stable scrollbar gutter, so its content does not shift
  when it first overflows under a classic scrollbar.
- **Cost.** App CSS 73.5 → 85.1 kB (15.1 → 16.5 kB gzip); app JS is unchanged, because no screen uses
  the overlays yet. `stack.css` keeps `container`, `fixed`, `visible`, `inline` and `transition` (words
  in the kit's prose) from minting utilities.
- **Gallery.** The stand-in gallery switches pages with `?page=overlays` and loads `@localdot/protocol/csp`
  first, as the app does: the sheet's spring comes from `@localdot/stage`, which brings zod, whose
  `Function` probe the CSP otherwise reports.
- **Visual baselines.** `e2e/ui/overlays.spec.ts` runs on T01's harness over the Overlays page of its
  gallery (`/gallery/#overlays`) and keeps `ui-sheet-inspector` (c14), `ui-sheet-bottom` (w39) and
  `ui-dialog-destructive` (both).
- **Not yet.** Select and Combobox drawn on `Anchored` and `Sheet` (see "Pickers open through this
  stack"; they already register with it while open, so a trapping sheet leaves their focus alone), with T08's
  Playwright scenarios (a), (b) and (f) and the `ui-select-*` and `ui-combobox-search` baselines.
  G3a on iOS Safari: Playwright's WebKit sends no touch moves, so a content drag from the top, the
  `<html>` scroll lock against rubber-banding, the fixed bottom sheet with the keyboard up and the 48 px
  bleed have been seen only in Chrome's touch emulation.

## Feedback

T09 (UI plan §4.2), the feedback half: toasts, banners, progress, meters, skeletons, empty states and
the page's one announcer. Files in `src/ui/`: `Announcer.tsx`, `Toast.tsx` with `toasts.ts` (the
queue) and `toast-swipe.ts`, `Banner.tsx`, `Progress.tsx`, `Meter.tsx`, `Skeleton.tsx`,
`EmptyState.tsx`, and `feedback.css` in the kit layer. Unit tests sit beside them;
`e2e/ui-feedback.spec.ts` drives the gallery's Feedback page (`?page=feedback`) in Chrome and WebKit,
on a desktop and on a touch phone, under the production CSP, and `e2e/ui/feedback.spec.ts` keeps the
`ui-toast`, `ui-toast-expanded` and `ui-feedback` baselines at c14 and w39. Zero-dependency, like the
rest of the kit. No screen uses them yet. `feedback.css` adds 1.9 kB gz to the app's CSS.

- **Announcer.** `announce(channel, text, urgency?)` and `<Announcer />`, mounted once near the root:
  the page's only polite region and its only alert region. One polite announcement at most every
  1.5 s; a newer message on a channel replaces one still waiting there (the HUD's status on one
  channel never queues stale states), and channels take turns. `assertive` is for errors that stop
  work and is never held back. Text repeated on purpose gets a trailing no-break space, so it is
  heard again. `withdraw(channel)` drops what still waits on a channel: a toast dismissed before its
  turn is not read out after it has gone.
- **Toasts.** `showToast({ id?, title, description?, tone?, action?, persist?, urgency? })` and
  `dismissToast(id)`; `<Toaster anchor={hudRef} />` renders them. The Toaster is absolutely
  positioned in its anchor's positioned box (the stage frame), 8 px under the anchor and centred on
  it, 360 px wide or the box less 16 px a side, so a toast never moves anything. Mount one Toaster.
  While a toast is up the anchor is measured every frame, so the stack follows it however it moves
  (a transform, a sibling's change), and an anchor mounted late is picked up.
  - Layers: the Toaster sits at `--layer-toast` (10), over every control's face (1) and anything drawn
    on a control (2), so where an opened stack hangs past a short phone stage it covers the page and
    takes every press inside it. The HUD it hangs from takes `--layer-hud` (11), so a toast swiped
    up goes back under it; the stage's other parts stay under 10. The stage frame must not form a
    stacking context of its own (no `z-index`, transform, filter, `opacity` below 1 or `isolation` on
    it), or the toasts cannot rise over the page around it. Overlays (50) and pickers (60) cover them.
  - Newest in front; the front one and the edges of two behind it show, each step back 5% narrower
    and a little lighter, the rest wait. Only the front toast's time runs (4 s), so each is read in
    turn; a `danger` toast persists unless told otherwise. Time stands still while the stack is
    hovered, holds focus, is opened by a tap, is being swiped or pressed, or the page is hidden.
  - Nothing moves under a pointer or a finger. While the stack is held (hovered, focused, opened by a
    tap, swiped, or pressed until the press's click is handled), the toasts on it keep their places:
    one that arrives meanwhile is read out at once and joins the stack, in front, when it is let go.
  - Hover or focus lays the stack out into a column (8 px apart); on touch a tap does, and a press
    elsewhere closes it. Behind toasts are inert until then. The words of a card that comes out from
    behind, laid out or handed the front, start at once on `--ease-enter`, and a card going behind
    covers its words on `--dur-press`.
  - Showing again under an `id` replaces that toast where it is and brings it to the front: an action
    such as "Check again" can turn "Couldn't confirm the stop" into "Stopped" in place. Each toast has
    a `key` for its element; it stays through an update in place, and a toast shown again while its
    old element is still being swiped off gets a new one, so it comes back whole.
  - A toast is read out through the Announcer when shown, politely unless `urgency: "assertive"` (an
    error that stops work); the stack itself is a labelled region, not a live one. Escape on a focused
    toast dismisses it and goes no further. Focus in a toast that goes, by Escape, Dismiss, its action
    or a swipe, moves to the next toast, or with the last one back to where it came into the stack
    from, or else to the anchor (itself, or its first control). The close button is always there;
    buttons keep a 28 px face and reach 44 px on touch (the toast's end padding is 10 px there, so
    its rounded clip leaves the close button its whole reach), so a toast stays 44 px tall. A
    description beside an action wraps in balanced lines.
  - Motion: it grows down out of the anchor (8 px, scale .96, blur 4 px to sharp) on the spring and
    leaves back into it on `--ease-exit`, sinking under the cards that slide up. Swipe: sideways or up,
    10 px of slop, then 1:1 from the grab point (down gives by a rubber band); a release projected
    (d = .998) past 40% of the width or half the height carries on out at the release speed on
    `springValue` from `@localdot/stage`, otherwise it springs home and can be caught on the way.
    Under reduced motion it only fades.
  - The surface is the HUD material at its solid strength (`--color-hud-solid`, blur 20 px), since a
    toast hangs over the picture. Playwright's WebKit draws no `backdrop-filter`, so its screenshots
    show the picture faintly through; Safari blurs it.
- **Banner.** `tone: neutral | attention | danger`, `title`, detail as children, small-button
  `actions` (beside the text from 480 px wide, under it below that), `onDismiss`, `open` and
  `announce`. It stays mounted: closing folds it to nothing (`grid-template-rows` 1fr → 0fr) and
  makes it inert, opening unfolds it and slides what follows down, so keep it mounted and toggle
  `open` rather than rendering it conditionally. Spacing around it belongs inside the part that folds
  (a margin on `.ui-banner`), or a gap stays behind when it is closed. Attention is a 1 px rim, danger
  a tinted fill with an alert glyph, never colour alone. `announce` reads it out each time it opens.
  Closing while it holds focus (its own dismiss, or an action that closes it), it first gives focus
  back to where focus came into it from, or else to the control before it, and only then goes inert.
  Beside the actions, the close button lines up with them.
- **Progress.** `label`, `value`, `max`, `valueText`, `variant: bar | ring`, ring `size: 16 | 20 | 24`.
  The bar is 4 px, its fill sliding along the track; without a value a 30% stretch sweeps along a
  2 px line in the same 4 px, so a bar that learns its length moves nothing. The ring's arc draws from
  twelve o'clock over a 25% track; complete, it brightens and draws a check (the download button's
  ring → check → toast). Of unknown length the arc turns alone, with no track, so it never reads as a
  share. Reduced motion: both stand still, the line drawn whole in fg-3 and the arc where it stands.
- **Meter.** `label`, `value`, `max` (100), `valueText`: the label and the amount over a 4 px bar. From
  90% the fill turns fg-1 and the amount reads "Almost at limit · …", in words and in the meter's
  value text. `role="meter"` on a drawn bar, since a native `meter` draws differently in each engine.
  In forced colours every fill, near the limit too, is CanvasText.
- **Skeleton.** `loading`, `shape: text | block | circle`, `width`, `height`, `lines`, children. A text
  line is one line of the surrounding type tall (`1lh`) with a bar about cap height, so it takes the
  content's own type and the room is the same before and after; blocks take `width` and `height`.
  The bones appear only if loading lasts 200 ms, one sweep of light crosses every bone on the page
  together, and when the content arrives it fades in over the fading bones in the same grid cell.
  Loading again, the content last shown stays (even if the caller has nothing to show meanwhile) and
  the skeleton is `aria-busy`; a reload under 200 ms changes nothing on screen, and a longer one
  crosses to the bones at 200 ms and back when the new content arrives, so something always shows.
  A Skeleton is a block (`display: grid` on a span): for a value inside a sentence ("resets in …"),
  wrap it in an element of its own that sits in the line, such as an `inline-block` span with a width.
- **EmptyState.** `title`, detail, `icon`, `actions`, `layout: center | start`: centred in the room a
  list would fill, or a quiet line in fg-3 where the list starts ("What would you like done?"). Show it
  once loaded and empty; while loading, a Skeleton.
- **Not here.** StatusGlyph, Disclosure and ScrollArea are L9's (`structure.css`). The status lamp is
  not in §4.2; the `Badge` dot covers a lamp, and T12 removes the top bar's Live / Not live lamp.
  `Presence`, `useFlip` and `useSpringValue` were not needed: entrances use `data-entering` or
  `@starting-style`, the stack is laid out with CSS variables, and the swipe uses `springValue`
  directly.
- **Wiring (T12 and on).** Mount `<Announcer />` once at the root and move the HUD's, the
  conversation's and the caption's live regions onto `announce`. Mount `<Toaster anchor={hud} />`
  inside the stage frame, and give the HUD `z-index: var(--layer-hud)`, so a toast swiped up goes back
  under it (see Layers above). The
  decision card (T18) hangs from the same place; show one or the other. Replace `<progress>` in
  `export/ExportSheet.tsx` and `settings/ChatgptPanel.tsx` with `Progress`. The usage popover
  (`agent/UsageFooter.tsx`) already draws each plan window with `Meter`, its name as the label and
  "N% used" as the value, and only the reset time under it.

## Guards

T04 (UI plan). `apps/web/scripts/ui-guard.mjs` reads the web sources and fails on anything that goes
around the design system. It runs in `pnpm lint`, alone as `pnpm check:ui`, and as a Vitest suite
(`ui-guard.test.mjs` beside it) in `pnpm test`; a full scan takes about 0.4 s.

| Rule | Fails on |
| --- | --- |
| `raw-colour` | `#hex`, `rgb()`, `hsl()`, `oklch()` and other colour functions in CSS or a script string; a named colour in a colour property |
| `undeclared-token` | `var(--x)` where no token, legacy alias, script (`setProperty`, a style key) or the same stylesheet declares `--x` |
| `token-fallback` | `var(--x, …)`; a private `--_x` may fall back |
| `type-literal` | a literal `font-size`, `line-height` or `font` size; a weight outside 400, 500 and 600; a bare `leading-6` utility |
| `half-pixel` | any `.5px` length |
| `radius-literal` | a radius in px, rem or em |
| `motion-literal` | a literal duration in a transition or a finite animation; `ease*`, `cubic-bezier()`, `steps()` or `linear()` in a transition or animation; a time or an easing in a custom property; a `duration-300` or `delay-150` utility |
| `spacing-literal` | a margin, padding or gap in px or rem beyond a 1–2 px optical nudge |
| `arbitrary-value` | a Tailwind arbitrary value, variant or property (`min-h-[44px]`, `data-[open]:…`, `[&>svg]:size-4`, `[mask-type:luminance]`) |
| `control-selector` | a `button`, `input`, `select` or `textarea` element selector outside `src/ui/` |
| `base-ui-import` | `@base-ui/react` imported outside `src/ui/` |
| `native-control` | `<button>`, `<input>` (but hidden), `<select>`, `<textarea>`, `<progress>`, `<meter>`, `<dialog>` or `<details>` outside `src/ui/` |
| `native-disabled` | native `disabled` on a form element outside `src/ui/` |
| `csp-inline` | a `<style>` or inline `<script>` element, `setAttribute("style")`, `createElement("style")`, markup with a `style` attribute in a string, or any of these in an HTML page; the page's policy blocks them all |
| `stray-stylesheet` | a stylesheet outside `src/ui/`, the galleries and the sheets the UI plan names: `src/dot/dot.css` (T24) and, in `src/shell/`, `stage-frame`, `hud`, `layout`, `bar`, `rails`, `phone`, `conversation` and `decision.css` (T11–T18) |
| `banned-copy` | a word from `src/copy/banned.ts` in a string a screen can show |

- **Scope.** The HTML pages and `src/**/*.{css,ts,tsx,html}`, without tests, `src/testing/` and the spike.
  The token layer (`src/ui/tokens.css`, and `src/ui/motion.css` for reduced motion) is the one place raw
  values live. The kit may style and render native controls.
- **Parameters.** A custom property that only one stylesheet declares (`--_pad`, `--_h`) is read
  through: the spacing, radius and type rules check every value the stylesheet gives it, and every
  `var()` fallback. A literal in a JSX `style` object is checked like a declaration, a number as px;
  a computed value passes.
- **Ratchet.** `apps/web/scripts/ui-guard-baseline.json` gives each legacy file the count it may hold of
  each rule; more fails. A count that falls fails too, until it is written down with
  `pnpm check:ui --update`, which only ever lowers counts, so a fix cannot be undone quietly. Raising a
  count is a hand edit a reviewer sees. The kit is never on the baseline (a test holds this), and T29
  deletes the file.
- **Copy.** A string counts as copy when it is JSX text, a string prop other than class names, ids and
  other code attributes, or a literal that reads like prose (it has a space or starts with a capital).
  Comparisons, `switch` cases, literal types, selectors, class lists, attribute names, `console`
  calls and the URLs given to `fetch` and `new URL` are code; `defaultValue` is copy. Words are matched
  whole, so `cell-row`, `/api/cells` and `obj.session` pass. "verified", "unconfirmed" and "retained"
  are banned only in headings and on buttons, including the elements inside them. A link's `href` and
  a selector are not read for hex colours, so `#feed` passes there. The check covers `.ts`
  modules as well as `.tsx`: most of the jargon people meet (`cells/errors.ts`, `keys/keys-api.ts`) is
  built there. The galleries are exempt.
- **Allowed on purpose.** The period of an `animation` item that says `infinite` (a spinner's loop is
  not an enter or exit) and a delay may be literal where they are used; a custom property outside the
  token layer may hold neither a time nor an easing. `linear` is a keyword, not a curve. Spacing allows
  a 1 or 2 px nudge for optical alignment.
- **Why in `scripts/`.** Tailwind scans `src/ui/`, and the rule tables would mint utilities there; the
  checker is Node tooling, like `notices.mjs`. It parses scripts with Vite's own parser (`parseSync`),
  so it adds no dependency.
- **Kit cleanup.** The `::selection` colour became a token (`--color-selection`) and the summary chevron's
  gap `calc(var(--spacing) * 1.5)`, both the same values as before; the screen baselines at c14 and w39
  still match.

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
  kit CSS must carry it from the task that first ships a Base UI Select (T07's own Select needs none) or
  ScrollArea (T09), and that task adds the part to the CSP check.
- **Every React root inside `KitProvider`:** without it, Base UI's Select and ScrollArea render a
  `<style>` the CSP blocks. T04 left this check out, because no Base UI part ships outside the spike
  yet. The task that ships the first one (T08 on L8, or T09's ScrollArea on L9 if it lands first) adds
  a guard rule that each `createRoot(…).render` is wrapped.
- **Motion:** the generated `animate-in`/`zoom-in-95` classes need `tw-animate-css`. The spike replaced
  them with transitions on Base UI's `data-starting-style`/`data-ending-style`.
- **Touch targets:** the spike's controls use `pointer-coarse:min-h-11`; text inputs use 16 px type on
  coarse pointers so iOS does not zoom.
- **Testing under the CSP in WebKit:** Playwright's WebKit screenshots inject a `<style>` element, which
  the CSP reports. Collect violations before any screenshot, or keep CSP checks in screenshot-free tests.
  Quick scripted typing right after a tap can also race WebKit's delayed click; wait for the popup first.
- **Notices:** Tailwind's MIT banner ships in the built stylesheet. When kit code first ships in `dist`
  (the first screen moved onto the kit; T06 ships none), extend `scripts/notices.mjs` to ship Lucide's
  licence (`vendor/lucide/LICENSE`) and, if Base UI is used, the MIT notices of Base UI and Floating UI.
