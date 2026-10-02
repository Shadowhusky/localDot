# Task 13 report: the Theatre shell

**Status:** DONE_WITH_CONCERNS. Everything the brief and the five rulings ask for is done and verified. The concerns are small, tested deviations (D1–D7) for the controller to rule on, plus two notes.

## Commit (BASE `1ba1659`, branch `feat/core-part2`)

| Commit | What |
|---|---|
| `b97bc42` feat(web): Theatre shell | 18 files, all in `apps/web/src`. **New:** `app.css`, `cells/{types,hud-state,useCell}.ts`, `cells/hud-state.test.ts`, `shell/{TopBar,ConversationRail,PlanRail,StageColumn,Hud,Caption,MascotDock,Mascot}.tsx`, `testing/fake-websocket.ts`. **Modified:** `App.tsx`, `App.test.tsx`, `theme.css`, `lib/socket.test.ts`. |

- The message has no `Co-Authored-By` or AI line: a grep of the commit body for co-authored, claude, anthropic and generated finds 0 matches.
- The tree is clean after the commit.
- Screenshots and `dist` stay out of git: `apps/web/e2e/out/` is matched by `.gitignore:11`.

## How each controller ruling is met

1. **CARRY, the `hashchange` listener.**
   - `App.tsx` keeps Task 12's effect unchanged; the diff doesn't touch it. It still runs `bootstrapToken()`, so a token from a fragment-only navigation takes the same parse, validate, store and `replaceState` path as the first load.
   - Its test is now "takes a well-formed token link opened in the tab that already shows the page". It covers both cases:
     - **Malformed:** a `#token=abc` arriving by `hashchange` is removed from the address bar and never stored, and the panel stays.
     - **Well-formed:** a token arriving the same way is stored, the fragment is cleared, and the Theatre appears. The test waits for "Start computer", with a fetch that answers `/api/cells` with `[]`.
   - Two mutations fail this test: M2 (no listener) and M10 (the listener reads the raw fragment instead of calling `bootstrapToken`).
   - Task 12's count pin still holds: a rejected token makes exactly 1 request, which is now `GET /api/cells`.
   - The web test count is **20**, not 17 (see D7).
2. **Tests.**
   - `afterEach(cleanup)` stays in `App.test.tsx`, the only RTL file, with Task 12's comment. A second `afterEach`, registered before it, restores the timers and globals.
   - Ruling 2 is pinned by "follows the cell over its status socket and closes it, and any pending retry, on unmount". The global `WebSocket` is stubbed with the shared `FakeWebSocket`. The test has two parts:
     - **Open socket at unmount.** The socket opens `ws://<host>/api/cells/<id>/status` and offers `["localdot.v1", "localdot.token.<t>"]`. A `ready`/`live` message switches the HUD to "Live", sets `.stage.lit` and lights the top bar's lamp. Unmounting closes that socket.
     - **Pending retry at unmount.** A second Theatre's socket is dropped by the daemon, which leaves exactly one retry timer (`vi.getTimerCount() === 1`). After unmount there are 0 timers, and no socket is created over 60 s of fake time.
   - Mutation M1 (no effect cleanup) fails both this test and the removed-cell test.
3. **Design.**
   - I read `~/.agents/skills/apple-design/SKILL.md`, `c-theatre.html`/`.png` and the README's "Decision". The build follows the brief's code and values from the mockup. The rails use the brief's carry-over: 264 px wide, in `--color-text-2` for empty states, at 13.5/1.55.
   - **Tokens:** every colour, radius and spacing value is a CSS token (D1). In the built CSS:
     - colour literals appear only in the `:root` token block;
     - no rule references `--color-xenon*`;
     - there are no gradients;
     - there is exactly one `backdrop-filter` (the HUD), plus its reduced-transparency override.
   - **The void is `#0A0B0D`.**
   - **No xenon, purple, violet or emoji:** every screenshot below was pixel-scanned and has **0** chromatic pixels (max − min channel > 12).
   - **Reduced motion and reduced transparency** are both honoured, as measured in Chrome under emulation:
     - `prefers-reduced-transparency`: the HUD's `backdrop-filter` becomes `none` and its background `rgba(14, 15, 18, 0.92)`;
     - `prefers-reduced-motion`: the canvas reveal transition is dropped, and Task 12's press feedback becomes an opacity change.
   - **Response:** buttons respond on pointer-down (Task 12's `:active` scale).
   - **Mascot:** it is the brief's generic one, with the same geometry (circle r 24 and the two short eye strokes). There is no [avatar-name], [avatar-name] or [avatar-name] name or asset anywhere; `pnpm hygiene` exits 0.
4. **Screenshot check:** done on test port **4793**; see the section below.
5. **Commits and paths:** one conventional commit with no attribution. All work was in this repo by absolute paths; scratch files are in `…/scratchpad/t13-theatre/`.

## Deviations from the brief (each tested or measured; rule on them)

- **D1, tokens (ruling 3).** `theme.css` isn't in the brief's Files list, but it now holds the new tokens:
  - 36 `--spacing-*` component tokens, for example `--spacing-bar` 44, `--spacing-gutter` 20, `--spacing-pill` 40, `--spacing-hud-inset` 5 and `--spacing-stage-reserve` 200;
  - `--radius-full` and `--radius-stop`;
  - `--shadow-hud`, `--blur-hud`, `--duration-lit` and `--ease-lit`.

  The names stay in Tailwind 4 namespaces. `app.css` uses only tokens for colour, radius and spacing. Task 12's `.notice` panel spacing is tokenized too (480, 16, 8), and its re-shot `no-token.png` looks unchanged.

  Still literal: font sizes, weights, line heights and letter-spacing (the ruling doesn't name them), the 2 px focus stroke, and `saturate(140%)`.
- **D2, neutral focus ring.** `theme.css` gains `:focus-visible { outline: 2px solid var(--color-text); outline-offset: var(--spacing-focus-offset) }`.
  - Without it, Chrome on macOS draws the system accent colour. That is blue, which reads as xenon, or purple if the user chose it.
  - Verified: one Tab puts a white 2 px ring around "Start computer" (`theatre-focus.png`).
- **D3, mascot.** The art is unchanged; three things around it differ from the brief:
  - **Sizing:** there is no `size` prop. CSS tokens size it per context: 16 in the bar, 18 in the HUD and 44 in the dock. The brief's numeric prop put spacing values outside CSS.
  - **Colour:** the SVG uses `.body`/`.eye` classes coloured from `--color-avatar-*`, instead of `fill="var(…)"` presentation attributes.
  - **Accessibility:** it is `aria-hidden="true"` instead of `role="img" aria-label="dot"`. It always sits next to text that names dot, so a screen reader would hear "dot localDot" and "dot No computer".
  - Chrome confirms the computed fill `rgb(236, 237, 239)`.
- **D4, HUD.**
  - `role="status"` moved from the whole pill to the label span (`data-testid="hud-status"`), so assistive tech announces the state and not "Start computer" as well.
  - An empty `.acts` is hidden, and `.hud:has(.acts:empty)` sets the right padding to 12 px. "Starting…" and "Stopping…" then sit centred instead of 12/17 px off. Measured padding while starting: `0px 12px`.
- **D5, `useCell`.**
  - **(a) No ref writes during render.** The brief's `api$.current = api` breaks React's rules. `start` and `stop` now use `api` and list it in their dependencies.
  - **(b) Busy until the daemon has answered the first list** (`listed`). With the brief's hook, "Start computer" is offered before `GET /api/cells` answers. A fast click would then create a second cell, and every load with a running computer would flash "Start computer".
    - Pinned by the Theatre test: right after render, `queryByRole("button", { name: "Start computer" })` is null. Mutation M3 fails it.
    - If the list itself fails, the caption shows the error and Start stays hidden, because the state is unknown; a reload retries.
- **D6, title on unmount.** The tab title goes back to "localDot" when the Theatre unmounts (for example after a 401), instead of keeping the last HUD label.
- **D7, tests.**
  - **Shared fake:** `FakeWebSocket` moved out of `socket.test.ts` into `src/testing/fake-websocket.ts`, following the daemon's `cells/testing/`. It is shared with `App.test.tsx`.
  - **No real sockets:** the App tests stub the global `WebSocket`, so no test opens a real socket to `localhost:3000`, token header included.
  - **Two tests beyond ruling 2,** both added during self-review to pin the brief's untested paths:
    - "stops and restarts the computer from the HUD and shows a refused request under the stage": POST stop, then a `stopped` message, then a POST start that the daemon answers with 502. The caption shows the daemon's text, and the exact call list is asserted.
    - "goes back to No computer and closes the status socket when the cell is removed".
  - **Count:** web tests total 20: 9 lib, 4 hud and 7 App.
  - **Kept verbatim:** the brief's Theatre test, including `start.click()`. Neither native clicks nor `fireEvent` produced `act()` warnings.

## TDD evidence (RED before GREEN)

- **HUD state.** With the test written first: `Error: Cannot find module './hud-state.ts'`, so no tests ran. With the brief's `hud-state.ts`: 4/4 pass.
- **App.** The new App tests were written before `useCell` and the shell existed, and run against Task 12's App: **4 failed, 2 passed**.
  - The Theatre test and the `hashchange` test failed with `Unable to find role="button" and name "Start computer"`. The `hashchange` test had already passed its malformed-token half.
  - The socket test failed with `expected [] to have a length of 1 but got +0`.
  - The first Stop test failed with `Unable to find role="button" and name "Stop computer"`.

  After the implementation: 19/19 web tests. The stop/start round trip and the removed-cell test came later, against working code. Mutations M5, M7 and M8 show they assert something real.
- **Logs:** `scratchpad/t13-theatre/red-1-hud-state.txt`, `red-2-app.txt`, `green-1-hud-state.txt` and `green-2-web.txt`.

## Verification

- **Mutations: 10 of 10 caught.** Each was applied, run, restored, and the restore checked byte for byte with `mutate.mjs`.

  | # | Mutation | Failing test |
  |---|---|---|
  | M1 | no socket cleanup in the effect | unmount test, removed-cell test |
  | M2 | no `hashchange` listener | token-link test |
  | M3 | `busy` ignores `listed` | Theatre test |
  | M4 | restart note never matched | hud "crash restart" |
  | M5 | a removed cell is kept | removed-cell test |
  | M6 | the stage is never lit | unmount test |
  | M7 | the request error is not put in the caption | stop/start test |
  | M8 | Start always POSTs `/api/cells` | stop/start test |
  | M9 | the socket offers no subprotocols | unmount test |
  | M10 | `hashchange` reads the raw fragment | token-link test |

- **Gates:**
  - `pnpm format` exits 0. It rewrapped 2 `act()` calls, and the earlier run rewrapped 2 lines in `hud-state*`.
  - `pnpm lint` checked 142 files with 0 diagnostics; Biome had no import-order fixes.
  - `pnpm typecheck` exits 0, including `apps/web` (`-p .` and `-p e2e`).
  - `pnpm hygiene` exits 0.
  - `pnpm test`: **41 files, 387 tests, all pass** (Task 12: 40 / 380).
  - Web suites: **20/20** on three repeated runs, with no stderr or `act()` warnings.
  - `pnpm --filter @localdot/web build`: CSS 7.68 kB, JS 227.23 kB (71.28 kB gzip). Both preference media queries survive minification.

## Screenshot check

**Setup.**
- **Daemon:** started as the constraints say, with `node --import tsx src/main.ts` from `apps/daemon`. It ran on `LOCALDOT_PORT=4793` with `LOCALDOT_HOME` set to a scratchpad folder named `home dot's`, so the path held a space and an apostrophe.
- **Shots:** taken against the build of the committed sources. `theatre-empty.png` and `no-token.png` used the brief's `pnpm --filter @localdot/web shot …`. A scratch Playwright script (`scratchpad/t13-theatre/flow.mjs`) took the other shots on the same system Chrome at DPR 2, with clicks and media emulation.
- **Paths:** package-relative (`e2e/out/<name>.png`, F12). The PNGs are in `/Volumes/Husky's SSD 4T/Projects/localdot/apps/web/e2e/out/`; nothing landed under a nested `apps/web/apps/web`.

**Checks across all PNGs.**
- **Colour:** I opened every one, and a pixel scan finds **0 chromatic pixels**, so no xenon, blue or purple.
- **Overflow:** at 1440×900 the page doesn't scroll (`scrollWidth` 1440 = `clientWidth`, `scrollHeight` 900 = `clientHeight`). No element overflows its box or leaves the viewport.
- **Console:** the only messages are two 404s for `/favicon.ico` (see Notes).

**`theatre-empty.png`** (1440×900, the brief's shot):
- **Layout:** a 44 px top bar above three columns. The conversation rail is 264 px at x 16, the plan rail 264 px at x 1160, the stage column between, with 20 px gutters and a 16 px edge.
- **Void:** everything off the stage is `#0a0b0d` (52 % of pixels). Right next to the stage, its drop shadow darkens the void to `#08090b`–`#060708`.
- **Stage:** 840×525 at (300, 168), so 16:10. Flat `#15161a` surface, 12 px radius, a faint light hairline edge, otherwise empty.
- **HUD:** a 252×40 pill. It shares the stage's centre line (x 720) and sits 14 px below the stage's top edge. It holds the 18 px mascot, "No computer" in white 13.5 px medium, and a lighter 30 px "Start computer" pill inset 5 px. It is blurred (`blur(16px) saturate(1.4)`), which looks the same as solid over a flat surface.
- **Caption:** "dot" in `--color-text-3`, then "Start your computer to see it here." in white 15 px medium, centred 26 px under the stage on one line.
- **Left rail:** "Conversation" heading (11.5 px, `--color-text-3`) at the top. The empty state "Your conversation with dot appears here once the first task starts." sits at the bottom on two lines, in 13.5/1.55 `--color-text-2`, just above the dock. The dock is the 44 px mascot plus a 40 px "Message dot…" pill.
- **Right rail:** "Plan", "No plan yet.", then "Steps", "Steps appear here as dot works.", one line each. It reads easily at a glance, unlike the mockup's slim 12.5 px grey.
- **Top bar:**
  - left: a 16 px mascot with "localDot" (12.5 px semibold, `--color-text-2`), then "Your computer" in white;
  - centre: "Glance Watch Replay", with Watch in white over a 4 px white dot and the others in `--color-text-3`;
  - right: a grey lamp with "Offline".
- **Text and colour:** nothing is clipped or truncated, and there are no stray colours.
- **Against `c-theatre.png`:** the arrangement is the same (bar, rails, HUD on the picture, caption under the stage). The intended differences:
  - the rails are wider (264 vs 212), so the stage is 840 px instead of 944;
  - there is no xenon rim, no pace control and no timer;
  - the rails show empty states.

**`theatre-starting.png`** (after clicking "Start computer" on the real daemon):
- POST `/api/cells` answered 202, creating cell `01M3WPEHBT2QETJHTGYKECCXV5`.
- The HUD reads "Starting…" with no button, and the pill closes around the label with 12 px on each side.
- The caption reads "Starting your computer. The first start takes about a minute." on one line.
- The bar still says Offline, and the rest is unchanged.

**`theatre-started.png`** (about 2 s later; the images were already built, so the cell came up rather than failing):
- The HUD reads "Connecting…" with "■ Stop computer" (an 8 px white square with 1.5 px radius).
- This is a ready cell with no stream viewer yet; the viewer arrives in Task 14. So the bar stays "Offline" and the stage stays unlit.
- The caption reads "Connecting to the stream.", and the tab title is "localDot — Connecting…".

**`theatre-stopped.png`** (after "Stop computer", passing through "Stopping…" with no button):
- The HUD reads "Stopped" with "Start computer".
- The caption reads "Your computer is off."

**`theatre-reduced.png`** (the empty Theatre under emulated `prefers-reduced-transparency` and `prefers-reduced-motion`):
- It looks the same at a glance, since there is nothing under the HUD to blur.
- Measured: `backdrop-filter: none` and HUD background `rgba(14, 15, 18, 0.92)`.

**`theatre-focus.png`** (a 400×90 crop around the HUD after one Tab):
- "Start computer" has a white 2 px ring that sits 2 px outside it and follows its pill shape.
- The ring is not the system blue or purple.

**`theatre-1280.png`** (1280×800):
- The same composition, scaled down: the stage is 680×425 at (300, 168), the rails stay 264, and the HUD and caption stay centred.
- No scroll and no overflow.

**`no-token.png`** (re-shot after the `.notice` tokens): Task 12's panel, unchanged.
- A centred 480 px column holds "No access token", the grey sentence and the white monospace link.
- 99.7 % of pixels are void.

**Cleanup:**
- `DELETE /api/cells/01M3…?purge=1` answered 204, and the list is `[]`.
- Docker `localdot-*` containers, networks and volumes are back to 0/0/0, the same as the baseline before the run.
- The daemon stopped on SIGTERM with exit 143. Its home had no `daemon.lock` left, port 4793 is free, and the home (with the token) was deleted.

## Concerns and notes

- **The favicon 404 predates this task.** Chrome requests `/favicon.ico`, the daemon answers 404, and two console errors appear per session. Task 12's `index.html` has no icon link. I left it alone because both fixes reach beyond this task: a colour-literal mascot icon would break the token rule, and `<link rel="icon" href="data:,">` silences the request but changes Task 12's `index.html`.
- **Expected until Task 14:** a ready cell stays "Connecting…", with the bar Offline and the stage unlit, because nothing views the stream yet. Task 14's viewer drives the HUD to Live and adds `.lit`.
- **Task 14 fit:** `StageColumn` renders `children` directly inside `.stage`, before the HUD, which stays on top (z-index 4). `app.css` already has the brief's `.stage > canvas` and `.stage > .stage-veil` rules. Task 14's canvas, iframe and veil are all direct children of `.stage`.
- **Two reduced-transparency rules:** both Task 12's `:root` remap of `--color-hud` and this task's `.hud` rule apply under reduced transparency. They agree, and only the `.hud` rule can drop the blur.
- **Unchanged Task 12 note:** the panel's hint still hard-codes `127.0.0.1:4750`.
