# localDot Core — Part 3: Visual Core (M2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish milestone M2 "visual core": the first task confirms that the desktop's compositor
runs without vsync and does not tear (P3-C15), so every later measurement describes what users see;
`desktopd` perceives (observe, hitTest) and acts (input,
type, settle) with its own XTest client and an XI2 raw-event listener; the daemon's action gateway
turns scripted actions into the intent → target → dispatch → settle event stream with the spec's
timing contract and a per-injector ring onset measured on this machine; the Theatre stage draws the
P0 overlays from that log with PixiJS; a scripted puppet drives a multi-app sequence live in the UI;
and the pixel-oracle tests pass.

**Architecture:** In the cell, `desktopd` (Hono, one esbuild bundle) spawns two helpers: Cua Driver
(`cua-driver mcp --no-overlay`, perception only, over the MCP stdio SDK) and a small python-xlib
process (`xhelper.py`) that injects XTest input, activates windows through `_NET_ACTIVE_WINDOW`,
stamps every XI2 raw press and release with `CLOCK_MONOTONIC`, and tracks DAMAGE for settle
detection. Chromium web-content boxes come from its DevTools protocol on `127.0.0.1:9222` inside
the cell. The daemon maps `desktopd`'s clock to its own with lowest-RTT pings, keeps every event in
desktop device pixels, holds dispatch while the viewer's stream is stalled, and starts the click
ring at the raw press plus that injector's per-scale p99 (`~/.localdot/calibration.json`, written by
the calibration tool, with the development Mac's first numbers as the fallback). The calibration
validates its method with xfwm4's compositor off, S6's conditions, and measures the table with the
compositor on, as users see it: maximized windows, `vblank_mode=off` (Part 2 Task 5, checked by
Task 1). `@localdot/stage`
folds the log into a model and samples a `Scene` for any time — a pure function the worker draws
with PixiJS over the video texture under one camera matrix, and the oracle checks against captured
pixels. The puppet is a JSON script run through the same gateway, API and UI the brain will use in M4.

**Tech Stack:** Everything Part 2 pinned (Node 24.21.0 in the cell, host Node 25.6, pnpm 10.29.3,
TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3, Hono 4.13.12, ws 8.22.0, zod 4.6.5, React 19.3.0,
Vite 8.3.1, @playwright/test 1.63.0 on system Chrome 154, sharp 0.35.5, esbuild 0.28.2) plus:
PixiJS 8.21.0 (MIT) in the web worker; `@modelcontextprotocol/sdk` 1.31.0 (MIT, already in the
lockfile through `spikes/s2-perception`) and `ws` 8.22.0 in `desktopd`; python-xlib as Ubuntu's
`python3-xlib` and `cwebp` from Ubuntu's `webp` package in the desktop image (Cua Driver 0.30.4 and
`xinput` are already there); `pixi.js` is the only new npm download. Task 1 reuses S8's latency
harness (`spikes/s8-hosted-client`) and adds a motion page and a tear check to it.

**Spec:** `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/specs/2026-09-30-localdot-core-design.md`
(the authority, amended by the spikes). Its "Action gateway and live view" section defers the
overlay parameters, timing table and pixel-oracle rules to
`/Volumes/Husky's SSD 4T/Projects/docs/superpowers/research/2026-09-30-localdot/visualization-ux.md`
§4, which this plan treats as part of the spec (§4.3 P0 parameters, §4.5 timing rules, §4.12 oracle).
Decisions and evidence: `localdot/docs/spikes/SUMMARY.md` (D8, D9, D12, D13 above all) and
`localdot/spikes/s2-perception/FINDINGS.md`, `localdot/spikes/s6-timing/FINDINGS.md`.
Part 2 (binding interfaces): `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-10-01-localdot-core-part2.md`,
its closing sections "Interfaces Part 3 builds on" and "Part 3 obligations".
UI direction (binding): `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/design/2026-09-30-localdot-ui-directions/README.md`
"Decision" and `c-theatre.html` in that folder; `~/.agents/skills/apple-design/SKILL.md`.

**This is Part 3 of the core plan.** Part 1 (spikes and the foundation) is on `main` at
`992e82d`; Part 2 (M1: images, cells, the stream proxy, the Theatre shell with the live desktop) is
on `feat/core-part2` and must be executed before this plan. Task 1 checks the one Part 2 setting
this plan's timing rests on: the compositor's vsync mode (P3-C15). Part 4 (M3, keyd) is written from the
"Interfaces Part 4 builds on" section at the end.

## Global Constraints

- Repo root: `/Volumes/Husky's SSD 4T/Projects/localdot`. Work on branch `feat/core-part3`, created
  from the tip of `feat/core-part2` (`git switch -c feat/core-part3 feat/core-part2`); never commit
  on `main`. Quote the path in every shell command (space and apostrophe).
- Commit messages: conventional `type(scope): summary`. **Never add `Co-Authored-By` or any AI
  attribution line** (user rule; overrides any harness default).
- **Never bind-mount any path under `/Volumes/Husky's SSD 4T` into a container.** Containers get
  named volumes, `docker cp`, `docker exec … sh -c 'cat > file'`, or build contexts only. Runtime data
  lives in `~/.localdot` (`LOCALDOT_HOME` overrides); the calibration table is
  `<home>/calibration.json`; session frames are `<home>/sessions/<id>/frames/<frameId>.webp`.
- Build paths from `fileURLToPath(import.meta.url)`, never `new URL(...).pathname`.
- Ports, all bound to `127.0.0.1` only: daemon and UI `4750` (`LOCALDOT_PORT` overrides), brain tool
  API `4751`, keyd listeners `4760–4789`, spikes and e2e harnesses `4790–4799` (the e2e daemon on
  `4790`, the driver opt-out proxy on `4798`). Inside a cell: `desktopd` `7700`, Selkies `3000`,
  Chromium's DevTools `9222` (loopback inside the cell only; the gate relays nothing to it).
- Auth is cookie-free: HTTP accepts the install token only as `Authorization: Bearer <token>`;
  WebSocket clients always offer `localdot.v1` and `localdot.token.<token>` together and the server
  selects only `localdot.v1`; the UI keeps the token in origin-scoped storage. Every inbound cell
  port requires the per-cell token (`desktopd` bearer, Selkies basic auth). Session frames are
  served only behind the install token, so the UI fetches them with the header and shows blob URLs.
- Every cell network is created with `--internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated`;
  desktop: default seccomp, `NET_RAW` dropped, no added capabilities, pids/memory/CPU limits, no
  `docker.sock`, no `no-new-privileges`; gate: read-only, `no-new-privileges`, all capabilities
  dropped, user `nobody`. Unchanged from Part 2; nothing in Part 3 opens a port on a cell.
- Secrets never enter a container. Typed text is masked at the source: when the target is a secret
  field (AT-SPI role `password text`, or `<input type=password>` through CDP) or the script says
  `masked`, `desktopd` streams counts only, the gateway appends `text.progress` without `chunk`, and
  the intent label says `Type N characters`. No plaintext of a masked field ever reaches the log.
- No Docker restart policy on any cell container; the orchestrator restarts with backoff and re-reads
  ports (P2-R14). `start()` during a restart's backoff must leave exactly one watch loop: Part 2's
  guards and per-cell queue ensure it, and Task 11 pins it with a regression test.
- The daemon is started with `node` directly (`node --import tsx src/main.ts` from `apps/daemon`)
  by anything that must stop it; `pnpm … start` is a terminal convenience only (P2-R11).
- **Geometry in the event log is in desktop device pixels** (the X root: 2560×1600 at 2×, 1280×800
  at 1×), declared once by `session.start.screen = { w, h, scale }`. The puppet and (in M4) the models
  speak model pixels (1280×800); the gateway converts with `toDevice` from `@localdot/providers`
  before emitting any event (D13). `desktopd` maps every accessibility frame into device pixels with
  the spec's per-toolkit formulas, never with the driver's `screenshot_frame`.
- **Timing (spec "Timing", "Clock" and research §4.5):** travel
  `T = clamp(150 + 100·log2(D/W + 1), 220, 700) ms ÷ speed` with `W = 24 px` when the target is
  unknown; the cursor departs `120 ms ÷ speed` after the intent; dwell `90 ms ÷ speed`; press squash
  80 ms; Instant fades the cursor and dispatches after 60 ms. Watch = 1.0 while `stream.viewers > 0`,
  Fast = 2.0 otherwise, Instant only on request. The click ring starts at `pressT + onsetMs`, where
  `pressT` is the XI2 raw-press time `desktopd` returns (mapped to the daemon's clock) and `onsetMs`
  is that injector's per-scale p99 from `<home>/calibration.json`; until the calibration of Task 6 has
  run on this machine the defaults are the development Mac's first numbers (own XTest clicks 19.6 ms
  at 1× / 23.1 ms at 2×, keys 19.1 / 29.3 ms; driver clicks 18.4 / 26.4 — S6, D8). The driver
  fallback delivers clicks and typed text only (P3-C9): its `press_key` is XSendEvent, which no
  XI2 raw listener sees, so key combos on the fallback path are refused with a clear 501.
  The ring lasts ≤ 600 ms. Settle: no screen damage for 250 ms, cap 3 s ("page still changing").
  Typing pace: Watch 35 ms/char for the first 60 characters then 6 ms/char, Fast 8 ms/char, Instant
  0 ms. `desktopd`'s clock is mapped with a lowest-RTT ping burst every 20 s.
- The ring-onset policy lives behind one interface (`RingOnsetPolicy`, Task 9); "keep" (press +
  p99) is implemented and is the default; "strict" (first changed frame at the dispatch point, p99 as
  the timeout) is a contained change described in Task 9 and switched by `LOCALDOT_RING_ONSET`.
- Overlays exist only in the viewer. Observe screenshots come from the cell and never contain an
  overlay pixel; the oracle checks it anyway.
- The Theatre direction: near-black `--color-void` `#0A0B0D`, one accent xenon `#3FB5DE` used
  **only while the agent has control** (stage rim, target box, cursor stroke, click ring, caret,
  current step); Stop and done states stay neutral; "looking at" is a neutral dashed outline; the
  target box carries a dark halo so the light accent shows on white; the HUD floats on the picture
  with a solid fallback under reduced transparency; every colour is a CSS token in
  `apps/web/src/theme.css` (Tailwind 4 `@theme` namespaces) and reaches the worker as a theme message.
- Every UI task follows `~/.agents/skills/apple-design/SKILL.md`: respond on pointer-down,
  interruptible motion that starts from the current value, critically damped springs by default
  (damping 1.0; the target box morph uses response 0.31 s), `prefers-reduced-motion` and
  `prefers-reduced-transparency` honoured (reduced motion: cross-fades instead of travel, no
  overshoot, static caret). Every UI task ends with a screenshot check of the rendered page.
- Determinism: cursor paths, springs and every overlay are closed-form functions of the log and the
  time; no `Math.random()` at render time; `render(log, t, view)` is a pure function in
  `@localdot/stage` and the worker only draws its result.
- Code style: named exports only (default exports only in tool config files), small focused files,
  comments only for non-obvious rules or workarounds, relative imports with explicit `.ts`,
  workspace imports by package name; `pnpm format` before `pnpm lint` in every task. When a fragment
  is merged into an existing file, its imports join that file's import block; Biome's
  `organizeImports` errors are fixed with `pnpm exec biome check --write <files>` (Part 2's F5). Python in the
  image is one file, `xhelper.py`, using only the standard library and python-xlib; no pip.
- Tests: run only the suites a task touches (`pnpm exec vitest run <paths>`); the full `pnpm test`,
  `pnpm typecheck`, `pnpm lint`, `pnpm hygiene` before the final review. Docker-backed tests live in
  `*.docker.test.ts`, run only with `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker`, name everything they
  create `localdot-test-*` and remove it in `afterAll`; one file runs with
  `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker <file>`. Never put `--` before arguments to a `pnpm`
  script: pnpm 10 forwards it literally, and Vitest then runs every file (Part 2's ruling F9) while
  the calibration script would misread its options. Every Docker probe whose output a test checks
  also asserts its exit status, and no server runs on a Docker test's own thread: the `spawnSync`
  Docker helpers block it, so a server a test needs runs in a worker thread or a child process
  (P3-C16, as Part 2's ledger ruled for its gate and image tests). Browser tests run with
  `LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e` in the installed Google Chrome. The
  calibration run is a one-off command, not a test.
- Measurements and the oracle show pages the way users see them: in a maximized window through
  `localdot-chromium`, which xfwm4 composites. `--kiosk` windows are unredirected and bypass the
  compositor, so only the calibration's compositor-off gate, which reproduces S6, uses them (P3-C15,
  P3-C16).
- No [avatar-name]/[avatar-name]/[avatar-name] names or assets anywhere in the repo (`pnpm hygiene` enforces it);
  no binary fixtures are committed (test images are generated in code).

## Review Focus

1. **The viewer disconnects or the stream stalls right before a click.** The gateway must hold
   dispatch while `stream.connection` is `stalled`, `disconnected` or `connecting` and a viewer is
   attached, continue the instant it is `live` again, and never hold when nobody watches
   (`viewers` 0, Fast speed), not even on a `disconnected` left behind by a closed tab. Test:
   Task 9 ("holds dispatch while the stream is stalled and resumes on live", "dispatches at Fast
   with no viewer and never holds").
2. **The XI2 listener never reports the press** (the X server dropped the event, the helper died
   mid-call). `desktopd` must answer with an error inside 150 ms, never a fabricated `pressMono`,
   and the gateway must append `action.cancel { reason: "timeout" }` and mark the step failed.
   Test: Task 4 ("fails loudly when no raw press arrives"), Task 9 ("cancels with timeout when
   desktopd reports no press").
3. **An accessible name that is long, multi-line or empty, or no element under the point.** Labels,
   roles, names, app and window titles are truncated to the schema limits (80/64/64/128/256) with an
   ellipsis before any event is appended, control characters are stripped, and a null target leaves
   the crosshair in place without an `action.target` event. Test: Task 9 ("labels a find click by
   the element's name, truncates a 300-character name, names a point click by its coordinates and
   keeps the crosshair when the hit test is empty"), Task 7 ("flags password fields as secret and
   clips long names").
4. **The video frame size does not match `session.start.screen`** (a 1× cell replayed into a
   stage that assumed 2×, or Selkies renegotiating a size). The camera matrix is built from the
   session's screen, the frame is drawn into that space, overlays stay at their desktop
   coordinates, and the worker reports the mismatch once (`PixiPresenter.warned`) instead of
   drawing a stretched picture. Test: Task 14a ("builds the camera from the session screen, not
   the frame", "places a frame of another size into the session screen and flags it").
5. **Typing into a password field through the puppet.** The log contains the count and no text,
   the typing pill shows dots, the intent label says `Type 7 characters`, and the observe image is
   taken only after the field has lost nothing. Test: Task 9 ("masks a secret field end to end"),
   Task 13 ("renders masked typing as dots and never more characters than typed").

## File map

Created or modified in this part (exact paths relative to the repo root):

```
packages/protocol/src/{events.ts,events.test.ts,desktopd.ts,desktopd.test.ts,text.ts,text.test.ts,time.ts,time.test.ts,index.ts}, packages/protocol/schema/events.schema.json (regenerated)
packages/stage/src/{pointer-path.ts,pointer-path.test.ts,travel.ts,travel.test.ts,spring.ts,spring.test.ts,timing.ts,model.ts,model.test.ts,scene.ts,scene.test.ts,camera.ts,camera.test.ts,index.ts}
packages/providers/src/{coordinates.ts,coordinates.test.ts}
cells/desktop/desktopd/x/xhelper.py
cells/desktop/desktopd/src/x/{helper.ts,helper.test.ts,keys.ts,keys.test.ts,testing/fake-xhelper.mjs}
cells/desktop/desktopd/src/{input.ts,input.test.ts,settle.ts,launch.ts,launch.test.ts,app.ts,app.test.ts,main.ts}
cells/desktop/desktopd/src/perception/{driver.ts,mapping.ts,mapping.test.ts,hit-test.ts,hit-test.test.ts,observe.ts,observe.test.ts,cdp.ts,cdp.test.ts,find.ts}
cells/desktop/desktopd/{package.json,build.mjs}
cells/desktop/{Dockerfile,THIRD-PARTY.md}, cells/desktop/root/usr/local/bin/{localdot-chromium,localdot-plank}, cells/desktop/root/usr/local/share/applications/chromium.desktop
cells/desktop/root/opt/localdot/{flash.html,marker.html,demo/index.html,demo/page2.html}
cells/desktop/root/defaults/localdot/xsettings.xml.in, apps/daemon/src/cells/desktop-image.docker.test.ts
cells/desktop/root/defaults/localdot/xfwm4.xml.in   (Task 1, only if the motion capture tears)
spikes/s8-hosted-client/{motion.html,tearing.js}
apps/daemon/src/desktopd/{client.ts,client.test.ts,clock-map.ts,clock-map.test.ts,registry.ts,registry.test.ts,testing/fake-desktopd.ts}
apps/daemon/src/gateway/{onset-table.ts,onset-table.test.ts,ring-onset.ts,ring-onset.test.ts,frames.ts,frames.test.ts,text.ts,text.test.ts,gateway.ts,gateway.test.ts,live.ts,routes.ts,routes.test.ts}
apps/daemon/src/puppet/{script.ts,script.test.ts,runner.ts,runner.test.ts}
apps/daemon/src/{puppet-main.ts,event-log.ts,event-log.test.ts,app.ts,main.ts,main.test.ts}
apps/daemon/src/cells/{docker.ts,docker.test.ts,orchestrator.test.ts,stream-proxy.ts,stream-proxy.test.ts}
apps/daemon/src/cells/{desktopd.docker.test.ts,desktopd-perception.docker.test.ts,desktopd-cdp.docker.test.ts,driver-optout.docker.test.ts}
apps/daemon/src/cells/testing/desktop-container.ts
apps/daemon/puppet/{demo-multiapp.json,oracle.json}
apps/daemon/package.json
apps/web/src/stage/{render-worker.ts,pump.ts,pump.test.ts,pixi-presenter.ts,overlays.ts,theme.ts,theme.test.ts,geometry.ts,geometry.test.ts,probe.ts,probe.test.ts,oracle.ts,oracle.test.ts,oracle-check.ts,oracle-check.test.ts,worker-protocol.ts,StageCanvas.tsx,Stage.tsx}   (presenter.ts removed)
apps/web/src/session/{useLiveSession.ts,useNowMs.ts,session-view.ts,session-view.test.ts,clock-sync.ts,clock-sync.test.ts,thumbnails.ts}
apps/web/src/shell/{Hud.tsx,PlanRail.tsx,StageColumn.tsx,StepRow.tsx}
apps/web/src/lib/api.ts
apps/web/src/{App.tsx,App.test.tsx,app.css,theme.css}
apps/web/e2e/{calibrate.ts,cells.ts,puppet.ts,pixel-oracle.spec.ts,two-viewers.spec.ts,visual-core.spec.ts}
apps/web/{package.json,playwright.config.ts}
docs/measurements/{2026-10-compositor.md,2026-10-ring-onset.md}, README.md, .github/workflows/ci.yml
```

---
### Task 1: Low-latency compositing — verify vsync off, and check for tearing

Since Part 2's Task 3b, xfwm4's compositor is on: Plank's dock is translucent only with it. S8
found that the compositor's XPresent vsync added about 27 ms to input → frame (send → frame p50 46–51
ms with XPresent, 25 ms with vsync off, 21 ms with no compositor), so Part 2's Task 5 set
`/general/vblank_mode` to `off` in the image's xfwm4 defaults (commit 4195ea0). xfwm4 reads that
setting only when it starts, and nobody has checked that frames without vsync do not tear. P3-C15,
as amended, makes this the first task: confirm the running image composites without vsync, look
for tearing in a motion capture at 2× and 1×, keep `off` if nothing tears, and otherwise switch to
`xpresent` and accept the latency. The calibration (Task 6) and the pixel oracle (Task 16) then
measure the configuration this task settles. The harness is S8's: its page hosts Selkies' client
from a standalone desktop, and a pasted script reads every decoded frame from a clone of the
client's track.

**Files:**
- Create: `spikes/s8-hosted-client/motion.html`, `spikes/s8-hosted-client/tearing.js`,
  `docs/measurements/2026-10-compositor.md`
- Modify, only if the capture tears: `cells/desktop/root/defaults/localdot/xfwm4.xml.in`,
  `apps/daemon/src/cells/desktop-image.docker.test.ts`

**Interfaces:**
- Consumes: Part 2's image `localdot/desktop:dev` and its probe "composites without vsync"
  (`apps/daemon/src/cells/desktop-image.docker.test.ts`, at 2× and 1×); S8's harness in
  `spikes/s8-hosted-client/` (`run-desktop.sh`, `extract.sh`, `host.mjs` on `127.0.0.1:4792`,
  `page.html`, `recorder.js`, `latency-send.mjs`); S6's `spikes/s6-timing/flash.html`.
- Produces: `docs/measurements/2026-10-compositor.md` (the vsync mode the image runs, its send →
  frame latency and the tear counts at 2× and 1×); `motion.html` (a full-height bar moving 16 CSS px
  per animation frame); `tearing.js`, a page script like `recorder.js` that defines
  `ldTear.summary()`. The vsync mode it settles is the production configuration Task 6 calibrates.

- [ ] **Step 1: Branch**

```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot" && git switch -c feat/core-part3 feat/core-part2 && git log --oneline -1
```
Expected: the last Part 2 commit (`test(e2e): live desktop acceptance and 2x measurements`).

- [ ] **Step 2: The setting on the running image**

```bash
cells/desktop/build.sh
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts -t "vsync|switches to 1x"
```
Expected: "composites without vsync" and "switches to 1x with LOCALDOT_SCALE=1" pass: the running
session's `/general/vblank_mode` is `off` at 2× and at 1×. (The build is quick when the image is
current; it must contain Part 2's tip.)

- [ ] **Step 3: The motion page and the tear check**

`spikes/s8-hosted-client/motion.html`:
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>motion</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #bar { position: fixed; top: 0; bottom: 0; left: 0; width: 64px; background: #fff; }
</style>
</head>
<body>
<div id="bar"></div>
<script>
  // A full-height white bar on black, 16 CSS px further right on every animation frame. A frame the
  // capture took while the compositor was still painting shows the bar's left edge at two places.
  const bar = document.getElementById("bar");
  let x = 0;
  const step = () => {
    x = (x + 16) % Math.max(16, innerWidth - 64);
    bar.style.transform = `translateX(${x}px)`;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
</script>
</body>
</html>
```

`spikes/s8-hosted-client/tearing.js` (paste it into the S8 page once the stage shows the motion
page, like `recorder.js`):
```js
// Reads every decoded frame from a second clone of the iframe's track, finds the bar's left edge in
// 8 rows between 20 % and 80 % of the frame's height (below the panel and Chromium's toolbar,
// above the dock) and calls a frame torn when two rows disagree by more than 4 px per scale step.
//   ldTear.summary()  frames seen, frames with the bar in every row, moving frames, torn frames
//   ldTear.stop()     ends the clone
// Re-run it after the client reloads itself: the clone ends with the old track.
(() => {
  const track = document
    .getElementById("desktop")
    .contentDocument?.getElementById("videoStream")
    ?.srcObject?.getVideoTracks?.()[0];
  if (!track) return "no track yet";
  window.ldTear?.stop();
  const ROWS = 8;
  const rec = { frames: 0, withBar: 0, moving: 0, torn: [], lastEdge: null, stopped: false };
  const clone = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();

  const edgesOf = async (frame) => {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const edges = [];
    for (let i = 0; i < ROWS; i++) {
      // Even rows, two high: a 4:2:0 frame (LOCALDOT_STREAM_FULLCOLOR=0) refuses odd rects.
      const y = 2 * Math.round((h * (0.2 + (0.6 * i) / (ROWS - 1))) / 2);
      const rect = { x: 0, y, width: w, height: 2 };
      const buf = new Uint8Array(frame.allocationSize({ rect }));
      const [luma] = await frame.copyTo(buf, { rect });
      const row = buf.subarray(luma.offset, luma.offset + w);
      edges.push(row.findIndex((v) => v > 128));
    }
    return { edges, scale: w / 1280 };
  };

  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) return;
      try {
        if (rec.stopped) continue;
        const { edges, scale } = await edgesOf(frame);
        rec.frames += 1;
        if (edges.some((e) => e < 0)) continue;
        rec.withBar += 1;
        const spread = Math.max(...edges) - Math.min(...edges);
        if (spread > 4 * scale) rec.torn.push({ frame: rec.frames, edges });
        if (rec.lastEdge !== null && edges[0] !== rec.lastEdge) rec.moving += 1;
        rec.lastEdge = edges[0];
      } finally {
        frame.close();
      }
    }
  })();

  rec.stop = () => {
    rec.stopped = true;
    reader.cancel().catch(() => {});
    clone.stop();
  };
  rec.summary = () => ({
    frames: rec.frames,
    withBar: rec.withBar,
    moving: rec.moving,
    torn: rec.torn.length,
    examples: rec.torn.slice(0, 5),
  });
  window.ldTear = rec;
  return `watching ${track.id}`;
})();
```

- [ ] **Step 4: Measure at 2×, then at 1×**

S8's harness, as its FINDINGS describe (Google Chrome with its own profile and DevTools open on the
S8 page; `cd spikes/s8-hosted-client && ./extract.sh` once for the vendored client):
```bash
cd spikes/s8-hosted-client
./run-desktop.sh 2
node host.mjs &
```
Open `http://127.0.0.1:4792` in Chrome and wait for the stage to show the desktop.

The latency, S8's method (S6's flash page in a normal window; a fullscreen window would bypass the
compositor):
```bash
docker exec -i -u abc ld-s8-desktop sh -c 'cat > /tmp/flash.html' < ../s6-timing/flash.html
docker exec -d -u abc -e DISPLAY=:1 ld-s8-desktop chromium --start-maximized file:///tmp/flash.html
sleep 8
```
Paste `recorder.js` into the page, then run `node latency-send.mjs 60` and call
`ldLatency(<the printed list>)` in the page. Expected: send → frame p50 about 25 ms, as S8 measured
with vsync off. A p50 around 46–51 ms means the running xfwm4 still syncs through XPresent: stop and
check that the image contains commit 4195ea0 before anything else.

The motion capture:
```bash
docker exec -u abc ld-s8-desktop pkill -f /tmp/flash.html
docker exec -i -u abc ld-s8-desktop sh -c 'cat > /tmp/motion.html' < motion.html
docker exec -d -u abc -e DISPLAY=:1 ld-s8-desktop chromium --start-maximized file:///tmp/motion.html
sleep 8
```
Paste `tearing.js`, wait 10 seconds, and call `ldTear.summary()`. Expected: about 600 frames, with
`withBar` and `moving` close to `frames` (otherwise the capture did not see the animation: fix that
before reading `torn`), and `torn: 0`. Then `./run-desktop.sh 1`, reload the S8 page, and repeat
the latency and the motion capture at 1×. Stop `host.mjs` and `docker rm -fv ld-s8-desktop` at the
end.

- [ ] **Step 5: Decide**

- No torn frame at either scale: keep `vblank_mode` `off`. Nothing in the image changes.
- Torn frames at either scale: the compositor without vsync tears. Set
  `<property name="vblank_mode" type="string" value="xpresent"/>` in
  `cells/desktop/root/defaults/localdot/xfwm4.xml.in`, change the two `vblank_mode` expectations in
  `apps/daemon/src/cells/desktop-image.docker.test.ts` ("composites without vsync" becomes
  "composites with XPresent vsync", expecting `xpresent` at 2× and 1×), rebuild, run Step 2 and
  Step 4 again, and accept the latency (S8: send → frame p50 46–51 ms).
  - If XPresent tears as well, the tear is in the capture, not the compositor: restore `off`, keep
    the counts, and tell the controller before Task 6.

- [ ] **Step 6: Record it and commit**

`docs/measurements/2026-10-compositor.md`:
```markdown
# Compositor: vsync and tearing (Part 3, Task 1)

<date> · <machine, chip> · Docker Desktop <version> · Google Chrome <version> ·
`localdot/desktop:dev` <image id> · S8's harness (`spikes/s8-hosted-client`: `run-desktop.sh`,
`host.mjs`, `recorder.js` with `latency-send.mjs`, `tearing.js` with `motion.html`)

| | 2× | 1× |
|---|---|---|
| `/general/vblank_mode` in the running session (Part 2's probe) | … | … |
| send → frame, flash page in a maximized window, 60 presses: p50 / p95 / max (ms) | … | … |
| motion page, 10 s: frames / with the bar / moving / torn | … | … |

Decision: <`off` kept: no torn frame in either capture | `xpresent`: … torn frames at 2× and … at 1×
without vsync; the image now syncs through XPresent and send → frame p50 is … ms>.

Task 6 calibrates the ring-onset table with this configuration: compositor on, this vsync mode,
pages in maximized windows.
```
Fill it from the runs.

```bash
pnpm format && pnpm lint
git add spikes/s8-hosted-client/motion.html spikes/s8-hosted-client/tearing.js docs/measurements/2026-10-compositor.md
git commit -m "docs(measurements): the compositor runs without vsync and does not tear"
```
If Step 5 switched to XPresent, also stage `cells/desktop/root/defaults/localdot/xfwm4.xml.in` and
`apps/daemon/src/cells/desktop-image.docker.test.ts`, and commit as
`perf(desktop): sync the compositor through XPresent, without vsync it tears`.

---
### Task 2: Protocol and stage hygiene — the carried obligations

Part 1's final review and Part 2's "Part 3 obligations" leave five changes that every later task
depends on: the envelope `id` validated as a ULID, `observe` events that reference a frame file
instead of carrying base64, an `action.dispatch` that carries the raw-press time and the ring onset,
the stage importing `PointerPlan` from the protocol and switching on `curve`, finite-input guards and
an overshoot cap in the stage maths, and the removal of the unused `resizedPixels` coordinate space.

**Files:**
- Modify: `packages/protocol/src/events.ts`, `packages/protocol/src/events.test.ts`,
  `packages/protocol/src/index.ts`, `packages/protocol/schema/events.schema.json` (regenerated)
- Create: `packages/protocol/src/time.ts`, `packages/protocol/src/time.test.ts`
- Modify: `packages/stage/src/pointer-path.ts`, `packages/stage/src/pointer-path.test.ts`,
  `packages/stage/src/travel.ts`, `packages/stage/src/travel.test.ts`, `packages/stage/src/spring.ts`,
  `packages/stage/src/spring.test.ts`
- Create: `packages/stage/src/timing.ts`
- Modify: `packages/stage/src/index.ts`, `packages/providers/src/coordinates.ts`,
  `packages/providers/src/coordinates.test.ts`

**Interfaces:**
- Consumes: Part 1's `@localdot/protocol` (`Point`, `Rect`, `Input`, `Target`, `ULID_PATTERN`),
  `@localdot/stage` (`pointerAt`, `travelDurationMs`, `dwellMs`, `springValue`),
  `@localdot/providers` (`toScreen`, `toModel`, `toDevice`).
- Produces: `Injector = z.enum(["xtest", "driver"])`; `ActionDispatch.data = { input: Input; pressT: number; ringAt: number; injector: Injector }`
  (`pressT`, `ringAt` in session microseconds, the envelope's `t` unit); `Observe.data = { frameId: ULID; width; height }`;
  envelope `id` must match `ULID_PATTERN`; `export type PointerPlan`; stage `pointerAt(plan: PointerPlan, tMs)`
  throwing `RangeError` on non-finite input, overshoot capped at `OVERSHOOT_CAP_PX = 12`, straight-line
  fallback for an unknown `curve`; `timing.ts` constants: `INTENT_LEAD_MS = 120`, `PRESS_MS = 80`,
  `RING_SCALE_MS = 225`, `RING_FADE_MS = 300`, `RING_PX = 44`, `DOUBLE_CLICK_GAP_MS = 90`,
  `TARGET_HOLD_MS = 900`, `TARGET_FADE_MS = 300`, `TARGET_SPRING = { dampingRatio: 1, response: 0.31 }`,
  `CHIP_SHOW_MS = 2000`, `CHIP_FADE_MS = 400`, `KEYCAP_IN_MS = 200`, `KEYCAP_LINGER_MS = 1500`,
  `KEYCAP_FADE_MS = 300`, `CURSOR_DIM_AFTER_MS = 1200`, `CURSOR_HIDE_AFTER_MS = 60_000`,
  `CARET_PERIOD_MS = 1060`, `TYPING_HOLD_MS = 500`, `SETTLE_QUIET_MS = 250`, `SETTLE_CAP_MS = 3000`,
  `TARGET_IN_MS = 120`, `CANCEL_SHAKE_MS = 180`;
  `intentLeadMs(speed)`, `typingPaceMs(speed, index)`; `CoordSpace` without `resizedPixels`;
  `@localdot/protocol` `time.ts` (P3-C2, the one place units convert): `MICROS_PER_MS = 1000`,
  `microsToMs(micros)`, `msToMicros(ms)` (rounded to a whole microsecond), `msToSeconds(ms)`,
  `sessionMsOf(event: { t })`, and `requireFinite(value, what)`, the finite guard the stage maths
  shares. Every later task converts through these, never inline.

- [ ] **Step 1: Write the failing protocol tests**

Replace the "accepts a dispatch carrying a typed input" test in `packages/protocol/src/events.test.ts`
with the first test below, and add the other three (keep the rest):
```ts
  it("accepts a dispatch carrying the input, the raw press time and the ring onset", () => {
    const e = parseEvent({
      ...base,
      type: "action.dispatch",
      data: {
        input: { kind: "click", button: "left", count: 1, at: { x: 5, y: 6 } },
        pressT: 1_000_000,
        ringAt: 1_019_600,
        injector: "xtest",
      },
    });
    expect(e.type).toBe("action.dispatch");
  });

  it("rejects a dispatch without the press time", () => {
    expect(() =>
      parseEvent({
        ...base,
        type: "action.dispatch",
        data: { input: { kind: "click", button: "left", count: 1, at: { x: 5, y: 6 } } },
      }),
    ).toThrow();
  });

  it("rejects an envelope id that is not a ULID", () => {
    expect(() =>
      parseEvent({ ...base, id: "not-a-ulid", type: "agent.state", data: { state: "idle" } }),
    ).toThrow();
  });

  it("keeps observe frames out of the log: a frame id, never image data", () => {
    const frameId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
    const e = parseEvent({ ...base, type: "observe", data: { frameId, width: 1280, height: 800 } });
    expect(e.type).toBe("observe");
    // The log writes the parsed event, so image data a caller passes along never reaches the JSONL.
    const withImage = parseEvent({
      ...base,
      type: "observe",
      data: { frameId, image: "data:image/png;base64,AAAA", width: 1280, height: 800 },
    });
    expect(withImage.data).toEqual({ frameId, width: 1280, height: 800 });
  });
```

`packages/protocol/src/time.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MICROS_PER_MS, microsToMs, msToMicros, msToSeconds, requireFinite, sessionMsOf } from "./time.ts";

describe("time units", () => {
  it("converts microseconds and milliseconds through one helper", () => {
    expect(MICROS_PER_MS).toBe(1000);
    expect(microsToMs(1_635_100)).toBe(1635.1);
    expect(msToMicros(1635.1)).toBe(1_635_100);
    expect(msToMicros(0.0004)).toBe(0);
    expect(msToMicros(-2.5)).toBe(-2500);
    expect(sessionMsOf({ t: 2_500_000 })).toBe(2500);
    expect(msToSeconds(310)).toBe(0.31);
  });

  it("refuses non-finite input", () => {
    expect(() => microsToMs(Number.NaN)).toThrow(RangeError);
    expect(() => msToMicros(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => requireFinite(Number.NaN, "distance")).toThrow("distance must be finite, got NaN");
    expect(requireFinite(-2, "distance")).toBe(-2);
  });
});
```

Run: `pnpm exec vitest run packages/protocol/src/events.test.ts packages/protocol/src/time.test.ts`
Expected: FAIL — the dispatch without `pressT` parses, the bad id parses, an `observe` without
`image` is rejected; `time.ts` does not exist.

- [ ] **Step 2: Change the schemas and add the time helper**

`packages/protocol/src/time.ts`:
```ts
// Units fixed by Part 1's schema (P3-C2): the envelope's t, pressT and ringAt are session
// microseconds (the daemon clock reads µs); PointerPlan.startsAt/durationMs and the renderer work
// in milliseconds; desktopd's helper clock is CLOCK_MONOTONIC milliseconds. Every conversion goes
// through these four functions, never inline arithmetic.
export const MICROS_PER_MS = 1000;

export function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be finite, got ${value}`);
  return value;
}

export function microsToMs(micros: number): number {
  return requireFinite(micros, "microseconds") / MICROS_PER_MS;
}

export function msToMicros(ms: number): number {
  return Math.round(requireFinite(ms, "milliseconds") * MICROS_PER_MS);
}

export function msToSeconds(ms: number): number {
  return requireFinite(ms, "milliseconds") / 1000;
}

export function sessionMsOf(event: { t: number }): number {
  return microsToMs(event.t);
}
```
`packages/protocol/src/index.ts` — add `export * from "./time.ts";`.

In `packages/protocol/src/events.ts`:
```ts
import { ULID_PATTERN } from "./ids.ts";

const envelope = {
  v: z.literal(1),
  id: z.string().regex(ULID_PATTERN),
  seq: z.number().int().nonnegative(),
  t: z.number().int().nonnegative(),
  agent: z.string().min(1),
  step: z.string().min(1).optional(),
};
```
after `PointerPlan`:
```ts
export type PointerPlan = z.infer<typeof PointerPlan>;

export const Injector = z.enum(["xtest", "driver"]);
export type Injector = z.infer<typeof Injector>;
```
replace `ActionDispatch`:
```ts
// pressT: the XI2 raw press desktopd observed; ringAt: pressT plus the injector's per-scale p99
// press-to-frame latency, when the click ring starts (A8, A18). Both in session microseconds.
export const ActionDispatch = event(
  "action.dispatch",
  z.object({
    input: Input,
    pressT: z.number().int().nonnegative(),
    ringAt: z.number().int().nonnegative(),
    injector: Injector,
  }),
);
```
replace `Observe`:
```ts
// The frame itself is a file keyed by frameId (<home>/sessions/<id>/frames/<frameId>.webp), never
// inline: every stream connect re-reads the JSONL.
export const Observe = event(
  "observe",
  z.object({
    frameId: z.string().regex(ULID_PATTERN),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
);
```

Run: `pnpm exec vitest run packages/protocol/src && pnpm --filter @localdot/protocol schema && git diff --stat packages/protocol/schema`
Expected: all protocol tests pass (the time tests included); `events.schema.json` changes (the `id`
pattern, the dispatch and observe shapes).

- [ ] **Step 3: Write the failing stage and provider tests**

`packages/stage/src/pointer-path.test.ts` — change the import and the plan, and add three tests:
```ts
import type { PointerPlan } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { OVERSHOOT_CAP_PX, pointerAt } from "./pointer-path.ts";

const plan: PointerPlan = {
  from: { x: 0, y: 0 },
  to: { x: 500, y: 0 },
  startsAt: 1000,
  durationMs: 500,
  seed: 7,
  curve: "minjerk-bow-v1",
};
```
replace the "overshoots by at most 3% and corrects back" test with:
```ts
  it("overshoots by at most min(3 %, 12 px) and corrects back", () => {
    const xs = samples(plan).map((p) => p.x);
    expect(Math.max(...xs)).toBeGreaterThan(500);
    expect(Math.max(...xs)).toBeLessThanOrEqual(500 + OVERSHOOT_CAP_PX + 1e-9);
    const long = { ...plan, to: { x: 2000, y: 0 }, durationMs: 700 };
    const far = Array.from({ length: 701 }, (_, i) => pointerAt(long, long.startsAt + i).x);
    expect(Math.max(...far)).toBeLessThanOrEqual(2000 + OVERSHOOT_CAP_PX + 1e-9);
  });
```
and append:
```ts
  it("falls back to a straight line for a curve this renderer does not know", () => {
    const future = { ...plan, curve: "unknown-v9" as unknown as PointerPlan["curve"] };
    const p = pointerAt(future, 1250);
    expect(p.y).toBe(0);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(500);
    expect(pointerAt(future, 1500)).toEqual(plan.to);
  });

  it("refuses non-finite plans and times instead of drawing NaN", () => {
    expect(() => pointerAt({ ...plan, to: { x: Number.NaN, y: 0 } }, 1200)).toThrow(RangeError);
    expect(() => pointerAt({ ...plan, durationMs: Number.POSITIVE_INFINITY }, 1200)).toThrow(RangeError);
    expect(() => pointerAt(plan, Number.NaN)).toThrow(RangeError);
  });
```

`packages/stage/src/travel.test.ts` — append:
```ts
describe("guards", () => {
  it("rejects a non-finite or negative distance", () => {
    expect(() => travelDurationMs(Number.NaN, 24, "watch")).toThrow(RangeError);
    expect(() => travelDurationMs(-1, 24, "watch")).toThrow(RangeError);
    expect(() => travelDurationMs(100, Number.NaN, "watch")).toThrow(RangeError);
  });
});

describe("timing constants", () => {
  it("leads the cursor by 120 ms at Watch, 60 ms at Fast and 0 when instant", () => {
    expect(intentLeadMs("watch")).toBe(120);
    expect(intentLeadMs("fast")).toBe(60);
    expect(intentLeadMs("instant")).toBe(0);
  });

  it("paces typing per the research table", () => {
    expect(typingPaceMs("watch", 0)).toBe(35);
    expect(typingPaceMs("watch", 59)).toBe(35);
    expect(typingPaceMs("watch", 60)).toBe(6);
    expect(typingPaceMs("fast", 0)).toBe(8);
    expect(typingPaceMs("instant", 0)).toBe(0);
  });
});
```
(extend the import to `import { dwellMs, INSTANT_LEAD_MS, intentLeadMs, travelDurationMs, typingPaceMs } from "./travel.ts";`.)

`packages/stage/src/spring.test.ts` — append:
```ts
  it("rejects a non-positive or non-finite response and a negative damping ratio", () => {
    expect(() => springValue(0, 1, 0, 0.1, { dampingRatio: 1, response: 0 })).toThrow(RangeError);
    expect(() => springValue(0, 1, 0, 0.1, { dampingRatio: 1, response: Number.NaN })).toThrow(RangeError);
    expect(() => springValue(0, 1, 0, 0.1, { dampingRatio: -0.1, response: 0.4 })).toThrow(RangeError);
    expect(() => springValue(Number.NaN, 1, 0, 0.1, SPRING_DEFAULT)).toThrow(RangeError);
  });
```
(inside `describe("springValue")`.)

`packages/providers/src/coordinates.test.ts` — in "rejects a model space with a NaN size", change
`kind: "resizedPixels"` to `kind: "pixels"`.

Run: `pnpm exec vitest run packages/stage/src packages/providers/src`
Expected: FAIL, 7 tests — `OVERSHOOT_CAP_PX`, `intentLeadMs`, `typingPaceMs` are not exported; the
guard tests see no `RangeError`; a curve this renderer does not know still bows instead of running
straight.

- [ ] **Step 4: Implement**

`packages/stage/src/timing.ts`:
```ts
// Overlay timing from the spec's "Timing" section and research §4.3 / §4.5. Milliseconds.
export const INTENT_LEAD_MS = 120;
export const PRESS_MS = 80;
export const RING_SCALE_MS = 225;
export const RING_FADE_MS = 300;
export const RING_PX = 44;
export const DOUBLE_CLICK_GAP_MS = 90;
export const TARGET_HOLD_MS = 900;
export const TARGET_FADE_MS = 300;
export const TARGET_IN_MS = 120;
export const TARGET_SPRING = { dampingRatio: 1, response: 0.31 } as const;
export const CHIP_SHOW_MS = 2000;
export const CHIP_FADE_MS = 400;
export const KEYCAP_IN_MS = 200;
export const KEYCAP_LINGER_MS = 1500;
export const KEYCAP_FADE_MS = 300;
export const CURSOR_DIM_AFTER_MS = 1200;
export const CURSOR_HIDE_AFTER_MS = 60_000;
export const CARET_PERIOD_MS = 1060;
export const TYPING_HOLD_MS = 500;
export const SETTLE_QUIET_MS = 250;
export const SETTLE_CAP_MS = 3000;
export const CANCEL_SHAKE_MS = 180;
```

`packages/stage/src/travel.ts` (replace the whole file):
```ts
import { requireFinite } from "@localdot/protocol";
import { INTENT_LEAD_MS } from "./timing.ts";

export type Speed = "watch" | "fast" | "instant";

const SPEED_FACTOR = { watch: 1, fast: 2 } as const;
const UNKNOWN_TARGET_WIDTH = 24;
export const INSTANT_LEAD_MS = 60;

export function travelDurationMs(
  distance: number,
  targetWidth: number | undefined,
  speed: Speed,
): number {
  if (requireFinite(distance, "distance") < 0) throw new RangeError("distance must be >= 0");
  if (targetWidth !== undefined) requireFinite(targetWidth, "target width");
  if (speed === "instant") return 0;
  const width = targetWidth && targetWidth > 0 ? targetWidth : UNKNOWN_TARGET_WIDTH;
  const fitts = 150 + 100 * Math.log2(distance / width + 1);
  return Math.min(700, Math.max(220, fitts)) / SPEED_FACTOR[speed];
}

export function dwellMs(speed: Speed): number {
  return speed === "instant" ? 0 : 90 / SPEED_FACTOR[speed];
}

export function intentLeadMs(speed: Speed): number {
  return speed === "instant" ? 0 : INTENT_LEAD_MS / SPEED_FACTOR[speed];
}

// Research §4.3.6: readable for the first 60 characters, then fast with "+N more" in the pill.
export function typingPaceMs(speed: Speed, index: number): number {
  if (speed === "instant") return 0;
  if (speed === "fast") return 8;
  return index < 60 ? 35 : 6;
}
```

`packages/stage/src/pointer-path.ts` (replace the whole file):
```ts
import type { Point, PointerPlan } from "@localdot/protocol";
import { mulberry32 } from "./random.ts";

// The primary sub-movement overshoots slightly and a corrective one settles on the target, as a
// human hand does. Both, and the sideways bow over the primary, are minimum-jerk eased so the path
// has no velocity jumps. The overshoot is 2–3 % of the distance, capped so a long move does not
// sail 60 px past its target.
const PRIMARY_SHARE = 0.85;
export const OVERSHOOT_CAP_PX = 12;

const minJerk = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);

const progress = (tau: number, overshoot: number) =>
  tau < PRIMARY_SHARE
    ? (1 + overshoot) * minJerk(tau / PRIMARY_SHARE)
    : 1 + overshoot - overshoot * minJerk((tau - PRIMARY_SHARE) / (1 - PRIMARY_SHARE));

function assertFinitePlan(plan: PointerPlan, tMs: number): void {
  const values = [plan.from.x, plan.from.y, plan.to.x, plan.to.y, plan.startsAt, plan.durationMs, plan.seed, tMs];
  if (!values.every(Number.isFinite)) throw new RangeError("pointer plan and time must be finite");
}

export function pointerAt(plan: PointerPlan, tMs: number): Point {
  assertFinitePlan(plan, tMs);
  const { from, to, startsAt, durationMs } = plan;
  if (tMs < startsAt) return { x: from.x, y: from.y };
  if (durationMs <= 0 || tMs >= startsAt + durationMs) return { x: to.x, y: to.y };
  const tau = (tMs - startsAt) / durationMs;
  // A log written by a newer renderer may name a curve this one does not know: draw a straight,
  // minimum-jerk line rather than nothing (the schema's version tag versions the renderer).
  const curve: string = plan.curve;
  return curve === "minjerk-bow-v1" ? minJerkBow(plan, tau) : straight(plan, tau);
}

function straight(plan: PointerPlan, tau: number): Point {
  const s = minJerk(tau);
  return { x: plan.from.x + (plan.to.x - plan.from.x) * s, y: plan.from.y + (plan.to.y - plan.from.y) * s };
}

function minJerkBow(plan: PointerPlan, tau: number): Point {
  const { from, to, seed } = plan;
  const random = mulberry32(seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: from.x, y: from.y };
  const overshoot = Math.min(0.02 + random() * 0.01, OVERSHOOT_CAP_PX / distance);
  const side = random() < 0.5 ? -1 : 1;
  const along = progress(tau, overshoot);
  const bow =
    side *
    Math.min(0.05 * distance, 36) *
    Math.sin(Math.PI * minJerk(Math.min(1, tau / PRIMARY_SHARE)));
  const nx = -dy / distance;
  const ny = dx / distance;
  return { x: from.x + dx * along + nx * bow, y: from.y + dy * along + ny * bow };
}
```

`packages/stage/src/spring.ts` — add the guard at the top of `springValue`:
```ts
export function springValue(
  from: number,
  to: number,
  velocity: number,
  tSeconds: number,
  p: SpringParams,
): number {
  if (![from, to, velocity, tSeconds].every(Number.isFinite)) {
    throw new RangeError("spring inputs must be finite");
  }
  if (!(Number.isFinite(p.response) && p.response > 0) || !(p.dampingRatio >= 0)) {
    throw new RangeError(`spring needs response > 0 and dampingRatio >= 0, got ${p.response}, ${p.dampingRatio}`);
  }
  // ... the existing body unchanged
```

`packages/stage/src/index.ts`:
```ts
export * from "./pointer-path.ts";
export * from "./random.ts";
export * from "./spring.ts";
export * from "./timing.ts";
export * from "./travel.ts";
```

`packages/providers/src/coordinates.ts` — delete the `resizedPixels` member:
```ts
export type CoordSpace = { kind: "pixels"; width: number; height: number } | { kind: "per1000" };
```
(the rest of the file is unchanged; `space.kind !== "per1000"` still selects the sized space.)

- [ ] **Step 5: Run the suites**

Run: `pnpm exec vitest run packages && pnpm typecheck`
Expected: every package suite passes (protocol, stage, providers); `apps/daemon` still typechecks
(no daemon code constructs `action.dispatch` or `observe` events yet).

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages
git commit -m "feat(protocol): dispatch carries pressT and ringAt, observe references a frame file, ids are ULIDs, one time-unit helper"
```

---
### Task 3: The X helper — XTest injection, window activation, XI2 raw-press stamps and DAMAGE

`desktopd`'s own input path (D12): a python-xlib process that `desktopd` spawns once and talks to
over JSON lines. It injects pointer and keys with XTest, activates windows with
`_NET_ACTIVE_WINDOW` and waits for the change as a `PropertyNotify` event (no polling), stamps
every XI2 raw press and release with `CLOCK_MONOTONIC` the instant it reads the event, and tracks
DAMAGE on the root window so `settle()` knows when the screen went quiet. Two X connections, one
per thread, because python-xlib displays are not shared across threads. python-xlib 0.33 (Ubuntu's
`python3-xlib`) initialises the `xtest`, `xinput`, `damage` and `ge` extensions on connect, but it
registers no parser for XI2 *raw* events, so the helper registers its own struct for the RawEvent
wire layout. This task also makes the image changes every later task needs: the helper file, `cwebp`
for observe, a non-blinking caret (a blinking caret is screen damage that would never settle), and the
Chromium wrapper that launches it maximized with the DevTools port (P2-R8), which the menu and the
dock both use.

**Files:**
- Create: `cells/desktop/desktopd/x/xhelper.py`, `cells/desktop/desktopd/src/x/helper.ts`,
  `cells/desktop/desktopd/src/x/testing/fake-xhelper.mjs`,
  `cells/desktop/root/usr/local/bin/localdot-chromium`,
  `cells/desktop/root/usr/local/share/applications/chromium.desktop`,
  `apps/daemon/src/cells/testing/desktop-container.ts`
- Modify: `cells/desktop/Dockerfile`, `cells/desktop/root/defaults/localdot/xsettings.xml.in`,
  `cells/desktop/root/usr/local/bin/localdot-plank`
- Test: `cells/desktop/desktopd/src/x/helper.test.ts`, `apps/daemon/src/cells/desktopd.docker.test.ts` (part 1),
  `apps/daemon/src/cells/desktop-image.docker.test.ts` (Part 2's, the dock's launcher list)

**Interfaces:**
- Consumes: the Part 2 image (`python3-xlib`, `xinput`, `xdotool`, the session bus at
  `unix:path=/tmp/localdot-session-bus`), Part 2's `docker-cli.ts` test helpers.
- Produces: `/opt/localdot/xhelper.py` in the image, run as `abc` with `DISPLAY=:1`. Protocol: a
  request line `{"id", "cmd", ...}` gets `{"id", "ok": true, ...}` or `{"id", "ok": false, "error"}`;
  unsolicited event lines `{"ev": "ready" | "fatal" | "press" | "release", ...}`, where press/release carry
  `kind: "button" | "key"`, `detail` (button number or keycode) and `mono` (CLOCK_MONOTONIC ms), one
  line per physical input (XI 2.2, the slave device's raw event only).
  Commands: `ping` → `{mono}`; `pointer` → `{x, y}`; `windows` → `{windows: [{id, pid, cls, title, x, y, w, h, frame: [x, y, w, h], active}]}`
  top-most first (client-area origin and size in device px; `frame` includes the WM decorations);
  `activate {window}` → `{active, changed, waitedMs, timedOut?}` (≤ 300 ms wait); `move {x, y}` → `{mono}`;
  `click {x, y, button, count, holdMs, mods}` → `{button, presses}`; `scroll {x, y, dx, dy}` → `{notches}`;
  `keys {combo: [names]}` → `{keycodes}`; `char {ch}` → `{keycode, mods}`; `arm` → `{mono}` (resets the
  damage accumulator); `settle {quietMs, firstMs, timeoutMs}` → `{changed: [[x, y, w, h]], lastChange, quiet, noVisibleChange}`;
  `quit`. Key names: X keysym names (`Return`, `Control_L`, `F5`, …) or a single character.
  TypeScript: `startXHelper({ command, args, env?, readyTimeoutMs? }): Promise<XHelper>`,
  `XHelper { call<T>(cmd, args?, timeoutMs?): Promise<T>; onEvent(listener): () => void; readonly alive; close() }`,
  `XEvent`, `XHelperError`; a `fatal` line marks the helper dead and kills its process. Image: `cwebp`
  on `PATH`, `/usr/local/bin/localdot-chromium` (adds
  `--start-maximized --force-renderer-accessibility --remote-debugging-port=9222`), which the menu
  and the Plank dock launch, the XFCE caret no longer blinks. Test helper
  `startDesktopContainer(name, scale, extra?): DesktopContainer` (`{ name, scale, stream, desktopd,
  token, baseUrl }`; returns once desktopd reports `ok: true`), `execAsDesktopUser`,
  `launchInDesktop`, `windowGeometry`.

- [ ] **Step 1: Write the helper**

`cells/desktop/desktopd/x/xhelper.py`:
```python
"""localDot desktopd X helper: XTest injection, window activation, XI2 raw-press stamps and DAMAGE.

Runs as the desktop user with DISPLAY set. JSON lines over stdio:
  request  {"id": 1, "cmd": "click", ...} -> {"id": 1, "ok": true, ...} | {"id": 1, "ok": false, "error": "..."}
  event    {"ev": "press"|"release", "kind": "button"|"key", "detail": 1, "mono": 12345.678}
Times are CLOCK_MONOTONIC milliseconds (time.monotonic_ns() / 1e6), the clock desktopd's Node
process reads through process.hrtime, so nothing inside the cell needs a clock mapping.
Two X connections: `cmd` serves requests on the main thread, `evt` feeds the listener thread.
"""
import json
import select
import sys
import threading
import time

from Xlib import X, display
from Xlib.ext import damage, ge, xinput
from Xlib.protocol import event as xevent
from Xlib.protocol import rq

ACTIVATE_TIMEOUT_MS = 300
DOUBLE_CLICK_GAP_MS = 90

RAW_EVENTS = {
    xinput.RawKeyPress: ("press", "key"),
    xinput.RawKeyRelease: ("release", "key"),
    xinput.RawButtonPress: ("press", "button"),
    xinput.RawButtonRelease: ("release", "button"),
}
# python-xlib 0.33 parses XI2 device events but not raw events; this is the XI 2.1 RawEvent wire
# layout after the GenericEvent header (deviceid, time, detail, sourceid, valuators_len, flags, pad).
RawEventData = rq.Struct(
    rq.Card16("deviceid"),
    rq.Card32("time"),
    rq.Card32("detail"),
    rq.Card16("sourceid"),
    rq.Card16("valuators_len"),
    rq.Card32("flags"),
    rq.Pad(4),
)

KEYSYMS = {
    "Return": 0xFF0D, "Tab": 0xFF09, "BackSpace": 0xFF08, "Escape": 0xFF1B, "Delete": 0xFFFF,
    "Insert": 0xFF63, "space": 0x20, "Up": 0xFF52, "Down": 0xFF54, "Left": 0xFF51, "Right": 0xFF53,
    "Home": 0xFF50, "End": 0xFF57, "Prior": 0xFF55, "Next": 0xFF56, "Menu": 0xFF67, "Print": 0xFF61,
    "Control_L": 0xFFE3, "Shift_L": 0xFFE1, "Alt_L": 0xFFE9, "Super_L": 0xFFEB, "ISO_Level3_Shift": 0xFE03,
}
for _i in range(1, 13):
    KEYSYMS["F%d" % _i] = 0xFFBE + _i - 1
MODS_FOR_INDEX = {0: [], 1: ["Shift_L"], 2: ["ISO_Level3_Shift"], 3: ["Shift_L", "ISO_Level3_Shift"]}

out_lock = threading.Lock()


def mono():
    return time.monotonic_ns() / 1e6


def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def keysym_for_char(ch):
    cp = ord(ch)
    if ch == "\n":
        return KEYSYMS["Return"]
    if ch == "\t":
        return KEYSYMS["Tab"]
    if 0x20 <= cp <= 0x7E or 0xA0 <= cp <= 0xFF:
        return cp
    return 0x1000000 | cp


def merge_rects(rects, limit=8):
    """Unions rectangles that touch within 8 px; above `limit` boxes, one bounding box."""
    boxes = [list(r) for r in rects]
    merged = True
    while merged and len(boxes) > 1:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                near = (a[0] <= b[0] + b[2] + 8 and b[0] <= a[0] + a[2] + 8
                        and a[1] <= b[1] + b[3] + 8 and b[1] <= a[1] + a[3] + 8)
                if near:
                    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
                    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
                    boxes[i] = [x0, y0, x1 - x0, y1 - y0]
                    del boxes[j]
                    merged = True
                    break
            if merged:
                break
    if len(boxes) > limit:
        x0 = min(b[0] for b in boxes)
        y0 = min(b[1] for b in boxes)
        x1 = max(b[0] + b[2] for b in boxes)
        y1 = max(b[1] + b[3] for b in boxes)
        boxes = [[x0, y0, x1 - x0, y1 - y0]]
    return boxes


class Damage:
    """Rectangles damaged since the last arm(), filled by the listener thread."""

    def __init__(self):
        self.lock = threading.Lock()
        self.rects = []
        self.last = None
        self.count = 0

    def add(self, rect, t):
        with self.lock:
            self.rects.append(rect)
            if len(self.rects) > 256:
                self.rects = merge_rects(self.rects)
            self.last = t
            self.count += 1

    def arm(self):
        with self.lock:
            self.rects = []
            self.last = None
            self.count = 0
            return mono()

    def snapshot(self):
        with self.lock:
            return merge_rects(self.rects), self.last, self.count


class Listener(threading.Thread):
    def __init__(self, dmg):
        super().__init__(daemon=True)
        self.dmg = dmg
        self.ready = threading.Event()
        self.error = None

    def run(self):
        try:
            d = display.Display()
            root = d.screen().root
            opcode = d.display.get_extension_major("XInputExtension")
            # XI 2.2, not the 2.0 that python-xlib's xinput_query_version announces: XI2proto gives
            # a 2.0 client raw events only while the device is not grabbed.
            xinput.XIQueryVersion(display=d.display, opcode=opcode, major_version=2, minor_version=2)
            for evtype in RAW_EVENTS:
                d.ge_add_event_data(opcode, evtype, RawEventData)
            mask = (xinput.RawKeyPressMask | xinput.RawKeyReleaseMask
                    | xinput.RawButtonPressMask | xinput.RawButtonReleaseMask)
            root.xinput_select_events([(xinput.AllDevices, mask)])
            damage_id = root.damage_create(damage.DamageReportRawRectangles)
            d.sync()
            self.ready.set()
            seen = 0
            while True:
                ev = d.next_event()
                t = mono()
                # Xlib.X has no GenericEvent constant; the ge extension owns the class (code 35).
                if isinstance(ev, ge.GenericEvent) and ev.extension == opcode and ev.evtype in RAW_EVENTS:
                    # AllDevices delivers each input twice, from the slave device and from its
                    # master; the slave's copy (deviceid == sourceid) is the one press.
                    if ev.data.deviceid != ev.data.sourceid:
                        continue
                    what, kind = RAW_EVENTS[ev.evtype]
                    emit({"ev": what, "kind": kind, "detail": int(ev.data.detail), "mono": t})
                elif isinstance(ev, damage.DamageNotify):
                    a = ev.area
                    self.dmg.add([a.x, a.y, a.width, a.height], t)
                    seen += 1
                    # Raw rectangles arrive without a subtract; the server's region still grows.
                    if seen % 32 == 0:
                        d.damage_subtract(damage_id, X.NONE, X.NONE)
        except Exception as err:  # noqa: BLE001 - reported to desktopd, which restarts the helper
            self.error = "%s: %s" % (type(err).__name__, err)
            self.ready.set()
            emit({"ev": "fatal", "error": "listener: " + self.error})


class Commands:
    def __init__(self, dmg):
        self.d = display.Display()
        self.root = self.d.screen().root
        self.dmg = dmg
        self.NET_ACTIVE = self.d.intern_atom("_NET_ACTIVE_WINDOW")
        self.NET_STACK = self.d.intern_atom("_NET_CLIENT_LIST_STACKING")
        self.NET_PID = self.d.intern_atom("_NET_WM_PID")
        self.NET_NAME = self.d.intern_atom("_NET_WM_NAME")
        self.NET_EXTENTS = self.d.intern_atom("_NET_FRAME_EXTENTS")
        self.root.change_attributes(event_mask=X.PropertyChangeMask)
        info = self.d.display.info
        self.min_kc, self.max_kc = info.min_keycode, info.max_keycode
        self.remapped = {}
        self.d.sync()

    # Events queued on the command connection: MappingNotify after our own keymap changes.
    def drain(self):
        while self.d.pending_events():
            ev = self.d.next_event()
            if ev.type == X.MappingNotify:
                self.d.refresh_keyboard_mapping(ev)

    def prop(self, win, atom):
        p = win.get_full_property(atom, X.AnyPropertyType)
        return None if p is None else p.value

    def active_window(self):
        v = self.prop(self.root, self.NET_ACTIVE)
        return int(v[0]) if v is not None and len(v) else 0

    def window(self, wid):
        return self.d.create_resource_object("window", int(wid))

    def cmd_ping(self, a):
        return {"mono": mono()}

    def cmd_pointer(self, a):
        p = self.root.query_pointer()
        return {"x": p.root_x, "y": p.root_y}

    def cmd_windows(self, a):
        ids = self.prop(self.root, self.NET_STACK)
        active = self.active_window()
        out = []
        for wid in reversed(list(ids or [])):  # EWMH lists bottom to top
            try:
                w = self.window(wid)
                g = w.get_geometry()
                t = self.root.translate_coords(w, 0, 0)
                ext = self.prop(w, self.NET_EXTENTS)
                left, right, top, bottom = (int(v) for v in ext[:4]) if ext is not None and len(ext) >= 4 else (0, 0, 0, 0)
                pid = self.prop(w, self.NET_PID)
                cls = w.get_wm_class()
                name = self.prop(w, self.NET_NAME)
                if isinstance(name, (bytes, bytearray)):
                    title = name.decode("utf-8", "replace")
                else:
                    title = name if isinstance(name, str) else (w.get_wm_name() or "")
                out.append({
                    "id": int(wid),
                    "pid": int(pid[0]) if pid is not None and len(pid) else 0,
                    "cls": cls[1] if cls else "",
                    "title": title,
                    "x": t.x, "y": t.y, "w": g.width, "h": g.height,
                    "frame": [t.x - left, t.y - top, g.width + left + right, g.height + top + bottom],
                    "active": int(wid) == active,
                })
            except Exception:  # noqa: BLE001 - a window that vanished mid-walk
                continue
        return {"windows": out}

    def cmd_activate(self, a):
        wid = int(a["window"])
        before = self.active_window()
        if before == wid:
            return {"active": wid, "changed": False, "waitedMs": 0}
        msg = xevent.ClientMessage(window=self.window(wid), client_type=self.NET_ACTIVE,
                                   data=(32, [2, X.CurrentTime, before, 0, 0]))
        self.root.send_event(msg, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        self.d.flush()
        t0 = mono()
        deadline = t0 + ACTIVATE_TIMEOUT_MS
        while mono() < deadline:
            if self.d.pending_events() == 0:
                ready, _, _ = select.select([self.d.fileno()], [], [], max(0.0, (deadline - mono()) / 1000))
                if not ready:
                    break
            ev = self.d.next_event()
            if ev.type == X.MappingNotify:
                self.d.refresh_keyboard_mapping(ev)
            elif ev.type == X.PropertyNotify and ev.atom == self.NET_ACTIVE and self.active_window() == wid:
                return {"active": wid, "changed": True, "waitedMs": mono() - t0}
        return {"active": self.active_window(), "changed": False, "waitedMs": mono() - t0, "timedOut": True}

    def cmd_move(self, a):
        self.d.xtest_fake_input(X.MotionNotify, x=int(a["x"]), y=int(a["y"]))
        self.d.sync()
        return {"mono": mono()}

    def cmd_click(self, a):
        button = int(a.get("button", 1))
        count = int(a.get("count", 1))
        hold_s = float(a.get("holdMs", 0)) / 1000
        mods = [self.keycode_for_name(m)[0] for m in a.get("mods", [])]
        self.d.xtest_fake_input(X.MotionNotify, x=int(a["x"]), y=int(a["y"]))
        for kc in mods:
            self.d.xtest_fake_input(X.KeyPress, kc)
        self.d.sync()
        for i in range(count):
            if i:
                time.sleep(DOUBLE_CLICK_GAP_MS / 1000)
            self.d.xtest_fake_input(X.ButtonPress, button)
            self.d.sync()
            if hold_s:
                time.sleep(hold_s)
            self.d.xtest_fake_input(X.ButtonRelease, button)
            self.d.sync()
        for kc in reversed(mods):
            self.d.xtest_fake_input(X.KeyRelease, kc)
        self.d.sync()
        return {"button": button, "presses": count}

    def cmd_scroll(self, a):
        dx, dy = int(a.get("dx", 0)), int(a.get("dy", 0))
        self.d.xtest_fake_input(X.MotionNotify, x=int(a["x"]), y=int(a["y"]))
        self.d.sync()
        notches = 0
        for button, n in ((5 if dy > 0 else 4, abs(dy)), (7 if dx > 0 else 6, abs(dx))):
            for _ in range(n):
                self.d.xtest_fake_input(X.ButtonPress, button)
                self.d.xtest_fake_input(X.ButtonRelease, button)
                self.d.sync()
                notches += 1
        return {"notches": notches}

    def keysym_for_name(self, name):
        if name in KEYSYMS:
            return KEYSYMS[name]
        if len(name) == 1:
            return keysym_for_char(name)
        raise ValueError("unknown key %r" % name)

    def keycodes_for_keysym(self, keysym):
        codes = list(self.d.keysym_to_keycodes(keysym))
        if codes:
            kc, idx = codes[0]
            return kc, MODS_FOR_INDEX.get(idx, [])
        return self.remap(keysym), []

    def keycode_for_name(self, name):
        return self.keycodes_for_keysym(self.keysym_for_name(name))

    # xdotool's trick for characters the layout lacks: bind a spare keycode to the keysym.
    def remap(self, keysym):
        if keysym in self.remapped:
            return self.remapped[keysym]
        mapping = self.d.get_keyboard_mapping(self.min_kc, self.max_kc - self.min_kc + 1)
        per = len(mapping[0]) if mapping else 1
        spare = None
        for i in range(len(mapping) - 1, -1, -1):
            if all(s == 0 for s in mapping[i]) and (self.min_kc + i) not in self.remapped.values():
                spare = self.min_kc + i
                break
        if spare is None:
            raise RuntimeError("no spare keycode for keysym %#x" % keysym)
        self.d.change_keyboard_mapping(spare, [[keysym] * per])
        self.d.sync()
        self.drain()
        # Every client refreshes its keymap on MappingNotify; a press before the focused app has
        # done so lands as the old (empty) symbol. xdotool waits the same way.
        time.sleep(0.02)
        self.remapped[keysym] = spare
        return spare

    def cmd_char(self, a):
        kc, mods = self.keycodes_for_keysym(keysym_for_char(a["ch"]))
        mod_codes = [self.keycode_for_name(m)[0] for m in mods]
        for m in mod_codes:
            self.d.xtest_fake_input(X.KeyPress, m)
        self.d.xtest_fake_input(X.KeyPress, kc)
        self.d.sync()
        self.d.xtest_fake_input(X.KeyRelease, kc)
        for m in reversed(mod_codes):
            self.d.xtest_fake_input(X.KeyRelease, m)
        self.d.sync()
        return {"keycode": kc, "mods": mods}

    def cmd_keys(self, a):
        codes = [self.keycode_for_name(n)[0] for n in a["combo"]]
        for kc in codes:
            self.d.xtest_fake_input(X.KeyPress, kc)
            self.d.sync()
        for kc in reversed(codes):
            self.d.xtest_fake_input(X.KeyRelease, kc)
        self.d.sync()
        return {"keycodes": codes}

    def cmd_arm(self, a):
        return {"mono": self.dmg.arm()}

    def cmd_settle(self, a):
        quiet = float(a.get("quietMs", 250))
        first = float(a.get("firstMs", 1500))
        timeout = float(a.get("timeoutMs", 3000))
        t0 = mono()
        while True:
            rects, last, count = self.dmg.snapshot()
            now = mono()
            if count and now - last >= quiet:
                return {"changed": rects, "lastChange": last, "quiet": True, "noVisibleChange": False}
            if not count and now - t0 >= first:
                return {"changed": [], "lastChange": None, "quiet": True, "noVisibleChange": True}
            if now - t0 >= timeout:
                return {"changed": rects, "lastChange": last, "quiet": False, "noVisibleChange": count == 0}
            time.sleep(0.01)


def main():
    dmg = Damage()
    listener = Listener(dmg)
    listener.start()
    listener.ready.wait(5)
    if listener.error:
        sys.exit(1)
    cmds = Commands(dmg)
    emit({"ev": "ready", "mono": mono()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = req.get("cmd")
            if cmd == "quit":
                emit({"id": rid, "ok": True})
                break
            fn = getattr(cmds, "cmd_" + str(cmd), None)
            if fn is None:
                emit({"id": rid, "ok": False, "error": "unknown command %r" % cmd})
                continue
            cmds.drain()
            res = fn(req)
            res["id"] = rid
            res["ok"] = True
            emit(res)
        except Exception as err:  # noqa: BLE001 - every failure is reported on the reply line
            emit({"id": rid, "ok": False, "error": "%s: %s" % (type(err).__name__, err)})


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write the failing wrapper test and the fake helper**

`cells/desktop/desktopd/src/x/testing/fake-xhelper.mjs` (a Node stand-in that speaks the protocol;
`node fake-xhelper.mjs [--no-ready|--die-on-ping]`):
```js
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "";
const mono = () => performance.timeOrigin + performance.now();
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
if (mode !== "--no-ready") emit({ ev: "ready", mono: mono() });
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  switch (req.cmd) {
    case "ping":
      if (mode === "--die-on-ping") process.exit(3);
      return emit({ id: req.id, ok: true, mono: mono() });
    case "click": {
      // The raw press lands before the reply, as it does with the real helper.
      emit({ ev: "press", kind: "button", detail: req.button ?? 1, mono: mono() });
      emit({ ev: "release", kind: "button", detail: req.button ?? 1, mono: mono() });
      return emit({ id: req.id, ok: true, button: req.button ?? 1, presses: 1 });
    }
    case "char":
      setTimeout(() => emit({ ev: "press", kind: "key", detail: 38, mono: mono() }), 5);
      return emit({ id: req.id, ok: true, keycode: 38, mods: [] });
    case "silent-click":
      return emit({ id: req.id, ok: true, button: 1, presses: 0 });
    case "hang":
      return;
    case "boom":
      return emit({ id: req.id, ok: false, error: "ValueError: boom" });
    case "quit":
      emit({ id: req.id, ok: true });
      return process.exit(0);
    default:
      return emit({ id: req.id, ok: false, error: `unknown command ${req.cmd}` });
  }
});
```

`cells/desktop/desktopd/src/x/helper.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startXHelper, type XEvent, type XHelper, XHelperError } from "./helper.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-xhelper.mjs", import.meta.url));
const helpers: XHelper[] = [];
afterEach(async () => {
  for (const h of helpers.splice(0)) await h.close();
});

async function fake(...args: string[]): Promise<XHelper> {
  const h = await startXHelper({ command: process.execPath, args: [FAKE, ...args] });
  helpers.push(h);
  return h;
}

describe("startXHelper", () => {
  it("waits for ready, answers commands by id, and delivers events to listeners", async () => {
    const h = await fake();
    const events: XEvent[] = [];
    h.onEvent((e) => events.push(e));
    const pong = await h.call<{ mono: number }>("ping");
    expect(pong.mono).toBeGreaterThan(0);
    const click = await h.call<{ presses: number }>("click", { x: 1, y: 2, button: 3 });
    expect(click.presses).toBe(1);
    expect(events.map((e) => `${e.ev}:${e.kind}:${e.detail}`)).toEqual(["press:button:3", "release:button:3"]);
  });

  it("rejects with the helper's error message and keeps serving", async () => {
    const h = await fake();
    await expect(h.call("boom")).rejects.toThrow("ValueError: boom");
    expect((await h.call<{ mono: number }>("ping")).mono).toBeGreaterThan(0);
  });

  it("times out a command that never answers", async () => {
    const h = await fake();
    await expect(h.call("hang", {}, 50)).rejects.toThrow(/timed out/);
  });

  it("fails every pending call and reports not alive when the process exits", async () => {
    const h = await fake("--die-on-ping");
    await expect(h.call("ping")).rejects.toThrow(/exited/);
    expect(h.alive).toBe(false);
  });

  it("fails to start when the helper never says ready", async () => {
    await expect(startXHelper({ command: process.execPath, args: [FAKE, "--no-ready"], readyTimeoutMs: 100 })).rejects.toThrow(XHelperError);
  });
});
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src/x/helper.test.ts`
Expected: FAIL — `Cannot find module './helper.ts'`.

- [ ] **Step 3: Implement the wrapper**

`cells/desktop/desktopd/src/x/helper.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface XEvent {
  ev: "press" | "release";
  kind: "button" | "key";
  detail: number;
  mono: number;
}

export interface XHelper {
  call<T extends object = Record<string, unknown>>(
    cmd: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  onEvent(listener: (event: XEvent) => void): () => void;
  readonly alive: boolean;
  close(): Promise<void>;
}

export interface XHelperOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
}

export class XHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XHelperError";
  }
}

interface Pending {
  cmd: string;
  resolve(value: object): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_CALL_TIMEOUT_MS = 5000;

export function startXHelper(opts: XHelperOptions): Promise<XHelper> {
  const child: ChildProcess = spawn(opts.command, opts.args, {
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: XEvent) => void>();
  let seq = 0;
  let alive = true;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((err: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});

  const failAll = (why: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new XHelperError(`xhelper ${p.cmd}: ${why}`));
      pending.delete(id);
    }
  };

  child.stderr?.on("data", (d: Buffer) => console.error(`xhelper: ${String(d).trimEnd()}`));
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error(`xhelper: unreadable line ${line}`);
      return;
    }
    if (typeof msg.ev === "string") {
      if (msg.ev === "ready") readyResolve?.();
      else if (msg.ev === "fatal") {
        alive = false;
        readyReject?.(new XHelperError(String(msg.error)));
        failAll(String(msg.error));
        // A helper whose listener died still holds its X connections: end it, and the next start
        // gets a fresh one.
        child.kill();
      } else for (const l of listeners) l(msg as unknown as XEvent);
      return;
    }
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg);
    else p.reject(new XHelperError(`xhelper ${p.cmd}: ${String(msg.error)}`));
  });
  child.on("exit", (code, signal) => {
    alive = false;
    const why = `exited with ${code ?? signal}`;
    readyReject?.(new XHelperError(`xhelper ${why} before ready`));
    failAll(why);
  });
  child.on("error", (err) => {
    alive = false;
    readyReject?.(new XHelperError(`xhelper failed to start: ${err.message}`));
    failAll(err.message);
  });

  const helper: XHelper = {
    get alive() {
      return alive;
    },
    call<T extends object>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
      if (!alive) return Promise.reject(new XHelperError(`xhelper ${cmd}: helper is not running`));
      const id = ++seq;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new XHelperError(`xhelper ${cmd}: timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { cmd, resolve: resolve as (v: object) => void, reject, timer });
        child.stdin?.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (!alive) return;
      try {
        await helper.call("quit", {}, 500);
      } catch {}
      child.kill();
      alive = false;
    },
  };

  const readyTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new XHelperError(`xhelper did not say ready within ${opts.readyTimeoutMs ?? 5000} ms`)), opts.readyTimeoutMs ?? 5000).unref(),
  );
  return Promise.race([ready, readyTimeout]).then(
    () => helper,
    (err) => {
      child.kill();
      throw err;
    },
  );
}
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src/x/helper.test.ts`
Expected: 5 tests pass.

- [ ] **Step 4: The image changes**

`cells/desktop/root/usr/local/bin/localdot-chromium` (P2-R8; the DevTools port is loopback inside the
cell and the gate relays nothing to it):
```bash
#!/bin/bash
# localDot's Chromium launcher: maximized, with the accessibility tree and the DevTools protocol
# desktopd reads web-content boxes from (A10, D13). /usr/bin/chromium is the base image's wrapper.
exec /usr/bin/chromium --start-maximized --force-renderer-accessibility --remote-debugging-port=9222 "$@"
```

`cells/desktop/root/usr/local/share/applications/chromium.desktop` (XDG looks in
`/usr/local/share/applications` before `/usr/share/applications`, so the menu uses the wrapper too;
the dock names its launchers' files itself, so `localdot-plank` changes below):
```
[Desktop Entry]
Version=1.0
Name=Chromium Web Browser
GenericName=Web Browser
Comment=Access the Internet
Exec=/usr/local/bin/localdot-chromium %U
Terminal=false
Type=Application
Icon=chromium-browser
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
StartupNotify=true
```

`cells/desktop/root/usr/local/bin/localdot-plank` — Part 2 writes every dock launcher as
`Launcher=file:///usr/share/applications/<app>.desktop`, so a dock click would start Chromium
without the wrapper: no DevTools port and no forced accessibility, and Chromium, being one
instance, would then ignore the flags of every later `localdot-chromium` launch. In the launcher
loop, replace the two-line `printf …` command that writes `"$launchers/$app.dockitem"` with:
```bash
  # The menu's rule: an app's own desktop file in /usr/local wins (Chromium's starts the wrapper).
  dir=/usr/share/applications
  [ -e "/usr/local/share/applications/$app.desktop" ] && dir=/usr/local/share/applications
  printf '[PlankDockItemPreferences]\nLauncher=file://%s/%s.desktop\n' "$dir" "$app" \
    > "$launchers/$app.dockitem"
```
Part 2's image test reads the dock's launcher files ("wears the WhiteSur light look with a dock and a
menu-bar panel" in `apps/daemon/src/cells/desktop-image.docker.test.ts`); its expected list now
starts with the override (`ls` sorts `/usr/local/…` first):
```ts
    expect(launchers.trim().split("\n")).toEqual([
      "/usr/local/share/applications/chromium.desktop",
      ...[
        "codium",
        "gimp",
        "libreoffice-calc",
        "libreoffice-impress",
        "libreoffice-writer",
        "org.xfce.mousepad",
        "thunar",
        "xfce4-terminal",
      ].map((app) => `/usr/share/applications/${app}.desktop`),
    ]);
```

`cells/desktop/root/defaults/localdot/xsettings.xml.in` — change one property:
```xml
    <property name="CursorBlink" type="bool" value="false"/>
```

`cells/desktop/Dockerfile`:
- in the first `apt-get install` list add `webp` after `imagemagick`;
- extend the `base` stage's `RUN chmod 755 …` line with `/usr/local/bin/localdot-chromium`;
- in the final `desktop` stage, after the `COPY desktopd/dist/desktopd.mjs …` line add:
```dockerfile
COPY desktopd/x/xhelper.py /opt/localdot/xhelper.py
RUN chmod 644 /opt/localdot/xhelper.py
```

Run: `cells/desktop/build.sh`
Expected: the apt layer and everything after it rebuild (10–20 minutes); the build ends with the
`desktop` stage containing `/opt/localdot/xhelper.py`.

- [ ] **Step 5: The shared container helper and the Docker test**

`apps/daemon/src/cells/testing/desktop-container.ts` (the `startDesktop` pattern of Part 2's image
test, shared by Part 3's Docker tests):
```ts
import { docker, dockerExecAs, publishedPort, removeAll, sleepSync, waitFor } from "./docker-cli.ts";

export const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
export const TEST_DESKTOPD_TOKEN = "d".repeat(43);
export const TEST_STREAM_PASSWORD = "p".repeat(43);

export interface DesktopContainer {
  name: string;
  scale: 1 | 2;
  stream: number;
  desktopd: number;
  token: string;
  baseUrl: string;
}

// A standalone desktop (default bridge, no gate) with desktopd and Selkies published on 127.0.0.1.
export function startDesktopContainer(name: string, scale: 1 | 2, extra: string[] = []): DesktopContainer {
  removeAll({ containers: [name] });
  const [w, h] = scale === 2 ? ["2560", "1600"] : ["1280", "800"];
  docker("run", "-d", "--name", name, "--shm-size=1g", "--cap-drop", "NET_RAW",
    "-p", "127.0.0.1:0:3000", "-p", "127.0.0.1:0:7700",
    "-e", `PASSWORD=${TEST_STREAM_PASSWORD}`, "-e", `LOCALDOT_DESKTOPD_TOKEN=${TEST_DESKTOPD_TOKEN}`,
    "-e", `LOCALDOT_SCALE=${scale}`, "-e", `SELKIES_MANUAL_WIDTH=${w}`, "-e", `SELKIES_MANUAL_HEIGHT=${h}`,
    ...extra, DESKTOP_IMAGE);
  waitFor("xfce4-panel", () => dockerExecAs(name, "abc", "pgrep", "-x", "xfce4-panel").status === 0, 180_000);
  sleepSync(5000);
  const desktopd = publishedPort(name, "7700");
  // desktopd answers 200 with ok:false while the session is still coming up (Part 2): wait for ok.
  const health = `curl -sf -H 'Authorization: Bearer ${TEST_DESKTOPD_TOKEN}' http://127.0.0.1:7700/healthz | grep -q '"ok":true'`;
  waitFor("desktopd", () => dockerExecAs(name, "abc", "sh", "-c", health).status === 0, 60_000);
  return { name, scale, stream: publishedPort(name, "3000"), desktopd, token: TEST_DESKTOPD_TOKEN, baseUrl: `http://127.0.0.1:${desktopd}` };
}

export function execAsDesktopUser(name: string, ...cmd: string[]): { status: number; out: string } {
  return dockerExecAs(name, "abc", "env", "DISPLAY=:1", "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus", ...cmd);
}

export function launchInDesktop(name: string, ...cmd: string[]): void {
  docker("exec", "-d", "-u", "abc", "-e", "DISPLAY=:1", "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus", name, ...cmd);
}

// xdotool search exits 1 when no window matches, which a poll expects; any other status is a
// failed probe. A window that closes between the two calls is skipped.
export function windowGeometry(name: string, className: string): { id: number; x: number; y: number; w: number; h: number } | undefined {
  const search = execAsDesktopUser(name, "xdotool", "search", "--onlyvisible", "--classname", className);
  if (search.status === 1) return undefined;
  if (search.status !== 0) throw new Error(`xdotool search ${className} exited ${search.status}: ${search.out}`);
  for (const id of search.out.trim().split("\n").filter(Boolean)) {
    const geometry = execAsDesktopUser(name, "xdotool", "getwindowgeometry", "--shell", id);
    if (geometry.status !== 0) continue;
    const out = geometry.out;
    const pick = (key: string) => Number(new RegExp(`^${key}=(\\d+)$`, "m").exec(out)?.[1]);
    const g = { id: Number(id), x: pick("X"), y: pick("Y"), w: pick("WIDTH"), h: pick("HEIGHT") };
    if (g.w > 100 && g.h > 100) return g;
  }
  return undefined;
}
```

`apps/daemon/src/cells/desktopd.docker.test.ts` (part 1; Task 4 appends the HTTP part):
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Test-only cross-package import: the helper's TypeScript client lives with desktopd.
import { startXHelper, type XEvent, type XHelper } from "../../../../cells/desktop/desktopd/src/x/helper.ts";
import { execAsDesktopUser, launchInDesktop, startDesktopContainer, windowGeometry } from "./testing/desktop-container.ts";
import { DOCKER_TESTS, dockerExec, dockerExecAs, removeAll, sleepSync, waitFor } from "./testing/docker-cli.ts";

const C = "localdot-test-desktopd";
let x: XHelper;
const events: XEvent[] = [];

const waitEvent = async (pred: (e: XEvent) => boolean, ms: number): Promise<XEvent | undefined> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5));
  }
  return undefined;
};

describe.skipIf(!DOCKER_TESTS)("desktopd: the X helper inside the image", () => {
  beforeAll(async () => {
    startDesktopContainer(C, 2);
    x = await startXHelper({
      command: "docker",
      // /usr/bin/python3, not the venv the base image puts first on PATH (/lsiopy), which has no python-xlib.
      args: ["exec", "-i", "-u", "abc", "-e", "DISPLAY=:1", "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus", C, "/usr/bin/python3", "-u", "/opt/localdot/xhelper.py"],
    });
    x.onEvent((e) => events.push(e));
  });
  afterAll(async () => {
    await x?.close();
    removeAll({ containers: [C] });
  });

  it("shares CLOCK_MONOTONIC with Node in the cell", async () => {
    const pong = await x.call<{ mono: number }>("ping");
    const probe = dockerExec(C, "node", "-e", "console.log(Number(process.hrtime.bigint()) / 1e6)");
    expect(probe.status, probe.out).toBe(0);
    const node = Number(probe.out.trim());
    expect(Math.abs(node - pong.mono)).toBeLessThan(2000);
    expect(pong.mono).toBeGreaterThan(1000);
  });

  it("lists windows top-most first with device-pixel geometry and activates one as an event", async () => {
    launchInDesktop(C, "xfce4-terminal");
    waitFor("terminal window", () => windowGeometry(C, "xfce4-terminal") !== undefined, 30_000);
    sleepSync(1500);
    const { windows } = await x.call<{ windows: { id: number; cls: string; x: number; y: number; w: number; h: number; active: boolean }[] }>("windows");
    // The panel, the dock and the desktop are windows too and may sit above clients in the
    // stacking order; the comparison is about the top-most client window.
    const DECOR = new Set(["Xfce4-panel", "Plank", "Xfdesktop"]);
    const clients = windows.filter((w) => !DECOR.has(w.cls));
    const terminal = clients.find((w) => w.cls === "Xfce4-terminal");
    expect(terminal).toBeDefined();
    expect(terminal?.w).toBeGreaterThan(100);
    expect(clients[0]?.id).toBe(terminal?.id);
    launchInDesktop(C, "thunar");
    waitFor("thunar window", () => windowGeometry(C, "thunar") !== undefined, 30_000);
    sleepSync(1500);
    const again = await x.call<{ windows: { id: number; cls: string; active: boolean }[] }>("windows");
    expect(again.windows.filter((w) => !DECOR.has(w.cls))[0]?.cls).toBe("Thunar");
    const back = await x.call<{ active: number; changed: boolean; waitedMs: number }>("activate", { window: terminal?.id });
    expect(back.active).toBe(terminal?.id);
    expect(back.changed).toBe(true);
    expect(back.waitedMs).toBeLessThan(300);
    expect((await x.call<{ active: number; changed: boolean }>("activate", { window: terminal?.id })).changed).toBe(false);
  });

  it("clicks with XTest and stamps the raw press within 100 ms of the command", async () => {
    const g = windowGeometry(C, "xfce4-terminal");
    if (!g) throw new Error("no terminal");
    events.length = 0;
    const before = (await x.call<{ mono: number }>("ping")).mono;
    const reply = await x.call<{ presses: number }>("click", { x: g.x + g.w / 2, y: g.y + g.h / 2, button: 1, count: 1 });
    expect(reply.presses).toBe(1);
    const press = await waitEvent((e) => e.ev === "press" && e.kind === "button" && e.detail === 1, 500);
    const release = await waitEvent((e) => e.ev === "release" && e.kind === "button" && e.detail === 1, 500);
    expect(press).toBeDefined();
    expect(release).toBeDefined();
    expect((press?.mono ?? 0) - before).toBeGreaterThanOrEqual(0);
    expect((press?.mono ?? 0) - before).toBeLessThan(100);
    expect((release?.mono ?? 0) - (press?.mono ?? 0)).toBeLessThan(10);
  });

  it("types characters, shifted and remapped ones included, and sees the key presses", async () => {
    events.length = 0;
    for (const ch of "echo H_i é€ > /tmp/typed.txt") await x.call("char", { ch });
    const keys = await x.call<{ keycodes: number[] }>("keys", { combo: ["Return"] });
    expect(keys.keycodes).toHaveLength(1);
    const presses = events.filter((e) => e.ev === "press" && e.kind === "key");
    expect(presses.length).toBeGreaterThanOrEqual("echo H_i é€ > /tmp/typed.txt".length + 1);
    waitFor("typed file", () => dockerExec(C, "cat", "/tmp/typed.txt").status === 0, 5000);
    const typed = dockerExec(C, "cat", "/tmp/typed.txt");
    expect(typed.status, typed.out).toBe(0);
    expect(typed.out.trim()).toBe("H_i é€");
  });

  it("reports damage after a change and no visible change on a still screen", async () => {
    await x.call("arm");
    await x.call("char", { ch: "x" });
    const changed = await x.call<{ changed: number[][]; quiet: boolean; noVisibleChange: boolean; lastChange: number | null }>("settle", { quietMs: 250, timeoutMs: 3000 });
    expect(changed.noVisibleChange).toBe(false);
    expect(changed.changed.length).toBeGreaterThan(0);
    expect(changed.lastChange).toBeGreaterThan(0);
    await x.call("keys", { combo: ["BackSpace"] });
    sleepSync(500);
    await x.call("arm");
    const still = await x.call<{ noVisibleChange: boolean; quiet: boolean }>("settle", { quietMs: 250, firstMs: 800, timeoutMs: 3000 });
    expect(still.noVisibleChange).toBe(true);
    expect(still.quiet).toBe(true);
    // The session's own xfconfd, through its bus: a probe as root would start a bus of its own.
    const blink = execAsDesktopUser(C, "xfconf-query", "-c", "xsettings", "-p", "/Net/CursorBlink");
    expect(blink.status, blink.out).toBe(0);
    expect(blink.out.trim()).toBe("false");
  });

  it("launches Chromium maximized with the DevTools port on loopback", async () => {
    launchInDesktop(C, "/usr/local/bin/localdot-chromium", "about:blank");
    waitFor("chromium window", () => windowGeometry(C, "chromium") !== undefined, 60_000);
    sleepSync(3000);
    const g = windowGeometry(C, "chromium");
    expect(g?.w).toBe(2560);
    expect(g?.y).toBe(54);
    const devtools = dockerExecAs(C, "abc", "curl", "-sf", "http://127.0.0.1:9222/json/version");
    expect(devtools.status, devtools.out).toBe(0);
    expect(devtools.out).toContain("Chrome");
    expect(dockerExec(C, "sh", "-c", "grep -l localdot-chromium /usr/local/share/applications/chromium.desktop").status).toBe(0);
  });
});
```
Add `cells/*/desktopd/src/**/*.docker.test.ts` to nothing: the Docker tests stay under
`apps/daemon/src/cells/` where Part 2's config already finds them.

Run:
```bash
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktopd.docker.test.ts
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts
```
Expected: 6 tests pass in 3–5 minutes, then Part 2's image suite passes with the dock's Chromium
launcher on the override. If "lists windows" fails on `windows[0]`, print the list:
xfwm4 may keep the panel on top; the assertion is about the top-most *client* window, so filter
`cls` ∈ {`Xfce4-panel`, `Plank`, `Xfdesktop`} out of the comparison in the test, and keep that
filter in Task 7's hit test (those windows never host a target the agent clicks on purpose).

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add cells/desktop apps/daemon/src/cells
git commit -m "feat(desktopd): X helper with XTest input, raw-press stamps and damage tracking"
```

---
### Task 4: desktopd input, type, settle, clock and launch

The wire types both sides share live in `@localdot/protocol` (`desktopd.ts`), so the daemon's client
(Task 5) and `desktopd`'s routes validate the same schemas. `input()` arms the damage accumulator,
injects through the helper and returns the XI2 raw-press time it observed — or fails loudly when no
press arrives. `type()` streams one progress line per key for the first 60 characters and then every
eighth, masked at the source. `settle()` reads the accumulator. `launch()` starts an allow-listed app.

**Files:**
- Create: `packages/protocol/src/desktopd.ts`, `packages/protocol/src/desktopd.test.ts`
- Create: `cells/desktop/desktopd/src/x/keys.ts`, `cells/desktop/desktopd/src/input.ts`,
  `cells/desktop/desktopd/src/settle.ts`, `cells/desktop/desktopd/src/launch.ts`
- Modify: `packages/protocol/src/index.ts`, `cells/desktop/desktopd/src/app.ts`,
  `cells/desktop/desktopd/src/main.ts`, `cells/desktop/desktopd/package.json`
- Test: `cells/desktop/desktopd/src/x/keys.test.ts`, `cells/desktop/desktopd/src/input.test.ts`,
  `cells/desktop/desktopd/src/launch.test.ts`, `cells/desktop/desktopd/src/app.test.ts`,
  `apps/daemon/src/cells/desktopd.docker.test.ts` (part 2)

**Interfaces:**
- Consumes: `XHelper`, `XEvent` (Task 3); Part 2's committed `createDesktopdApp` and `DesktopdDeps`
  (123f443): `readXsettings(): Promise<Xsettings | null>` (null while the session's settings cannot
  be read, so `/healthz` reports not ready), `hidpiReport(scale, x: Xsettings | null)`, and
  `main.ts` passing `readXsettings: () => readXsettings(uid)` (its child processes time out after
  2 s, and an unset xsetting is told from a failed read). This task keeps all of it.
- Produces (`@localdot/protocol`): `WindowInfo`, `InputRequest { input: Input; window?: number; injector?: Injector; holdMs?: number }`,
  `InputResult { pressMono: number; presses: number[]; releaseMono?: number; injector: Injector; armedMono: number }`,
  `TypeRequest { text; masked; pace: { firstMs; firstCount; restMs }; window?; injector? }`,
  `TypeProgress { count; chunk?; pressMono }`, `TypeResult { done: true; count; firstPressMono: number | null; injector; armedMono }`,
  `SettleRequest { quietMs; firstMs; timeoutMs }`, `SettleResult { changed: Rect[]; lastChangeMono: number | null; quiet; noVisibleChange }`,
  `LaunchApp`, `LaunchRequest { app; args }`, `LaunchResult { pid; armedMono }`, `ClockResult { mono }`,
  `ObserveResult`, `HitTestRequest`, `HitTestResult { target: WireTarget | null; window; ms }`,
  `WireTarget` (a `Target` whose strings have no length limit: desktopd clips at the source and the
  gateway's `clipTarget` cuts to the event limits, so an over-long name is cut, never a failed call),
  `FindRequest` (schemas used by Tasks 5, 7, 8).
  desktopd routes: `GET /clock`, `POST /input`, `POST /type` (NDJSON stream of `TypeProgress` lines
  then one `TypeResult`), `POST /settle`, `POST /arm`, `POST /launch`; 400 on a bad body, 501 for an
  input kind or injector that is not available, 504 when no raw press arrives, 503 without the helper.
  `DesktopdDeps` gains `x?: XHelper`, `launch?: (req: LaunchRequest) => { pid: number }`,
  `injectors?: Injectors` (`{ xtest: true; driver?: DriverInjector }`, `DriverInjector { click(req: InputRequest); type(req: TypeRequest) }` — clicks and typed text only, P3-C9), `clockMono?: () => number`.
  `keyName(name): string` (normalises `ctrl`/`control` → `Control_L`, `enter` → `Return`, `cmd`/`super`
  → `Super_L`, `pageup` → `Prior`, letters lower-cased, `F1`…`F12`, single characters as themselves).
  `withPress(x, match, count, act, timeoutMs)`, `inject(x, req)`,
  `typeText(x, req, onProgress, injectors?, signal?)` (stops between characters once `signal`
  aborts; the `/type` route passes the request's own signal, so a closed request stops the typing),
  `PRESS_TIMEOUT_MS = 150`, `NoPressError`, `UnsupportedInputError`.

- [ ] **Step 1: The shared wire schemas, test first**

`packages/protocol/src/desktopd.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { HitTestResult, InputRequest, LaunchRequest, SettleRequest, TypeRequest } from "./desktopd.ts";

describe("desktopd wire schemas", () => {
  it("defaults the injector to xtest and the hold to 0", () => {
    const req = InputRequest.parse({ input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } } });
    expect(req.injector).toBe("xtest");
    expect(req.holdMs).toBe(0);
  });

  it("caps typed text and rejects an unknown app", () => {
    expect(() => TypeRequest.parse({ text: "x".repeat(4001), masked: false, pace: { firstMs: 35, firstCount: 60, restMs: 6 } })).toThrow();
    expect(() => LaunchRequest.parse({ app: "bash" })).toThrow();
    expect(LaunchRequest.parse({ app: "terminal" }).args).toEqual([]);
  });

  it("defaults settle to 250 ms quiet, 1500 ms first change, 3 s cap", () => {
    expect(SettleRequest.parse({})).toEqual({ quietMs: 250, firstMs: 1500, timeoutMs: 3000 });
  });

  it("carries a target name of any length for the gateway to cut", () => {
    const long = { point: { x: 1, y: 2 }, source: "ax", name: "n".repeat(300), window: "w".repeat(400) };
    expect(HitTestResult.parse({ target: long, window: 7, ms: 3 }).target?.name).toHaveLength(300);
  });
});
```

`packages/protocol/src/desktopd.ts`:
```ts
import { z } from "zod";
import { Injector } from "./events.ts";
import { Point, Rect } from "./geometry.ts";
import { ULID_PATTERN } from "./ids.ts";
import { Input } from "./input.ts";
import { Target } from "./target.ts";

// desktopd's HTTP API (spec, "desktopd" table). Times are the cell's CLOCK_MONOTONIC milliseconds.

export const WindowInfo = z.object({
  id: z.number().int().nonnegative(),
  pid: z.number().int().nonnegative(),
  cls: z.string().max(128),
  title: z.string().max(256),
  rect: Rect,
  frame: Rect,
  active: z.boolean(),
});
export type WindowInfo = z.infer<typeof WindowInfo>;

export const InputRequest = z.object({
  input: Input,
  window: z.number().int().nonnegative().optional(),
  injector: Injector.default("xtest"),
  holdMs: z.number().nonnegative().max(500).default(0),
});
export type InputRequest = z.infer<typeof InputRequest>;

export const InputResult = z.object({
  pressMono: z.number(),
  presses: z.array(z.number()),
  releaseMono: z.number().optional(),
  injector: Injector,
  armedMono: z.number(),
});
export type InputResult = z.infer<typeof InputResult>;

export const TypePace = z.object({
  firstMs: z.number().nonnegative(),
  firstCount: z.number().int().nonnegative(),
  restMs: z.number().nonnegative(),
});
export const TypeRequest = z.object({
  text: z.string().min(1).max(4000),
  masked: z.boolean(),
  pace: TypePace,
  window: z.number().int().nonnegative().optional(),
  injector: Injector.default("xtest"),
});
export type TypeRequest = z.infer<typeof TypeRequest>;
export const TypeProgress = z.object({
  count: z.number().int().positive(),
  chunk: z.string().optional(),
  pressMono: z.number(),
});
export type TypeProgress = z.infer<typeof TypeProgress>;
export const TypeResult = z.object({
  done: z.literal(true),
  count: z.number().int().nonnegative(),
  firstPressMono: z.number().nullable(),
  injector: Injector,
  armedMono: z.number(),
});
export type TypeResult = z.infer<typeof TypeResult>;

export const SettleRequest = z.object({
  quietMs: z.number().positive().max(5000).default(250),
  firstMs: z.number().positive().max(10_000).default(1500),
  timeoutMs: z.number().positive().max(30_000).default(3000),
});
export type SettleRequest = z.infer<typeof SettleRequest>;
export const SettleResult = z.object({
  changed: z.array(Rect),
  lastChangeMono: z.number().nullable(),
  quiet: z.boolean(),
  noVisibleChange: z.boolean(),
});
export type SettleResult = z.infer<typeof SettleResult>;

export const LaunchApp = z.enum([
  "chromium", "calc", "writer", "impress", "terminal", "thunar", "mousepad", "codium", "gimp",
]);
export type LaunchApp = z.infer<typeof LaunchApp>;
export const LaunchRequest = z.object({
  app: LaunchApp,
  args: z.array(z.string().max(2048)).max(16).default([]),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;
export const LaunchResult = z.object({ pid: z.number().int().positive(), armedMono: z.number() });
export type LaunchResult = z.infer<typeof LaunchResult>;

export const ClockResult = z.object({ mono: z.number() });
export type ClockResult = z.infer<typeof ClockResult>;

export const ObserveResult = z.object({
  frameId: z.string().regex(ULID_PATTERN),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  image: z.string(),
  pointer: Point,
  windows: z.array(WindowInfo),
});
export type ObserveResult = z.infer<typeof ObserveResult>;

export const HitTestRequest = z.object({ point: Point });
export type HitTestRequest = z.infer<typeof HitTestRequest>;
// desktopd clips names at the source and the gateway's clipTarget cuts to the event limits before
// it appends, so the wire repeats neither limit: an over-long name is cut, never a failed call.
export const WireTarget = Target.extend({
  role: z.string().optional(),
  name: z.string().optional(),
  app: z.string().optional(),
  window: z.string().optional(),
  url: z.string().optional(),
});
export type WireTarget = z.infer<typeof WireTarget>;
export const HitTestResult = z.object({
  target: WireTarget.nullable(),
  window: z.number().int().nonnegative().nullable(),
  ms: z.number().nonnegative(),
});
export type HitTestResult = z.infer<typeof HitTestResult>;

export const FindRequest = z.object({
  name: z.string().min(1).max(256),
  role: z.string().max(64).optional(),
  app: z.string().max(128).optional(),
});
export type FindRequest = z.infer<typeof FindRequest>;
```
`packages/protocol/src/index.ts` — add `export * from "./desktopd.ts";`.

Run: `pnpm exec vitest run packages/protocol/src/desktopd.test.ts`
Expected: 4 tests pass.

- [ ] **Step 2: Key names, input and launch — failing tests**

`cells/desktop/desktopd/src/x/keys.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { keyName } from "./keys.ts";

describe("keyName", () => {
  it("maps the common aliases onto X keysym names", () => {
    expect(["ctrl", "control", "Control"].map(keyName)).toEqual(["Control_L", "Control_L", "Control_L"]);
    expect(["enter", "Return", "esc", "cmd", "super", "win", "alt", "shift", "pageup", "pagedown", "backspace", "tab", "space", "delete"].map(keyName))
      .toEqual(["Return", "Return", "Escape", "Super_L", "Super_L", "Super_L", "Alt_L", "Shift_L", "Prior", "Next", "BackSpace", "Tab", "space", "Delete"]);
    expect(keyName("F5")).toBe("F5");
    expect(keyName("f12")).toBe("F12");
  });

  it("lower-cases letters and passes other single characters through", () => {
    expect(keyName("L")).toBe("l");
    expect(keyName("é")).toBe("é");
    expect(keyName("/")).toBe("/");
  });

  it("rejects names it does not know", () => {
    expect(() => keyName("hyperkey")).toThrow(/unknown key/);
  });
});
```

`cells/desktop/desktopd/src/input.test.ts` (a scripted fake `XHelper`: each call records its
arguments and can emit events before or after replying):
```ts
import type { InputRequest, TypeProgress, TypeRequest } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { inject, NoPressError, typeText, UnsupportedInputError, withPress } from "./input.ts";
import type { XEvent, XHelper } from "./x/helper.ts";

interface Scripted {
  helper: XHelper;
  calls: { cmd: string; args: Record<string, unknown> }[];
  emit(e: XEvent): void;
}

function scripted(reply: (cmd: string, args: Record<string, unknown>, emit: (e: XEvent) => void) => object): Scripted {
  const listeners = new Set<(e: XEvent) => void>();
  const calls: Scripted["calls"] = [];
  const emit = (e: XEvent) => {
    for (const l of listeners) l(e);
  };
  // Below the scripted presses (500 and up), as a real arm precedes its press.
  let mono = 100;
  const helper: XHelper = {
    alive: true,
    async call(cmd, args = {}) {
      calls.push({ cmd, args });
      if (cmd === "ping" || cmd === "arm") {
        mono += 1;
        return { mono } as never;
      }
      return reply(cmd, args, emit) as never;
    },
    onEvent(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async close() {},
  };
  return { helper, calls, emit };
}

const press = (kind: XEvent["kind"], detail: number, mono: number): XEvent => ({ ev: "press", kind, detail, mono });
const click: InputRequest = { input: { kind: "click", button: "left", count: 1, at: { x: 10, y: 20 } }, injector: "xtest", holdMs: 0 };

describe("withPress", () => {
  it("sees a press that lands before the reply", async () => {
    const s = scripted((_cmd, _args, emit) => {
      emit(press("button", 1, 5));
      return { button: 1, presses: 1 };
    });
    const hits = await withPress(s.helper, (e) => e.kind === "button", 1, () => s.helper.call("click"));
    expect(hits.map((h) => h.mono)).toEqual([5]);
  });

  it("waits up to the timeout for a press that lands after the reply", async () => {
    const s = scripted((_cmd, _args, emit) => {
      setTimeout(() => emit(press("key", 38, 7)), 20);
      return { keycode: 38 };
    });
    const hits = await withPress(s.helper, (e) => e.kind === "key", 1, () => s.helper.call("char"), 150);
    expect(hits[0]?.mono).toBe(7);
  });

  it("fails loudly when no raw press arrives", async () => {
    const s = scripted(() => ({ button: 1, presses: 1 }));
    await expect(withPress(s.helper, () => true, 1, () => s.helper.call("silent-click"), 30)).rejects.toThrow(NoPressError);
  });
});

describe("inject", () => {
  it("arms, activates the window when given, clicks, and returns the first raw press", async () => {
    const s = scripted((cmd, args, emit) => {
      if (cmd === "activate") return { active: args.window, changed: true, waitedMs: 12 };
      emit(press("button", 1, 500));
      emit({ ev: "release", kind: "button", detail: 1, mono: 501 });
      return { button: 1, presses: 1 };
    });
    const res = await inject(s.helper, { ...click, window: 77 });
    expect(s.calls.map((c) => c.cmd)).toEqual(["arm", "activate", "click"]);
    expect(s.calls[2]?.args).toMatchObject({ x: 10, y: 20, button: 1, count: 1, holdMs: 0 });
    expect(res).toMatchObject({ pressMono: 500, presses: [500], releaseMono: 501, injector: "xtest" });
    expect(res.armedMono).toBeLessThan(500);
  });

  it("maps buttons and double clicks and returns every press", async () => {
    let n = 0;
    const s = scripted((cmd, _args, emit) => {
      if (cmd !== "click") return {};
      emit(press("button", 3, 600 + n++));
      emit(press("button", 3, 700 + n++));
      return { button: 3, presses: 2 };
    });
    const res = await inject(s.helper, { ...click, input: { kind: "click", button: "right", count: 2, at: { x: 1, y: 1 } } });
    expect(res.presses).toEqual([600, 701]);
    expect(s.calls.find((c) => c.cmd === "click")?.args).toMatchObject({ button: 3, count: 2 });
  });

  it("presses key combos and takes the last key's press time", async () => {
    const s = scripted((_cmd, _args, emit) => {
      emit(press("key", 37, 10));
      emit(press("key", 46, 12));
      return { keycodes: [37, 46] };
    });
    const res = await inject(s.helper, { ...click, input: { kind: "key", combo: ["ctrl", "L"] } });
    expect(s.calls.find((c) => c.cmd === "keys")?.args).toEqual({ combo: ["Control_L", "l"] });
    expect(res.pressMono).toBe(12);
    expect(res.presses).toEqual([10, 12]);
  });

  it("scrolls in notches and times the first notch", async () => {
    const s = scripted((_cmd, args, emit) => {
      for (let i = 0; i < Number(args.dy); i++) emit(press("button", 5, 20 + i));
      return { notches: args.dy };
    });
    const res = await inject(s.helper, { ...click, input: { kind: "scroll", at: { x: 5, y: 5 }, dx: 0, dy: 3 } });
    expect(res.pressMono).toBe(20);
    expect(res.presses).toHaveLength(3);
  });

  it("refuses drags, the driver injector until it exists, and anything but clicks through the driver", async () => {
    const s = scripted(() => ({}));
    await expect(inject(s.helper, { ...click, input: { kind: "drag", from: { x: 0, y: 0 }, to: { x: 9, y: 9 } } })).rejects.toThrow(UnsupportedInputError);
    await expect(inject(s.helper, { ...click, injector: "driver" })).rejects.toThrow(UnsupportedInputError);
    const driver = { click: async () => {}, type: async () => {} };
    await expect(inject(s.helper, { ...click, input: { kind: "key", combo: ["ctrl", "s"] }, injector: "driver" }, { xtest: true, driver })).rejects.toThrow(/key through the driver injector/);
    await expect(inject(s.helper, { ...click, input: { kind: "scroll", at: { x: 5, y: 5 }, dx: 0, dy: 1 }, injector: "driver" }, { xtest: true, driver })).rejects.toThrow(UnsupportedInputError);
    expect(s.calls.filter((c) => c.cmd === "arm")).toHaveLength(0);
  });

  it("delivers a click through the driver injector and still times it from the raw press", async () => {
    const s = scripted(() => ({}));
    const driver = {
      click: async () => {
        s.emit(press("button", 1, 41));
        s.emit({ ev: "release", kind: "button", detail: 1, mono: 90 });
      },
      type: async () => {},
    };
    const res = await inject(s.helper, { ...click, injector: "driver" }, { xtest: true, driver });
    expect(res).toMatchObject({ pressMono: 41, releaseMono: 90, injector: "driver" });
    expect(s.calls.map((c) => c.cmd)).toEqual(["arm"]);
  });
});

describe("typeText", () => {
  const pace = { firstMs: 0, firstCount: 60, restMs: 0 };
  it("types one character at a time, reports progress per key for the first 60 then every 8th, and masks at the source", async () => {
    let t = 0;
    const s = scripted((cmd, _args, emit) => {
      if (cmd === "char") {
        t += 1;
        emit(press("key", 30, t));
      }
      return { keycode: 30, mods: [] };
    });
    const text = "a".repeat(70);
    const progress: TypeProgress[] = [];
    const req: TypeRequest = { text, masked: false, pace, injector: "xtest" };
    const res = await typeText(s.helper, req, (p) => {
      progress.push(p);
    });
    expect(res).toMatchObject({ done: true, count: 70, firstPressMono: 1, injector: "xtest" });
    expect(progress.map((p) => p.count)).toEqual([...Array.from({ length: 60 }, (_, i) => i + 1), 68, 70]);
    expect(progress[0]?.chunk).toBe("a");
    expect(progress[60]?.chunk).toBe("a".repeat(8));
    expect(progress.at(-1)?.chunk).toBe("aa");
    expect(s.calls.filter((c) => c.cmd === "char")).toHaveLength(70);
    expect(s.calls[0]?.cmd).toBe("arm");

    const masked: TypeProgress[] = [];
    await typeText(s.helper, { ...req, text: "hunter2", masked: true }, (p) => {
      masked.push(p);
    });
    expect(masked.every((p) => p.chunk === undefined)).toBe(true);
    expect(masked.at(-1)?.count).toBe(7);
    expect(JSON.stringify(s.calls.slice(-7))).toContain('"ch":"h"');
  });

  it("types through the driver as one string, reporting the first raw press and the final count", async () => {
    const s = scripted(() => ({}));
    const typed: string[] = [];
    const driver = {
      click: async () => {},
      type: async (req: TypeRequest) => {
        typed.push(req.text);
        s.emit(press("key", 43, 500));
        s.emit(press("key", 31, 540));
      },
    };
    const progress: TypeProgress[] = [];
    const res = await typeText(s.helper, { text: "hi", masked: false, pace, injector: "driver" }, (p) => {
      progress.push(p);
    }, { xtest: true, driver });
    expect(typed).toEqual(["hi"]);
    expect(progress).toEqual([{ count: 2, chunk: "hi", pressMono: 500 }]);
    expect(res).toMatchObject({ done: true, count: 2, firstPressMono: 500, injector: "driver" });
    expect(s.calls.filter((c) => c.cmd === "char")).toHaveLength(0);
    await expect(typeText(s.helper, { text: "x", masked: false, pace, injector: "driver" }, () => {})).rejects.toThrow(UnsupportedInputError);
  });

  it("fails loudly on the first key without a raw press", async () => {
    const s = scripted(() => ({ keycode: 30, mods: [] }));
    await expect(typeText(s.helper, { text: "ab", masked: false, pace, injector: "xtest" }, () => {})).rejects.toThrow(NoPressError);
  });

  it("stops between characters once its signal aborts", async () => {
    const ac = new AbortController();
    let t = 0;
    const s = scripted((cmd, _args, emit) => {
      if (cmd === "char") {
        t += 1;
        emit(press("key", 30, t));
        if (t === 2) ac.abort();
      }
      return { keycode: 30, mods: [] };
    });
    const typing = typeText(s.helper, { text: "abcdef", masked: false, pace, injector: "xtest" }, () => {}, { xtest: true }, ac.signal);
    await expect(typing).rejects.toThrow(/aborted/);
    expect(s.calls.filter((c) => c.cmd === "char")).toHaveLength(2);
  });
});
```

`cells/desktop/desktopd/src/launch.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LAUNCHERS, launchApp } from "./launch.ts";

describe("launchApp", () => {
  it("spawns the allow-listed command detached with the display environment", () => {
    const seen: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawnImpl = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      seen.push({ cmd, args, opts });
      return { pid: 4242, unref() {} };
    }) as never;
    const res = launchApp({ app: "chromium", args: ["--kiosk", "file:///opt/localdot/flash.html"] }, { DISPLAY: ":1" }, spawnImpl);
    expect(res.pid).toBe(4242);
    expect(seen[0]?.cmd).toBe(LAUNCHERS.chromium[0]);
    expect(seen[0]?.args).toEqual(["--kiosk", "file:///opt/localdot/flash.html"]);
    expect(seen[0]?.opts).toMatchObject({ detached: true, stdio: "ignore", env: { DISPLAY: ":1" } });
  });

  it("refuses arguments beyond the allow-listed flags and file URLs under /opt/localdot or /config", () => {
    const spawnImpl = (() => ({ pid: 1, unref() {} })) as never;
    expect(() => launchApp({ app: "terminal", args: ["-e", "rm -rf /"] }, {}, spawnImpl)).toThrow(/argument/);
    expect(() => launchApp({ app: "chromium", args: ["http://example.com"] }, {}, spawnImpl)).toThrow(/argument/);
    expect(() => launchApp({ app: "chromium", args: ["file:///opt/localdot/../../etc/passwd"] }, {}, spawnImpl)).toThrow(/argument/);
    expect(() => launchApp({ app: "thunar", args: ["/config/../etc"] }, {}, spawnImpl)).toThrow(/argument/);
    expect(() => launchApp({ app: "chromium", args: ["--remote-debugging-address=0.0.0.0"] }, {}, spawnImpl)).toThrow(/argument/);
    expect(() => launchApp({ app: "chromium", args: ["--proxy-server=127.0.0.1:1"] }, {}, spawnImpl)).toThrow(/argument/);
    expect(() => launchApp({ app: "chromium", args: ["--user-data-dir=/tmp/x"] }, {}, spawnImpl)).toThrow(/argument/);
    expect(launchApp({ app: "chromium", args: ["--new-window", "--incognito", "about:blank"] }, {}, spawnImpl).pid).toBe(1);
  });
});
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src`
Expected: FAIL — `keys.ts`, `input.ts`, `launch.ts` do not exist.

- [ ] **Step 3: Implement keys, input, settle and launch**

`cells/desktop/desktopd/src/x/keys.ts`:
```ts
const ALIASES: Record<string, string> = {
  ctrl: "Control_L", control: "Control_L", alt: "Alt_L", option: "Alt_L", shift: "Shift_L",
  cmd: "Super_L", super: "Super_L", win: "Super_L", meta: "Super_L",
  enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", space: "space",
  backspace: "BackSpace", delete: "Delete", del: "Delete", insert: "Insert",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End",
  pageup: "Prior", pagedown: "Next", prior: "Prior", next: "Next", menu: "Menu", print: "Print",
};
const X_NAMES = new Set([...Object.values(ALIASES), "ISO_Level3_Shift"]);

// Normalises a key name from a script or a model onto the X keysym names xhelper.py knows.
export function keyName(name: string): string {
  if (name.length === 1) return /[A-Z]/.test(name) ? name.toLowerCase() : name;
  const lower = name.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return `F${lower.slice(1)}`;
  if (X_NAMES.has(name)) return name;
  throw new RangeError(`unknown key ${JSON.stringify(name)}`);
}
```

`cells/desktop/desktopd/src/input.ts`:
```ts
import { setTimeout as sleep } from "node:timers/promises";
import type { Injector, InputRequest, InputResult, TypeProgress, TypeRequest, TypeResult } from "@localdot/protocol";
import type { XEvent, XHelper } from "./x/helper.ts";
import { keyName } from "./x/keys.ts";

export const PRESS_TIMEOUT_MS = 150;
const PROGRESS_EVERY = 8;
const BUTTONS = { left: 1, middle: 2, right: 3 } as const;

export class NoPressError extends Error {
  constructor(what: string) {
    super(`no raw press observed for ${what} within ${PRESS_TIMEOUT_MS} ms`);
    this.name = "NoPressError";
  }
}

export class UnsupportedInputError extends Error {
  constructor(what: string) {
    super(`${what} is not available in this desktopd`);
    this.name = "UnsupportedInputError";
  }
}

// The subscription opens before the helper call, so a raw press that lands before the reply is
// still seen; resolves with the first `count` matching presses or fails loudly (Review Focus 2).
export async function withPress(
  x: XHelper,
  match: (e: XEvent) => boolean,
  count: number,
  act: () => Promise<unknown>,
  timeoutMs = PRESS_TIMEOUT_MS,
): Promise<XEvent[]> {
  const hits: XEvent[] = [];
  let done!: () => void;
  const complete = new Promise<void>((resolve) => {
    done = resolve;
  });
  const off = x.onEvent((e) => {
    if (e.ev === "press" && match(e)) {
      hits.push(e);
      if (hits.length >= count) done();
    }
  });
  try {
    await act();
    if (hits.length < count) {
      const ac = new AbortController();
      const timeout = sleep(timeoutMs, undefined, { signal: ac.signal }).then(() => false, () => true);
      const arrived = complete.then(() => true);
      const ok = await Promise.race([arrived, timeout]);
      ac.abort();
      if (!ok) throw new NoPressError(`${count} press(es)`);
    }
    return hits.slice(0, count);
  } finally {
    off();
  }
}

// The Cua Driver fallback (D12, P3-C9) delivers clicks and typed text, both with XTest-like
// foreground delivery the XI2 listener still times. Its press_key is XSendEvent, invisible to
// XI2, so key combos, moves and scrolls stay on the own-XTest path or are refused.
export interface DriverInjector {
  click(req: InputRequest): Promise<void>;
  type(req: TypeRequest): Promise<void>;
}

export interface Injectors {
  xtest: true;
  driver?: DriverInjector;
}

function driverFor(injectors: Injectors, what: string): DriverInjector {
  if (!injectors.driver) throw new UnsupportedInputError("the driver injector");
  if (what !== "click" && what !== "type") throw new UnsupportedInputError(`${what} through the driver injector (it delivers clicks and typed text only)`);
  return injectors.driver;
}

export async function inject(x: XHelper, req: InputRequest, injectors: Injectors = { xtest: true }): Promise<InputResult> {
  const { input } = req;
  if (input.kind === "drag") throw new UnsupportedInputError("drag");
  if (input.kind === "wait" || input.kind === "type") throw new UnsupportedInputError(`${input.kind} through /input`);
  const driver = req.injector === "driver" ? driverFor(injectors, input.kind) : undefined;
  const { mono: armedMono } = await x.call<{ mono: number }>("arm");
  if (req.window !== undefined) await x.call("activate", { window: req.window });
  const injector: Injector = req.injector;

  if (input.kind === "click") {
    const button = BUTTONS[input.button];
    const releases: XEvent[] = [];
    const offRelease = x.onEvent((e) => {
      if (e.ev === "release" && e.kind === "button" && e.detail === button) releases.push(e);
    });
    try {
      const presses = await withPress(
        x,
        (e) => e.kind === "button" && e.detail === button,
        input.count,
        () => (driver ? driver.click(req) : x.call("click", { x: input.at.x, y: input.at.y, button, count: input.count, holdMs: req.holdMs, mods: (input.mods ?? []).map(keyName) })),
      );
      await sleep(5);
      const first = presses[0] as XEvent;
      const release = releases.find((r) => r.mono >= first.mono);
      return { pressMono: first.mono, presses: presses.map((p) => p.mono), ...(release ? { releaseMono: release.mono } : {}), injector, armedMono };
    } finally {
      offRelease();
    }
  }
  if (input.kind === "move") {
    const { mono } = await x.call<{ mono: number }>("move", { x: input.to.x, y: input.to.y });
    return { pressMono: mono, presses: [], injector, armedMono };
  }
  if (input.kind === "scroll") {
    const notches = Math.abs(Math.trunc(input.dx)) + Math.abs(Math.trunc(input.dy));
    if (notches === 0) throw new RangeError("scroll needs at least one notch");
    const presses = await withPress(
      x,
      (e) => e.kind === "button" && e.detail >= 4 && e.detail <= 7,
      notches,
      () => x.call("scroll", { x: input.at.x, y: input.at.y, dx: Math.trunc(input.dx), dy: Math.trunc(input.dy) }),
      PRESS_TIMEOUT_MS + notches * 10,
    );
    return { pressMono: (presses[0] as XEvent).mono, presses: presses.map((p) => p.mono), injector, armedMono };
  }
  const combo = input.combo.map(keyName);
  const presses = await withPress(x, (e) => e.kind === "key", combo.length, () => x.call("keys", { combo }));
  return { pressMono: (presses.at(-1) as XEvent).mono, presses: presses.map((p) => p.mono), injector, armedMono };
}

// `signal` is the request's: a Stop closes the daemon's request, and typing ends at the next key.
export async function typeText(
  x: XHelper,
  req: TypeRequest,
  onProgress: (p: TypeProgress) => void | Promise<void>,
  injectors: Injectors = { xtest: true },
  signal?: AbortSignal,
): Promise<TypeResult> {
  const driver = req.injector === "driver" ? driverFor(injectors, "type") : undefined;
  const { mono: armedMono } = await x.call<{ mono: number }>("arm");
  if (req.window !== undefined) await x.call("activate", { window: req.window });
  const chars = [...req.text];
  if (driver) {
    signal?.throwIfAborted();
    // type_text delivers the whole string at the driver's own pace and withPress waits for that
    // call, so the one progress line follows the delivery: the whole count, stamped with the first
    // raw press (the keycap and the ring are timed from it).
    const [first] = await withPress(x, (e) => e.kind === "key", 1, () => driver.type(req), PRESS_TIMEOUT_MS + chars.length * 50);
    const pressMono = (first as XEvent).mono;
    await onProgress({ count: chars.length, ...(req.masked ? {} : { chunk: req.text }), pressMono });
    return { done: true, count: chars.length, firstPressMono: pressMono, injector: req.injector, armedMono };
  }
  let count = 0;
  let firstPressMono: number | null = null;
  let chunk = "";
  for (const [i, ch] of chars.entries()) {
    signal?.throwIfAborted();
    const delay = i < req.pace.firstCount ? req.pace.firstMs : req.pace.restMs;
    if (delay > 0 && i > 0) await sleep(delay);
    const [press] = await withPress(x, (e) => e.kind === "key", 1, () => x.call("char", { ch }));
    count += 1;
    chunk += ch;
    firstPressMono ??= (press as XEvent).mono;
    const last = i === chars.length - 1;
    if (count <= req.pace.firstCount || (count - req.pace.firstCount) % PROGRESS_EVERY === 0 || last) {
      await onProgress({ count, ...(req.masked ? {} : { chunk }), pressMono: (press as XEvent).mono });
      chunk = "";
    }
  }
  return { done: true, count, firstPressMono, injector: req.injector, armedMono };
}
```

`cells/desktop/desktopd/src/settle.ts`:
```ts
import type { SettleRequest, SettleResult } from "@localdot/protocol";
import type { XHelper } from "./x/helper.ts";

interface HelperSettle {
  changed: [number, number, number, number][];
  lastChange: number | null;
  quiet: boolean;
  noVisibleChange: boolean;
}

export async function settle(x: XHelper, req: SettleRequest): Promise<SettleResult> {
  const r = await x.call<HelperSettle>("settle", req, req.timeoutMs + 1000);
  return {
    changed: r.changed.map(([x0, y0, w, h]) => ({ x: x0, y: y0, w, h })),
    lastChangeMono: r.lastChange,
    quiet: r.quiet,
    noVisibleChange: r.noVisibleChange,
  };
}
```

`cells/desktop/desktopd/src/launch.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import type { LaunchApp, LaunchRequest } from "@localdot/protocol";

export const LAUNCHERS: Record<LaunchApp, string[]> = {
  chromium: ["/usr/local/bin/localdot-chromium"],
  calc: ["libreoffice", "--calc", "--norestore"],
  writer: ["libreoffice", "--writer", "--norestore"],
  impress: ["libreoffice", "--impress", "--norestore"],
  terminal: ["xfce4-terminal"],
  thunar: ["thunar"],
  mousepad: ["mousepad"],
  codium: ["codium"],
  gimp: ["gimp"],
};

// Launch arguments are the few flags the puppet needs and files the desktop already holds (never
// a flag that re-points Chromium's DevTools, proxy or profile, nor a `..` that leaves those
// folders); the agent's own commands come through the shell tool (M4), never through launch.
const ARGUMENT = /^(--kiosk|--new-window|--incognito|about:blank|file:\/\/\/(opt\/localdot|config)\/[^\s]*|\/(opt\/localdot|config)\/[^\s]*)$/;
const PARENT_SEGMENT = /(^|\/)\.\.(\/|$)/;

type SpawnLike = (cmd: string, args: string[], opts: Record<string, unknown>) => Pick<ChildProcess, "pid" | "unref">;

export function launchApp(req: LaunchRequest, env: NodeJS.ProcessEnv = process.env, spawnImpl: SpawnLike = spawn as unknown as SpawnLike): { pid: number } {
  for (const a of req.args) {
    if (!ARGUMENT.test(a) || PARENT_SEGMENT.test(a)) throw new RangeError(`launch argument not allowed: ${JSON.stringify(a)}`);
  }
  const [cmd, ...base] = LAUNCHERS[req.app];
  const child = spawnImpl(cmd as string, [...base, ...req.args], { detached: true, stdio: "ignore", env });
  child.unref();
  if (!child.pid) throw new Error(`could not launch ${req.app}`);
  return { pid: child.pid };
}
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src`
Expected: the keys, input and launch tests pass (Part 2's app tests still pass).

- [ ] **Step 4: Routes — failing app tests, then the implementation**

Append to `cells/desktop/desktopd/src/app.test.ts` (keep Part 2's `app()` helper and tests; extend
the import to `import { createDesktopdApp, type DesktopdHealth, hidpiReport } from "./app.ts";`
plus `import type { XEvent, XHelper } from "./x/helper.ts";`):
```ts
function fakeX(): XHelper & { emit(e: XEvent): void; calls: string[] } {
  const listeners = new Set<(e: XEvent) => void>();
  const calls: string[] = [];
  let mono = 100;
  return {
    alive: true,
    calls,
    emit: (e) => {
      for (const l of listeners) l(e);
    },
    async call(cmd, args = {}) {
      calls.push(cmd);
      mono += 1;
      if (cmd === "ping" || cmd === "arm" || cmd === "move") return { mono } as never;
      if (cmd === "click") {
        for (const l of listeners) l({ ev: "press", kind: "button", detail: Number(args.button), mono });
        return { button: args.button, presses: 1 } as never;
      }
      if (cmd === "char") {
        for (const l of listeners) l({ ev: "press", kind: "key", detail: 30, mono });
        return { keycode: 30, mods: [] } as never;
      }
      if (cmd === "settle") return { changed: [[1, 2, 3, 4]], lastChange: mono, quiet: true, noVisibleChange: false } as never;
      return {} as never;
    },
    onEvent(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async close() {},
  };
}

function fullApp(x: XHelper) {
  return createDesktopdApp({
    token: TOKEN,
    scale: 2,
    display: ":1",
    readXsettings: async () => ({ windowScalingFactor: 2, xftDpi: 96 }),
    readScreen: async () => ({ w: 2560, h: 1600 }),
    x,
    launch: (req) => ({ pid: 999 + req.args.length }),
    clockMono: () => 42.5,
  });
}

describe("desktopd input routes", () => {
  it("answers the clock and injects a click with the raw press time", async () => {
    const a = fullApp(fakeX());
    expect(await (await a.request("/clock", { headers: bearer })).json()).toEqual({ mono: 42.5 });
    const res = await a.request("/input", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } } }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pressMono: expect.any(Number), presses: [expect.any(Number)], injector: "xtest" });
  });

  it("rejects bad bodies, unsupported kinds and reports a missing press as 504", async () => {
    const x = fakeX();
    x.call = (async (cmd: string) => (cmd === "arm" ? { mono: 1 } : { presses: 1 })) as never;
    const a = fullApp(x);
    const post = (body: unknown) => a.request("/input", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ input: { kind: "teleport" } })).status).toBe(400);
    expect((await post({ input: { kind: "drag", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } })).status).toBe(501);
    expect((await post({ input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } } })).status).toBe(504);
  });

  it("streams typing progress as NDJSON and ends with the result", async () => {
    const a = fullApp(fakeX());
    const res = await a.request("/type", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ text: "hi", masked: false, pace: { firstMs: 0, firstCount: 60, restMs: 0 } }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.count)).toEqual([1, 2, 2]);
    expect(lines[0]).toMatchObject({ chunk: "h" });
    expect(lines[2]).toMatchObject({ done: true, count: 2, injector: "xtest" });
  });

  it("settles, arms and launches", async () => {
    const x = fakeX();
    const a = fullApp(x);
    const settled = await a.request("/settle", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: "{}" });
    expect(await settled.json()).toMatchObject({ changed: [{ x: 1, y: 2, w: 3, h: 4 }], quiet: true, noVisibleChange: false });
    expect((await a.request("/arm", { method: "POST", headers: bearer })).status).toBe(200);
    const launched = await a.request("/launch", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ app: "terminal" }) });
    expect(await launched.json()).toMatchObject({ pid: 999, armedMono: expect.any(Number) });
    expect((await a.request("/launch", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ app: "bash" }) })).status).toBe(400);
  });

  it("answers 503 on the input routes when the helper is missing", async () => {
    const a = app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } });
    expect((await a.request("/input", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: "{}" })).status).toBe(503);
    expect((await a.request("/settle", { method: "POST", headers: bearer })).status).toBe(503);
  });
});
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src/app.test.ts`
Expected: FAIL, the 5 new tests — every new route answers 404 (Part 2's 7 tests still pass); the
typecheck rejects the new `DesktopdDeps` options as well.

`cells/desktop/desktopd/src/app.ts` — Part 2's file (commit 123f443) plus the input routes. The
whole file below keeps Part 2's health code as it is: `readXsettings()` may resolve `null` (the
session's settings cannot be read yet), and `hidpiReport` reports such unknown settings as not ok,
so `/healthz` answers 200 with `ok: false` until the session is up and the daemon keeps polling.
Only the imports, four optional dependencies, `monoNow`, `statusOf` and the routes after
`/healthz` are new:
```ts
import {
  InputRequest,
  type InputResult,
  LaunchRequest,
  type LaunchResult,
  SettleRequest,
  TypeRequest,
  type TypeResult,
} from "@localdot/protocol";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { bearerMatches } from "./auth.ts";
import { type Injectors, inject, NoPressError, typeText, UnsupportedInputError } from "./input.ts";
import { settle } from "./settle.ts";
import type { XHelper } from "./x/helper.ts";
import type { Screen, Xsettings } from "./xsettings.ts";

export type Scale = 1 | 2;

export interface DesktopdDeps {
  token: string;
  scale: Scale;
  display: string;
  // null until the session's settings can be read without disturbing its start.
  readXsettings(): Promise<Xsettings | null>;
  readScreen(): Promise<Screen | null>;
  x?: XHelper;
  injectors?: Injectors;
  launch?: (req: LaunchRequest) => { pid: number };
  clockMono?: () => number;
}

export interface HidpiReport {
  ok: boolean;
  expected: { windowScalingFactor: Scale; xftDpi: 96 };
  windowScalingFactor: number | null;
  xftDpi: number | null;
}

export interface DesktopdHealth {
  ok: boolean;
  scale: Scale;
  display: string;
  screen: Screen | null;
  hidpi: HidpiReport;
}

const SCREEN: Record<Scale, Screen> = { 1: { w: 1280, h: 800 }, 2: { w: 2560, h: 1600 } };

// Unknown settings (null) are never ok; an unset property (a null field) is XFCE's default.
export function hidpiReport(scale: Scale, x: Xsettings | null): HidpiReport {
  const expected: HidpiReport["expected"] = { windowScalingFactor: scale, xftDpi: 96 };
  if (x === null) return { ok: false, expected, windowScalingFactor: null, xftDpi: null };
  const factor = x.windowScalingFactor ?? 1;
  const dpi = x.xftDpi ?? 96;
  return {
    ok: factor === scale && dpi === 96,
    expected,
    windowScalingFactor: x.windowScalingFactor,
    xftDpi: x.xftDpi,
  };
}

export const monoNow = (): number => Number(process.hrtime.bigint()) / 1e6;

function statusOf(err: unknown): number {
  if (err instanceof NoPressError) return 504;
  if (err instanceof UnsupportedInputError) return 501;
  if (err instanceof RangeError) return 400;
  return 500;
}

export function createDesktopdApp(deps: DesktopdDeps): Hono {
  const app = new Hono();
  const clock = deps.clockMono ?? monoNow;

  app.use("*", async (c, next) => {
    if (!bearerMatches(deps.token, c.req.header("authorization"))) {
      return c.text("unauthorized", 401);
    }
    await next();
  });

  app.get("/healthz", async (c) => {
    const [xsettings, screen] = await Promise.all([deps.readXsettings(), deps.readScreen()]);
    const hidpi = hidpiReport(deps.scale, xsettings);
    const want = SCREEN[deps.scale];
    const ok = hidpi.ok && screen !== null && screen.w === want.w && screen.h === want.h;
    const health: DesktopdHealth = { ok, scale: deps.scale, display: deps.display, screen, hidpi };
    return c.json(health);
  });

  app.get("/clock", (c) => c.json({ mono: clock() }));

  const withX = (fn: (x: XHelper) => Promise<Response>) => async () => {
    if (!deps.x?.alive) return new Response("x helper not available", { status: 503 });
    try {
      return await fn(deps.x);
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: statusOf(err) });
    }
  };

  app.post("/input", async (c) =>
    withX(async (x) => {
      const parsed = InputRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      const result: InputResult = await inject(x, parsed.data, deps.injectors);
      return c.json(result);
    })(),
  );

  app.post("/type", async (c) =>
    withX(async (x) => {
      const parsed = TypeRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      c.header("content-type", "application/x-ndjson");
      // The request's signal aborts when the daemon closes the request (a Stop): typing ends there.
      const signal = c.req.raw.signal;
      return stream(c, async (out) => {
        try {
          const write = async (line: unknown) => {
            await out.write(`${JSON.stringify(line)}\n`);
          };
          const result: TypeResult = await typeText(x, parsed.data, write, deps.injectors, signal);
          await write(result);
        } catch (err) {
          await out.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err), status: statusOf(err) })}\n`);
        }
      });
    })(),
  );

  app.post("/settle", async (c) =>
    withX(async (x) => {
      const parsed = SettleRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      return c.json(await settle(x, parsed.data));
    })(),
  );

  app.post("/arm", async (c) => withX(async (x) => c.json(await x.call<{ mono: number }>("arm")))());

  app.post("/launch", async (c) =>
    withX(async (x) => {
      if (!deps.launch) return c.text("launch not available", 503);
      const parsed = LaunchRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      const { mono: armedMono } = await x.call<{ mono: number }>("arm");
      const result: LaunchResult = { ...deps.launch(parsed.data), armedMono };
      return c.json(result);
    })(),
  );

  return app;
}
```

`cells/desktop/desktopd/src/main.ts` — Part 2's file plus the helper: the whole file below keeps
Part 2's token check, `uid` and `readXsettings: () => readXsettings(uid)` (the reader that waits for
the session's own xfce4-session and xfconfd), and adds the helper's start and three dependencies:
```ts
import { userInfo } from "node:os";
import { serve } from "@hono/node-server";
import { createDesktopdApp, monoNow } from "./app.ts";
import { MIN_TOKEN_LENGTH } from "./auth.ts";
import { launchApp } from "./launch.ts";
import { startXHelper, type XHelper } from "./x/helper.ts";
import { readScreen, readXsettings } from "./xsettings.ts";

const token = process.env.LOCALDOT_DESKTOPD_TOKEN ?? "";
if (token.length < MIN_TOKEN_LENGTH) {
  console.error(
    `desktopd: LOCALDOT_DESKTOPD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
  );
  process.exit(1);
}
const scale = process.env.LOCALDOT_SCALE === "1" ? 1 : 2;
const port = Number(process.env.LOCALDOT_DESKTOPD_PORT ?? 7700);
// desktopd runs as the session's user, so its own uid is the session's.
const uid = userInfo().uid;
const XHELPER = process.env.LOCALDOT_XHELPER ?? "/opt/localdot/xhelper.py";

// The helper is restarted after a crash; routes answer 503 in between. One start at a time: the
// 2 s retry must not spawn a second helper while the first is still inside its 5 s ready wait.
let x: XHelper | undefined;
let starting: Promise<XHelper | undefined> | undefined;
function ensureHelper(): Promise<XHelper | undefined> {
  if (x?.alive) return Promise.resolve(x);
  if (starting) return starting;
  starting = (async () => {
    try {
      // /usr/bin/python3: the base image's PATH starts with a venv (/lsiopy) without python-xlib.
      x = await startXHelper({ command: "/usr/bin/python3", args: ["-u", XHELPER], env: process.env });
      console.log("desktopd: x helper ready");
    } catch (err) {
      console.error(`desktopd: x helper failed: ${err instanceof Error ? err.message : String(err)}`);
      x = undefined;
    } finally {
      starting = undefined;
    }
    return x;
  })();
  return starting;
}
await ensureHelper();
setInterval(() => void ensureHelper(), 2000).unref();

const app = createDesktopdApp({
  token,
  scale,
  display: process.env.DISPLAY ?? ":1",
  readXsettings: () => readXsettings(uid),
  readScreen,
  get x() {
    return x;
  },
  launch: (req) => launchApp(req, process.env),
  clockMono: monoNow,
});
// 0.0.0.0 inside the cell: only the gate's relay on the isolated internal network can reach it.
serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, () => {
  console.log(`desktopd on 0.0.0.0:${port} (scale ${scale})`);
});
```
(The `get x()` accessor keeps `deps.x` current after a helper restart.)

`cells/desktop/desktopd/package.json` — add the dependency `"@localdot/protocol": "workspace:*"`
(`zod` comes with it and is bundled). Run `pnpm install`.

Run: `pnpm exec vitest run cells/desktop/desktopd/src && pnpm --filter @localdot/desktopd build`
Expected: all desktopd tests pass: Part 2's 12 (`app.test.ts` 7, `xsettings.test.ts` 5, among them
"reports not ready, at either scale, while the session's xsettings are unknown" and "a failed read
is never ok at 1x") plus the new keys 3, input 13, launch 2 and app 5; the bundle grows to about
600 kB with zod.

- [ ] **Step 5: The HTTP part of the Docker test**

Rebuild the image (`cells/desktop/build.sh`; only the bundle layer changes), then append to
`apps/daemon/src/cells/desktopd.docker.test.ts` (its import from `./testing/desktop-container.ts`
gains `type DesktopContainer`; the rest is imported already):
```ts
describe.skipIf(!DOCKER_TESTS)("desktopd: input, type, settle, launch over HTTP", () => {
  const C2 = "localdot-test-desktopd-http";
  let cell: DesktopContainer;
  const post = async (path: string, body: unknown) =>
    fetch(`${cell.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(() => {
    cell = startDesktopContainer(C2, 2);
  });
  afterAll(() => removeAll({ containers: [C2] }));

  it("launches the terminal, clicks it, types a command and settles", async () => {
    const launched = await post("/launch", { app: "terminal" });
    expect(launched.status).toBe(200);
    waitFor("terminal", () => windowGeometry(C2, "xfce4-terminal") !== undefined, 30_000);
    sleepSync(1500);
    const g = windowGeometry(C2, "xfce4-terminal");
    if (!g) throw new Error("no terminal");
    const clock = (await (await fetch(`${cell.baseUrl}/clock`, { headers: { authorization: `Bearer ${cell.token}` } })).json()) as { mono: number };
    const click = await post("/input", { input: { kind: "click", button: "left", count: 1, at: { x: g.x + g.w / 2, y: g.y + g.h / 2 } }, window: g.id });
    expect(click.status).toBe(200);
    const result = (await click.json()) as { pressMono: number; presses: number[]; armedMono: number };
    expect(result.pressMono).toBeGreaterThan(clock.mono);
    expect(result.pressMono - clock.mono).toBeLessThan(500);
    expect(result.presses).toHaveLength(1);

    const typed = await post("/type", { text: "echo typed-ok > /tmp/http.txt", masked: false, pace: { firstMs: 10, firstCount: 60, restMs: 6 } });
    expect(typed.status).toBe(200);
    const lines = (await typed.text()).trim().split("\n").map((l) => JSON.parse(l) as { count?: number; done?: boolean; firstPressMono?: number });
    expect(lines.at(-1)).toMatchObject({ done: true, count: "echo typed-ok > /tmp/http.txt".length });
    expect((lines.at(-1)?.firstPressMono ?? 0) > result.pressMono).toBe(true);
    const enter = await post("/input", { input: { kind: "key", combo: ["Return"] } });
    expect(enter.status).toBe(200);
    const settled = (await (await post("/settle", {})).json()) as { changed: unknown[]; quiet: boolean; noVisibleChange: boolean };
    expect(settled.noVisibleChange).toBe(false);
    expect(settled.changed.length).toBeGreaterThan(0);
    waitFor("typed file", () => dockerExec(C2, "cat", "/tmp/http.txt").status === 0, 5000);
    const file = dockerExec(C2, "cat", "/tmp/http.txt");
    expect(file.status, file.out).toBe(0);
    expect(file.out.trim()).toBe("typed-ok");
  });

  it("refuses unknown apps and dangerous arguments, and reports no press as 504", async () => {
    expect((await post("/launch", { app: "bash" })).status).toBe(400);
    expect((await post("/launch", { app: "terminal", args: ["-e", "rm -rf /"] })).status).toBe(400);
    // Button 2 on the root window outside any client: the press still happens, so 200; a
    // bogus window id only makes activation time out (300 ms) and the click still lands.
    const odd = await post("/input", { input: { kind: "click", button: "middle", count: 1, at: { x: 5, y: 1590 } }, window: 1 });
    expect(odd.status).toBe(200);
  });
});
```

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktopd.docker.test.ts`
Expected: 8 tests pass.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages/protocol cells/desktop apps/daemon/src/cells pnpm-lock.yaml
git commit -m "feat(desktopd): input, type, settle, clock and launch routes with shared wire schemas"
```

---
### Task 5: Daemon side of desktopd — client, clock mapping, onset table and the raw routes

The daemon talks to `desktopd` through one typed client per cell, maps the cell's
`CLOCK_MONOTONIC` onto its own event clock with a lowest-RTT ping burst every 20 s (spec "Clock"),
and loads the ring-onset table. Two raw routes (`/api/cells/:id/input`, `/api/cells/:id/launch`)
and `GET /api/clock` exist for the calibration tool and for tests; the gateway (Task 9) uses the
same client and clock map.

**Files:**
- Create: `apps/daemon/src/desktopd/client.ts`, `apps/daemon/src/desktopd/clock-map.ts`,
  `apps/daemon/src/desktopd/registry.ts`, `apps/daemon/src/desktopd/testing/fake-desktopd.ts`,
  `apps/daemon/src/gateway/onset-table.ts`, `apps/daemon/src/gateway/routes.ts`
- Modify: `apps/daemon/src/event-log.ts`, `apps/daemon/src/app.ts`, `apps/daemon/src/main.ts`,
  `apps/daemon/package.json`
- Test: `apps/daemon/src/desktopd/client.test.ts`, `apps/daemon/src/desktopd/clock-map.test.ts`,
  `apps/daemon/src/desktopd/registry.test.ts`, `apps/daemon/src/gateway/onset-table.test.ts`,
  `apps/daemon/src/gateway/routes.test.ts`, `apps/daemon/src/event-log.test.ts`

**Interfaces:**
- Consumes: `@localdot/protocol` desktopd schemas (Task 4); Part 2's `CellApi`, `CellEndpoints`,
  `DesktopdEndpoint`, `EventLog`, `Clock`, `createApp`, `FakeOrchestrator`.
- Produces: `class DesktopdClient { constructor(endpoint: DesktopdEndpoint, fetchImpl?); clock(); input(req); type(req, onProgress, signal?); settle(req?); arm(); launch(req); observe(); hitTest(point); find(req) }`
  (`type` ends its request when `signal` aborts, which stops desktopd's typing),
  `DesktopdError { status; path }`;
  `class ClockMap { constructor(ping: () => Promise<number>, now: () => number); sync(samples?): Promise<ClockSample>; toDaemonMicros(mono: number): number; readonly sample; start(everyMs?); stop() }`
  (a failed periodic sync logs one line and keeps the last sample),
  `ClockSample { offsetMicros; rttMicros; at }`;
  `class DesktopdRegistry { constructor(cells: CellApi, clock: Clock, fetchImpl?); for(cellId): { client; clocks } | undefined; dispose() }`
  (a cell that leaves `ready` loses its client and its clock sync);
  `OnsetTable`, `DEFAULT_ONSET_TABLE`, `loadOnsetTable(home): OnsetTable`, `onsetKind(input): "click" | "key"`,
  `onsetMs(table, injector, kind, scale): number`, `CalibrationFile` (zod);
  `EventLog.toSessionT(sessionId, daemonMicros): number`, `EventLog.originOf(sessionId): number`;
  routes `GET /api/clock → { nowMicros }`, `POST /api/cells/:id/input` (body `InputRequest`, device
  px; reply `InputResult & { pressDaemonMicros; armedDaemonMicros }` — daemon-clock microseconds, not
  session time, hence the name), `POST /api/cells/:id/launch` (body `LaunchRequest`; reply
  `LaunchResult & { armedDaemonMicros }`); `AppOptions.gateway?: GatewayRoutesDeps { registry; clock }`;
  `FakeDesktopd { app: Hono; fetchImpl; mono(); calls; script }` for tests.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/desktopd/testing/fake-desktopd.ts` (a scripted desktopd on a Hono app; `fetchImpl`
routes requests to it without a socket):
```ts
import type { HitTestResult, InputResult, ObserveResult, SettleResult, TypeProgress, TypeResult } from "@localdot/protocol";
import { Hono } from "hono";

export interface FakeScript {
  input?: (body: unknown) => InputResult | { status: number; body: string };
  type?: (body: unknown) => { progress: TypeProgress[]; result: TypeResult } | { status: number; body: string };
  settle?: () => SettleResult;
  observe?: () => ObserveResult;
  hitTest?: (point: { x: number; y: number }) => HitTestResult;
  find?: (req: unknown) => HitTestResult;
  launch?: (body: unknown) => { pid: number };
  clockDelayMs?: number;
  // A long string still typing: /type sends its progress lines, then nothing until the request ends.
  typeHolds?: boolean;
}

export class FakeDesktopd {
  readonly app = new Hono();
  readonly calls: { path: string; body: unknown }[] = [];
  readonly token = "d".repeat(43);
  script: FakeScript;
  #mono = 50_000;
  // Where the fake's pointer is: the last /input point, as a real desktop's would be after a click.
  pointer = { x: 0, y: 0 };

  constructor(script: FakeScript = {}) {
    this.script = script;
    this.app.use("*", async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${this.token}`) return c.text("unauthorized", 401);
      await next();
    });
    this.app.get("/clock", async (c) => {
      if (this.script.clockDelayMs) await new Promise((r) => setTimeout(r, this.script.clockDelayMs));
      return c.json({ mono: this.mono() });
    });
    this.app.post("/input", async (c) => {
      const body = (await c.req.json()) as { input?: { kind?: string; at?: { x: number; y: number }; to?: { x: number; y: number } } };
      this.calls.push({ path: "/input", body });
      const at = body.input?.kind === "move" ? body.input.to : body.input?.at;
      if (at) this.pointer = { x: at.x, y: at.y };
      const armedMono = this.mono();
      const pressMono = this.mono();
      const out = this.script.input?.(body) ?? { pressMono, presses: [pressMono], injector: "xtest", armedMono };
      return "status" in out ? c.text(out.body, out.status as 500) : c.json(out);
    });
    this.app.post("/type", async (c) => {
      const body = await c.req.json();
      this.calls.push({ path: "/type", body });
      const out = this.script.type?.(body);
      if (out && "status" in out) return c.text(out.body, out.status as 500);
      const lines = out ? [...out.progress, out.result] : [{ done: true, count: 0, firstPressMono: null, injector: "xtest", armedMono: this.mono() }];
      const ndjson = (ls: unknown[]) => ls.map((l) => `${JSON.stringify(l)}\n`).join("");
      const headers = { "content-type": "application/x-ndjson" };
      if (!this.script.typeHolds) return new Response(ndjson(lines), { headers });
      const signal = c.req.raw.signal;
      const progress = new TextEncoder().encode(ndjson(out?.progress ?? []));
      const held = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(progress);
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(held, { headers });
    });
    this.app.post("/settle", (c) => {
      this.calls.push({ path: "/settle", body: null });
      return c.json(this.script.settle?.() ?? { changed: [], lastChangeMono: null, quiet: true, noVisibleChange: true });
    });
    this.app.post("/arm", (c) => c.json({ mono: this.mono() }));
    this.app.post("/launch", async (c) => {
      const body = await c.req.json();
      this.calls.push({ path: "/launch", body });
      return c.json({ ...(this.script.launch?.(body) ?? { pid: 1234 }), armedMono: this.mono() });
    });
    this.app.post("/observe", (c) => {
      this.calls.push({ path: "/observe", body: null });
      return c.json(this.script.observe?.() ?? { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", width: 1280, height: 800, image: Buffer.from("RIFF....WEBP").toString("base64"), pointer: this.pointer, windows: [] });
    });
    this.app.post("/hitTest", async (c) => {
      const body = (await c.req.json()) as { point: { x: number; y: number } };
      this.calls.push({ path: "/hitTest", body });
      return c.json(this.script.hitTest?.(body.point) ?? { target: null, window: null, ms: 1 });
    });
    this.app.post("/find", async (c) => {
      const body = await c.req.json();
      this.calls.push({ path: "/find", body });
      return c.json(this.script.find?.(body) ?? { target: null, window: null, ms: 1 });
    });
  }

  mono(): number {
    this.#mono += 1;
    return this.#mono;
  }

  get fetchImpl(): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => this.app.fetch(new Request(input, init))) as typeof fetch;
  }
}
```

`apps/daemon/src/desktopd/client.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DesktopdClient, DesktopdError } from "./client.ts";
import { FakeDesktopd } from "./testing/fake-desktopd.ts";

const client = (fake: FakeDesktopd) => new DesktopdClient({ baseUrl: "http://127.0.0.1:1", token: fake.token }, fake.fetchImpl);

describe("DesktopdClient", () => {
  it("reads the clock and injects input", async () => {
    const fake = new FakeDesktopd();
    const c = client(fake);
    expect((await c.clock()).mono).toBeGreaterThan(0);
    const res = await c.input({ input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } }, injector: "xtest", holdMs: 0 });
    expect(res.presses).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ path: "/input", body: { input: { kind: "click" } } });
  });

  it("streams typing progress lines and returns the final result", async () => {
    const fake = new FakeDesktopd({
      type: () => ({ progress: [{ count: 1, chunk: "h", pressMono: 10 }, { count: 2, chunk: "i", pressMono: 20 }], result: { done: true, count: 2, firstPressMono: 10, injector: "xtest", armedMono: 5 } }),
    });
    const seen: number[] = [];
    const res = await client(fake).type({ text: "hi", masked: false, pace: { firstMs: 0, firstCount: 60, restMs: 0 }, injector: "xtest" }, (p) => {
      seen.push(p.count);
    });
    expect(seen).toEqual([1, 2]);
    expect(res).toMatchObject({ done: true, count: 2, firstPressMono: 10 });
  });

  it("turns desktopd errors into DesktopdError with the status", async () => {
    const fake = new FakeDesktopd({ input: () => ({ status: 504, body: "no raw press observed" }) });
    const err = await client(fake).input({ input: { kind: "key", combo: ["a"] }, injector: "xtest", holdMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(DesktopdError);
    expect(err).toMatchObject({ status: 504, path: "/input" });
    const bad = new DesktopdClient({ baseUrl: "http://127.0.0.1:1", token: "wrong" }, fake.fetchImpl);
    await expect(bad.clock()).rejects.toMatchObject({ status: 401 });
  });
});
```

`apps/daemon/src/desktopd/clock-map.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ClockMap } from "./clock-map.ts";

describe("ClockMap", () => {
  it("takes the lowest-RTT sample and maps the cell's monotonic ms onto daemon microseconds", async () => {
    // The daemon clock runs in µs; the cell's clock reads 1 000 000 ms ahead of it and one ping is slow.
    let now = 10_000_000;
    const rtts = [900, 2500, 600, 1800, 700];
    let i = 0;
    const map = new ClockMap(
      async () => {
        const rtt = rtts[i++ % rtts.length] as number;
        now += rtt;
        return (now - rtt / 2) / 1000 + 1_000_000;
      },
      () => now,
    );
    const sample = await map.sync(5);
    expect(sample.rttMicros).toBe(600);
    expect(Math.abs(sample.offsetMicros - 1_000_000_000)).toBeLessThan(1);
    expect(Math.abs(map.toDaemonMicros(1_000_000 + 12.5) - 12_500)).toBeLessThan(1);
  });

  it("refuses to map before a sync", () => {
    const map = new ClockMap(async () => 0, () => 0);
    expect(() => map.toDaemonMicros(1)).toThrow(/not synced/);
  });
});
```

`apps/daemon/src/desktopd/registry.test.ts`:
```ts
import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { monotonicClock } from "../clock.ts";
import { DesktopdRegistry } from "./registry.ts";
import { FakeDesktopd } from "./testing/fake-desktopd.ts";

describe("DesktopdRegistry", () => {
  it("keeps one client per cell while it is ready and drops it, clock sync included, when it leaves", () => {
    const cells = new FakeOrchestrator();
    const fake = new FakeDesktopd();
    const registry = new DesktopdRegistry(cells, monotonicClock(), fake.fetchImpl);
    const cell: CellSummary = { id: ulid(), state: "ready", scale: 2, createdAt: "", stream: NO_STREAM };
    cells.emit(cell);
    cells.endpointsById.set(cell.id, { desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token }, stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" } });
    const first = registry.for(cell.id);
    expect(first).toBeDefined();
    expect(registry.for(cell.id)).toBe(first);
    const stop = vi.spyOn(first?.clocks as NonNullable<typeof first>["clocks"], "stop");
    cells.emit({ ...cell, state: "stopped" });
    expect(stop).toHaveBeenCalled();
    expect(registry.for(cell.id)).not.toBe(first);
    registry.dispose();
  });
});
```

`apps/daemon/src/gateway/onset-table.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ONSET_TABLE, loadOnsetTable, onsetKind, onsetMs } from "./onset-table.ts";

describe("onset table", () => {
  it("defaults to the development Mac's first numbers when no calibration exists", () => {
    const table = loadOnsetTable(mkdtempSync(join(tmpdir(), "local dot's onset-")));
    expect(table.source).toBe("defaults");
    expect(onsetMs(table, "xtest", "click", 1)).toBe(19.6);
    expect(onsetMs(table, "xtest", "click", 2)).toBe(23.1);
    expect(onsetMs(table, "xtest", "key", 1)).toBe(19.1);
    expect(onsetMs(table, "xtest", "key", 2)).toBe(29.3);
    expect(onsetMs(table, "driver", "click", 2)).toBe(26.4);
    expect(onsetMs(table, "driver", "key", 2)).toBe(26.4);
    expect(DEFAULT_ONSET_TABLE.onsetMs.driver).toEqual({ click: { "1": 18.4, "2": 26.4 } });
  });

  it("loads a calibration file, keeping defaults for groups it lacks", () => {
    const home = mkdtempSync(join(tmpdir(), "local dot's onset-"));
    writeFileSync(join(home, "calibration.json"), JSON.stringify({ v: 1, measuredAt: "2026-10-02T10:00:00.000Z", machine: "M3 Ultra", onsetMs: { xtest: { click: { "2": 24.4 } } } }));
    const table = loadOnsetTable(home);
    expect(table.source).toBe("calibration");
    expect(onsetMs(table, "xtest", "click", 2)).toBe(24.4);
    expect(onsetMs(table, "xtest", "click", 1)).toBe(19.6);
  });

  it("ignores an unreadable calibration file", () => {
    const home = mkdtempSync(join(tmpdir(), "local dot's onset-"));
    writeFileSync(join(home, "calibration.json"), "{nope");
    expect(loadOnsetTable(home).source).toBe("defaults");
  });

  it("classifies inputs: keys and typing are keys, everything else a click", () => {
    expect(onsetKind({ kind: "type", chars: 3, masked: false })).toBe("key");
    expect(onsetKind({ kind: "key", combo: ["a"] })).toBe("key");
    expect(onsetKind({ kind: "click", button: "left", count: 1, at: { x: 0, y: 0 } })).toBe("click");
    expect(onsetKind({ kind: "scroll", at: { x: 0, y: 0 }, dx: 0, dy: 1 })).toBe("click");
  });
});
```

`apps/daemon/src/gateway/routes.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { TicketRegistry } from "../cells/secrets.ts";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { monotonicClock } from "../clock.ts";
import { DesktopdRegistry } from "../desktopd/registry.ts";
import { FakeDesktopd } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const bearer = { authorization: `Bearer ${TOKEN}` };
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

function setup() {
  const cells = new FakeOrchestrator();
  const fake = new FakeDesktopd();
  const clock = monotonicClock();
  const registry = new DesktopdRegistry(cells, clock, fake.fetchImpl);
  const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's routes-")), clock);
  const app = createApp({ token: TOKEN, port: PORT, eventLog, cells: { cells, tickets: new TicketRegistry() }, gateway: { registry, clock } });
  const id = ulid();
  cells.emit({ id, state: "ready", scale: 2, createdAt: new Date().toISOString(), stream: NO_STREAM });
  cells.endpointsById.set(id, { desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token }, stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" } });
  return { app, cells, fake, id, registry };
}

describe("raw desktopd routes", () => {
  it("serves the daemon clock in microseconds", async () => {
    const { app } = setup();
    const a = (await (await app.request(url("/api/clock"), { headers: bearer })).json()) as { nowMicros: number };
    const b = (await (await app.request(url("/api/clock"), { headers: bearer })).json()) as { nowMicros: number };
    expect(b.nowMicros).toBeGreaterThanOrEqual(a.nowMicros);
    expect((await app.request(url("/api/clock"))).status).toBe(401);
  });

  it("injects input through the cell's desktopd and maps the press onto the daemon clock", async () => {
    const { app, id, fake } = setup();
    const res = await app.request(url(`/api/cells/${id}/input`), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ input: { kind: "click", button: "left", count: 1, at: { x: 100, y: 200 } } }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pressDaemonMicros: number; pressMono: number; armedDaemonMicros: number };
    expect(body.pressDaemonMicros).toBeGreaterThan(0);
    expect(body.armedDaemonMicros).toBeLessThan(body.pressDaemonMicros);
    expect(fake.calls.at(-1)).toMatchObject({ path: "/input", body: { input: { at: { x: 100, y: 200 } } } });
  });

  it("launches an app and refuses cells that are not ready or unknown", async () => {
    const { app, id, cells } = setup();
    const launched = await app.request(url(`/api/cells/${id}/launch`), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ app: "terminal" }) });
    expect(launched.status).toBe(200);
    expect(await launched.json()).toMatchObject({ pid: 1234, armedDaemonMicros: expect.any(Number) });
    cells.emit({ ...(cells.get(id) as CellSummary), state: "stopped" });
    expect((await app.request(url(`/api/cells/${id}/launch`), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ app: "terminal" }) })).status).toBe(409);
    expect((await app.request(url("/api/cells/01JXYZ0000000000000000ABCD/launch"), { method: "POST", headers: bearer })).status).toBe(404);
  });
});
```

Append to `apps/daemon/src/event-log.test.ts` inside `describe("EventLog")`:
```ts
  it("maps daemon microseconds onto a session's time base", () => {
    const clock = fakeClock(5_000_000);
    const log = new EventLog(home(), clock);
    const id = log.createSession("t");
    expect(log.originOf(id)).toBe(5_000_000);
    expect(log.toSessionT(id, 5_250_000)).toBe(250_000);
    expect(log.toSessionT(id, 4_000_000)).toBe(0);
    expect(() => log.toSessionT("01JXYZ0000000000000000ABCD", 1)).toThrow(UnknownSessionError);
  });
```

Run: `pnpm exec vitest run apps/daemon/src/desktopd apps/daemon/src/gateway apps/daemon/src/event-log.test.ts`
Expected: FAIL — the new modules do not exist; `log.originOf is not a function`.

- [ ] **Step 2: Implement**

`apps/daemon/src/desktopd/client.ts`:
```ts
import {
  ClockResult,
  type FindRequest,
  HitTestResult,
  type InputRequest,
  InputResult,
  type LaunchRequest,
  LaunchResult,
  ObserveResult,
  type Point,
  type SettleRequest,
  SettleResult,
  TypeProgress,
  type TypeRequest,
  TypeResult,
} from "@localdot/protocol";
import type { DesktopdEndpoint } from "../cells/types.ts";

export class DesktopdError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(`desktopd ${status || "unreachable"} on ${path}: ${message}`);
    this.name = "DesktopdError";
  }
}

const TIMEOUT_MS = { clock: 2000, input: 5000, settle: 35_000, launch: 5000, observe: 10_000, hitTest: 5000 } as const;

export class DesktopdClient {
  constructor(
    readonly endpoint: DesktopdEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  clock(): Promise<ClockResult> {
    return this.#json("GET", "/clock", undefined, TIMEOUT_MS.clock, ClockResult.parse);
  }

  input(req: InputRequest): Promise<InputResult> {
    return this.#json("POST", "/input", req, TIMEOUT_MS.input, InputResult.parse);
  }

  settle(req: Partial<SettleRequest> = {}): Promise<SettleResult> {
    return this.#json("POST", "/settle", req, TIMEOUT_MS.settle, SettleResult.parse);
  }

  arm(): Promise<{ mono: number }> {
    return this.#json("POST", "/arm", {}, TIMEOUT_MS.clock, (v) => v as { mono: number });
  }

  launch(req: LaunchRequest): Promise<LaunchResult> {
    return this.#json("POST", "/launch", req, TIMEOUT_MS.launch, LaunchResult.parse);
  }

  observe(): Promise<ObserveResult> {
    return this.#json("POST", "/observe", {}, TIMEOUT_MS.observe, ObserveResult.parse);
  }

  hitTest(point: Point): Promise<HitTestResult> {
    return this.#json("POST", "/hitTest", { point }, TIMEOUT_MS.hitTest, HitTestResult.parse);
  }

  find(req: FindRequest): Promise<HitTestResult> {
    return this.#json("POST", "/find", req, TIMEOUT_MS.hitTest, HitTestResult.parse);
  }

  // NDJSON: one TypeProgress per line, then the TypeResult; an {error, status} line fails the call.
  // Aborting `signal` (a Stop) closes the request, and desktopd stops typing at the next key.
  async type(req: TypeRequest, onProgress: (p: TypeProgress) => void | Promise<void>, signal?: AbortSignal): Promise<TypeResult> {
    const res = await this.#send("POST", "/type", req, 60_000 + req.text.length * 50, signal);
    if (!res.ok || !res.body) throw new DesktopdError(res.status, await res.text(), "/type");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let result: TypeResult | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let nl = buffered.indexOf("\n");
      while (nl >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf("\n");
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if ("error" in msg) throw new DesktopdError(Number(msg.status) || 500, String(msg.error), "/type");
        if (msg.done === true) result = TypeResult.parse(msg);
        else await onProgress(TypeProgress.parse(msg));
      }
      if (done) break;
    }
    if (!result) throw new DesktopdError(502, "typing ended without a result line", "/type");
    return result;
  }

  async #send(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.endpoint.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      throw new DesktopdError(0, err instanceof Error ? err.message : String(err), path);
    }
  }

  async #json<T>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, parse: (v: unknown) => T): Promise<T> {
    const res = await this.#send(method, path, body, timeoutMs);
    const text = await res.text();
    if (!res.ok) throw new DesktopdError(res.status, text || res.statusText, path);
    return parse(JSON.parse(text));
  }
}
```

`apps/daemon/src/desktopd/clock-map.ts`:
```ts
import { msToMicros } from "@localdot/protocol";

export interface ClockSample {
  offsetMicros: number;
  rttMicros: number;
  at: number;
}

// desktopd's CLOCK_MONOTONIC (ms) against the daemon's event clock (µs): the lowest-RTT ping of a
// burst gives the offset within about half its RTT; S6 saw the two drift up to 1 ms in 20–45 s, so
// the burst repeats every 20 s (spec "Clock").
export class ClockMap {
  #sample: ClockSample | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ping: () => Promise<number>,
    private readonly now: () => number,
  ) {}

  get sample(): ClockSample | undefined {
    return this.#sample;
  }

  async sync(samples = 10): Promise<ClockSample> {
    let best: ClockSample | undefined;
    for (let i = 0; i < samples; i++) {
      const sent = this.now();
      const mono = await this.ping();
      const got = this.now();
      const rttMicros = got - sent;
      const candidate = { offsetMicros: msToMicros(mono) - (sent + got) / 2, rttMicros, at: got };
      if (!best || candidate.rttMicros < best.rttMicros) best = candidate;
    }
    this.#sample = best as ClockSample;
    return this.#sample;
  }

  toDaemonMicros(mono: number): number {
    if (!this.#sample) throw new Error("clock map not synced");
    return Math.round(msToMicros(mono) - this.#sample.offsetMicros);
  }

  // A failed burst keeps the last sample (the clocks drift about 1 ms in 20–45 s) and says so.
  start(everyMs = 20_000): void {
    this.stop();
    this.#timer = setInterval(() => {
      this.sync().catch((err) => {
        console.error(`desktopd clock sync failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
```

`apps/daemon/src/desktopd/registry.ts`:
```ts
import type { CellApi } from "../cells/orchestrator.ts";
import type { Clock } from "../clock.ts";
import { DesktopdClient } from "./client.ts";
import { ClockMap } from "./clock-map.ts";

export interface CellDesktopd {
  client: DesktopdClient;
  clocks: ClockMap;
}

// One client and clock map per cell, rebuilt whenever the published port changes (every start)
// and dropped when the cell leaves ready, so a stopped or removed cell keeps no sync timer.
export class DesktopdRegistry {
  readonly #byUrl = new Map<string, CellDesktopd>();
  readonly #unsubscribe: () => void;

  constructor(
    private readonly cells: CellApi,
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.#unsubscribe = cells.subscribe((cell) => {
      if (cell.state !== "ready") this.#forget(cell.id);
    });
  }

  for(cellId: string): CellDesktopd | undefined {
    const endpoint = this.cells.endpoints(cellId)?.desktopd;
    if (!endpoint) return undefined;
    const key = `${cellId} ${endpoint.baseUrl}`;
    let entry = this.#byUrl.get(key);
    if (!entry) {
      this.#forget(cellId);
      const client = new DesktopdClient(endpoint, this.fetchImpl);
      const clocks = new ClockMap(async () => (await client.clock()).mono, () => this.clock.nowMicros());
      clocks.start();
      entry = { client, clocks };
      this.#byUrl.set(key, entry);
    }
    return entry;
  }

  dispose(): void {
    this.#unsubscribe();
    for (const entry of this.#byUrl.values()) entry.clocks.stop();
    this.#byUrl.clear();
  }

  #forget(cellId: string): void {
    for (const [k, old] of this.#byUrl) {
      if (k.startsWith(`${cellId} `)) {
        old.clocks.stop();
        this.#byUrl.delete(k);
      }
    }
  }
}
```

`apps/daemon/src/gateway/onset-table.ts`:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Injector, Input } from "@localdot/protocol";
import { z } from "zod";

export type OnsetKind = "click" | "key";
type ScaleKey = "1" | "2";
type Scales = Record<ScaleKey, number>;

// The driver fallback has no key row (P3-C9): typed text through it is timed from the raw press
// like a click, and key combos never travel that path.
export interface OnsetTable {
  v: 1;
  source: "defaults" | "calibration";
  measuredAt?: string;
  onsetMs: { xtest: Record<OnsetKind, Scales>; driver: { click: Scales } };
}

// S6 on the development Mac (M3 Ultra), 50–120 trials per group, so each p99 is a sample maximum
// (D8). The calibration tool (Task 6) replaces them with ≥ 500-trial p99s per machine.
export const DEFAULT_ONSET_TABLE: OnsetTable = {
  v: 1,
  source: "defaults",
  onsetMs: {
    xtest: { click: { "1": 19.6, "2": 23.1 }, key: { "1": 19.1, "2": 29.3 } },
    driver: { click: { "1": 18.4, "2": 26.4 } },
  },
};

const GROUPS: readonly [Injector, OnsetKind][] = [["xtest", "click"], ["xtest", "key"], ["driver", "click"]];

const Group = z.object({ "1": z.number().positive().optional(), "2": z.number().positive().optional() });
export const CalibrationFile = z.object({
  v: z.literal(1),
  measuredAt: z.string(),
  machine: z.string().optional(),
  trials: z.number().int().optional(),
  onsetMs: z.object({
    xtest: z.object({ click: Group.optional(), key: Group.optional() }).optional(),
    driver: z.object({ click: Group.optional() }).optional(),
  }),
});
export type CalibrationFile = z.infer<typeof CalibrationFile>;

function row(table: OnsetTable["onsetMs"], injector: Injector, kind: OnsetKind): Scales | undefined {
  return injector === "xtest" ? table.xtest[kind] : kind === "click" ? table.driver.click : undefined;
}

export function loadOnsetTable(home: string): OnsetTable {
  const file = join(home, "calibration.json");
  let parsed: CalibrationFile;
  try {
    parsed = CalibrationFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`ignoring ${file}: ${String(err)}`);
    else console.error(`no ${file}: using the development Mac's ring onsets; run pnpm --filter @localdot/web calibrate --compositor on`);
    return DEFAULT_ONSET_TABLE;
  }
  const onsetMs = structuredClone(DEFAULT_ONSET_TABLE.onsetMs);
  for (const [injector, kind] of GROUPS) {
    const measured = injector === "xtest" ? parsed.onsetMs.xtest?.[kind] : parsed.onsetMs.driver?.click;
    const target = row(onsetMs, injector, kind) as Scales;
    for (const scale of ["1", "2"] as const) {
      const v = measured?.[scale];
      if (v !== undefined) target[scale] = v;
    }
  }
  return { v: 1, source: "calibration", measuredAt: parsed.measuredAt, onsetMs };
}

export function onsetKind(input: Input): OnsetKind {
  return input.kind === "type" || input.kind === "key" ? "key" : "click";
}

export function onsetMs(table: OnsetTable, injector: Injector, kind: OnsetKind, scale: 1 | 2): number {
  // Driver-typed text is timed from its first raw press with the click row (the same XTest-like
  // delivery); driver key combos do not exist (P3-C9).
  const r = row(table.onsetMs, injector, injector === "driver" ? "click" : kind);
  if (!r) throw new Error(`no ring onset row for ${injector} ${kind}`);
  return r[String(scale) as ScaleKey];
}
```

`apps/daemon/src/gateway/routes.ts` (Task 10 extends it with the puppet, live and frame routes):
```ts
import { InputRequest, LaunchRequest, ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { CellApi } from "../cells/orchestrator.ts";
import type { Clock } from "../clock.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";

export interface GatewayRoutesDeps {
  registry: DesktopdRegistry;
  clock: Clock;
}

export function gatewayRoutes(app: Hono, cells: CellApi, deps: GatewayRoutesDeps): void {
  app.get("/api/clock", (c) => c.json({ nowMicros: deps.clock.nowMicros() }));

  app.post("/api/cells/:id/input", (c) =>
    withReadyCell(c, cells, deps, async (d) => {
      const parsed = InputRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      if (!d.clocks.sample) await d.clocks.sync();
      const result = await d.client.input(parsed.data);
      // Daemon-clock microseconds (the calibration tool maps the viewer's clock onto the same
      // base); action.dispatch.pressT is session time, which only the gateway produces.
      return c.json({ ...result, pressDaemonMicros: d.clocks.toDaemonMicros(result.pressMono), armedDaemonMicros: d.clocks.toDaemonMicros(result.armedMono) });
    }),
  );

  app.post("/api/cells/:id/launch", (c) =>
    withReadyCell(c, cells, deps, async (d) => {
      const parsed = LaunchRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      if (!d.clocks.sample) await d.clocks.sync();
      const result = await d.client.launch(parsed.data);
      return c.json({ ...result, armedDaemonMicros: d.clocks.toDaemonMicros(result.armedMono) });
    }),
  );
}

export async function withReadyCell(
  c: Context,
  cells: CellApi,
  deps: GatewayRoutesDeps,
  fn: (d: NonNullable<ReturnType<DesktopdRegistry["for"]>>) => Promise<Response>,
): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
  const cell = cells.get(id);
  if (!cell) return c.text("unknown cell", 404);
  if (cell.state !== "ready") return c.text(`cell is ${cell.state}`, 409);
  const d = deps.registry.for(id);
  if (!d) return c.text("cell has no desktopd endpoint", 503);
  try {
    return await fn(d);
  } catch (err) {
    // desktopd unreachable, or refusing the daemon's own token: a bad gateway, not the caller's fault.
    if (err instanceof DesktopdError) return c.text(err.message, (err.status === 0 || err.status === 401 ? 502 : err.status) as ContentfulStatusCode);
    throw err;
  }
}
```

`apps/daemon/src/event-log.ts` — add two methods after `read`:
```ts
  originOf(sessionId: string): number {
    return this.#stateOf(sessionId).origin;
  }

  // Daemon microseconds → this session's time base (the envelope's t), never negative.
  toSessionT(sessionId: string, daemonMicros: number): number {
    return Math.max(0, Math.round(daemonMicros - this.originOf(sessionId)));
  }
```
(`#stateOf` throws `UnknownSessionError` for an unknown id, through `#existingFileOf`.)

`apps/daemon/src/app.ts` — add the option and the routes (after `cellRoutes`, inside the `/api/*`
token middleware):
```ts
import { type GatewayRoutesDeps, gatewayRoutes } from "./gateway/routes.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
  desktop?: StreamProxyDeps;
  ui?: { dir: string };
  gateway?: GatewayRoutesDeps;
}
// inside createApp, right after `if (cells) cellRoutes(app, cells);`:
  if (cells && gateway) gatewayRoutes(app, cells.cells, gateway);
```

`apps/daemon/src/main.ts` — share one clock and wire the registry (keep everything else):
```ts
import { monotonicClock } from "./clock.ts";
import { DesktopdRegistry } from "./desktopd/registry.ts";
// ...
const clock = monotonicClock();
const eventLog = new EventLog(home, clock);
// ... after the orchestrator is built:
const registry = new DesktopdRegistry(orchestrator, clock);
const app = createApp({ token, port, eventLog, cells: { cells: orchestrator, tickets }, desktop, ui: { dir: webDir("dist") }, gateway: { registry, clock } });
```

`apps/daemon/package.json` — add `"@localdot/stage": "workspace:*"` and `"@localdot/providers": "workspace:*"`
(Task 9 uses them; adding them here keeps one `pnpm install`) and `"zod": "4.6.5"` to
`dependencies`, then `pnpm install`. `onset-table.ts` here and Task 10's `puppet/script.ts` import
`zod` directly, and pnpm's isolated `node_modules` gives `apps/daemon` only its own dependencies.

Run: `pnpm exec vitest run apps/daemon/src`
Expected: every daemon suite passes (Part 1 and Part 2 suites plus client, clock-map, registry,
onset-table, routes and the new event-log case).

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): desktopd client, clock mapping, onset table and raw input routes"
```

---
### Task 6: Calibration — ≥ 500 trials per injector and scale on this machine

S6 measured raw press → frame with xdotool standing in for `desktopd`'s own client and 50–120
trials per group, so each p99 is a sample maximum. This task measures `desktopd`'s real client
(Tasks 3–4) with at least 500 trials per group, through the real path (daemon → desktopd → cell →
Selkies → daemon proxy → the stage's frame tap), writes the p99 table the gateway loads
(`<home>/calibration.json`), and checks the client reproduces S6's numbers before Task 9 relies on
them. The frame side reuses S6's method: a luma probe on a 32×32 patch of every decoded frame and a
flash page in the cell that flips on `mousedown`/`keydown`. The viewer's clock is mapped to the
daemon's the same way desktopd's is (lowest-RTT pings of `GET /api/clock`).

Each scale runs twice (P3-C15). The **gate** pass validates the harness under S6's conditions:
xfwm4's compositor switched off in the cell for the run and the flash page in a kiosk window, with
each group held to S6's numbers. The **table** pass measures what users see: the compositor on
with Task 1's vsync mode, and the flash page in a maximized window through `localdot-chromium`
(a kiosk window is unredirected and would bypass the compositor). Only a table pass on the
press-acting page writes `<home>/calibration.json`; the gate and the release-acting control are
recorded in `apps/web/e2e/out/` only.

**Files:**
- Create: `cells/desktop/root/opt/localdot/flash.html`, `apps/web/src/stage/probe.ts`,
  `apps/web/src/session/clock-sync.ts`, `apps/web/e2e/calibrate.ts`, `apps/web/e2e/cells.ts`,
  `docs/measurements/2026-10-ring-onset.md`
- Modify: `apps/web/src/stage/render-worker.ts`, `apps/web/src/stage/StageCanvas.tsx`,
  `apps/web/src/stage/Stage.tsx`, `apps/web/package.json`
- Test: `apps/web/src/stage/probe.test.ts`, `apps/web/src/session/clock-sync.test.ts`

**Interfaces:**
- Consumes: Part 2's stage as Part 2's Task 14 builds it: the worker protocol (`WorkerIn`/`WorkerOut`,
  whose `frames` message carries S8's seed frame `first`), `StageCanvasHandle` (its `attach`
  transfers the readable and `first`), `pumpFrames(readable, presenter, report, { first })`, and
  `Stage`'s ticket, remount and storage cleanup, all kept as built; the raw routes and
  `GET /api/clock` (Task 5); `startDaemon` and `desktopContainer(cellId)` (Part 2's
  `apps/web/e2e/daemon.ts`); Task 1's vsync mode.
- Produces: `meanLuma(frame: VideoFrame, rect): Promise<number>`; worker messages
  `{ type: "probe"; rect: Rect | null; threshold: number }` and `{ type: "flip"; at; luma; bright; presented }`;
  `window.__localdot.probe = { start(rect, threshold?), stop(), flips(), clear() }` when the page URL
  has `?probe=1`; `syncClock(fetchImpl, origin, token, samples?): Promise<{ offsetMicros; rttMicros }>`
  (viewer wall ms → daemon µs: `daemonMicros = msToMicros(wallMs) + offsetMicros`), `SessionClock { offsetMicros; originMicros }`,
  `sessionMsAt(wallMs, clock): number` (session ms of a viewer instant; the worker's and the oracle's one conversion);
  `apps/web/e2e/cells.ts`: `createReadyCell(daemon, scale)`, `launchApp(daemon, cellId, app, args)`;
  CLI `pnpm --filter @localdot/web calibrate --compositor off|on --scale 1|2 [--trials 500] [--injectors xtest,driver] [--kinds click,key] [--page down|up] [--out <file>]`
  (no `--` before the options: pnpm 10 forwards it, and the script stops with its usage line on a
  `--`-shifted, unknown or unpaired option); `--compositor off` is the gate and writes no table,
  `--compositor on --page down` writes `onsetMs` into `--out` (default `<home>/calibration.json`);
  `<home>/calibration.json` in the `CalibrationFile` shape (Task 5).

- [ ] **Step 1: The flash page and the luma probe, test first**

`cells/desktop/root/opt/localdot/flash.html` (S6's page: black/white toggles on `mousedown` or
`keydown`; `#up` toggles on `mouseup` for the release-acting measurement; the page takes keyboard
focus from a click, and the calibration and the oracle click it before any key):
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>flash</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}body.on{background:#fff}</style>
</head>
<body>
<script>
  const up = location.hash === "#up";
  if (up) document.title = "flash up";
  const flip = () => document.body.classList.toggle("on");
  addEventListener(up ? "mouseup" : "mousedown", flip);
  addEventListener("keydown", (e) => { if (!e.repeat) flip(); });
  addEventListener("contextmenu", (e) => e.preventDefault());
</script>
</body>
</html>
```
(The image's `COPY root/ /` already installs it; rebuild once with `cells/desktop/build.sh`.)

`apps/web/src/stage/probe.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { meanLuma } from "./probe.ts";

// A VideoFrame stand-in: I444 with a Y plane whose stride is wider than the rect.
function fakeFrame(width: number, height: number, fill: (x: number, y: number) => number) {
  const stride = width + 16;
  const plane = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) plane[y * stride + x] = fill(x, y);
  return {
    format: "I444",
    codedWidth: width,
    codedHeight: height,
    allocationSize: (opts: { rect: { x: number; y: number; width: number; height: number } }) => opts.rect.width * opts.rect.height * 3,
    copyTo: async (buf: Uint8Array, opts: { rect: { x: number; y: number; width: number; height: number } }) => {
      const r = opts.rect;
      for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) buf[y * r.width + x] = plane[(r.y + y) * stride + r.x + x] as number;
      return [{ offset: 0, stride: r.width }];
    },
  } as unknown as VideoFrame;
}

describe("meanLuma", () => {
  it("averages the luma plane over the rect", async () => {
    const frame = fakeFrame(64, 64, (x) => (x < 32 ? 0 : 200));
    expect(await meanLuma(frame, { x: 0, y: 0, width: 32, height: 32 })).toBe(0);
    expect(await meanLuma(frame, { x: 32, y: 0, width: 32, height: 32 })).toBe(200);
    expect(await meanLuma(frame, { x: 16, y: 0, width: 32, height: 32 })).toBe(100);
  });
});
```

`apps/web/src/stage/probe.ts`:
```ts
export interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Flip {
  at: number;
  luma: number;
  bright: boolean;
  presented: number;
}

let scratch = new Uint8Array(0);

// Mean of the luma plane over `rect` (plane 0 of I444/I420). S6's detector did the same.
export async function meanLuma(frame: VideoFrame, rect: ProbeRect): Promise<number> {
  const size = frame.allocationSize({ rect });
  if (scratch.byteLength < size) scratch = new Uint8Array(size);
  const [luma] = await frame.copyTo(scratch, { rect });
  if (!luma) return 0;
  let sum = 0;
  for (let row = 0; row < rect.height; row++) {
    const o = luma.offset + row * luma.stride;
    for (let col = 0; col < rect.width; col++) sum += scratch[o + col] as number;
  }
  return sum / (rect.width * rect.height);
}

export const wallNow = (): number => performance.timeOrigin + performance.now();
```

Run: `pnpm exec vitest run apps/web/src/stage/probe.test.ts`
Expected: 1 test passes.

- [ ] **Step 2: The probe in the worker and on the page**

`apps/web/package.json` — dependencies: add `"@localdot/protocol": "workspace:*"` (the time helper
`clock-sync.ts` and the calibration script convert through; a workspace link, no download), then
`pnpm install`.

`apps/web/src/stage/render-worker.ts` — Part 2's worker plus the probe (the presenter and pump stay
Part 2's for now; Task 14a replaces the presenter). Part 2's Task 14 built the worker with S8's seed:
its `frames` message carries the `<video>`'s current frame as `first`, which goes to `pumpFrames`
with `{ first: m.first }`, so the stage is not black after a connect on a still screen. The whole
file after this step keeps that and adds the probe:
```ts
import { canvasPresenter } from "./presenter.ts";
import { type Flip, meanLuma, type ProbeRect, wallNow } from "./probe.ts";
import { type Presenter, type PumpStats, pumpFrames } from "./pump.ts";

export type WorkerIn =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "frames"; readable: ReadableStream<VideoFrame>; first?: VideoFrame }
  | { type: "stop" }
  | { type: "probe"; rect: ProbeRect | null; threshold: number };

export type WorkerOut =
  | { type: "stats"; stats: PumpStats }
  | { type: "error"; message: string }
  | { type: "flip"; flip: Flip };

const scope = self as unknown as {
  postMessage(message: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let presenter: Presenter | undefined;
let pump: { stop(): Promise<void> } | undefined;
let probe: { rect: ProbeRect; threshold: number; last: boolean | null } | null = null;
let presented = 0;

// Wraps the presenter so every decoded frame, the seed included, is also sampled by the luma probe
// when one is set.
function probing(inner: Presenter): Presenter {
  return {
    present(frame) {
      presented += 1;
      const at = wallNow();
      const p = probe;
      if (p) {
        // copyTo is async; the frame is closed by the pump after present() returns, so clone it.
        const copy = frame.clone();
        void meanLuma(copy, p.rect)
          .then((luma) => {
            const bright = luma > p.threshold;
            if (p.last !== null && bright !== p.last) scope.postMessage({ type: "flip", flip: { at, luma, bright, presented } });
            p.last = bright;
          })
          .finally(() => copy.close());
      }
      inner.present(frame);
    },
  };
}

scope.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      presenter = probing(canvasPresenter(m.canvas));
      return;
    }
    if (m.type === "probe") {
      probe = m.rect ? { rect: m.rect, threshold: m.threshold, last: null } : null;
      return;
    }
    if (m.type === "stop" || m.type === "frames") {
      await pump?.stop();
      pump = undefined;
    }
    if (m.type === "frames") {
      if (!presenter) {
        m.first?.close();
        throw new Error("frames before init");
      }
      pump = pumpFrames(m.readable, presenter, (stats) => scope.postMessage({ type: "stats", stats }), { first: m.first });
    }
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
```

`apps/web/src/stage/StageCanvas.tsx` — the handle gains `probe(rect, threshold)` and the component an
`onFlip` prop:
```tsx
export interface StageCanvasHandle {
  attach(source: FrameSource): void;
  detach(): void;
  probe(rect: ProbeRect | null, threshold?: number): void;
}

export const StageCanvas = forwardRef<StageCanvasHandle, { onStats?(stats: PumpStats): void; onFlip?(flip: Flip): void }>(function StageCanvas({ onStats, onFlip }, ref) {
  // ... Part 2's refs; add:
  const onFlipRef = useRef(onFlip);
  onFlipRef.current = onFlip;
  // in worker.onmessage:
  //   if (e.data.type === "flip") { onFlipRef.current?.(e.data.flip); return; }
  // in useImperativeHandle, add:
  //   probe(rect, threshold = 128) { workerRef.current?.postMessage({ type: "probe", rect, threshold } satisfies WorkerIn); },
```
(import `Flip`, `ProbeRect` from `./probe.ts`. Part 2's `attach` and `detach` stay as built: `attach`
transfers the readable and S8's seed frame together.)

`apps/web/src/stage/Stage.tsx` — install the page hook when the URL asks for it:
```tsx
declare global {
  interface Window {
    __localdot?: { probe?: ProbeApi };
  }
}

export interface ProbeApi {
  start(rect: ProbeRect, threshold?: number): void;
  stop(): void;
  flips(): Flip[];
  clear(): void;
}

// inside Stage, after `const canvas = useRef<StageCanvasHandle>(null);`:
  const flips = useRef<Flip[]>([]);
  const onFlip = useCallback((flip: Flip) => {
    flips.current.push(flip);
  }, []);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("probe") !== "1") return;
    const api: ProbeApi = {
      start: (rect, threshold = 128) => canvas.current?.probe(rect, threshold),
      stop: () => canvas.current?.probe(null),
      flips: () => flips.current,
      clear: () => {
        flips.current = [];
      },
    };
    window.__localdot = { ...window.__localdot, probe: api };
    return () => {
      if (window.__localdot) window.__localdot.probe = undefined;
    };
  }, []);
// and pass `onFlip={onFlip}` to <StageCanvas ref={canvas} onFlip={onFlip} />
```

`apps/web/src/session/clock-sync.test.ts`:
```ts
import { microsToMs, msToMicros } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { sessionMsAt, syncClock } from "./clock-sync.ts";

describe("syncClock", () => {
  it("maps viewer wall-clock ms onto daemon microseconds with the lowest-RTT ping", async () => {
    let wall = 1_700_000_000_000;
    const daemonAt = (w: number) => (w - 1_700_000_000_000) * 1000 + 999_000_000;
    const rtts = [3, 1, 2];
    let i = 0;
    const fetchImpl = (async () => {
      const rtt = rtts[i++ % rtts.length] as number;
      const mid = wall + rtt / 2;
      wall += rtt;
      return new Response(JSON.stringify({ nowMicros: daemonAt(mid) }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const sample = await syncClock(fetchImpl, "http://x", "tok", 3, () => wall);
    expect(sample.rttMicros).toBe(1000);
    expect(Math.abs(msToMicros(wall) + sample.offsetMicros - daemonAt(wall))).toBeLessThan(1);
    expect(sessionMsAt(wall, { offsetMicros: sample.offsetMicros, originMicros: 999_000_000 })).toBeCloseTo(microsToMs(daemonAt(wall) - 999_000_000), 3);
  });
});
```

`apps/web/src/session/clock-sync.ts`:
```ts
import { microsToMs, msToMicros } from "@localdot/protocol";

export interface ViewerClockSample {
  offsetMicros: number;
  rttMicros: number;
}

export interface SessionClock {
  offsetMicros: number;
  originMicros: number;
}

// One ping of `GET /api/clock`: viewer wall ms when it left and when its reply arrived, and the
// daemon's microseconds in the reply.
export interface ClockPing {
  sent: number;
  got: number;
  nowMicros: number;
}

// Viewer wall clock (performance.timeOrigin + performance.now(), ms) → daemon microseconds:
// daemonMicros = msToMicros(wallMs) + offsetMicros, from the burst's lowest-RTT ping, as the
// daemon does for desktopd.
export function lowestRttSample(pings: ClockPing[]): ViewerClockSample {
  let best: ViewerClockSample | undefined;
  for (const { sent, got, nowMicros } of pings) {
    const candidate = { offsetMicros: nowMicros - msToMicros((sent + got) / 2), rttMicros: msToMicros(got - sent) };
    if (!best || candidate.rttMicros < best.rttMicros) best = candidate;
  }
  if (!best) throw new RangeError("a clock sync needs at least one ping");
  return best;
}

export async function syncClock(
  fetchImpl: typeof fetch,
  origin: string,
  token: string,
  samples = 12,
  now: () => number = () => performance.timeOrigin + performance.now(),
): Promise<ViewerClockSample> {
  const pings: ClockPing[] = [];
  for (let i = 0; i < samples; i++) {
    const sent = now();
    const res = await fetchImpl(`${origin}/api/clock`, { headers: { authorization: `Bearer ${token}` } });
    const { nowMicros } = (await res.json()) as { nowMicros: number };
    pings.push({ sent, got: now(), nowMicros });
  }
  return lowestRttSample(pings);
}

// Session milliseconds (the renderer's unit) of a viewer wall-clock instant.
export function sessionMsAt(wallMs: number, clock: SessionClock): number {
  return microsToMs(msToMicros(wallMs) + clock.offsetMicros - clock.originMicros);
}
```

Run: `pnpm exec vitest run apps/web/src && pnpm --filter @localdot/web typecheck && pnpm --filter @localdot/web build`
Expected: the web suites pass; the build succeeds.

- [ ] **Step 3: The calibration script**

`apps/web/e2e/cells.ts` (shared by the calibration, the puppet runner and the e2e specs):
```ts
import type { RunningDaemon } from "./daemon.ts";

export interface CellRef {
  id: string;
  scale: 1 | 2;
}

const headers = (d: RunningDaemon) => ({ authorization: `Bearer ${d.token}`, "content-type": "application/json" });

export async function createReadyCell(d: RunningDaemon, scale: 1 | 2, timeoutMs = 300_000): Promise<CellRef> {
  const created = await fetch(`${d.origin}/api/cells`, { method: "POST", headers: headers(d), body: JSON.stringify({ scale }) });
  if (created.status !== 202) throw new Error(`create cell: ${created.status} ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cell = (await (await fetch(`${d.origin}/api/cells/${id}`, { headers: headers(d) })).json()) as { state: string; error?: string };
    if (cell.state === "ready") return { id, scale };
    if (cell.state === "failed") throw new Error(`cell failed: ${cell.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("cell not ready in time");
}

export async function launchApp(d: RunningDaemon, cellId: string, app: string, args: string[] = []): Promise<void> {
  const res = await fetch(`${d.origin}/api/cells/${cellId}/launch`, { method: "POST", headers: headers(d), body: JSON.stringify({ app, args }) });
  if (!res.ok) throw new Error(`launch ${app}: ${res.status} ${await res.text()}`);
}

export async function rawInput(d: RunningDaemon, cellId: string, body: unknown): Promise<{ pressDaemonMicros: number; presses: number[] }> {
  const res = await fetch(`${d.origin}/api/cells/${cellId}/input`, { method: "POST", headers: headers(d), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`input: ${res.status} ${await res.text()}`);
  return (await res.json()) as { pressDaemonMicros: number; presses: number[] };
}

export async function removeCell(d: RunningDaemon, cellId: string): Promise<void> {
  await fetch(`${d.origin}/api/cells/${cellId}?purge=1`, { method: "DELETE", headers: headers(d) }).catch(() => {});
}
```

`apps/web/e2e/calibrate.ts`:
```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { microsToMs, msToMicros } from "@localdot/protocol";
import { chromium, type Page } from "@playwright/test";
import { type ClockPing, lowestRttSample } from "../src/session/clock-sync.ts";
import { createReadyCell, launchApp, rawInput, removeCell } from "./cells.ts";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";

const USAGE =
  "usage: pnpm --filter @localdot/web calibrate --compositor off|on [--scale 1|2] [--trials 500] [--injectors xtest,driver] [--kinds click,key] [--page down|up] [--out <file>]";
const OPTIONS = new Set(["compositor", "scale", "trials", "injectors", "kinds", "page", "out"]);

function usage(problem: string): never {
  console.error(`${problem}\n${USAGE}`);
  process.exit(2);
}

// pnpm 10 forwards a literal "--" to the script, and pairing from it would read each option as the
// previous one's value; so it is skipped, and anything unknown or unpaired stops the run.
function parseArgs(argv: string[]): Map<string, string> {
  const rest = argv[0] === "--" ? argv.slice(1) : argv;
  if (rest.length % 2 !== 0) usage(`options come in pairs: ${rest.join(" ")}`);
  const parsed = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = /^--([a-z]+)$/.exec(rest[i] ?? "")?.[1];
    if (!name || !OPTIONS.has(name)) usage(`unknown option ${rest[i]}`);
    parsed.set(name, rest[i + 1] ?? "");
  }
  return parsed;
}

const oneOf = <T extends string>(value: string, allowed: readonly T[], what: string): T =>
  allowed.includes(value as T) ? (value as T) : usage(`${what} must be one of ${allowed.join(", ")}`);

const args = parseArgs(process.argv.slice(2));
// off: the gate, S6's conditions (compositor off, kiosk window), which validates the harness and
// writes no table. on: the table, what users see (compositor on with Task 1's vsync mode, a
// maximized window through localdot-chromium; a kiosk window is unredirected and bypasses the
// compositor).
const compositor = oneOf(args.get("compositor") ?? "", ["off", "on"] as const, "--compositor");
const scale = oneOf(args.get("scale") ?? "2", ["1", "2"] as const, "--scale") === "1" ? 1 : 2;
const trials = Number(args.get("trials") ?? 500);
if (!Number.isInteger(trials) || trials < 1) usage("--trials must be a positive integer");
const injectors = (args.get("injectors") ?? "xtest").split(",").map((i) => oneOf(i, ["xtest", "driver"] as const, "--injectors"));
const kinds = (args.get("kinds") ?? "click,key").split(",").map((k) => oneOf(k, ["click", "key"] as const, "--kinds"));
const pageVariant = oneOf(args.get("page") ?? "down", ["down", "up"] as const, "--page");
const home = process.env.LOCALDOT_HOME || join(homedir(), ".localdot");
const out = args.get("out") ?? join(home, "calibration.json");
const gate = compositor === "off";
// Only the table on the press-acting page feeds the onsets: the gate and the release-acting
// control are a record, never the table.
const writesTable = !gate && pageVariant === "down";
const W = 1280 * scale;
const H = 800 * scale;

// S6 reference (xdotool stand-in, M3 Ultra, no compositor): p50 / p99 per group; the gate reads them.
// No driver key group (P3-C9).
const S6: Record<"xtest" | "driver", Partial<Record<"click" | "key", Record<1 | 2, readonly [number, number]>>>> = {
  xtest: { click: { 1: [9.6, 19.6], 2: [13.8, 23.1] }, key: { 1: [10.2, 19.1], 2: [16.3, 29.3] } },
  driver: { click: { 1: [5.9, 18.4], 2: [14.2, 26.4] } },
};

type ProbeWindow = Window & {
  __localdot?: {
    probe?: {
      start(rect: { x: number; y: number; width: number; height: number }, threshold?: number): void;
      clear(): void;
      flips(): { at: number }[];
    };
  };
};

// Nearest-rank percentile: the smallest value with at least p % of the sample at or below it
// (n = 500, p = 99 → the 495th value, index 494).
const pct = (sorted: number[], p: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))] as number;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// xfwm4 applies use_compositing live; xfconf-query reaches the session's xfconfd on its bus.
function setCompositing(cellId: string, on: boolean): void {
  execFileSync("docker", ["exec", "-u", "abc", "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus", desktopContainer(cellId), "xfconf-query", "-c", "xfwm4", "-p", "/general/use_compositing", "-s", String(on)], { stdio: "ignore" });
}

// The pings run in the page, whose clock the probe's flips use; the arithmetic is clock-sync.ts's.
async function viewerClock(page: Page, origin: string, token: string) {
  const pings: ClockPing[] = await page.evaluate(
    async ({ origin, token }) => {
      const now = () => performance.timeOrigin + performance.now();
      const taken: { sent: number; got: number; nowMicros: number }[] = [];
      for (let i = 0; i < 20; i++) {
        const sent = now();
        const res = await fetch(`${origin}/api/clock`, { headers: { authorization: `Bearer ${token}` } });
        const { nowMicros } = (await res.json()) as { nowMicros: number };
        taken.push({ sent, got: now(), nowMicros });
      }
      return taken;
    },
    { origin, token },
  );
  return lowestRttSample(pings);
}

async function run() {
  const daemon: RunningDaemon = await startDaemon();
  let cellId = "";
  try {
    const cell = await createReadyCell(daemon, scale);
    cellId = cell.id;
    setCompositing(cellId, !gate);
    const windowArgs = gate ? ["--kiosk"] : ["--new-window"];
    await launchApp(daemon, cellId, "chromium", [...windowArgs, `file:///opt/localdot/flash.html${pageVariant === "up" ? "#up" : ""}`]);
    await sleep(8000);
    // One untimed click: the page takes keyboard focus for the key groups.
    await rawInput(daemon, cellId, { input: { kind: "click", button: "left", count: 1, at: { x: W / 2, y: H / 2 } } });
    const browser = await chromium.launch({ channel: "chrome" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`${daemon.origin}/?probe=1#token=${daemon.token}`);
    await page.getByTestId("hud-status").filter({ hasText: "Live" }).waitFor({ timeout: 120_000 });
    await page.waitForFunction(() => Number(document.querySelector("canvas.stage-canvas")?.getAttribute("data-frames")) > 0, null, { timeout: 60_000 });
    await page.evaluate(({ W, H }) => (window as ProbeWindow).__localdot?.probe?.start({ x: W / 2 - 16, y: H / 2 - 16, width: 32, height: 32 }, 128), { W, H });

    const pass = gate ? "gate, compositor off" : "table, compositor on";
    const results: Record<string, unknown> = {};
    const onsetMs: Record<string, Record<string, Record<string, number>>> = {};
    for (const injector of injectors) {
      for (const kind of kinds) {
        const ref = S6[injector][kind];
        if (!ref) {
          console.log(`${scale}x ${injector} ${kind}: not measured (P3-C9: the driver's key path produces no raw press)`);
          continue;
        }
        const latencies: number[] = [];
        let missed = 0;
        // One untimed input: a still screen gives the probe no baseline (S6).
        await rawInput(daemon, cellId, { input: kind === "click" ? { kind: "click", button: "left", count: 1, at: { x: W / 2, y: H / 2 } } : { kind: "key", combo: ["space"] }, injector });
        await sleep(600);
        await page.evaluate(() => (window as ProbeWindow).__localdot?.probe?.clear());
        let clockSample = await viewerClock(page, daemon.origin, daemon.token);
        for (let i = 0; i < trials; i++) {
          if (i % 100 === 0 && i > 0) clockSample = await viewerClock(page, daemon.origin, daemon.token);
          const side = i % 2 === 0 ? -1 : 1;
          const point = { x: Math.round(W / 2 + (side * W) / 32), y: Math.round(H / 2) };
          const before = await page.evaluate(() => (window as ProbeWindow).__localdot?.probe?.flips().length ?? 0);
          const res = await rawInput(daemon, cellId, { input: kind === "click" ? { kind: "click", button: "left", count: 1, at: point } : { kind: "key", combo: ["space"] }, injector });
          const flip = await page.waitForFunction((n) => ((window as ProbeWindow).__localdot?.probe?.flips().length ?? 0) > n, before, { timeout: 3000 }).then(
            () => page.evaluate((n) => (window as ProbeWindow).__localdot?.probe?.flips()[n], before),
            () => undefined,
          );
          if (!flip) {
            missed += 1;
          } else {
            const frameMicros = msToMicros(flip.at) + clockSample.offsetMicros;
            latencies.push(microsToMs(frameMicros - res.pressDaemonMicros));
          }
          await sleep(400 + Math.random() * 16.7);
        }
        const sorted = [...latencies].sort((a, b) => a - b);
        const stats = { n: sorted.length, missed, p5: pct(sorted, 5), p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted.at(-1) ?? 0, min: sorted[0] ?? 0 };
        const line = `${scale}x ${injector} ${kind} [${pass}]: n=${stats.n} missed=${missed} p5=${stats.p5.toFixed(1)} p50=${stats.p50.toFixed(1)} p95=${stats.p95.toFixed(1)} p99=${stats.p99.toFixed(1)} max=${stats.max.toFixed(1)} ms`;
        const fewMissed = missed <= trials * 0.01;
        if (gate) {
          const [refP50, refP99] = ref[scale];
          const verdict = Math.abs(stats.p50 - refP50) <= 3 && stats.p99 <= refP99 + 16.7 && fewMissed ? "PASS" : "CHECK";
          console.log(`${line} (S6 p50 ${refP50} / p99 ${refP99}) ${verdict}`);
          results[`${injector}.${kind}`] = { ...stats, latencies, verdict };
        } else {
          console.log(`${line} ${fewMissed ? `→ onset ${stats.p99.toFixed(1)} ms` : "CHECK: over 1 % of the flips missed, not written"}`);
          results[`${injector}.${kind}`] = { ...stats, latencies };
          if (writesTable && fewMissed) {
            const byKind = onsetMs[injector] ?? {};
            byKind[kind] = { ...(byKind[kind] ?? {}), [String(scale)]: Number(stats.p99.toFixed(1)) };
            onsetMs[injector] = byKind;
          }
        }
      }
    }
    await browser.close();

    mkdirSync("e2e/out", { recursive: true });
    const record = `e2e/out/calibrate-${scale}x-${compositor}-${pageVariant}-${Date.now()}.json`;
    writeFileSync(record, JSON.stringify({ scale, trials, compositor, pageVariant, results }, null, 1));
    if (!writesTable || Object.keys(onsetMs).length === 0) {
      console.log(`recorded in ${record}; ${out} is unchanged`);
      return;
    }
    let existing: { onsetMs?: Record<string, Record<string, Record<string, number>>> } = {};
    try {
      existing = JSON.parse(readFileSync(out, "utf8"));
    } catch {}
    const merged = structuredClone(existing.onsetMs ?? {});
    for (const [injector, byKind] of Object.entries(onsetMs)) {
      const row = merged[injector] ?? {};
      for (const [kind, byScale] of Object.entries(byKind)) row[kind] = { ...(row[kind] ?? {}), ...byScale };
      merged[injector] = row;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ v: 1, measuredAt: new Date().toISOString(), machine: hostname(), trials, onsetMs: merged }, null, 2)}\n`, { mode: 0o600 });
    console.log(`wrote ${out}; recorded in ${record}`);
  } finally {
    if (cellId) await removeCell(daemon, cellId);
    await daemon.stop();
  }
}

await run();
```
`apps/web/package.json` — scripts: add `"calibrate": "tsx e2e/calibrate.ts"` (the
`@localdot/protocol` dependency the script imports came in Step 2).

- [ ] **Step 4: Run it on this machine**

Rebuild the image for the flash page (`cells/desktop/build.sh`), `pnpm --filter @localdot/web build`,
then the gate and the table at each scale (no `--` before the options):
```bash
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor off --scale 2 --trials 500
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor on --scale 2 --trials 500
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor off --scale 1 --trials 500
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor on --scale 1 --trials 500
```
Expected: about 8 minutes per command (two groups × 500 trials × ~0.45 s).
- Each gate pass prints two lines like
  `2x xtest click [gate, compositor off]: n=500 missed=0 p5=… p50=13.x p95=… p99=2x.x max=… ms (S6 p50 13.8 / p99 23.1) PASS`
  and `recorded in e2e/out/calibrate-2x-off-down-….json; <home>/calibration.json is unchanged`.
- Each table pass prints two lines like
  `2x xtest click [table, compositor on]: n=500 missed=0 p5=… p50=… p95=… p99=… max=… ms → onset … ms`
  and `wrote <home>/calibration.json`. With Task 1's vsync off the table's p50 runs about 4 ms
  above the gate's (S8); with XPresent, 26–30 ms.
- `~/.localdot/calibration.json` then holds `onsetMs.xtest.click["2"]`, `.key["2"]`, then `["1"]`,
  all from the table passes.

If a gate line reads `CHECK`, the harness does not reproduce S6, and no table run counts until it
does:
- The client is slower than xdotool's stand-in or misses flips: look at `e2e/out/calibrate-*.json`
  (`latencies`) and at `docker logs` of the cell for `xhelper:` lines. The usual causes are
  `desktopd`'s `withPress` 150 ms timeout, the helper's `sync()` after each press, and the kiosk
  page not being the active window.
- If the p50 misses S6 by more than ±3 ms in every group while the p99 rule and the missed count
  hold, the image itself may have moved since S6: S8 measured 19–21 ms with no compositor against
  S6's 17.5 ms after Part 2 changed the look (P3-C15). Re-baseline the gate with S6's own script
  run on the current image: `spikes/s6-timing` (its FINDINGS' "Method": `setup.sh`, `detector.js`
  in the viewer, `measure.mjs 120` for the bare key, `inputs.mjs xtest click flash 120` and
  `inputs.mjs cua click flash 120` for the clicks) against `localdot/desktop:dev` with the compositor
  off. Replace the `S6` rows in `calibrate.ts` and in the measurement doc with the new p50 / p99,
  say there which image they came from, and run the gate again. Do not loosen the tolerance (±3 ms
  on the p50, one frame on the p99).

A table line reading `CHECK` missed more than 1 % of the flips and wrote nothing for its group:
re-run that pass. The driver rows are measured in Task 8 Step 3, once the driver injector exists.

Also run the release-acting page once, for the record only (it never writes the table):
```bash
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor on --scale 2 --trials 200 --kinds click --page up
```

Write `docs/measurements/2026-10-ring-onset.md`:
```markdown
# Ring onset: raw press → frame on this machine (Part 3 calibration)

<date> · <machine, chip> · Docker Desktop <version> · Google Chrome <version> · `localdot/desktop:dev` ·
`apps/web/e2e/calibrate.ts`, 500 trials per group, luma probe on the stage's own frame tap, viewer and
desktopd clocks mapped to the daemon's by lowest-RTT pings.

## Gate: the harness against S6 (compositor off, flash page in a kiosk window)

| Scale | Injector | Kind | n | missed | p50 | p99 | S6 p50 / p99 | gate |
|---|---|---|---|---|---|---|---|---|
| 2× | own XTest | click | … | … | … | … | 13.8 / 23.1 | PASS |
| 2× | own XTest | key | … | … | … | … | 16.3 / 29.3 | PASS |
| 1× | own XTest | click | … | … | … | … | 9.6 / 19.6 | PASS |
| 1× | own XTest | key | … | … | … | … | 10.2 / 19.1 | PASS |
| 2× | driver | click | (Task 8) | | | | 14.2 / 26.4 | |
| 1× | driver | click | (Task 8) | | | | 5.9 / 18.4 | |

## Table: what users see (compositor on, `vblank_mode` <Task 1's mode>, flash page maximized)

| Scale | Injector | Kind | n | missed | p5 | p50 | p95 | p99 (= onset) | max |
|---|---|---|---|---|---|---|---|---|---|
| 2× | own XTest | click | … | … | … | … | … | … | … |
| 2× | own XTest | key | … | … | … | … | … | … | … |
| 1× | own XTest | click | … | … | … | … | … | … | … |
| 1× | own XTest | key | … | … | … | … | … | … | … |
| 2× | driver | click | (Task 8) | | | | | | |
| 1× | driver | click | (Task 8) | | | | | | |

No driver key row: the driver's `press_key` is XSendEvent, which produces no XI2 raw press, so the
fallback path delivers clicks and typed text only (P3-C9); driver-typed text uses the click row.

Release-acting control (`flash.html#up`, 200 clicks, 2×, compositor on): p50 … / p99 … ms — the
tail the "keep" policy accepts (A1: a ring may lead such a control's change by up to one frame).

The gateway reads `~/.localdot/calibration.json`, which only the table passes write; on a machine
without it, the development Mac's S6 numbers apply until this command has run there.
```
Fill the tables from the printed lines.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add cells/desktop/root/opt/localdot/flash.html apps/web docs/measurements/2026-10-ring-onset.md pnpm-lock.yaml
git commit -m "feat(calibrate): measure raw press to frame per injector and scale with 500 trials"
```
(`~/.localdot/calibration.json` and `apps/web/e2e/out/` are not committed.)

---
### Task 7: desktopd perception — Cua Driver client, per-toolkit mapping, observe, hitTest and find

Cua Driver 0.30.4 runs as `cua-driver mcp --no-overlay` for perception only (D3): windows, trees
and the desktop screenshot. `desktopd` maps every element frame into desktop device pixels with the
spec's per-toolkit formulas (D13) and never uses `screenshot_frame`. `hitTest(point)` picks the
top-most window under the point from the X helper's stacking order, asks the driver for that
window's tree, maps it and returns the smallest element containing the point. `observe()` returns a
1280×800 WebP (the driver's PNG through `cwebp`), the pointer and the window list. The driver's own
input calls become the fallback injector (clicks and typed text, P3-C9). Task 7b, right after,
confirms the driver's telemetry and update-check opt-outs on the wire (a Part 2 obligation).

**Files:**
- Create: `packages/protocol/src/text.ts`, `packages/protocol/src/text.test.ts`
- Create: `cells/desktop/desktopd/src/perception/driver.ts`, `cells/desktop/desktopd/src/perception/mapping.ts`,
  `cells/desktop/desktopd/src/perception/hit-test.ts`, `cells/desktop/desktopd/src/perception/observe.ts`,
  `cells/desktop/desktopd/src/perception/find.ts`, `cells/desktop/desktopd/src/perception/cdp.ts`
  (a type-only stub; Task 8 replaces it)
- Modify: `packages/protocol/src/index.ts`, `cells/desktop/desktopd/src/app.ts`,
  `cells/desktop/desktopd/src/main.ts`, `cells/desktop/desktopd/package.json`,
  `cells/desktop/desktopd/build.mjs`, `cells/desktop/THIRD-PARTY.md`,
  `apps/daemon/src/cells/testing/desktop-container.ts`
- Test: `packages/protocol/src/text.test.ts`, `cells/desktop/desktopd/src/perception/mapping.test.ts`,
  `cells/desktop/desktopd/src/perception/hit-test.test.ts`, `cells/desktop/desktopd/src/perception/observe.test.ts`,
  `apps/daemon/src/cells/desktopd-perception.docker.test.ts`

**Interfaces:**
- Consumes: `XHelper` (Task 3), `inject`'s `Injectors` (Task 4), the wire schemas (Task 4); Part 2's
  `readXsettings(uid)` (null while the session's settings are unknown).
- Produces: `clipText(text, max): string` (control characters → spaces, trimmed, cut with `…`);
  `keyDisplayName(key): string` (how a key reads in a label or on a keycap: `Ctrl`, `Shift`, `Return`,
  `Space`, `Backspace`, letters upper-cased; Linux names, research §4.3.6), shared by the gateway's
  labels (Task 9) and the stage's keycaps (Task 13);
  `class CuaDriver { constructor({ command, args, env }); listWindows(); windowState(pid, windowId, timeoutMs?); desktopShot(maxDimension?): Promise<Buffer>; click(pid, windowId, point, button, count); typeText(pid, windowId, text); close() }`
  (no `pressKey`, P3-C9),
  `DriverWindow`, `DriverElement`, `DriverWindowState`;
  `appToolkit(cls): "gtk" | "libreoffice" | "chromium"`, `elementToolkit(app, el, ancestorRoles): Toolkit`,
  `frameToDevice(frame, toolkit, params): Rect`, `menuBarHeight(elements): number`, `MapParams { g; c; m; windowOrigin }`;
  `hitTest(deps, point): Promise<HitTestResult>`, `findTarget(deps, req): Promise<HitTestResult>`
  (both skip the panel, the dock and the desktop window, `DECOR_CLASSES`; `findTarget` walks the
  windows' trees inside a 4 s budget, under the client's 5 s `find` timeout),
  `PerceptionDeps { x; driver; cdp?: ChromiumPerception; scale; readScaling(): Promise<number> }`;
  `observe(deps): Promise<ObserveResult>`; `driverInjector(driver, x): DriverInjector` (`click(req)`, `type(req)`);
  desktopd routes `POST /observe`, `POST /hitTest`, `POST /find`; `DesktopdDeps.perception?: PerceptionDeps`.
  desktopd's bundle header and `cells/desktop/THIRD-PARTY.md` carry the license notice of every
  package the bundle contains (`build.mjs` reads them from esbuild's metafile and fails on a package
  without one).

- [ ] **Step 1: Text clipping (shared by desktopd and the gateway), test first**

`packages/protocol/src/text.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { clipText, keyDisplayName } from "./text.ts";

describe("clipText", () => {
  it("strips control characters, collapses whitespace and cuts with an ellipsis", () => {
    expect(clipText("  Save\tAs\n\u0007now  ", 80)).toBe("Save As now");
    expect(clipText("a".repeat(100), 10)).toBe("aaaaaaaaa…");
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("", 10)).toBe("");
  });

  it("counts code points, not UTF-16 units", () => {
    expect(clipText("😀".repeat(5), 3)).toBe("😀😀…");
  });
});

describe("keyDisplayName", () => {
  it("names keys the way labels and keycaps show them", () => {
    expect(["ctrl", "Control_L", "shift", "s", "Return", "space", "backspace", "F5"].map(keyDisplayName)).toEqual(["Ctrl", "Ctrl", "Shift", "S", "Return", "Space", "Backspace", "F5"]);
  });
});
```

`packages/protocol/src/text.ts`:
```ts
// Labels and names come from accessibility trees and page titles, which can hold anything; every
// string that enters an event is cut to its schema limit in code points (Review Focus 3).
export function clipText(text: string, max: number): string {
  const clean = text.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

// One name per key for the gateway's labels and the stage's keycaps: the guest is Linux, so names
// rather than macOS glyphs (research §4.3.6).
const KEY_DISPLAY: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", control_l: "Ctrl", alt: "Alt", alt_l: "Alt", shift: "Shift", shift_l: "Shift",
  cmd: "Super", super: "Super", super_l: "Super", win: "Super", enter: "Return", return: "Return",
  esc: "Esc", escape: "Esc", space: "Space", backspace: "Backspace", tab: "Tab",
};

export function keyDisplayName(key: string): string {
  return KEY_DISPLAY[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key);
}
```
`packages/protocol/src/index.ts` — add `export * from "./text.ts";`.

Run: `pnpm exec vitest run packages/protocol/src/text.test.ts`
Expected: 3 tests pass.

- [ ] **Step 2: Mapping, test first (S2's measured numbers)**

`cells/desktop/desktopd/src/perception/mapping.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { appToolkit, elementToolkit, frameToDevice, menuBarHeight } from "./mapping.ts";

describe("frameToDevice (D13, S2 measurements)", () => {
  it("GTK3 at 2x with window scaling 2: Thunar's File menu at a window whose origin is odd", () => {
    // S2: raw menu File (0,39) 39×27 for a window at device (1,78) → the menu sits at the window's top-left.
    expect(frameToDevice({ x: 0, y: 39, w: 39, h: 27 }, "gtk", { g: 2, c: 2, m: 27, windowOrigin: { x: 1, y: 78 } })).toEqual({ x: 1, y: 78, w: 78, h: 54 });
    // Plain frame × g would give (0, 78): off by one at the odd origin (carry-forward).
  });

  it("GTK3 at 1x is the identity", () => {
    expect(frameToDevice({ x: 1057, y: 634, w: 31, h: 40 }, "gtk", { g: 1, c: 1, m: 27, windowOrigin: { x: 0, y: 27 } })).toEqual({ x: 1057, y: 634, w: 31, h: 40 });
  });

  it("LibreOffice GTK-drawn parts follow the GTK rule, VCL-drawn parts shift by the menu bar", () => {
    const p = { g: 2, c: 2, m: 27, windowOrigin: { x: 0, y: 77 } };
    // S2 at 2x GTK×2: File (0,38) 39×27 → device (0,77); New (4,40) 45×36 is a toolbar button, one menu bar too high.
    expect(frameToDevice({ x: 0, y: 38, w: 39, h: 27 }, "libreoffice-gtk", p)).toEqual({ x: 0, y: 77, w: 78, h: 54 });
    expect(frameToDevice({ x: 4, y: 40, w: 45, h: 36 }, "libreoffice-vcl", p)).toEqual({ x: 8, y: 134, w: 90, h: 72 });
    // 1x: New (4,52) is on screen at y 79–115.
    expect(frameToDevice({ x: 4, y: 52, w: 45, h: 36 }, "libreoffice-vcl", { g: 1, c: 1, m: 27, windowOrigin: { x: 0, y: 50 } })).toEqual({ x: 4, y: 79, w: 45, h: 36 });
  });

  it("Chromium browser chrome scales by the device scale factor", () => {
    // S2: root frame 1050×753 at (10,37) for an X window 2100×1506+20+74.
    expect(frameToDevice({ x: 10, y: 37, w: 1050, h: 753 }, "chromium-chrome", { g: 2, c: 2, m: 27, windowOrigin: { x: 20, y: 74 } })).toEqual({ x: 20, y: 74, w: 2100, h: 1506 });
  });
});

describe("toolkit classification", () => {
  it("classifies apps by WM_CLASS", () => {
    expect(appToolkit("Chromium")).toBe("chromium");
    expect(appToolkit("libreoffice-calc")).toBe("libreoffice");
    expect(appToolkit("Soffice")).toBe("libreoffice");
    expect(appToolkit("Thunar")).toBe("gtk");
    expect(appToolkit("Xfce4-terminal")).toBe("gtk");
  });

  it("marks LibreOffice's VCL-drawn parts per role and tool-bar ancestry, GTK-drawn text fields never", () => {
    expect(elementToolkit("libreoffice", { role: "menu", inWeb: false }, [])).toBe("libreoffice-gtk");
    expect(elementToolkit("libreoffice", { role: "button", inWeb: false }, ["tool bar"])).toBe("libreoffice-vcl");
    expect(elementToolkit("libreoffice", { role: "panel", inWeb: false }, ["tool bar"])).toBe("libreoffice-vcl");
    expect(elementToolkit("libreoffice", { role: "text", inWeb: false }, ["panel", "tool bar"])).toBe("libreoffice-gtk");
    expect(elementToolkit("libreoffice", { role: "table", inWeb: false }, [])).toBe("libreoffice-vcl");
    expect(elementToolkit("libreoffice", { role: "page tab", inWeb: false }, ["page tab list"])).toBe("libreoffice-vcl");
    expect(elementToolkit("libreoffice", { role: "button", inWeb: false }, ["page tab list"])).toBe("libreoffice-gtk");
    expect(elementToolkit("chromium", { role: "button", inWeb: false }, [])).toBe("chromium-chrome");
    expect(elementToolkit("chromium", { role: "link", inWeb: true }, [])).toBe("chromium-web");
    expect(elementToolkit("gtk", { role: "anything", inWeb: true }, [])).toBe("gtk");
  });

  it("reads the native menu bar height from the menu rows, 27 by default", () => {
    expect(menuBarHeight([{ role: "menu", frame: { x: 0, y: 50, w: 39, h: 27 }, depth: 2 }, { role: "menu", frame: { x: 0, y: 50, w: 36, h: 22 }, depth: 3 }])).toBe(27);
    expect(menuBarHeight([])).toBe(27);
    expect(menuBarHeight([{ role: "menu", frame: { x: 0, y: 125, w: 60, h: 45 }, depth: 2 }])).toBe(45);
  });
});
```

`cells/desktop/desktopd/src/perception/mapping.ts`:
```ts
import type { Point, Rect } from "@localdot/protocol";

export type AppToolkit = "gtk" | "libreoffice" | "chromium";
export type Toolkit = "gtk" | "libreoffice-gtk" | "libreoffice-vcl" | "chromium-chrome" | "chromium-web";

export interface MapParams {
  g: number;
  c: number;
  m: number;
  windowOrigin: Point;
}

export interface ElementLike {
  role: string;
  inWeb: boolean;
}

// LibreOffice draws these itself (VCL) and reports them one native menu bar too high (S2); anything
// inside a tool bar is VCL-drawn except the GTK text fields embedded in it.
const VCL_ROLES = new Set([
  "tool bar", "table", "table cell", "table column header", "table row header", "page tab",
  "document text", "document spreadsheet", "document presentation", "paragraph", "text frame",
  "canvas", "drawing area",
]);
const GTK_DRAWN_ROLES = new Set(["text", "entry", "password text", "menu", "menu bar", "menu item", "check menu item", "radio menu item", "scroll bar", "combo box"]);

export function appToolkit(cls: string): AppToolkit {
  const lower = cls.toLowerCase();
  if (lower.startsWith("chromium") || lower === "chrome") return "chromium";
  if (lower.startsWith("libreoffice") || lower === "soffice") return "libreoffice";
  return "gtk";
}

export function elementToolkit(app: AppToolkit, el: ElementLike, ancestorRoles: string[]): Toolkit {
  if (app === "chromium") return el.inWeb ? "chromium-web" : "chromium-chrome";
  if (app === "gtk") return "gtk";
  if (GTK_DRAWN_ROLES.has(el.role)) return "libreoffice-gtk";
  if (VCL_ROLES.has(el.role) || ancestorRoles.includes("tool bar")) return "libreoffice-vcl";
  return "libreoffice-gtk";
}

// Canonical space = desktop device pixels, one transform per toolkit (spec "Frame mapping").
export function frameToDevice(frame: Rect, toolkit: Toolkit, p: MapParams): Rect {
  switch (toolkit) {
    case "gtk":
    case "libreoffice-gtk": {
      // device = windowOrigin + (frame − floor(windowOrigin / g)) × g, never plain frame × g.
      const ox = Math.floor(p.windowOrigin.x / p.g);
      const oy = Math.floor(p.windowOrigin.y / p.g);
      return { x: p.windowOrigin.x + (frame.x - ox) * p.g, y: p.windowOrigin.y + (frame.y - oy) * p.g, w: frame.w * p.g, h: frame.h * p.g };
    }
    case "libreoffice-vcl":
      return { x: frame.x * p.g, y: (frame.y + p.m) * p.g, w: frame.w * p.g, h: frame.h * p.g };
    case "chromium-chrome":
      return { x: frame.x * p.c, y: frame.y * p.c, w: frame.w * p.c, h: frame.h * p.c };
    case "chromium-web":
      throw new RangeError("web content boxes come from CDP, not from the tree");
  }
}

// m: LibreOffice's native menu bar height in frame units, the tallest shallow `menu` row (27 at
// Xft/DPI 96, 45 when LibreOffice renders at 192 dpi with window scaling 1).
export function menuBarHeight(elements: { role: string; frame?: Rect; depth: number }[]): number {
  const menus = elements.filter((e) => e.role === "menu" && e.frame && e.depth <= 3).map((e) => e.frame?.h ?? 0);
  return menus.length ? Math.max(...menus) : 27;
}
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src/perception/mapping.test.ts`
Expected: 7 tests pass.

- [ ] **Step 3: The driver client**

`cells/desktop/desktopd/src/perception/driver.ts`:
```ts
import type { Point } from "@localdot/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface DriverWindow {
  window_id: number;
  pid: number;
  app_name: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  z_index: number;
}

export interface DriverElement {
  element_index: number;
  element_token?: string;
  role: string;
  label?: string;
  value?: string;
  frame?: { x: number; y: number; w: number; h: number };
  parent_index?: number;
  depth: number;
  actions?: string[];
  in_web_content?: boolean;
}

export interface DriverWindowState {
  elements: DriverElement[];
  truncated?: boolean;
  truncation_reason?: string;
}

export interface DriverOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface ToolResult {
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverError";
  }
}

// One MCP stdio session, started on first use and restarted after it exits. The SDK passes only a
// safe default environment to the child, so DISPLAY, the session bus and the opt-outs are explicit.
export class CuaDriver {
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;

  constructor(private readonly opts: DriverOptions) {}

  static defaultOptions(env: NodeJS.ProcessEnv = process.env): DriverOptions {
    return {
      command: env.LOCALDOT_CUA_DRIVER ?? "/usr/local/bin/cua-driver",
      args: ["mcp", "--no-overlay"],
      env: {
        DISPLAY: env.DISPLAY ?? ":1",
        DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS ?? "unix:path=/tmp/localdot-session-bus",
        HOME: env.HOME ?? "/config",
        PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
        CUA_DRIVER_RS_UPDATE_CHECK: "0",
        CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS: "0",
      },
    };
  }

  async #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      const transport = new StdioClientTransport({ command: this.opts.command, args: this.opts.args, env: this.opts.env, stderr: "pipe" });
      transport.stderr?.on("data", (d: Buffer) => {
        const line = String(d).trim();
        // The driver warns about its disabled overlay on every start; everything else is worth a log line.
        if (line && !line.includes("overlay")) console.error(`cua-driver: ${line}`);
      });
      const client = new Client({ name: "localdot-desktopd", version: "0.0.0" });
      transport.onclose = () => {
        this.#client = undefined;
      };
      await client.connect(transport);
      this.#client = client;
      return client;
    })().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async call<T>(name: string, args: Record<string, unknown>, timeoutMs = 10_000): Promise<{ structured: T | undefined; content: NonNullable<ToolResult["content"]> }> {
    const client = await this.#connect();
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as ToolResult;
    if (result.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
      throw new DriverError(`${name}: ${text || "error"}`);
    }
    return { structured: result.structuredContent as T | undefined, content: result.content ?? [] };
  }

  async listWindows(): Promise<DriverWindow[]> {
    const { structured } = await this.call<{ windows: DriverWindow[] }>("list_windows", {});
    return structured?.windows ?? [];
  }

  async windowState(pid: number, windowId: number, timeoutMs = 2500): Promise<DriverWindowState> {
    const { structured } = await this.call<DriverWindowState>("get_window_state", { pid, window_id: windowId, timeout_ms: timeoutMs, include_screenshot: false }, timeoutMs + 5000);
    return structured ?? { elements: [] };
  }

  // The driver's PNG of the X root, downscaled to the model's 1280 px width at 2×.
  async desktopShot(maxDimension = 1280): Promise<Buffer> {
    const { content } = await this.call("get_desktop_state", { max_image_dimension: maxDimension }, 15_000);
    const image = content.find((c) => c.type === "image" && c.data);
    if (!image?.data) throw new DriverError("get_desktop_state returned no image");
    return Buffer.from(image.data, "base64");
  }

  // The fallback injector (D12): foreground delivery in desktop coordinates; pressT still comes
  // from the XI2 listener.
  async click(pid: number, windowId: number, point: Point, button: "left" | "right" | "middle", count: 1 | 2 | 3): Promise<void> {
    const name = count === 2 ? "double_click" : button === "right" ? "right_click" : "click";
    await this.call(name, { pid, window_id: windowId, x: point.x, y: point.y, coordinate_frame: "desktop", delivery_mode: "foreground" });
  }

  // No pressKey: the driver's press_key is XSendEvent, which the XI2 raw listener never sees, so
  // key combos are not offered on the fallback path (P3-C9).
  async typeText(pid: number, windowId: number, text: string): Promise<void> {
    await this.call("type_text", { pid, window_id: windowId, text, delivery_mode: "foreground" });
  }

  async close(): Promise<void> {
    await this.#client?.close();
    this.#client = undefined;
  }
}
```
`cells/desktop/desktopd/package.json` — add `"@modelcontextprotocol/sdk": "1.31.0"` and `"ws": "8.22.0"`
to `dependencies`, `"@types/ws": "8.18.2"` to `devDependencies`; `pnpm install` (both are already in the
lockfile, so no network beyond `pixi.js` later).

- [ ] **Step 4: Hit test, find and observe — tests, then the implementation**

`cells/desktop/desktopd/src/perception/hit-test.test.ts` (fakes for the helper and the driver):
```ts
import { describe, expect, it } from "vitest";
import type { XHelper } from "../x/helper.ts";
import type { CuaDriver, DriverElement } from "./driver.ts";
import { findTarget, hitTest, type PerceptionDeps } from "./hit-test.ts";

const win = (id: number, cls: string, x: number, y: number, w: number, h: number, pid = 10 * id) => ({ id, pid, cls, title: `${cls} window`, x, y, w, h, frame: [x - 1, y - 24, w + 2, h + 25], active: id === 1 });

function deps(windows: ReturnType<typeof win>[], trees: Record<number, DriverElement[]>, scale: 1 | 2 = 2): PerceptionDeps & { driverCalls: number[] } {
  const driverCalls: number[] = [];
  const x = { call: async (cmd: string) => (cmd === "windows" ? { windows } : {}) } as unknown as XHelper;
  const driver = {
    windowState: async (_pid: number, id: number) => {
      driverCalls.push(id);
      return { elements: trees[id] ?? [] };
    },
  } as unknown as CuaDriver;
  return { x, driver, scale, readScaling: async () => scale, driverCalls };
}

const el = (index: number, role: string, label: string, frame: DriverElement["frame"], depth: number, parent?: number, inWeb = false): DriverElement => ({ element_index: index, role, label, frame, depth, parent_index: parent, in_web_content: inWeb });

describe("hitTest", () => {
  it("picks the top-most window under the point and the smallest mapped element containing it", async () => {
    // The helper lists windows top-most first: the terminal (active, on top) overlaps Thunar.
    const d = deps(
      [win(1, "Xfce4-terminal", 500, 300, 800, 600), win(2, "Thunar", 1, 78, 1280, 960)],
      {
        2: [el(0, "frame", "Thunar window", { x: 0, y: 0, w: 640, h: 480 }, 0), el(1, "menu bar", "", { x: 0, y: 39, w: 640, h: 27 }, 1, 0), el(2, "menu", "File", { x: 0, y: 39, w: 39, h: 27 }, 2, 1)],
        1: [el(0, "frame", "Terminal", { x: 250, y: 150, w: 400, h: 300 }, 0)],
      },
    );
    // (20,100) is outside the terminal's frame (x ≥ 499), so Thunar is the window under it;
    // the File menu at frame (0,39,39,27) maps to device (1,78,78,54) with origin (1,78), g = 2.
    const hit = await hitTest(d, { x: 20, y: 100 });
    expect(hit.window).toBe(2);
    expect(hit.target).toMatchObject({ point: { x: 20, y: 100 }, source: "ax", role: "menu", name: "File", app: "Thunar", window: "Thunar window", bbox: { x: 1, y: 78, w: 78, h: 54 } });
    expect(d.driverCalls).toEqual([2]);
    // (600,400) is inside both; the top-most (terminal) wins.
    const inTerminal = await hitTest(d, { x: 600, y: 400 });
    expect(inTerminal.window).toBe(1);
    expect(inTerminal.target?.app).toBe("Xfce4-terminal");
  });

  it("returns a coordinates-only target on a window's decoration and nothing on empty desktop", async () => {
    const d = deps([win(2, "Thunar", 1, 78, 1280, 960)], { 2: [] });
    const title = await hitTest(d, { x: 100, y: 60 });
    expect(title.target).toMatchObject({ source: "coords", app: "Thunar" });
    expect(title.target?.bbox).toBeUndefined();
    const nothing = await hitTest(d, { x: 2500, y: 1500 });
    expect(nothing.target).toBeNull();
    expect(nothing.window).toBeNull();
  });

  it("never names the panel, the dock or the desktop as the window under a point", async () => {
    const d = deps([win(9, "Xfce4-panel", 0, 0, 2560, 54), win(2, "Thunar", 1, 78, 1280, 960)], { 2: [], 9: [] });
    const onPanel = await hitTest(d, { x: 100, y: 20 });
    expect(onPanel.target).toBeNull();
    expect(onPanel.window).toBeNull();
    expect(d.driverCalls).toEqual([]);
  });

  it("flags password fields as secret and clips long names", async () => {
    const d = deps([win(3, "Mousepad", 0, 54, 1000, 800)], {
      3: [el(0, "password text", "x".repeat(200), { x: 10, y: 40, w: 100, h: 20 }, 1)],
    });
    // GTK3 with origin (0,54), g = 2: device = (0,54) + ((10,40) − (0,27)) × 2 = (20,80), size 200×40.
    const hit = await hitTest(d, { x: 50, y: 90 });
    expect(hit.target?.bbox).toEqual({ x: 20, y: 80, w: 200, h: 40 });
    expect(hit.target?.secret).toBe(true);
    expect(hit.target?.name?.length).toBe(64);
    expect(hit.target?.name?.endsWith("…")).toBe(true);
  });

  it("applies the VCL shift inside LibreOffice tool bars", async () => {
    const d = deps([win(4, "libreoffice-calc", 0, 77, 2560, 1523)], {
      4: [el(0, "frame", "Calc", { x: 0, y: 38, w: 1280, h: 762 }, 0), el(1, "menu", "File", { x: 0, y: 38, w: 39, h: 27 }, 1, 0), el(2, "tool bar", "Standard", { x: 0, y: 40, w: 1280, h: 36 }, 1, 0), el(3, "button", "New", { x: 4, y: 40, w: 45, h: 36 }, 2, 2)],
    });
    const hit = await hitTest(d, { x: 40, y: 150 });
    expect(hit.target).toMatchObject({ role: "button", name: "New", bbox: { x: 8, y: 134, w: 90, h: 72 } });
  });
});

describe("findTarget", () => {
  it("finds an element by role and name in the top-most matching window", async () => {
    const d = deps([win(4, "libreoffice-calc", 0, 77, 2560, 1523)], {
      4: [el(0, "frame", "Calc", { x: 0, y: 38, w: 1280, h: 762 }, 0), el(1, "text", "Name Box", { x: 10, y: 80, w: 100, h: 24 }, 2, 0)],
    });
    const found = await findTarget(d, { name: "name box" });
    expect(found.target).toMatchObject({ role: "text", name: "Name Box", bbox: { x: 20, y: 161, w: 200, h: 48 } });
    expect(found.target?.point).toEqual({ x: 120, y: 185 });
    expect((await findTarget(d, { name: "Nope", role: "button" })).target).toBeNull();
  });

  it("never looks in the panel, the dock or the desktop window", async () => {
    const d = deps([win(9, "Xfce4-panel", 0, 0, 2560, 54), win(4, "Thunar", 1, 78, 1280, 960)], {
      9: [el(0, "push button", "Search", { x: 10, y: 5, w: 30, h: 20 }, 1)],
      4: [],
    });
    expect((await findTarget(d, { name: "Search" })).target).toBeNull();
    expect(d.driverCalls).toEqual([4]);
  });
});
```

`cells/desktop/desktopd/src/perception/hit-test.ts`:
```ts
import { clipText, type FindRequest, type HitTestResult, type Point, type Rect, type Target } from "@localdot/protocol";
import type { XHelper } from "../x/helper.ts";
import type { ChromiumPerception } from "./cdp.ts";
import type { CuaDriver, DriverElement } from "./driver.ts";
import { appToolkit, elementToolkit, frameToDevice, menuBarHeight } from "./mapping.ts";

export interface HelperWindow {
  id: number;
  pid: number;
  cls: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  frame: [number, number, number, number];
  active: boolean;
}

export interface PerceptionDeps {
  x: XHelper;
  driver: CuaDriver;
  cdp?: ChromiumPerception;
  scale: 1 | 2;
  readScaling(): Promise<number>;
}

const TREE_TIMEOUT_MS = 2500;
// find walks window after window; it stops inside the daemon client's 5 s find timeout.
const FIND_BUDGET_MS = 4000;

const contains = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const area = (r: Rect) => r.w * r.h;

export async function listWindows(x: XHelper): Promise<HelperWindow[]> {
  const { windows } = await x.call<{ windows: HelperWindow[] }>("windows");
  return windows;
}

// The panel, the dock and the desktop window (the classes the Task 3 windows test filters) are
// never "the app under the point": a point on the panel strut has no window, so hitTest returns
// a null target and the gateway keeps the crosshair; find never searches them either.
export const DECOR_CLASSES = new Set(["Xfce4-panel", "Plank", "Xfdesktop"]);

export function windowUnder(windows: HelperWindow[], point: Point): HelperWindow | undefined {
  return windows.find((w) => !DECOR_CLASSES.has(w.cls) && contains({ x: w.frame[0], y: w.frame[1], w: w.frame[2], h: w.frame[3] }, point));
}

interface Mapped {
  el: DriverElement;
  rect: Rect;
}

// Every frame through its toolkit's transform; web content is left to CDP (chromium-web throws).
export function mapTree(elements: DriverElement[], cls: string, params: { g: number; c: number; windowOrigin: Point }): Mapped[] {
  const app = appToolkit(cls);
  const byIndex = new Map(elements.map((e) => [e.element_index, e]));
  const ancestorsOf = (e: DriverElement): string[] => {
    const roles: string[] = [];
    let p = e.parent_index === undefined ? undefined : byIndex.get(e.parent_index);
    for (let i = 0; p && i < 64; i++) {
      roles.push(p.role);
      p = p.parent_index === undefined ? undefined : byIndex.get(p.parent_index);
    }
    return roles;
  };
  const m = menuBarHeight(elements);
  const out: Mapped[] = [];
  for (const el of elements) {
    if (!el.frame) continue;
    const toolkit = elementToolkit(app, { role: el.role, inWeb: el.in_web_content === true }, ancestorsOf(el));
    if (toolkit === "chromium-web") continue;
    out.push({ el, rect: frameToDevice(el.frame, toolkit, { ...params, m }) });
  }
  return out;
}

function targetFrom(point: Point, win: HelperWindow, mapped: Mapped | undefined, source: Target["source"]): Target {
  const base: Target = { point, source, app: clipText(win.cls, 128), window: clipText(win.title, 256) };
  if (!mapped) return base;
  const { el, rect } = mapped;
  return {
    ...base,
    bbox: rect,
    role: clipText(el.role, 64),
    ...(el.label ? { name: clipText(el.label, 64) } : {}),
    ...(el.role === "password text" ? { secret: true } : {}),
  };
}

export async function hitTest(deps: PerceptionDeps, point: Point): Promise<HitTestResult> {
  const t0 = performance.now();
  const windows = await listWindows(deps.x);
  const win = windowUnder(windows, point);
  const done = (target: Target | null, window: number | null): HitTestResult => ({ target, window, ms: Math.round(performance.now() - t0) });
  if (!win) return done(null, null);
  const client = { x: win.x, y: win.y, w: win.w, h: win.h };
  if (!contains(client, point)) return done(targetFrom(point, win, undefined, "coords"), win.id);
  if (appToolkit(win.cls) === "chromium" && deps.cdp) {
    const web = await deps.cdp.hitTest(win, point).catch(() => null);
    if (web) return done(web, win.id);
  }
  const g = await deps.readScaling();
  const c = await chromeScale(deps, win);
  const state = await deps.driver.windowState(win.pid, win.id, TREE_TIMEOUT_MS);
  const mapped = mapTree(state.elements, win.cls, { g, c, windowOrigin: { x: win.x, y: win.y } });
  const hits = mapped.filter((m) => contains(m.rect, point)).sort((a, b) => area(a.rect) - area(b.rect) || b.el.depth - a.el.depth);
  return done(targetFrom(point, win, hits[0], hits[0] ? "ax" : "coords"), win.id);
}

// Chromium's own chrome scales by its device scale factor (D13); every other toolkit ignores `c`,
// so only a Chromium window is worth a CDP round trip.
async function chromeScale(deps: PerceptionDeps, win: HelperWindow): Promise<number> {
  if (appToolkit(win.cls) !== "chromium" || !deps.cdp) return deps.scale;
  return deps.cdp.deviceScaleFactor(win).catch(() => deps.scale);
}

export async function findTarget(deps: PerceptionDeps, req: FindRequest): Promise<HitTestResult> {
  const t0 = performance.now();
  const wanted = req.name.toLowerCase();
  const windows = (await listWindows(deps.x)).filter((w) => !DECOR_CLASSES.has(w.cls) && (!req.app || w.cls.toLowerCase() === req.app.toLowerCase()));
  const g = await deps.readScaling();
  for (const win of windows) {
    const left = FIND_BUDGET_MS - (performance.now() - t0);
    if (left <= 0) break;
    if (appToolkit(win.cls) === "chromium" && deps.cdp) {
      const web = await deps.cdp.find(win, req).catch(() => null);
      if (web) return { target: web, window: win.id, ms: Math.round(performance.now() - t0) };
      continue;
    }
    const state = await deps.driver.windowState(win.pid, win.id, Math.min(TREE_TIMEOUT_MS, left));
    const mapped = mapTree(state.elements, win.cls, { g, c: deps.scale, windowOrigin: { x: win.x, y: win.y } });
    const match = mapped.find((m) => (m.el.label ?? "").toLowerCase() === wanted && (!req.role || m.el.role === req.role)) ?? mapped.find((m) => (m.el.label ?? "").toLowerCase().startsWith(wanted) && (!req.role || m.el.role === req.role));
    if (match) {
      const point = { x: Math.round(match.rect.x + match.rect.w / 2), y: Math.round(match.rect.y + match.rect.h / 2) };
      return { target: targetFrom(point, win, match, "ax"), window: win.id, ms: Math.round(performance.now() - t0) };
    }
  }
  return { target: null, window: null, ms: Math.round(performance.now() - t0) };
}
```
(`cdp.ts` arrives in Task 8; until then create it with only the type the import needs:)
```ts
// cells/desktop/desktopd/src/perception/cdp.ts (Task 7 stub; Task 8 replaces it)
import type { FindRequest, Point, Target } from "@localdot/protocol";
import type { HelperWindow } from "./hit-test.ts";

export interface ChromiumPerception {
  hitTest(win: HelperWindow, point: Point): Promise<Target | null>;
  find(win: HelperWindow, req: FindRequest): Promise<Target | null>;
  deviceScaleFactor(win: HelperWindow): Promise<number>;
}
```

`cells/desktop/desktopd/src/perception/observe.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { observe } from "./observe.ts";

describe("observe", () => {
  it("encodes the driver's PNG to WebP, and reports the pointer and the windows", async () => {
    const png = Buffer.from("png-bytes");
    const calls: string[] = [];
    const result = await observe({
      driver: { desktopShot: async () => png } as never,
      x: { call: async (cmd: string) => (cmd === "pointer" ? { x: 640, y: 400 } : { windows: [{ id: 5, pid: 50, cls: "Thunar", title: "Home", x: 1, y: 78, w: 100, h: 50, frame: [0, 54, 102, 75], active: true }] }) } as never,
      encode: async (input) => {
        calls.push(input.toString());
        return Buffer.from("RIFF....WEBP");
      },
    });
    expect(calls).toEqual(["png-bytes"]);
    expect(result).toMatchObject({ width: 1280, height: 800, pointer: { x: 640, y: 400 } });
    expect(Buffer.from(result.image, "base64").toString()).toBe("RIFF....WEBP");
    expect(result.windows[0]).toEqual({ id: 5, pid: 50, cls: "Thunar", title: "Home", rect: { x: 1, y: 78, w: 100, h: 50 }, frame: { x: 0, y: 54, w: 102, h: 75 }, active: true });
    expect(result.frameId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
```

`cells/desktop/desktopd/src/perception/observe.ts`:
```ts
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { clipText, type ObserveResult, ulid, type WindowInfo } from "@localdot/protocol";
import type { XHelper } from "../x/helper.ts";
import type { CuaDriver } from "./driver.ts";
import { type HelperWindow, listWindows } from "./hit-test.ts";

const run = promisify(execFile);
const SHM = "/dev/shm";

export interface ObserveDeps {
  driver: Pick<CuaDriver, "desktopShot">;
  x: XHelper;
  encode?: (png: Buffer) => Promise<Buffer>;
}

// cwebp (Ubuntu's webp package) through tmpfs: the driver's PNG in, WebP q80 out.
export async function encodeWebp(png: Buffer, tmp = SHM): Promise<Buffer> {
  const id = ulid();
  const input = join(tmp, `localdot-${id}.png`);
  const output = join(tmp, `localdot-${id}.webp`);
  try {
    await writeFile(input, png);
    await run("cwebp", ["-quiet", "-q", "80", input, "-o", output]);
    return await readFile(output);
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
}

export function windowInfo(w: HelperWindow): WindowInfo {
  return { id: w.id, pid: w.pid, cls: clipText(w.cls, 128), title: clipText(w.title, 256), rect: { x: w.x, y: w.y, w: w.w, h: w.h }, frame: { x: w.frame[0], y: w.frame[1], w: w.frame[2], h: w.frame[3] }, active: w.active };
}

export async function observe(deps: ObserveDeps): Promise<ObserveResult> {
  const [png, pointer, windows] = await Promise.all([
    deps.driver.desktopShot(1280),
    deps.x.call<{ x: number; y: number }>("pointer"),
    listWindows(deps.x),
  ]);
  const webp = await (deps.encode ?? encodeWebp)(png);
  return { frameId: ulid(), width: 1280, height: 800, image: webp.toString("base64"), pointer: { x: pointer.x, y: pointer.y }, windows: windows.map(windowInfo) };
}
```

`cells/desktop/desktopd/src/perception/find.ts` (the driver fallback injector lives beside the
perception code because it needs the window under the point; clicks and typed text only, P3-C9):
```ts
import type { InputRequest, TypeRequest } from "@localdot/protocol";
import type { DriverInjector } from "../input.ts";
import type { XHelper } from "../x/helper.ts";
import type { CuaDriver } from "./driver.ts";
import { DECOR_CLASSES, type HelperWindow, listWindows, windowUnder } from "./hit-test.ts";

async function deliveryWindow(x: XHelper, point?: { x: number; y: number }, id?: number): Promise<HelperWindow> {
  const windows = await listWindows(x);
  const win = (id !== undefined ? windows.find((w) => w.id === id) : undefined) ?? (point && windowUnder(windows, point)) ?? windows.find((w) => w.active && !DECOR_CLASSES.has(w.cls)) ?? windows.find((w) => !DECOR_CLASSES.has(w.cls));
  if (!win) throw new Error("no window to deliver to");
  return win;
}

export function driverInjector(driver: CuaDriver, x: XHelper): DriverInjector {
  return {
    async click(req: InputRequest) {
      if (req.input.kind !== "click") throw new Error(`the driver injector does not deliver ${req.input.kind}`);
      const win = await deliveryWindow(x, req.input.at, req.window);
      await driver.click(win.pid, win.id, req.input.at, req.input.button, req.input.count);
    },
    async type(req: TypeRequest) {
      const win = await deliveryWindow(x, undefined, req.window);
      await driver.typeText(win.pid, win.id, req.text);
    },
  };
}
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src/perception`
Expected: mapping, hit-test and observe tests pass.

- [ ] **Step 5: Routes and wiring**

`cells/desktop/desktopd/src/app.ts` — add to `DesktopdDeps`:
```ts
  perception?: PerceptionDeps;
```
(import `type PerceptionDeps`, `hitTest`, `findTarget` from `./perception/hit-test.ts`, `observe`
from `./perception/observe.ts`, `HitTestRequest`, `FindRequest` from `@localdot/protocol`) and the routes:
```ts
  const withPerception = (fn: (p: PerceptionDeps) => Promise<Response>) => async () => {
    if (!deps.perception || !deps.x?.alive) return new Response("perception not available", { status: 503 });
    try {
      return await fn(deps.perception);
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: statusOf(err) });
    }
  };

  app.post("/observe", (c) => withPerception(async (p) => c.json(await observe({ driver: p.driver, x: p.x })))());

  app.post("/hitTest", async (c) =>
    withPerception(async (p) => {
      const parsed = HitTestRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      return c.json(await hitTest(p, parsed.data.point));
    })(),
  );

  app.post("/find", async (c) =>
    withPerception(async (p) => {
      const parsed = FindRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      return c.json(await findTarget(p, parsed.data));
    })(),
  );
```
`cells/desktop/desktopd/src/main.ts` — build the driver and the perception deps (Part 2's `uid` and
`readXsettings: () => readXsettings(uid)` stay as Task 4 kept them):
```ts
import { CuaDriver } from "./perception/driver.ts";
import { driverInjector } from "./perception/find.ts";
import type { PerceptionDeps } from "./perception/hit-test.ts";
// ...
const driver = new CuaDriver(CuaDriver.defaultOptions());
// The session's window scaling: unknown while the session comes up (the cell's scale stands in),
// XFCE's default 1 when unset.
const scaling = async () => {
  const settings = await readXsettings(uid);
  return settings === null ? scale : (settings.windowScalingFactor ?? 1);
};
const app = createDesktopdApp({
  token,
  scale,
  display: process.env.DISPLAY ?? ":1",
  readXsettings: () => readXsettings(uid),
  readScreen,
  get x() {
    return x;
  },
  launch: (req) => launchApp(req, process.env),
  clockMono: monoNow,
  get perception(): PerceptionDeps | undefined {
    return x ? { x, driver, scale, readScaling: scaling } : undefined;
  },
  get injectors() {
    return x ? { xtest: true as const, driver: driverInjector(driver, x) } : { xtest: true as const };
  },
});
```
`apps/daemon/src/cells/testing/desktop-container.ts` — add `import { spawnSync } from "node:child_process";`
to the top of its import block, and append:
```ts
export function copyIntoDesktop(name: string, path: string, bytes: Buffer): void {
  const r = spawnSync("docker", ["exec", "-i", name, "sh", "-c", `cat > ${path}`], { input: bytes });
  if (r.status !== 0) throw new Error(`copy into ${name}:${path} failed: ${String(r.stderr)}`);
}
```

`cells/desktop/desktopd/build.mjs` (replace the whole file) — the bundle now carries the MCP SDK,
`ws`, `zod` and what they pull in, and Part 2's Task 5 ruling puts every bundled package's notice in
the bundle's header and in `THIRD-PARTY.md`; a fixed list would drift, so the list comes from
esbuild's own inputs:
```js
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const options = {
  absWorkingDir: here,
  entryPoints: [join(here, "src/main.ts")],
  outfile: join(here, "dist/desktopd.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
};

// The bundle carries copies of these packages, so it carries their notices too: every package
// esbuild read an input from, each with its license file (a package without one stops the build).
const { metafile } = await build({ ...options, write: false, metafile: true, logLevel: "silent" });
const roots = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) roots.add(resolve(here, m[1]));
}
const notices = [...roots]
  .map((root) => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const file = readdirSync(root).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
    if (!file) throw new Error(`${pkg.name} ${pkg.version} has no license file to bundle`);
    const text = readFileSync(join(root, file), "utf8").replaceAll("*/", "* /");
    return { name: pkg.name, notice: `${pkg.name} ${pkg.version} (${pkg.license})\n\n${text}` };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
console.log(`desktopd bundles ${notices.length} packages: ${notices.map((n) => n.name).join(", ")}`);
await build({
  ...options,
  logLevel: "info",
  banner: {
    js: `/*!\n${notices.map((n) => n.notice).join("\n")}*/\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});
```
`cells/desktop/THIRD-PARTY.md` — the two rows for Hono and `@hono/node-server` become one row per
package the build lists, each "bundled into `/opt/localdot/desktopd.mjs`, license in its header":

```markdown
| @hono/node-server | 2.1.3 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| @modelcontextprotocol/sdk | 1.31.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ajv | 8.20.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ajv-formats | 3.0.1 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| cross-spawn | 7.0.6 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| fast-deep-equal | 3.1.3 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| fast-uri | 3.1.8 | BSD-3-Clause | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| Hono | 4.13.12 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| isexe | 2.0.0 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| json-schema-traverse | 1.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| path-key | 3.1.1 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| shebang-command | 2.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| shebang-regex | 3.0.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| which | 2.0.2 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| ws | 8.22.0 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| zod | 4.6.5 | MIT | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
| zod-to-json-schema | 3.25.2 | ISC | bundled into `/opt/localdot/desktopd.mjs`, license in its header |
```

Run: `pnpm exec vitest run cells/desktop/desktopd/src && pnpm --filter @localdot/desktopd build && cells/desktop/build.sh`
Expected: tests pass; the build prints `desktopd bundles 17 packages: …` with the packages above;
the bundle includes the MCP SDK (esbuild reports about 1.4 MB); the image rebuilds its last layer.

- [ ] **Step 6: Docker test — perception against real apps**

`apps/daemon/src/cells/desktopd-perception.docker.test.ts`:
```ts
import type { HitTestResult, ObserveResult } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyIntoDesktop, type DesktopContainer, execAsDesktopUser, startDesktopContainer, windowGeometry } from "./testing/desktop-container.ts";
import { DOCKER_TESTS, dockerExec, removeAll, sleepSync, waitFor } from "./testing/docker-cli.ts";

const C = "localdot-test-perception";
let cell: DesktopContainer;
const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${cell.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

describe.skipIf(!DOCKER_TESTS)("desktopd perception at 2x", () => {
  beforeAll(async () => {
    cell = startDesktopContainer(C, 2);
    await post("/launch", { app: "terminal" });
    waitFor("terminal", () => windowGeometry(C, "xfce4-terminal") !== undefined, 30_000);
    sleepSync(2000);
  });
  afterAll(() => removeAll({ containers: [C] }));

  it("hit-tests the terminal's File menu through the GTK mapping", async () => {
    const g = windowGeometry(C, "xfce4-terminal");
    if (!g) throw new Error("no terminal");
    const point = { x: g.x + 40, y: g.y + 26 };
    const hit = await post<HitTestResult>("/hitTest", { point });
    expect(hit.window).toBe(g.id);
    expect(hit.target).toMatchObject({ source: "ax", role: "menu", name: "File", app: "Xfce4-terminal" });
    const b = hit.target?.bbox;
    if (!b) throw new Error("no bbox");
    expect(point.x).toBeGreaterThanOrEqual(b.x);
    expect(point.x).toBeLessThan(b.x + b.w);
    expect(point.y).toBeGreaterThanOrEqual(b.y);
    expect(point.y).toBeLessThan(b.y + b.h);
    expect(b.h).toBe(54);
    expect(hit.ms).toBeLessThan(2500);
  });

  it("observes a 1280x800 WebP with the pointer and the windows", async () => {
    const o = await post<ObserveResult>("/observe", {});
    const bytes = Buffer.from(o.image, "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
    copyIntoDesktop(C, "/tmp/observe.webp", bytes);
    const identify = dockerExec(C, "identify", "-format", "%m %wx%h", "/tmp/observe.webp");
    expect(identify.status, identify.out).toBe(0);
    expect(identify.out).toBe("WEBP 1280x800");
    expect(o.windows.some((w) => w.cls === "Xfce4-terminal" && w.pid > 0)).toBe(true);
    expect(o.pointer.x).toBeGreaterThanOrEqual(0);
  });

  it("finds Calc's Name Box (GTK-drawn) and places a VCL-drawn sheet tab near the bottom", async () => {
    await post("/launch", { app: "calc" });
    waitFor("calc", () => windowGeometry(C, "libreoffice") !== undefined, 90_000);
    sleepSync(8000);
    const g = windowGeometry(C, "libreoffice");
    if (!g) throw new Error("no calc");
    const nameBox = await post<HitTestResult>("/find", { name: "Name Box" });
    expect(nameBox.target).toMatchObject({ source: "ax", app: expect.stringMatching(/libreoffice|Soffice/i) });
    expect(nameBox.target?.bbox?.w).toBeGreaterThan(50);
    const again = await post<HitTestResult>("/hitTest", { point: nameBox.target?.point });
    expect(again.target?.name).toBe(nameBox.target?.name);
    const tab = await post<HitTestResult>("/find", { name: "Sheet1", role: "page tab" });
    const b = tab.target?.bbox;
    if (!b) throw new Error("no sheet tab");
    expect(b.y).toBeGreaterThan(g.y + g.h * 0.8);
    expect(b.y + b.h).toBeLessThanOrEqual(g.y + g.h);
    // Use the found Name Box for real: click it, type B2, Enter — Calc's current cell must become B2.
    await post("/input", { input: { kind: "click", button: "left", count: 1, at: nameBox.target?.point }, window: nameBox.window });
    await post("/type", { text: "B2", masked: false, pace: { firstMs: 20, firstCount: 60, restMs: 6 } });
    await post("/input", { input: { kind: "key", combo: ["Return"] } });
    sleepSync(1000);
    const after = await post<HitTestResult>("/find", { name: "Name Box" });
    expect(after.target).toBeDefined();
    const value = execAsDesktopUser(C, "/usr/bin/python3", "-c", "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi\nd=Atspi.get_desktop(0)\n" +
      "def walk(n,depth=0):\n    for i in range(min(n.get_child_count(),400)):\n        c=n.get_child_at_index(i)\n        if c is None: continue\n        if c.get_name()=='Name Box' and c.get_role_name()=='text':\n            print(c.get_text_iface().get_text(0,-1)); return True\n        if depth<12 and walk(c,depth+1): return True\n    return False\n" +
      "[walk(d.get_child_at_index(i)) for i in range(d.get_child_count()) if 'soffice' in (d.get_child_at_index(i).get_name() or '').lower()]");
    expect(value.status, value.out).toBe(0);
    expect(value.out.trim()).toBe("B2");
  });
});
```

Run:
```bash
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktopd-perception.docker.test.ts
```
Expected: 3 tests pass in about 4 minutes.

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages/protocol cells/desktop apps/daemon/src/cells pnpm-lock.yaml
git commit -m "feat(desktopd): perception through Cua Driver with per-toolkit mapping, observe, hitTest and find"
```

---
### Task 7b: The driver's opt-outs on the wire

A Part 2 obligation, in its own unit (P3-C10): the image sets `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`
and `CUA_DRIVER_RS_UPDATE_CHECK=0`; this proves on the wire that the driver then sends nothing.
A CONNECT-logging proxy on the host receives every outbound TLS attempt of a container started with
`HTTPS_PROXY`; a control run with the opt-outs removed must show telemetry or update traffic, or
the method proves nothing (P3-C5). The proxy runs in a worker thread: the test's Docker helpers
block its own thread (`spawnSync`) for the whole driver run, so a proxy there could not answer
until the run was over (Part 2's Task 1 ruling).

**Files:**
- Create: `apps/daemon/src/cells/driver-optout.docker.test.ts`
- Test: `apps/daemon/src/cells/driver-optout.docker.test.ts`

**Interfaces:**
- Consumes: `docker`, `dockerExecAs`, `removeAll`, `sleepSync`, `waitFor` (`testing/docker-cli.ts`, Part 2), `DESKTOP_IMAGE` (`testing/desktop-container.ts`).
- Produces: nothing new; a documented limitation if the control run cannot see the driver's traffic.

- [ ] **Step 1: The proxy, the control run and the opt-out run**

`apps/daemon/src/cells/driver-optout.docker.test.ts`:
```ts
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESKTOP_IMAGE } from "./testing/desktop-container.ts";
import { DOCKER_TESTS, docker, dockerExecAs, removeAll, sleepSync, waitFor } from "./testing/docker-cli.ts";

// A CONNECT-logging proxy on 127.0.0.1:4798: every outbound TLS attempt from a container that honours
// HTTPS_PROXY shows up as a "CONNECT host:443" line. The driver is Rust/reqwest, which honours the
// variable; the control run proves the method before the opt-out run is trusted. The proxy answers
// from its own thread, because runDriver's Docker calls block this one (spawnSync) while the driver
// runs, and keeps its log until asked for it.
const PROXY_PORT = 4798;
const PROXY = `const { parentPort } = require("node:worker_threads");
const connects = [];
const server = require("node:net").createServer((socket) => {
  socket.once("data", (d) => {
    connects.push(String(d).split("\\r\\n")[0] ?? "");
    socket.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
  });
  socket.on("error", () => {});
});
parentPort.on("message", () => parentPort.postMessage(connects.splice(0)));
server.listen(${PROXY_PORT}, "127.0.0.1", () => parentPort.postMessage("listening"));
`;
let proxy: Worker;

// The CONNECT lines logged since the last call.
async function connectsSince(): Promise<string[]> {
  proxy.postMessage("read");
  const [lines] = await once(proxy, "message");
  return lines as string[];
}

function runDriver(name: string, env: Record<string, string>): string {
  removeAll({ containers: [name] });
  const flags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  docker("run", "-d", "--name", name, "--shm-size=1g", "--cap-drop", "NET_RAW", "-e", `HTTPS_PROXY=http://host.docker.internal:${PROXY_PORT}`, "-e", `HTTP_PROXY=http://host.docker.internal:${PROXY_PORT}`, "-e", "LOCALDOT_DESKTOPD_TOKEN=x".padEnd(60, "x"), ...flags, DESKTOP_IMAGE);
  waitFor("panel", () => dockerExecAs(name, "abc", "pgrep", "-x", "xfce4-panel").status === 0, 180_000);
  sleepSync(3000);
  const run = dockerExecAs(name, "abc", "env", "DISPLAY=:1", "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus", "sh", "-c", "timeout 20 cua-driver doctor; timeout 20 cua-driver telemetry status; printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"0\"}}}\\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"list_windows\",\"arguments\":{}}}\\n' | timeout 20 cua-driver mcp --no-overlay | head -c 20000");
  expect(run.status, run.out).toBe(0);
  sleepSync(5000);
  return run.out;
}

// The driver's JSON-RPC replies among the run's output lines.
const replies = (out: string) =>
  out.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }];
    } catch {
      return [];
    }
  });

describe.skipIf(!DOCKER_TESTS)("Cua Driver telemetry and update checks are off on the wire", () => {
  beforeAll(async () => {
    proxy = new Worker(PROXY, { eval: true });
    await once(proxy, "message");
  });
  afterAll(async () => {
    removeAll({ containers: ["localdot-test-optout-control", "localdot-test-optout"] });
    await proxy?.terminate();
  });

  it("control: with the opt-outs removed the driver tries to phone home through the proxy", async () => {
    runDriver("localdot-test-optout-control", { CUA_DRIVER_RS_TELEMETRY_ENABLED: "1", CUA_DRIVER_RS_UPDATE_CHECK: "1" });
    const connects = await connectsSince();
    const outbound = connects.filter((l) => /posthog|github/i.test(l));
    expect(outbound.length, `control run saw no telemetry or update traffic (${connects.join(" | ")}): the proxy method cannot confirm the opt-out; trace the driver with strace in a container with CAP_SYS_PTRACE instead`).toBeGreaterThan(0);
  });

  it("with the image's opt-outs the driver sends nothing", async () => {
    const out = runDriver("localdot-test-optout", {});
    // The driver ran for real: it answered the list_windows call (JSON-RPC id 2) with a result.
    expect(replies(out).find((r) => r.id === 2)?.result, out).toBeDefined();
    expect((await connectsSince()).filter((l) => /posthog|github/i.test(l))).toEqual([]);
  });
});
```


Run:
```bash
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/driver-optout.docker.test.ts
```
Expected: 2 tests pass in about 2 minutes. If the control run's assertion fails, the opt-out cannot
be confirmed by this method: record that in the commit message and in SUMMARY-style notes for the
user, and keep the test (it then documents the limitation by failing loudly rather than passing
vacuously).

- [ ] **Step 2: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells/driver-optout.docker.test.ts
git commit -m "test(cells): prove the driver's telemetry and update-check opt-outs on the wire"
```

---
### Task 8: Chromium web content through CDP, the marker test, and the driver's calibration rows

Web-content boxes come from Chromium's DevTools protocol (D13): `DOM.getNodeForLocation` at the
point in CSS pixels, `DOM.getBoxModel` for the box, `Accessibility.getPartialAXTree` for role and
name, `DOM.describeNode` for `type=password`. The content area's device origin is the X window's
client origin plus Chromium's own chrome height (`outerHeight − innerHeight`, in CSS px × the
device scale factor), which this task measures with a marker page. `find` uses
`Accessibility.queryAXTree`. The driver injector exists since Task 7, so the calibration's driver
rows are measured here.

**Files:**
- Create: `cells/desktop/root/opt/localdot/marker.html`
- Modify: `cells/desktop/desktopd/src/perception/cdp.ts` (replaces the Task 7 stub),
  `cells/desktop/desktopd/src/main.ts`, `docs/measurements/2026-10-ring-onset.md`
- Test: `cells/desktop/desktopd/src/perception/cdp.test.ts`, `apps/daemon/src/cells/desktopd-cdp.docker.test.ts`

**Interfaces:**
- Consumes: `HelperWindow`, `PerceptionDeps.cdp` (Task 7); `ws`.
- Produces: `class ChromiumPerception { constructor({ port?, WebSocketImpl?, fetchImpl? }); hitTest(win, point); find(win, req); deviceScaleFactor(win); close() }`
  (the class takes the place of the Task 7 stub's interface of the same name, so `PerceptionDeps.cdp`
  keeps its type), `contentOrigin(win, metrics): Point`, `quadToRect(quad: number[], origin: Point, dpr: number): Rect`,
  `pickTarget(targets, win): PageTarget | undefined`, `CdpSession` (`closed` once its socket closes;
  `ChromiumPerception` then opens a new session for that page).

- [ ] **Step 1: Pure helpers and the session, test first**

`cells/desktop/desktopd/src/perception/cdp.test.ts`:
```ts
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ChromiumPerception, contentOrigin, pickTarget, quadToRect } from "./cdp.ts";
import type { HelperWindow } from "./hit-test.ts";

const win: HelperWindow = { id: 9, pid: 90, cls: "Chromium", title: "S2 marker - Chromium", x: 0, y: 54, w: 2560, h: 1546, frame: [0, 54, 2560, 1546], active: true };

describe("pure CDP geometry", () => {
  it("places the content area below Chromium's own chrome, centred horizontally", () => {
    expect(contentOrigin(win, { dpr: 2, chromeW: 0, chromeH: 87 })).toEqual({ x: 0, y: 54 + 174 });
    expect(contentOrigin({ ...win, x: 20, y: 74, w: 2100 }, { dpr: 2, chromeW: 16, chromeH: 87 })).toEqual({ x: 36, y: 248 });
  });

  it("turns a border quad in CSS px into a device-pixel rect", () => {
    expect(quadToRect([40, 100, 160, 100, 160, 140, 40, 140], { x: 0, y: 228 }, 2)).toEqual({ x: 80, y: 428, w: 240, h: 80 });
  });

  it("picks the page target whose title matches the window title", () => {
    const targets = [
      { id: "a", type: "page", title: "Other", url: "x", webSocketDebuggerUrl: "ws://a" },
      { id: "b", type: "page", title: "S2 marker", url: "y", webSocketDebuggerUrl: "ws://b" },
    ];
    expect(pickTarget(targets, win)?.id).toBe("b");
    expect(pickTarget(targets, { ...win, title: "Nothing - Chromium" })?.id).toBe("a");
  });
});

describe("ChromiumPerception against a scripted DevTools endpoint", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  async function scriptedChromium(answers: Record<string, (params: Record<string, unknown>) => unknown>) {
    const http = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "p1", type: "page", title: "S2 marker", url: "file:///opt/localdot/marker.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/p1` }]));
    });
    const port = await new Promise<number>((r) => http.listen(0, "127.0.0.1", () => r((http.address() as { port: number }).port)));
    const wss = new WebSocketServer({ server: http });
    const seen: string[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> };
        seen.push(msg.method);
        const fn = answers[msg.method];
        ws.send(JSON.stringify(fn ? { id: msg.id, result: fn(msg.params) } : { id: msg.id, error: { message: `no ${msg.method}` } }));
      });
    });
    close = () => new Promise<void>((r) => http.close(() => r()));
    // The page's side ends every DevTools socket, as a navigation or a crash does.
    const drop = () => {
      for (const client of wss.clients) client.terminate();
    };
    return { port, seen, drop };
  }

  it("hit-tests a web element: box, role, name, url, and the password flag", async () => {
    const { port, seen } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": () => ({ result: { value: { dpr: 2, chromeW: 0, chromeH: 87, innerWidth: 1280, innerHeight: 686, url: "file:///opt/localdot/marker.html" } } }),
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.getNodeForLocation": (p) => ({ backendNodeId: 42, frameId: "f", nodeId: 7, ...(p.x === 100 ? {} : {}) }),
      "DOM.getBoxModel": () => ({ model: { border: [40, 100, 160, 100, 160, 140, 40, 140] } }),
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ role: { value: "textbox" }, name: { value: "Password" } }] }),
      "DOM.describeNode": () => ({ node: { attributes: ["type", "password", "name", "pw"] } }),
    });
    const cdp = new ChromiumPerception({ port });
    const target = await cdp.hitTest(win, { x: 200, y: 450 });
    expect(target).toMatchObject({ point: { x: 200, y: 450 }, source: "dom", role: "textbox", name: "Password", bbox: { x: 80, y: 428, w: 240, h: 80 }, url: "file:///opt/localdot/marker.html", secret: true, app: "Chromium" });
    expect(seen).toContain("DOM.getNodeForLocation");
    expect(await cdp.hitTest(win, { x: 200, y: 100 })).toBeNull();
    expect(seen.filter((m) => m === "Accessibility.enable")).toHaveLength(1);
    await cdp.close();
  });

  it("finds by accessible name through Accessibility.queryAXTree", async () => {
    const { port } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": () => ({ result: { value: { dpr: 2, chromeW: 0, chromeH: 87, innerWidth: 1280, innerHeight: 686, url: "u" } } }),
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "Accessibility.queryAXTree": (p) => ({ nodes: p.accessibleName === "marker green" ? [{ backendDOMNodeId: 5, role: { value: "button" }, name: { value: "marker green" } }] : [] }),
      "DOM.getBoxModel": () => ({ model: { border: [300, 100, 420, 100, 420, 140, 300, 140] } }),
      "DOM.describeNode": () => ({ node: { attributes: [] } }),
    });
    const cdp = new ChromiumPerception({ port });
    const found = await cdp.find(win, { name: "marker green", role: "button" });
    expect(found).toMatchObject({ role: "button", name: "marker green", bbox: { x: 600, y: 428, w: 240, h: 80 }, point: { x: 720, y: 468 } });
    expect(await cdp.find(win, { name: "nothing" })).toBeNull();
    await cdp.close();
  });

  it("opens a new session once the page's socket has closed", async () => {
    const { port, seen, drop } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": () => ({ result: { value: { dpr: 2, chromeW: 0, chromeH: 87, innerWidth: 1280, innerHeight: 686 } } }),
    });
    const cdp = new ChromiumPerception({ port });
    expect(await cdp.deviceScaleFactor(win)).toBe(2);
    drop();
    await new Promise((r) => setTimeout(r, 20));
    expect(await cdp.deviceScaleFactor(win)).toBe(2);
    expect(seen.filter((m) => m === "Accessibility.enable")).toHaveLength(2);
    await cdp.close();
  });
});
```

`cells/desktop/desktopd/src/perception/cdp.ts` (replace the stub; the class takes the stub
interface's name, so `hit-test.ts`'s `import type { ChromiumPerception }` now names the class):
```ts
import { clipText, type FindRequest, type Point, type Rect, type Target } from "@localdot/protocol";
import { WebSocket } from "ws";
import type { HelperWindow } from "./hit-test.ts";

export interface PageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface PageMetrics {
  dpr: number;
  chromeW: number;
  chromeH: number;
  innerWidth?: number;
  innerHeight?: number;
  url?: string;
}

// Chromium's content area in device pixels: the X client origin plus its own chrome (tab strip
// and toolbar) in CSS px × the device scale factor. With xfwm4's borderless maximize there is no
// WM frame; a restored window's title bar sits above the client origin and so is already excluded.
export function contentOrigin(win: HelperWindow, m: PageMetrics): Point {
  return { x: win.x + Math.round((m.chromeW / 2) * m.dpr), y: win.y + Math.round(m.chromeH * m.dpr) };
}

export function quadToRect(quad: number[], origin: Point, dpr: number): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: origin.x + Math.round(x0 * dpr), y: origin.y + Math.round(y0 * dpr), w: Math.round((Math.max(...xs) - x0) * dpr), h: Math.round((Math.max(...ys) - y0) * dpr) };
}

// The X window title is "<page title> - Chromium"; pick that page, else the first page target.
export function pickTarget(targets: PageTarget[], win: HelperWindow): PageTarget | undefined {
  const pages = targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  const title = win.title.replace(/ - Chromium$/, "");
  return pages.find((t) => t.title === title) ?? pages[0];
}

const METRICS = "({dpr: window.devicePixelRatio, chromeW: window.outerWidth - window.innerWidth, chromeH: window.outerHeight - window.innerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, url: location.href})";

export class CdpSession {
  #ws: WebSocket;
  #seq = 0;
  #closed = false;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  readonly ready: Promise<void>;

  constructor(url: string, WebSocketImpl: typeof WebSocket = WebSocket) {
    this.#ws = new WebSocketImpl(url);
    this.ready = new Promise((resolve, reject) => {
      this.#ws.once("open", () => resolve());
      this.#ws.once("error", (err) => reject(err));
    });
    // ws emits "error" again on a later socket failure; without a listener Node would throw it.
    this.#ws.on("error", () => undefined);
    this.#ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`cdp: ${msg.error.message}`));
      else p.resolve(msg.result);
    });
    this.#ws.on("close", () => {
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(new Error("cdp: connection closed"));
      this.#pending.clear();
    });
  }

  // A page that navigated away or crashed closes its socket; the session cannot be reused.
  get closed(): boolean {
    return this.#closed;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<T> {
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`cdp: ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.#ws.close();
  }
}

export class ChromiumPerception {
  readonly #port: number;
  readonly #fetchImpl: typeof fetch;
  readonly #WebSocketImpl: typeof WebSocket;
  #sessions = new Map<string, CdpSession>();

  constructor(opts: { port?: number; fetchImpl?: typeof fetch; WebSocketImpl?: typeof WebSocket } = {}) {
    this.#port = opts.port ?? 9222;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
  }

  async #session(win: HelperWindow): Promise<{ cdp: CdpSession; target: PageTarget }> {
    const res = await this.#fetchImpl(`http://127.0.0.1:${this.#port}/json/list`, { signal: AbortSignal.timeout(1500) });
    const targets = (await res.json()) as PageTarget[];
    const target = pickTarget(targets, win);
    if (!target) throw new Error("cdp: no page target");
    let cdp = this.#sessions.get(target.id);
    if (!cdp || cdp.closed) {
      cdp = new CdpSession(target.webSocketDebuggerUrl, this.#WebSocketImpl);
      await cdp.ready;
      // The Accessibility domain (getPartialAXTree, the experimental queryAXTree) answers only
      // after enable; once per session.
      await cdp.send("Accessibility.enable").catch(() => undefined);
      this.#sessions.set(target.id, cdp);
    }
    return { cdp, target };
  }

  async #metrics(cdp: CdpSession): Promise<PageMetrics> {
    const r = await cdp.send<{ result: { value: PageMetrics } }>("Runtime.evaluate", { expression: METRICS, returnByValue: true });
    return r.result.value;
  }

  async deviceScaleFactor(win: HelperWindow): Promise<number> {
    const { cdp } = await this.#session(win);
    return (await this.#metrics(cdp)).dpr;
  }

  async #describe(cdp: CdpSession, backendNodeId: number, win: HelperWindow, origin: Point, dpr: number, url: string | undefined, point?: Point, ax?: { role?: string; name?: string }): Promise<Target | null> {
    const box = await cdp.send<{ model: { border: number[] } }>("DOM.getBoxModel", { backendNodeId }).catch(() => null);
    if (!box) return null;
    const bbox = quadToRect(box.model.border, origin, dpr);
    let role = ax?.role;
    let name = ax?.name;
    if (!ax) {
      const tree = await cdp.send<{ nodes: { role?: { value: string }; name?: { value: string } }[] }>("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }).catch(() => ({ nodes: [] }));
      role = tree.nodes[0]?.role?.value;
      name = tree.nodes[0]?.name?.value;
    }
    const node = await cdp.send<{ node: { attributes?: string[] } }>("DOM.describeNode", { backendNodeId }).catch(() => ({ node: {} as { attributes?: string[] } }));
    const attrs = node.node.attributes ?? [];
    const secret = attrs.findIndex((a, i) => i % 2 === 0 && a === "type" && attrs[i + 1] === "password") >= 0;
    const centre = point ?? { x: Math.round(bbox.x + bbox.w / 2), y: Math.round(bbox.y + bbox.h / 2) };
    return {
      point: centre,
      bbox,
      source: "dom",
      ...(role ? { role: clipText(role, 64) } : {}),
      ...(name ? { name: clipText(name, 64) } : {}),
      app: clipText(win.cls, 128),
      window: clipText(win.title, 256),
      ...(url ? { url: clipText(url, 2048) } : {}),
      ...(secret ? { secret: true } : {}),
    };
  }

  async hitTest(win: HelperWindow, point: Point): Promise<Target | null> {
    const { cdp } = await this.#session(win);
    const m = await this.#metrics(cdp);
    const origin = contentOrigin(win, m);
    const css = { x: (point.x - origin.x) / m.dpr, y: (point.y - origin.y) / m.dpr };
    if (css.x < 0 || css.y < 0 || (m.innerWidth !== undefined && css.x >= m.innerWidth) || (m.innerHeight !== undefined && css.y >= m.innerHeight)) return null;
    await cdp.send("DOM.getDocument", { depth: 0 });
    const node = await cdp.send<{ backendNodeId: number }>("DOM.getNodeForLocation", { x: Math.round(css.x), y: Math.round(css.y), includeUserAgentShadowDOM: false }).catch(() => null);
    if (!node) return null;
    return this.#describe(cdp, node.backendNodeId, win, origin, m.dpr, m.url, point);
  }

  async find(win: HelperWindow, req: FindRequest): Promise<Target | null> {
    const { cdp } = await this.#session(win);
    const m = await this.#metrics(cdp);
    const origin = contentOrigin(win, m);
    const doc = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const q = await cdp.send<{ nodes: { backendDOMNodeId: number; role?: { value: string }; name?: { value: string } }[] }>("Accessibility.queryAXTree", { nodeId: doc.root.nodeId, accessibleName: req.name, ...(req.role ? { role: req.role } : {}) }).catch(() => ({ nodes: [] }));
    const hit = q.nodes[0];
    if (!hit) return null;
    return this.#describe(cdp, hit.backendDOMNodeId, win, origin, m.dpr, m.url, undefined, { role: hit.role?.value, name: hit.name?.value });
  }

  async close(): Promise<void> {
    for (const s of this.#sessions.values()) s.close();
    this.#sessions.clear();
  }
}
```
`cells/desktop/desktopd/src/main.ts` — add `cdp: new ChromiumPerception()` to the perception deps
(import from `./perception/cdp.ts`).

Run: `pnpm exec vitest run cells/desktop/desktopd/src/perception/cdp.test.ts cells/desktop/desktopd/src/perception/hit-test.test.ts`
Expected: 13 tests pass (cdp 6, hit-test 7).

- [ ] **Step 2: The marker page and the Docker test**

`cells/desktop/root/opt/localdot/marker.html`:
```html
<!doctype html>
<meta charset="utf-8">
<title>S2 marker</title>
<style>
  html, body { margin: 0; background: #fff; }
  button { position: absolute; width: 120px; height: 40px; border: 0; padding: 0; color: transparent; }
  #r { left: 40px; top: 100px; background: #f00; }
  #g { left: 300px; top: 100px; background: #0f0; }
  #b { left: 560px; top: 100px; background: #00f; }
  input { position: absolute; left: 40px; top: 200px; width: 200px; height: 30px; }
</style>
<button type="button" id="r" aria-label="marker red">red</button>
<button type="button" id="g" aria-label="marker green">green</button>
<button type="button" id="b" aria-label="marker blue">blue</button>
<label><input id="pw" type="password" aria-label="Password" placeholder="Password"></label>
```

`apps/daemon/src/cells/desktopd-cdp.docker.test.ts`:
```ts
import type { HitTestResult } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopContainer, execAsDesktopUser, startDesktopContainer, windowGeometry } from "./testing/desktop-container.ts";
import { DOCKER_TESTS, dockerExec, removeAll, sleepSync, waitFor } from "./testing/docker-cli.ts";

const C = "localdot-test-cdp";
let cell: DesktopContainer;
const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${cell.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

// ImageMagick: paint everything but the colour white, the colour black, and read the trim box.
function pixelBox(colour: string): { x: number; y: number; w: number; h: number } {
  expect(execAsDesktopUser(C, "sh", "-c", "import -window root /tmp/shot.png").status).toBe(0);
  const trim = dockerExec(C, "convert", "/tmp/shot.png", "-fuzz", "8%", "-fill", "white", "+opaque", colour, "-fill", "black", "-opaque", colour, "-format", "%@", "info:");
  expect(trim.status, trim.out).toBe(0);
  const out = trim.out.trim();
  const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(out);
  if (!m) throw new Error(`no trim box for ${colour}: ${out}`);
  return { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
}

const within = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, px: number) =>
  Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px && Math.abs(a.w - b.w) <= px && Math.abs(a.h - b.h) <= px;

describe.skipIf(!DOCKER_TESTS)("Chromium web content through CDP at 2x", () => {
  beforeAll(async () => {
    cell = startDesktopContainer(C, 2);
    await post("/launch", { app: "chromium", args: ["file:///opt/localdot/marker.html"] });
    waitFor("chromium", () => windowGeometry(C, "chromium") !== undefined, 60_000);
    sleepSync(5000);
  });
  afterAll(() => removeAll({ containers: [C] }));

  it("maps a web element's box within 1 px of its pixels, maximized", async () => {
    const red = pixelBox("rgb(255,0,0)");
    const point = { x: red.x + red.w / 2, y: red.y + red.h / 2 };
    const hit = await post<HitTestResult>("/hitTest", { point });
    expect(hit.target).toMatchObject({ source: "dom", role: "button", name: "marker red", url: "file:///opt/localdot/marker.html" });
    expect(hit.target?.bbox && within(hit.target.bbox, red, 1), JSON.stringify({ got: hit.target?.bbox, want: red })).toBe(true);
    expect(hit.ms).toBeLessThan(500);
  });

  it("still maps within 1 px after the window is restored", async () => {
    expect(execAsDesktopUser(C, "xdotool", "key", "alt+F10").status).toBe(0);
    sleepSync(2000);
    const g = windowGeometry(C, "chromium");
    expect(g?.w).toBeLessThan(2560);
    const blue = pixelBox("rgb(0,0,255)");
    const hit = await post<HitTestResult>("/hitTest", { point: { x: blue.x + blue.w / 2, y: blue.y + blue.h / 2 } });
    expect(hit.target?.name).toBe("marker blue");
    expect(hit.target?.bbox && within(hit.target.bbox, blue, 1), JSON.stringify({ got: hit.target?.bbox, want: blue })).toBe(true);
    expect(execAsDesktopUser(C, "xdotool", "key", "alt+F10").status).toBe(0);
    sleepSync(2000);
  });

  it("finds by accessible name and flags the password field", async () => {
    const green = pixelBox("rgb(0,255,0)");
    const found = await post<HitTestResult>("/find", { name: "marker green", role: "button" });
    expect(found.target?.bbox && within(found.target.bbox, green, 1)).toBe(true);
    const pw = await post<HitTestResult>("/find", { name: "Password" });
    expect(pw.target).toMatchObject({ secret: true });
    const typed = await post<HitTestResult>("/hitTest", { point: pw.target?.point });
    expect(typed.target?.secret).toBe(true);
  });
});
```
If the maximized check fails by a constant offset, the chrome-height assumption is wrong for this
Chromium build: print `hit.target.bbox` and `red`, and change `contentOrigin` to read the content
area's device origin from the driver's `document web` element instead (its frame equals raw AT-SPI
device px, exact in all six S2 marker cases): `perception.driver.windowState` → the element with
role `document web` → `frame` as the origin. The test is the arbiter; record which formula held in
the commit message.

Run: `cells/desktop/build.sh && LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktopd-cdp.docker.test.ts`
Expected: 3 tests pass.

- [ ] **Step 3: The driver's calibration rows (clicks only, P3-C9)**

The same two passes as Task 6 (the gate with the compositor off, then the table as users see it):
```bash
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor off --scale 2 --trials 500 --injectors driver --kinds click
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor on --scale 2 --trials 500 --injectors driver --kinds click
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor off --scale 1 --trials 500 --injectors driver --kinds click
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor on --scale 1 --trials 500 --injectors driver --kinds click
```
Expected: one `… driver click [gate, compositor off] … PASS` line per gate pass and one
`… driver click [table, compositor on] … → onset … ms` line per table pass; `~/.localdot/calibration.json`
gains the `driver.click` group from the table passes. Fill the two driver rows of both tables in
`docs/measurements/2026-10-ring-onset.md`.

- [ ] **Step 4: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add cells/desktop apps/daemon/src/cells docs/measurements
git commit -m "feat(desktopd): Chromium web-content boxes through CDP, verified against a marker page"
```

---
### Task 9: The action gateway — intent, target, travel, dispatch, settle, result

The gateway owns the timing (spec "Timing", "Clock", "One click, end to end"): it converts the
action's model coordinates to device pixels, appends `action.intent` with a seeded pointer plan
(start = intent + `120 ms ÷ speed`, Fitts travel, dwell `90 ms ÷ speed`), asks `desktopd` for the
target in parallel, waits for the planned press time, holds while a viewer's stream is stalled
(never while no viewer is attached), dispatches on `desktopd`, and appends `action.dispatch` with the raw-press time mapped to the
session clock and the ring onset from the policy. Then settle, observe (frame to a file), result.
Watch when a viewer is attached, Fast when none, Instant on request. Secrets are masked at the
source: a `type` action hit-tests the focused field first and asks `desktopd` to mask.

**Units.** The envelope `t`, `pressT` and `ringAt` are session microseconds. `PointerPlan.startsAt`
is session **milliseconds** (the renderer's unit, `microsToMs(t)`) and `durationMs` is a duration in
milliseconds; `@localdot/stage` samples with `pointerAt(plan, tMs)`.

**Files:**
- Create: `apps/daemon/src/gateway/ring-onset.ts`, `apps/daemon/src/gateway/text.ts`,
  `apps/daemon/src/gateway/frames.ts`, `apps/daemon/src/gateway/gateway.ts`
- Modify: `packages/protocol/src/events.ts` (one comment on `PointerPlan.startsAt`)
- Test: `apps/daemon/src/gateway/ring-onset.test.ts`, `apps/daemon/src/gateway/text.test.ts`,
  `apps/daemon/src/gateway/frames.test.ts`, `apps/daemon/src/gateway/gateway.test.ts`

**Interfaces:**
- Consumes: `DesktopdRegistry`, `ClockMap`, `OnsetTable`, `onsetKind`, `onsetMs` (Task 5); `EventLog.toSessionT`;
  `CellApi` (`get`, `subscribe`); `@localdot/stage` (`travelDurationMs`, `dwellMs`, `intentLeadMs`,
  `INSTANT_LEAD_MS`, `typingPaceMs`, `SETTLE_QUIET_MS`, `SETTLE_CAP_MS`); `@localdot/providers` `toDevice`;
  `clipText`, `keyDisplayName` (Task 7); `DesktopdClient.type(req, onProgress, signal)` (Task 5), so a
  Stop ends the typing as well as the wait.
- Produces: `RingOnsetPolicy { name: "keep" | "strict"; onset(input: RingOnsetInput): Promise<number> }`,
  `RingOnsetInput { pressT; injector; kind; scale; changeAt?: () => Promise<number | undefined> }`,
  `keepPolicy(table)`, `strictPolicy(table)`, `policyFromEnv(table, env?)` (`LOCALDOT_RING_ONSET`);
  `clickLabel`, `typeLabel`, `keyLabel`, `scrollLabel`, `clipTarget(target): Target`;
  `class FrameStore { constructor(home); save(sessionId, frameId, bytes): string; path(sessionId, frameId): string | undefined }`;
  `GuiAction` (verbs `click` with `point` in model px or `find`, `type`, `key`, `scroll`, `wait`; optional `label`, `speed: Speed | "auto"`),
  `ActionContext { sessionId; cellId; agent?; step?; signal? }`, `ActionOutcome { ok; frameId?; target?; error?; cancelled? }`,
  `GatewayDeps { eventLog; cells; registry; onset; ringOnset; frames; now(); sleep(ms, signal?); hitTestTimeoutMs? }`,
  `class ActionGateway { run(ctx, action): Promise<ActionOutcome>; observe(ctx): Promise<{ frameId; pointer }>; cursorOf(cellId): Point | undefined }`,
  `DEFAULT_AGENT = "main"`.

- [ ] **Step 1: Ring onset, labels and frames — tests, then code**

`apps/daemon/src/gateway/ring-onset.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_ONSET_TABLE } from "./onset-table.ts";
import { keepPolicy, policyFromEnv, strictPolicy } from "./ring-onset.ts";

describe("ring onset policies", () => {
  it("keep: press plus the injector's per-scale p99", async () => {
    const keep = keepPolicy(DEFAULT_ONSET_TABLE);
    expect(keep.name).toBe("keep");
    expect(await keep.onset({ pressT: 1_000_000, injector: "xtest", kind: "click", scale: 2 })).toBe(1_023_100);
    expect(await keep.onset({ pressT: 1_000_000, injector: "xtest", kind: "key", scale: 1 })).toBe(1_019_100);
  });

  it("strict: the first change at the point, capped by the p99 and never before the press", async () => {
    const strict = strictPolicy(DEFAULT_ONSET_TABLE);
    expect(await strict.onset({ pressT: 1_000_000, injector: "xtest", kind: "click", scale: 2 })).toBe(1_023_100);
    expect(await strict.onset({ pressT: 1_000_000, injector: "xtest", kind: "click", scale: 2, changeAt: async () => 1_009_000 })).toBe(1_009_000);
    expect(await strict.onset({ pressT: 1_000_000, injector: "xtest", kind: "click", scale: 2, changeAt: async () => 1_050_000 })).toBe(1_023_100);
    expect(await strict.onset({ pressT: 1_000_000, injector: "xtest", kind: "click", scale: 2, changeAt: async () => 999_000 })).toBe(1_000_000);
  });

  it("is chosen by LOCALDOT_RING_ONSET, keep by default", () => {
    expect(policyFromEnv(DEFAULT_ONSET_TABLE, {}).name).toBe("keep");
    expect(policyFromEnv(DEFAULT_ONSET_TABLE, { LOCALDOT_RING_ONSET: "strict" }).name).toBe("strict");
    expect(() => policyFromEnv(DEFAULT_ONSET_TABLE, { LOCALDOT_RING_ONSET: "soon" })).toThrow(/LOCALDOT_RING_ONSET/);
  });
});
```

`apps/daemon/src/gateway/ring-onset.ts`:
```ts
import { type Injector, msToMicros } from "@localdot/protocol";
import { type OnsetKind, type OnsetTable, onsetMs } from "./onset-table.ts";

export interface RingOnsetInput {
  pressT: number;
  injector: Injector;
  kind: OnsetKind;
  scale: 1 | 2;
  // Session microseconds of the first screen change at the dispatch point, when the policy wants it.
  changeAt?: () => Promise<number | undefined>;
}

// Success criterion 3 (A1) is pending the user's sign-off between these two; the gateway only ever
// sees this interface, so switching is a one-line change in main.ts.
export interface RingOnsetPolicy {
  readonly name: "keep" | "strict";
  onset(input: RingOnsetInput): Promise<number>;
}

const latest = (table: OnsetTable, i: RingOnsetInput) => i.pressT + msToMicros(onsetMs(table, i.injector, i.kind, i.scale));

// keep: the ring means "input delivered" and starts at the raw press plus that injector's p99 (A8).
export function keepPolicy(table: OnsetTable): RingOnsetPolicy {
  return { name: "keep", onset: async (i) => latest(table, i) };
}

// strict: the ring starts on the first frame that changes at the dispatch point, with the p99 as
// the timeout; it needs desktopd's change-at-point report (see "What changes for strict" below).
export function strictPolicy(table: OnsetTable): RingOnsetPolicy {
  return {
    name: "strict",
    onset: async (i) => {
      const cap = latest(table, i);
      const change = i.changeAt ? await i.changeAt() : undefined;
      return change === undefined ? cap : Math.max(i.pressT, Math.min(change, cap));
    },
  };
}

export function policyFromEnv(table: OnsetTable, env: NodeJS.ProcessEnv = process.env): RingOnsetPolicy {
  const name = env.LOCALDOT_RING_ONSET ?? "keep";
  if (name === "keep") return keepPolicy(table);
  if (name === "strict") return strictPolicy(table);
  throw new RangeError(`LOCALDOT_RING_ONSET must be keep or strict, got ${name}`);
}
```

**What changes if the user picks "strict" (A1):** (1) `desktopd` gains `POST /change-at
{ point, sinceMono, timeoutMs }` that answers with the `mono` of the first damage rectangle
containing the point after `sinceMono` (the helper's `Damage.rects` already carry timestamps once
`add()` keeps them; one more command, `change_at`, ~15 lines of Python); (2) the gateway passes
`changeAt: () => registry.client.changeAt({ point, sinceMono: pressMono, timeoutMs: onsetMs })`
mapped through the clock map into `RingOnsetInput`, so `action.dispatch` is appended up to one
p99 (≤ 30 ms) later than today; (3) `main.ts` sets `LOCALDOT_RING_ONSET=strict` by default; (4) the
pixel-oracle rule (Task 16) becomes "no ring frame before the frame that shows the change at the
point" with the p99 timeout keeping the "keep" rule as the fallback. Nothing in the renderer or the
schema changes.

`apps/daemon/src/gateway/text.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { clickLabel, clipTarget, keyLabel, scrollLabel, typeLabel } from "./text.ts";

describe("gateway labels", () => {
  it("names clicks by their target, else by coordinates, and clips to 80", () => {
    expect(clickLabel({ point: { x: 1, y: 2 }, source: "ax", role: "button", name: "Search" }, { x: 1, y: 2 })).toBe('Click "Search"');
    expect(clickLabel(null, { x: 10, y: 20 })).toBe("Click at (10, 20)");
    expect(clickLabel({ point: { x: 1, y: 2 }, source: "ax", name: "x".repeat(200) }, { x: 1, y: 2 }).length).toBe(80);
  });

  it("never puts masked text in a label", () => {
    expect(typeLabel("hunter2", true)).toBe("Type 7 characters");
    expect(typeLabel("hello", false)).toBe('Type "hello"');
    expect(typeLabel("a\nb\tc", false)).toBe('Type "a b c"');
  });

  it("writes key combos and scrolls for people", () => {
    expect(keyLabel(["ctrl", "l"])).toBe("Press Ctrl+L");
    expect(keyLabel(["Return"])).toBe("Press Return");
    expect(scrollLabel(0, 3)).toBe("Scroll down 3");
    expect(scrollLabel(-2, 0)).toBe("Scroll left 2");
  });

  it("clips every target string to its schema limit", () => {
    const t = clipTarget({ point: { x: 0, y: 0 }, source: "ax", role: "r".repeat(100), name: "n".repeat(100), app: "a".repeat(200), window: "w".repeat(300), url: "u".repeat(3000) });
    expect([t.role?.length, t.name?.length, t.app?.length, t.window?.length, t.url?.length]).toEqual([64, 64, 128, 256, 2048]);
  });
});
```

`apps/daemon/src/gateway/text.ts`:
```ts
import { clipText, keyDisplayName, type Point, type Target } from "@localdot/protocol";

const LABEL_MAX = 80;

export function clickLabel(target: Target | null, point: Point, verb = "Click"): string {
  const name = target?.name;
  return clipText(name ? `${verb} "${name}"` : `${verb} at (${point.x}, ${point.y})`, LABEL_MAX);
}

export function typeLabel(text: string, masked: boolean): string {
  const n = [...text].length;
  return masked ? `Type ${n} character${n === 1 ? "" : "s"}` : clipText(`Type "${text}"`, LABEL_MAX);
}

export function keyLabel(combo: string[]): string {
  return clipText(`Press ${combo.map(keyDisplayName).join("+")}`, LABEL_MAX);
}

export function scrollLabel(dx: number, dy: number): string {
  const parts = [];
  if (dy) parts.push(`${dy > 0 ? "down" : "up"} ${Math.abs(dy)}`);
  if (dx) parts.push(`${dx > 0 ? "right" : "left"} ${Math.abs(dx)}`);
  return `Scroll ${parts.join(", ") || "0"}`;
}

export function clipTarget(t: Target): Target {
  return {
    ...t,
    ...(t.role !== undefined ? { role: clipText(t.role, 64) } : {}),
    ...(t.name !== undefined ? { name: clipText(t.name, 64) } : {}),
    ...(t.app !== undefined ? { app: clipText(t.app, 128) } : {}),
    ...(t.window !== undefined ? { window: clipText(t.window, 256) } : {}),
    ...(t.url !== undefined ? { url: clipText(t.url, 2048) } : {}),
  };
}
```

`apps/daemon/src/gateway/frames.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { FrameStore } from "./frames.ts";

describe("FrameStore", () => {
  it("writes frames under the session folder with private modes and finds them again", () => {
    const home = mkdtempSync(join(tmpdir(), "local dot's frames-"));
    const store = new FrameStore(home);
    const session = ulid();
    const frame = ulid();
    const path = store.save(session, frame, Buffer.from("RIFF....WEBP"));
    expect(path).toBe(join(home, "sessions", session, "frames", `${frame}.webp`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "sessions", session, "frames")).mode & 0o777).toBe(0o700);
    expect(readFileSync(store.path(session, frame) ?? "").toString()).toBe("RIFF....WEBP");
    expect(store.path(session, ulid())).toBeUndefined();
    expect(() => store.save("../etc", frame, Buffer.alloc(1))).toThrow(/id/);
    expect(store.path(session, "../../daemon-token")).toBeUndefined();
    expect(existsSync(join(home, "daemon-token"))).toBe(false);
  });
});
```

`apps/daemon/src/gateway/frames.ts`:
```ts
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";

// observe screenshots live beside the session log, keyed by frameId, never inline in the JSONL.
export class FrameStore {
  readonly #root: string;

  constructor(home: string) {
    this.#root = join(home, "sessions");
  }

  save(sessionId: string, frameId: string, bytes: Buffer): string {
    const file = this.#file(sessionId, frameId);
    mkdirSync(join(this.#root, sessionId, "frames"), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    try {
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    return file;
  }

  path(sessionId: string, frameId: string): string | undefined {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(frameId)) return undefined;
    const file = this.#file(sessionId, frameId);
    return existsSync(file) ? file : undefined;
  }

  #file(sessionId: string, frameId: string): string {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(frameId)) throw new RangeError("invalid session or frame id");
    return join(this.#root, sessionId, "frames", `${frameId}.webp`);
  }
}
```
`packages/protocol/src/events.ts` — one comment above `PointerPlan`:
```ts
// startsAt is in session milliseconds (the renderer's unit, envelope t ÷ 1000); durationMs is a
// duration in milliseconds. pressT and ringAt on action.dispatch stay in microseconds like t.
```

Run: `pnpm exec vitest run apps/daemon/src/gateway`
Expected: ring-onset, text, frames (and Task 5's onset-table, routes) pass.

- [ ] **Step 2: The gateway test**

`apps/daemon/src/gateway/gateway.test.ts`:
```ts
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventOf, type LocalDotEvent, msToMicros, sessionMsOf, ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import type { Clock } from "../clock.ts";
import { DesktopdRegistry } from "../desktopd/registry.ts";
import { FakeDesktopd, type FakeScript } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "./frames.ts";
import { ActionGateway } from "./gateway.ts";
import { DEFAULT_ONSET_TABLE } from "./onset-table.ts";
import { keepPolicy } from "./ring-onset.ts";

function fakeClock(start = 10_000_000): Clock & { advance(us: number): void } {
  let now = start;
  return { nowMicros: () => now, advance: (us) => { now += us; } };
}

function setup(script: FakeScript = {}, opts: { viewers?: number; scale?: 1 | 2 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "local dot's gateway-"));
  const clock = fakeClock();
  const eventLog = new EventLog(home, clock);
  const cells = new FakeOrchestrator();
  const fake = new FakeDesktopd(script);
  const registry = new DesktopdRegistry(cells, clock, fake.fetchImpl);
  const cellId = ulid();
  cells.emit({ id: cellId, state: "ready", scale: opts.scale ?? 2, createdAt: new Date().toISOString(), stream: { ...NO_STREAM, connection: (opts.viewers ?? 1) > 0 ? "live" : "none", viewers: opts.viewers ?? 1 } });
  cells.endpointsById.set(cellId, { desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token }, stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" } });
  const sleeps: number[] = [];
  const gateway = new ActionGateway({
    eventLog,
    cells,
    registry,
    onset: DEFAULT_ONSET_TABLE,
    ringOnset: keepPolicy(DEFAULT_ONSET_TABLE),
    frames: new FrameStore(home),
    now: () => clock.nowMicros(),
    // Advances the fake clock, then yields one macrotask so a hit test that started beside the
    // travel resolves before the dispatch, as it does with real timers.
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      clock.advance(msToMicros(ms));
      await new Promise((r) => setImmediate(r));
    },
    hitTestTimeoutMs: 2500,
  });
  const sessionId = eventLog.createSession("test");
  const events = () => eventLog.read(sessionId);
  const ofType = <T extends LocalDotEvent["type"]>(type: T) => events().filter((e): e is EventOf<T> => e.type === type);
  return { home, clock, eventLog, cells, fake, registry, cellId, sessionId, gateway, sleeps, events, ofType };
}

const search = (point = { x: 300, y: 400 }) => ({ target: { point, bbox: { x: 280, y: 380, w: 40, h: 40 }, source: "ax" as const, role: "button", name: "Search", app: "Chromium", window: "Example" }, window: 77, ms: 12 });

describe("ActionGateway click", () => {
  it("emits intent → target → dispatch → settle → observe → result with the timing contract", async () => {
    const s = setup({ hitTest: () => search(), settle: () => ({ changed: [{ x: 1, y: 2, w: 3, h: 4 }], lastChangeMono: 50_010, quiet: true, noVisibleChange: false }) });
    const outcome = await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId, step: "s1" }, { verb: "click", point: { x: 150, y: 200 }, label: "Click the search box" });
    expect(outcome.ok).toBe(true);
    // The target may land before or after the dispatch (S2: hit tests can outlast the travel).
    const types = s.events().map((e) => e.type);
    expect(types[0]).toBe("action.intent");
    expect(types).toContain("action.target");
    expect(types.filter((t) => t !== "action.target")).toEqual(["action.intent", "action.dispatch", "screen.settle", "observe", "action.result"]);
    const [intent] = s.ofType("action.intent");
    const [dispatch] = s.ofType("action.dispatch");
    if (!intent || !dispatch) throw new Error("missing events");
    expect(intent.data).toMatchObject({ verb: "click", label: "Click the search box", point: { x: 300, y: 400 }, risk: "none" });
    expect(intent.step).toBe("s1");
    const plan = intent.data.pointer;
    if (!plan) throw new Error("no plan");
    expect(plan.curve).toBe("minjerk-bow-v1");
    expect(plan.to).toEqual({ x: 300, y: 400 });
    expect(plan.startsAt).toBe(Math.round(sessionMsOf(intent)) + 120);
    const distance = Math.hypot(plan.to.x - plan.from.x, plan.to.y - plan.from.y);
    expect(plan.durationMs).toBeCloseTo(Math.min(700, Math.max(220, 150 + 100 * Math.log2(distance / 48 + 1))), 6);
    // The press happens after travel + 90 ms dwell: the sleeps add up to lead + travel + dwell.
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(120 + plan.durationMs + 90, 3);
    expect(dispatch.data).toMatchObject({ input: { kind: "click", button: "left", count: 1, at: { x: 300, y: 400 } }, injector: "xtest" });
    expect(dispatch.data.ringAt - dispatch.data.pressT).toBe(23_100);
    expect(dispatch.data.pressT).toBeLessThanOrEqual(dispatch.t);
    expect(s.fake.calls.find((c) => c.path === "/input")?.body).toMatchObject({ window: 77, injector: "xtest" });
    const [settle] = s.ofType("screen.settle");
    expect(settle?.data).toMatchObject({ changed: [{ x: 1, y: 2, w: 3, h: 4 }], noVisibleChange: false });
    const [observe] = s.ofType("observe");
    expect(existsSync(join(s.home, "sessions", s.sessionId, "frames", `${observe?.data.frameId}.webp`))).toBe(true);
    expect(outcome.frameId).toBe(observe?.data.frameId);
    // The observe after the settle reports the pointer where the click landed; the gateway's
    // cursor (the next plan's `from`) follows it.
    expect(s.fake.pointer).toEqual({ x: 300, y: 400 });
    expect(s.gateway.cursorOf(s.cellId)).toEqual({ x: 300, y: 400 });
  });

  it("labels a find click by the element's name, truncates a 300-character name, names a point click by its coordinates and keeps the crosshair when the hit test is empty", async () => {
    // Only a `find` click knows its element before the intent; a point click's hit test runs
    // beside the travel, so its label is the coordinates.
    const long = { ...search(), target: { ...search().target, name: "n".repeat(300), window: "w".repeat(400) } };
    const s = setup({ find: () => long });
    await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "click", find: { name: "n".repeat(300) } });
    const [intent] = s.ofType("action.intent");
    expect(intent?.data.label.length).toBe(80);
    expect(intent?.data.label.startsWith('Click "nnn')).toBe(true);
    expect(intent?.data.label.endsWith("…")).toBe(true);
    const [target] = s.ofType("action.target");
    expect(target?.data.target.name?.length).toBe(64);
    expect(target?.data.target.window?.length).toBe(256);

    const byPoint = setup({ hitTest: () => long });
    await byPoint.gateway.run({ sessionId: byPoint.sessionId, cellId: byPoint.cellId }, { verb: "click", point: { x: 1, y: 1 } });
    expect(byPoint.ofType("action.intent")[0]?.data.label).toBe("Click at (2, 2)");
    expect(byPoint.ofType("action.target")[0]?.data.target.name?.length).toBe(64);

    const empty = setup({ hitTest: () => ({ target: null, window: null, ms: 3 }) });
    await empty.gateway.run({ sessionId: empty.sessionId, cellId: empty.cellId }, { verb: "click", point: { x: 10, y: 20 } });
    expect(empty.ofType("action.target")).toHaveLength(0);
    expect(empty.ofType("action.intent")[0]?.data.label).toBe("Click at (20, 40)");
    expect(empty.fake.calls.find((c) => c.path === "/input")?.body).not.toHaveProperty("window");
  });

  it("dispatches at Fast with no viewer and never holds", async () => {
    const s = setup({ hitTest: () => search() }, { viewers: 0 });
    // A tab that closed while its stream was down leaves `disconnected` behind with no viewer.
    s.cells.updateStream(s.cellId, { connection: "disconnected" });
    const outcome = await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "click", point: { x: 150, y: 200 } });
    expect(outcome.ok).toBe(true);
    const plan = s.ofType("action.intent")[0]?.data.pointer;
    expect(plan?.startsAt).toBe(Math.round(sessionMsOf(s.ofType("action.intent")[0] ?? { t: 0 })) + 60);
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(60 + (plan?.durationMs ?? 0) + 45, 3);
  });

  it("instant: no travel, dispatch after 60 ms", async () => {
    const s = setup({ hitTest: () => search() });
    await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "click", point: { x: 150, y: 200 }, speed: "instant" });
    expect(s.ofType("action.intent")[0]?.data.pointer?.durationMs).toBe(0);
    expect(s.sleeps).toEqual([60]);
  });

  it("holds dispatch while the stream is stalled and resumes on live", async () => {
    const s = setup({ hitTest: () => search() });
    s.cells.updateStream(s.cellId, { connection: "stalled" });
    const running = s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "click", point: { x: 150, y: 200 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.fake.calls.some((c) => c.path === "/input")).toBe(false);
    expect(s.events().map((e) => e.type)).toEqual(["action.intent", "action.target"]);
    s.cells.updateStream(s.cellId, { connection: "live" });
    const outcome = await running;
    expect(outcome.ok).toBe(true);
    expect(s.fake.calls.some((c) => c.path === "/input")).toBe(true);
  });

  it("finds a named target first and clicks its centre", async () => {
    const s = setup({ find: () => search({ x: 700, y: 468 }) });
    await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "click", find: { name: "Page two", role: "link" } });
    expect(s.fake.calls[0]).toMatchObject({ path: "/find", body: { name: "Page two", role: "link" } });
    expect(s.ofType("action.intent")[0]?.data.point).toEqual({ x: 700, y: 468 });
    expect(s.ofType("action.intent")[0]?.data.label).toBe('Click "Search"');
    expect(s.events().map((e) => e.type).slice(0, 2)).toEqual(["action.intent", "action.target"]);
  });

  it("floors Fitts' target width at 16 px times the scale", async () => {
    const close = { target: { point: { x: 1200, y: 900 }, bbox: { x: 1196, y: 896, w: 8, h: 8 }, source: "ax" as const, name: "Close" }, window: 77, ms: 3 };
    const s = setup({ find: () => close });
    await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "click", find: { name: "Close" } });
    const plan = s.ofType("action.intent")[0]?.data.pointer;
    if (!plan) throw new Error("no plan");
    const distance = Math.hypot(plan.to.x - plan.from.x, plan.to.y - plan.from.y);
    expect(plan.durationMs).toBeCloseTo(Math.min(700, Math.max(220, 150 + 100 * Math.log2(distance / 32 + 1))), 6);
  });

  it("cancels with timeout when desktopd reports no press, and with preflight when find fails", async () => {
    const s = setup({ hitTest: () => search(), input: () => ({ status: 504, body: "no raw press observed" }) });
    const outcome = await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "click", point: { x: 1, y: 1 } });
    expect(outcome).toMatchObject({ ok: false, cancelled: "timeout" });
    expect(s.events().map((e) => e.type).filter((t) => t !== "action.target")).toEqual(["action.intent", "action.cancel"]);
    expect(s.ofType("action.cancel")[0]?.data).toMatchObject({ reason: "timeout" });

    const missing = setup({ find: () => ({ target: null, window: null, ms: 1 }) });
    const out2 = await missing.gateway.run({ sessionId: missing.sessionId, cellId: missing.cellId }, { verb: "click", find: { name: "Nope" } });
    expect(out2).toMatchObject({ ok: false, cancelled: "preflight" });
    expect(missing.ofType("action.cancel")[0]?.data.detail).toContain("Nope");
  });

  it("cancels with user when aborted during travel", async () => {
    const s = setup({ hitTest: () => search() });
    const ac = new AbortController();
    const running = s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId, signal: ac.signal }, { verb: "click", point: { x: 1, y: 1 } });
    ac.abort();
    const outcome = await running;
    expect(outcome.cancelled).toBe("user");
    expect(s.ofType("action.cancel")[0]?.data.reason).toBe("user");
    expect(s.fake.calls.some((c) => c.path === "/input")).toBe(false);
  });
});

describe("ActionGateway type and key", () => {
  it("masks a secret field end to end", async () => {
    const s = setup({
      hitTest: () => ({ target: { point: { x: 100, y: 100 }, bbox: { x: 80, y: 90, w: 200, h: 30 }, source: "dom", role: "textbox", name: "Password", secret: true }, window: 9, ms: 5 }),
      type: () => ({ progress: [{ count: 3, pressMono: 60_000 }, { count: 7, pressMono: 60_300 }], result: { done: true, count: 7, firstPressMono: 59_900, injector: "xtest", armedMono: 59_000 } }),
    });
    const outcome = await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "type", text: "hunter2" });
    expect(outcome.ok).toBe(true);
    expect(s.events().map((e) => e.type)).toEqual(["action.intent", "action.target", "action.dispatch", "text.progress", "text.progress", "screen.settle", "observe", "action.result"]);
    expect(s.ofType("action.intent")[0]?.data.label).toBe("Type 7 characters");
    expect(s.ofType("action.dispatch")[0]?.data.input).toEqual({ kind: "type", chars: 7, masked: true });
    expect(s.ofType("text.progress").map((e) => e.data)).toEqual([{ count: 3, masked: true }, { count: 7, masked: true }]);
    expect(JSON.stringify(s.events())).not.toContain("hunter2");
    expect(s.fake.calls.find((c) => c.path === "/type")?.body).toMatchObject({ masked: true, pace: { firstMs: 35, firstCount: 60, restMs: 6 } });
  });

  it("types plain text with chunks, paced by the speed", async () => {
    const s = setup({
      hitTest: () => ({ target: null, window: null, ms: 2 }),
      type: () => ({ progress: [{ count: 1, chunk: "h", pressMono: 60_000 }, { count: 2, chunk: "i", pressMono: 60_040 }], result: { done: true, count: 2, firstPressMono: 60_000, injector: "xtest", armedMono: 59_000 } }),
    }, { viewers: 0 });
    await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "type", text: "hi" });
    expect(s.ofType("text.progress").map((e) => e.data)).toEqual([{ count: 1, chunk: "h", masked: false }, { count: 2, chunk: "i", masked: false }]);
    expect(s.fake.calls.find((c) => c.path === "/type")?.body).toMatchObject({ pace: { firstMs: 8, firstCount: 60, restMs: 8 } });
    const dispatch = s.ofType("action.dispatch")[0];
    expect((dispatch?.data.ringAt ?? 0) - (dispatch?.data.pressT ?? 0)).toBe(29_300);
  });

  it("a Stop mid-typing ends the typing itself", async () => {
    const s = setup({
      hitTest: () => ({ target: null, window: null, ms: 2 }),
      type: () => ({ progress: [{ count: 1, chunk: "h", pressMono: 60_000 }], result: { done: true, count: 40, firstPressMono: 60_000, injector: "xtest", armedMono: 59_000 } }),
      typeHolds: true,
    });
    const stop = new AbortController();
    const running = s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId, signal: stop.signal }, { verb: "type", text: "h".repeat(40) });
    await vi.waitFor(() => expect(s.ofType("text.progress")).toHaveLength(1));
    stop.abort();
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    expect(s.events().map((e) => e.type)).toEqual(["action.intent", "action.dispatch", "text.progress", "action.result"]);
  });

  it("presses a key combo with a readable label and a key onset", async () => {
    const s = setup();
    await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "key", combo: ["ctrl", "l"] });
    expect(s.ofType("action.intent")[0]?.data).toMatchObject({ verb: "key", label: "Press Ctrl+L" });
    expect(s.ofType("action.dispatch")[0]?.data.input).toEqual({ kind: "key", combo: ["ctrl", "l"] });
    const dispatch = s.ofType("action.dispatch")[0];
    expect((dispatch?.data.ringAt ?? 0) - (dispatch?.data.pressT ?? 0)).toBe(29_300);
    expect(s.sleeps).toEqual([90]);
  });

  it("waits without touching the desktop", async () => {
    const s = setup();
    await s.gateway.run({ sessionId: s.sessionId, cellId: s.cellId }, { verb: "wait", ms: 500 });
    expect(s.events().map((e) => e.type)).toEqual(["action.intent", "action.result"]);
    expect(s.sleeps).toEqual([500]);
    expect(s.fake.calls).toEqual([]);
  });
});
```

Run: `pnpm exec vitest run apps/daemon/src/gateway/gateway.test.ts`
Expected: FAIL — `Cannot find module './gateway.ts'`.

- [ ] **Step 3: Implement the gateway**

`apps/daemon/src/gateway/gateway.ts`:
```ts
import { type Input, microsToMs, type Point, type Rect, type Target } from "@localdot/protocol";
import { toDevice } from "@localdot/providers";
import {
  dwellMs,
  INSTANT_LEAD_MS,
  intentLeadMs,
  SETTLE_CAP_MS,
  SETTLE_QUIET_MS,
  type Speed,
  travelDurationMs,
  typingPaceMs,
} from "@localdot/stage";
import type { CellApi } from "../cells/orchestrator.ts";
import type { StreamState } from "../cells/types.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { CellDesktopd, DesktopdRegistry } from "../desktopd/registry.ts";
import type { EventLog } from "../event-log.ts";
import type { FrameStore } from "./frames.ts";
import { type OnsetTable, onsetKind } from "./onset-table.ts";
import type { RingOnsetPolicy } from "./ring-onset.ts";
import { clickLabel, clipTarget, keyLabel, scrollLabel, typeLabel } from "./text.ts";

export const DEFAULT_AGENT = "main";
const MODEL_SCREEN = { width: 1280, height: 800 } as const;
// Fitts' W in CSS px, multiplied by the cell's scale: the distance it divides is in device px.
const UNKNOWN_TARGET_PX = 24;
const MIN_TARGET_PX = 16;

export type GuiAction =
  | { verb: "click"; label?: string; point?: Point; find?: { name: string; role?: string; app?: string }; button?: "left" | "right" | "middle"; count?: 1 | 2 | 3; speed?: Speed | "auto" }
  | { verb: "type"; label?: string; text: string; masked?: boolean; speed?: Speed | "auto" }
  | { verb: "key"; label?: string; combo: string[]; speed?: Speed | "auto" }
  | { verb: "scroll"; label?: string; point: Point; dx: number; dy: number; speed?: Speed | "auto" }
  | { verb: "wait"; label?: string; ms: number };

export interface ActionContext {
  sessionId: string;
  cellId: string;
  agent?: string;
  step?: string;
  signal?: AbortSignal;
}

export interface ActionOutcome {
  ok: boolean;
  frameId?: string;
  target?: Target;
  error?: string;
  cancelled?: "preflight" | "user" | "timeout";
}

export interface GatewayDeps {
  eventLog: EventLog;
  cells: CellApi;
  registry: DesktopdRegistry;
  onset: OnsetTable;
  ringOnset: RingOnsetPolicy;
  frames: FrameStore;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  hitTestTimeoutMs?: number;
}

class Cancelled extends Error {
  constructor(
    readonly reason: "preflight" | "user" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "Cancelled";
  }
}

// Only a viewer's stream can hold dispatch: with nobody attached, a `disconnected` left behind by a
// closed tab is not a stall.
const holding = (s: StreamState) => s.viewers > 0 && (s.connection === "stalled" || s.connection === "disconnected" || s.connection === "connecting");

export class ActionGateway {
  readonly #cursor = new Map<string, Point>();

  constructor(private readonly deps: GatewayDeps) {}

  cursorOf(cellId: string): Point | undefined {
    return this.#cursor.get(cellId);
  }

  // A fresh frame for the brain (M4) and for the step thumbnails; also where the cursor starts.
  async observe(ctx: ActionContext): Promise<{ frameId: string; pointer: Point }> {
    const d = await this.#ready(ctx.cellId);
    const o = await d.client.observe();
    this.deps.frames.save(ctx.sessionId, o.frameId, Buffer.from(o.image, "base64"));
    this.#append(ctx, "observe", { frameId: o.frameId, width: o.width, height: o.height });
    this.#cursor.set(ctx.cellId, o.pointer);
    return { frameId: o.frameId, pointer: o.pointer };
  }

  async run(ctx: ActionContext, action: GuiAction): Promise<ActionOutcome> {
    const cell = this.deps.cells.get(ctx.cellId);
    if (!cell) throw new Error(`unknown cell ${ctx.cellId}`);
    const scale = cell.scale;
    const speed: Speed = "speed" in action && action.speed && action.speed !== "auto" ? action.speed : cell.stream.viewers > 0 ? "watch" : "fast";
    let dispatched = false;
    try {
      switch (action.verb) {
        case "wait": {
          this.#append(ctx, "action.intent", { verb: "wait", label: action.label ?? `Wait ${action.ms} ms`, risk: "none" });
          await this.deps.sleep(action.ms, ctx.signal);
          this.#append(ctx, "action.result", { ok: true });
          return { ok: true };
        }
        case "click":
        case "scroll":
          return await this.#pointerAction(ctx, action, scale, speed, (v) => {
            dispatched = v;
          });
        case "type":
          return await this.#typeAction(ctx, action, scale, speed, (v) => {
            dispatched = v;
          });
        case "key":
          return await this.#keyAction(ctx, action, scale, speed, (v) => {
            dispatched = v;
          });
      }
    } catch (err) {
      return this.#fail(ctx, err, dispatched);
    }
  }

  async #pointerAction(ctx: ActionContext, action: Extract<GuiAction, { verb: "click" | "scroll" }>, scale: 1 | 2, speed: Speed, mark: (v: boolean) => void): Promise<ActionOutcome> {
    const d = await this.#ready(ctx.cellId);
    const t0 = this.deps.now();
    let found: { target: Target | null; window: number | null } | undefined;
    let point: Point;
    if (action.verb === "click" && action.find) {
      found = await d.client.find(action.find);
      if (!found.target) throw new Cancelled("preflight", `no element named ${JSON.stringify(action.find.name)}`);
      point = found.target.point;
    } else if (action.point) {
      point = toDevice(action.point, { ...MODEL_SCREEN, scale });
    } else throw new Cancelled("preflight", "click needs a point or a find");

    const from = this.#cursor.get(ctx.cellId) ?? { x: (MODEL_SCREEN.width * scale) / 2, y: (MODEL_SCREEN.height * scale) / 2 };
    const width = found?.target?.bbox ? Math.max(MIN_TARGET_PX * scale, Math.min(found.target.bbox.w, found.target.bbox.h)) : UNKNOWN_TARGET_PX * scale;
    const durationMs = travelDurationMs(Math.hypot(point.x - from.x, point.y - from.y), width, speed);
    const leadMs = speed === "instant" ? 0 : intentLeadMs(speed);
    const startsAt = Math.round(microsToMs(this.#sessionT(ctx.sessionId, t0))) + leadMs;
    const verb = action.verb === "click" ? "click" : "scroll";
    const label = action.label ?? (action.verb === "click" ? clickLabel(found?.target ?? null, point) : scrollLabel(action.dx, action.dy));
    this.#append(ctx, "action.intent", {
      verb,
      label,
      point,
      risk: "none",
      pointer: { from, to: point, startsAt, durationMs, seed: Math.floor(Math.random() * 2 ** 31), curve: "minjerk-bow-v1" },
    });

    // The hit test runs beside the travel: it often takes longer than the cursor (S2), so the
    // target box may arrive after the cursor; a result after the action has ended is dropped.
    let ended = false;
    const lookup: Promise<{ target: Target | null; window: number | null }> = found
      ? Promise.resolve(found)
      : Promise.race([
          d.client.hitTest(point).catch(() => ({ target: null, window: null })),
          timeoutAfter<{ target: Target | null; window: number | null }>(this.deps.hitTestTimeoutMs ?? 2500, { target: null, window: null }),
        ]);
    let known: { target: Target | null; window: number | null } | undefined = found;
    const targetKnown = lookup.then((r) => {
      known = r;
      if (r.target && !ended) this.#append(ctx, "action.target", { target: clipTarget(r.target) });
      return r;
    });
    let frameId: string;
    try {
      const pressAtMs = speed === "instant" ? startsAt + INSTANT_LEAD_MS : startsAt + durationMs + dwellMs(speed);
      await this.#sleepUntil(ctx, pressAtMs);
      await this.#waitForStream(ctx);
      const input: Input = action.verb === "click"
        ? { kind: "click", button: action.button ?? "left", count: action.count ?? 1, at: point }
        : { kind: "scroll", at: point, dx: action.dx, dy: action.dy };
      const res = await d.client.input({ input, injector: "xtest", holdMs: 0, ...(known?.window ? { window: known.window } : {}) });
      mark(true);
      const pressT = this.#pressT(ctx, d, res.pressMono);
      const ringAt = await this.deps.ringOnset.onset({ pressT, injector: res.injector, kind: onsetKind(input), scale });
      this.#append(ctx, "action.dispatch", { input, pressT, ringAt, injector: res.injector });
      this.#cursor.set(ctx.cellId, point);
      frameId = await this.#finish(ctx, d);
    } finally {
      ended = true;
    }
    const outcome = await targetKnown;
    return { ok: true, frameId, ...(outcome.target ? { target: outcome.target } : {}) };
  }

  async #typeAction(ctx: ActionContext, action: Extract<GuiAction, { verb: "type" }>, scale: 1 | 2, speed: Speed, mark: (v: boolean) => void): Promise<ActionOutcome> {
    const d = await this.#ready(ctx.cellId);
    const at = this.#cursor.get(ctx.cellId) ?? { x: (MODEL_SCREEN.width * scale) / 2, y: (MODEL_SCREEN.height * scale) / 2 };
    // The field under the cursor decides masking before a single key goes out.
    const hit = await Promise.race([
      d.client.hitTest(at).catch(() => ({ target: null, window: null })),
      timeoutAfter<{ target: Target | null; window: number | null }>(this.deps.hitTestTimeoutMs ?? 2500, { target: null, window: null }),
    ]);
    const masked = action.masked === true || hit.target?.secret === true;
    const chars = [...action.text].length;
    this.#append(ctx, "action.intent", { verb: "type", label: action.label ?? typeLabel(action.text, masked), point: at, risk: "none" });
    if (hit.target) this.#append(ctx, "action.target", { target: clipTarget(hit.target) });
    await this.#waitForStream(ctx);
    const pace = { firstMs: typingPaceMs(speed, 0), firstCount: 60, restMs: typingPaceMs(speed, 60) };
    let first = true;
    // Stop reaches the request itself: desktopd stops typing at the next key, however long the text.
    const typing = { text: action.text, masked, pace, injector: "xtest" as const, ...(hit.window ? { window: hit.window } : {}) };
    const result = await d.client.type(
      typing,
      async (p) => {
        if (first) {
          first = false;
          mark(true);
          const pressT = this.#pressT(ctx, d, p.pressMono);
          const ringAt = await this.deps.ringOnset.onset({ pressT, injector: "xtest", kind: "key", scale });
          this.#append(ctx, "action.dispatch", { input: { kind: "type", chars, masked }, pressT, ringAt, injector: "xtest" });
        }
        this.#append(ctx, "text.progress", { count: p.count, masked, ...(masked || p.chunk === undefined ? {} : { chunk: p.chunk }) });
      },
      ctx.signal,
    );
    if (result.count === 0) throw new Cancelled("timeout", "nothing was typed");
    const frameId = await this.#finish(ctx, d);
    return { ok: true, frameId, ...(hit.target ? { target: hit.target } : {}) };
  }

  async #keyAction(ctx: ActionContext, action: Extract<GuiAction, { verb: "key" }>, scale: 1 | 2, speed: Speed, mark: (v: boolean) => void): Promise<ActionOutcome> {
    const d = await this.#ready(ctx.cellId);
    this.#append(ctx, "action.intent", { verb: "key", label: action.label ?? keyLabel(action.combo), risk: "none" });
    await this.deps.sleep(dwellMs(speed), ctx.signal);
    await this.#waitForStream(ctx);
    const input: Input = { kind: "key", combo: action.combo };
    const res = await d.client.input({ input, injector: "xtest", holdMs: 0 });
    mark(true);
    const pressT = this.#pressT(ctx, d, res.pressMono);
    const ringAt = await this.deps.ringOnset.onset({ pressT, injector: res.injector, kind: "key", scale });
    this.#append(ctx, "action.dispatch", { input, pressT, ringAt, injector: res.injector });
    const frameId = await this.#finish(ctx, d);
    return { ok: true, frameId };
  }

  // settle → observe → result; returns this action's own frame, never a concurrent action's.
  async #finish(ctx: ActionContext, d: CellDesktopd): Promise<string> {
    const s = await d.client.settle({ quietMs: SETTLE_QUIET_MS, timeoutMs: SETTLE_CAP_MS });
    const frameT = s.lastChangeMono === null ? this.#sessionT(ctx.sessionId, this.deps.now()) : this.#sessionT(ctx.sessionId, d.clocks.toDaemonMicros(s.lastChangeMono));
    this.#append(ctx, "screen.settle", { frameT, changed: s.changed.map(roundRect), noVisibleChange: s.noVisibleChange });
    const o = await this.observe(ctx);
    this.#append(ctx, "action.result", { ok: true });
    return o.frameId;
  }

  #fail(ctx: ActionContext, err: unknown, dispatched: boolean): ActionOutcome {
    const message = err instanceof Error ? err.message : String(err);
    if (dispatched) {
      this.#append(ctx, "action.result", { ok: false, error: message.slice(0, 500) });
      return { ok: false, error: message };
    }
    const reason = err instanceof Cancelled ? err.reason : err instanceof DesktopdError && err.status === 504 ? "timeout" : ctx.signal?.aborted ? "user" : "preflight";
    this.#append(ctx, "action.cancel", { reason, detail: message.slice(0, 500) });
    return { ok: false, error: message, cancelled: reason };
  }

  #desktopd(cellId: string): CellDesktopd {
    const d = this.deps.registry.for(cellId);
    if (!d) throw new Cancelled("preflight", `cell ${cellId} has no desktopd endpoint`);
    return d;
  }

  // The clock map must be synced before a press time is mapped: the registry re-syncs on a timer,
  // the first action on a cell syncs here.
  async #ready(cellId: string): Promise<CellDesktopd> {
    const d = this.#desktopd(cellId);
    if (!d.clocks.sample) await d.clocks.sync();
    return d;
  }

  #pressT(ctx: ActionContext, d: CellDesktopd, pressMono: number): number {
    if (!d.clocks.sample) throw new Cancelled("preflight", "desktopd clock not synced");
    // The press happened before this call returned; a mapping error of a millisecond must not put
    // it after the event that records it.
    return Math.min(this.#sessionT(ctx.sessionId, d.clocks.toDaemonMicros(pressMono)), this.#sessionT(ctx.sessionId, this.deps.now()));
  }

  #sessionT(sessionId: string, daemonMicros: number): number {
    return this.deps.eventLog.toSessionT(sessionId, daemonMicros);
  }

  async #sleepUntil(ctx: ActionContext, sessionMs: number): Promise<void> {
    const remaining = sessionMs - microsToMs(this.#sessionT(ctx.sessionId, this.deps.now()));
    if (remaining > 0) await this.deps.sleep(remaining, ctx.signal);
    ctx.signal?.throwIfAborted();
  }

  // Spec, error handling: the gateway holds dispatch until the connection is back.
  async #waitForStream(ctx: ActionContext): Promise<void> {
    const stream = this.deps.cells.get(ctx.cellId)?.stream;
    if (!stream || !holding(stream)) return;
    await new Promise<void>((resolve, reject) => {
      const off = this.deps.cells.subscribe((cell) => {
        if (cell.id === ctx.cellId && !holding(cell.stream)) {
          off();
          resolve();
        }
      });
      ctx.signal?.addEventListener(
        "abort",
        () => {
          off();
          reject(new Cancelled("user", "stopped while holding for the stream"));
        },
        { once: true },
      );
    });
  }

  #append(ctx: ActionContext, type: string, data: Record<string, unknown>): void {
    this.deps.eventLog.append(ctx.sessionId, { type, agent: ctx.agent ?? DEFAULT_AGENT, ...(ctx.step ? { step: ctx.step } : {}), data } as never);
  }
}

function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

// A real timer, never the injected sleep: tests drive a fake clock through `sleep`, and a hit-test
// timeout must not advance the presentation clock.
function timeoutAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
}
```
A note on `#sleepUntil` and the `sleep` dependency: in production `sleep` is a real timer that
rejects on abort (`node:timers/promises` `setTimeout(ms, undefined, { signal })`); `#sleepUntil`
handles the abort by rethrowing after the sleep, and `#fail` maps an aborted signal to `user`.
`ClockMap.sync` must have run before the first action: the registry starts it on first use, and
`#pressT` refuses to guess when it has not (the puppet runner syncs explicitly, Task 10).

Run: `pnpm exec vitest run apps/daemon/src/gateway`
Expected: all gateway tests pass. The "aborted during travel" test relies on the test's `sleep`
calling `signal.throwIfAborted()` first; production sleeps reject the same way.

- [ ] **Step 4: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon packages/protocol/src/events.ts
git commit -m "feat(daemon): action gateway with the timing contract and the ring-onset policy"
```

---
### Task 10: The puppet — scripts, the runner, routes and the CLI

A puppet script is a JSON list of steps run through the gateway with no model, for demos, the e2e
test and the pixel oracle (spec, Testing: integration). It creates a session, declares the screen,
observes once so the cursor starts at the real pointer, runs each step inside `step.start`/`step.end`,
and ends the session. The daemon exposes it on the API, reports the live session per cell, serves
frames, and can stop a session.

**Files:**
- Create: `apps/daemon/src/puppet/script.ts`, `apps/daemon/src/puppet/runner.ts`,
  `apps/daemon/src/gateway/live.ts`, `apps/daemon/src/puppet-main.ts`,
  `apps/daemon/puppet/demo-multiapp.json`, `apps/daemon/puppet/oracle.json`,
  `cells/desktop/root/opt/localdot/demo/index.html`, `cells/desktop/root/opt/localdot/demo/page2.html`
- Modify: `apps/daemon/src/gateway/routes.ts`, `apps/daemon/src/main.ts`, `apps/daemon/package.json`
  (`app.ts` already passes `AppOptions.gateway` through to the routes, so it does not change)
- Test: `apps/daemon/src/puppet/script.test.ts`, `apps/daemon/src/puppet/runner.test.ts`,
  `apps/daemon/src/gateway/routes.test.ts`

**Interfaces:**
- Consumes: `ActionGateway`, `GuiAction` (Task 9); `EventLog`; `DesktopdRegistry`; `FrameStore`.
- Produces: `PuppetScript` (zod) `{ v: 1; title; steps: PuppetStep[] }`, `PuppetStep` = `launch { app; args?; waitMs? }`
  | `click { x; y } | click { find: { name; role?; app? } }` (+ `button?`, `count?`, `speed?`) | `type { text; masked? }` | `key { combo }`
  | `scroll { x; y; dx; dy }` | `wait { ms }`, each with an optional `label`; `parsePuppetScript(value)`;
  `runPuppet(deps, { cellId, sessionId, script, signal }): Promise<{ ok: boolean; steps: number }>`,
  `PuppetDeps { gateway; eventLog; registry; cells; sleep }`;
  `class LiveSessions { start(cellId, sessionId, run: (signal) => Promise<unknown>): void; get(cellId): string | undefined; stop(sessionId): boolean; cellOf(sessionId) }`;
  routes `POST /api/cells/:id/puppet` → 202 `{ sessionId }` (400 bad script, 409 busy or not ready),
  `GET /api/cells/:id/live` → `{ sessionId }` or 404, `POST /api/sessions/:id/stop` → 202,
  `GET /api/sessions/:id/frames/:frameId` → `image/webp`; `GatewayRoutesDeps` gains `eventLog, gateway, frames, live`;
  CLI `pnpm --filter @localdot/daemon puppet <script.json> [--cell <id>]` (reads `<home>/daemon-token`, picks the first ready cell, follows the event stream).

- [ ] **Step 1: The script schema, test first**

`apps/daemon/src/puppet/script.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parsePuppetScript } from "./script.ts";

describe("parsePuppetScript", () => {
  it("accepts the demo shapes", () => {
    const s = parsePuppetScript({
      v: 1,
      title: "demo",
      steps: [
        { do: "launch", app: "calc", waitMs: 8000 },
        { do: "click", find: { name: "Name Box" }, label: "Click the Name Box" },
        { do: "type", text: "B2" },
        { do: "key", combo: ["Return"] },
        { do: "click", x: 155, y: 238, button: "right", count: 2, speed: "instant" },
        { do: "scroll", x: 640, y: 400, dx: 0, dy: 3 },
        { do: "wait", ms: 500 },
      ],
    });
    expect(s.steps).toHaveLength(7);
  });

  it("rejects model coordinates outside 1280x800, unknown verbs, and empty scripts", () => {
    expect(() => parsePuppetScript({ v: 1, title: "t", steps: [{ do: "click", x: 1280, y: 0 }] })).toThrow();
    expect(() => parsePuppetScript({ v: 1, title: "t", steps: [{ do: "teleport" }] })).toThrow();
    expect(() => parsePuppetScript({ v: 1, title: "t", steps: [] })).toThrow();
    expect(() => parsePuppetScript({ v: 1, title: "t", steps: [{ do: "click" }] })).toThrow(/point or find/);
  });
});
```

`apps/daemon/src/puppet/script.ts`:
```ts
import { LaunchApp, MouseButton } from "@localdot/protocol";
import { z } from "zod";

const coord = (max: number) => z.number().int().min(0).max(max - 1);
const Speed = z.enum(["auto", "watch", "fast", "instant"]);
const label = z.string().min(1).max(80).optional();

export const PuppetStep = z.discriminatedUnion("do", [
  z.object({ do: z.literal("launch"), app: LaunchApp, args: z.array(z.string().max(2048)).max(16).optional(), waitMs: z.number().int().nonnegative().max(60_000).optional(), label }),
  z
    .object({
      do: z.literal("click"),
      x: coord(1280).optional(),
      y: coord(800).optional(),
      find: z.object({ name: z.string().min(1).max(256), role: z.string().max(64).optional(), app: z.string().max(128).optional() }).optional(),
      button: MouseButton.optional(),
      count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      speed: Speed.optional(),
      label,
    })
    .refine((s) => (s.x !== undefined && s.y !== undefined) || s.find !== undefined, { message: "click needs a point or find" }),
  z.object({ do: z.literal("type"), text: z.string().min(1).max(2000), masked: z.boolean().optional(), speed: Speed.optional(), label }),
  z.object({ do: z.literal("key"), combo: z.array(z.string().min(1).max(32)).min(1).max(4), speed: Speed.optional(), label }),
  z.object({ do: z.literal("scroll"), x: coord(1280), y: coord(800), dx: z.number().int().min(-50).max(50), dy: z.number().int().min(-50).max(50), speed: Speed.optional(), label }),
  z.object({ do: z.literal("wait"), ms: z.number().int().nonnegative().max(60_000), label }),
]);
export type PuppetStep = z.infer<typeof PuppetStep>;

export const PuppetScript = z.object({
  v: z.literal(1),
  title: z.string().min(1).max(200),
  steps: z.array(PuppetStep).min(1).max(200),
});
export type PuppetScript = z.infer<typeof PuppetScript>;

export function parsePuppetScript(value: unknown): PuppetScript {
  return PuppetScript.parse(value);
}
```

- [ ] **Step 2: The runner, test first**

`apps/daemon/src/puppet/runner.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import { monotonicClock } from "../clock.ts";
import { DesktopdRegistry } from "../desktopd/registry.ts";
import { FakeDesktopd } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { ActionGateway } from "../gateway/gateway.ts";
import { DEFAULT_ONSET_TABLE } from "../gateway/onset-table.ts";
import { keepPolicy } from "../gateway/ring-onset.ts";
import { runPuppet } from "./runner.ts";
import { parsePuppetScript } from "./script.ts";

function setup(fake = new FakeDesktopd()) {
  const home = mkdtempSync(join(tmpdir(), "local dot's puppet-"));
  const clock = monotonicClock();
  const eventLog = new EventLog(home, clock);
  const cells = new FakeOrchestrator();
  const registry = new DesktopdRegistry(cells, clock, fake.fetchImpl);
  const cellId = ulid();
  cells.emit({ id: cellId, state: "ready", scale: 2, createdAt: new Date().toISOString(), stream: { ...NO_STREAM, connection: "none" } });
  cells.endpointsById.set(cellId, { desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token }, stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" } });
  const sleep = async () => {};
  const gateway = new ActionGateway({ eventLog, cells, registry, onset: DEFAULT_ONSET_TABLE, ringOnset: keepPolicy(DEFAULT_ONSET_TABLE), frames: new FrameStore(home), now: () => clock.nowMicros(), sleep });
  return { eventLog, cells, registry, cellId, gateway, fake, deps: { gateway, eventLog, registry, cells, sleep } };
}

describe("runPuppet", () => {
  it("runs a script as one session with steps, a screen declaration and a first observe", async () => {
    const s = setup();
    const script = parsePuppetScript({ v: 1, title: "demo", steps: [{ do: "launch", app: "terminal", waitMs: 10 }, { do: "click", x: 100, y: 100 }, { do: "key", combo: ["Return"] }] });
    const sessionId = s.eventLog.createSession(script.title);
    const result = await runPuppet(s.deps, { cellId: s.cellId, sessionId, script });
    expect(result).toEqual({ ok: true, steps: 3 });
    const types = s.eventLog.read(sessionId).map((e) => e.type);
    expect(types.slice(0, 4)).toEqual(["session.start", "agent.state", "observe", "step.start"]);
    expect(types.at(-2)).toBe("agent.state");
    expect(types.at(-1)).toBe("session.end");
    const start = s.eventLog.read(sessionId)[0];
    expect(start?.type === "session.start" && start.data).toMatchObject({ screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "demo" });
    expect(types.filter((t) => t === "step.start")).toHaveLength(3);
    expect(types.filter((t) => t === "step.end")).toHaveLength(3);
    expect(s.fake.calls.map((c) => c.path)).toEqual(expect.arrayContaining(["/observe", "/launch", "/input"]));
    const steps = new Set(s.eventLog.read(sessionId).map((e) => e.step).filter(Boolean));
    expect(steps.size).toBe(3);
  });

  it("stops at the first failed step and ends the session with error", async () => {
    const s = setup(new FakeDesktopd({ find: () => ({ target: null, window: null, ms: 1 }) }));
    const script = parsePuppetScript({ v: 1, title: "bad", steps: [{ do: "click", find: { name: "Nope" } }, { do: "wait", ms: 1 }] });
    const sessionId = s.eventLog.createSession(script.title);
    const result = await runPuppet(s.deps, { cellId: s.cellId, sessionId, script });
    expect(result.ok).toBe(false);
    const events = s.eventLog.read(sessionId);
    expect(events.filter((e) => e.type === "step.end").map((e) => (e.type === "step.end" ? e.data.status : ""))).toEqual(["failed"]);
    expect(events.at(-1)).toMatchObject({ type: "session.end", data: { reason: "error" } });
  });

  it("ends with stopped when aborted", async () => {
    const s = setup();
    const script = parsePuppetScript({ v: 1, title: "stop", steps: [{ do: "wait", ms: 5 }, { do: "wait", ms: 5 }] });
    const sessionId = s.eventLog.createSession(script.title);
    const ac = new AbortController();
    ac.abort();
    const result = await runPuppet(s.deps, { cellId: s.cellId, sessionId, script, signal: ac.signal });
    expect(result.ok).toBe(false);
    expect(s.eventLog.read(sessionId).at(-1)).toMatchObject({ type: "session.end", data: { reason: "stopped" } });
  });
});
```

`apps/daemon/src/puppet/runner.ts`:
```ts
import { ulid } from "@localdot/protocol";
import type { CellApi } from "../cells/orchestrator.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import type { EventLog } from "../event-log.ts";
import { type ActionGateway, DEFAULT_AGENT, type GuiAction } from "../gateway/gateway.ts";
import type { PuppetScript, PuppetStep } from "./script.ts";

export interface PuppetDeps {
  gateway: ActionGateway;
  eventLog: EventLog;
  registry: DesktopdRegistry;
  cells: CellApi;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface PuppetRun {
  cellId: string;
  sessionId: string;
  script: PuppetScript;
  signal?: AbortSignal;
}

export function actionOf(step: PuppetStep): GuiAction | undefined {
  switch (step.do) {
    case "click":
      return step.find
        ? { verb: "click", find: step.find, button: step.button, count: step.count, speed: step.speed, label: step.label }
        : { verb: "click", point: { x: step.x as number, y: step.y as number }, button: step.button, count: step.count, speed: step.speed, label: step.label };
    case "type":
      return { verb: "type", text: step.text, masked: step.masked, speed: step.speed, label: step.label };
    case "key":
      return { verb: "key", combo: step.combo, speed: step.speed, label: step.label };
    case "scroll":
      return { verb: "scroll", point: { x: step.x, y: step.y }, dx: step.dx, dy: step.dy, speed: step.speed, label: step.label };
    case "wait":
      return { verb: "wait", ms: step.ms, label: step.label };
    case "launch":
      return undefined;
  }
}

export async function runPuppet(deps: PuppetDeps, run: PuppetRun): Promise<{ ok: boolean; steps: number }> {
  const { cellId, sessionId, script, signal } = run;
  const cell = deps.cells.get(cellId);
  if (!cell) throw new Error(`unknown cell ${cellId}`);
  const append = (type: string, data: Record<string, unknown>, step?: string) =>
    deps.eventLog.append(sessionId, { type, agent: DEFAULT_AGENT, ...(step ? { step } : {}), data } as never);
  append("session.start", { screen: { w: 1280 * cell.scale, h: 800 * cell.scale, scale: cell.scale }, os: "linux", title: script.title });
  append("agent.state", { state: "acting" });
  let done = 0;
  let reason: "done" | "stopped" | "error" = "done";
  try {
    const d = deps.registry.for(cellId);
    if (!d) throw new Error("cell has no desktopd endpoint");
    if (!d.clocks.sample) await d.clocks.sync();
    await deps.gateway.observe({ sessionId, cellId });
    for (const step of script.steps) {
      if (signal?.aborted) {
        reason = "stopped";
        break;
      }
      const id = ulid();
      append("step.start", { kind: "gui" }, id);
      let ok = false;
      if (step.do === "launch") {
        await d.client.launch({ app: step.app, args: step.args ?? [] });
        append("action.intent", { verb: "wait", label: step.label ?? `Open ${step.app}`, risk: "none" }, id);
        await deps.sleep(step.waitMs ?? 5000, signal);
        await d.client.settle({});
        await deps.gateway.observe({ sessionId, cellId, step: id });
        append("action.result", { ok: true }, id);
        ok = true;
      } else {
        const action = actionOf(step) as GuiAction;
        const outcome = await deps.gateway.run({ sessionId, cellId, step: id, signal }, action);
        ok = outcome.ok;
        if (!ok && outcome.cancelled === "user") reason = "stopped";
      }
      append("step.end", { status: ok ? "ok" : signal?.aborted ? "cancelled" : "failed" }, id);
      if (!ok) {
        if (reason !== "stopped") reason = "error";
        break;
      }
      done += 1;
    }
  } catch (err) {
    reason = signal?.aborted ? "stopped" : "error";
    append("agent.state", { state: "error", reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
  }
  if (reason === "done") append("agent.state", { state: "done" });
  else if (reason === "stopped") append("agent.state", { state: "idle", reason: "stopped" });
  append("session.end", { reason });
  return { ok: reason === "done", steps: done };
}
```

Run: `pnpm exec vitest run apps/daemon/src/puppet`
Expected: 5 tests pass.

- [ ] **Step 3: Live sessions, routes and the CLI**

`apps/daemon/src/gateway/live.ts`:
```ts
// One live session per cell; Stop aborts it. M5 extends this into the kill switch.
export class LiveSessions {
  readonly #byCell = new Map<string, { sessionId: string; controller: AbortController }>();

  start(cellId: string, sessionId: string, run: (signal: AbortSignal) => Promise<unknown>): void {
    if (this.#byCell.has(cellId)) throw new Error(`cell ${cellId} already has a live session`);
    const controller = new AbortController();
    this.#byCell.set(cellId, { sessionId, controller });
    run(controller.signal)
      .catch((err) => console.error(`session ${sessionId}: ${String(err)}`))
      .finally(() => {
        if (this.#byCell.get(cellId)?.sessionId === sessionId) this.#byCell.delete(cellId);
      });
  }

  get(cellId: string): string | undefined {
    return this.#byCell.get(cellId)?.sessionId;
  }

  cellOf(sessionId: string): string | undefined {
    for (const [cellId, live] of this.#byCell) if (live.sessionId === sessionId) return cellId;
    return undefined;
  }

  stop(sessionId: string): boolean {
    const cellId = this.cellOf(sessionId);
    if (!cellId) return false;
    this.#byCell.get(cellId)?.controller.abort();
    return true;
  }
}
```

`apps/daemon/src/gateway/routes.ts` — extend the deps and add the routes (keep Task 5's):
```ts
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { EventLog } from "../event-log.ts";
import { runPuppet } from "../puppet/runner.ts";
import { PuppetScript } from "../puppet/script.ts";
import type { FrameStore } from "./frames.ts";
import type { ActionGateway } from "./gateway.ts";
import type { LiveSessions } from "./live.ts";

export interface GatewayRoutesDeps {
  registry: DesktopdRegistry;
  clock: Clock;
  eventLog?: EventLog;
  gateway?: ActionGateway;
  frames?: FrameStore;
  live?: LiveSessions;
}

// inside gatewayRoutes, after the launch route:
  app.post("/api/cells/:id/puppet", (c) =>
    withReadyCell(c, cells, deps, async () => {
      const { eventLog, gateway, live, registry } = deps;
      if (!eventLog || !gateway || !live) return c.text("puppet not available", 503);
      const id = c.req.param("id") ?? "";
      const parsed = PuppetScript.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      if (live.get(id)) return c.text("a session is already live on this cell", 409);
      const sessionId = eventLog.createSession(parsed.data.title);
      live.start(id, sessionId, (signal) =>
        runPuppet({ gateway, eventLog, registry, cells, sleep: (ms, s) => sleep(ms, undefined, { signal: s }) }, { cellId: id, sessionId, script: parsed.data, signal }),
      );
      return c.json({ sessionId }, 202);
    }),
  );

  app.get("/api/cells/:id/live", (c) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
    const sessionId = deps.live?.get(id);
    return sessionId ? c.json({ sessionId }) : c.text("no live session", 404);
  });

  app.post("/api/sessions/:id/stop", (c) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    return deps.live?.stop(id) ? c.body(null, 202) : c.text("no such live session", 404);
  });

  app.get("/api/sessions/:id/frames/:frameId", (c) => {
    const file = deps.frames?.path(c.req.param("id") ?? "", c.req.param("frameId") ?? "");
    if (!file) return c.text("not found", 404);
    return c.body(readFileSync(file), 200, { "content-type": "image/webp", "cache-control": "private, max-age=31536000, immutable" });
  });
```
In `apps/daemon/src/gateway/routes.test.ts`, add the imports
```ts
import { setTimeout as sleep } from "node:timers/promises";
import { FrameStore } from "./frames.ts";
import { ActionGateway } from "./gateway.ts";
import { LiveSessions } from "./live.ts";
import { DEFAULT_ONSET_TABLE } from "./onset-table.ts";
import { keepPolicy } from "./ring-onset.ts";
```
and replace the `eventLog` and `createApp` lines of `setup()` with
```ts
  const home = mkdtempSync(join(tmpdir(), "local dot's routes-"));
  const eventLog = new EventLog(home, clock);
  const frames = new FrameStore(home);
  const gateway = new ActionGateway({ eventLog, cells, registry, onset: DEFAULT_ONSET_TABLE, ringOnset: keepPolicy(DEFAULT_ONSET_TABLE), frames, now: () => clock.nowMicros(), sleep: (ms, signal) => sleep(ms, undefined, { signal }) });
  const app = createApp({ token: TOKEN, port: PORT, eventLog, cells: { cells, tickets: new TicketRegistry() }, gateway: { registry, clock, eventLog, gateway, frames, live: new LiveSessions() } });
```
returning `eventLog` too (`return { app, cells, fake, id, registry, eventLog };`). Then append:
```ts
describe("puppet, live and frame routes", () => {
  it("starts a puppet session, reports it live, serves its frames, and stops it", async () => {
    const { app, id, eventLog } = setup();
    const started = await app.request(url(`/api/cells/${id}/puppet`), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ v: 1, title: "t", steps: [{ do: "wait", ms: 300 }, { do: "wait", ms: 300 }] }) });
    expect(started.status).toBe(202);
    const { sessionId } = (await started.json()) as { sessionId: string };
    expect(await (await app.request(url(`/api/cells/${id}/live`), { headers: bearer })).json()).toEqual({ sessionId });
    expect((await app.request(url(`/api/cells/${id}/puppet`), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ v: 1, title: "t", steps: [{ do: "wait", ms: 1 }] }) })).status).toBe(409);
    await new Promise((r) => setTimeout(r, 50));
    const observe = eventLog.read(sessionId).find((e) => e.type === "observe");
    expect(observe).toBeDefined();
    const frame = await app.request(url(`/api/sessions/${sessionId}/frames/${observe?.type === "observe" ? observe.data.frameId : ""}`), { headers: bearer });
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/webp");
    expect((await app.request(url(`/api/sessions/${sessionId}/frames/01JXYZ0000000000000000ABCD`), { headers: bearer })).status).toBe(404);
    expect((await app.request(url(`/api/sessions/${sessionId}/stop`), { method: "POST", headers: bearer })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(eventLog.read(sessionId).at(-1)).toMatchObject({ type: "session.end", data: { reason: "stopped" } });
    expect((await app.request(url(`/api/cells/${id}/live`), { headers: bearer })).status).toBe(404);
    expect((await app.request(url(`/api/cells/${id}/puppet`), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ v: 1, steps: [] }) })).status).toBe(400);
  });
});
```

`apps/daemon/src/main.ts` — build and wire the pieces (keep the rest; one `FrameStore` serves the
gateway that writes frames and the route that reads them):
```ts
import { setTimeout as sleep } from "node:timers/promises";
import { FrameStore } from "./gateway/frames.ts";
import { ActionGateway } from "./gateway/gateway.ts";
import { LiveSessions } from "./gateway/live.ts";
import { loadOnsetTable } from "./gateway/onset-table.ts";
import { policyFromEnv } from "./gateway/ring-onset.ts";
// ...
const onset = loadOnsetTable(home);
const frames = new FrameStore(home);
const gateway = new ActionGateway({
  eventLog, cells: orchestrator, registry, onset, ringOnset: policyFromEnv(onset),
  frames, now: () => clock.nowMicros(),
  sleep: (ms, signal) => sleep(ms, undefined, { signal }),
});
const app = createApp({ token, port, eventLog, cells: { cells: orchestrator, tickets }, desktop, ui: { dir: webDir("dist") },
  gateway: { registry, clock, eventLog, gateway, frames, live: new LiveSessions() } });
console.log(`ring onset: ${onset.source}${onset.measuredAt ? ` (${onset.measuredAt})` : ""}, policy ${policyFromEnv(onset).name}`);
```

`apps/daemon/src/puppet-main.ts`:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { msToSeconds, sessionMsOf } from "@localdot/protocol";
import { WebSocket } from "ws";
import { localdotHome } from "./paths.ts";
import { parsePort } from "./port.ts";
import { parsePuppetScript } from "./puppet/script.ts";

// usage: pnpm --filter @localdot/daemon puppet <script.json> [--cell <id>]
const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: pnpm --filter @localdot/daemon puppet <script.json> [--cell <id>]");
  process.exit(2);
}
const cellArg = rest.indexOf("--cell") >= 0 ? rest[rest.indexOf("--cell") + 1] : undefined;
const home = localdotHome();
const port = parsePort(process.env.LOCALDOT_PORT);
const origin = `http://127.0.0.1:${port}`;
const token = readFileSync(join(home, "daemon-token"), "utf8").trim();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const script = parsePuppetScript(JSON.parse(readFileSync(file, "utf8")));

const cells = (await (await fetch(`${origin}/api/cells`, { headers })).json()) as { id: string; state: string }[];
const cell = cellArg ? cells.find((c) => c.id === cellArg) : cells.find((c) => c.state === "ready");
if (!cell) {
  console.error("no ready cell; start the computer first");
  process.exit(1);
}
const res = await fetch(`${origin}/api/cells/${cell.id}/puppet`, { method: "POST", headers, body: JSON.stringify(script) });
if (res.status !== 202) {
  console.error(`puppet: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { sessionId } = (await res.json()) as { sessionId: string };
console.log(`session ${sessionId} on cell ${cell.id}`);
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/stream`, ["localdot.v1", `localdot.token.${token}`], { origin });
ws.on("message", (data) => {
  const e = JSON.parse(String(data)) as { t: number; type: string; data: Record<string, unknown> };
  const label = typeof e.data.label === "string" ? ` ${e.data.label}` : e.type === "action.target" ? ` ${JSON.stringify((e.data.target as { role?: string; name?: string }).role)} ${JSON.stringify((e.data.target as { name?: string }).name)}` : "";
  console.log(`${msToSeconds(sessionMsOf(e)).toFixed(3)}s ${e.type}${label}`);
  if (e.type === "session.end") {
    ws.close();
    process.exit(e.data.reason === "done" ? 0 : 1);
  }
});
ws.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
```
`apps/daemon/package.json` scripts — add `"puppet": "tsx src/puppet-main.ts"`.

The demo pages, `cells/desktop/root/opt/localdot/demo/index.html`:
```html
<!doctype html>
<meta charset="utf-8">
<title>localDot demo</title>
<style>body{font:20px/1.5 Inter,sans-serif;margin:48px;color:#222}a{color:#0a58ca}</style>
<h1>localDot demo</h1>
<p>A page that lives inside the computer, for the puppet.</p>
<p><a id="next" href="page2.html">Page two</a></p>
```
`cells/desktop/root/opt/localdot/demo/page2.html`:
```html
<!doctype html>
<meta charset="utf-8">
<title>Page two</title>
<style>body{font:20px/1.5 Inter,sans-serif;margin:48px;color:#222}</style>
<h1>Page two</h1>
<p>You made it.</p>
```

`apps/daemon/puppet/demo-multiapp.json` (the acceptance sequence: open Calc, go to B2 through the
Name Box, type, open Chromium, click a link):
```json
{
  "v": 1,
  "title": "Demo: a sheet and a web page",
  "steps": [
    { "do": "launch", "app": "calc", "waitMs": 9000 },
    { "do": "click", "find": { "name": "Name Box" } },
    { "do": "type", "text": "B2", "label": "Go to B2" },
    { "do": "key", "combo": ["Return"] },
    { "do": "type", "text": "Q3 revenue" },
    { "do": "key", "combo": ["Return"] },
    { "do": "wait", "ms": 10000, "label": "Wait for the sheet" },
    { "do": "launch", "app": "chromium", "args": ["file:///opt/localdot/demo/index.html"], "waitMs": 6000, "label": "Open Chromium" },
    { "do": "click", "find": { "name": "Page two", "role": "link" } },
    { "do": "wait", "ms": 1500, "label": "Done" }
  ]
}
```
`apps/daemon/puppet/oracle.json` (press-acting clicks and typing on the flash page, then the
marker page's password field; the pixel oracle's script). The flash page opens in a normal window,
maximized by `localdot-chromium`, as users' windows are: a `--kiosk` window is unredirected and
would bypass the compositor whose latency the rings must match (P3-C15):
```json
{
  "v": 1,
  "title": "Oracle: press-acting clicks and typing",
  "steps": [
    { "do": "launch", "app": "chromium", "args": ["--new-window", "file:///opt/localdot/flash.html"], "waitMs": 8000, "label": "Open the flash page" },
    { "do": "click", "x": 640, "y": 400, "label": "Click the page (centre)" },
    { "do": "wait", "ms": 600 },
    { "do": "click", "x": 500, "y": 300, "label": "Click the page (upper left)" },
    { "do": "wait", "ms": 600 },
    { "do": "click", "x": 780, "y": 500, "label": "Click the page (lower right)" },
    { "do": "wait", "ms": 600 },
    { "do": "click", "x": 640, "y": 400, "speed": "fast", "label": "Click the page (fast)" },
    { "do": "wait", "ms": 600 },
    { "do": "click", "x": 300, "y": 600, "speed": "instant", "label": "Click the page (instant)" },
    { "do": "wait", "ms": 600 },
    { "do": "type", "text": "abc" },
    { "do": "wait", "ms": 600 },
    { "do": "key", "combo": ["space"] },
    { "do": "wait", "ms": 600 },
    { "do": "launch", "app": "chromium", "args": ["file:///opt/localdot/marker.html"], "waitMs": 5000, "label": "Open the marker page" },
    { "do": "click", "find": { "name": "Password" }, "label": "Click the password field" },
    { "do": "type", "text": "hunter2" },
    { "do": "click", "find": { "name": "marker red", "role": "button" } },
    { "do": "wait", "ms": 1000 }
  ]
}
```

Run: `pnpm exec vitest run apps/daemon/src && pnpm typecheck`
Expected: all daemon suites pass, the routes test included.

- [ ] **Step 4: Run the demo against a real cell**

`cells/desktop/build.sh` (the demo pages), `pnpm --filter @localdot/web build`, start the daemon
from `apps/daemon` with `LOCALDOT_HOME="$(mktemp -d)/home" node --import tsx src/main.ts`, open
the printed `#token=` URL in Chrome, click "Start computer", wait for "Live", then in another
terminal (`LOCALDOT_HOME` set to the same home):
```bash
pnpm --filter @localdot/daemon puppet puppet/demo-multiapp.json
```
Expected: the CLI prints one line per event (`0.012s session.start`, `… action.intent Click
"Name Box"`, `… action.target "text" "Name Box"`, `… action.dispatch`, `… screen.settle`,
`… observe`, …), the desktop in the stage shows Calc's cell B2 receiving `Q3 revenue` and Chromium
navigating to "Page two", and the run ends with `session.end` and exit 0 in about 45 s. No overlays
yet (Tasks 14a–15). Stop the computer and the daemon.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon cells/desktop/root/opt/localdot/demo
git commit -m "feat(daemon): puppet scripts, live sessions, frame and stop routes"
```

---
### Task 11: Part 2's daemon obligations — relay backpressure, checked with two viewers

Part 2 carried two daemon items here. The first, two `#watch` loops on one cell after a user
`start()` during a restart's backoff, Part 2 closed itself: the orchestrator's `#current` guards
(a2531c0) and its per-cell operation queue (bfd71bb) make a late loop stand down. This task only
pins that with a regression test. The second: the stream relay never checked
`client.bufferedAmount`, so a slow viewer grew the daemon's memory. The relay now pauses the
upstream socket above a high-water mark and resumes below a low-water mark, so memory is bounded by
the kernel's socket buffers; Selkies' server then paces itself (a paced viewer sees added latency
until it catches up, never a growing daemon). A pause the relay chooses is not a stall: the stall
watchdog stays fed while it waits, so the cell never reads "stalled" for it, no other viewer sees
"Reconnecting…" and the gateway holds nothing. P3-C6 allows pausing instead of shedding only because
Part 2's `relay()` dials one upstream per viewer, and only if pausing one viewer never stalls
another or the recorder's tap. Selkies' fan-out to its own clients is untested (S8 used one viewer),
so the task ends with two real viewers, one of them frozen.

**Files:**
- Modify: `apps/daemon/src/cells/stream-proxy.ts`
- Create: `apps/web/e2e/two-viewers.spec.ts`
- Test: `apps/daemon/src/cells/orchestrator.test.ts`, `apps/daemon/src/cells/stream-proxy.test.ts`,
  `apps/web/e2e/two-viewers.spec.ts`

**Interfaces:**
- Consumes: Part 2's `relay()` (one upstream per viewer), `startDaemon()` and `desktopContainer(cellId)`
  (`apps/web/e2e/daemon.ts`), the stage canvas's `data-frames`, the HUD's `hud-status`.
- Produces: `RELAY_HIGH_WATER = 4 MiB`, `RELAY_LOW_WATER = 512 KiB`; `StreamProxyDeps` gains
  `highWater?`, `lowWater?`.

- [ ] **Step 1: The regression pin and the failing relay test**

Append to `apps/daemon/src/cells/orchestrator.test.ts`, in `describe("CellOrchestrator restarts")`
(its `setup()` already takes `restartBackoffMs` and `sleep`; `watchEveryMs: 0` and the readiness
sleeps resolve at once while the test holds the 7000 ms backoff):
```ts
  it("a user start() during a restart's backoff leaves exactly one watch loop", async () => {
    const held: (() => void)[] = [];
    const { orchestrator, store, stateOf } = await setup({
      restartBackoffMs: [7000, 7000],
      sleep: (ms) => (ms === 7000 ? new Promise<void>((r) => held.push(r)) : Promise.resolve()),
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    const until = (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (pred() ? resolve() : setTimeout(check, 5));
        check();
      });
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await until(() => (orchestrator.get(cell.id)?.error ?? "").includes("restarting (attempt 1 of 2)"));
    await until(() => held.length === 1);
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    expect(desktop?.starts).toBe(2);
    held[0]?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(desktop?.starts).toBe(2);
    expect(orchestrator.get(cell.id)?.state).toBe("ready");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await until(() => held.length === 2);
    held[1]?.();
    await until(() => desktop?.starts === 3 && orchestrator.get(cell.id)?.state === "ready");
    await new Promise((r) => setTimeout(r, 30));
    expect(desktop?.starts).toBe(3);
  });
```

Append to `apps/daemon/src/cells/stream-proxy.test.ts`:
```ts
  it("pauses the upstream for a slow viewer and drains once the viewer catches up", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl, { highWater: 256 * 1024, lowWater: 64 * 1024 });
    const ws = d.open(`${d.prefix}/api/websockets`);
    await new Promise((r) => ws.once("open", r));
    let got = 0;
    ws.on("message", () => {
      got += 1;
    });
    ws.pause();
    const chunk = Buffer.alloc(256 * 1024, 7);
    const sockets = [...selkies.state.sockets];
    for (let i = 0; i < 64; i++) sockets[0]?.send(chunk);
    await settle(800);
    // The daemon stopped reading: bytes are still queued on Selkies' side of the relay.
    expect(sockets[0]?.bufferedAmount ?? 0).toBeGreaterThan(0);
    // A pause the relay chose is no stall: the cell never reads "stalled" for it, so no other
    // viewer sees "Reconnecting…" and the gateway holds nothing.
    expect(d.connections(d.id)).not.toContain("stalled");
    ws.resume();
    await new Promise<void>((resolve) => {
      const check = () => (got >= 64 ? resolve() : setTimeout(check, 20));
      check();
    });
    expect(sockets[0]?.bufferedAmount).toBe(0);
    ws.close();
  });
```
Extend the test file's `daemon()` helper to take `opts: { highWater?: number; lowWater?: number } = {}`
and spread them into the `desktop` deps object.

Run: `pnpm exec vitest run apps/daemon/src/cells/orchestrator.test.ts apps/daemon/src/cells/stream-proxy.test.ts`
Expected: the orchestrator's new test already passes (Part 2's guards: `starts` stays 2 when the
held backoff ends and reaches 3 only after the second kill); the relay's fails — the daemon reads
everything (`expected 0 to be greater than 0`: Selkies' `bufferedAmount` while the viewer is paused).

- [ ] **Step 2: Implement the backpressure**

`apps/daemon/src/cells/stream-proxy.ts`:
```ts
export const RELAY_HIGH_WATER = 4 * 1024 ** 2;
export const RELAY_LOW_WATER = 512 * 1024;

export interface StreamProxyDeps {
  cells: CellApi;
  tickets: TicketRegistry;
  vendorDir: string;
  pingEveryMs?: number;
  stallAfterMs?: number;
  highWater?: number;
  lowWater?: number;
}
```
and in `relay()`, replace the `upstream.on("message", …)` handler:
```ts
  const highWater = deps.highWater ?? RELAY_HIGH_WATER;
  const lowWater = deps.lowWater ?? RELAY_LOW_WATER;
  let drain: NodeJS.Timeout | undefined;
  // A viewer that cannot keep up must not grow the daemon's memory: above the high-water mark the
  // upstream socket is paused (bounded by kernel buffers) until the viewer drains.
  upstream.on("message", (data, isBinary) => {
    watchdog.touch();
    const viewer = client;
    if (!viewer || viewer.readyState !== WebSocket.OPEN) return;
    viewer.send(data, { binary: isBinary });
    if (drain || viewer.bufferedAmount <= highWater) return;
    upstream.pause();
    drain = setInterval(() => {
      // The relay stopped reading on purpose; the cell's stream is not stalled for that.
      watchdog.touch();
      if (viewer.bufferedAmount < lowWater || viewer.readyState !== WebSocket.OPEN) {
        clearInterval(drain);
        drain = undefined;
        upstream.resume();
      }
    }, 20);
  });
```
and in `upstream.on("close", …)` add `clearInterval(drain);` first.

Run: `pnpm exec vitest run apps/daemon/src/cells/orchestrator.test.ts apps/daemon/src/cells/stream-proxy.test.ts`
Expected: both files pass (the new tests included).

- [ ] **Step 3: Two viewers, one frozen (P3-C6)**

`apps/web/e2e/two-viewers.spec.ts`:
```ts
import { spawnSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
let daemon: RunningDaemon;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images and Docker Desktop");

test.beforeAll(async () => {
  daemon = await startDaemon();
});

test.afterAll(async () => {
  await daemon?.stop();
});

// A patch of noise redrawn on every animation frame: nothing in it compresses, so the stream runs
// at a high rate and a viewer that stops reading backs up within seconds.
const NOISE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>noise</title>
<style>html, body { margin: 0; height: 100%; background: #000; } canvas { position: fixed; left: 50%; top: 50%; width: 160px; height: 100px; transform: translate(-50%, -50%); }</style>
</head><body><canvas width="320" height="200"></canvas><script>
  const g = document.querySelector("canvas").getContext("2d");
  const img = g.createImageData(320, 200);
  const px = new Uint32Array(img.data.buffer);
  const step = () => {
    for (let i = 0; i < px.length; i++) px[i] = (Math.random() * 0x1000000) | 0xff000000;
    g.putImageData(img, 0, 0);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
</script></body></html>
`;

function docker(args: string[], input?: string): string {
  const r = spawnSync("docker", args, { encoding: "utf8", input });
  expect(r.status, `docker ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

// The largest send queue of any established TCP socket in the cell's desktop, in bytes. A frozen
// viewer's backlog ends up there (Selkies → nginx → the gate) once the relay pauses its upstream.
function largestSendQueue(desktop: string): number {
  const tables = docker(["exec", desktop, "sh", "-c", "cat /proc/net/tcp; cat /proc/net/tcp6 2>/dev/null; true"]);
  let largest = 0;
  for (const line of tables.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[3] === "01") largest = Math.max(largest, Number.parseInt(f[4]?.split(":")[0] ?? "0", 16));
  }
  return largest;
}

const framesOf = async (page: Page) => Number(await page.locator("canvas.stage-canvas").getAttribute("data-frames"));

// Frames the page's stage presented per second over `ms`.
async function rate(page: Page, ms: number): Promise<number> {
  const before = await framesOf(page);
  await page.waitForTimeout(ms);
  return ((await framesOf(page)) - before) / (ms / 1000);
}

// P3-C6: the relay may pause a slow viewer's upstream only because each viewer has its own, and
// only if Selkies keeps serving its other clients meanwhile.
test("a frozen viewer never stalls another viewer", async ({ browser }) => {
  test.setTimeout(600_000);
  const a = await (await browser.newContext()).newPage();
  await a.goto(`${daemon.origin}/#token=${daemon.token}`);
  const created = a.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/cells");
  await a.getByRole("button", { name: "Start computer" }).click();
  const cellId = ((await (await created).json()) as { id: string }).id;
  await expect(a.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });

  const desktop = desktopContainer(cellId);
  docker(["exec", "-i", "-u", "abc", desktop, "sh", "-c", "cat > /tmp/noise.html"], NOISE);
  docker(["exec", "-d", "-u", "abc", "-e", "DISPLAY=:1", desktop, "/usr/local/bin/localdot-chromium", "--new-window", "file:///tmp/noise.html"]);

  const b = await (await browser.newContext()).newPage();
  await b.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(b.getByTestId("hud-status")).toHaveText("Live", { timeout: 120_000 });
  await expect.poll(() => rate(b, 2000), { timeout: 90_000 }).toBeGreaterThan(10);
  const steady = await rate(b, 5000);
  const aBefore = await framesOf(a);

  // Frozen, viewer A's page stops reading its socket: the browser's buffers fill, then the relay's
  // high-water mark pauses A's upstream, and A's backlog piles up inside the cell.
  const cdp = await a.context().newCDPSession(a);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  let backedUp = 0;
  for (let n = 1; n <= 6; n++) {
    const r = await rate(b, 5000);
    backedUp = Math.max(backedUp, largestSendQueue(desktop));
    expect(r, `viewer B's frames per second in window ${n} of A's freeze (steady ${steady.toFixed(1)})`).toBeGreaterThan(steady / 2);
    await expect(b.getByTestId("hud-status")).toHaveText("Live");
  }
  expect(backedUp, "viewer A's freeze never backed up into the cell, so B's rate proves nothing").toBeGreaterThan(128 * 1024);

  // Thawed, viewer A drains its backlog and the relay resumes its upstream.
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await a.bringToFront();
  await expect.poll(() => framesOf(a), { timeout: 60_000 }).toBeGreaterThan(aBefore);

  await a.getByRole("button", { name: "Stop computer" }).click();
  await expect(a.getByTestId("hud-status")).toHaveText("Stopped", { timeout: 60_000 });
});
```

Run:
```bash
pnpm --filter @localdot/web build && LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e --grep "frozen viewer"
```
Expected: 1 test passes in about 4 minutes; viewer B keeps more than half its steady frame rate and
its "Live" HUD in all six 5-second windows of A's freeze, the cell's largest send queue passes
128 KiB, and A's frame count rises again after the thaw. If B's rate drops, Selkies' fan-out couples its clients and P3-C6
forbids pausing: the relay must shed a slow viewer's frames instead. Stop, put the six rates and the
send queue in the commit message, and tell the controller before Task 13. If only the 128 KiB check
fails, the freeze never reached the cell: lengthen the freeze (more windows) until it does; never
drop the check.

- [ ] **Step 4: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells apps/web/e2e/two-viewers.spec.ts
git commit -m "fix(daemon): pause a slow viewer's upstream, proven not to stall another viewer"
```

---
### Task 12: Docker requests that cannot hang the daemon

Part 2's F25, carried as a Part 3 obligation (Part 2's plan, "Part 3 obligations"; P3-C16's F16):
a wedged Docker Desktop accepts connections on its socket and never answers, and the daemon then
hangs, because `DockerClient` waits forever and `main.ts` awaits the startup `reconcile()` before
`serve()`. Each request now carries an `AbortSignal` timeout, and the reconcile runs in the
background: the UI loads at once and shows each cell as `failed` with the reason once its
requests time out.

**Files:**
- Modify: `apps/daemon/src/cells/docker.ts`, `apps/daemon/src/main.ts`
- Create: `apps/daemon/src/main.test.ts`
- Test: `apps/daemon/src/cells/docker.test.ts`, `apps/daemon/src/main.test.ts`

**Interfaces:**
- Consumes: Part 2's `DockerClient`, `CellStore`, `sampleRecord()` (`cells/testing/sample-record.ts`),
  `findDockerSocket()` (reads `DOCKER_HOST`).
- Produces: `DOCKER_TIMEOUT_MS = 30_000`; `new DockerClient(socketPath?, timeoutMs = DOCKER_TIMEOUT_MS)`;
  `DockerRequest.timeoutMs?` (one request's own limit); a request with no reply in time rejects
  with `DockerError` status 0 and "no reply within … ms; is Docker Desktop responding?".

- [ ] **Step 1: Failing tests**

Append to `apps/daemon/src/cells/docker.test.ts`, in `describe("DockerClient")`:
```ts
  it("gives up on a socket that never answers", async () => {
    const socketPath = await listen(() => {});
    const started = Date.now();
    const err = await new DockerClient(socketPath, 200).request({ method: "GET", path: "/containers/c1/json" }).catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ status: 0, path: "/containers/c1/json" });
    expect((err as Error).message).toContain("no reply within 200 ms");
    expect(Date.now() - started).toBeLessThan(2000);
    const own = await new DockerClient(socketPath).request({ method: "GET", path: "/version", timeoutMs: 50 }).catch((e) => e);
    expect((own as Error).message).toContain("no reply within 50 ms");
  });
```

`apps/daemon/src/main.test.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CellStore } from "./cells/store.ts";
import { sampleRecord } from "./cells/testing/sample-record.ts";

const DAEMON_DIR = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess | undefined;
let wedged: Server | undefined;

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  const server = wedged;
  wedged = undefined;
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

// A Docker socket that accepts every connection and never answers, as a wedged Docker Desktop does.
// It reads what arrives, so it sees each client go away and can close.
async function wedgedDocker(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "ld-wedged-")), "d.sock");
  const server = createServer((socket) => socket.resume());
  wedged = server;
  await new Promise<void>((r) => server.listen(path, r));
  return path;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

describe("daemon startup", () => {
  it("serves while a wedged Docker holds the cells' reconcile", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "local dot's main-")), "home");
    new CellStore(home).save(sampleRecord());
    const socket = await wedgedDocker();
    const port = await freePort();
    let stderr = "";
    child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: DAEMON_DIR,
      env: { ...process.env, LOCALDOT_HOME: home, LOCALDOT_PORT: String(port), DOCKER_HOST: `unix://${socket}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    let status = 0;
    const deadline = Date.now() + 10_000;
    while (status !== 200 && Date.now() < deadline) {
      status = await fetch(`http://127.0.0.1:${port}/healthz`).then(
        (r) => r.status,
        () => 0,
      );
      if (status !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    expect(status, `no /healthz answer while Docker said nothing; stderr: ${stderr}`).toBe(200);
  }, 15_000);
});
```

Run: `pnpm exec vitest run apps/daemon/src/cells/docker.test.ts apps/daemon/src/main.test.ts`
Expected: FAIL — the wedged request never settles (`Test timed out in 5000ms`), and the daemon
never answers `/healthz` while its reconcile waits on Docker.

- [ ] **Step 2: Implement**

`apps/daemon/src/cells/docker.ts`:
- after `DOCKER_API`, add
  ```ts
  // A wedged Docker Desktop accepts the connection and never answers: no request waits longer than
  // this. Stopping a container waits out its 10 s grace period well inside it.
  export const DOCKER_TIMEOUT_MS = 30_000;
  ```
- `DockerRequest` gains `timeoutMs?: number;`;
- the constructor becomes `constructor(readonly socketPath: string = dockerSocketPath(), readonly timeoutMs: number = DOCKER_TIMEOUT_MS)`;
- in `#send`, before `return new Promise`, add `const timeoutMs = req.timeoutMs ?? this.timeoutMs;`,
  replace `unreachable` with
  ```ts
        const unreachable = (err: NodeJS.ErrnoException) =>
          reject(
            err.name === "AbortError"
              ? new DockerError(0, `no reply within ${timeoutMs} ms; is Docker Desktop responding?`, req.path)
              : new DockerError(0, `${err.code ?? err.message}; is Docker Desktop running?`, req.path),
          );
  ```
  and add `signal: AbortSignal.timeout(timeoutMs),` to the `httpRequest` options, after `path`.

`apps/daemon/src/main.ts` — replace the comment above the awaited `orchestrator.reconcile()` and
that statement with:
```ts
// The daemon serves the UI without Docker, and a wedged Docker must not keep it from loading: the
// reconcile runs in the background, and the UI shows each cell as it comes back, or as failed.
void orchestrator.reconcile().catch((err) => console.error(`cell reconcile failed: ${String(err)}`));
```

Run: `pnpm exec vitest run apps/daemon/src/cells/docker.test.ts apps/daemon/src/main.test.ts apps/daemon/src/cells/orchestrator.test.ts`
Expected: all three files pass.

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells/docker.ts apps/daemon/src/cells/docker.test.ts apps/daemon/src/main.ts apps/daemon/src/main.test.ts
git commit -m "fix(daemon): time out Docker requests and reconcile cells without blocking startup"
```

---
### Task 13: The stage model — `render(log, t, view)` as a pure function

`@localdot/stage` folds the event log into a model and samples a `Scene` for any time: cursor
position and press state, the target box or crosshair, click rings, the typing pill, keycap chips,
the cancel shake and the HUD state. It is pure and closed-form (research §4.1: replay equals live),
so the worker only draws it, the tests pin the truthfulness rules, and the oracle compares it with
pixels. Times inside the model are session **milliseconds** (`sessionMsOf(e)`; `microsToMs(pressT)`, `microsToMs(ringAt)` — the protocol's time helper, P3-C2);
geometry is desktop device pixels. The camera (desktop → canvas) is a separate pure module.

**Files:**
- Create: `packages/stage/src/model.ts`, `packages/stage/src/scene.ts`, `packages/stage/src/camera.ts`
- Modify: `packages/stage/src/index.ts`
- Test: `packages/stage/src/model.test.ts`, `packages/stage/src/scene.test.ts`, `packages/stage/src/camera.test.ts`

**Interfaces:**
- Consumes: `@localdot/protocol` events, `clipText`, `keyDisplayName` (Task 7); `pointerAt`, `springValue`, the `timing.ts` constants (Task 2).
- Produces: `SessionModel` (with `agentStates`, every `agent.state` in log order), `ActionState`, `emptyModel()`,
  `foldEvents(model, events): SessionModel` (mutates and returns `model`), `agentStateAt(model, tMs)` (the state in effect at `tMs`),
  `View { reducedMotion: boolean }`, `Scene { control; cursor; target; rings; typing; keycaps; cancel; hud }` and its parts
  (`CursorScene { x; y; visible; alpha; press; hand; chipAlpha; name; floating }`, `TargetScene { style; rect | null; point; alpha; chip? }`,
  `RingScene { x; y; p; style }`, `TypingScene { anchor; text; more; masked; caretOn; alpha }`, `KeycapsScene { keys; alpha; scale; dy }`
  (`dy`: CSS px below the chips' resting place, 20 → 0 while they pop in),
  `CancelScene { x; y; dx; reason; alpha }`, `HudScene { label; state; control; elapsedMs }`),
  `sceneAt(model, tMs, view): Scene`, `render(log, tMs, view): Scene`, `CURSOR_NAME = "dot"`, `keycapNames(combo)`;
  `Camera { scale; tx; ty }`, `cameraFor({ stageW, stageH, desktopW, desktopH, zoom, focus? }): Camera`, `toCanvas(cam, p)`, `toWorld(cam, p)`.

- [ ] **Step 1: Write the failing model and scene tests**

`packages/stage/src/model.test.ts`:
```ts
import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyModel, foldEvents } from "./model.ts";

let seq = 0;
const ev = (type: string, tMs: number, data: Record<string, unknown>, step?: string): LocalDotEvent =>
  ({ v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: seq++, t: msToMicros(tMs), agent: "main", ...(step ? { step } : {}), type, data }) as LocalDotEvent;

const click = (startMs: number, step: string): LocalDotEvent[] => [
  ev("action.intent", startMs, { verb: "click", label: "Click A", point: { x: 300, y: 400 }, risk: "none", pointer: { from: { x: 100, y: 100 }, to: { x: 300, y: 400 }, startsAt: startMs + 120, durationMs: 400, seed: 1, curve: "minjerk-bow-v1" } }, step),
  ev("action.target", startMs + 50, { target: { point: { x: 300, y: 400 }, bbox: { x: 280, y: 380, w: 40, h: 40 }, source: "ax", role: "button", name: "A" } }, step),
  ev("action.dispatch", startMs + 615, { input: { kind: "click", button: "left", count: 1, at: { x: 300, y: 400 } }, pressT: msToMicros(startMs + 612), ringAt: msToMicros(startMs + 635.1), injector: "xtest" }, step),
  ev("screen.settle", startMs + 900, { frameT: msToMicros(startMs + 700), changed: [], noVisibleChange: false }, step),
  ev("observe", startMs + 1200, { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", width: 1280, height: 800 }, step),
  ev("action.result", startMs + 1210, { ok: true }, step),
];

describe("foldEvents", () => {
  it("builds one action per intent and attaches the rest by step, converting times to ms", () => {
    const m = foldEvents(emptyModel(), [ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "t" }), ev("agent.state", 1, { state: "acting" }), ...click(1000, "s1"), ...click(3000, "s2")]);
    expect(m.screen).toEqual({ w: 2560, h: 1600, scale: 2 });
    expect(m.actions).toHaveLength(2);
    const a = m.actions[0];
    expect(a).toMatchObject({ verb: "click", label: "Click A", intentT: 1000, step: "s1", ok: true, resultT: 2210, settleT: 1900 });
    expect(a?.plan?.startsAt).toBe(1120);
    expect(a?.target?.name).toBe("A");
    expect(a?.dispatch).toMatchObject({ t: 1615, pressT: 1612, ringAt: 1635.1 });
    expect(m.actions[1]?.intentT).toBe(3000);
  });

  it("is incremental: folding in two halves equals folding at once", () => {
    const events = [ev("agent.state", 1, { state: "acting" }), ...click(1000, "s1"), ev("text.progress", 2300, { count: 2, chunk: "hi", masked: false }, "s1"), ev("session.end", 5000, { reason: "done" })];
    const whole = foldEvents(emptyModel(), events);
    const halves = foldEvents(foldEvents(emptyModel(), events.slice(0, 4)), events.slice(4));
    expect(halves).toEqual(whole);
    expect(whole.ended).toEqual({ t: 5000, reason: "done" });
  });

  it("attaches events without a step to the latest action and records cancels", () => {
    const m = foldEvents(emptyModel(), [ev("action.intent", 10, { verb: "key", label: "Press Return", risk: "none" }), ev("action.cancel", 50, { reason: "timeout", detail: "no press" })]);
    expect(m.actions[0]?.cancel).toEqual({ t: 50, reason: "timeout" });
  });
});
```

`packages/stage/src/scene.test.ts`:
```ts
import { type LocalDotEvent, msToMicros, sessionMsOf } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyModel, foldEvents } from "./model.ts";
import { pointerAt } from "./pointer-path.ts";
import { keycapNames, render, sceneAt } from "./scene.ts";
import { RING_FADE_MS, TARGET_HOLD_MS } from "./timing.ts";

let seq = 0;
const ev = (type: string, tMs: number, data: Record<string, unknown>, step?: string): LocalDotEvent =>
  ({ v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: seq++, t: msToMicros(tMs), agent: "main", ...(step ? { step } : {}), type, data }) as LocalDotEvent;
const plan = { from: { x: 100, y: 100 }, to: { x: 300, y: 400 }, startsAt: 1120, durationMs: 400, seed: 1, curve: "minjerk-bow-v1" as const };
const base = (): LocalDotEvent[] => [ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux" }), ev("agent.state", 1, { state: "acting" })];
const intent = ev("action.intent", 1000, { verb: "click", label: "Click A", point: { x: 300, y: 400 }, risk: "none", pointer: plan }, "s1");
const target = ev("action.target", 1300, { target: { point: { x: 300, y: 400 }, bbox: { x: 280, y: 380, w: 40, h: 40 }, source: "ax", role: "button", name: "A" } }, "s1");
const dispatch = ev("action.dispatch", 1615, { input: { kind: "click", button: "left", count: 1, at: { x: 300, y: 400 } }, pressT: 1_612_000, ringAt: 1_635_100, injector: "xtest" }, "s1");
const result = ev("action.result", 2210, { ok: true }, "s1");
const view = { reducedMotion: false };
// A session's log numbers its events in order, and foldEvents skips any seq it has passed. The
// fixtures above are shared between logs, so each log is numbered by position before it is folded.
const inOrder = (log: LocalDotEvent[]): LocalDotEvent[] => log.map((e, i) => ({ ...e, seq: i }));
const fold = (log: LocalDotEvent[]) => foldEvents(emptyModel(), inOrder(log));
const motion = (log: LocalDotEvent[], t: number) => sceneAt(fold(log), t, view);

describe("cursor", () => {
  it("is hidden before the first intent, then follows the plan and sits exactly on the dispatch point", () => {
    expect(motion(base(), 500).cursor?.visible ?? false).toBe(false);
    const log = [...base(), intent, target, dispatch, result];
    expect(motion(log, 1050).cursor).toMatchObject({ x: 100, y: 100, visible: true });
    const mid = motion(log, 1300).cursor;
    const expected = pointerAt(plan, 1300);
    expect(mid?.x).toBeCloseTo(expected.x, 9);
    expect(mid?.y).toBeCloseTo(expected.y, 9);
    expect(motion(log, 1612).cursor).toMatchObject({ x: 300, y: 400 });
    expect(motion(log, 1700).cursor).toMatchObject({ x: 300, y: 400 });
  });

  it("stays where it was when an action is cancelled mid-travel", () => {
    const log = [...base(), intent, ev("action.cancel", 1300, { reason: "user" }, "s1")];
    const at = pointerAt(plan, 1300);
    expect(motion(log, 1500).cursor?.x).toBeCloseTo(at.x, 9);
    expect(motion(log, 1500).cancel).toMatchObject({ reason: "user" });
  });

  it("cross-fades instead of travelling under reduced motion and never sits between the ends", () => {
    const log = [...base(), intent, dispatch, result];
    const s = sceneAt(fold(log), 1300, { reducedMotion: true });
    expect([100, 300]).toContain(s.cursor?.x);
    expect(s.cursor?.alpha).toBeLessThanOrEqual(1);
  });

  it("dims while thinking and hides after a minute idle", () => {
    const log = [...base(), intent, dispatch, result, ev("agent.state", 2300, { state: "thinking" })];
    expect(motion(log, 2400).cursor?.alpha).toBeCloseTo(0.7, 6);
    expect(motion(log, 2400).cursor?.floating).toBe(true);
    // Idle from the result at 2210: resting (dimmed and floating) after 1.2 s even without a thinking
    // state (research §4.5); the fade starts a minute later and takes FADE_MS (180 ms).
    const idle = [...base(), intent, dispatch, result];
    expect(motion(idle, 2210 + 1100).cursor).toMatchObject({ alpha: 1, floating: false });
    expect(motion(idle, 2210 + 1300).cursor).toMatchObject({ alpha: 0.7, floating: true });
    expect(motion(idle, 2210 + 60_001).cursor?.visible).toBe(true);
    expect(motion(idle, 2210 + 60_001).cursor?.alpha).toBeLessThan(0.7);
    expect(motion(idle, 2210 + 60_000 + 180).cursor?.visible).toBe(false);
  });

  it("appears at the target and fades in over 150 ms in Instant mode (a plan with no travel)", () => {
    const instant = ev("action.intent", 1000, { verb: "click", label: "Click A", point: { x: 300, y: 400 }, risk: "none", pointer: { ...plan, startsAt: 1000, durationMs: 0 } }, "s1");
    const log = [...base(), instant];
    expect(motion(log, 1000).cursor).toMatchObject({ x: 300, y: 400, visible: true, alpha: 0 });
    expect(motion(log, 1075).cursor).toMatchObject({ x: 300, y: 400 });
    expect(motion(log, 1075).cursor?.alpha).toBeCloseTo(0.5, 6);
    expect(motion(log, 1150).cursor?.alpha).toBe(1);
    expect(motion(log, 1150).cursor?.press).toBe(0);
  });
});

describe("rings and target", () => {
  const log = [...base(), intent, target, dispatch, result];
  it("shows no ring before ringAt, one ring at ringAt, none after 300 ms", () => {
    expect(motion(log, 1612).rings).toEqual([]);
    expect(motion(log, 1635).rings).toEqual([]);
    expect(motion(log, 1635.1).rings).toMatchObject([{ x: 300, y: 400, p: 0, style: "left" }]);
    expect(motion(log, 1635.1 + RING_FADE_MS - 1).rings).toHaveLength(1);
    expect(motion(log, 1635.1 + RING_FADE_MS).rings).toEqual([]);
  });

  it("draws two rings 90 ms apart for a double click and a dashed one for the right button", () => {
    const dbl = ev("action.dispatch", 1615, { input: { kind: "click", button: "right", count: 2, at: { x: 300, y: 400 } }, pressT: 1_612_000, ringAt: 1_635_100, injector: "xtest" }, "s1");
    const s = motion([...base(), intent, dbl, result], 1730);
    expect(s.rings).toHaveLength(2);
    expect(s.rings[0]?.style).toBe("right");
    expect((s.rings[0]?.p ?? 0) - (s.rings[1]?.p ?? 0)).toBeCloseTo(90 / RING_FADE_MS, 6);
  });

  it("shows a crosshair until the target arrives, then the box, held 900 ms after dispatch", () => {
    expect(motion(log, 1200).target).toMatchObject({ style: "acting", rect: null, point: { x: 300, y: 400 } });
    // One second after the target event the critically damped spring (response 0.31 s) has
    // settled to within 1e-3 px; the box is still held (dispatch 1615 + 900 + 300 = 2815).
    const boxed = motion(log, 1300 + 1000).target;
    expect(boxed?.rect?.x).toBeCloseTo(280, 3);
    expect(boxed?.rect?.y).toBeCloseTo(380, 3);
    expect(boxed?.rect?.w).toBeCloseTo(40, 3);
    expect(boxed?.rect?.h).toBeCloseTo(40, 3);
    expect(boxed?.chip).toBe("button · A");
    expect(boxed?.alpha).toBe(1);
    expect(motion(log, 1615 + TARGET_HOLD_MS + 299).target?.alpha).toBeGreaterThan(0);
    expect(motion(log, 1615 + TARGET_HOLD_MS + 301).target).toBeNull();
  });

  it("morphs the box with a spring and snaps under reduced motion", () => {
    const early = motion(log, 1310).target?.rect;
    expect(early?.w).toBeGreaterThan(36);
    expect(early?.w).toBeLessThan(40);
    const snap = sceneAt(fold(log), 1310, { reducedMotion: true }).target?.rect;
    expect(snap).toEqual({ x: 280, y: 380, w: 40, h: 40 });
  });
});

describe("typing and keys", () => {
  const typeIntent = ev("action.intent", 1000, { verb: "type", label: 'Type "hello world"', point: { x: 200, y: 200 }, risk: "none" }, "s2");
  const typeDispatch = ev("action.dispatch", 1100, { input: { kind: "type", chars: 11, masked: false }, pressT: 1_098_000, ringAt: 1_127_300, injector: "xtest" }, "s2");
  const progress = (t: number, count: number, chunk: string) => ev("text.progress", t, { count, chunk, masked: false }, "s2");
  const log = [...base(), typeIntent, typeDispatch, progress(1130, 1, "h"), progress(1165, 2, "e"), progress(1200, 5, "llo"), progress(1400, 11, " world"), ev("action.result", 1900, { ok: true }, "s2")];

  it("never shows more characters than typed and holds the pill 500 ms after the last chunk", () => {
    expect(motion(log, 1120).typing).toBeNull();
    expect(motion(log, 1130).typing?.text).toBe("h");
    expect(motion(log, 1199).typing?.text).toBe("he");
    expect(motion(log, 1200).typing?.text).toBe("hello");
    expect(motion(log, 1500).typing?.text).toBe("hello world");
    for (const t of [1130, 1150, 1199, 1250, 1399, 1400, 1800]) {
      const typed = log.filter((e) => e.type === "text.progress" && sessionMsOf(e) <= t).map((e) => (e.type === "text.progress" ? e.data.count : 0));
      expect((motion(log, t).typing?.text.length ?? 0) + (motion(log, t).typing?.more ?? 0)).toBeLessThanOrEqual(Math.max(0, ...typed));
    }
    // The result (1900) came after the last progress line (1400): the hold counts from the result.
    expect(motion(log, 1900 + 499).typing).not.toBeNull();
    expect(motion(log, 1900 + 501).typing).toBeNull();
    // The other order: a last chunk after the result keeps the pill until that chunk + 500 ms.
    const lateChunk = [...log.filter((e) => e.type !== "action.result"), ev("action.result", 1300, { ok: true }, "s2")];
    expect(motion(lateChunk, 1400 + 499).typing?.text).toBe("hello world");
    expect(motion(lateChunk, 1400 + 501).typing).toBeNull();
  });

  it("renders masked typing as dots and never more characters than typed", () => {
    const masked = [...base(), typeIntent, ev("action.dispatch", 1100, { input: { kind: "type", chars: 7, masked: true }, pressT: 1_098_000, ringAt: 1_127_300, injector: "xtest" }, "s2"), ev("text.progress", 1200, { count: 3, masked: true }, "s2"), ev("text.progress", 1400, { count: 7, masked: true }, "s2")];
    expect(motion(masked, 1300).typing).toMatchObject({ text: "•••", masked: true });
    expect(motion(masked, 1500).typing?.text).toBe("•••••••");
  });

  it("truncates a long paste to the last 60 characters with a +N more count", () => {
    const long = [...base(), typeIntent, typeDispatch, ev("text.progress", 1200, { count: 100, chunk: "x".repeat(100), masked: false }, "s2")];
    expect(motion(long, 1300).typing).toMatchObject({ more: 40 });
    expect(motion(long, 1300).typing?.text.length).toBe(60);
  });

  it("shows keycaps for a combo from the key onset, popping in then fading", () => {
    const keys = [...base(), ev("action.intent", 1000, { verb: "key", label: "Press Ctrl+L", risk: "none" }, "s3"), ev("action.dispatch", 1100, { input: { kind: "key", combo: ["ctrl", "l"] }, pressT: 1_098_000, ringAt: 1_127_300, injector: "xtest" }, "s3")];
    expect(motion(keys, 1120).keycaps).toBeNull();
    expect(motion(keys, 1127.3).keycaps).toMatchObject({ keys: ["Ctrl", "L"], scale: 0.5, dy: 20 });
    expect(motion(keys, 1127.3 + 200).keycaps).toMatchObject({ scale: 1, dy: 0 });
    expect(motion(keys, 1127.3 + 200 + 1500 + 301).keycaps).toBeNull();
    expect(keycapNames(["ctrl", "shift", "s"])).toEqual(["Ctrl", "Shift", "S"]);
    expect(keycapNames(["Return"])).toEqual(["Return"]);
  });
});

describe("hud and control", () => {
  it("lights control while the agent acts and turns it off at the end", () => {
    const log = [...base(), intent, dispatch, result, ev("agent.state", 2300, { state: "done" }), ev("session.end", 2301, { reason: "done" })];
    expect(motion(log, 1500)).toMatchObject({ control: true, hud: { label: "Click A", state: "working" } });
    expect(motion(log, 2400)).toMatchObject({ control: false, hud: { state: "done" } });
    expect(motion(log, 1500).hud.elapsedMs).toBe(1500);
  });

  it("reads the agent state in effect at t, not the latest one", () => {
    const log = [...base(), intent, dispatch, result, ev("agent.state", 2300, { state: "thinking" }), ev("agent.state", 2600, { state: "acting" })];
    expect(motion(log, 2400).cursor?.floating).toBe(true);
    expect(motion(log, 2700).cursor?.alpha).toBe(1);
    expect(motion(log, 2700).hud.label).toBe("Click A");
    expect(motion([...base(), ev("agent.state", 500, { state: "thinking" })], 400).hud.label).toBe("");
  });
});

describe("determinism", () => {
  it("renders the same log identically twice at many times", () => {
    const log = [...base(), intent, target, dispatch, result];
    for (let t = 900; t < 3000; t += 7.3) expect(render(inOrder(log), t, view)).toEqual(render(inOrder(log), t, view));
  });
});
```

`packages/stage/src/camera.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { cameraFor, toCanvas, toWorld } from "./camera.ts";

describe("cameraFor", () => {
  it("letterboxes the desktop into the stage at zoom 1", () => {
    const cam = cameraFor({ stageW: 1888, stageH: 1180, desktopW: 2560, desktopH: 1600, zoom: 1 });
    expect(cam.scale).toBeCloseTo(1888 / 2560, 9);
    expect(toCanvas(cam, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(toCanvas(cam, { x: 2560, y: 1600 }).x).toBeCloseTo(1888, 6);
    expect(toWorld(cam, toCanvas(cam, { x: 300, y: 400 }))).toEqual({ x: 300, y: 400 });
  });

  it("centres a 2x zoom on the focus and clamps at the desktop edges", () => {
    const centred = cameraFor({ stageW: 1888, stageH: 1180, desktopW: 2560, desktopH: 1600, zoom: 2, focus: { x: 1280, y: 800 } });
    expect(toCanvas(centred, { x: 1280, y: 800 })).toEqual({ x: 944, y: 590 });
    const corner = cameraFor({ stageW: 1888, stageH: 1180, desktopW: 2560, desktopH: 1600, zoom: 2, focus: { x: 0, y: 0 } });
    expect(toCanvas(corner, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});
```

Run: `pnpm exec vitest run packages/stage/src/model.test.ts packages/stage/src/scene.test.ts packages/stage/src/camera.test.ts`
Expected: FAIL — the three modules do not exist.

- [ ] **Step 2: Implement the model**

`packages/stage/src/model.ts`:
```ts
import { type EventOf, type Input, type LocalDotEvent, microsToMs, type Point, type PointerPlan, sessionMsOf, type Target } from "@localdot/protocol";

export interface Progress {
  t: number;
  count: number;
  chunk?: string;
  masked: boolean;
}

export interface Dispatch {
  t: number;
  input: Input;
  pressT: number;
  ringAt: number;
}

export interface ActionState {
  id: string;
  step?: string;
  verb: EventOf<"action.intent">["data"]["verb"];
  label: string;
  intentT: number;
  point?: Point;
  plan?: PointerPlan;
  target?: Target;
  targetT?: number;
  dispatch?: Dispatch;
  progress: Progress[];
  settleT?: number;
  resultT?: number;
  ok?: boolean;
  cancel?: { t: number; reason: string };
}

export interface AgentStateAt {
  state: string;
  t: number;
}

export interface SessionModel {
  screen: { w: number; h: number; scale: number } | null;
  title: string | null;
  startT: number | null;
  // Every agent.state in log order: a scene at any t reads the state in effect then, so replay
  // equals live (research §4.1).
  agentStates: AgentStateAt[];
  ended: { t: number; reason: string } | null;
  actions: ActionState[];
  lastSeq: number;
}

export function emptyModel(): SessionModel {
  return { screen: null, title: null, startT: null, agentStates: [], ended: null, actions: [], lastSeq: -1 };
}

export function agentStateAt(model: SessionModel, t: number): AgentStateAt | undefined {
  for (let i = model.agentStates.length - 1; i >= 0; i--) {
    const s = model.agentStates[i];
    if (s && s.t <= t) return s;
  }
  return undefined;
}

// Mutates and returns `model`; events already folded (seq ≤ lastSeq) are skipped, so a stream
// that replays its backlog is harmless.
export function foldEvents(model: SessionModel, events: Iterable<LocalDotEvent>): SessionModel {
  for (const e of events) {
    if (e.seq <= model.lastSeq) continue;
    model.lastSeq = e.seq;
    const t = sessionMsOf(e);
    switch (e.type) {
      case "session.start":
        model.screen = e.data.screen;
        model.title = e.data.title ?? null;
        model.startT = t;
        break;
      case "session.end":
        model.ended = { t, reason: e.data.reason };
        break;
      case "agent.state":
        model.agentStates.push({ state: e.data.state, t });
        break;
      case "action.intent":
        model.actions.push({
          id: e.id,
          ...(e.step ? { step: e.step } : {}),
          verb: e.data.verb,
          label: e.data.label,
          intentT: t,
          ...(e.data.point ? { point: e.data.point } : {}),
          ...(e.data.pointer ? { plan: e.data.pointer } : {}),
          progress: [],
        });
        break;
      case "action.target": {
        const a = current(model, e.step);
        if (a) {
          a.target = e.data.target;
          a.targetT = t;
        }
        break;
      }
      case "action.dispatch": {
        const a = current(model, e.step);
        if (a) a.dispatch = { t, input: e.data.input, pressT: microsToMs(e.data.pressT), ringAt: microsToMs(e.data.ringAt) };
        break;
      }
      case "text.progress": {
        const a = current(model, e.step);
        if (a) a.progress.push({ t, count: e.data.count, masked: e.data.masked, ...(e.data.chunk !== undefined ? { chunk: e.data.chunk } : {}) });
        break;
      }
      case "screen.settle": {
        const a = current(model, e.step);
        if (a) a.settleT = t;
        break;
      }
      case "action.result": {
        const a = current(model, e.step);
        if (a) {
          a.resultT = t;
          a.ok = e.data.ok;
        }
        break;
      }
      case "action.cancel": {
        const a = current(model, e.step);
        if (a) a.cancel = { t, reason: e.data.reason };
        break;
      }
      default:
        break;
    }
  }
  return model;
}

function current(model: SessionModel, step: string | undefined): ActionState | undefined {
  if (step) {
    for (let i = model.actions.length - 1; i >= 0; i--) {
      const a = model.actions[i];
      if (a?.step === step) return a;
    }
  }
  return model.actions.at(-1);
}
```

- [ ] **Step 3: Implement the scene and the camera**

`packages/stage/src/scene.ts`:
```ts
import { clipText, keyDisplayName, type LocalDotEvent, msToSeconds, type Point, type Rect } from "@localdot/protocol";
import { type ActionState, agentStateAt, emptyModel, foldEvents, type SessionModel } from "./model.ts";
import { pointerAt } from "./pointer-path.ts";
import { springValue } from "./spring.ts";
import {
  CANCEL_SHAKE_MS,
  CARET_PERIOD_MS,
  CHIP_FADE_MS,
  CHIP_SHOW_MS,
  CURSOR_DIM_AFTER_MS,
  CURSOR_HIDE_AFTER_MS,
  DOUBLE_CLICK_GAP_MS,
  KEYCAP_FADE_MS,
  KEYCAP_IN_MS,
  KEYCAP_LINGER_MS,
  PRESS_MS,
  RING_FADE_MS,
  TARGET_FADE_MS,
  TARGET_HOLD_MS,
  TARGET_IN_MS,
  TARGET_SPRING,
  TYPING_HOLD_MS,
} from "./timing.ts";

export const CURSOR_NAME = "dot";
const CROSSHAIR_PX = 36;
const FADE_MS = 180;
const RELEASE_MS = 150;
const REDUCED_FADE_MS = 120;
const INSTANT_FADE_MS = 150;
const CANCEL_CHIP_MS = 1500;
const PILL_MAX = 60;
const CLICKABLE = new Set(["button", "link", "push button", "menu item", "check box", "radio button", "toggle button", "tab", "page tab", "menu"]);
const KEYCAP_RISE_PX = 20;

export interface View {
  reducedMotion: boolean;
}

export interface CursorScene {
  x: number;
  y: number;
  visible: boolean;
  alpha: number;
  press: number;
  hand: boolean;
  chipAlpha: number;
  name: string;
  floating: boolean;
}

export interface TargetScene {
  style: "acting" | "looking";
  rect: Rect | null;
  point: Point;
  alpha: number;
  chip?: string;
}

export interface RingScene {
  x: number;
  y: number;
  p: number;
  style: "left" | "right";
}

export interface TypingScene {
  anchor: Point;
  text: string;
  more: number;
  masked: boolean;
  caretOn: boolean;
  alpha: number;
}

export interface KeycapsScene {
  keys: string[];
  alpha: number;
  scale: number;
  dy: number;
}

export interface CancelScene {
  x: number;
  y: number;
  dx: number;
  reason: string;
  alpha: number;
}

export interface HudScene {
  label: string;
  state: "idle" | "working" | "done" | "stopped" | "error";
  control: boolean;
  elapsedMs: number;
}

export interface Scene {
  control: boolean;
  cursor: CursorScene | null;
  target: TargetScene | null;
  rings: RingScene[];
  typing: TypingScene | null;
  keycaps: KeycapsScene | null;
  cancel: CancelScene | null;
  hud: HudScene;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const ended = (a: ActionState) => a.cancel?.t ?? a.resultT;
const planEnd = (a: ActionState) => (a.plan ? a.plan.startsAt + a.plan.durationMs : a.intentT);

export function keycapNames(combo: string[]): string[] {
  return combo.slice(0, 5).map(keyDisplayName);
}

export function render(log: LocalDotEvent[], tMs: number, view: View): Scene {
  return sceneAt(foldEvents(emptyModel(), log), tMs, view);
}

export function sceneAt(model: SessionModel, t: number, view: View): Scene {
  if (!Number.isFinite(t)) throw new RangeError("scene time must be finite");
  const started = model.actions.filter((a) => a.intentT <= t);
  const current = started.at(-1);
  const control = controlAt(model, t);
  return {
    control,
    cursor: cursorAt(model, started, current, t, view, control),
    target: current ? targetAt(current, t, view) : null,
    rings: ringsAt(started, t),
    typing: current ? typingAt(current, t, view) : null,
    keycaps: current ? keycapsAt(current, t, view) : null,
    cancel: current ? cancelAt(current, started, t, view) : null,
    hud: hudAt(model, current, t, control),
  };
}

function controlAt(model: SessionModel, t: number): boolean {
  if (model.ended && model.ended.t <= t) return false;
  const s = agentStateAt(model, t)?.state;
  return s === "acting" || s === "observing" || s === "thinking";
}

// Where the cursor rests after an action: its dispatch point, or where a cancel froze it.
function restingPoint(a: ActionState): Point | undefined {
  if (a.plan) return a.cancel ? pointerAt(a.plan, a.cancel.t) : a.plan.to;
  return a.point;
}

function cursorAt(model: SessionModel, started: ActionState[], current: ActionState | undefined, t: number, view: View, control: boolean): CursorScene | null {
  if (!current) return null;
  let pos: Point | undefined;
  let floating = false;
  for (const a of started) {
    const p = a === current && a.plan ? positionOnPlan(a, t, view) : restingPoint(a);
    if (p) pos = p;
  }
  if (!pos) return null;
  const idleSince = current.cancel?.t ?? current.resultT;
  const state = agentStateAt(model, t);
  const thinking = state?.state === "thinking";
  // Resting (research §4.5): dimmed and floating while thinking, or after 1.2 s with nothing to do.
  const restSince = Math.min(thinking && state ? state.t : Number.POSITIVE_INFINITY, idleSince === undefined ? Number.POSITIVE_INFINITY : idleSince + CURSOR_DIM_AFTER_MS);
  let alpha = 1;
  if (t > restSince) alpha = 0.7;
  if (t > restSince && !view.reducedMotion) {
    floating = true;
    const phase = (2 * Math.PI * (t - restSince)) / 4000;
    pos = { x: pos.x + 2.5 * Math.sin(phase), y: pos.y + 3 * Math.cos(phase) - 2.5 };
  }
  const hideAt = idleSince === undefined ? undefined : idleSince + CURSOR_HIDE_AFTER_MS;
  const lostControlAt = model.ended?.t;
  const fadeStart = Math.min(hideAt ?? Number.POSITIVE_INFINITY, lostControlAt ?? Number.POSITIVE_INFINITY);
  if (t >= fadeStart) {
    alpha *= 1 - clamp01((t - fadeStart) / FADE_MS);
    if (alpha <= 0) return { x: pos.x, y: pos.y, visible: false, alpha: 0, press: 0, hand: false, chipAlpha: 0, name: CURSOR_NAME, floating: false };
  }
  if (current.plan && (view.reducedMotion || current.plan.durationMs === 0)) alpha *= crossfadeAlpha(current, t, view.reducedMotion ? REDUCED_FADE_MS : INSTANT_FADE_MS);
  const press = pressAt(current, t, view);
  const chipSince = t - current.intentT;
  const chipAlpha = chipSince < CHIP_SHOW_MS ? 1 : 1 - clamp01((chipSince - CHIP_SHOW_MS) / CHIP_FADE_MS);
  const arrived = current.plan ? t >= planEnd(current) : true;
  const hand = arrived && CLICKABLE.has(current.target?.role ?? "") && control;
  return { x: pos.x, y: pos.y, visible: true, alpha, press, hand, chipAlpha, name: CURSOR_NAME, floating };
}

// Reduced motion: no travel, a 120 ms cross-fade at departure and at arrival (apple-design §14).
// Instant (a plan with durationMs 0, spec "Timing"): no travel either; the cursor appears at the
// target and fades in over 150 ms, the research's fade-teleport (§4.3).
function positionOnPlan(a: ActionState, t: number, view: View): Point {
  const plan = a.plan as NonNullable<ActionState["plan"]>;
  const stop = a.cancel ? Math.min(t, a.cancel.t) : t;
  if (!view.reducedMotion && plan.durationMs > 0) return pointerAt(plan, stop);
  return stop < planEnd(a) ? { x: plan.from.x, y: plan.from.y } : { x: plan.to.x, y: plan.to.y };
}

function crossfadeAlpha(a: ActionState, t: number, fadeMs: number): number {
  const plan = a.plan as NonNullable<ActionState["plan"]>;
  const out = clamp01((t - plan.startsAt) / fadeMs);
  const inn = clamp01((t - planEnd(a)) / fadeMs);
  if (t < plan.startsAt) return 1;
  if (t < planEnd(a)) return 1 - out;
  return inn;
}

// Squash 0.85 over 80 ms ending at the raw press, spring back over 150 ms; replay sees all of it,
// the live view joins once the dispatch arrives.
function pressAt(a: ActionState, t: number, view: View): number {
  const d = a.dispatch;
  if (!d || d.input.kind === "type" || d.input.kind === "key" || d.input.kind === "wait") return 0;
  if (view.reducedMotion) return 0;
  if (t < d.pressT - PRESS_MS) return 0;
  if (t <= d.pressT) return clamp01((t - (d.pressT - PRESS_MS)) / PRESS_MS);
  return 1 - clamp01((t - d.pressT) / RELEASE_MS);
}

function targetAt(a: ActionState, t: number, view: View): TargetScene | null {
  const point = a.target?.point ?? a.point;
  if (!point || t < a.intentT) return null;
  const holdFrom = a.dispatch?.t ?? ended(a);
  if (holdFrom !== undefined && t >= holdFrom + TARGET_HOLD_MS + TARGET_FADE_MS) return null;
  let alpha = clamp01((t - a.intentT) / TARGET_IN_MS);
  if (holdFrom !== undefined && t > holdFrom + TARGET_HOLD_MS) alpha *= 1 - clamp01((t - holdFrom - TARGET_HOLD_MS) / TARGET_FADE_MS);
  const bbox = a.target?.bbox;
  const known = bbox && a.targetT !== undefined && t >= a.targetT;
  let rect: Rect | null = null;
  if (known) {
    const from: Rect = { x: point.x - CROSSHAIR_PX / 2, y: point.y - CROSSHAIR_PX / 2, w: CROSSHAIR_PX, h: CROSSHAIR_PX };
    const s = msToSeconds(t - (a.targetT as number));
    const morph = (k: keyof Rect) => (view.reducedMotion ? bbox[k] : springValue(from[k], bbox[k], 0, s, TARGET_SPRING));
    rect = { x: morph("x"), y: morph("y"), w: morph("w"), h: morph("h") };
  }
  const chip = known && (a.target?.role || a.target?.name) ? clipText([a.target?.role, a.target?.name].filter(Boolean).join(" · "), 32) : undefined;
  return { style: "acting", rect, point, alpha, ...(chip ? { chip } : {}) };
}

function ringsAt(started: ActionState[], t: number): RingScene[] {
  const rings: RingScene[] = [];
  for (const a of started) {
    const d = a.dispatch;
    if (d?.input.kind !== "click") continue;
    const style = d.input.button === "right" ? "right" : "left";
    for (let i = 0; i < d.input.count; i++) {
      const at = d.ringAt + i * DOUBLE_CLICK_GAP_MS;
      if (t >= at && t < at + RING_FADE_MS) rings.push({ x: d.input.at.x, y: d.input.at.y, p: (t - at) / RING_FADE_MS, style });
    }
  }
  return rings;
}

function typingAt(a: ActionState, t: number, view: View): TypingScene | null {
  const d = a.dispatch;
  if (d?.input.kind !== "type" || t < d.ringAt) return null;
  const shown = a.progress.filter((p) => p.t <= t);
  const last = shown.at(-1);
  // One rule: the pill stays while the action runs and for TYPING_HOLD_MS after whichever came
  // last, the action's end or the last progress line.
  const stop = ended(a);
  if (stop !== undefined && t > Math.max(stop, last?.t ?? 0) + TYPING_HOLD_MS) return null;
  const count = last?.count ?? 0;
  const text = d.input.masked ? "•".repeat(count) : shown.map((p) => p.chunk ?? "").join("");
  const chars = [...text];
  const more = Math.max(0, chars.length - PILL_MAX);
  const caretOn = view.reducedMotion ? true : Math.floor((t - d.t) / (CARET_PERIOD_MS / 2)) % 2 === 0;
  const anchor = a.target?.bbox ? { x: a.target.bbox.x, y: a.target.bbox.y } : (a.target?.point ?? a.point ?? { x: 0, y: 0 });
  return { anchor, text: chars.slice(-PILL_MAX).join(""), more, masked: d.input.masked, caretOn, alpha: 1 };
}

function keycapsAt(a: ActionState, t: number, view: View): KeycapsScene | null {
  const d = a.dispatch;
  if (d?.input.kind !== "key" || t < d.ringAt) return null;
  const since = t - d.ringAt;
  if (since > KEYCAP_IN_MS + KEYCAP_LINGER_MS + KEYCAP_FADE_MS) return null;
  const inn = clamp01(since / KEYCAP_IN_MS);
  const scale = view.reducedMotion ? 1 : lerp(0.5, 1, inn);
  const dy = view.reducedMotion ? 0 : lerp(KEYCAP_RISE_PX, 0, inn);
  const alpha = since <= KEYCAP_IN_MS + KEYCAP_LINGER_MS ? inn : 1 - clamp01((since - KEYCAP_IN_MS - KEYCAP_LINGER_MS) / KEYCAP_FADE_MS);
  return { keys: keycapNames(d.input.combo), alpha, scale, dy };
}

function cancelAt(a: ActionState, started: ActionState[], t: number, view: View): CancelScene | null {
  if (!a.cancel || t < a.cancel.t || t > a.cancel.t + CANCEL_CHIP_MS) return null;
  const since = t - a.cancel.t;
  const pos = restingPoint(a) ?? restingPoint(started.at(-2) as ActionState) ?? { x: 0, y: 0 };
  const dx = view.reducedMotion || since > CANCEL_SHAKE_MS ? 0 : 5 * Math.sin((2 * Math.PI * 2 * since) / CANCEL_SHAKE_MS);
  return { x: pos.x, y: pos.y, dx, reason: a.cancel.reason, alpha: 1 - clamp01((since - CANCEL_CHIP_MS + 300) / 300) };
}

function hudAt(model: SessionModel, current: ActionState | undefined, t: number, control: boolean): HudScene {
  const elapsedMs = model.startT === null ? 0 : Math.max(0, t - model.startT);
  if (model.ended && model.ended.t <= t) {
    return { label: current?.label ?? "", state: model.ended.reason === "done" ? "done" : model.ended.reason === "stopped" ? "stopped" : "error", control: false, elapsedMs };
  }
  const working = current !== undefined && ended(current) === undefined;
  const thinking = agentStateAt(model, t)?.state === "thinking";
  return { label: current?.label ?? (thinking ? "Thinking…" : ""), state: working || control ? "working" : "idle", control, elapsedMs };
}
```

`packages/stage/src/camera.ts`:
```ts
import type { Point } from "@localdot/protocol";

export interface CameraInput {
  stageW: number;
  stageH: number;
  desktopW: number;
  desktopH: number;
  zoom: number;
  focus?: Point;
}

// canvas = world × scale + (tx, ty); world is desktop device pixels, canvas the backing store.
export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

export function cameraFor(i: CameraInput): Camera {
  for (const v of [i.stageW, i.stageH, i.desktopW, i.desktopH, i.zoom]) {
    if (!(Number.isFinite(v) && v > 0)) throw new RangeError("camera inputs must be positive and finite");
  }
  const base = Math.min(i.stageW / i.desktopW, i.stageH / i.desktopH);
  const scale = base * i.zoom;
  const shownW = i.desktopW * scale;
  const shownH = i.desktopH * scale;
  if (i.zoom <= 1) return { scale, tx: (i.stageW - shownW) / 2, ty: (i.stageH - shownH) / 2 };
  const focus = i.focus ?? { x: i.desktopW / 2, y: i.desktopH / 2 };
  const clampT = (want: number, shown: number, stage: number) => (shown <= stage ? (stage - shown) / 2 : Math.min(0, Math.max(stage - shown, want)));
  return { scale, tx: clampT(i.stageW / 2 - focus.x * scale, shownW, i.stageW), ty: clampT(i.stageH / 2 - focus.y * scale, shownH, i.stageH) };
}

export function toCanvas(cam: Camera, p: Point): Point {
  return { x: p.x * cam.scale + cam.tx, y: p.y * cam.scale + cam.ty };
}

export function toWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.tx) / cam.scale, y: (p.y - cam.ty) / cam.scale };
}
```
`packages/stage/src/index.ts` — add `export * from "./camera.ts"; export * from "./model.ts"; export * from "./scene.ts";`.

Run: `pnpm exec vitest run packages/stage`
Expected: every stage test passes. If the typing test's "never more characters" loop fails at
`t = 1200`, the `shown` filter is using `<` instead of `<=`: a progress event at exactly `t` counts.

- [ ] **Step 4: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages/stage
git commit -m "feat(stage): fold the event log into a model and sample a deterministic scene"
```

---
### Task 14a: The stage renderer, part 1 — PixiJS in the worker and the video path

The render worker replaces Part 2's 2D presenter with PixiJS 8: the video frame is a texture
uploaded once per new frame (never per `requestAnimationFrame`, A20), the world container carries
the video and the world-space overlays under one camera matrix, a screen container carries the
keycap chips, and one `requestAnimationFrame` loop samples `sceneAt(model, t, view)` and draws it.
The worker owns the folded model (events arrive in batches from the page), the clock mapping
(viewer wall ms → session ms, through `sessionMsAt`), the view (zoom, freeze, reduced motion) and
the theme (every colour a CSS token read on the page and posted in). Frames are closed after their
upload; a frame superseded before it was drawn is dropped (newest wins). The camera is built from
the session's screen, so a frame of another size is drawn into the session's space and reported
once (Review Focus 4). This part ships everything but the drawing of the overlays and the page-side
session handle (P3-C10): `Overlays` is a skeleton whose `draw` only clears, so "see it draw" is the
video through PixiJS; Task 14b draws the P0 overlays and adds the handle.

Part 2's Task 14 built the video path with S8's three carried fixes, and this task keeps them: the
seed frame (`new VideoFrame(<video>)` at tap time, `FrameSource.first`, transferred with the
readable and handed to `pumpFrames` as `{ first }`), the re-ticket and iframe remount after a
daemon reconnect or 10 s without `#videoStream`, and the cleanup of the client's stale
`…_cells_<id>_desktop_*` storage keys. The seed is presented like any frame, so the PixiJS presenter
owns it too. `Stage.tsx` does not change here; Task 14b adds to it. The canvas reads the theme
tokens, the device pixel ratio and the motion preference itself when it mounts: it renders only
where frames can be tapped, so jsdom (Part 2's `Stage.test`, `App.test`) and browsers without
WebCodecs never reach `matchMedia` or the theme.

**Files:**
- Create: `apps/web/src/stage/worker-protocol.ts`, `apps/web/src/stage/theme.ts`, `apps/web/src/stage/geometry.ts`,
  `apps/web/src/stage/pixi-presenter.ts`, `apps/web/src/stage/overlays.ts` (skeleton), `apps/web/src/stage/oracle.ts` (skeleton)
- Modify: `apps/web/src/stage/pump.ts`, `apps/web/src/stage/render-worker.ts`, `apps/web/src/stage/StageCanvas.tsx`,
  `apps/web/src/theme.css`, `apps/web/package.json`
- Delete: `apps/web/src/stage/presenter.ts`
- Test: `apps/web/src/stage/pump.test.ts` (Part 2's), `apps/web/src/stage/theme.test.ts`, `apps/web/src/stage/geometry.test.ts`

**Interfaces:**
- Consumes: `@localdot/stage` (`sceneAt`, `foldEvents`, `emptyModel`, `cameraFor`, `toCanvas`, `Scene`, `Camera`, timing constants), Part 2's
  `FrameSource` (with `first`), `pumpFrames` (with `{ first }`), `StageCanvas`, `Stage`; `sessionMsAt`, `Flip`, `ProbeRect` (Task 6);
  `microsToMs` (Task 2); `pixi.js` 8.21.0.
- Produces: `Presenter { present(frame: VideoFrame): void }` now **owns the frame**, the seed included (the presenter closes it;
  the pump closes a frame only when `present` throws);
  `WorkerIn = init { canvas; width; height; dpr; theme; reducedMotion } | resize { width; height } | frames { readable; first? } | stop | probe | events { events } | session-reset | clock { offsetMicros; originMicros } | view { zoom?; freeze?; reducedMotion? } | theme { theme } | oracle (Task 16)`,
  `WorkerOut = stats | error | flip | warn { message } | oracle-reply (Task 16)`; `OracleRequest` (a command without its `id`, still a union);
  `StageTheme` (parsed colours), `readTheme(style: CSSStyleDeclaration): StageTheme`, `parseCssColor(s): { color; alpha }`;
  `cursorPolygon(scale): number[]`, `CURSOR_TILT_RAD`, `CURSOR_HEIGHT_PX = 24`, `ringRadius(p): { outer; alpha }`, `videoPlacement(frame, screen)`;
  `class PixiPresenter { static create(canvas, opts); present(frame); setScreen(screen); setCamera(cam); setViewport(w, h); draw(scene); render(); frameSize; presented; warned; extract(crop, layer, cam, scene) }`
  (`opts.warn(message)` reports a frame of another size once; the worker posts it as `warn`),
  `class Overlays { constructor(theme, dpr); world: Container; screen: Container; setCamera(cam); setViewport(w, h); setTheme(theme); draw(scene) }` (the skeleton's `draw` clears; Task 14b draws);
  `reducedMotionQuery()`; `StageCanvas` keeps its props (`onStats?`, `onFlip?`) and reads the theme, the device pixel ratio
  and the motion preference when it mounts; the worker handles every `WorkerIn` message (the page sends the session ones from Task 14b on).
  theme.css tokens added: `--color-halo-target`, `--color-shade-cursor`, `--color-key-bevel`, `--color-xenon-a10`.

- [ ] **Step 1: Pure parts, test first**

`apps/web/src/stage/theme.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseCssColor, readTheme } from "./theme.ts";

describe("theme tokens", () => {
  it("parses hex and rgba colours into Pixi numbers and alphas", () => {
    expect(parseCssColor("#3FB5DE")).toEqual({ color: 0x3fb5de, alpha: 1 });
    expect(parseCssColor(" rgba(14, 15, 18, 0.92) ")).toEqual({ color: 0x0e0f12, alpha: 0.92 });
    expect(parseCssColor("rgb(255, 255, 255)")).toEqual({ color: 0xffffff, alpha: 1 });
    expect(parseCssColor("#abc")).toEqual({ color: 0xaabbcc, alpha: 1 });
    expect(() => parseCssColor("hotpink")).toThrow(/colour/);
  });

  it("reads every overlay colour from the CSS tokens", () => {
    const vars: Record<string, string> = {
      "--color-xenon": "#3fb5de", "--color-xenon-a10": "rgba(63, 181, 222, 0.1)", "--color-cursor-fill": "#ffffff", "--color-cursor-rim": "#121316",
      "--color-hud-solid": "rgba(14, 15, 18, 0.92)", "--color-hud-line": "rgba(255, 255, 255, 0.1)", "--color-text": "#eeeff1", "--color-text-2": "#999ca4",
      "--color-halo-target": "rgba(10, 11, 13, 0.35)", "--color-shade-cursor": "rgba(0, 0, 0, 0.4)", "--color-key-bevel": "rgba(255, 255, 255, 0.06)", "--color-void": "#0a0b0d",
    };
    const theme = readTheme({ getPropertyValue: (k: string) => vars[k] ?? "" } as unknown as CSSStyleDeclaration);
    expect(theme.xenon).toEqual({ color: 0x3fb5de, alpha: 1 });
    expect(theme.haloTarget.alpha).toBeCloseTo(0.35, 6);
    expect(Object.keys(theme).sort()).toEqual(["cursorFill", "cursorRim", "haloTarget", "hudLine", "hudSolid", "keyBevel", "shadeCursor", "text", "text2", "void", "xenon", "xenonA10"]);
  });
});
```

`apps/web/src/stage/theme.ts`:
```ts
export interface ThemeColor {
  color: number;
  alpha: number;
}

export interface StageTheme {
  xenon: ThemeColor;
  xenonA10: ThemeColor;
  cursorFill: ThemeColor;
  cursorRim: ThemeColor;
  hudSolid: ThemeColor;
  hudLine: ThemeColor;
  text: ThemeColor;
  text2: ThemeColor;
  haloTarget: ThemeColor;
  shadeCursor: ThemeColor;
  keyBevel: ThemeColor;
  void: ThemeColor;
}

const TOKENS: Record<keyof StageTheme, string> = {
  xenon: "--color-xenon", xenonA10: "--color-xenon-a10", cursorFill: "--color-cursor-fill", cursorRim: "--color-cursor-rim",
  hudSolid: "--color-hud-solid", hudLine: "--color-hud-line", text: "--color-text", text2: "--color-text-2",
  haloTarget: "--color-halo-target", shadeCursor: "--color-shade-cursor", keyBevel: "--color-key-bevel", void: "--color-void",
};

export function parseCssColor(value: string): ThemeColor {
  const s = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1] as string;
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return { color: Number.parseInt(full, 16), alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (rgba) {
    const [r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
    return { color: (r << 16) | (g << 8) | b, alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  throw new RangeError(`unsupported CSS colour ${JSON.stringify(value)}`);
}

// Every overlay colour comes from theme.css, so a theme pack restyles the stage too.
export function readTheme(style: CSSStyleDeclaration): StageTheme {
  const out = {} as StageTheme;
  for (const [key, token] of Object.entries(TOKENS) as [keyof StageTheme, string][]) {
    out[key] = parseCssColor(style.getPropertyValue(token));
  }
  return out;
}
```

`apps/web/src/stage/geometry.test.ts`:
```ts
import { cameraFor, toCanvas } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { CURSOR_HEIGHT_PX, cursorPolygon, ringRadius, videoPlacement } from "./geometry.ts";

describe("stage geometry", () => {
  it("builds the arrow with its tip at the origin, 24 px tall", () => {
    const pts = cursorPolygon(1);
    expect(pts[0]).toBe(0);
    expect(pts[1]).toBe(0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeCloseTo(CURSOR_HEIGHT_PX, 1);
    expect(Math.min(...ys)).toBe(0);
    expect(cursorPolygon(2)[3]).toBeCloseTo((cursorPolygon(1)[3] ?? 0) * 2, 9);
  });

  it("grows the ring from 60 % to 100 % over 225 ms and fades it out over 300 ms", () => {
    expect(ringRadius(0)).toEqual({ outer: 22 * 0.6, alpha: 0.7 });
    expect(ringRadius(0.75).outer).toBeCloseTo(22, 6);
    expect(ringRadius(0.999).alpha).toBeCloseTo(0, 2);
    expect(ringRadius(0.5).outer).toBeGreaterThan(ringRadius(0.25).outer);
  });

  it("places a frame of another size into the session screen and flags it", () => {
    expect(videoPlacement({ w: 2560, h: 1600 }, { w: 2560, h: 1600 })).toEqual({ sx: 1, sy: 1, mismatch: false });
    expect(videoPlacement({ w: 1280, h: 800 }, { w: 2560, h: 1600 })).toEqual({ sx: 2, sy: 2, mismatch: true });
  });

  it("builds the camera from the session screen, not the frame", () => {
    // A 1280×800 frame in a 2560×1600 session on a 1280×800 stage: the camera halves the desktop,
    // the frame is doubled into it, the picture fills the stage unstretched and a desktop point
    // lands where the session's geometry says, whatever the frame's size.
    const screen = { w: 2560, h: 1600 };
    const cam = cameraFor({ stageW: 1280, stageH: 800, desktopW: screen.w, desktopH: screen.h, zoom: 1 });
    const p = videoPlacement({ w: 1280, h: 800 }, screen);
    expect(cam.scale).toBe(0.5);
    expect(1280 * p.sx * cam.scale).toBe(1280);
    expect(800 * p.sy * cam.scale).toBe(800);
    expect(toCanvas(cam, { x: 2560, y: 1600 })).toEqual({ x: 1280, y: 800 });
    // The frame's pixel (150, 200) shows desktop (300, 400): drawn ×2 into the session it lands
    // under that point's overlay. A camera built from the frame would put the overlay at (300, 400).
    expect(toCanvas(cam, { x: 150 * p.sx, y: 200 * p.sy })).toEqual({ x: 150, y: 200 });
    expect(toCanvas(cam, { x: 300, y: 400 })).toEqual({ x: 150, y: 200 });
    expect(toCanvas(cameraFor({ stageW: 1280, stageH: 800, desktopW: 1280, desktopH: 800, zoom: 1 }), { x: 300, y: 400 })).toEqual({ x: 300, y: 400 });
  });
});
```

`apps/web/src/stage/geometry.ts`:
```ts
import { RING_FADE_MS, RING_PX, RING_SCALE_MS } from "@localdot/stage";

// The mockup's arrow (c-theatre.html), tip at the origin, 24 px tall at scale 1, tilted 12°.
const ARROW = [0, 0, 0, 17.6, 4.5, 13.3, 7.5, 20.2, 10.8, 18.8, 7.9, 12.2, 14.2, 12.2];
export const CURSOR_HEIGHT_PX = 24;
export const CURSOR_TILT_RAD = (-12 * Math.PI) / 180;
const ARROW_SCALE = CURSOR_HEIGHT_PX / 20.2;

export function cursorPolygon(scale: number): number[] {
  return ARROW.map((v) => v * ARROW_SCALE * scale);
}

// Research §4.3.3: scale 0.6→1.0 over 225 ms (ease-out), opacity 0.7→0 over 300 ms.
export function ringRadius(p: number): { outer: number; alpha: number } {
  const u = Math.min(1, (p * RING_FADE_MS) / RING_SCALE_MS);
  const eased = 1 - (1 - u) ** 3;
  return { outer: (RING_PX / 2) * (0.6 + 0.4 * eased), alpha: 0.7 * (1 - p) };
}

export function videoPlacement(frame: { w: number; h: number }, screen: { w: number; h: number }): { sx: number; sy: number; mismatch: boolean } {
  const sx = screen.w / frame.w;
  const sy = screen.h / frame.h;
  return { sx, sy, mismatch: sx !== 1 || sy !== 1 };
}
```

`apps/web/src/stage/pump.test.ts` (Part 2's) — the presenter now owns every frame, the seed
included, and the pump closes one only when the presenter throws on it. In "presents every frame
once, closes it, …" and "presents the seed frame before the first read and closes it", the fake
presenters close what they are given: `present: (f) => { presented.push(f); f.close(); }` (the
`toHaveBeenCalledTimes(1)` expectations stay; they now count the presenter's close). Append:
```ts
  it("closes a frame the presenter throws on, and a refused seed never stops the stream", async () => {
    const first = fakeFrame();
    const frames = [fakeFrame()];
    const presented: VideoFrame[] = [];
    const presenter: Presenter = {
      present: (f) => {
        if (f === first) throw new Error("refused");
        presented.push(f);
        f.close();
      },
    };
    const pump = pumpFrames(stream([...frames]), presenter, () => {}, { first });
    await new Promise((r) => setTimeout(r, 20));
    await pump.stop();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(presented).toEqual(frames);
    expect(frames[0]?.close).toHaveBeenCalledTimes(1);
  });
```

`apps/web/src/stage/pump.ts` — in Part 2's `present` helper, the presenter's call no longer closes
the frame; replace its `try { presenter.present(frame); } finally { frame.close(); }` with
```ts
    try {
      presenter.present(frame);
    } catch (err) {
      frame.close();
      throw err;
    }
```
and give `Presenter` the doc comment "Takes ownership of the frame and closes it once drawn or
dropped; the pump closes it only when this throws."

Run: `pnpm exec vitest run apps/web/src/stage`
Expected: theme, geometry, pump (4), probe and frame-source tests pass.

- [ ] **Step 2: Protocol, the presenter and the overlay skeleton**

`apps/web/package.json` — add `"pixi.js": "8.21.0"` and `"@localdot/stage": "workspace:*"` (`@localdot/protocol` is there since Task 6)
to `dependencies`; `pnpm install` (the one new download of this plan).

`apps/web/src/stage/worker-protocol.ts`:
```ts
import type { LocalDotEvent } from "@localdot/protocol";
import type { Flip, ProbeRect } from "./probe.ts";
import type { PumpStats } from "./pump.ts";
import type { StageTheme } from "./theme.ts";

export interface StageClock {
  offsetMicros: number;
  originMicros: number;
}

export interface StageViewPatch {
  zoom?: number;
  freeze?: boolean;
  reducedMotion?: boolean;
}

export type WorkerIn =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number; dpr: number; theme: StageTheme; reducedMotion: boolean }
  | { type: "resize"; width: number; height: number }
  // S8's seed travels with the readable (Part 2's Task 14): the <video>'s frame at tap time.
  | { type: "frames"; readable: ReadableStream<VideoFrame>; first?: VideoFrame }
  | { type: "stop" }
  | { type: "probe"; rect: ProbeRect | null; threshold: number }
  | { type: "events"; events: LocalDotEvent[] }
  | { type: "session-reset" }
  | { type: "clock"; clock: StageClock }
  | { type: "view"; view: StageViewPatch }
  | { type: "theme"; theme: StageTheme }
  | { type: "oracle"; command: OracleCommand };

export type WorkerOut =
  | { type: "stats"; stats: PumpStats }
  | { type: "error"; message: string }
  | { type: "warn"; message: string }
  | { type: "flip"; flip: Flip }
  | { type: "oracle-reply"; id: number; reply: unknown };

// Task 16 fills these in; declared here so the protocol has one home.
export type OracleCommand = { id: number; op: "enable"; zooms: number[] } | { id: number; op: "dump" } | { id: number; op: "template" } | { id: number; op: "render-twice"; tMs: number };

// A command as the page writes it, before the canvas numbers it: still a union (a plain Omit of the
// union would keep only the keys every member shares, `op`).
export type OracleRequest = OracleCommand extends infer C ? (C extends unknown ? Omit<C, "id"> : never) : never;
```

`apps/web/src/stage/pixi-presenter.ts`:
```ts
import type { Camera, Scene } from "@localdot/stage";
import { Application, Container, DOMAdapter, ImageSource, Matrix, Rectangle, RenderTexture, Sprite, Texture, WebWorkerAdapter } from "pixi.js";
import { videoPlacement } from "./geometry.ts";
import { Overlays } from "./overlays.ts";
import type { Presenter } from "./pump.ts";
import type { StageTheme } from "./theme.ts";

export interface PresenterOptions {
  width: number;
  height: number;
  dpr: number;
  theme: StageTheme;
  // Reports, once, a frame of another size than the session's screen.
  warn(message: string): void;
}

// Video quad and world overlays under one camera matrix, screen overlays on top, on an
// OffscreenCanvas in the worker (spec "Rendering").
export class PixiPresenter implements Presenter {
  readonly app: Application;
  readonly world = new Container();
  readonly screen = new Container();
  readonly video = new Sprite();
  readonly overlays: Overlays;
  presented = 0;
  warned = false;
  #source: ImageSource | null = null;
  #pending: VideoFrame | null = null;
  #frameSize: { w: number; h: number } | null = null;
  #screen: { w: number; h: number } | null = null;
  readonly #warn: (message: string) => void;

  static async create(canvas: OffscreenCanvas, opts: PresenterOptions): Promise<PixiPresenter> {
    DOMAdapter.set(WebWorkerAdapter);
    const app = new Application();
    await app.init({ canvas, width: opts.width, height: opts.height, resolution: 1, autoDensity: false, preference: "webgl", antialias: true, background: opts.theme.void.color, backgroundAlpha: 1, autoStart: false, sharedTicker: false });
    return new PixiPresenter(app, opts);
  }

  private constructor(app: Application, opts: PresenterOptions) {
    this.app = app;
    this.#warn = opts.warn;
    this.overlays = new Overlays(opts.theme, opts.dpr);
    this.world.addChild(this.video, this.overlays.world);
    this.screen.addChild(this.overlays.screen);
    app.stage.addChild(this.world, this.screen);
    this.overlays.setViewport(opts.width, opts.height);
  }

  get frameSize(): { w: number; h: number } | null {
    return this.#frameSize;
  }

  // Owns the frame: it is closed after its upload, or at once when a newer one supersedes it.
  present(frame: VideoFrame): void {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (!this.#source || this.#frameSize?.w !== w || this.#frameSize?.h !== h) {
      this.#source?.destroy();
      this.#source = new ImageSource({ resource: frame, width: w, height: h, autoGarbageCollect: false });
      this.video.texture = new Texture({ source: this.#source });
      this.#frameSize = { w, h };
      this.#place();
    } else {
      this.#source.resource = frame;
      this.#source.update();
    }
    this.#pending?.close();
    this.#pending = frame;
    this.presented += 1;
  }

  setScreen(screen: { w: number; h: number } | null): void {
    this.#screen = screen;
    this.#place();
  }

  // The session's screen is the world; a frame of another size is drawn into it, not the reverse.
  #place(): void {
    if (!this.#frameSize) return;
    const screen = this.#screen ?? this.#frameSize;
    const p = videoPlacement(this.#frameSize, screen);
    this.video.scale.set(p.sx, p.sy);
    if (p.mismatch && !this.warned) {
      this.warned = true;
      this.#warn(`frame ${this.#frameSize.w}x${this.#frameSize.h} drawn into a ${screen.w}x${screen.h} session screen`);
    }
  }

  setCamera(cam: Camera): void {
    this.world.scale.set(cam.scale);
    this.world.position.set(cam.tx, cam.ty);
    this.overlays.setCamera(cam);
  }

  setViewport(width: number, height: number): void {
    this.app.renderer.resize(width, height);
    this.overlays.setViewport(width, height);
  }

  draw(scene: Scene | null): void {
    this.#lastScene = scene;
    this.overlays.draw(scene);
  }

  #lastScene: Scene | null = null;

  render(): void {
    this.app.renderer.render(this.app.stage);
    const f = this.#pending;
    this.#pending = null;
    f?.close();
  }

  // Oracle (Task 16): a crop of the composite, or of the overlays alone (the video sprite hidden),
  // rendered with the given camera into a transparent render texture, as RGBA bytes. The overlays
  // size themselves by the camera at draw time (unit = dpr / cam.scale), so the scene is redrawn
  // under `cam` and restored afterwards. The bytes are premultiplied RGBA: a half-transparent
  // xenon pixel reads darker than #3FB5DE, so only solid strokes match the oracle's tolerance.
  extract(crop: { x: number; y: number; w: number; h: number }, layer: "overlays" | "composite", cam: Camera, scene: Scene | null): Uint8ClampedArray {
    const rt = RenderTexture.create({ width: crop.w, height: crop.h, resolution: 1 });
    const transform = new Matrix().translate(-crop.x, -crop.y);
    const saved = { cam: { scale: this.world.scale.x, tx: this.world.position.x, ty: this.world.position.y }, video: this.video.visible, scene: this.#lastScene };
    this.setCamera(cam);
    this.overlays.draw(scene);
    this.video.visible = layer === "composite";
    this.app.renderer.render({ container: this.app.stage, target: rt, transform, clear: true, clearColor: [0, 0, 0, 0] });
    const { pixels } = this.app.renderer.extract.pixels({ target: rt, frame: new Rectangle(0, 0, crop.w, crop.h) });
    this.video.visible = saved.video;
    this.setCamera(saved.cam);
    this.overlays.draw(saved.scene);
    rt.destroy(true);
    return pixels;
  }
}
```

`apps/web/src/stage/overlays.ts` (the skeleton; Task 14b replaces the whole file):
```ts
import type { Camera, Scene } from "@localdot/stage";
import { Container, Graphics } from "pixi.js";
import type { StageTheme } from "./theme.ts";

// The overlay layers under the presenter's camera: `world` in desktop device pixels, `screen` in
// canvas pixels. Task 14b draws the scene; here `draw` only clears, so the stage shows the video.
export class Overlays {
  readonly world = new Container();
  readonly screen = new Container();
  readonly #g = new Graphics();

  constructor(_theme: StageTheme, _dpr: number) {
    this.world.addChild(this.#g);
  }

  setTheme(_theme: StageTheme): void {}

  setCamera(_cam: Camera): void {}

  setViewport(_w: number, _h: number): void {}

  draw(_scene: Scene | null): void {
    this.#g.clear();
  }
}
```

- [ ] **Step 3: The worker loop, the canvas mount and the stage**

`apps/web/src/stage/render-worker.ts` (replace the whole file):
```ts
import { type Camera, cameraFor, emptyModel, foldEvents, type Scene, type SessionModel, sceneAt, type View } from "@localdot/stage";
import { sessionMsAt } from "../session/clock-sync.ts";
import { OracleCapture } from "./oracle.ts";
import { PixiPresenter } from "./pixi-presenter.ts";
import { meanLuma, type ProbeRect, wallNow } from "./probe.ts";
import { type Presenter, pumpFrames } from "./pump.ts";
import type { StageClock, WorkerIn, WorkerOut } from "./worker-protocol.ts";

const scope = self as unknown as {
  postMessage(message: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let presenter: PixiPresenter | undefined;
let pump: { stop(): Promise<void> } | undefined;
let probe: { rect: ProbeRect; threshold: number; last: boolean | null } | null = null;
let model: SessionModel = emptyModel();
let view: View = { reducedMotion: false };
let zoom = 1;
let freeze = false;
let frozenT: number | null = null;
let clock: StageClock | null = null;
let viewport = { w: 1, h: 1 };
let lastScene: Scene | null = null;
const oracle = new OracleCapture();

function sessionNow(): number | null {
  if (!clock) return null;
  return sessionMsAt(wallNow(), clock);
}

function screenNow(): { w: number; h: number } {
  return model.screen ?? presenter?.frameSize ?? { w: 1280, h: 800 };
}

function probing(inner: Presenter): Presenter {
  return {
    present(frame) {
      const at = wallNow();
      const p = probe;
      const presented = (presenter?.presented ?? 0) + 1;
      if (p) {
        // copyTo is async and the presenter closes the frame, so the probe reads a clone.
        const copy = frame.clone();
        void meanLuma(copy, p.rect)
          .then((luma) => {
            const bright = luma > p.threshold;
            if (p.last !== null && bright !== p.last) scope.postMessage({ type: "flip", flip: { at, luma, bright, presented } });
            p.last = bright;
          })
          .finally(() => copy.close());
      }
      // Every frame: Task 16's oracle ignores it while off and, only while on, keeps a clone of
      // the newest one (P3-C12).
      oracle.onFrame(frame, at, presented);
      inner.present(frame);
    },
  };
}

function tick(): void {
  if (presenter) {
    const screen = screenNow();
    presenter.setScreen(model.screen ? { w: model.screen.w, h: model.screen.h } : null);
    // A frozen stage keeps the time it froze at; overlays never animate over a dead picture.
    if (freeze) frozenT ??= sessionNow();
    else frozenT = null;
    const t = freeze ? frozenT : sessionNow();
    const focus = lastScene?.cursor?.visible ? { x: lastScene.cursor.x, y: lastScene.cursor.y } : undefined;
    const cam: Camera = cameraFor({ stageW: viewport.w, stageH: viewport.h, desktopW: screen.w, desktopH: screen.h, zoom, focus });
    presenter.setCamera(cam);
    const scene = t === null ? null : sceneAt(model, t, view);
    lastScene = scene;
    presenter.draw(scene);
    presenter.render();
    if (oracle.enabled && t !== null) oracle.onTick(presenter, model, t, scene, cam, viewport, screen);
  }
  requestAnimationFrame(tick);
}

scope.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "init": {
        viewport = { w: m.width, h: m.height };
        view = { reducedMotion: m.reducedMotion };
        presenter = await PixiPresenter.create(m.canvas, { width: m.width, height: m.height, dpr: m.dpr, theme: m.theme, warn: (message) => scope.postMessage({ type: "warn", message }) });
        oracle.dpr = m.dpr;
        requestAnimationFrame(tick);
        return;
      }
      case "resize":
        viewport = { w: m.width, h: m.height };
        presenter?.setViewport(m.width, m.height);
        return;
      case "probe":
        probe = m.rect ? { rect: m.rect, threshold: m.threshold, last: null } : null;
        return;
      case "events": {
        model = foldEvents(model, m.events);
        // Task 16: a window already open when its intent arrives (an Instant click) gets its
        // baseline now, not a tick later, so the press's frame cannot replace the kept one first.
        const t = freeze ? frozenT : sessionNow();
        if (oracle.enabled && t !== null) oracle.onModel(model, t, screenNow());
        return;
      }
      case "session-reset":
        model = emptyModel();
        lastScene = null;
        return;
      case "clock":
        clock = m.clock;
        oracle.clock = m.clock;
        return;
      case "view":
        if (m.view.zoom !== undefined) zoom = m.view.zoom;
        if (m.view.freeze !== undefined) freeze = m.view.freeze;
        if (m.view.reducedMotion !== undefined) view = { reducedMotion: m.view.reducedMotion };
        return;
      case "theme":
        presenter?.overlays.setTheme(m.theme);
        return;
      case "oracle": {
        const reply = presenter ? await oracle.handle(m.command, presenter, model, view) : { error: "no presenter" };
        scope.postMessage({ type: "oracle-reply", id: m.command.id, reply });
        return;
      }
      case "stop":
      case "frames": {
        await pump?.stop();
        pump = undefined;
        oracle.dispose();
        if (m.type === "frames") {
          if (!presenter) {
            m.first?.close();
            throw new Error("frames before init");
          }
          pump = pumpFrames(m.readable, probing(presenter), (stats) => scope.postMessage({ type: "stats", stats }), { first: m.first });
        }
        return;
      }
    }
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
```
`./oracle.ts` is Task 16's; until then create it with the class skeleton the worker calls (every
decoded frame goes to `onFrame`, and `dispose` runs whenever the stream stops or is replaced:
Task 16 keeps a clone of the newest frame there while the oracle is on, never while it is off
(P3-C12), and closes it then):
```ts
// apps/web/src/stage/oracle.ts (Task 14a skeleton; Task 16 completes it)
import type { Camera, Scene, SessionModel, View } from "@localdot/stage";
import type { PixiPresenter } from "./pixi-presenter.ts";
import type { OracleCommand, StageClock } from "./worker-protocol.ts";

export class OracleCapture {
  enabled = false;
  dpr = 1;
  clock: StageClock | null = null;
  onFrame(_frame: VideoFrame, _at: number, _presented: number): void {}
  dispose(): void {}
  onModel(_m: SessionModel, _t: number, _screen: { w: number; h: number }): void {}
  onTick(_p: PixiPresenter, _m: SessionModel, _t: number, _s: Scene | null, _cam: Camera, _viewport: { w: number; h: number }, _screen: { w: number; h: number }): void {}
  async handle(command: OracleCommand, _p: PixiPresenter, _m: SessionModel, _v: View): Promise<unknown> {
    if (command.op === "enable") this.enabled = true;
    return { ok: true };
  }
}
```

`apps/web/src/stage/StageCanvas.tsx` (replace the whole file: Part 2's canvas with Task 6's probe,
the PixiJS worker's `init` and the resize observer; the session methods of the handle come in Task 14b):
```tsx
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FrameSource } from "./frame-source.ts";
import type { Flip, ProbeRect } from "./probe.ts";
import type { PumpStats } from "./pump.ts";
import { readTheme } from "./theme.ts";
import type { WorkerIn, WorkerOut } from "./worker-protocol.ts";

export interface StageCanvasHandle {
  attach(source: FrameSource): void;
  detach(): void;
  probe(rect: ProbeRect | null, threshold?: number): void;
}

export interface StageCanvasProps {
  onStats?(stats: PumpStats): void;
  onFlip?(flip: Flip): void;
}

export const reducedMotionQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

export const StageCanvas = forwardRef<StageCanvasHandle, StageCanvasProps>(function StageCanvas({ onStats, onFlip }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onFlipRef = useRef(onFlip);
  onFlipRef.current = onFlip;
  const [stats, setStats] = useState<PumpStats | null>(null);

  // The worker owns the canvas for the component's lifetime. It starts with the theme's colours,
  // the device pixel ratio and the motion preference, read here: the canvas renders only where
  // frames can be tapped, so jsdom and browsers without WebCodecs never reach them.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const theme = readTheme(getComputedStyle(document.documentElement));
    const worker = new Worker(new URL("./render-worker.ts", import.meta.url), { type: "module" });
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "init", canvas: offscreen, width: Math.max(1, Math.round(rect.width * dpr)), height: Math.max(1, Math.round(rect.height * dpr)), dpr, theme, reducedMotion: reducedMotionQuery().matches } satisfies WorkerIn, [offscreen]);
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "stats") {
        setStats(m.stats);
        onStatsRef.current?.(m.stats);
      } else if (m.type === "flip") onFlipRef.current?.(m.flip);
      else if (m.type === "warn") console.warn(`stage worker: ${m.message}`);
      else if (m.type === "error") console.error(`stage worker: ${m.message}`);
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry?.devicePixelContentBoxSize?.[0];
      const width = box ? box.inlineSize : Math.round((entry?.contentRect.width ?? 0) * dpr);
      const height = box ? box.blockSize : Math.round((entry?.contentRect.height ?? 0) * dpr);
      if (width > 0 && height > 0) worker.postMessage({ type: "resize", width, height } satisfies WorkerIn);
    });
    observer.observe(canvas);
    workerRef.current = worker;
    return () => {
      observer.disconnect();
      sourceRef.current?.stop();
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    attach(source) {
      sourceRef.current?.stop();
      sourceRef.current = source;
      const worker = workerRef.current;
      if (!worker) {
        source.first?.close();
        return;
      }
      // S8's seed frame travels with the readable; both are transferred.
      const transfer: Transferable[] = source.first ? [source.readable, source.first] : [source.readable];
      worker.postMessage({ type: "frames", readable: source.readable, first: source.first } satisfies WorkerIn, transfer);
    },
    detach() {
      sourceRef.current?.stop();
      sourceRef.current = null;
      workerRef.current?.postMessage({ type: "stop" } satisfies WorkerIn);
    },
    probe(rect, threshold = 128) {
      workerRef.current?.postMessage({ type: "probe", rect, threshold } satisfies WorkerIn);
    },
  }));

  return <canvas ref={canvasRef} className="stage-canvas" data-frames={stats?.presented ?? 0} data-fps={stats?.fps ?? 0} data-size={stats ? `${stats.width}x${stats.height}` : ""} aria-label="The virtual computer" />;
});
```

`apps/web/src/stage/Stage.tsx` does not change: it still renders `<StageCanvas ref={canvas} onFlip={onFlip} />`
behind Part 2's support gate, with Part 2's re-ticket generation, `onLost` remount and storage
cleanup, and Task 6's probe hook.

`apps/web/src/theme.css` — add after `--color-xenon-a40`:
```css
  --color-xenon-a10: rgba(63, 181, 222, 0.1);
  --color-halo-target: rgba(10, 11, 13, 0.35);
  --color-shade-cursor: rgba(0, 0, 0, 0.4);
  --color-key-bevel: rgba(255, 255, 255, 0.06);
```
Delete `apps/web/src/stage/presenter.ts`; `App.tsx` keeps rendering `<Stage cell={cell} api={api} />`.

Run: `pnpm exec vitest run apps/web/src && pnpm --filter @localdot/web typecheck && pnpm --filter @localdot/web build`
Expected: tests pass (Part 2's `Stage.test` and `App.test` included); the build emits the
`render-worker-*.js` chunk (about 460 kB) and PixiJS's lazily loaded chunks beside the app bundle;
no "Could not resolve" on `pixi.js`.

- [ ] **Step 4: See it draw**

Start the daemon (temporary home), open the UI, "Start computer", wait for Live, then run
`pnpm --filter @localdot/daemon puppet puppet/demo-multiapp.json`. The stage has no session wiring
yet (Task 14b, Task 15), so nothing moves — but the video must still show through PixiJS: `data-frames`
rises, the picture is sharp at DPR 2, and `docker pause`/`unpause` still freezes and resumes it.
Task 14b draws the overlays; Task 15's screenshot check is their first real exercise, once events
reach the worker. Take `pnpm --filter @localdot/web shot "http://127.0.0.1:4750/#token=<token>" apps/web/e2e/out/pixi-live.png 1440 900 8000`
and look: the desktop through PixiJS, no stretch, no xenon. Stop the computer and the daemon.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): PixiJS stage renderer in the worker, the video under one camera"
```

---
### Task 14b: The stage renderer, part 2 — the P0 overlays and the stage handle

The second half of the renderer (P3-C10): `Overlays.draw` draws the cursor (the mockup's arrow with
its halo, rim and accent stroke, the name chip, the press squash), the click rings, the target box
or crosshair with its chip, the typing pill, the keycaps and the cancel chip, every colour from the
theme and every screen-constant size counter-scaled by the camera (`unit = dpr / cam.scale`); the
page side gains the session handle (`pushEvents`, `resetSession`, `setClock`, `setView`, `setTheme`,
`oracle`) through which Task 15 feeds the worker, the optional `control` prop with the xenon rim,
and the live reduced-motion message. The video path of Task 14a does not change, and `Stage` keeps
Part 2's re-ticket, remount and storage cleanup.

**Files:**
- Modify: `apps/web/src/stage/overlays.ts` (replaces the skeleton), `apps/web/src/stage/StageCanvas.tsx`,
  `apps/web/src/stage/Stage.tsx`, `apps/web/src/app.css`
- Test: none new — `pnpm exec vitest run apps/web/src` stays green (Part 2's `Stage.test` renders `Stage`
  without `control`, which defaults to `false`) and the build still emits the worker chunk;
  Task 15's screenshot check and Task 16's oracle exercise the drawing on the real stage.

**Interfaces:**
- Consumes: the Task 14a skeleton, `cursorPolygon`, `ringRadius`, `CURSOR_TILT_RAD`, `StageTheme`, `OracleRequest`, the `Scene` types, `pixi.js` `Graphics`/`Text`.
- Produces: `class Overlays` whose `draw(scene)` draws the P0 set (target, rings, cursor, typing, keycaps, cancel);
  the keycap chips of a combo are built once and reused while it shows, and destroyed when the next combo replaces them;
  `StageCanvasHandle` gains `pushEvents(events)`, `resetSession()`, `setClock(clock)`, `setView(view)`, `setTheme(theme)`, `oracle(command: OracleRequest)`;
  `Stage` is a `forwardRef<StageHandle>` (`pushEvents`, `resetSession`, `setClock`, `setView`, `oracle`) with an optional
  `control` prop (default `false`; the rim); `StageHandle` is what Task 15's `useLiveSession` holds.

- [ ] **Step 1: The overlays**

`apps/web/src/stage/overlays.ts` (replace the skeleton with the whole file):
```ts
import type { Camera, CancelScene, CursorScene, KeycapsScene, RingScene, Scene, TargetScene, TypingScene } from "@localdot/stage";
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { CURSOR_TILT_RAD, cursorPolygon, ringRadius } from "./geometry.ts";
import type { StageTheme, ThemeColor } from "./theme.ts";

const FONT = "-apple-system, 'Inter', system-ui, sans-serif";

class Chip extends Container {
  readonly bg = new Graphics();
  readonly text: Text;
  constructor(theme: StageTheme, dpr: number, size: number, fill: ThemeColor) {
    super();
    this.text = new Text({ text: "", style: new TextStyle({ fontFamily: FONT, fontSize: size, fontWeight: "500", fill: fill.color }), resolution: dpr });
    this.addChild(this.bg, this.text);
    this.setTheme(theme);
  }
  setTheme(theme: StageTheme) {
    this.bgColor = theme.hudSolid;
  }
  bgColor: ThemeColor = { color: 0, alpha: 0.92 };
  set(label: string, padX = 8, height = 19): void {
    this.text.text = label;
    const w = this.text.width + padX * 2;
    this.text.position.set(padX, (height - this.text.height) / 2);
    this.bg.clear().roundRect(0, 0, w, height, height / 2).fill({ color: this.bgColor.color, alpha: this.bgColor.alpha });
  }
}

// Draws one Scene. World-space items live in `world` (desktop device px, under the camera);
// screen-constant items counter-scale by `unit` = CSS px in world units; keycaps live in `screen`.
export class Overlays {
  readonly world = new Container();
  readonly screen = new Container();
  #theme: StageTheme;
  readonly #dpr: number;
  #unit = 1;
  #viewport = { w: 1, h: 1 };
  readonly #targetG = new Graphics();
  readonly #ringsG = new Graphics();
  readonly #cursor = new Container();
  readonly #cursorG = new Graphics();
  readonly #nameChip: Chip;
  readonly #targetChip: Chip;
  readonly #typing = new Container();
  readonly #typingBg = new Graphics();
  readonly #typingText: Text;
  readonly #typingMore: Text;
  readonly #caret = new Graphics();
  readonly #cancelChip: Chip;
  readonly #keycaps = new Container();
  #keycapsLabel = "";
  #keycapsWidth = 0;

  constructor(theme: StageTheme, dpr: number) {
    this.#theme = theme;
    this.#dpr = dpr;
    this.#nameChip = new Chip(theme, dpr, 11, theme.text);
    this.#targetChip = new Chip(theme, dpr, 11, theme.text);
    this.#cancelChip = new Chip(theme, dpr, 11, theme.text);
    this.#typingText = new Text({ text: "", style: new TextStyle({ fontFamily: FONT, fontSize: 14, fontWeight: "500", fill: theme.text.color }), resolution: dpr });
    this.#typingMore = new Text({ text: "", style: new TextStyle({ fontFamily: FONT, fontSize: 11, fill: theme.text2.color }), resolution: dpr });
    this.#typing.addChild(this.#typingBg, this.#typingText, this.#typingMore, this.#caret);
    this.#cursor.addChild(this.#cursorG, this.#nameChip);
    this.world.addChild(this.#targetG, this.#ringsG, this.#targetChip, this.#typing, this.#cancelChip, this.#cursor);
    this.screen.addChild(this.#keycaps);
  }

  setTheme(theme: StageTheme): void {
    this.#theme = theme;
    for (const c of [this.#nameChip, this.#targetChip, this.#cancelChip]) c.setTheme(theme);
    this.#keycapsLabel = "";
  }

  setCamera(cam: Camera): void {
    this.#unit = this.#dpr / cam.scale;
  }

  setViewport(w: number, h: number): void {
    this.#viewport = { w, h };
  }

  draw(scene: Scene | null): void {
    this.#targetG.clear();
    this.#ringsG.clear();
    this.#cursor.visible = false;
    this.#targetChip.visible = false;
    this.#typing.visible = false;
    this.#cancelChip.visible = false;
    this.#keycaps.visible = false;
    if (!scene) return;
    if (scene.target) this.#drawTarget(scene.target, scene.control);
    for (const ring of scene.rings) this.#drawRing(ring, scene.control);
    if (scene.cursor?.visible) this.#drawCursor(scene.cursor, scene.control);
    if (scene.typing) this.#drawTyping(scene.typing, scene.control);
    if (scene.keycaps) this.#drawKeycaps(scene.keycaps);
    if (scene.cancel) this.#drawCancel(scene.cancel);
  }

  // Xenon only while the agent has control; a neutral outline otherwise (Theatre).
  #accent(control: boolean): ThemeColor {
    return control ? this.#theme.xenon : this.#theme.text2;
  }

  #drawTarget(t: TargetScene, control: boolean): void {
    const u = this.#unit;
    const g = this.#targetG;
    const accent = this.#accent(control);
    if (t.rect) {
      const pad = 3 * u;
      const r = { x: t.rect.x - pad, y: t.rect.y - pad, w: t.rect.w + 2 * pad, h: t.rect.h + 2 * pad };
      if (t.style === "acting") {
        g.roundRect(r.x, r.y, r.w, r.h, 4 * u).stroke({ width: 2.5 * u, color: this.#theme.haloTarget.color, alpha: this.#theme.haloTarget.alpha * t.alpha, alignment: 1 });
        g.roundRect(r.x, r.y, r.w, r.h, 4 * u).fill({ color: this.#theme.xenonA10.color, alpha: this.#theme.xenonA10.alpha * t.alpha * (control ? 1 : 0) }).stroke({ width: 1.5 * u, color: accent.color, alpha: t.alpha });
      } else {
        this.#dashedRect(g, r, 6 * u, accent, t.alpha);
      }
      if (t.chip) {
        this.#targetChip.visible = true;
        this.#targetChip.set(t.chip);
        this.#targetChip.alpha = t.alpha;
        this.#targetChip.scale.set(u);
        const above = r.y - 24 * u;
        this.#targetChip.position.set(r.x, above < 0 ? r.y + r.h + 5 * u : above);
      }
    } else {
      // Coordinates only: the localization marker (36 px ring, crosshair, centre dot).
      const rr = 18 * u;
      g.circle(t.point.x, t.point.y, rr).fill({ color: this.#theme.xenonA10.color, alpha: this.#theme.xenonA10.alpha * t.alpha * (control ? 1 : 0) }).stroke({ width: 1.5 * u, color: accent.color, alpha: t.alpha });
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        g.moveTo(t.point.x + dx * (rr - 4 * u), t.point.y + dy * (rr - 4 * u)).lineTo(t.point.x + dx * (rr + 6 * u), t.point.y + dy * (rr + 6 * u)).stroke({ width: 1.5 * u, color: accent.color, alpha: t.alpha });
      }
      g.circle(t.point.x, t.point.y, 2 * u).fill({ color: accent.color, alpha: t.alpha });
    }
  }

  #dashedRect(g: Graphics, r: { x: number; y: number; w: number; h: number }, dash: number, c: ThemeColor, alpha: number): void {
    const edges: [number, number, number, number][] = [[r.x, r.y, r.x + r.w, r.y], [r.x + r.w, r.y, r.x + r.w, r.y + r.h], [r.x + r.w, r.y + r.h, r.x, r.y + r.h], [r.x, r.y + r.h, r.x, r.y]];
    for (const [x0, y0, x1, y1] of edges) {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.floor(len / (dash * 2)));
      for (let i = 0; i < n; i++) {
        const a = i / n;
        const b = Math.min(1, a + dash / len);
        g.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a).lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b).stroke({ width: 1.5 * this.#unit, color: c.color, alpha });
      }
    }
  }

  #drawRing(ring: RingScene, control: boolean): void {
    const u = this.#unit;
    const { outer, alpha } = ringRadius(ring.p);
    const accent = this.#accent(control);
    const g = this.#ringsG;
    if (ring.style === "right") {
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2;
        g.arc(ring.x, ring.y, outer * u, a0, a0 + Math.PI / 18).stroke({ width: 2 * u, color: accent.color, alpha });
        g.moveTo(ring.x + Math.cos(a0 + Math.PI / 6) * outer * u, ring.y + Math.sin(a0 + Math.PI / 6) * outer * u);
      }
    } else {
      g.circle(ring.x, ring.y, outer * u).stroke({ width: 2 * u, color: accent.color, alpha });
    }
    g.circle(ring.x, ring.y, outer * 0.55 * u).stroke({ width: 1.5 * u, color: accent.color, alpha: alpha * 0.5 });
  }

  #drawCursor(c: CursorScene, control: boolean): void {
    const u = this.#unit;
    this.#cursor.visible = true;
    this.#cursor.position.set(c.x, c.y);
    this.#cursor.alpha = c.alpha;
    const g = this.#cursorG;
    g.clear();
    const squash = 1 - 0.15 * c.press;
    g.rotation = CURSOR_TILT_RAD;
    g.scale.set(u * squash);
    // A soft dark halo under the arrow (the desktop is light), then rim, fill and the accent stroke.
    g.circle(7, 9, 9).fill({ color: this.#theme.shadeCursor.color, alpha: this.#theme.shadeCursor.alpha * 0.45 });
    const pts = cursorPolygon(1);
    g.poly(pts, true).stroke({ width: 2.6, color: this.#theme.cursorRim.color, alpha: this.#theme.cursorRim.alpha, alignment: 1, join: "round" });
    g.poly(pts, true).fill({ color: this.#theme.cursorFill.color, alpha: this.#theme.cursorFill.alpha });
    if (control) g.poly(pts, true).stroke({ width: 2, color: this.#theme.xenon.color, alpha: this.#theme.xenon.alpha, alignment: 0, join: "round" });
    // The name chip sits below-right, clear of the arrow so the oracle can isolate the arrow.
    this.#nameChip.visible = true;
    this.#nameChip.scale.set(u);
    this.#nameChip.position.set(14 * u, 30 * u);
    if (c.chipAlpha > 0) {
      this.#nameChip.set(c.name, 8, 19);
      this.#nameChip.alpha = c.chipAlpha;
    } else {
      this.#nameChip.set("", 3, 6);
      this.#nameChip.alpha = 1;
    }
  }

  #drawTyping(t: TypingScene, control: boolean): void {
    const u = this.#unit;
    this.#typing.visible = true;
    this.#typing.scale.set(u);
    this.#typing.alpha = t.alpha;
    const label = t.more > 0 ? `${t.text}` : t.text;
    this.#typingText.text = `⌨ ${label}`;
    this.#typingMore.text = t.more > 0 ? `+${t.more} more` : "";
    const padX = 12;
    const h = 32;
    const w = padX + this.#typingText.width + (t.more > 0 ? 8 + this.#typingMore.width : 0) + 10 + padX;
    this.#typingBg.clear().roundRect(0, 0, w, h, 16).fill({ color: this.#theme.hudSolid.color, alpha: this.#theme.hudSolid.alpha }).stroke({ width: 1, color: this.#theme.hudLine.color, alpha: this.#theme.hudLine.alpha, alignment: 0 });
    this.#typingText.position.set(padX, (h - this.#typingText.height) / 2);
    this.#typingMore.position.set(padX + this.#typingText.width + 8, (h - this.#typingMore.height) / 2);
    this.#caret.clear();
    if (t.caretOn) this.#caret.rect(padX + this.#typingText.width + 2, 8, 2, 16).fill({ color: this.#accent(control).color, alpha: 1 });
    const x = t.anchor.x - 4 * u;
    const y = t.anchor.y - (h + 33) * u;
    this.#typing.position.set(x, y < 0 ? t.anchor.y + 40 * u : y);
  }

  #drawKeycaps(k: KeycapsScene): void {
    this.#keycaps.visible = true;
    const dpr = this.#dpr;
    // A combo's chips (a Graphics and a Text texture each) are built once and drawn on every frame
    // it shows; the previous combo's are destroyed, never left for the GPU to collect.
    const label = k.keys.join("+");
    if (label !== this.#keycapsLabel) {
      for (const old of this.#keycaps.removeChildren()) old.destroy({ children: true });
      let x = 0;
      for (const key of k.keys) {
        const chip = new Chip(this.#theme, dpr, 13, this.#theme.text);
        chip.set(key, 9, 30);
        chip.bg.rect(0, 28, chip.bg.width, 2).fill({ color: this.#theme.keyBevel.color, alpha: this.#theme.keyBevel.alpha });
        chip.position.set(x, 0);
        x += chip.bg.width + 6;
        this.#keycaps.addChild(chip);
      }
      this.#keycapsLabel = label;
      this.#keycapsWidth = x - 6;
    }
    this.#keycaps.scale.set(dpr * k.scale);
    this.#keycaps.alpha = k.alpha * 0.9;
    // `dy` lifts the chips 20 px into place while they pop in (research §4.3.6).
    this.#keycaps.position.set(this.#viewport.w / 2 - (this.#keycapsWidth * dpr * k.scale) / 2, this.#viewport.h - (46 + 30 * k.scale - k.dy) * dpr);
  }

  #drawCancel(c: CancelScene): void {
    this.#cancelChip.visible = true;
    this.#cancelChip.scale.set(this.#unit);
    this.#cancelChip.set(`Blocked · ${c.reason}`);
    this.#cancelChip.alpha = c.alpha;
    this.#cancelChip.position.set(c.x + (14 + c.dx) * this.#unit, c.y + 52 * this.#unit);
  }
}
```

Run: `pnpm exec vitest run apps/web/src/stage && pnpm --filter @localdot/web typecheck`
Expected: pass (the class is exercised through the worker; no unit test draws with WebGL).

- [ ] **Step 2: The stage handle and the rim**

`apps/web/src/stage/StageCanvas.tsx` (replace the whole file; the Task 14a canvas plus the session
methods and the live motion preference):
```tsx
import type { LocalDotEvent } from "@localdot/protocol";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FrameSource } from "./frame-source.ts";
import type { Flip, ProbeRect } from "./probe.ts";
import type { PumpStats } from "./pump.ts";
import { readTheme, type StageTheme } from "./theme.ts";
import type { OracleCommand, OracleRequest, StageClock, StageViewPatch, WorkerIn, WorkerOut } from "./worker-protocol.ts";

export interface StageCanvasHandle {
  attach(source: FrameSource): void;
  detach(): void;
  probe(rect: ProbeRect | null, threshold?: number): void;
  pushEvents(events: LocalDotEvent[]): void;
  resetSession(): void;
  setClock(clock: StageClock): void;
  setView(view: StageViewPatch): void;
  setTheme(theme: StageTheme): void;
  oracle(command: OracleRequest): Promise<unknown>;
}

export interface StageCanvasProps {
  onStats?(stats: PumpStats): void;
  onFlip?(flip: Flip): void;
}

export const reducedMotionQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

export const StageCanvas = forwardRef<StageCanvasHandle, StageCanvasProps>(function StageCanvas({ onStats, onFlip }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onFlipRef = useRef(onFlip);
  onFlipRef.current = onFlip;
  const pendingOracle = useRef(new Map<number, (v: unknown) => void>());
  const oracleSeq = useRef(0);
  const [stats, setStats] = useState<PumpStats | null>(null);

  // The worker owns the canvas for the component's lifetime. It starts with the theme's colours,
  // the device pixel ratio and the motion preference, read here: the canvas renders only where
  // frames can be tapped, so jsdom and browsers without WebCodecs never reach them. A change of the
  // motion preference is a message.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const theme = readTheme(getComputedStyle(document.documentElement));
    const motion = reducedMotionQuery();
    const worker = new Worker(new URL("./render-worker.ts", import.meta.url), { type: "module" });
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "init", canvas: offscreen, width: Math.max(1, Math.round(rect.width * dpr)), height: Math.max(1, Math.round(rect.height * dpr)), dpr, theme, reducedMotion: motion.matches } satisfies WorkerIn, [offscreen]);
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "stats") {
        setStats(m.stats);
        onStatsRef.current?.(m.stats);
      } else if (m.type === "flip") onFlipRef.current?.(m.flip);
      else if (m.type === "oracle-reply") {
        pendingOracle.current.get(m.id)?.(m.reply);
        pendingOracle.current.delete(m.id);
      } else if (m.type === "warn") console.warn(`stage worker: ${m.message}`);
      else console.error(`stage worker: ${m.message}`);
    };
    const onMotion = () => worker.postMessage({ type: "view", view: { reducedMotion: motion.matches } } satisfies WorkerIn);
    motion.addEventListener("change", onMotion);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry?.devicePixelContentBoxSize?.[0];
      const width = box ? box.inlineSize : Math.round((entry?.contentRect.width ?? 0) * dpr);
      const height = box ? box.blockSize : Math.round((entry?.contentRect.height ?? 0) * dpr);
      if (width > 0 && height > 0) worker.postMessage({ type: "resize", width, height } satisfies WorkerIn);
    });
    observer.observe(canvas);
    workerRef.current = worker;
    return () => {
      motion.removeEventListener("change", onMotion);
      observer.disconnect();
      sourceRef.current?.stop();
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    attach(source) {
      sourceRef.current?.stop();
      sourceRef.current = source;
      const worker = workerRef.current;
      if (!worker) {
        source.first?.close();
        return;
      }
      // S8's seed frame travels with the readable; both are transferred.
      const transfer: Transferable[] = source.first ? [source.readable, source.first] : [source.readable];
      worker.postMessage({ type: "frames", readable: source.readable, first: source.first } satisfies WorkerIn, transfer);
    },
    detach() {
      sourceRef.current?.stop();
      sourceRef.current = null;
      workerRef.current?.postMessage({ type: "stop" } satisfies WorkerIn);
    },
    probe(rect, threshold = 128) {
      workerRef.current?.postMessage({ type: "probe", rect, threshold } satisfies WorkerIn);
    },
    pushEvents(events) {
      workerRef.current?.postMessage({ type: "events", events } satisfies WorkerIn);
    },
    resetSession() {
      workerRef.current?.postMessage({ type: "session-reset" } satisfies WorkerIn);
    },
    setClock(clock) {
      workerRef.current?.postMessage({ type: "clock", clock } satisfies WorkerIn);
    },
    setView(view) {
      workerRef.current?.postMessage({ type: "view", view } satisfies WorkerIn);
    },
    // A theme pack restyles the stage by sending its parsed tokens (the stage reads theme.css once).
    setTheme(theme) {
      workerRef.current?.postMessage({ type: "theme", theme } satisfies WorkerIn);
    },
    oracle(command) {
      const id = ++oracleSeq.current;
      return new Promise((resolve) => {
        pendingOracle.current.set(id, resolve);
        workerRef.current?.postMessage({ type: "oracle", command: { ...command, id } as OracleCommand } satisfies WorkerIn);
      });
    },
  }));

  return <canvas ref={canvasRef} className="stage-canvas" data-frames={stats?.presented ?? 0} data-fps={stats?.fps ?? 0} data-size={stats ? `${stats.width}x${stats.height}` : ""} aria-label="The virtual computer" />;
});
```

`apps/web/src/stage/Stage.tsx` (replace the whole file: Part 2's stage with Task 6's probe hook, plus
the handle, the freeze and zoom view, and the rim):
```tsx
import type { LocalDotEvent } from "@localdot/protocol";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { DesktopFrame } from "./DesktopFrame.tsx";
import { type FrameSource, frameTapSupport } from "./frame-source.ts";
import type { Flip, ProbeRect } from "./probe.ts";
import { StageCanvas, type StageCanvasHandle } from "./StageCanvas.tsx";
import type { OracleRequest, StageClock, StageViewPatch } from "./worker-protocol.ts";

export interface ProbeApi {
  start(rect: ProbeRect, threshold?: number): void;
  stop(): void;
  flips(): Flip[];
  clear(): void;
}

export interface StageHandle {
  pushEvents(events: LocalDotEvent[]): void;
  resetSession(): void;
  setClock(clock: StageClock): void;
  setView(view: StageViewPatch): void;
  oracle(command: OracleRequest): Promise<unknown>;
}

export interface StageProps {
  cell: CellSummary | null;
  api: ApiClient;
  // The agent has control: the stage wears the xenon rim.
  control?: boolean;
}

declare global {
  interface Window {
    __localdot?: { probe?: ProbeApi; oracle?: unknown };
  }
}

// The client keys localStorage by its page path, and every ticket is a new path (S8).
function forgetClientStorage(cellId: string): void {
  const marker = `_cells_${cellId}_desktop_`;
  for (const key of Object.keys(window.localStorage)) {
    if (key.includes(marker)) window.localStorage.removeItem(key);
  }
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage({ cell, api, control = false }, ref) {
  const support = frameTapSupport();
  const canvas = useRef<StageCanvasHandle>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";
  const flips = useRef<Flip[]>([]);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  // A self-reloading client reuses its ticket, which dies with the daemon: a new generation mints a
  // new ticket and remounts the iframe (S8).
  useEffect(() => {
    if (!cellId || !ready || !support.ok) {
      setSrc(null);
      canvas.current?.detach();
      return;
    }
    let cancelled = false;
    forgetClientStorage(cellId);
    api.post<{ path: string }>(`/api/cells/${cellId}/stream-ticket?g=${generation}`).then(
      ({ path }) => {
        if (!cancelled) setSrc(path);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, cellId, ready, support.ok, generation]);

  // Overlays freeze while the stream is not live (spec, error handling); zoom comes from ?zoom= for tests.
  const paused = cell?.stream.connection === "stalled" || cell?.stream.connection === "disconnected";
  useEffect(() => {
    canvas.current?.setView({ freeze: paused, zoom: Number(params.get("zoom") ?? 1) || 1 });
  }, [paused, params]);

  const onSource = useCallback((source: FrameSource) => canvas.current?.attach(source), []);
  const onLost = useCallback(() => setGeneration((g) => g + 1), []);
  const onFlip = useCallback((flip: Flip) => {
    flips.current.push(flip);
  }, []);

  useEffect(() => {
    if (params.get("probe") !== "1") return;
    const probe: ProbeApi = {
      start: (rect, threshold = 128) => canvas.current?.probe(rect, threshold),
      stop: () => canvas.current?.probe(null),
      flips: () => flips.current,
      clear: () => {
        flips.current = [];
      },
    };
    window.__localdot = { ...window.__localdot, probe };
    return () => {
      if (window.__localdot) window.__localdot.probe = undefined;
    };
  }, [params]);

  useImperativeHandle(ref, () => ({
    pushEvents: (events) => canvas.current?.pushEvents(events),
    resetSession: () => canvas.current?.resetSession(),
    setClock: (clock) => canvas.current?.setClock(clock),
    setView: (view) => canvas.current?.setView(view),
    oracle: (command) => canvas.current?.oracle(command) ?? Promise.resolve(undefined),
  }));

  if (!support.ok) {
    return (
      <div className="stage-veil" role="alert">
        <p>{support.reason}</p>
      </div>
    );
  }
  return (
    <>
      <StageCanvas ref={canvas} onFlip={onFlip} />
      {src && <DesktopFrame key={`${src} ${generation}`} src={src} onSource={onSource} onLost={onLost} />}
      <div className={paused ? "stage-veil on" : "stage-veil"} aria-hidden={!paused}>
        <p>Reconnecting…</p>
      </div>
      {control && <div className="rim" aria-hidden="true" />}
    </>
  );
});
```
(`control` is passed by Task 15's Theatre; until then `App.tsx`'s `<Stage cell={cell} api={api} />`
draws no rim.)

`apps/web/src/app.css` — the stage rim (the mockup's `.rim`, only while the agent has control):
```css
.stage > .rim {
  position: absolute;
  inset: -2px;
  border-radius: calc(var(--radius-stage) + 2px);
  pointer-events: none;
  box-shadow: 0 0 0 2px var(--color-xenon), 0 0 28px 2px var(--color-xenon-a40);
  z-index: 3;
}
```

Run: `pnpm exec vitest run apps/web/src && pnpm --filter @localdot/web typecheck && pnpm --filter @localdot/web build`
Expected: tests pass; the build still emits the `render-worker-*.js` chunk.

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web
git commit -m "feat(web): P0 overlays on the PixiJS stage and the session handle"
```

---
### Task 15: The live session in the Theatre — HUD, caption, steps, Stop

The page discovers the live session of its cell, streams its events into the stage worker and
into a React model updated at most 10 times a second, maps the viewer's clock onto the daemon's,
and renders the Theatre's HUD states from the log: `dot Clicking "Name Box" · 12 s` with a neutral
Stop, the caption under the stage, the xenon rim while the agent has control, and a step list with
thumbnails cropped around each step's target. A finished session stays on screen, its verdict
("Done", "Stopped", "Failed") on the HUD and its steps in the rail, until the next one starts.
Frames are fetched with the bearer token and shown as blob URLs (cookie-free auth).

**Files:**
- Create: `apps/web/src/session/useLiveSession.ts`, `apps/web/src/session/session-view.ts`,
  `apps/web/src/session/thumbnails.ts`, `apps/web/src/session/useNowMs.ts`, `apps/web/src/shell/StepRow.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/shell/Hud.tsx`, `apps/web/src/shell/PlanRail.tsx`,
  `apps/web/src/shell/StageColumn.tsx`, `apps/web/src/app.css`, `apps/web/src/lib/api.ts`,
  `packages/stage/src/model.ts` (observe frames per step), `apps/daemon/src/gateway/routes.ts`
- Test: `apps/web/src/session/session-view.test.ts`, `apps/web/src/App.test.tsx`,
  `apps/daemon/src/gateway/routes.test.ts`

**Interfaces:**
- Consumes: `StageHandle` (Task 14b), `openSocket`, `createApi`, `useCell`, `hudFor`; `foldEvents`, `sceneAt` from `@localdot/stage`;
  `syncClock` (Task 6); the daemon's `/api/cells/:id/live`, `/api/sessions/:id/stream`, `/api/sessions/:id/stop`, `/api/sessions/:id/frames/:frameId`.
- Produces: daemon route `GET /api/sessions/:id/clock → { originMicros; nowMicros }`;
  `useLiveSession(api, cell, stage): { sessionId; model; version; ended; stop() }` (model mutated in place, `version` bumps ≤ 10 Hz;
  an ended session stays until `/live` names another); `ApiClient` gains `token`, `authorization()` and `fetch`;
  `SessionModel.frames` (the observe frame per step);
  `sessionHud(model, nowMs): SessionHud { label; caption; elapsedS; control; state }`, `stepRows(model): StepRow[]`,
  `mergeHud(hud: HudState, session: SessionHud | null): HudState & { control; elapsedS?; stop?: boolean }`
  (a finished session's verdict stays the label while the computer is live); `useNowMs(model, version)`;
  `thumbnailUrl(api, sessionId, frameId): Promise<string>` (cached blob URLs); `StepRow` component.

- [ ] **Step 1: The daemon's session clock route**

Append to `gatewayRoutes` in `apps/daemon/src/gateway/routes.ts`:
```ts
  app.get("/api/sessions/:id/clock", (c) => {
    const id = c.req.param("id") ?? "";
    const log = deps.eventLog;
    if (!log || !ULID_PATTERN.test(id) || !log.hasSession(id)) return c.text("unknown session", 404);
    return c.json({ originMicros: log.originOf(id), nowMicros: deps.clock.nowMicros() });
  });
```
and to `routes.test.ts`'s puppet describe:
```ts
  it("serves a session's clock origin", async () => {
    const { app, eventLog } = setup();
    const id = eventLog.createSession("c");
    const body = (await (await app.request(url(`/api/sessions/${id}/clock`), { headers: bearer })).json()) as { originMicros: number; nowMicros: number };
    expect(body.nowMicros).toBeGreaterThanOrEqual(body.originMicros);
    expect((await app.request(url("/api/sessions/01JXYZ0000000000000000ABCD/clock"), { headers: bearer })).status).toBe(404);
  });
```
Run: `pnpm exec vitest run apps/daemon/src/gateway/routes.test.ts` — Expected: pass.

- [ ] **Step 2: Pure session views, test first**

`apps/web/src/session/session-view.test.ts`:
```ts
import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { hudFor } from "../cells/hud-state.ts";
import { mergeHud, sessionHud, stepRows } from "./session-view.ts";

let seq = 0;
const ev = (type: string, tMs: number, data: Record<string, unknown>, step?: string): LocalDotEvent =>
  ({ v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: seq++, t: msToMicros(tMs), agent: "main", ...(step ? { step } : {}), type, data }) as LocalDotEvent;
const log = [
  ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "Demo" }),
  ev("agent.state", 1, { state: "acting" }),
  ev("step.start", 10, { kind: "gui" }, "s1"),
  ev("action.intent", 20, { verb: "click", label: 'Click "Name Box"', point: { x: 100, y: 200 }, risk: "none" }, "s1"),
  ev("action.target", 30, { target: { point: { x: 100, y: 200 }, bbox: { x: 80, y: 190, w: 40, h: 20 }, source: "ax", role: "text", name: "Name Box" } }, "s1"),
  ev("action.dispatch", 600, { input: { kind: "click", button: "left", count: 1, at: { x: 100, y: 200 } }, pressT: 598_000, ringAt: 621_100, injector: "xtest" }, "s1"),
  ev("observe", 1000, { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", width: 1280, height: 800 }, "s1"),
  ev("action.result", 1010, { ok: true }, "s1"),
  ev("step.end", 1020, { status: "ok" }, "s1"),
  ev("step.start", 1100, { kind: "gui" }, "s2"),
  ev("action.intent", 1110, { verb: "type", label: 'Type "B2"', point: { x: 100, y: 200 }, risk: "none" }, "s2"),
];
const cell = { id: "01JXYZ0000000000000000ABCD", state: "ready" as const, scale: 2 as const, createdAt: "", stream: { connection: "live" as const, viewers: 1, lastUpstreamAt: null } };

describe("sessionHud", () => {
  it("labels the current action in the present progressive with the elapsed time after 5 s", () => {
    const m = foldEvents(emptyModel(), log);
    expect(sessionHud(m, 1200)).toMatchObject({ label: 'Typing "B2"', control: true, state: "working", elapsedS: null });
    expect(sessionHud(m, 7200)).toMatchObject({ elapsedS: 7 });
    expect(sessionHud(foldEvents(emptyModel(), [...log, ev("session.end", 2000, { reason: "done" })]), 2500)).toMatchObject({ label: "Done", control: false, state: "done" });
  });

  it("merges into the cell HUD: the session owns the label and the Stop while live", () => {
    const merged = mergeHud(hudFor(cell, false), sessionHud(foldEvents(emptyModel(), log), 1200));
    expect(merged).toMatchObject({ label: 'Typing "B2"', action: "none", stop: true, control: true, live: true });
    expect(mergeHud(hudFor(cell, false), null)).toMatchObject({ label: "Live", action: "stop", control: false });
    // A finished session keeps its verdict on the HUD while the computer is live, and gives the
    // computer's own Stop back.
    const done = sessionHud(foldEvents(emptyModel(), [...log, ev("session.end", 2000, { reason: "done" })]), 2500);
    expect(mergeHud(hudFor(cell, false), done)).toMatchObject({ label: "Done", caption: "Done.", action: "stop", control: false });
    expect(mergeHud(hudFor(cell, false), done).stop).toBeUndefined();
  });

  it("lists steps with their thumbnail and target", () => {
    const rows = stepRows(foldEvents(emptyModel(), log));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "s1", label: 'Clicked "Name Box"', status: "ok", frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", target: { x: 80, y: 190, w: 40, h: 20 }, durationMs: 990 });
    expect(rows[1]).toMatchObject({ id: "s2", label: 'Typing "B2"', status: "doing" });
  });
});
```

`apps/web/src/session/session-view.ts`:
```ts
import { msToSeconds, type Rect } from "@localdot/protocol";
import { type ActionState, type SessionModel, sceneAt } from "@localdot/stage";
import type { HudState } from "../cells/hud-state.ts";

export interface SessionHud {
  label: string;
  caption: string;
  elapsedS: number | null;
  control: boolean;
  state: "working" | "idle" | "done" | "stopped" | "error";
}

export interface StepRowView {
  id: string;
  label: string;
  status: "doing" | "ok" | "failed" | "cancelled";
  frameId?: string;
  target?: Rect;
  durationMs: number | null;
}

const PROGRESSIVE: [RegExp, string][] = [[/^Click\b/, "Clicking"], [/^Type\b/, "Typing"], [/^Press\b/, "Pressing"], [/^Scroll\b/, "Scrolling"], [/^Open\b/, "Opening"], [/^Wait\b/, "Waiting"]];
const PAST: [RegExp, string][] = [[/^Click\b/, "Clicked"], [/^Type\b/, "Typed"], [/^Press\b/, "Pressed"], [/^Scroll\b/, "Scrolled"], [/^Open\b/, "Opened"], [/^Wait\b/, "Waited"]];
const tense = (label: string, table: [RegExp, string][]) => table.reduce((l, [re, to]) => l.replace(re, to), label);

export function sessionHud(model: SessionModel, nowMs: number): SessionHud {
  const scene = sceneAt(model, nowMs, { reducedMotion: true });
  const elapsedS = scene.hud.elapsedMs >= 5000 ? Math.floor(msToSeconds(scene.hud.elapsedMs)) : null;
  if (scene.hud.state === "done") return { label: "Done", caption: "Done.", elapsedS, control: false, state: "done" };
  if (scene.hud.state === "stopped") return { label: "Stopped", caption: "Stopped.", elapsedS, control: false, state: "stopped" };
  if (scene.hud.state === "error") return { label: "Failed", caption: scene.hud.label || "The step failed.", elapsedS, control: false, state: "error" };
  const label = scene.hud.label ? tense(scene.hud.label, PROGRESSIVE) : "Working";
  return { label, caption: scene.hud.label || "Starting…", elapsedS, control: scene.control, state: scene.hud.state === "working" ? "working" : "idle" };
}

export function mergeHud(hud: HudState, session: SessionHud | null): HudState & { control: boolean; elapsedS?: number | null; stop?: boolean } {
  if (!session) return { ...hud, control: false };
  if (session.state === "done" || session.state === "stopped" || session.state === "error") {
    // A finished session keeps its verdict while the computer is live; the computer's controls return.
    return { ...hud, ...(hud.live ? { label: session.label } : {}), caption: session.caption, control: false };
  }
  return { ...hud, label: session.label, caption: session.caption, action: "none", control: session.control, elapsedS: session.elapsedS, stop: true };
}

export function stepRows(model: SessionModel): StepRowView[] {
  const rows = new Map<string, StepRowView>();
  const stepOf = (a: ActionState) => a.step ?? a.id;
  for (const a of model.actions) {
    const id = stepOf(a);
    const done = a.resultT ?? a.cancel?.t;
    const status: StepRowView["status"] = a.cancel ? (a.cancel.reason === "user" ? "cancelled" : "failed") : a.resultT === undefined ? "doing" : a.ok ? "ok" : "failed";
    rows.set(id, {
      id,
      label: done === undefined ? tense(a.label, PROGRESSIVE) : tense(a.label, PAST),
      status,
      ...(a.target?.bbox ? { target: a.target.bbox } : {}),
      durationMs: done === undefined ? null : Math.round(done - a.intentT),
    });
  }
  // The frame a step ends with is the observe appended inside it; the model keeps observes by
  // step through the actions' order: the latest observe at or before the result belongs to it.
  return [...rows.values()].map((row) => ({ ...row, ...(frameFor(model, row.id) ? { frameId: frameFor(model, row.id) } : {}) }));
}

function frameFor(model: SessionModel, step: string): string | undefined {
  return model.frames?.get(step);
}
```
The model needs the observe frames per step: in `packages/stage/src/model.ts` add
`frames: Map<string, string>` to `SessionModel` (initialised in `emptyModel()`), and in `foldEvents`
handle `case "observe": if (e.step) model.frames.set(e.step, e.data.frameId); break;` (the Task 13
model test's `toEqual` comparisons still hold: both sides fold the same events).

`apps/web/src/session/thumbnails.ts`:
```ts
import type { ApiClient } from "../lib/api.ts";

const cache = new Map<string, Promise<string>>();

// Frames sit behind the install token, which an <img> cannot send: fetch with the header and show
// a blob URL (cookie-free auth, trust rule 6).
export function thumbnailUrl(api: ApiClient, sessionId: string, frameId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = `${sessionId}/${frameId}`;
  let p = cache.get(key);
  if (!p) {
    p = fetchImpl(`${api.socketUrl("").replace(/^ws/, "http")}/api/sessions/${sessionId}/frames/${frameId}`, { headers: { authorization: api.authorization() } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`frame ${frameId}: ${res.status}`);
        return URL.createObjectURL(await res.blob());
      });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
```
`apps/web/src/lib/api.ts` — add `authorization(): string` to `ApiClient` returning `` `Bearer ${token}` ``
and `fetch: typeof fetch` (the client's injected `fetchImpl`, so the clock sync and the thumbnails go
through the same fetch the tests script); both on `createApi`'s object.

Run: `pnpm exec vitest run apps/web/src/session packages/stage`
Expected: the session-view tests pass; the stage tests still pass.

- [ ] **Step 3: The hook, the shell changes and the wiring**

`apps/web/src/session/useLiveSession.ts`:
```ts
import type { LocalDotEvent } from "@localdot/protocol";
import { emptyModel, foldEvents, type SessionModel } from "@localdot/stage";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { openSocket, type SocketHandle } from "../lib/socket.ts";
import type { StageHandle } from "../stage/Stage.tsx";
import { syncClock } from "./clock-sync.ts";

export interface LiveSession {
  sessionId: string | null;
  model: SessionModel;
  version: number;
  ended: boolean;
  stop(): void;
}

const POLL_MS = 1000;
const REACT_HZ_MS = 100;
const CLOCK_EVERY_MS = 20_000;

// The worker gets every event at once; React sees the model at most ten times a second.
export function useLiveSession(api: ApiClient, cell: CellSummary | null, stage: RefObject<StageHandle | null>): LiveSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [ended, setEnded] = useState(false);
  const modelRef = useRef<SessionModel>(emptyModel());
  const dirty = useRef(false);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";

  // Looks for a live session while there is none or the shown one has ended; an ended session
  // stays on screen until the cell starts another.
  useEffect(() => {
    if (!cellId || !ready || (sessionId && !ended)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const live = await api.get<{ sessionId: string }>(`/api/cells/${cellId}/live`);
        if (!cancelled && live.sessionId !== sessionId) setSessionId(live.sessionId);
      } catch {}
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, cellId, ready, sessionId, ended]);

  useEffect(() => {
    if (!sessionId) return;
    modelRef.current = emptyModel();
    stage.current?.resetSession();
    setEnded(false);
    setVersion((v) => v + 1);
    let socket: SocketHandle | undefined;
    let closed = false;
    const origin = api.socketUrl("").replace(/^ws/, "http");
    // The API's own fetch (injected in tests); a failed sync keeps the last clock and retries on
    // the timer instead of surfacing as an unhandled rejection.
    const clock = async () => {
      try {
        const [viewer, session] = await Promise.all([syncClock(api.fetch, origin, api.token), api.get<{ originMicros: number }>(`/api/sessions/${sessionId}/clock`)]);
        stage.current?.setClock({ offsetMicros: viewer.offsetMicros, originMicros: session.originMicros });
      } catch (err) {
        console.warn(`clock sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void clock();
    const clockTimer = setInterval(() => void clock(), CLOCK_EVERY_MS);
    const flush = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        setVersion((v) => v + 1);
      }
    }, REACT_HZ_MS);
    socket = openSocket({
      url: api.socketUrl(`/api/sessions/${sessionId}/stream`),
      protocols: api.socketProtocols(),
      handlers: {
        onMessage: (data) => {
          const event = JSON.parse(data) as LocalDotEvent;
          foldEvents(modelRef.current, [event]);
          stage.current?.pushEvents([event]);
          dirty.current = true;
          if (event.type === "session.end") {
            closed = true;
            socket?.close();
            setEnded(true);
          }
        },
      },
    });
    return () => {
      clearInterval(clockTimer);
      clearInterval(flush);
      if (!closed) socket?.close();
    };
  }, [api, sessionId, stage]);

  const stop = useCallback(() => {
    if (sessionId) void api.post(`/api/sessions/${sessionId}/stop`).catch(() => {});
  }, [api, sessionId]);

  return { sessionId, model: modelRef.current, version, ended, stop };
}
```
`apps/web/src/lib/api.ts` — also expose `token` on `ApiClient` (`readonly token: string`).

`apps/web/src/shell/Hud.tsx` (replace):
```tsx
import type { HudState } from "../cells/hud-state.ts";
import { Mascot } from "./Mascot.tsx";

export interface HudProps {
  hud: HudState & { control?: boolean; elapsedS?: number | null; stop?: boolean };
  onStart(): void;
  onStop(): void;
  onStopSession(): void;
}

export function Hud({ hud, onStart, onStop, onStopSession }: HudProps) {
  return (
    <div className="hud" role="status" aria-live="polite">
      <span className="st">
        <Mascot size={18} />
        <span data-testid="hud-status">{hud.label}</span>
        {hud.elapsedS != null && <span className="t num" data-testid="hud-elapsed">{hud.elapsedS} s</span>}
      </span>
      <span className="acts">
        {hud.stop && (
          <>
            <button type="button" className="a" disabled title="Take over arrives with M5">
              Take over
            </button>
            <button type="button" className="a" onClick={onStopSession} data-testid="hud-stop-session">
              <span className="sq" aria-hidden="true" />
              Stop
            </button>
          </>
        )}
        {!hud.stop && hud.action === "start" && (
          <button type="button" className="a" onClick={onStart}>
            Start computer
          </button>
        )}
        {!hud.stop && hud.action === "stop" && (
          <button type="button" className="a" onClick={onStop}>
            <span className="sq" aria-hidden="true" />
            Stop computer
          </button>
        )}
      </span>
    </div>
  );
}
```
`apps/web/src/shell/StageColumn.tsx` (replace):
```tsx
import type { ReactNode } from "react";
import { Caption } from "./Caption.tsx";
import { Hud, type HudProps } from "./Hud.tsx";

export interface StageColumnProps extends HudProps {
  control: boolean;
  children?: ReactNode;
}

export function StageColumn({ hud, control, onStart, onStop, onStopSession, children }: StageColumnProps) {
  const classes = ["stage", hud.live ? "lit" : "", control ? "control" : ""].filter(Boolean).join(" ");
  return (
    <main className="stage-col">
      <div className={classes}>
        {children}
        <Hud hud={hud} onStart={onStart} onStop={onStop} onStopSession={onStopSession} />
      </div>
      <Caption text={hud.caption} />
    </main>
  );
}
```
`apps/web/src/shell/Caption.tsx` (Part 2's) is unchanged: the caption text comes from the merged HUD.

`apps/web/src/shell/StepRow.tsx`:
```tsx
import { msToSeconds } from "@localdot/protocol";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import type { StepRowView } from "../session/session-view.ts";
import { thumbnailUrl } from "../session/thumbnails.ts";

// A 160×100 crop of the step's settled frame around its target (the mockup's thumb), from the
// 1280×800 observe image; target rects are device px, so they are divided by the scale.
export function StepRow({ row, sessionId, scale, api, current }: { row: StepRowView; sessionId: string; scale: number; api: ApiClient; current: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!row.frameId) return;
    let cancelled = false;
    thumbnailUrl(api, sessionId, row.frameId).then((u) => { if (!cancelled) setUrl(u); }, () => {});
    return () => { cancelled = true; };
  }, [api, sessionId, row.frameId]);
  const t = row.target ? { x: row.target.x / scale, y: row.target.y / scale, w: row.target.w / scale, h: row.target.h / scale } : null;
  const z = t ? Math.min(1, Math.max(0.25, 60 / Math.max(t.w, t.h, 30))) : 0.125;
  const cx = t ? t.x + t.w / 2 : 640;
  const cy = t ? t.y + t.h / 2 : 400;
  return (
    <div className={current ? "step now" : "step"} data-testid="step-row" data-status={row.status}>
      <div className="step-cap">{row.label}</div>
      <div className="step-row">
        <div className="thumb">
          {url && <img src={url} alt="" style={{ width: 1280 * z, left: 80 - cx * z, top: 50 - cy * z }} />}
          {t && url && <span className="tb" style={{ left: 80 + (t.x - cx) * z - 2, top: 50 + (t.y - cy) * z - 2, width: t.w * z + 4, height: t.h * z + 4 }} />}
        </div>
        <div className="meta">
          <span className={row.status === "ok" ? "okg" : row.status === "doing" ? "pr" : "err"} role="img" aria-label={row.status} />
          <span className="num">{row.durationMs === null ? "…" : `${msToSeconds(row.durationMs).toFixed(1)} s`}</span>
        </div>
      </div>
    </div>
  );
}
```
`apps/web/src/shell/PlanRail.tsx` (replace):
```tsx
import type { ApiClient } from "../lib/api.ts";
import type { StepRowView } from "../session/session-view.ts";
import { StepRow } from "./StepRow.tsx";

export interface PlanRailProps {
  rows: StepRowView[];
  sessionId: string | null;
  scale: number;
  api: ApiClient;
  title: string | null;
}

export function PlanRail({ rows, sessionId, scale, api, title }: PlanRailProps) {
  return (
    <aside className="rail r" aria-label="Plan and steps">
      <div className="rail-h">
        <span>Plan</span>
      </div>
      <p className="say empty">{title ?? "No plan yet."}</p>
      <div className="rail-h">
        <span>Steps</span>
        {sessionId && <span>Following live</span>}
      </div>
      {sessionId && rows.length > 0 ? (
        <div className="steps">
          {rows.map((row, i) => (
            <StepRow key={row.id} row={row} sessionId={sessionId} scale={scale} api={api} current={i === rows.length - 1 && row.status === "doing"} />
          ))}
        </div>
      ) : (
        <p className="say empty">Steps appear here as dot works.</p>
      )}
    </aside>
  );
}
```

`apps/web/src/App.tsx` — import `useRef`, `type StageHandle` (with `Stage`), `useLiveSession`,
`useNowMs` and `mergeHud`, `sessionHud`, `stepRows` (`./session/…`); in `Theatre`, after Part 2's
`useCell` and `hudFor` lines (its title effect gives way to the one below, which follows the merged
label), the rest of the function becomes:
```tsx
  const stage = useRef<StageHandle>(null);
  const session = useLiveSession(api, cell, stage);
  const now = useNowMs(session.model, session.version);
  const sHud = session.sessionId ? sessionHud(session.model, now) : null;
  const merged = mergeHud(error ? { ...hud, caption: error } : hud, sHud);
  const rows = session.sessionId ? stepRows(session.model) : [];
  useEffect(() => { document.title = `localDot — ${merged.label}`; }, [merged.label]);
  return (
    <div className={merged.control ? "app control" : "app"}>
      <TopBar title={session.model.title ?? "Your computer"} live={hud.live} />
      <div className="house">
        <ConversationRail />
        <StageColumn hud={merged} control={merged.control} onStart={start} onStop={stop} onStopSession={session.stop}>
          <Stage ref={stage} cell={cell} api={api} control={merged.control} />
        </StageColumn>
        <PlanRail rows={rows} sessionId={session.sessionId} scale={cell?.scale ?? 2} api={api} title={session.model.title} />
      </div>
    </div>
  );
```
with `apps/web/src/session/useNowMs.ts`:
```ts
import type { SessionModel } from "@localdot/stage";
import { useEffect, useMemo, useState } from "react";

// The HUD's "now" in session ms: the latest folded event's time plus the wall-clock time since it
// arrived, re-anchored on every model version and re-read once a second for the elapsed counter.
export function useNowMs(model: SessionModel, version: number): number {
  const [, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is folded in place, so its version is what changes
  const anchor = useMemo(() => ({ t: latestT(model), wall: Date.now() }), [model, version]);
  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return anchor.t + (Date.now() - anchor.wall);
}

function latestT(model: SessionModel): number {
  let t = model.startT ?? 0;
  for (const a of model.actions) {
    t = Math.max(t, a.intentT, a.targetT ?? 0, a.dispatch?.t ?? 0, a.settleT ?? 0, a.resultT ?? 0, a.cancel?.t ?? 0, a.progress.at(-1)?.t ?? 0);
  }
  return model.ended ? Math.max(t, model.ended.t) : t;
}
```

`apps/web/src/app.css` — append (the mockup's step styles; the current step's accents are xenon only
while `.app.control`, neutral otherwise):
```css
.steps {
  display: grid;
  gap: 14px;
  overflow: hidden;
}

.step-cap {
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--color-text-2);
  margin-bottom: 6px;
}

.step-row {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 8px;
}

.thumb {
  position: relative;
  width: 160px;
  height: 100px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-surface);
}

.thumb img {
  position: absolute;
  max-width: none;
}

.thumb .tb {
  position: absolute;
  border-radius: 3px;
  box-shadow: 0 0 0 1.5px var(--color-text-2);
}

.meta {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  padding: 2px 0;
  font-size: 11px;
  color: var(--color-text-3);
}

.okg,
.err,
.pr {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-surface-2);
}

.err {
  box-shadow: inset 0 0 0 1.5px var(--color-text-2);
}

.pr {
  box-shadow: inset 0 0 0 2px var(--color-text-3);
}

.step.now .step-cap {
  color: var(--color-text);
  font-weight: 500;
}

.app.control .step.now .thumb,
.app.control .step.now .thumb .tb {
  box-shadow: 0 0 0 1.5px var(--color-xenon);
}

.app.control .step.now .pr {
  box-shadow: inset 0 0 0 2px var(--color-xenon);
}

.hud .t {
  color: var(--color-text-2);
  font-size: 12px;
}

.hud .a[disabled] {
  opacity: 0.5;
  cursor: default;
}
```

`apps/web/src/App.test.tsx` — extend the Theatre test's `fetchImpl` to answer `GET /api/cells/<id>/live`
with 404, import `waitFor` from `@testing-library/react`, and add:
```tsx
  it("shows the session label, the Stop control and the rim while a session is live", async () => {
    window.localStorage.setItem(TOKEN_KEY, "a".repeat(43));
    const cell = { id: "01JXYZ0000000000000000ABCD", state: "ready", scale: 2, createdAt: "", stream: { connection: "live", viewers: 1, lastUpstreamAt: null } };
    let clockCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/cells") return new Response(JSON.stringify([cell]), { status: 200, headers: { "content-type": "application/json" } });
      if (path.endsWith("/live")) return new Response(JSON.stringify({ sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N" }), { status: 200, headers: { "content-type": "application/json" } });
      // Both clocks the hook syncs through api.fetch: the daemon's and the session's origin.
      if (path === "/api/clock") clockCalls += 1;
      if (path.endsWith("/clock")) return new Response(JSON.stringify({ originMicros: 0, nowMicros: 1 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    render(<App fetchImpl={fetchImpl} />);
    await screen.findByTestId("hud-status");
    // jsdom has no MediaStreamTrackProcessor: the stage shows its notice, the HUD still binds the session.
    expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
    await waitFor(() => expect(clockCalls).toBeGreaterThan(0));
  });
```

Run: `pnpm exec vitest run apps/web/src && pnpm --filter @localdot/web typecheck && pnpm --filter @localdot/web build`
Expected: pass.

- [ ] **Step 4: Screenshot check on a real session**

Start the daemon (temporary home), `pnpm --filter @localdot/web build`, open the UI in Chrome, Start
computer, wait for Live. Run `pnpm --filter @localdot/daemon puppet puppet/demo-multiapp.json` and
watch: the stage rim turns xenon, the cursor travels to the Name Box with the box and chip, the ring
fires on the click, the typing pill shows `B2` then `Q3 revenue`, keycaps show `Return`, Chromium
opens and the link is clicked; the HUD reads `Clicking "Name Box"` … `Typing "Q3 revenue"` with a
neutral Stop; the Steps rail fills with rows and thumbnails; at the end the rim goes out, the HUD
reads "Done" with "Stop computer" back, and the steps stay in the rail. While it runs, shoot it (a fresh Chrome profile needs the token URL):
```bash
pnpm --filter @localdot/web shot "http://127.0.0.1:4750/#token=<token>" apps/web/e2e/out/theatre-session.png 1440 900 14000
```
and look at the PNG: xenon only on the rim, target, cursor stroke, caret and current step; the HUD
on the picture; the caption under the stage; rails readable. Run it once more with
`chrome://settings/accessibility`'s "Prefer reduced motion" (or the DevTools rendering emulation)
and confirm the cursor cross-fades instead of travelling and the caret does not blink. Click Stop
mid-run: the HUD reads "Stopped" and the rim goes out. Stop the computer and the daemon.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web apps/daemon packages/stage
git commit -m "feat(web): live session in the Theatre with HUD states, steps and Stop"
```

---
### Task 16: The pixel oracle

Spec "Testing, pixel oracle" (as amended by A31): for every dispatch in a recorded session the
composited frame puts the cursor hotspot within 2 px of the dispatch point at 1×, at 2× zoom and on
HiDPI; no click ring starts before the input's raw press, or more than one frame before the frame
that shows a press-acting control's change; the typing display never shows more characters than
were typed; model screenshots contain no overlay pixels; rendering the same log twice yields
identical frames. The worker captures, inside a window around each action, the overlay layer alone
as small PNG crops at zoom 1 and 2 and the video's luma around the point per decoded frame. Selkies
sends nothing while the screen is still (A30), so while the oracle is on the worker keeps a clone of
the newest decoded frame (closed when the next replaces it or the stream stops) and every window's
luma series starts with a baseline crop of it, taken when the window opens, or as the worker folds
the intent of a window that is already open (an Instant click). While the oracle is off, in
production, it keeps no frame (P3-C12): a held decoded frame is about 12 MB at 2× I444 and can
starve the decode/track frame pool. A pure checker locates the real cursor sprite by template
matching and counts accent pixels in the ring band; a Playwright spec runs the oracle script
through the puppet at DPR 2 and DPR 1 and asserts everything from the captures and the session log.

**Files:**
- Create: `apps/web/src/stage/oracle-check.ts`, `apps/web/e2e/puppet.ts`, `apps/web/e2e/pixel-oracle.spec.ts`
- Modify: `apps/web/src/stage/oracle.ts` (replaces the Task 14a skeleton), `apps/web/src/stage/Stage.tsx`,
  `apps/web/playwright.config.ts`
- Test: `apps/web/src/stage/oracle-check.test.ts`, `apps/web/src/stage/oracle.test.ts`, `apps/web/e2e/pixel-oracle.spec.ts`

**Interfaces:**
- Consumes: `PixiPresenter.extract`, `OracleCommand`, `StageHandle.oracle`; the puppet API; `sharp`.
- Produces: `class OracleCapture { enabled; dpr; zooms; clock; ticks; frames; errors (each failed luma crop as "<actionId>: <message>", cleared on enable); onFrame(frame, at, presented) (every frame; while enabled keeps a clone of the newest, while off returns at once, P3-C12); dispose(); onModel(model, t, screen) (sets the open windows; a newly opened window gets one baseline luma crop from the kept frame, when one is kept; the worker calls it right after folding events, and `onTick` calls it first); onTick(p, model, t, scene, cam, viewport, screen) (`onModel`, then the overlay captures); handle(command, p, model, view) }`,
  `TickCapture { t; presented; zoom; scale; actionId; expected: Point (crop px); crop: CropRect (96 px centred on the point); png: string; cursorInCrop: Point | null; cursorShot: { crop (96 px, tip at (32, 24)); tip; press; alpha; png } | null (at most one per 50 ms per action and zoom); rings; typingShown; typingCount }`,
  `FrameCapture { t; presented; actionId; luma: string (base64 64×64) }` (a baseline carries its frame's own `t` and `presented`), `OracleDump { ticks; frames; errors; dpr }`,
  `TemplateReply { png; w; h; tip }` (64 px, tip at (16, 10)); `window.__localdot.oracle = { enable(zooms), dump(), template(), renderTwice(tMs) }` under `?oracle=1`;
  `oracle-check.ts`: `Rgba`, `locateTemplate(crop, template, tipInTemplate, maxMeanDiff?)`, `countColour(crop, rgb, tol, mask?)`,
  `ringBandMask(cx, cy, rMin, rMax)`, `awayFromRectEdge(rect, pad)`, `outsideRect(rect, pad)`, `arrowRect(tip, dpr)`,
  `crosshairMask(cx, cy, dpr)`, `firstChange(frames, baselineCount, threshold?)`;
  `apps/web/e2e/puppet.ts`: `runPuppet(d, cellId, script)`, `waitForSessionEnd(d, sessionId, timeoutMs)`, `sessionEvents(d, sessionId)`, `frameBytes(d, sessionId, frameId)`.

- [ ] **Step 1: The pure checks, test first**

`apps/web/src/stage/oracle-check.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { arrowRect, awayFromRectEdge, countColour, crosshairMask, firstChange, locateTemplate, outsideRect, type Rgba, ringBandMask } from "./oracle-check.ts";

function image(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number] | null): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = paint(x, y);
    if (!px) continue;
    data.set(px, (y * w + x) * 4);
  }
  return { data, w, h };
}
// A 9×12 right triangle whose tip is its top-left pixel, like the arrow.
const arrow = (ox: number, oy: number) => (x: number, y: number) => (x >= ox && y >= oy && x - ox <= (y - oy) * 0.75 && y - oy < 12 ? ([255, 255, 255, 255] as [number, number, number, number]) : null);

describe("locateTemplate", () => {
  it("finds the arrow's tip within a pixel, ignoring a translucent halo", () => {
    const template = image(16, 16, (x, y) => arrow(3, 3)(x, y) ?? (Math.hypot(x - 8, y - 9) < 7 ? [0, 0, 0, 46] : null));
    const crop = image(48, 48, (x, y) => arrow(20, 17)(x, y) ?? [40, 120, 200, 255]);
    const hit = locateTemplate(crop, template, { x: 3, y: 3 });
    expect(hit).not.toBeNull();
    expect(Math.abs((hit?.tip.x ?? 0) - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs((hit?.tip.y ?? 0) - 17)).toBeLessThanOrEqual(1);
  });

  it("reports nothing when the sprite is absent", () => {
    const template = image(16, 16, arrow(3, 3));
    const empty = image(48, 48, () => [0, 0, 0, 0]);
    expect(locateTemplate(empty, template, { x: 3, y: 3 })).toBeNull();
  });
});

describe("countColour and masks", () => {
  it("counts accent pixels inside a ring band, away from a rectangle's edges", () => {
    const crop = image(48, 48, (x, y) => (Math.abs(Math.hypot(x - 24, y - 24) - 14) < 1.2 ? [63, 181, 222, 255] : x > 40 ? [63, 181, 222, 255] : null));
    expect(countColour(crop, [63, 181, 222], 6)).toBeGreaterThan(60);
    expect(countColour(crop, [63, 181, 222], 6, ringBandMask(24, 24, 8, 26))).toBeGreaterThan(40);
    const away = awayFromRectEdge({ x: 10, y: 10, w: 20, h: 20 }, 3);
    expect(away(20, 20)).toBe(true);
    expect(away(11, 20)).toBe(false);
    expect(away(31, 20)).toBe(false);
    expect(away(40, 40)).toBe(true);
    const masked = (x: number, y: number) => ringBandMask(24, 24, 8, 26)(x, y) && awayFromRectEdge({ x: 0, y: 0, w: 48, h: 10 }, 2)(x, y);
    expect(countColour(crop, [63, 181, 222], 6, masked)).toBeLessThan(countColour(crop, [63, 181, 222], 6, ringBandMask(24, 24, 8, 26)));
  });

  it("excludes the arrow's footprint and the crosshair's own pixels", () => {
    const out = outsideRect({ x: 10, y: 10, w: 20, h: 20 }, 2);
    expect(out(5, 5)).toBe(true);
    expect(out(9, 20)).toBe(false);
    expect(out(33, 20)).toBe(true);
    const arrow = arrowRect({ x: 40, y: 40 }, 2);
    expect(outsideRect(arrow, 0)(41, 60)).toBe(false);
    expect(outsideRect(arrow, 0)(30, 40)).toBe(true);
    expect(outsideRect(arrow, 0)(40, 100)).toBe(true);
    const cross = crosshairMask(48, 48, 1);
    expect(cross(48 + 18, 48)).toBe(true);
    expect(cross(48, 48 - 22)).toBe(true);
    // Diagonals miss the arms: r = 14.1 lies between the dot and the ring, r = 22.6 outside it.
    expect(cross(48 + 10, 48 + 10)).toBe(false);
    expect(cross(48 + 16, 48 + 16)).toBe(false);
    expect(cross(48 + 1, 48)).toBe(true);
  });
});

describe("firstChange", () => {
  it("returns the first frame that differs from the baseline frames beyond the threshold", () => {
    const flat = new Uint8Array(64 * 64).fill(10);
    const lit = new Uint8Array(64 * 64).fill(200);
    const frames = [flat, flat, flat, lit, lit].map((luma, i) => ({ t: i * 16, presented: 100 + i, actionId: "a", luma }));
    expect(firstChange(frames, 2)?.presented).toBe(103);
    expect(firstChange([frames[0] as (typeof frames)[number]], 1)).toBeUndefined();
    // A still screen: the window's one baseline crop, then the frame the press brought.
    expect(firstChange([frames[0], frames[3]] as typeof frames, 1)?.presented).toBe(103);
  });
});
```

`apps/web/src/stage/oracle-check.ts`:
```ts
export interface Rgba {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface LumaFrame {
  t: number;
  presented: number;
  actionId: string;
  luma: Uint8Array;
}

// Sum of absolute colour differences over the template's opaque pixels (alpha ≥ 128) at every
// offset where the template fits; the best mean difference wins when it is under the limit.
export function locateTemplate(crop: Rgba, template: Rgba, tipInTemplate: { x: number; y: number }, maxMeanDiff = 40): { tip: { x: number; y: number }; score: number } | null {
  const opaque: [number, number][] = [];
  for (let y = 0; y < template.h; y++) for (let x = 0; x < template.w; x++) if ((template.data[(y * template.w + x) * 4 + 3] ?? 0) >= 128) opaque.push([x, y]);
  if (opaque.length === 0) return null;
  let best: { x: number; y: number; score: number } | null = null;
  for (let oy = 0; oy + template.h <= crop.h; oy++) {
    for (let ox = 0; ox + template.w <= crop.w; ox++) {
      let sum = 0;
      for (const [tx, ty] of opaque) {
        const ti = (ty * template.w + tx) * 4;
        const ci = ((oy + ty) * crop.w + ox + tx) * 4;
        const alphaMiss = (crop.data[ci + 3] ?? 0) < 128 ? 255 : 0;
        sum += alphaMiss + Math.abs((template.data[ti] ?? 0) - (crop.data[ci] ?? 0)) + Math.abs((template.data[ti + 1] ?? 0) - (crop.data[ci + 1] ?? 0)) + Math.abs((template.data[ti + 2] ?? 0) - (crop.data[ci + 2] ?? 0));
      }
      const score = sum / (opaque.length * 3);
      if (!best || score < best.score) best = { x: ox, y: oy, score };
    }
  }
  if (!best || best.score > maxMeanDiff) return null;
  return { tip: { x: best.x + tipInTemplate.x, y: best.y + tipInTemplate.y }, score: best.score };
}

export function countColour(crop: Rgba, rgb: [number, number, number], tol: number, mask?: (x: number, y: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < crop.h; y++) {
    for (let x = 0; x < crop.w; x++) {
      if (mask && !mask(x, y)) continue;
      const i = (y * crop.w + x) * 4;
      if ((crop.data[i + 3] ?? 0) < 128) continue;
      if (Math.abs((crop.data[i] ?? 0) - rgb[0]) <= tol && Math.abs((crop.data[i + 1] ?? 0) - rgb[1]) <= tol && Math.abs((crop.data[i + 2] ?? 0) - rgb[2]) <= tol) n += 1;
    }
  }
  return n;
}

export function ringBandMask(cx: number, cy: number, rMin: number, rMax: number): (x: number, y: number) => boolean {
  return (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r >= rMin && r <= rMax;
  };
}

// True for points farther than `pad` from every edge of `rect`, inside or outside it: the target
// box's stroke and halo run along those edges and must not count as ring pixels.
export function awayFromRectEdge(rect: { x: number; y: number; w: number; h: number }, pad: number): (x: number, y: number) => boolean {
  return (x, y) => {
    const inside = x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
    if (inside) return Math.min(x - rect.x, rect.x + rect.w - x, y - rect.y, rect.y + rect.h - y) > pad;
    const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.w));
    const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.h));
    return Math.hypot(dx, dy) > pad;
  };
}

// True outside `rect` grown by `pad` on every side.
export function outsideRect(rect: { x: number; y: number; w: number; h: number }, pad: number): (x: number, y: number) => boolean {
  return (x, y) => x < rect.x - pad || x > rect.x + rect.w + pad || y < rect.y - pad || y > rect.y + rect.h + pad;
}

// The arrow's footprint around its tip at `dpr`: x −2…20, y −2…25 CSS px (geometry.ts, the 12°
// tilt, the rim and the halo), grown by 2 px for the xenon stroke. Its own accent stroke must
// never count as ring pixels.
export function arrowRect(tip: { x: number; y: number }, dpr: number): { x: number; y: number; w: number; h: number } {
  return { x: tip.x - 2 * dpr - 2, y: tip.y - 2 * dpr - 2, w: 22 * dpr + 4, h: 27 * dpr + 4 };
}

// The coordinates-only marker (18 px ring with 1.5 px stroke, four arms from 14 to 24 px) in
// crop pixels at `dpr`; true where its pixels can lie.
export function crosshairMask(cx: number, cy: number, dpr: number): (x: number, y: number) => boolean {
  return (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    if (r >= 16.5 * dpr && r <= 19.5 * dpr) return true;
    const onArm = (Math.abs(x - cx) <= 1.5 * dpr || Math.abs(y - cy) <= 1.5 * dpr) && r >= 13 * dpr && r <= 25 * dpr;
    return onArm || r <= 3 * dpr;
  };
}

// The first frame whose luma differs from the mean of the first `baselineCount` frames by more
// than `threshold` on average: the frame that shows the control's change.
export function firstChange(frames: LumaFrame[], baselineCount: number, threshold = 8): LumaFrame | undefined {
  const base = frames.slice(0, baselineCount);
  if (base.length === 0 || frames.length <= baselineCount) return undefined;
  const n = base[0]?.luma.length ?? 0;
  const mean = new Float32Array(n);
  for (const f of base) for (let i = 0; i < n; i++) mean[i] = (mean[i] ?? 0) + (f.luma[i] ?? 0) / base.length;
  for (const f of frames.slice(baselineCount)) {
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs((f.luma[i] ?? 0) - (mean[i] ?? 0));
    if (diff / n > threshold) return f;
  }
  return undefined;
}
```

Run: `pnpm exec vitest run apps/web/src/stage/oracle-check.test.ts`
Expected: 5 tests pass.

- [ ] **Step 2: Capture in the worker and the page hook**

`apps/web/src/stage/oracle.test.ts` (the baseline a still screen needs, and no frame kept while the
oracle is off, P3-C12; without WebGL: `onTick` with no scene computes the windows and the luma
crops and stops before any overlay capture):
```ts
import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it, vi } from "vitest";
import { OracleCapture } from "./oracle.ts";
import type { PixiPresenter } from "./pixi-presenter.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
let seq = 0;
const ev = (type: string, tMs: number, data: Record<string, unknown>, step?: string): LocalDotEvent =>
  ({ v: 1, id: ID, seq: seq++, t: msToMicros(tMs), agent: "main", ...(step ? { step } : {}), type, data }) as LocalDotEvent;

// A click whose cursor arrives at 1120 + 400 = 1520 ms, so its capture window opens at 1420 ms.
const clickModel = () =>
  foldEvents(emptyModel(), [
    ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux" }),
    ev("action.intent", 1000, { verb: "click", label: "Click the page (centre)", point: { x: 300, y: 400 }, risk: "none", pointer: { from: { x: 100, y: 100 }, to: { x: 300, y: 400 }, startsAt: 1120, durationMs: 400, seed: 1, curve: "minjerk-bow-v1" } }, "s1"),
  ]);

// A VideoFrame stand-in with a flat luma plane; it records every clone it hands out and every rect
// read from it or its clones.
function fakeFrame(luma: number) {
  const clones: VideoFrame[] = [];
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  const make = (): VideoFrame =>
    ({
      allocationSize: (opts: { rect: { width: number; height: number } }) => opts.rect.width * opts.rect.height,
      copyTo: async (buf: Uint8Array, opts: { rect: { x: number; y: number; width: number; height: number } }) => {
        rects.push(opts.rect);
        buf.fill(luma);
        return [{ offset: 0, stride: opts.rect.width }];
      },
      clone: () => {
        const c = make();
        clones.push(c);
        return c;
      },
      close: vi.fn(),
    }) as unknown as VideoFrame;
  return { frame: make(), clones, rects };
}

// With this clock sessionMsAt (Task 6) maps viewer wall ms w to session ms w − 1_000_000.
const clock = { offsetMicros: 0, originMicros: 1_000_000_000 };
const wall = (sessionMs: number) => 1_000_000 + sessionMs;
const screen = { w: 2560, h: 1600 };
const cam = { scale: 0.5, tx: 0, ty: 0 };
const viewport = { w: 1280, h: 800 };
const noPresenter = {} as PixiPresenter;
const settle = () => new Promise((r) => setTimeout(r, 0));
const bytes = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

describe("OracleCapture", () => {
  it("gives a window opened on a still screen one baseline crop from the newest frame", async () => {
    const oracle = new OracleCapture();
    oracle.clock = clock;
    const model = clickModel();
    // The oracle is on before the screen's last frame arrives (900 ms); then the screen stays still.
    await oracle.handle({ id: 1, op: "enable", zooms: [1] }, noPresenter, model, { reducedMotion: false });
    const still = fakeFrame(10);
    oracle.onFrame(still.frame, wall(900), 7);
    oracle.onTick(noPresenter, model, 1400, null, cam, viewport, screen);
    oracle.onTick(noPresenter, model, 1450, null, cam, viewport, screen);
    oracle.onTick(noPresenter, model, 1500, null, cam, viewport, screen);
    await settle();
    expect(oracle.frames).toHaveLength(1);
    expect(oracle.frames[0]).toMatchObject({ t: 900, presented: 7, actionId: ID });
    expect(bytes(oracle.frames[0]?.luma ?? "")).toEqual(new Uint8Array(64 * 64).fill(10));
    expect(still.rects).toEqual([{ x: 268, y: 368, width: 64, height: 64 }]);
    // The press changes the page: the new frame joins the window once, after its baseline.
    const lit = fakeFrame(200);
    oracle.onFrame(lit.frame, wall(1700), 8);
    oracle.onTick(noPresenter, model, 1716, null, cam, viewport, screen);
    await settle();
    expect(oracle.frames.map((f) => [f.t, f.presented])).toEqual([
      [900, 7],
      [1700, 8],
    ]);
    // The kept clone of the still frame and the clone its crop read are both closed.
    expect(still.clones).toHaveLength(2);
    for (const c of still.clones) expect(c.close).toHaveBeenCalledTimes(1);
  });

  it("keeps one clone of the newest frame while on, closing the one it replaces and on dispose", async () => {
    const oracle = new OracleCapture();
    await oracle.handle({ id: 1, op: "enable", zooms: [1] }, noPresenter, emptyModel(), { reducedMotion: false });
    const a = fakeFrame(10);
    const b = fakeFrame(20);
    oracle.onFrame(a.frame, wall(100), 1);
    oracle.onFrame(b.frame, wall(116), 2);
    expect(a.clones).toHaveLength(1);
    expect(a.clones[0]?.close).toHaveBeenCalledTimes(1);
    expect(b.clones).toHaveLength(1);
    expect(b.clones[0]?.close).not.toHaveBeenCalled();
    oracle.dispose();
    expect(b.clones[0]?.close).toHaveBeenCalledTimes(1);
    // The presenter owns the frames themselves, and with no window open nothing is cropped.
    expect(a.frame.close).not.toHaveBeenCalled();
    expect(b.frame.close).not.toHaveBeenCalled();
    expect(oracle.frames).toEqual([]);
  });

  it("keeps no clone while the oracle is off", async () => {
    const oracle = new OracleCapture();
    oracle.clock = clock;
    const model = clickModel();
    // Production: frames flow with the oracle off, then the screen stays still.
    const early = fakeFrame(10);
    const still = fakeFrame(10);
    oracle.onFrame(early.frame, wall(884), 6);
    oracle.onFrame(still.frame, wall(900), 7);
    expect(early.clones).toEqual([]);
    expect(still.clones).toEqual([]);
    // Switched on mid-stream on that still screen: the window opens with no baseline.
    await oracle.handle({ id: 1, op: "enable", zooms: [1] }, noPresenter, model, { reducedMotion: false });
    oracle.onTick(noPresenter, model, 1450, null, cam, viewport, screen);
    oracle.onTick(noPresenter, model, 1500, null, cam, viewport, screen);
    await settle();
    expect(oracle.frames).toEqual([]);
    expect(still.rects).toEqual([]);
    // The next frame is kept and is the open window's first crop, taken once.
    const lit = fakeFrame(200);
    oracle.onFrame(lit.frame, wall(1700), 8);
    oracle.onTick(noPresenter, model, 1716, null, cam, viewport, screen);
    await settle();
    expect(oracle.frames.map((f) => [f.t, f.presented])).toEqual([[1700, 8]]);
    expect(lit.rects).toEqual([{ x: 268, y: 368, width: 64, height: 64 }]);
    // Its kept clone stays open until dispose; the clone its crop read is closed.
    expect(lit.clones).toHaveLength(2);
    expect(lit.clones[0]?.close).not.toHaveBeenCalled();
    expect(lit.clones[1]?.close).toHaveBeenCalledTimes(1);
    oracle.dispose();
    expect(lit.clones[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("takes a window's baseline when its intent arrives, before any tick", async () => {
    const oracle = new OracleCapture();
    oracle.clock = clock;
    const model = clickModel();
    await oracle.handle({ id: 1, op: "enable", zooms: [1] }, noPresenter, model, { reducedMotion: false });
    const still = fakeFrame(10);
    oracle.onFrame(still.frame, wall(900), 7);
    // The intent is folded at 1450 ms, inside its window (1420…3020 ms), and no tick follows.
    oracle.onModel(model, 1450, screen);
    await settle();
    expect(oracle.frames).toHaveLength(1);
    expect(oracle.frames[0]).toMatchObject({ t: 900, presented: 7, actionId: ID });
    expect(still.rects).toEqual([{ x: 268, y: 368, width: 64, height: 64 }]);
    // The kept clone stays open until dispose; the clone the crop read is closed.
    expect(still.clones).toHaveLength(2);
    expect(still.clones[0]?.close).not.toHaveBeenCalled();
    expect(still.clones[1]?.close).toHaveBeenCalledTimes(1);
    oracle.dispose();
    expect(still.clones[0]?.close).toHaveBeenCalledTimes(1);
  });
});
```

Run: `pnpm exec vitest run apps/web/src/stage/oracle.test.ts`
Expected: FAIL, all 4 — the Task 14a skeleton keeps no frame and has no `frames`. The second test
fails at its first clone check, the other three at their first `frames` check (the third test's
clone checks pass against it, and the fourth test's `onModel` call reaches the skeleton's no-op).

`apps/web/src/stage/oracle.ts` (replace the skeleton):
```ts
import { type Camera, cameraFor, type Scene, type SessionModel, sceneAt, toCanvas, type View } from "@localdot/stage";
import { sessionMsAt } from "../session/clock-sync.ts";
import type { PixiPresenter } from "./pixi-presenter.ts";
import type { OracleCommand, StageClock } from "./worker-protocol.ts";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Two overlay-only crops per tick and zoom: `crop` centred on the action point (the ring band and
// the target box live there) and `cursorShot` around the drawn cursor wherever it is, so the
// hotspot can be checked on an unsquashed, fully opaque arrow at any point of the travel or the
// hold. That check needs few shots: one per SHOT_EVERY_MS keeps the tick rate up in the dwell.
export interface TickCapture {
  t: number;
  presented: number;
  zoom: number;
  scale: number;
  actionId: string;
  expected: { x: number; y: number };
  crop: CropRect;
  png: string;
  cursorInCrop: { x: number; y: number } | null;
  cursorShot: { crop: CropRect; tip: { x: number; y: number }; press: number; alpha: number; png: string } | null;
  rings: number;
  typingShown: number;
  typingCount: number;
}

export interface FrameCapture {
  t: number;
  presented: number;
  actionId: string;
  luma: string;
}

export interface OracleDump {
  ticks: TickCapture[];
  frames: FrameCapture[];
  errors: string[];
  dpr: number;
}

interface Region {
  id: string;
  point: { x: number; y: number };
  kind: "click" | "type" | "key";
  from: number;
  until: number;
}

interface KeptFrame {
  frame: VideoFrame;
  at: number;
  presented: number;
}

// The arrow with its halo and rim spans about x −2…20, y −2…25 CSS px from the tip (geometry.ts,
// tilted 12°), 48 × 54 canvas px at DPR 2. A cursor shot is 96 px with the tip at (32, 24), so a
// 64 px template placed around the tip fits (template origin ≥ 0 and ≤ 32 both ways). The action
// crop is 96 px centred on the point: the whole 11–21 CSS px ring band (22–42 px at DPR 2) fits.
const CROP = 96;
const CROP_CENTRE = { x: CROP / 2, y: CROP / 2 };
const SHOT_TIP = { x: 32, y: 24 };
const SHOT_EVERY_MS = 50;
const TEMPLATE = 64;
const TEMPLATE_TIP = { x: 16, y: 10 };
const LUMA = 64;
const MAX_TICKS = 4000;
const MAX_FRAMES = 3000;

const cropAt = (c: { x: number; y: number }, at: { x: number; y: number }): CropRect => ({ x: Math.round(c.x - at.x), y: Math.round(c.y - at.y), w: CROP, h: CROP });

const lumaRect = (p: { x: number; y: number }, screen: { w: number; h: number }) => ({
  x: Math.max(0, Math.min(screen.w - LUMA, Math.round(p.x - LUMA / 2))),
  y: Math.max(0, Math.min(screen.h - LUMA, Math.round(p.y - LUMA / 2))),
  width: LUMA,
  height: LUMA,
});

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function pngOf(rgba: Uint8ClampedArray, w: number, h: number): Promise<string> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context for the oracle");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const blob = await c.convertToBlob({ type: "image/png" });
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

async function copyLuma(frame: VideoFrame, rect: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
  const size = frame.allocationSize({ rect });
  const buf = new Uint8Array(size);
  const [layout] = await frame.copyTo(buf, { rect });
  const out = new Uint8Array(rect.width * rect.height);
  if (!layout) return out;
  for (let row = 0; row < rect.height; row++) out.set(buf.subarray(layout.offset + row * layout.stride, layout.offset + row * layout.stride + rect.width), row * rect.width);
  return out;
}

// Captures only inside a window around each action: from 100 ms before the planned arrival (the
// press comes after a ≤ 90 ms dwell) to 1.5 s after the dispatch, so a session's dump stays a few
// megabytes.
function regionsAt(model: SessionModel, t: number): Region[] {
  const out: Region[] = [];
  for (const a of model.actions) {
    const point = a.dispatch && "at" in a.dispatch.input ? a.dispatch.input.at : (a.target?.point ?? a.plan?.to ?? a.point);
    if (!point) continue;
    const kind = a.verb === "type" ? "type" : a.verb === "key" ? "key" : "click";
    const arrival = a.plan ? a.plan.startsAt + a.plan.durationMs : a.intentT;
    const from = arrival - 100;
    const until = (a.dispatch?.t ?? arrival) + 1500;
    if (t >= from && t <= until) out.push({ id: a.id, point, kind, from, until });
  }
  return out;
}

export class OracleCapture {
  enabled = false;
  dpr = 1;
  zooms = [1];
  clock: StageClock | null = null;
  ticks: TickCapture[] = [];
  frames: FrameCapture[] = [];
  errors: string[] = [];
  #regions: Region[] = [];
  #screen = { w: 2560, h: 1600 };
  #latest: KeptFrame | null = null;
  // Windows that already have a luma crop: each gets one baseline, and only when it opens.
  #opened = new Set<string>();
  // "<action id> <zoom>" → session ms of the last cursor shot.
  #lastShot = new Map<string, number>();

  // Every decoded frame comes through here. While the oracle is off (production) nothing is kept
  // (P3-C12): a held decoded frame is ~12 MB at 2× I444 and can starve the decode frame pool.
  // While it is on, a still screen sends no frames (Selkies encodes on damage, A30), so a clone of
  // the newest is kept until the next one replaces it: a window that opens on a still screen takes
  // its baseline from it.
  onFrame(frame: VideoFrame, at: number, presented: number): void {
    if (!this.enabled) return;
    this.#latest?.frame.close();
    const kept = { frame: frame.clone(), at, presented };
    this.#latest = kept;
    this.#lumaCrops(kept, this.#regions);
  }

  dispose(): void {
    this.#latest?.frame.close();
    this.#latest = null;
  }

  // One luma crop of `kept` per window, with that frame's own time and count. The windows are
  // marked at once, so no frame is cropped twice for one window, and the bytes come from a clone:
  // copyTo is async and the kept frame may be replaced and closed before it resolves. A failed
  // crop is recorded in `errors` under its window's id, and the other windows still get theirs.
  #lumaCrops(kept: KeptFrame, regions: Region[]): void {
    if (!this.clock || regions.length === 0) return;
    const t = sessionMsAt(kept.at, this.clock);
    const jobs = regions.map((r) => ({ id: r.id, rect: lumaRect(r.point, this.#screen) }));
    for (const job of jobs) this.#opened.add(job.id);
    const copy = kept.frame.clone();
    void (async () => {
      for (const job of jobs) {
        try {
          const luma = await copyLuma(copy, job.rect);
          this.frames.push({ t, presented: kept.presented, actionId: job.id, luma: toBase64(luma) });
        } catch (err) {
          this.errors.push(`${job.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);
    })().finally(() => copy.close());
  }

  // Runs on every tick and right after the worker folds events: an Instant click's window is
  // already open when its intent arrives, so its baseline is taken then, from the kept frame,
  // before the press's frame can replace it.
  onModel(model: SessionModel, t: number, screen: { w: number; h: number }): void {
    this.#screen = screen;
    this.#regions = regionsAt(model, t);
    const latest = this.#latest;
    if (latest) this.#lumaCrops(latest, this.#regions.filter((r) => !this.#opened.has(r.id)));
  }

  onTick(p: PixiPresenter, model: SessionModel, t: number, scene: Scene | null, cam: Camera, viewport: { w: number; h: number }, screen: { w: number; h: number }): void {
    this.onModel(model, t, screen);
    if (!scene) return;
    for (const r of this.#regions) {
      for (const zoom of this.zooms) {
        const camZ = zoom === 1 ? cam : cameraFor({ stageW: viewport.w, stageH: viewport.h, desktopW: screen.w, desktopH: screen.h, zoom, focus: r.point });
        const c = toCanvas(camZ, r.point);
        const crop = cropAt(c, CROP_CENTRE);
        const rgba = p.extract(crop, "overlays", camZ, scene);
        const action = model.actions.find((a) => a.id === r.id);
        const typingCount = Math.max(0, ...(action?.progress.filter((pr) => pr.t <= t).map((pr) => pr.count) ?? [0]));
        const rings = scene.rings.filter((ring) => Math.hypot(ring.x - r.point.x, ring.y - r.point.y) < 4).length;
        const typingShown = scene.typing ? [...scene.typing.text].length + scene.typing.more : 0;
        const cursor = scene.cursor?.visible ? scene.cursor : null;
        const cursorCanvas = cursor ? toCanvas(camZ, { x: cursor.x, y: cursor.y }) : null;
        const cursorInCrop = cursorCanvas ? { x: cursorCanvas.x - crop.x, y: cursorCanvas.y - crop.y } : null;
        let cursorShot: TickCapture["cursorShot"] = null;
        let cursorRgba: Uint8ClampedArray | null = null;
        const shotKey = `${r.id} ${zoom}`;
        if (cursor && cursorCanvas && t - (this.#lastShot.get(shotKey) ?? Number.NEGATIVE_INFINITY) >= SHOT_EVERY_MS) {
          this.#lastShot.set(shotKey, t);
          const shotCrop = cropAt(cursorCanvas, SHOT_TIP);
          cursorRgba = p.extract(shotCrop, "overlays", camZ, scene);
          cursorShot = { crop: shotCrop, tip: { x: cursorCanvas.x - shotCrop.x, y: cursorCanvas.y - shotCrop.y }, press: cursor.press, alpha: cursor.alpha, png: "" };
        }
        const tick: TickCapture = { t, presented: p.presented, zoom, scale: camZ.scale, actionId: r.id, expected: { x: c.x - crop.x, y: c.y - crop.y }, crop, png: "", cursorInCrop, cursorShot, rings, typingShown, typingCount };
        this.ticks.push(tick);
        void pngOf(rgba, CROP, CROP).then((png) => {
          tick.png = png;
        });
        if (cursorRgba && cursorShot) {
          const shot = cursorShot;
          void pngOf(cursorRgba, CROP, CROP).then((png) => {
            shot.png = png;
          });
        }
      }
    }
    if (this.ticks.length > MAX_TICKS) this.ticks.splice(0, this.ticks.length - MAX_TICKS);
  }

  async handle(command: OracleCommand, p: PixiPresenter, model: SessionModel, view: View): Promise<unknown> {
    switch (command.op) {
      case "enable":
        // A frame kept while already on stays: it is still what the screen shows.
        this.enabled = true;
        this.zooms = command.zooms;
        this.ticks = [];
        this.frames = [];
        this.errors = [];
        this.#opened.clear();
        this.#lastShot.clear();
        return { ok: true };
      case "dump":
        await new Promise((r) => setTimeout(r, 50));
        return { ticks: this.ticks.filter((t) => t.png && (!t.cursorShot || t.cursorShot.png)), frames: this.frames, errors: this.errors, dpr: this.dpr } satisfies OracleDump;
      case "template": {
        // The arrow alone at zoom 1, unsquashed and opaque, the name chip collapsed to its dot:
        // the sprite the matcher looks for. Overlays keep their CSS size at every zoom (unit =
        // dpr / cam.scale), so one template serves zoom 1 and zoom 2.
        const scene: Scene = { control: true, cursor: { x: 100, y: 100, visible: true, alpha: 1, press: 0, hand: false, chipAlpha: 0, name: "dot", floating: false }, target: null, rings: [], typing: null, keycaps: null, cancel: null, hud: { label: "", state: "working", control: true, elapsedMs: 0 } };
        const live = cameraFor({ stageW: p.app.renderer.width, stageH: p.app.renderer.height, desktopW: model.screen?.w ?? this.#screen.w, desktopH: model.screen?.h ?? this.#screen.h, zoom: 1 });
        const c = toCanvas(live, { x: 100, y: 100 });
        const crop = { x: Math.round(c.x - TEMPLATE_TIP.x), y: Math.round(c.y - TEMPLATE_TIP.y), w: TEMPLATE, h: TEMPLATE };
        const rgba = p.extract(crop, "overlays", live, scene);
        return { png: await pngOf(rgba, TEMPLATE, TEMPLATE), w: TEMPLATE, h: TEMPLATE, tip: { x: c.x - crop.x, y: c.y - crop.y } };
      }
      case "render-twice": {
        const live = cameraFor({ stageW: p.app.renderer.width, stageH: p.app.renderer.height, desktopW: model.screen?.w ?? this.#screen.w, desktopH: model.screen?.h ?? this.#screen.h, zoom: 1 });
        const whole = { x: 0, y: 0, w: p.app.renderer.width, h: p.app.renderer.height };
        const a = p.extract(whole, "overlays", live, sceneAt(model, command.tMs, view));
        p.draw(null);
        const b = p.extract(whole, "overlays", live, sceneAt(model, command.tMs, view));
        let identical = a.length === b.length;
        for (let i = 0; identical && i < a.length; i++) if (a[i] !== b[i]) identical = false;
        return { identical, bytes: a.length };
      }
    }
  }
}
```
(The `clock` case of `render-worker.ts` already sets `oracle.clock`, its `probing` wrapper hands
every frame to `onFrame`, which returns at once while the oracle is off (P3-C12), its `events`
case calls `onModel` right after folding while the oracle is on, and its `stop`/`frames` case
calls `dispose`, Task 14a. `OracleCommand` has no op that turns the oracle off again, so a kept
frame is closed only when the next one replaces it or on `dispose`.)

`apps/web/src/stage/Stage.tsx` — beside the probe hook, install the oracle API when `?oracle=1`:
```tsx
  useEffect(() => {
    if (params.get("oracle") !== "1") return;
    const o = {
      enable: (zooms: number[]) => canvas.current?.oracle({ op: "enable", zooms }),
      dump: () => canvas.current?.oracle({ op: "dump" }),
      template: () => canvas.current?.oracle({ op: "template" }),
      renderTwice: (tMs: number) => canvas.current?.oracle({ op: "render-twice", tMs }),
    };
    window.__localdot = { ...window.__localdot, oracle: o };
    return () => { if (window.__localdot) window.__localdot.oracle = undefined; };
  }, [params]);
```

Run: `pnpm exec vitest run apps/web/src && pnpm --filter @localdot/web typecheck && pnpm --filter @localdot/web build`
Expected: pass, the 4 `OracleCapture` tests and the 5 oracle-check tests included.

- [ ] **Step 3: The e2e helpers and the oracle spec**

`apps/web/e2e/puppet.ts`:
```ts
import type { RunningDaemon } from "./daemon.ts";

const headers = (d: RunningDaemon) => ({ authorization: `Bearer ${d.token}`, "content-type": "application/json" });

export async function runPuppet(d: RunningDaemon, cellId: string, script: unknown): Promise<string> {
  const res = await fetch(`${d.origin}/api/cells/${cellId}/puppet`, { method: "POST", headers: headers(d), body: JSON.stringify(script) });
  if (res.status !== 202) throw new Error(`puppet: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

export interface LoggedEvent {
  id: string;
  seq: number;
  t: number;
  step?: string;
  type: string;
  data: Record<string, unknown>;
}

export async function sessionEvents(d: RunningDaemon, sessionId: string): Promise<LoggedEvent[]> {
  const res = await fetch(`${d.origin}/api/sessions/${sessionId}/events`, { headers: headers(d) });
  return (await res.json()) as LoggedEvent[];
}

export async function waitForSessionEnd(d: RunningDaemon, sessionId: string, timeoutMs = 300_000): Promise<LoggedEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await sessionEvents(d, sessionId);
    if (events.some((e) => e.type === "session.end")) return events;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`session ${sessionId} did not end in time`);
}

export async function frameBytes(d: RunningDaemon, sessionId: string, frameId: string): Promise<Buffer> {
  const res = await fetch(`${d.origin}/api/sessions/${sessionId}/frames/${frameId}`, { headers: headers(d) });
  if (!res.ok) throw new Error(`frame ${frameId}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
```

`apps/web/playwright.config.ts` — two projects:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 600_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "e2e/out/results",
  use: { channel: "chrome", viewport: { width: 1440, height: 900 } },
  projects: [
    { name: "hidpi", use: { deviceScaleFactor: 2 } },
    { name: "lodpi", use: { deviceScaleFactor: 1 }, testMatch: /pixel-oracle/ },
  ],
});
```

`apps/web/e2e/pixel-oracle.spec.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { microsToMs } from "@localdot/protocol";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import type { OracleDump, TickCapture } from "../src/stage/oracle.ts";
import { arrowRect, awayFromRectEdge, countColour, crosshairMask, firstChange, locateTemplate, outsideRect, type Rgba, ringBandMask } from "../src/stage/oracle-check.ts";
import { type CellRef, createReadyCell, removeCell } from "./cells.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { frameBytes, runPuppet, waitForSessionEnd } from "./puppet.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
const SCRIPT = JSON.parse(readFileSync(fileURLToPath(new URL("../../daemon/puppet/oracle.json", import.meta.url)), "utf8"));
const XENON: [number, number, number] = [0x3f, 0xb5, 0xde];
let daemon: RunningDaemon;
let cell: CellRef;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images and Docker Desktop");
test.beforeAll(async () => {
  daemon = await startDaemon();
  cell = await createReadyCell(daemon, 2);
});
test.afterAll(async () => {
  if (cell) await removeCell(daemon, cell.id);
  await daemon?.stop();
});

const decode = async (png: string): Promise<Rgba> => {
  const { data, info } = await sharp(Buffer.from(png, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
};

test("pixel oracle: cursor hotspot, ring order, typing pace, clean observations, determinism", async ({ page }, info) => {
  await page.goto(`${daemon.origin}/?oracle=1#token=${daemon.token}`);
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 120_000 });
  await page.waitForFunction(() => Number(document.querySelector("canvas.stage-canvas")?.getAttribute("data-frames")) > 0, null, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as { __localdot: { oracle: { enable(z: number[]): Promise<unknown> } } }).__localdot.oracle.enable([1, 2]));
  const template = (await page.evaluate(() => (window as unknown as { __localdot: { oracle: { template(): Promise<unknown> } } }).__localdot.oracle.template())) as { png: string; w: number; h: number; tip: { x: number; y: number } };
  const templateRgba = await decode(template.png);

  const sessionId = await runPuppet(daemon, cell.id, SCRIPT);
  const events = await waitForSessionEnd(daemon, sessionId);
  expect(events.at(-1)?.data.reason).toBe("done");
  const dump = (await page.evaluate(() => (window as unknown as { __localdot: { oracle: { dump(): Promise<unknown> } } }).__localdot.oracle.dump())) as OracleDump;
  expect(dump.errors, `failed luma crops: ${dump.errors.join("; ")}`).toEqual([]);
  expect(dump.ticks.length).toBeGreaterThan(50);

  const intents = events.filter((e) => e.type === "action.intent");
  const dispatches = events.filter((e) => e.type === "action.dispatch");
  const byStep = (type: string, step: string | undefined) => events.find((e) => e.type === type && e.step === step);
  const report: string[] = [];

  for (const d of dispatches) {
    const input = d.data.input as { kind: string; at?: { x: number; y: number }; button?: string };
    const intent = byStep("action.intent", d.step);
    if (!intent) continue;
    const pressT = microsToMs(Number(d.data.pressT));
    // A key has no point, so it opens no capture window: checks 1–4 need one.
    if (input.kind === "key") continue;
    const ticks = dump.ticks.filter((t) => t.actionId === intent.id);
    expect(ticks.length, `captures for ${intent.data.label}`).toBeGreaterThan(5);

    if (input.kind === "click" && input.at) {
      // 1. The drawn cursor hotspot within 2 px of where the scene puts it, at zoom 1 and zoom 2,
      // on the latest capture whose arrow is unsquashed (press 0) and opaque (alpha 1): during the
      // travel, the dwell or the hold after the release. The template is the unsquashed arrow, so
      // the squash ticks (pressT − 80 ms … pressT + 150 ms) and an Instant fade-in never qualify.
      for (const zoom of [1, 2]) {
        const sharpTick = ticks.filter((t) => t.zoom === zoom && t.cursorShot && t.cursorShot.press === 0 && t.cursorShot.alpha === 1).sort((a, b) => b.t - a.t)[0];
        expect(sharpTick, `an unsquashed cursor capture at zoom ${zoom} for ${intent.data.label}`).toBeDefined();
        const shot = (sharpTick as TickCapture).cursorShot as NonNullable<TickCapture["cursorShot"]>;
        const hit = locateTemplate(await decode(shot.png), templateRgba, template.tip);
        expect(hit, `cursor sprite found at zoom ${zoom} for ${intent.data.label}`).not.toBeNull();
        const dx = (hit?.tip.x ?? 0) - shot.tip.x;
        const dy = (hit?.tip.y ?? 0) - shot.tip.y;
        report.push(`${intent.data.label} zoom ${zoom}: hotspot off by (${dx.toFixed(1)}, ${dy.toFixed(1)}) px at t=${(sharpTick as TickCapture).t.toFixed(1)}`);
        expect(Math.hypot(dx, dy), `hotspot within 2 px at zoom ${zoom} for ${intent.data.label}`).toBeLessThanOrEqual(2);
      }
      // The scene itself puts the cursor on the dispatch point at the press (Task 13 proves the
      // model; this proves the captured one): the latest capture in the dwell, from the planned
      // arrival (the intent's PointerPlan, session ms like the ticks) to pressT. Earlier ticks
      // are still travelling, up to OVERSHOOT_CAP_PX off; a Fast click's 45 ms dwell may hold no
      // capture, which is reported rather than failed.
      const plan = intent.data.pointer as { startsAt: number; durationMs: number };
      const arrival = plan.startsAt + plan.durationMs;
      const atPress = ticks.filter((t) => t.zoom === 1 && t.t >= arrival && t.t < pressT && t.cursorInCrop).sort((a, b) => b.t - a.t)[0];
      if (!atPress) {
        report.push(`${intent.data.label}: no capture between the arrival (${arrival.toFixed(1)} ms) and the press (${pressT.toFixed(1)} ms); cursor-at-press check skipped`);
      } else {
        const c = atPress.cursorInCrop as { x: number; y: number };
        expect(Math.hypot(c.x - atPress.expected.x, c.y - atPress.expected.y), `scene cursor on the dispatch point at the press (${intent.data.label})`).toBeLessThanOrEqual(0.5);
      }
      // 2. No click ring before the raw press: no ring in the scene and no accent pixels in the ring
      // band, 11…21 CSS px from the point (a ring 0–90 ms old spans 13–20 px, stroke 2 px). Excluded:
      // the arrow's own footprint (its xenon stroke sits on the point during the dwell and the
      // squash), the target box's stroke and halo (within 8 CSS px of the bbox edges), and the
      // coordinates-only crosshair (its 18 px ring, arms and dot). Captures are premultiplied
      // RGBA, so only solid xenon counts; ≤ 4 pixels allows anti-aliasing at the exclusions' rims.
      const target = byStep("action.target", d.step)?.data.target as { bbox?: { x: number; y: number; w: number; h: number } } | undefined;
      for (const t of ticks.filter((t) => t.zoom === 1 && t.t < pressT)) {
        expect(t.rings, `scene has no ring before the press (${intent.data.label}, t=${t.t.toFixed(1)})`).toBe(0);
        const crop = await decode(t.png);
        const band = ringBandMask(t.expected.x, t.expected.y, 11 * dump.dpr, 21 * dump.dpr);
        const parts: ((x: number, y: number) => boolean)[] = [band];
        if (t.cursorInCrop) parts.push(outsideRect(arrowRect(t.cursorInCrop, dump.dpr), 0));
        if (target?.bbox) {
          const b = target.bbox;
          const box = { x: t.expected.x + (b.x - input.at.x) * t.scale, y: t.expected.y + (b.y - input.at.y) * t.scale, w: b.w * t.scale, h: b.h * t.scale };
          parts.push(awayFromRectEdge(box, 8 * dump.dpr));
        } else {
          const cross = crosshairMask(t.expected.x, t.expected.y, dump.dpr);
          parts.push((x, y) => !cross(x, y));
        }
        const mask = (x: number, y: number) => parts.every((p) => p(x, y));
        expect(countColour(crop, XENON, 40, mask), `no ring pixels before the press (${intent.data.label}, t=${t.t.toFixed(1)})`).toBeLessThanOrEqual(4);
      }
      // 3. Press-acting control (every flash-page click, all five labelled "Click the page …"):
      // the ring starts at most one frame before the frame that shows the change. A still screen
      // sends no frames (A30), so every window's luma series starts with a baseline crop of the
      // newest frame, taken before the press: for Watch and Fast when the window opens, at
      // arrival − 100 ms; for Instant when the intent reaches the worker, about 60 ms before the
      // press is due. The oracle keeps that frame only while it is on (P3-C12): it is on before
      // the puppet starts, and the script's first step (the flash page's launch) repaints the
      // screen before any window opens, so `baseline` is at least 1 for every click.
      const frames = dump.frames.filter((f) => f.actionId === intent.id).map((f) => ({ ...f, luma: new Uint8Array(Buffer.from(f.luma, "base64")) })).sort((a, b) => a.presented - b.presented);
      const baseline = frames.filter((f) => f.t < pressT).length;
      expect(baseline, `baseline frames before the press for ${intent.data.label}`).toBeGreaterThan(0);
      if ((intent.data.label as string).startsWith("Click the page")) {
        const change = firstChange(frames, baseline);
        const ringTick = ticks.filter((t) => t.zoom === 1 && t.rings > 0).sort((a, b) => a.t - b.t)[0];
        expect(change, `the flash page changed after ${intent.data.label}`).toBeDefined();
        expect(ringTick, `a ring was drawn for ${intent.data.label}`).toBeDefined();
        report.push(`${intent.data.label}: change at frame ${change?.presented}, ring first drawn over frame ${ringTick?.presented}`);
        expect((ringTick?.presented ?? 0) >= (change?.presented ?? 0) - 1, `ring not more than one frame before the change (${intent.data.label})`).toBe(true);
      }
    }
    if (input.kind === "type") {
      // 4. The typing display never shows more characters than were typed.
      for (const t of ticks) expect(t.typingShown, `typing shown ≤ typed at t=${t.t.toFixed(1)}`).toBeLessThanOrEqual(t.typingCount);
      expect(ticks.some((t) => t.typingShown > 0), "the pill showed something").toBe(true);
    }
  }

  // 5. Model screenshots contain no overlay pixels. The desktop's own blue icons leave a few
  // xenon-like pixels in a lossy WebP, so each observe is held to the session's first, taken
  // before any action, when nothing could be drawn: at most 24 more, under a third of the xenon in
  // the smallest overlay (a 1280×800 ring is about 70 pixels).
  const observes = events.filter((e) => e.type === "observe");
  expect(observes.length).toBeGreaterThan(5);
  const xenonIn = async (frameId: string): Promise<number> => {
    const { data, info } = await sharp(await frameBytes(daemon, sessionId, frameId)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(1280);
    return countColour({ data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height }, XENON, 6);
  };
  const firstCount = await xenonIn(String(observes[0]?.data.frameId));
  for (const o of observes.slice(1)) {
    const n = await xenonIn(String(o.data.frameId));
    report.push(`observe ${String(o.data.frameId)}: ${n} xenon-like pixels (first observe: ${firstCount})`);
    expect(n, `xenon pixels in observe ${String(o.data.frameId)} against the first observe's ${firstCount}`).toBeLessThanOrEqual(firstCount + 24);
  }

  // 6. Rendering the same log twice yields identical frames.
  for (const d of dispatches.slice(0, 3)) {
    const t = microsToMs(Number(d.data.ringAt)) + 100;
    const twice = (await page.evaluate((tMs) => (window as unknown as { __localdot: { oracle: { renderTwice(t: number): Promise<unknown> } } }).__localdot.oracle.renderTwice(tMs), t)) as { identical: boolean; bytes: number };
    expect(twice.identical, `identical overlay frames at t=${t}`).toBe(true);
    expect(twice.bytes).toBeGreaterThan(0);
  }

  expect(intents.length).toBeGreaterThanOrEqual(10);
  await info.attach("oracle-report", { body: report.join("\n"), contentType: "text/plain" });
  await page.screenshot({ path: `e2e/out/oracle-${info.project.name}.png` });
});
```
Run:
```bash
pnpm --filter @localdot/web build
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e --grep "pixel oracle"
```
Expected: `2 passed` (`hidpi` and `lodpi`), about 6 minutes each. The attached `oracle-report`
lists the hotspot offsets (expected: under 1 px at zoom 1, under 2 px at zoom 2), for the flash
clicks the change frame and the ring frame, and any click whose dwell held no capture (its
cursor-at-press check is skipped; the Fast click's 45 ms dwell is the likely one). A failing
hotspot check names the label and zoom: look at the crop (`e2e/out/results/...`) before touching
the renderer — at zoom 2 the counter-scaled cursor must still be anchored at its tip (`Overlays.#drawCursor` scales the Graphics around the
origin, which is the tip). A failing ring-order check with "change at frame N, ring over N+2" means
the ring is late (fine); "ring over N−2" means early: the calibration's p99 is stale for this
machine — re-run Task 6 before anything else.

- [ ] **Step 4: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web
git commit -m "test(web): pixel oracle for cursor hotspot, ring order, typing pace and clean observations"
```

---
### Task 17: End-to-end acceptance, the full suite, the Node 24 run and the docs

**Files:**
- Create: `apps/web/e2e/visual-core.spec.ts`
- Modify: `README.md`, `.github/workflows/ci.yml` (nothing new beyond Part 2's `web build`: verify it runs the stage tests)

- [ ] **Step 1: The acceptance test — the multi-app puppet, live in the UI, with the overlays**

`apps/web/e2e/visual-core.spec.ts`:
```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { type CellRef, createReadyCell, removeCell } from "./cells.ts";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";
import { runPuppet, sessionEvents, waitForSessionEnd } from "./puppet.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
const SCRIPT = JSON.parse(readFileSync(fileURLToPath(new URL("../../daemon/puppet/demo-multiapp.json", import.meta.url)), "utf8"));
let daemon: RunningDaemon;
let cell: CellRef;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images and Docker Desktop");
test.beforeAll(async () => {
  daemon = await startDaemon();
  cell = await createReadyCell(daemon, 2);
});
test.afterAll(async () => {
  if (cell) await removeCell(daemon, cell.id);
  await daemon?.stop();
});

test("the puppet runs a multi-app sequence live in the Theatre with the overlays", async ({ page }) => {
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 120_000 });
  const sessionId = await runPuppet(daemon, cell.id, SCRIPT);
  await expect(page.getByTestId("hud-status")).toHaveText("Opening calc", { timeout: 15_000 });
  await expect(page.locator(".stage.control")).toBeVisible();
  await expect(page.getByTestId("hud-stop-session")).toBeVisible();
  await expect(page.getByTestId("hud-status")).toHaveText('Clicking "Name Box"', { timeout: 30_000 });
  await page.screenshot({ path: "e2e/out/10-click-name-box.png" });
  await expect(page.getByTestId("hud-status")).toHaveText('Typing "Q3 revenue"', { timeout: 30_000 });
  await page.screenshot({ path: "e2e/out/11-typing.png" });
  // Review Focus 1 on the real path (P3-C11): pause this cell's desktop (never another cell on this
  // Docker) during the script's dedicated 10 s wait step, never mid-input, so the test exercises
  // reconnection rather than desktopd's /input and /observe client timeouts; the HUD reports the
  // stall and the session completes after unpause.
  await expect(page.getByTestId("hud-status")).toHaveText("Waiting for the sheet", { timeout: 30_000 });
  const container = desktopContainer(cell.id);
  expect(container).toBe(`localdot-desktop-${cell.id}`);
  execFileSync("docker", ["pause", container]);
  await expect(page.locator(".stage-veil.on")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  execFileSync("docker", ["unpause", container]);
  await expect(page.locator(".stage-veil.on")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("hud-status")).toHaveText('Clicking "Page two"', { timeout: 120_000 });
  await page.screenshot({ path: "e2e/out/12-chromium-link.png" });
  const events = await waitForSessionEnd(daemon, sessionId, 240_000);
  expect(events.at(-1)?.data.reason).toBe("done");
  expect(events.filter((e) => e.type === "action.cancel")).toEqual([]);
  await expect(page.getByTestId("hud-status")).toHaveText("Done", { timeout: 15_000 });
  await expect(page.locator(".stage.control")).toHaveCount(0);
  const rows = page.getByTestId("step-row");
  await expect(rows).toHaveCount(SCRIPT.steps.length);
  await expect(rows.first().locator("img")).toHaveAttribute("src", /^blob:/);
  await page.screenshot({ path: "e2e/out/13-done.png" });

  const order = ["action.intent", "action.target", "action.dispatch", "screen.settle", "observe", "action.result"];
  const nameBoxStep = events.find((e) => e.type === "action.intent" && e.data.label === 'Click "Name Box"')?.step;
  const stepEvents = (await sessionEvents(daemon, sessionId)).filter((e) => e.step === nameBoxStep && order.includes(e.type)).map((e) => e.type);
  expect(stepEvents).toEqual(order);
});
```

Run:
```bash
pnpm --filter @localdot/web build && LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e --project hidpi
```
Expected: `live-desktop`, `two-viewers`, `visual-core` and `pixel-oracle` pass in the `hidpi` project
(about 20 minutes). Look at `e2e/out/10-click-name-box.png` (cursor on the Name Box with the xenon box and
chip, the rim lit, the HUD reading `Clicking "Name Box"`), `11-typing.png` (the pill with
`Q3 revenue` and the caret), `12-chromium-link.png` (the link boxed in Chromium) and `13-done.png`
(rim off, HUD "Done", the Steps rail with thumbnails). These four are the M2 acceptance evidence.

- [ ] **Step 2: The whole suite, on Node 24 and on the host Node**

```bash
npx -y -p node@24.21.0 -c 'node --version && pnpm test && pnpm typecheck'
pnpm test && pnpm typecheck && pnpm lint && pnpm hygiene
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e
```
Expected: all green; the Docker suites take 20–30 minutes (Part 2's plus desktopd, perception, CDP
and the opt-out proxy); the e2e run both projects.

- [ ] **Step 3: README and commit**

Add to `README.md` after Part 2's "Images and the live desktop" section:
```markdown
## The visual core (M2)

- `desktopd` inside the cell perceives through Cua Driver (`cua-driver mcp --no-overlay`) and
  Chromium's DevTools protocol, and acts through its own XTest client (`xhelper.py`), which
  timestamps every XI2 raw press. Routes: `/clock`, `/input`, `/type`, `/settle`, `/arm`, `/launch`,
  `/observe`, `/hitTest`, `/find`, all behind the cell's bearer token.
- The daemon's action gateway turns actions into `action.intent → action.target → action.dispatch →
  screen.settle → observe → action.result` with the spec's timing. The click ring starts at the raw
  press plus that injector's p99 from `~/.localdot/calibration.json`; without the file the
  development Mac's numbers apply. Measure your machine once, as users see the desktop (compositor
  on): `LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web calibrate --compositor on --scale 2 --trials 500`
  (and `--scale 1`); `--compositor off` only checks the harness against S6 and writes nothing.
  `LOCALDOT_RING_ONSET=strict` selects the stricter onset policy once its desktopd piece exists.
- Puppet scripts drive the gateway without a model: with the daemon and a computer running,
  `pnpm --filter @localdot/daemon puppet puppet/demo-multiapp.json` plays the demo live in the UI.
- Overlays are drawn by PixiJS in a worker from `@localdot/stage`'s `render(log, t, view)`; every
  colour is a token in `apps/web/src/theme.css`. The pixel oracle
  (`LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e --grep "pixel oracle"`) checks the drawn
  cursor, the ring order, the typing pace and the clean observations at DPR 1 and 2.
```

```bash
pnpm format && pnpm lint
git add apps/web README.md
git commit -m "test(e2e): visual core acceptance with the multi-app puppet"
```

---

## Interfaces Part 4 builds on

Exact module paths and exports as they exist at the end of this plan. Part 4 (M3, keyd) adds the
Go daemon, the per-cell listeners, the egress wiring into the cells and the key form; nothing in
the cells' inbound side changes.

**Where keyd plugs in**
- `apps/daemon/src/cells/spec.ts`: `desktopEnv(record, opts)` is the one place the cell's proxy
  settings go (`HTTPS_PROXY`/`HTTP_PROXY` = `http://<record.docker.gateInternalIp>:3128`, the
  proxy token, the CA path); `record.keydPort` (4760–4789, `apps/daemon/src/cells/ports.ts`) is the
  keyd listener the gate relays to (`cells/gate/relay.sh`, `internal:3128 → host.docker.internal:LD_KEYD_PORT`).
- `cells/desktop/desktopd/src/perception/driver.ts`: `CuaDriver.defaultOptions(env)` builds the
  driver's environment explicitly (the MCP SDK filters it); when the cell gets proxy variables,
  decide whether the driver inherits them — its telemetry and update checks stay disabled
  (`CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`), and
  `apps/daemon/src/cells/driver-optout.docker.test.ts` shows what it would send when enabled.
- `desktopd`'s `selfTest()` (spec, API table; "the boot self-test must pass before the cell is marked
  ready") is not built: Part 4 adds `GET /selftest` to `createDesktopdApp` in
  `cells/desktop/desktopd/src/app.ts` and makes `probeDesktopd` (`apps/daemon/src/cells/readiness.ts`)
  require it before `ready`.
- `key.use` events: `apps/daemon/src/gateway/live.ts` `LiveSessions.get(cellId)` names the session
  keyd's audit lines belong to; append with `EventLog.append(sessionId, { type: "key.use", agent: "keyd", data })`
  (`apps/daemon/src/event-log.ts`). The schema is in `packages/protocol/src/events.ts` and exported
  for keyd at `packages/protocol/schema/events.schema.json` (CI fails on drift).
- Stop and the kill switch: `POST /api/sessions/:id/stop` (`apps/daemon/src/gateway/routes.ts`)
  calls `LiveSessions.stop(sessionId)`, which aborts the gateway's `AbortSignal`
  (`ActionGateway.run(ctx, action)` in `apps/daemon/src/gateway/gateway.ts`); Part 4 adds "drop the
  cell's surrogates" to that route.
- `apps/daemon/src/main.ts` wiring order: `monotonicClock()` → `EventLog(home, clock)` → `CellOrchestrator`
  (its startup `reconcile()` runs in the background, Task 12) → `DesktopdRegistry(orchestrator, clock)` →
  `loadOnsetTable(home)` → one `FrameStore` → `ActionGateway` → `createApp({ …, gateway: { registry, clock, eventLog, gateway, frames, live } })`.
  keyd's admin-socket client and the key form's routes join `createApp`'s options the same way.
- `apps/daemon/src/cells/docker.ts`: `new DockerClient(socketPath?, timeoutMs = DOCKER_TIMEOUT_MS)`
  (30 s) and `DockerRequest.timeoutMs?`: every Engine request ends, with `DockerError` status 0 and
  "no reply within … ms" when Docker never answers.

**Daemon (stable for Parts 4–5)**
- `apps/daemon/src/gateway/gateway.ts`: `ActionGateway { run(ctx: ActionContext, action: GuiAction): Promise<ActionOutcome>; observe(ctx); cursorOf(cellId) }`,
  `GuiAction` (`click` by model point or `find`, `type`, `key`, `scroll`, `wait`), `ActionContext { sessionId; cellId; agent?; step?; signal? }`,
  `GatewayDeps`. M4's brain forwards each completed `computer` tool call as one `GuiAction` per action
  (the coordinate module in `@localdot/providers` turns the model's space into model pixels first;
  the gateway converts to device pixels). The freshness check (`frameId` on the action, `action.cancel
  { reason: "stale" }`) is M4's addition at the top of `#pointerAction`.
- `apps/daemon/src/gateway/ring-onset.ts`: `RingOnsetPolicy`, `keepPolicy`, `strictPolicy`, `policyFromEnv`.
- `apps/daemon/src/gateway/onset-table.ts`: `loadOnsetTable(home)`, `CalibrationFile`; `apps/daemon/src/gateway/frames.ts`: `FrameStore`.
- `apps/daemon/src/desktopd/client.ts`: `DesktopdClient` (`clock`, `input`, `type`, `settle`, `arm`, `launch`, `observe`, `hitTest`, `find`);
  `apps/daemon/src/desktopd/registry.ts`: `DesktopdRegistry.for(cellId): { client; clocks }`; `apps/daemon/src/desktopd/clock-map.ts`: `ClockMap`.
- `apps/daemon/src/puppet/{script.ts,runner.ts}`: `PuppetScript`, `runPuppet(deps, run)`; `apps/daemon/puppet/*.json`.
- Routes: `GET /api/clock`, `POST /api/cells/:id/input`, `POST /api/cells/:id/launch`, `POST /api/cells/:id/puppet`,
  `GET /api/cells/:id/live`, `POST /api/sessions/:id/stop`, `GET /api/sessions/:id/clock`, `GET /api/sessions/:id/frames/:frameId`.
- `apps/daemon/src/cells/stream-proxy.ts`: `RELAY_HIGH_WATER` (4 MiB) and `RELAY_LOW_WATER` (512 KiB), overridable
  through `StreamProxyDeps.highWater`/`lowWater`; `apps/web/e2e/two-viewers.spec.ts` checks that a frozen
  viewer never stalls another.

**desktopd (in the cell)**
- `cells/desktop/desktopd/src/app.ts`: `createDesktopdApp(deps: DesktopdDeps)` with `DesktopdDeps { token; scale; display; readXsettings; readScreen; x?; injectors?; launch?; clockMono?; perception? }`;
  routes `/healthz`, `/clock`, `/input`, `/type`, `/settle`, `/arm`, `/launch`, `/observe`, `/hitTest`, `/find`.
  `shell`, `files.*`, `browser.*` (M4) and `selftest` (M3) are added here.
- `cells/desktop/desktopd/x/xhelper.py` + `src/x/helper.ts`: the X helper and its client; `src/input.ts`: `inject`, `typeText`, `withPress`,
  `Injectors { xtest: true; driver?: DriverInjector }`, `DriverInjector { click(req); type(req) }` (clicks and typed text only, P3-C9);
  `src/perception/{driver.ts,mapping.ts,hit-test.ts,cdp.ts,observe.ts,find.ts}`.
- `packages/protocol/src/desktopd.ts`: every wire schema the daemon and desktopd share (the wire target
  is unbounded, `WireTarget`; the gateway's `clipTarget` enforces the event limits);
  `packages/protocol/src/text.ts`: `clipText`, `keyDisplayName`.
- Image: `/opt/localdot/xhelper.py`, `/opt/localdot/{flash,marker}.html`, `/opt/localdot/demo/`, `cwebp`,
  `/usr/local/bin/localdot-chromium` (maximized, DevTools on `127.0.0.1:9222`), the caret does not blink.

**Stage and web**
- `packages/protocol/src/time.ts`: `MICROS_PER_MS`, `microsToMs`, `msToMicros`, `msToSeconds`, `sessionMsOf(event)` — the only
  µs↔ms conversions (P3-C2); `apps/web/src/session/clock-sync.ts`: `syncClock`, `SessionClock`, `sessionMsAt(wallMs, clock)`.
- `packages/stage/src/{model.ts,scene.ts,camera.ts,timing.ts}`: `foldEvents`, `agentStateAt`, `sceneAt`, `render`, `cameraFor`, `toCanvas`;
  `View { reducedMotion }`; `SessionModel.agentStates` (every state, so a scene at any time reads the one in effect) and `frames`.
- `apps/web/src/stage/{render-worker.ts,worker-protocol.ts,pixi-presenter.ts,overlays.ts,oracle.ts,oracle-check.ts,StageCanvas.tsx,Stage.tsx}`
  (`Stage`'s optional `control`; `StageCanvasHandle.setTheme(theme)` for a theme pack that restyles the stage;
  `OracleRequest`; the canvas reads the theme, the device pixel ratio and the motion preference when it mounts);
  `apps/web/src/session/{useLiveSession.ts,session-view.ts,clock-sync.ts,thumbnails.ts,useNowMs.ts}`; `apps/web/src/shell/StepRow.tsx`;
  `apps/web/src/lib/api.ts`: `ApiClient` gains `token`, `authorization()` and `fetch`.
  M4's chat starts sessions itself and replaces the 1 Hz `/live` poll in `useLiveSession`; M5's
  approvals and takeover extend `Hud.tsx` (the disabled "Take over" button) and `control.change`
  handling in `scene.ts`'s `controlAt`; M6's replay feeds `foldEvents` from a stored log and sets
  the worker's clock from the scrubber instead of `wallNow()`.

**Part 4+ obligations carried from this plan (not implemented here)**
- `strict` ring onset: the desktopd `change_at` command and `POST /change-at` described in Task 9,
  if the user picks strict for A1.
- The driver injector delivers clicks and typed text only (P3-C9): key combos through the driver are
  refused with a 501 (its `press_key` is XSendEvent, invisible to the XI2 listener), and `drag`
  through either injector is not wired (M8 drag visuals). If own XTest ever fails for good on a
  machine, shortcuts need another injector.
- Relay backpressure pauses the upstream instead of shedding frames, which P3-C6 allows only while
  one paused viewer stalls no other (Task 11's two-viewer test); if Selkies' WebSocket protocol has
  a keyframe request, shedding with an IDR request would cut the catch-up latency.
- Until its background reconcile reports, a cell that survived a daemon restart shows as stopped
  (at most one Docker timeout, 30 s, when Docker is wedged); Start meanwhile waits in that cell's
  operation queue.
- §4.5's "max blocking presentation" cap is not enforced (P3-R35); M4's brain may want it when
  actions chain quickly.
- `contentOrigin` for Chromium rests on the marker test of Task 8; the `document web` AT-SPI frame
  is the documented fallback formula.
- The opt-out-on-the-wire check depends on the driver honouring `HTTPS_PROXY`; the control run
  fails loudly otherwise (Task 7b).
- `LiveSessions` allows one session per cell; the M4 brain and the puppet share it.
- `thumbnails.ts` never revokes its blob URLs within a page lifetime (bounded by one session's frames).
- `sessionHud` calls `sceneAt` on every React render (≤ 10 Hz); `useNowMs` estimates the session
  time from the last folded event plus wall-clock drift.
- `foldEvents` finds the current action by scanning back by `step` (fine below ~10 k events; M6's
  replay of long sessions should index by step).
- `screen.settle.changed` carries at most 8 merged rectangles (`merge_rects`); P1's "what changed"
  flash may want the raw list.
- The cursor halo is a fixed dark fog; research §4.3.1's luminance sampling is deferred.
- The render budget (spec "Rendering": under 4 ms per frame on an M1-class laptop) is unmeasured;
  Task 17's e2e only records `data-fps` on the M3 Ultra. Measure on M1-class hardware with Part 2's
  `measure.spec.ts` pattern before M9.
- Part 2's deferred minors that remain deferred: the T14 full synchronous re-read per stream
  connect (every viewer re-reads the JSONL on connect: acceptable for M2's session sizes).

## Decisions taken by this plan (ruled on by the controller, P3-R1 to P3-R29; P3-R30 to P3-R39 apply P3-C15 and P3-C16)

- **P3-R1 Geometry and units.** Event geometry is in desktop device pixels, declared by
  `session.start.screen`; the puppet and the models speak model pixels (1280×800) and the gateway
  converts with `toDevice`. Envelope `t`, `pressT` and `ringAt` are session microseconds;
  `PointerPlan.startsAt` is session milliseconds and the stage renders in milliseconds. Every
  µs↔ms conversion goes through `packages/protocol/src/time.ts` (`microsToMs`, `msToMicros`,
  `msToSeconds`, `sessionMsOf`), unit-tested, never inline arithmetic (P3-C2); the raw input
  route's daemon-clock stamps are named `pressDaemonMicros`/`armedDaemonMicros` so they are never
  mistaken for session time.
- **P3-R2 Schema changes.** `action.dispatch` carries `pressT`, `ringAt` and `injector`; `observe`
  references a frame file (`<home>/sessions/<id>/frames/<frameId>.webp`) and carries no image;
  envelope ids are validated as ULIDs; `resizedPixels` is deleted from `@localdot/providers`.
- **P3-R3 The X helper is python-xlib** (`python3-xlib` from the image, no pip): two X connections,
  an own parser for XI2 raw events (python-xlib 0.33 has none), DAMAGE raw rectangles merged to ≤ 8
  boxes, `_NET_ACTIVE_WINDOW` activation awaited as a `PropertyNotify` with a 300 ms cap, keysym
  remapping onto spare keycodes for characters the layout lacks, double-click gap 90 ms, hold 0 ms.
  The XFCE caret no longer blinks (it would be screen damage that never settles).
- **P3-R4 Ring onset.** "keep" (press + the injector's per-scale p99) is implemented and default
  behind `RingOnsetPolicy`; `LOCALDOT_RING_ONSET=strict` selects the strict policy whose desktopd
  piece is specified but not built until A1 is decided. The table comes from
  `<home>/calibration.json`, else the development Mac's S6 numbers with a startup warning.
- **P3-R5 Calibration** is a Playwright script in `apps/web/e2e` driving the real path (daemon →
  desktopd → Selkies → the daemon proxy → the stage's own frame tap), ≥ 500 trials per group,
  nearest-rank percentiles, in two passes (P3-C15): the gate, `--compositor off` (xfwm4's
  compositor switched off live in the cell and the flash page in a kiosk window, S6's
  conditions), validates the harness against S6 (p50 within ±3 ms, p99 ≤ S6's p99 + one frame) and
  writes nothing; the table, `--compositor on` (the production configuration Task 1 settled, the
  page maximized through `localdot-chromium`), writes `calibration.json`. A gate that misses S6 by
  more than ±3 ms is re-baselined with S6's own script on the current image; the tolerance is
  never loosened. The CLI skips a leading `--`, refuses unknown or unpaired options, and only a
  table pass on the press-acting page writes the file. The driver's click rows are measured in
  Task 8, once Task 7's driver injector exists, with the same two passes, and there are no driver
  key rows (P3-C9).
- **P3-R6 Observe** = the driver's `get_desktop_state` PNG at `max_image_dimension` 1280, encoded by
  `cwebp -q 80` through `/dev/shm`; always 1280×800; frames stored by the daemon, served behind the
  install token, shown as blob URLs.
- **P3-R7 Hit test** picks the top-most client window from `_NET_CLIENT_LIST_STACKING`, the
  smallest mapped element containing the point (depth breaks ties), CDP first for Chromium content,
  a coordinates-only target on decorations, `null` on empty desktop; LibreOffice VCL parts are
  recognised by a role set plus tool-bar ancestry with GTK text fields exempt; `m` is the tallest
  shallow `menu` row (default 27).
- **P3-R8 Chromium content origin** = the X client origin plus `(outerWidth − innerWidth)/2` and
  `outerHeight − innerHeight` in CSS px × `devicePixelRatio`, proven by the marker test; the driver's
  `document web` frame is the fallback formula if the test disagrees.
- **P3-R9 Driver opt-out on the wire** is checked with a CONNECT-logging proxy and a control run
  that must see traffic; a failing control fails the test rather than passing vacuously.
- **P3-R10 Typing** streams one progress line per key for the first 60 characters and then every
  eighth; masking happens in desktopd (no plaintext leaves it) and the gateway's label says
  `Type N characters`; pace Watch 35/6 ms, Fast 8 ms, Instant 0 ms.
- **P3-R11 Launch** is an allow-list of nine apps with arguments limited to three flags
  (`--kiosk`, `--new-window`, `--incognito`), `about:blank` and files under `/opt/localdot` or
  `/config` (never a flag that re-points DevTools, the proxy or the profile); Chromium starts
  through `localdot-chromium` (maximized, accessibility on, DevTools on loopback 9222).
- **P3-R12 The puppet API**: `POST /api/cells/:id/puppet` creates the session and runs it in the
  background (one live session per cell), `GET /api/cells/:id/live` lets the UI find it (1 Hz poll
  until M4's chat starts sessions itself), `POST /api/sessions/:id/stop` aborts it, and a CLI follows
  the event stream.
- **P3-R13 Relay backpressure** pauses the upstream socket above 4 MiB of unsent viewer bytes and
  resumes below 512 KiB: bounded daemon memory without corrupting the H.264 stream; the stall
  watchdog stays fed during such a pause, so the cell's stream never reads "stalled" for it. P3-C6
  allows the pause because Part 2's `relay()` dials one upstream per viewer, and Task 11's
  two-viewer test checks its purpose: a frozen viewer never stalls another. If that ever fails, the relay sheds
  instead, which waits for a verified keyframe request.
- **P3-R14 One watch loop per cell** is Part 2's own: its `#current` guards (a2531c0) and per-cell
  operation queue (bfd71bb) make a late loop stand down, so Part 3 adds no generation counter; Task
  11's test pins the behaviour.
- **P3-R15 The renderer** is PixiJS 8.21.0 in the worker with `WebWorkerAdapter`; the presenter owns
  each `VideoFrame`, S8's seed frame included (Part 2's Task 14), uploads it once
  (`ImageSource.update()`), closes it after the render, and drops a frame superseded before it was
  drawn; the pump closes a frame only when `present` throws; `autoGarbageCollect` is off for the video source. The
  worker also hands every frame to the oracle object, which, only while the oracle is enabled
  (P3-C12), keeps one clone of the newest (closed when the next replaces it or the stream stops),
  because a still screen sends no frames; with the oracle off, in production, it keeps nothing. The
  camera is built from the session's screen; a frame of another size is scaled into it and reported
  once, as a `warn` message to the page.
- **P3-R16 Theme** colours reach the worker as a parsed `StageTheme` read from the CSS tokens by the
  stage canvas when it mounts (with the device pixel ratio and the motion preference; the canvas
  exists only where frames can be tapped, so jsdom never reads them); four tokens are added (`--color-xenon-a10`, `--color-halo-target`, `--color-shade-cursor`,
  `--color-key-bevel`). Xenon is used only while `agent.state` is `acting`, `observing` or `thinking`
  and the session has not ended; "looking at" is a neutral dashed outline (unused by the puppet).
- **P3-R17 Overlay geometry**: the mockup's arrow at 24 px screen height tilted 12°, a fixed dark
  halo, the name chip at (+14, +30) px so the oracle can isolate the arrow; ring 44 px, scale
  0.6→1 over 225 ms (cubic ease-out standing in for the research's bezier), opacity 0.7→0 over 300 ms;
  the target box morphs from a 36 px crosshair with a critically damped 0.31 s spring and holds
  900 ms after dispatch; the press squash is drawn from `pressT − 80 ms` (replay sees all of it,
  the live view joins when the dispatch arrives).
- **P3-R18 Reduced motion and Instant**: under reduced motion the cursor cross-fades between the
  plan's ends (120 ms) instead of travelling, the box snaps, the caret does not blink, no float and
  no keycap pop; rings keep their timing and fade only. A plan with `durationMs` 0 (Instant) never
  travels either: the cursor appears at the target and fades in over 150 ms (the research's
  fade-teleport) while the dispatch waits its 60 ms.
- **P3-R19 Time on the page**: session time = `sessionMsAt(wallNow, clock)` =
  `microsToMs(msToMicros(wallNow) + offset − originMicros)`, the offset from lowest-RTT pings of
  `GET /api/clock` every 20 s and the origin from `GET /api/sessions/:id/clock`, both through the
  API's own fetch with failures logged and retried; the viewer's frame-arrival stamps stand in for
  the daemon's chunk stamps until M6's recorder; overlays freeze while the stream is not live.
- **P3-R20 The oracle** captures, in the worker, overlay-only PNG crops at zoom 1 and 2 — 96 px
  centred on each action point and, at most every 50 ms, 96 px around the drawn cursor wherever
  it is, with the cursor's press and alpha — and 64 px luma crops of the video inside a window
  around each action, the first a baseline from the newest frame when the window opens, or when
  an Instant click's intent is folded (Selkies sends nothing for a still screen; that frame is kept
  only while the oracle is on, P3-C12 and P3-R29; a failed crop goes to the dump's `errors`, which
  the spec asserts empty); it locates the real cursor sprite by template matching on an unsquashed,
  opaque capture, checks the scene cursor on the dispatch point only on captures in the dwell
  (reported, not failed, when the dwell held none), counts accent pixels in the 11–21 CSS
  px ring band with the arrow's footprint, the target box's edges and the crosshair's own pixels
  excluded (premultiplied RGBA: only solid xenon counts), finds the change frame from the luma
  crops for every flash-page click, checks the typing display against the model's counts, holds
  each observe frame's xenon-like pixels (sharp) to the session's first observe plus 24, and
  renders a fixed time twice for determinism (`extract` redraws the scene under the requested
  camera); it runs at DPR 2 and DPR 1, with the flash page maximized, never in a kiosk window.
- **P3-R21 Docker tests** that need desktopd's TypeScript import it from
  `apps/daemon/src/cells/*.docker.test.ts` (one direction, test code only); `startDesktopContainer`
  is the shared standalone-desktop helper.
- **P3-R22 Not in M2**: the freshness check (M4), approvals and takeover (M5), `step.verify`,
  scroll and drag visuals (M8), the auto-camera (M8); `screen.settle` is appended after every action
  and the gateway continues after 3 s with `quiet: false` ("page still changing" is the `noVisibleChange`/`quiet` pair for M4 to word).
- **P3-R23 The puppet's demo** reaches Calc's B2 through the Name Box (`find` by accessible name)
  rather than screen coordinates, because Calc cells are not in the tree (S2) and the layout at 2×
  is unmeasured; the oracle script uses the flash page for press-acting clicks and the marker page's
  password field for masking.
- **P3-R24 `clipText`** lives in `@localdot/protocol` so desktopd and the gateway cut names, roles,
  titles and labels the same way (code points, control characters stripped, `…`); `windowInfo` and
  every target field use it, never `slice`.
- **P3-R25 The driver fallback injector (P3-C9)** is `DriverInjector { click(req); type(req) }`:
  clicks through the driver's `click`/`double_click`/`right_click` with foreground delivery and
  typed text through `type_text` as one string (one progress line after the delivery, carrying the
  whole count and stamped with the first raw press), both still timed by the XI2 listener and both
  using the `driver.click` onset row. Key combos, moves and scrolls through the driver are refused
  by `inject` with `UnsupportedInputError` (501 on the wire); `CuaDriver` has no `pressKey`.
- **P3-R26 Task units (P3-C10)**: the renderer is two tasks — 14a (pure parts, protocol,
  `PixiPresenter`, the overlay skeleton, the worker loop, the video path, "see it draw") and 14b
  (the P0 `Overlays`, the stage handle, the rim) — and the driver's opt-out proxy test is Task 7b,
  separate from Task 7's perception suite.
- **P3-R27 The acceptance pause (P3-C11)** happens during the demo script's dedicated
  `wait 10000 ms` step ("Waiting for the sheet"), never mid-input, so Task 17 tests reconnection
  rather than desktopd's client timeouts; the pause, from the stall veil to the unpause, takes
  about 5.3 s, so the step leaves more than 4 s of margin.
- **P3-R28 Perception hygiene from the review**: `windowUnder` and `findTarget` skip the panel, the
  dock and the desktop window (`DECOR_CLASSES`), and `findTarget` walks the windows' trees inside a
  4 s budget; Chromium's device scale factor is asked only for Chromium windows; `CdpSession`
  keeps a persistent `error` listener, enables the Accessibility domain once per session and is
  replaced once its socket closes; the X helper sleeps 20 ms after a keycode remap, announces XI
  2.2 and keeps only the slave device's raw events (one per physical press); a helper that reports
  `fatal` is killed; `ensureHelper` keeps one in-flight start; every Python invocation is
  `/usr/bin/python3`.
- **P3-R29 The oracle's kept frame (P3-C12)** is held only while the oracle is enabled, never in
  production: `OracleCapture.onFrame` returns at once while the oracle is off, so the worker holds
  no extra decoded `VideoFrame` (about 12 MB at 2× I444, which can starve the decode/track frame
  pool). While it is on, each frame's clone replaces and closes the previous one, `dispose()`
  closes it when the stream stops or is replaced, and `enable` keeps it. The oracle spec enables
  the oracle under `?oracle=1` before the puppet starts, and the script's first step (the flash
  page's launch) repaints the screen before any window opens, so every window has its baseline. Switched
  on mid-stream on a still screen, the oracle gives a window that opens before the next frame no
  baseline (Task 16's "keeps no clone while the oracle is off" pins this); no test runs that way.
- **P3-R30 Compositing (P3-C15)**: Task 1 confirms that the running image composites with
  `vblank_mode` `off` (Part 2's commit 4195ea0) and counts torn frames in a motion capture at 2× and
  1×; `off` stays unless the capture tears, and then the image syncs through `xpresent` and accepts
  the latency. Plank stays translucent; the compositor stays on.
- **P3-R31 Production window mode (P3-C16's F12 and F13)**: the calibration's table and the oracle
  open their pages with `--new-window`, maximized by `localdot-chromium`; only the compositor-off
  gate uses `--kiosk`. The dock's Chromium launcher points at the wrapper's
  `/usr/local/share/applications/chromium.desktop`, so no launch path starts Chromium without
  its DevTools port and forced accessibility.
- **P3-R32 Part 2's committed code is edited, never replaced (P3-C16's F1 and F2)**: desktopd keeps
  `/healthz`'s not-ready semantics, `readXsettings(uid)`, the 2 s child timeout and the
  unset-versus-failed logic; the stage keeps S8's seed, the re-ticket and remount, and the stale
  storage cleanup; Part 2's tests keep passing unchanged. `Stage`'s `control` prop is optional.
- **P3-R33 Docker hygiene (P3-C16's F6, F16, F21)**: every Docker Engine request carries an
  `AbortSignal` timeout (30 s; a request may set its own), the startup reconcile runs in the
  background so the UI loads while Docker is wedged, every Docker probe a test reads asserts its
  exit status, and a server a Docker test needs runs in a worker thread (the opt-out proxy).
- **P3-R34 The scene reads the agent state in effect at its time**: the model keeps every
  `agent.state`, so `render(log, t, view)` is right for any `t`, not only after the last state;
  test logs are numbered in order, as a session's are.
- **P3-R35 Research §4 details applied in the fix pass (P3-C16's F38)**: the cursor rests (dimmed and
  floating) after 1.2 s with nothing to do as well as while thinking; keycaps rise 20 px as they pop
  in; the target chip is cut with `clipText`; Fitts' W floor is 16 px times the cell's scale, in
  device pixels like the distance. §4.5's "max blocking presentation" (Watch 800 ms, Fast 350 ms)
  is not enforced: the spec's Timing formulas win, and a Watch action may present for up to
  lead 120 + travel 700 + dwell 90 = 910 ms before its press.
- **P3-R36 The gateway's own fixes (P3-C16's F28 to F30)**: it holds dispatch for a stalled stream
  only while a viewer is attached; a Stop reaches an in-flight `/type`, so desktopd stops typing at
  the next key; each action returns the frame its own `#finish` observed.
- **P3-R37 A finished session stays on screen**: its verdict ("Done", "Stopped", "Failed") stays the
  HUD's label while the computer is live, the computer's own Stop comes back, and its steps stay in
  the rail until `/live` names the next session.
- **P3-R38 desktopd's bundle notices (P3-C16's F19)**: `build.mjs` reads the bundled packages from
  esbuild's metafile and writes each one's license text into the bundle header, failing on a package
  without a license file; `cells/desktop/THIRD-PARTY.md` lists the same packages.
- **P3-R39 Shared text helpers**: `clipText` and `keyDisplayName` live in `@localdot/protocol` and are
  the only implementations (the gateway's labels and the stage's keycaps use the same key names,
  Linux style per research §4.3.6), as are the finite-number guard `requireFinite` and one
  `DECOR_CLASSES` set; `main.ts` builds one `FrameStore` for the gateway and the frame route.
