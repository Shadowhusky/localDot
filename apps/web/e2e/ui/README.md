# UI harness

Deterministic screenshots of the web UI with no Docker. Each test boots the fixture daemon
(`e2e/fixtures/ui-server.ts`: the real daemon app with a fake computer and two recorded sessions)
on a port the system picks, in one named scenario from `e2e/fixtures/ui-scenarios.ts`, and fails on
any page error, CSP violation or request that leaves the fixture.

```sh
pnpm --filter @localdot/web e2e:ui                       # build the app and gallery, run everything
pnpm --filter @localdot/web exec playwright test -c playwright.ui.config.ts --project=c14 screens
pnpm --filter @localdot/web exec playwright test -c playwright.ui.config.ts --update-snapshots=all
```

- **Matrix:** `c14` `c12` `c39` (Chrome at 1440×900, 1280×800, 390×844 touch) and `w14` `w39`
  (WebKit at 1440×900, 390×844 touch), all with reduced motion.
- **Baselines** live in `e2e/__screenshots__/<project>/`, kept at `c14` and `w39` for now
  (`keepBaselinesAt`). Updating one is a deliberate act: look at the new image before committing it.
- **Determinism:** the fixture's wall clock starts at `FIXTURE_START` (`QA_NOW`), seeded tasks take
  the same session time on every run, the fake desktop shows one still frame, and the page's
  `Date` stands still. The live dot badge blinks, so app screenshots hide it (`ui.still()`);
  gallery pages run on a paused clock (`page.clock.runFor`), so the dot there is compared too.
- **Scenarios:** `QA_SCENARIO=<name>` (or `--scenario`) boots straight into one; on a running
  fixture, `POST /__qa/scenario/<name>` takes a scenario's step and `GET /__qa/scenarios` lists
  them all. By hand: `QA_PORT=0 node --import tsx e2e/fixtures/ui-server.ts --scenario approval`,
  then open the `origin` from the ready line with `#token=` and 43 `a`s.
- **Gallery:** `pnpm --filter @localdot/web build:gallery` builds `gallery.html` into
  `dist-gallery/` (never `dist`); the fixture serves it at `/gallery/` under the app's own page
  policy. Add a page to `GALLERY_PAGES` in `src/gallery/pages.tsx`.
- **Before capture:** `node --import tsx e2e/ui/plan-capture.ts` and `e2e/ui/plan-states.ts` write
  reference screenshots and control notes of today's app to `e2e/out/ui/before` (or `$OUT`).
