# UI harness

The web UI's flows with no Docker. Each test boots the fixture daemon
(`e2e/fixtures/ui-server.ts`: the real daemon app with a fake computer and two recorded sessions)
on a port the system picks, in one named scenario from `e2e/fixtures/ui-scenarios.ts`, and fails on
any page error, CSP violation or request that leaves the fixture.

```sh
pnpm --filter @localdot/web e2e:ui                       # build the app and gallery, run everything
pnpm --filter @localdot/web exec playwright test -c playwright.ui.config.ts --project=c14 thread
```

- **Matrix:** `c14` `c12` `c39` (Chromium at 1440×900, 1280×800, 390×844 touch) and `w14` `w39`
  (WebKit at 1440×900, 390×844 touch), all with reduced motion. Both are Playwright's own builds
  (`pnpm --filter @localdot/web exec playwright install chromium webkit`), never the installed
  Chrome. Most specs run at `c14` and `w39` only (`runAt`).
- **No screenshot baselines:** the look is checked against the master design's frames by eye, so
  no spec compares pixels with a stored image.
- **Contrast:** `contrast.spec.ts` walks the main states and fails on text under 4.5:1 (3:1 when
  large), or an icon, slider rail, step thread or field edge under 3:1. Each state is reached once and
  read in Daylight, Graphite and Midnight where it stands, so a new appearance costs reads, not walks.
  A project walks in one view (`c14` and `c39` Studio, `w39` Chat, and Chat's own screens everywhere);
  `QA_CONTRAST_VIEW=chat` or `studio` walks every project in that view. `contrast.ts` reads computed
  colours against a screenshot with words and icons taken out, so backgrounds are the pixels really
  drawn. Each test leaves `contrast.json` and a picture per state and appearance in its output. Add a
  state there when a screen is new.
- **Determinism:** the fixture's wall clock starts at `FIXTURE_START` (`QA_NOW`), seeded tasks take
  the same session time on every run, the fake desktop shows one still frame, and the page's
  `Date` stands still. The live dot badge blinks, so a screenshot taken by hand hides it
  (`ui.still()`); gallery pages run on a paused clock (`page.clock.runFor`).
- **Scenarios:** `QA_SCENARIO=<name>` (or `--scenario`) boots straight into one; on a running
  fixture, `POST /__qa/scenario/<name>` takes a scenario's step and `GET /__qa/scenarios` lists
  them all. By hand: `QA_PORT=0 node --import tsx e2e/fixtures/ui-server.ts --scenario approval`,
  then open the `origin` from the ready line with `#token=` and 43 `a`s.
- **Questions:** `POST /__qa/ask` asks a quick choice the user may leave to dot, as the ask tool
  does; `?fields=<form>` asks one with typed fields: `login` (a username and a password typed into
  the page), `pin`, `code`, `choice`, `multichoice`, `setup` (one field that needs an answer and
  three that don't), `longtext`, `confirm`, `details` (number, date, phone and web address), `file`,
  `qr` (a link) or `pair` (plain text). Answers go through the real answer route; `GET /__qa/state`
  lists them under `effects`, secret answers only counted.
- **Connecting apps:** the fixture answers an app's sign-in discovery in memory and stands in for
  keyd's redeeming of the code. The page the daemon would open in the Mac's browser is recorded, not
  opened: `GET /__qa/connect` says where the app would send the user back, so a test approves by
  visiting that. `POST /__qa/connect?remote=1` behaves as if from another device, `?opens=0` as if no
  browser could be opened, and `POST /__qa/connect/ended?id=` as if the app ended a sign-in. The real
  keyd's part is `keyd/internal/oauth` and `apps/daemon/src/connectors/oauth.keyd.test.ts`.
- **Saved logins:** the fixture opens what the page seals as keyd would and keeps sites and accounts
  in memory; `POST /__qa/logins` lists two. keyd's own parsing and store are in `keyd/internal/vault`
  and `apps/daemon/src/keyd/saved-logins.keyd.test.ts`, the fill in
  `apps/daemon/src/cells/saved-login-fill.docker.test.ts`.
- **Notifications:** the fixture records what would reach the Mac and phones instead of sending
  it: `GET /__qa/notify` lists Mac banners (`mac`, title and body) and counts phone pushes.
  `POST /__qa/finish?done=1` ends the task as the real runner does, which raises a Done;
  `?markdown=1` gives the result a summary with a heading, a list and bold words, and
  `?preview=<url>` has the reply come with a preview of that address.
- **Side questions:** `/btw` in the composer reaches the real side-question route, and the fixture
  answers it from the task's own record, as the Fast model reads it, with no model.
- **Replies:** a new task's first reply comes 800 ms after it starts; `POST /__qa/reply?ms=<n>`
  makes dot take longer, so a Stop can come before it has done anything. `?wake=<n>` has dot's
  brain say nothing for n ms first, as a real one starting up, and then also take up a follow-up
  to a task at rest.
- **Plan usage:** `POST /__qa/plan-usage/<state>` sets what the plans used, as the model menu shows
  it: `normal`, `near`, `limit`, `stale`, `reset` or `unknown`. The `plan-usage` scenario signs in
  both plans and starts at `normal`.
- **Screens:** `POST /__qa/screen?to=browser` moves dot to the web browser, through the daemon's
  own browser streams, and `POST /__qa/screen` back to the desktop; `POST /__qa/browser/restart?ms=`
  starts the browser again in place. `POST /__qa/picture/drop` and `/resume` (`?screen=desktop` or
  `browser`, else both) take a screen's picture away and bring it back, as a lost stream does.
  `POST /__qa/desktop/home` empties the desktop to its home screen, as when the last task worked only
  in the web browser, and `/__qa/desktop/window` puts the spreadsheet window back. The fake
  desktopd's window stack follows: the spreadsheet window, maximised, covers the dock.
- **Speech install:** `POST /__qa/speech` with JSON moves the computer's speech install on, or stands
  in for what's already there: `{"job": {"stage": "model", "doneBytes": 1000}}`, `{"handInstalled": …}`,
  `{"installed": …, "using": "installed"}`. It's in memory only; the real install has its own tests.
- **Update:** `POST /__qa/update` makes a new version of the computer ready (the island's one-time
  notice and Settings' Update row); `QA_UPDATE_MS` sets how long the update then takes.
- **Typing:** `typing.spec.ts` measures each key press to the frame that shows it while
  `POST /__qa/stream?ms=<n>` streams a busy task. `QA_CPU_THROTTLE=6` slows Chrome to a phone's CPU.
- **Scrolling:** `chat-scroll.spec.ts` reads through a long conversation (the `long-thread` scenario,
  `POST /__qa/talk?turns=<n>&short=1` for more) with real wheels and touch drags, while `scroll-recorder.ts`
  notes what each painted frame shows. It fails on anything that moved further than the reader's input
  explains and on any row in view taken out of the page. `QA_SCROLL_OUT=<file>` appends each run's numbers.
- **Performance:** `perf-live-run.spec.ts` and `perf-stage.spec.ts` count what watching a task costs
  the page and the stage, under `POST /__qa/live-run?ms=<n>` and a GPU-decoded stand-in for the
  stream (`perf.ts`), with generous budgets. `QA_PERF_OUT=<file>` appends each run's numbers;
  `QA_UI_DIR=<dir>` serves another build to compare. Method and results:
  `docs/measurements/2026-10-22-client-performance.md`.
- **Gallery:** `pnpm --filter @localdot/web build:gallery` builds `gallery.html` into
  `dist-gallery/` (never `dist`); the fixture serves it at `/gallery/` under the app's own page
  policy. Add a page to `GALLERY_PAGES` in `src/gallery/pages.tsx`.
- **Before capture:** `node --import tsx e2e/ui/plan-capture.ts` and `e2e/ui/plan-states.ts` write
  reference screenshots and control notes of today's app to `e2e/out/before` (or `$OUT`), outside
  the harness's own output, which Playwright empties on every run.

- **README screenshots:** after building the app, run
  `node --import tsx e2e/ui/readme-capture.ts` from `apps/web`. This refreshes Studio on a desktop, Chat on a phone,
  Permissions and the message queue at 2× resolution in `docs/readme` using a separate fixture daemon and synthetic data.
