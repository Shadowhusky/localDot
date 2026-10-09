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
- **Determinism:** the fixture's wall clock starts at `FIXTURE_START` (`QA_NOW`), seeded tasks take
  the same session time on every run, the fake desktop shows one still frame, and the page's
  `Date` stands still. The live dot badge blinks, so a screenshot taken by hand hides it
  (`ui.still()`); gallery pages run on a paused clock (`page.clock.runFor`).
- **Scenarios:** `QA_SCENARIO=<name>` (or `--scenario`) boots straight into one; on a running
  fixture, `POST /__qa/scenario/<name>` takes a scenario's step and `GET /__qa/scenarios` lists
  them all. By hand: `QA_PORT=0 node --import tsx e2e/fixtures/ui-server.ts --scenario approval`,
  then open the `origin` from the ready line with `#token=` and 43 `a`s.
- **Questions:** `POST /__qa/ask` asks a plain question (`?text=0` without a free answer);
  `?fields=<form>` asks one with typed fields: `login` (a username and a password typed into
  the page), `pin`, `code`, `choice`, `multichoice`, `longtext`, `confirm`, `details` (number, date,
  phone and web address), `file`, `qr` (a link) or `pair` (plain text). Answers go through the real
  answer route; `GET /__qa/state` lists them under `effects`, secret answers only counted.
- **Notifications:** the fixture records what would reach the Mac and phones instead of sending
  it: `GET /__qa/notify` lists Mac banners (`mac`, title and body) and counts phone pushes.
  `POST /__qa/finish?done=1` ends the task as the real runner does, which raises a Done;
  `?markdown=1` gives the result a summary with a heading, a list and bold words.
- **Update:** `POST /__qa/update` makes a new version of the computer ready (the island's one-time
  notice and Settings' Update row); `QA_UPDATE_MS` sets how long the update then takes.
- **Typing:** `typing.spec.ts` measures each key press to the frame that shows it while
  `POST /__qa/stream?ms=<n>` streams a busy task. `QA_CPU_THROTTLE=6` slows Chrome to a phone's CPU.
- **Gallery:** `pnpm --filter @localdot/web build:gallery` builds `gallery.html` into
  `dist-gallery/` (never `dist`); the fixture serves it at `/gallery/` under the app's own page
  policy. Add a page to `GALLERY_PAGES` in `src/gallery/pages.tsx`.
- **Before capture:** `node --import tsx e2e/ui/plan-capture.ts` and `e2e/ui/plan-states.ts` write
  reference screenshots and control notes of today's app to `e2e/out/before` (or `$OUT`), outside
  the harness's own output, which Playwright empties on every run.
