# Part 2 web fix round: report

**Status:** DONE_WITH_CONCERNS. Every item the job file lists is applied, each one test-first with RED evidence. The concerns are a few small judgement calls and some checks that need a real cell (Task 15). Nothing is blocked.

- **Branch:** `claude/part2-web-fix`, based on `b02765f`. The code is 9 commits; this report is the last commit and touches only `reports/`.
- **Author:** `shadowhusky <a983974247@gmail.com>`, matching `origin/feat/core-part2`. No commit carries an attribution line.
- **Environment:** a cloud container with Node 24.21, pnpm 10.29.3, Playwright 1.63 driving Chromium 141 (`/opt/pw-browsers/chromium-1194`), and no Docker.

## Commits

| Commit | What | Ledger items |
|---|---|---|
| `581bd26` fix(daemon): keep the Theatre out of every frame and its assets inside dist/assets | **Framing:** the Theatre's CSP (on `/` and `/assets/*`) now says `frame-ancestors 'none'`. The client page keeps `'self'`.<br>**Assets:** `/assets/*` is rooted at `dist/assets`.<br>**Symlinks:** `readStatic` resolves symlinks with `realpathSync`, for both root and file, before its containment check.<br>**Test cleanup:** the static tests remove their scratch folders, including the outside files. | T14 Important; T12 minors 2 and 4 |
| `3d9a120` fix(daemon): nosniff on every client-route refusal and a wider permissions deny list | **nosniff:** added to the client route's 403, 404 and 405 answers, and to the 502 and 503 answers of its API proxy.<br>**Permissions-Policy:** 14 more features, each `=()`. | T14 minors 1 and 4 |
| `fc9004e` fix(desktop): replace only a folder that holds Selkies' core bundle | **Extractor marker:** the script now requires `assets/selkies-core-*.js`, as a regular file, before replacing a folder.<br>**Fresh extraction:** a new extraction must carry that file too. | T14 minor 5 |
| `fe3256b` fix(web): keep a link's token only once the daemon accepts it | **Checked first:** a `#token=` is checked with `GET /api/whoami` before it is used or stored. A non-answer retries every 2 s.<br>**Rejection:** a 401 keeps the stored token. With no stored token, the panel says "rejected the token in the link".<br>**Forgetting:** `forgetToken(rejected)` deletes only if the stored token is the rejected one, and the token update uses `setToken(t => t === rejected ? null : t)`.<br>**Format:** `TOKEN_PATTERN` is exactly `{43}`.<br>**Panel link:** built from `window.location.origin`.<br>**Comment:** the false "history and bookmarks never keep the token" is corrected to describe the accepted residual. | T12 Important 1; T12 minor 1; T12 minor 5 |
| `1707f51` fix(web): ask the daemon why a status socket was refused | **Signal:** `openSocket` gains `onRefused`, fired when a socket closes without ever opening.<br>**useCell's answer:** on a refusal it probes `GET /api/whoami` (one probe in flight at a time). A 401 calls `onUnauthorized`, which unmounts the Theatre and closes the socket. A 200 re-lists the cells and adopts the result. | T12 Important 2; T13 out-of-scope evidence |
| `e03f92a` fix(web): an honest HUD with one steady button and plain-worded failures | `useCell` exposes `status` (listing, unknown or known) and `pending` (list, create, start or stop). The HUD changes: "Checking…", "Unavailable" with Try again, and "Starting…" during a create. Errors are mapped by status, failure notes are mapped by kind, the error clears on a state change, Stop is offered while starting and after a failed stop, the cells are re-listed after a request that got no answer or a 404, there is one `aria-disabled` button, and the caption is `aria-live="polite"`. The bar's lamp says "Not live". | T13 minors 1, 2, 3, 6, 7, 8; the "Offline" UX nit |
| `a54a05b` test(web): let React close the status socket before the refusal tests advance time | This fixes a flake in my own new tests under load. The cause was a passive-effect cleanup running after the fake clock fired. | — |
| `6f18bba` fix(web): readable tertiary text, a stage-first narrow layout and a bundled icon | **Contrast:** `--color-text-3` is now `#7c7f87`.<br>**Caption:** `overflow-wrap: anywhere`.<br>**Breakpoint:** `@custom-media --rails-collapse (width < 1180px)`, compiled by Lightning CSS (`vite.config.ts` uses the `lightningcss` transformer with `drafts.customMedia`).<br>**Icon:** an SVG favicon bundled into `/assets`. | T13 minors 4 and 5; CARRY favicon |
| `8ee96ba` fix(web): report a dead frame pump and drop the client's keys for unlisted cells | **Pump:** a `present()` throw cancels the reader and calls `onError`, and the worker posts `{type:"error"}`.<br>**Storage:** `forgetOldTickets({cellId, livePath, listed})` also removes every client key of a cell id that is no longer listed. Only `…_cells_<ULID>_desktop_…` keys of this origin are touched. | T14 minors 2 and 3 |

## Verification

All of the following were run on the final code commit.

| Check | Result |
|---|---|
| `pnpm format` | Clean: 0 fixes. |
| `pnpm lint` | 0 errors and 0 warnings. |
| `pnpm typecheck` | Every package reports Done. |
| `pnpm hygiene` | Exit 0. |
| `pnpm test` | 50 files and 454 tests (451 passed, 3 skipped).<br>The base had 46 files and 414 tests: +40 tests and 4 new files (`errors.test.ts`, `theme.test.ts`, `index-html.test.ts`, `render-worker.test.ts`).<br>Web went from 40 to 75 tests. |
| `pnpm --filter @localdot/web build` | Built. |

**Stability:**
- The web suite passed 15 consecutive runs at head.
- During development I saw `Stage.test.tsx` "hands each new track…" fail once under load (0 frames after 1 s). That test is from Task 14 and is untouched by this round. It did not recur in 10 runs at the base or in 15 runs at head (see Concerns).

### RED evidence (each test failed against the code before its fix)

- **Static serving:** 5 of 9 tests failed before the fix:
  - CSP: `frame-ancestors 'self'` where `'none'` was expected;
  - `/assets/..%2findex.html` answered **200** where 404 was expected;
  - the symlink `leak.js` (a link to a file outside dist) answered **200**;
  - `readStatic` served an escaping symlink.
- **Client route:** the 403 had `x-content-type-options` null, and the permissions header lacked the 14 new features. A stash-revert of `stream-proxy.ts` failed 3 tests.
- **Extractor:** a folder with `index.html` and `assets/app.js` exited **0** where 1 (refused) was expected.
- **Token:**
  - The App test asserting that the first call is whoami saw `["GET /api/cells"]`.
  - A late 401 for the old token erased the newer one (`localStorage` was null).
  - The panel showed no origin link.
  - 5 App tests and 4 token tests failed.
- **Refused socket:**
  - `onRefused` was never called.
  - The whoami 401 never showed the panel.
  - A removed cell stayed "Stopped".
  - A re-listed state was not adopted.
  - 4 tests failed.
- **HUD:**
  - The old `hudFor` threw on the new view shape.
  - The App showed "No computer" while listing and after a failed list.
  - Raw `docker unreachable on /networks/create: ENOENT…` appeared in the caption.
  - No Stop was offered while starting.
  - There was no re-list after a create with no answer, and none after a 404.
  - The caption had no `aria-live`.
  - 10 App tests and 9 hud-state tests failed.
- **Theme:**
  - `color-text-3 on color-void` measured 3.13 where at least 4.5 was required.
  - The caption had no `overflow-wrap`.
  - `index.html` had no icon link.
- **Layout** (Chromium against the real daemon; measured, not unit-tested):
  - **Before** (`layout-880-before.png`):
    - the widest HUD ("Reconnecting…" plus Stop) was clipped at 880 px and at 800 px;
    - a caption holding one long unbroken word spilled out of its column at 1000, 880 and 800 px (at 1000 px the caption ran 180–820 px in a 300–700 px column).
  - **After** (`layout-880-after.png`): the rails collapse below 1180 px, the HUD is not clipped, and the caption stays inside its column at all three widths.
- **Pump and worker:** before the fix, `onError` was never called, and the worker posted no error after a failed `present()`.
- **Storage:** a key of the unlisted cell `01JXYZ0000000000000000GONE` stayed in storage, and 4 unit tests failed.

**Mutations:**
- Removing each of these failed at least one test:
  - the error-clear on a state change;
  - the re-list after an error;
  - `aria-disabled`, by swapping in `disabled` (focus is then lost);
  - the `onRefused` call.
- One mutation survived: dropping `pendingRef`'s guard in `run()`. That guard is redundant behind the HUD's enabled check; I kept it as defence.

### Real daemon errors used in the tests

These come from a real daemon run (`tsx apps/daemon/src/main.ts`, port 5791, `DOCKER_HOST` pointed at a missing socket):

| Request | Answer |
|---|---|
| `POST /api/cells` | **502** `docker unreachable on /networks/create: ENOENT; is Docker Desktop running?` |
| start or stop of an unknown cell | **404** `unknown cell` |
| any `/api/*` call with a bad token | **401** `unauthorized` |
| `GET /api/whoami` | **200** `{"ok":true}` |

Status sockets, opened from Chromium against the same daemon:

| Socket | Result |
|---|---|
| unknown cell, good token | Server answered 404 (seen with `ws`). The page saw only `error` then `close` code **1006**, with no `open`. |
| bad token | Server answered 403. The page saw the same `error` then `close` 1006, with no `open`. |

So "closed before it ever opened" covers both cases, as the ruling required.

**Framing check:**
- A Theatre iframed by a same-origin page (`/healthz`) did not render; its frame has no `#root`.
- The served `/` CSP reads `… frame-ancestors 'none'; form-action 'none'`.

## Screenshots (`reports/part2-web-fix/`)

**How they were taken:**
- The real daemon served the built Theatre at 2× DPR, with its real CSP headers.
- `GET /api/cells` and the status socket were stubbed by Playwright route interception (`page.route` and `page.routeWebSocket`).
- `stream-ticket` was stubbed with 409 so that the stage stays blank.
- `start-refused` used no stub for the create; the real daemon answered it.

**Colour scan:** a scan for chromatic pixels (max − min channel > 12) found **0** in every image except `live-1000-reduced.png`. Its 6,140 pixels are scattered colour fringes on text glyphs (for example 237,238,211 and 9,24,69), which looks like subpixel antialiasing in the context with CDP media emulation. There are no xenon, purple or gradient fills.

| File | What I saw |
|---|---|
| `listing.png` (1440×900) | **Listing.** The HUD reads "Checking…", and "Start computer" is dimmed (aria-disabled, `--color-text-2`). The caption reads "dot Looking for your computer." The bar lamp shows a grey dot and "Not live". Both rails are visible; the stage is an empty surface. |
| `starting.png` | **Starting.** The HUD reads "Starting…" with an enabled "■ Stop computer". The caption reads "Starting your computer. The first start takes about a minute." |
| `failed.png` | **Failed.** The cell's real-format note was `stop failed: docker unreachable on /containers/…/stop: ENOENT; is Docker Desktop running?`. The HUD reads "Failed" with "■ Stop computer". The caption, on two centred lines, reads "Your computer didn't stop: Docker isn't answering. Check that Docker Desktop is running, then stop it again." No Docker text appears. |
| `start-refused.png` | **Real daemon failure caption.** I clicked Start against the Docker-less daemon. The HUD shows "No computer" and "Start computer". The caption reads "Docker isn't answering. Check that Docker Desktop is running, then try again." This comes from the daemon's real 502 body. |
| `live.png` | **Live.** The HUD reads "Live" with "■ Stop computer". The bar lamp is a white dot with "Live". The caption reads "Your computer is live." The stage is blank because no ticket was issued. |
| `stopped.png` | **Stopped.** The HUD reads "Stopped" with "Start computer". The caption reads "Your computer is off." |
| `failed-1000.png` (1000×700) | **Narrow window.** The rails are collapsed and the stage fills the column at about 800 px wide. The HUD "Failed" and "■ Stop computer" are fully inside the stage. The two-line caption is centred under the stage, and nothing clips. |
| `live-1000-reduced.png` (1000×700) | **Narrow window, reduced motion and transparency.** The same layout in the Live state, with `prefers-reduced-transparency` and `prefers-reduced-motion` emulated. The HUD's computed background is `rgba(14,15,18,0.92)` and `backdrop-filter: none`. |
| `layout-880-before.png` / `layout-880-after.png` | **Layout RED and GREEN at 880 px.**<br>Before: with both rails, the HUD pill overhangs a 280 px stage on both sides, and a long unbroken word in the caption spills out of the column.<br>After: no rails, a stage about 800 px wide, the HUD inside the stage, and the caption wrapped within 640 px. |

**Console:** none of these runs logged a CSP violation. The only console errors are the 409 and 502 resource errors the stubs and the real daemon produced on purpose.

**Favicon:** the page requests only `/assets/favicon-*.svg`, never `/favicon.ico`. The daemon still answers `GET /favicon.ico` with 404 if asked directly.

## Audit row 10, corrected (for the Task 14 audit table)

| # | Cell-controlled input → path | Sink | Verdict |
|---|---|---|---|
| 10 | `server_settings` → the core's settings sanitizer `Br` (`selkies-core-BbKps5RD.js:1067`, reached from `:2016`) | `window[<key>] = <value>` for **every** key the cell sends; values persisted under ticket-prefixed keys and echoed to the dashboard | **Not safe: arbitrary `window` property writes.** Key `location` navigates the hidden client frame to any same-origin URL. Before this round, that could load a second Theatre in the frame; with a `#token=` it would store the cell's token, and a later 401 would delete `localdot.token`, a silent logout (reproduced by the Task 14 reviewer on 4798). **Now:**<br>(1) the Theatre's `/` is served with `frame-ancestors 'none'` (pinned in `static-ui.test.ts`), so it cannot load inside the frame;<br>(2) a fragment token is stored only after `whoami` accepts it, and a 401 deletes only the token it rejected.<br>Same-origin pages that can still load in the frame (`/healthz`, `/api/*` 401 text, `/assets/*` with nosniff and `'none'`) are inert text. Other writable globals stay inside the sandboxed, inert, never-focused frame (CSP `sandbox allow-scripts allow-same-origin`, Permissions-Policy). **Residual:** availability only, within that cell's own view. |

## Decisions to rule on

1. **`aria-disabled`, not `disabled`.** Chrome blurs a focused button the moment it becomes `disabled`, which would drop focus, the exact thing minor 8 forbids. The HUD button is therefore `aria-disabled="true"` and ignores clicks while busy. It is relabelled to the next action (Start becomes "Stop computer", disabled until the create answers). While the first list is out, it shows a disabled "Start computer".
2. **New HUD states and wording.**
   - "Checking…" and "Unavailable" with **Try again** after a failed list. Try again only re-lists.
   - Failure notes from the orchestrator (`cell.error`) are also mapped to plain sentences by kind, not only request errors, because they can carry Docker's text. Unknown notes fall back to "Your computer could not start."
3. **Rails collapse completely below 1180 px**, so the conversation rail and composer are hidden at a 1000 px window. Both are placeholders in Part 2.
   - The breakpoint is a named `@custom-media` token in `app.css`. CSS variables can't be used in media queries, so this needed the Lightning CSS transformer.
   - The built CSS was otherwise unchanged in kind (8.31 kB → 8.48 kB).
4. **`--color-text-3` is `#7c7f87`, not the suggested `#767981`.** `#767981` reaches 4.52:1 on the void but only 4.15:1 on `--color-surface`, where the composer placeholder sits. `#7c7f87` gives 4.92:1 and 4.51:1, and `theme.test.ts` pins both.
5. **A token link that gets no answer is checked again every 2 s**, rather than used unverified. While a link is being checked and no stored token exists, the page shows a quiet "Checking the link…". When a stored token exists, the Theatre keeps running on it until the link's token is accepted.
6. **The Theatre is keyed by its token**, so adopting a new token remounts it cleanly.
7. **The refusal probe runs on every refusal, one probe in flight at a time.** It is not once per streak, so a cell removed while the daemon was down is still caught after the restart. During a daemon outage, `whoami` fails at the network level and no list follows.
8. **Small test helpers.** `apps/web/src/testing/read-source.ts` reads source files in Node through a variable-named dynamic import. Vitest blanks `?raw` imports of CSS, and the web tsconfig has no Node types. `index-html.test.ts` uses `?raw`, which works for HTML and SVG.

## Concerns

- **One Task 14 test flake.** `Stage.test.tsx` "hands each new track…" failed once during development under load. It did not recur in 25 later runs (10 at the base, 15 at head). Its fixed `advanceTimersByTime(1_000)` after `playInClient` may be load-sensitive; worth watching.
- **The extractor deletes NOTICE.md.** The script still `rm -rf`s the destination, so a re-extraction drops the hand-written `apps/web/vendor/selkies/NOTICE.md`. It must be restored from git after re-extracting. Not changed here.
- **`/favicon.ico` itself still answers 404.** Chrome never asks for it now that the page declares an icon.
- **Possibly redundant cleanup.** `forgetOldTickets` treats ids that were never listed (for example, a cell created in another tab after this tab's last list) as gone and drops their client settings. Only Selkies' own UI preferences are lost.

## Unverified (deferred to Task 15: needs Docker and a real cell)

- A live desktop painting through the stage after this round, Stop and Start recovery, and the pump's error path with a real lost canvas.
- A real cell's `server_settings` `location` attempt against the new `frame-ancestors 'none'`. Only the synthetic same-origin iframe check above was run.
- A real 404 refusal for a cell removed under a running tab (`DELETE` while the status socket is between connections), and the UI's adoption of "No computer".
- The extended Permissions-Policy names on the Mac's Chrome 154. Here Chromium 141 loaded the client route only through daemon tests, not in a browser.
- `pnpm test:docker` suites (no Docker; skipped per COMMON.md rule 5).
