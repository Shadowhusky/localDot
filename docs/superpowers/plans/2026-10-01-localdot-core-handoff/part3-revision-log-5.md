# Part 3 plan — revision 6 change log (pre-flight scan F1–F43, P3-C15, P3-C16)

Plan: `plans/2026-10-01-localdot-core-part3.md`, now **12,551 lines** (11,282 before) and **19 task units**:
Tasks 1–17 plus 7b, with the renderer split into 14a/14b. Line numbers below refer to the revised plan.
Inputs: `part3-preflight-scan.md`, `part3-rulings.md` (P3-C15 with its amendments and note, P3-C16), the spec,
research §4, Part 2's plan and ledger, and Part 2's repository read with `git show`/`git archive` only.

## Results in one place

- All 43 findings are applied, three with a stated narrowing: F17 keeps the old test as a regression pin, F25
  needs no edit, and F38 leaves out §4.5's blocking cap (reasons in their entries).
- 11 fixes go beyond the scan; they were found while verifying (section "Beyond the scan").
- Assembled tree (Part 2 HEAD `dfaf41f` + stubs of Part 2 Tasks 11–15 + every Part 3 block):
  - tsc 7.0.2: 0 errors in all 7 projects;
  - Biome 2.5.15: clean after the plan's documented `biome check --write` on the 6 files that fragments merge
    into (1 warning, in the stubbed Part 2 `app.css`);
  - Vitest 5.0.3: 68 files, 472 tests pass (Part 2 baseline: 35 files, 315 tests);
  - `vite build` passes (worker chunk 463 kB);
  - desktopd's new `build.mjs` bundles 17 packages, each license in the header;
  - `python3 -m py_compile xhelper.py` passes.
- Every task's commit gate passes in its own intermediate tree, and all 11 RED steps fail as the plan now states.
  Five statements were reworded to Vitest 5's real output.

## Renumbering map (old → new)

| Old | New | | Old | New |
|---|---|---|---|---|
| — | **1** (new: low-latency compositing, P3-C15) | | 8 | 9 |
| 1 | 2 | | 9 | 10 |
| 2 | 3 | | 10 | 11 |
| 3 | 4 | | — | **12** (new: Docker timeouts, F16) |
| 4 | 5 | | 11 | 13 |
| 5 | 6 | | 12a / 12b | 14a / 14b |
| 6 / 6b | 7 / 7b | | 13 | 15 |
| 7 | 8 | | 14 | 16 |
| | | | 15 | 17 |

Every "Task N" reference was rewritten by script; mentions of Part 2's own tasks ("Part 2's Task 14") were left alone.
One reference the script missed, "Task 12a." before a full stop, is fixed by hand (11827).
A reference check afterwards found no stale numbers.

## New tasks

- **Task 1 — Low-latency compositing (223–456, P3-C15 as amended).**
  - Step 2 re-runs Part 2's "composites without vsync" probe at 2× and 1×.
  - Steps 3–4 use S8's harness with a new `motion.html` (a full-height bar moving 16 CSS px per frame) and
    `tearing.js` (a paste script that counts frames, frames with the bar, moving frames and torn frames from a
    clone of the client's track). They measure send → frame latency with the flash page maximized and count
    tears in a 10 s capture, at 2× and 1×.
  - Step 5 decides: keep `off`; or switch to `xpresent`, change Part 2's probe and accept the latency; or, if
    XPresent tears too, the tear is in the capture, so report to the controller.
  - Step 6 records `docs/measurements/2026-10-compositor.md`.
  - Goal (5–6), Architecture (23–25), Tech Stack (36–37), "This is Part 3" (53–54), the File map (201–202, 219) and
    P3-R30 (12513) name the task.
- **Task 12 — Docker requests that cannot hang the daemon (8136–8291, F16).**
  - `DOCKER_TIMEOUT_MS = 30_000`. `DockerClient(socketPath?, timeoutMs)` and `DockerRequest.timeoutMs?` give each
    request an `AbortSignal.timeout`. A request with no reply rejects with `DockerError` status 0, "no reply within
    … ms".
  - `main.ts` turns the awaited startup `reconcile()` into `void orchestrator.reconcile().catch(…)` (8277).
  - Tests:
    - `docker.test.ts` "gives up on a socket that never answers" covers the client's 200 ms limit and a request's
      own 50 ms;
    - new `main.test.ts` spawns `node --import tsx src/main.ts` against a wedged socket and gets `/healthz` 200
      within 10 s, well under the 30 s Docker timeout, so the test proves the background reconcile, not the
      timeout.
  - The wedged server calls `socket.resume()` (8202). Without it, the test's `server.close()` never finished,
    which the first run showed.
  - RED verified: `Test timed out in 5000ms`, and no `/healthz` answer.
  - Interfaces Part 4 builds on (12269–12275), obligations (12333–12335) and P3-R33 (12526).

## Findings

### Critical

- **F1** (Part 2's desktopd kept).
  - Task 4's `app.ts` is the committed 123f443 file plus the routes (2849–3010). Kept as they were:
    - the not-ready `/healthz` (`readXsettings(): Promise<Xsettings | null>`, `hidpiReport(scale, x | null)`);
    - the 2 s child timeout;
    - the unset-versus-failed logic.
  - Task 4's `main.ts` keeps `uid` and `readXsettings: () => readXsettings(uid)` (3012–3075).
  - Task 7's fragment keeps both, and its `scaling` reads `null` as the cell's scale (5526–5555).
  - Expected counts say "Part 2's 12" (3084).
  - All 12 Part 2 desktopd tests pass in the assembled tree.
- **F2** (S8's seed, re-ticket and storage cleanup kept). Part 3 builds on Part 2 Task 14's video path:
  - Task 6's worker carries `first` (4147–4227).
  - Task 14a's intro states the three carried fixes (9113–9121).
  - `WorkerIn.frames` gains `first?` (9378).
  - The pump closes a frame only when `present` throws: Part 2's `present` helper is edited, not replaced
    (9335–9346). Two pump tests are updated and one is added ("closes a frame the presenter throws on, and a
    refused seed never stops the stream").
  - The worker passes `{ first: m.first }` and closes `first` on "frames before init".
  - The 14a and 14b `StageCanvas` transfer `[readable, first]`.
  - Task 14b's `Stage` is Part 2's: generation, `forgetClientStorage`, `onLost`, key remount (10307–10443).
  - P3-R15 (12424) and P3-R32 (12522) record it.
- **F3** (`--`).
  - No `pnpm calibrate`/`test:docker` command carries `--` (checked by grep), the README included (12222).
  - The calibration parser skips a leading `--`, refuses unknown or unpaired options (4441–4452), and writes the
    table only from a table pass on the press-acting page.
  - Global Constraint (139–141) and P3-R5 (12379).
- **F4** (scene tests at the root cause).
  - `scene.test.ts` numbers each log by position before folding (`inOrder`, 8386–8390).
  - The model keeps `agentStates` (8634) with `agentStateAt(model, t)` (8644). `controlAt`, the thinking float
    and the HUD read the state in effect at `t`.
  - New test "reads the agent state in effect at t, not the latest one".
  - No assertion was weakened. `packages/stage` passes 45/45 at Task 13.
  - P3-R34 (12530).
- **F5** (jsdom crash). The canvas reads the theme, the device pixel ratio and the motion preference inside its
  mount effect; it renders only behind the support gate, so jsdom never reaches them.
  - Task 14a intro (9117–9121) and its `StageCanvas` (9748–9844); `Stage.tsx` unchanged in 14a (9846).
  - `Stage` is unchanged in 14a.
  - In 14b, `control` is optional with default `false` (10356), so Part 2's `Stage.test` and `App.test` pass
    unchanged.
- **F6** (opt-out proxy). The proxy runs in a worker thread (`new Worker(PROXY, { eval: true })`, 5824) and the
  test reads its log by message after each run. The intro says why (5751–5754).
- **F7.** Task 5 adds `"zod": "4.6.5"` to `apps/daemon` (3978).
- **F8.**
  - (a) the fake helper's `let mono = 100` (2241, 2750);
  - (b) `FakeDesktopd` takes `armed` before `press` (3243);
  - (c) `observe.ts` imports `clipText`;
  - (d) the unbounded wire target, `WireTarget = Target.extend(…)` (2165), with the gateway's `clipTarget`
    enforcing the event limits.
  - All 4 tests pass.
- **F9.** Every row of the scan's tsc table is fixed. Examples:
  - `async` NDJSON writers;
  - `string | URL | Request` (3299);
  - `ContentfulStatusCode` (3928);
  - the e2e `ProbeWindow` cast;
  - the perception getter;
  - `{ node: {} as … }` (6164);
  - `?? 0` on `ringAt − pressT` (6847, 6871);
  - the relay's captured `viewer` (7983);
  - `cursorPolygon(1)[3] ?? 0` (9246);
  - `control` optional;
  - a distributive `OracleRequest` (9400) for `oracle(command)`.
  - tsc reports 0 errors in the assembled tree and at every commit gate.
- **F10.** Every rule in the scan's table is fixed:
  - `flash.html` closes its tags and has no `tabindex`;
  - `marker.html` buttons have `type="button"`;
  - `/\p{Cc}+/gu` (4805);
  - the `ChromiumPerception` class replaces the stub's interface;
  - `launch.test.ts` has no unsafe chain;
  - pre-increments are separate statements;
  - the calibrate chain is split;
  - `StepRow`'s status dot has `role="img"` (10903);
  - `useNowMs` is a `useMemo` with a justified `biome-ignore` (10984);
  - `tick()` has no assignment in an expression (9640);
  - the import orders are fixed.
  - Five more whole-file import orders found by the run are fixed (see "Beyond the scan").
  - The Global Constraint names `pnpm exec biome check --write <files>` for fragment merges (131–134).

### Important

- **F11.** P3-C15 as amended:
  - Task 1 (above);
  - Task 6's intro and Interfaces describe the two passes (3995–4045);
  - `calibrate.ts`: `--compositor off|on`, the gate validates against S6 with the compositor switched off live
    through `xfconf-query` on the session bus (4499–4501), and the table is written only by on-passes;
  - Step 4 has both passes per scale with no `--`, and the re-baseline note "don't loosen the tolerance"
    (4630–4670);
  - the template has a gate block and a table block (4683, 4694);
  - Task 8 Step 3 runs the same two passes (6320–6331);
  - P3-R5 (12379) and P3-R30 (12513).
- **F12.** The production window mode everywhere but the gate:
  - calibrate `windowArgs = gate ? ["--kiosk"] : ["--new-window"]` (4530);
  - `oracle.json` opens the flash page with `--new-window` (7794), with a sentence on why (7787–7789);
  - the oracle's comments (12036) and P3-R29 (12509) say "the flash page's launch";
  - Global Constraint (147–150), P3-R31 (12517).
- **F13.** `localdot-plank` points a launcher at `/usr/local/share/applications/<app>.desktop` when one exists
  (1713–1720). Part 2's dock-launcher expectation in `desktop-image.docker.test.ts` now lists the override first
  (1723–1736). Without that, Part 2's image test would fail.
- **F14.** Task 17 pauses `desktopContainer(cell.id)` and asserts the name (12161–12162).
- **F15.** Every `pnpm test:docker` names its file without `--`; Global Constraint (139–141).
- **F16.** New Task 12 (above).
- **F17.** The generation counter, its edit, the "Expected: FAIL" claim and the old P3-R14 are dropped. The test
  stays as a regression pin:
  - the "Expected" says it already passes (7953–7955);
  - it passes on HEAD `dfaf41f`'s orchestrator;
  - the "make `setup()` accept `sleep`" step is gone, since Part 2's setup already takes it.
  - P3-R14 (12421) credits a2531c0 and bfd71bb. The intro says this (7847–7851).
- **F18.** Task 11 Step 3: `apps/web/e2e/two-viewers.spec.ts` (8006–8113).
  - Viewer A starts the computer; a noise canvas, launched with `docker exec`, keeps the stream busy.
  - Viewer B attaches, and then viewer A is frozen with CDP `Page.setWebLifecycleState`.
  - For six 5 s windows, B must keep more than half its steady frame rate and its "Live" HUD.
  - The cell's largest TCP send queue (`/proc/net/tcp`) must pass 128 KiB, so the test cannot pass vacuously.
  - A must recover after the thaw.
  - The step says what to do if B stalls: P3-C6 then forbids pausing, so stop and report.
  - The intro cites P3-C6 (7855–7859); P3-R13 (12415). The File map lists the spec (217).
- **F19.** `build.mjs` is rewritten (5568–5615) to read the bundled packages from esbuild's metafile, write each
  license into the header (a package without one stops the build) and log the list.
  - `THIRD-PARTY.md` gets the 17 rows the run produced (5619–5635).
  - The expected output names 17 packages, "about 1.4 MB".
  - Measured: 17 packages; `fast-uri` is BSD-3-Clause; `isexe`, `which` and `zod-to-json-schema` are ISC.
  - P3-R38 (12545).
- **F20.** The keycap chips of a combo are built once and reused while it shows. The previous combo's are
  destroyed with `{ children: true }` (`#keycapsLabel` 9963–9964, its reset in `setTheme` 9983, `#drawKeycaps` 10128–10150).
- **F21.** Every Docker probe whose output a test reads asserts its status first. Among them:
  - `node` and `xfconf-query` (Task 3), `curl …/json/version`;
  - `cat /tmp/typed.txt` (1917) and `/tmp/http.txt` (3131);
  - `windowGeometry` (1806–1823);
  - `identify` (5692), the AT-SPI probe (5724) and `convert … info:` (6256);
  - `xdotool key` (Task 8);
  - the opt-out run (5807).
  - The root-run `xfconf-query` probe in Task 3's test, which would have started its own bus, is removed.
  - Global Constraint (141–145).

### Minor

- **F22.** The observe test asserts the strip of `image` with a real ULID (533).
- **F23.** The opt-out test parses the replies and requires a `result` on id 2 (5842).
- **F24.** Counts and outputs:
  - "Replace … with the first test below, and add the other three" (501);
  - "Part 2's 12" (3084);
  - "13 tests pass (cdp 6, hit-test 7)" (6214);
  - the worker chunk "about 460 kB" (9861);
  - the mapping fixture uses 27 px (4837–4856).
  - Every count the plan states for a unit-test file was re-counted in the assembled tree. Docker-file counts
    were checked by counting `it(` (6 + 2 = 8, 3, 2, 3).
- **F25.** No edit. Revision log 4's versions were informational; the plan's pins (Playwright 1.63.0, sharp
  0.35.5) stand and are what this verification installed.
- **F26.** Files sections and the File map:
  - `registry.test.ts` (Task 5);
  - the `cdp.ts` stub under Create (Task 7);
  - Task 10 no longer lists `app.ts`;
  - Task 15 lists `packages/stage/src/model.ts`, `lib/api.ts` and `useNowMs.ts` and drops the unchanged
    `Caption.tsx`;
  - `build.mjs` and `THIRD-PARTY.md` in Task 7;
  - the `.dockerignore` no-op is gone;
  - `xsettings.xml.in` and `registry.test.ts` added to the File map.
  - A script compared every Files section with the map; nothing is missing.
  - `Stage.test.tsx` needs no change, because `control` is optional.
- **F27.** Task 2's Interfaces list `TARGET_IN_MS = 120` and `CANCEL_SHAKE_MS = 180` (491).
- **F28.** `holding(stream)` holds only while `viewers > 0` (6967).
  - The "never holds" test now leaves a `disconnected` with 0 viewers and expects the action to go through.
  - Review Focus 1 (156–161).
- **F29.** The gateway passes `ctx.signal` to `DesktopdClient.type`.
  - `FakeDesktopd` gains `typeHolds` (3216, 3256), a `/type` that streams its progress and then waits on the
    request's signal.
  - New gateway test "a Stop mid-typing ends the typing itself" (6850).
- **F30.** `#finish` returns this action's `frameId`; `#lastFrame` is gone (7078, 7118, 7133).
- **F31.** `findTarget` skips `DECOR_CLASSES` and walks within `FIND_BUDGET_MS = 4000` (5255–5271, 5349).
- **F32.** `PARENT_SEGMENT` refuses `..` (2722–2728), with tests for both roots.
- **F33.** The X helper sends XIQueryVersion 2.2 and keeps only `deviceid == sourceid` (1132–1152).
  Interfaces (965).
- **F34.** `startDesktopContainer` waits for `"ok":true` (1791).
- **F35.**
  - A helper that reports `fatal` is killed (975);
  - `CdpSession.closed`, with `ChromiumPerception` opening a new session (6084, 6132), and a new cdp test
    "opens a new session once the page's socket has closed";
  - `ClockMap.start` logs failed syncs (3711);
  - the registry forgets a cell that leaves `ready` (3748), with `registry.test.ts`.
- **F36.**
  - The crosshair's xenon fill is gated by `control` (10025).
  - `PixiPresenter` reports a size mismatch through `opts.warn`, which the worker posts as `warn` (9662).
- **F37.** The calibration returns raw ms from the page and converts with `msToMicros` in Node (4572).
- **F38.** Applied:
  - the idle float after 1.2 s with nothing to do (`restSince`, 8904–8907, plus a test);
  - the keycap 20 px rise (`KeycapsScene.dy`, 8774/9017, drawn in 14b, plus test expectations);
  - the chip cut with `clipText` (8974);
  - Fitts' W floor of 16 px × scale (`MIN_TARGET_PX`, 6918/7035, plus a test).
  - **Not applied:** §4.5's "max blocking presentation" cap. The spec's Timing formulas (lead 120 + travel ≤ 700
    + dwell 90 ms) are binding, and capping them would change the timing contract the oracle tests. Recorded as
    P3-R35 (12533) and as a Part 4 obligation (12336).
- **F39.**
  - One `DECOR_CLASSES` (exported from `hit-test.ts`, used by `find.ts`).
  - One `keyDisplayName` in `@localdot/protocol` (4755–4815), used by the gateway's `keyLabel` (6520) and the
    stage's `keycapNames` (8854). The stage's "⌫" becomes "Backspace": research §4.3.6 asks for Linux names.
  - One `requireFinite` (495, 550–566).
  - One `FrameStore` in `main.ts` (7639–7680).
  - P3-R39 (12548).
- **F40.**
  - The demo's dedicated wait is 10 000 ms (7778), so the ~5.3 s pause path has more than 4 s of margin. The
    Task 17 comment and P3-R27 (12492) say so. Task 10's run time is now "about 45 s".
  - Step rows no longer vanish: an ended session stays until `/live` names another (`useLiveSession`: the poll
    runs while ended, the socket closes at `session.end`).
  - See "Beyond the scan" for the "Done" HUD this needed.
- **F41.** Check 5 holds each observe's xenon-like pixels to the session's first observe (taken before any
  action) + 24 and reports every count (12057–12072).
- **F42.** `received` is gone from `Flip` and from the 14a `probing` (4191, 9622).
- **F43.** `copyIntoDesktop`'s `spawnSync` import goes at the top of the import block (5559–5560).

## Beyond the scan (found while verifying)

1. **The "Done" HUD (Task 15).** `mergeHud` returned the cell's label for a finished session, so Task 17's
   `toHaveText("Done")` could never pass.
   - A finished session now keeps its verdict as the label while the computer is live, the computer's Stop
     comes back (10620), and a test covers it.
   - Intro (10474–10476), Interfaces, the screenshot step (11130) and P3-R37 (12542).
2. **A deliberate relay pause read as a stall (Task 11).** A paused upstream stops reading pongs, so the stall
   watchdog fired and the whole cell read "stalled". Every viewer then saw "Reconnecting…" and the gateway
   would hold dispatch.
   - The drain interval now feeds the watchdog (7988–7990).
   - The relay test asserts no "stalled" during the pause. A mutation run without the line fails with
     `['connecting','live','stalled']`.
   - The two-viewer test checks B's "Live" HUD (8101).
   - Intro (7855) and P3-R13 (12417).
3. **RED statements matched to Vitest 5.0.3's output.**
   - Task 3: `Cannot find module './helper.ts'` (1519).
   - Task 9: `Cannot find module './gateway.ts'` (6886).
   - Task 2 Step 3: "FAIL, 7 tests …; a curve this renderer does not know still bows" (750). There was no
     `curve` type error.
   - Task 4 Step 4: "the 5 new tests … 404, Part 2's 7 still pass; the typecheck rejects the new options" (2843).
   - Task 5: `log.originOf is not a function` (3531).
4. **Whole-file import orders Biome 2.5.15 rejects:**
   - `input.ts` (`node:` first);
   - desktopd `app.ts` (`type Injectors, inject`);
   - Task 6's `render-worker.ts` (`type PumpStats, pumpFrames`);
   - Task 14a's `render-worker.ts` and `oracle.ts` (`type SessionModel, sceneAt`);
   - `oracle-check.test.ts` (`type Rgba, ringBandMask`).
5. **Warnings removed:**
   - the unused `idleFor` left by F38;
   - the unused `type LoggedEvent` in the oracle spec;
   - the three `useOptionalChain` warnings in `scene.ts`, as `d?.input.kind !== …`, which tsc accepts.
6. **The `unreachable` snippet in Task 12** is indented to its real depth, so it can be pasted as is.
7. **App.tsx (Task 15).** The step names the imports it needs and replaces Part 2's title effect rather than
   adding a second one (10950–10953).
8. **The Theatre test** answers `/live` with 404, as the step says, applied to Part 2's `App.test.tsx`.
9. **`desktop-image.docker.test.ts`'s launcher list (Task 3, with F13).** Part 2's committed test would fail
   once the dock uses the override.
10. **The root `xfconf-query` probe in Task 3's Docker test** is removed (see F21).
11. **The Part 2 base moved.** HEAD is now `dfaf41f`: Tasks 9 (doctor) and 10 (cell API, status stream, upgrade
    router) are committed, after a history rewrite of `f17b6ef` into `9caec83`.
    - The verification tree uses HEAD's real files for Tasks 1–10. Part 3's edits to `app.ts`, `main.ts`,
      `docker.ts` and `orchestrator.test.ts` were checked against them. Task 12 targets HEAD's awaited
      `reconcile()` and `#send`.

## Verification runs

Scratch only, never a repository working tree. The tree is `git archive dfaf41f`, plus Part 2 Tasks 11–15 stubbed
from Part 2's plan and ledger, with node_modules installed offline from the scan's store.

- **Baseline (Part 2 only):** tsc 0 errors; Biome clean (1 warning in the stubbed `app.css`); Vitest 35 files,
  315 tests.
- **Staging:** `stage_p3_new.py` finds every block by its label in the plan (not by line), applies whole files
  verbatim and fragments by exact replacement, and fails on any miss. Every Part 3 block applies; `pnpm install
  --offline` adds the new packages.
- **Final tree:**
  - tsc 7.0.2: 0 errors in `packages/{protocol,stage,providers}`, `cells/desktop/desktopd`, `apps/daemon`,
    `apps/web` and `apps/web/e2e`.
  - Biome 2.5.15: before the documented step, only `organizeImports` in the 6 merge targets (`routes.ts`,
    `routes.test.ts`, daemon `main.ts`, `App.tsx`, the two `index.ts`). After `biome check --write` on them:
    "Checked 242 files, No fixes applied, 1 warning".
  - Vitest 5.0.3: 68 files, 472 tests.
  - `vite build`: `render-worker-*.js` 463 kB plus PixiJS's lazy chunks; app 346 kB.
  - `node build.mjs`: 17 packages, 1.4 MB.
  - `py_compile`, `node --check` and `bash -n` pass for `xhelper.py`, `tearing.js`, `build.mjs` and both wrapper
    scripts.
  - Both puppet scripts parse with `PuppetScript`, and their launch arguments pass desktopd's allow-list.
- **Commit gates.** A tree staged through each task (2, 3, 4, 5, 6, 7, 7b, 8, 9, 10, 11, 12, 13, 14a, 14b, 15, 16):
  tsc 0 every time; Vitest green every time (326 → 472 tests); Biome errors only `organizeImports` in merge
  targets. Task 6's worker import order was the one real error, now fixed. This also checks the blocks later
  tasks supersede: Task 6's worker and canvas, Task 7's `cdp.ts` stub, and Task 14a's overlay and oracle
  skeletons.
- **RED steps**, each in the tree of the task before plus only that step's tests:
  - Task 2 step 1: 3 tests fail as stated, plus `Cannot find module './time.ts'`.
  - Task 2 step 3: 7 tests fail.
  - Task 3: module missing.
  - Task 4 step 2: keys, input and launch missing.
  - Task 4 step 4: the 5 new tests 404 and Part 2's 7 pass.
  - Task 5: modules missing, and `originOf is not a function`.
  - Task 9: module missing.
  - Task 11: the pin passes and the relay test fails with `expected 0 to be greater than 0`.
  - Task 12: `Test timed out in 5000ms`, and no `/healthz`.
  - Task 13: three modules missing; green afterwards, 45/45.
  - Task 16: all 4 fail at the stated points.
- **Not run (no Docker, by instruction):** the `*.docker.test.ts` suites, Playwright e2e (`two-viewers`,
  `pixel-oracle`, `visual-core`, `calibrate`) and Task 1's capture. They typecheck and lint clean.

## Part 2 assumptions (Tasks 11–15 are not built yet; the plan builds on these, from Part 2's plan and ledger CARRY)

- **`cells/stream-proxy.ts`:**
  - `relay()` declares `let client: WebSocket | undefined`, has the one-line `upstream.on("message")` handler and
    a `StallWatchdog` fed by message, ping and pong;
  - `StreamProxyDeps { cells; tickets; vendorDir; pingEveryMs?; stallAfterMs? }`;
  - `stream-proxy.test.ts` has `fakeSelkies()` and `daemon(upstreamBaseUrl)`, which return `connections(id)`,
    `open`, `prefix` and `settle`, with `desktop = { cells, tickets, vendorDir, pingEveryMs: 50, stallAfterMs: 150 }`;
  - `app.ts` has `desktop`/`ui` options;
  - `main.ts` has `const desktop = {…}` and `desktopStreamRoute(desktop)`, plus static-ui's `webDir`.
- **The stage (Part 2 Task 14):**
  - `FrameSource.first`, from `new VideoFrame(video)` when `readyState ≥ 2`;
  - `PumpOptions.first`, with a `present` helper using `try { … } finally { frame.close(); }` and the seed
    presented first inside its own try/catch;
  - `render-worker.ts` with `WorkerIn.frames.first` and `m.first?.close()` before the init error;
  - `StageCanvas.attach` transfers `[readable, first]` and closes `first` when there is no worker;
  - `Stage` with a `generation` state, `forgetClientStorage(cellId)`, a stream ticket `?g=…`, `onLost` and a key
    remount;
  - `DesktopFrame.onLost` after 10 s without `#videoStream`;
  - `presenter.ts`'s `canvasPresenter`;
  - `Stage.test.tsx` renders `<Stage cell api />` and expects the support-gate alert;
  - `pump.test.ts` has the two `present: (f) => presented.push(f)` fakes and the seed test.
- **The web shell (Part 2 Tasks 12–13):**
  - `App.tsx`'s `Theatre` begins with `useCell`/`hudFor` and has its own title effect;
  - `App.test.tsx` imports `{ cleanup, render, screen }`, and its Theatre test returns `[]` for unknown paths;
  - `hudFor(cell, busy)` returns `HudState { label; caption; action; live }`, with "Live"/`stop` for a live
    ready cell;
  - `useCell` shows the first listed cell, so a second tab sees the same computer;
  - `ApiClient` has `get`/`post`/`socketUrl`/`socketProtocols`, from `createApi(token, { fetchImpl, … })`;
  - `openSocket({ url, protocols, handlers })`;
  - `theme.css` has `--color-xenon-a40`;
  - the shell components `TopBar`, `ConversationRail`, `PlanRail`, `StageColumn`, `Hud` and `Caption`.
- **e2e:**
  - `e2e/daemon.ts` exports `startDaemon` and `desktopContainer(cellId)` (port 4790);
  - Playwright 1.63.0 with a single project until Task 16 adds `hidpi`/`lodpi`;
  - Part 2's last commit message is `test(e2e): live desktop acceptance and 2x measurements` (Task 1 Step 1).
- **Committed, read at HEAD `dfaf41f`:**
  - `localdot-plank`'s two-line `printf` into `"$launchers/$app.dockitem"`;
  - the launcher-list expectation in `desktop-image.docker.test.ts`;
  - `main.ts`'s awaited `reconcile()` with its comment;
  - `docker.ts`'s `#send`/`unreachable`;
  - the orchestrator's `setup({ restartBackoffMs, sleep })`;
  - `FakeOrchestrator.updateStream`.
  - If Part 2's later commits change any of these, the matching Part 3 step names the old text, and its task
    review catches the conflict (P3-C16's cost line).
