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
| Popover | pass | Base UI |
| Menu | pass | Base UI |
| Tooltip | pass | own (T06, zero-dependency, first paint) until the controller rules; Base UI behind the same API is the alternative |
| Dialog / Sheet | pass | Base UI Dialog |
| Drawer (bottom sheet) | pass | own drag over Dialog, so the budget can hold |
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
  Grows from the trigger on `--ease-spring`; opacity only under reduced motion. Escape while a hovered
  tooltip is open and focus is elsewhere also reaches the page; T08's `LayerStack` makes the tooltip the
  topmost layer so one Escape closes only it.
- **Targets.** Buttons reach 6 px past their edge on fine pointers and grow to 44 px on coarse ones;
  icon buttons keep their visual size and reach to 44 px through `::after` at every size. Controls can
  sit closer than their reach, so the fill is drawn on a `::before` face that, with the control's
  content, sits at `z-index: 1`, above every reach at `auto`: a press just inside an edge lands on that
  control, and only the gap is shared. The button itself must never form a stacking context. Anything
  drawn over a control, such as a badge, needs `z-index: 2` (and `pointer-events: none` so taps reach the
  control); a sticky bar or panel that can cover kit controls in the same stacking context needs
  `z-index: 2` or its own stacking context. Today that is the Keys sheet's sticky `.keys-discard` bar,
  for T20.
- **Icons.** 36 Lucide 1.31.0 outlines (the plan's list, and `search` for T07's Combobox), drawn at
  16 px with a 1.5 px stroke at any size. The licence is in `vendor/lucide/LICENSE`.
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
- **Gallery.** The stand-in gallery has a page switch (Atoms, Fields); `parts.tsx` holds the shared
  section and specimen frames. The Fields page has a stand-in settings panel that closes on Escape or a
  click on its dimmed backdrop, to show the list keeping both from it, and RadioCards stands in for the
  theme picker. The page shows live specimens only; still hover, pressed and focus-visible specimens,
  and the `ui-<primitive>` VR baselines, wait for T01's gallery and harness.
- **Forced colours.** Field edges, checks, switches, chosen cards and segments, the focused field or
  trigger (a Highlight outline, since the ring is a shadow the mode drops), the chosen row's check
  (Highlight) and unavailable rows and fields (GrayText) all keep their state.
- **Utilities minted by accident.** Kit sources now also mint `.fixed`, `.block` and `.transition`. No
  legacy class or markup uses those names, so they stay inert.
- **Cost.** App CSS grows 74.2 → 93.3 kB (15.4 → 18.1 kB gzip, as Vite reports it); app JS is
  unchanged, since no screen imports the kit yet. The review fixes (the held message line and the
  forced-colour states) add 0.4 kB (94.5 → 94.9 kB, 18.4 kB gzip, on top of the approval-card work
  merged since). `stack.css` loads `fields.css` and `pickers.css` on first paint for now; when the first
  screen adopts the pickers, `pickers.css` moves into their code-split chunk, per the gate 4 decision.

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
  `<style>` the CSP blocks. T04's guard can check that each `createRoot(…).render` is wrapped.
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
