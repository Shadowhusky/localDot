# Part 3 pre-flight conflict scan (2026-10-01)

Plan: `docs/superpowers/plans/2026-10-01-localdot-core-part3.md` (11,282 lines, 17 tasks). Binding:
`part3-rulings.md` (P3-C1…C15 with the C15 amendments), the core spec, `visualization-ux.md` §4, the
Part 2 plan's "Interfaces Part 3 builds on" and "Part 3 obligations", the Part 2 ledger and S8's FINDINGS.

**Result: 10 Critical, 11 Important, 22 Minor.** Findings F1–F43 are below the tables. Plan line numbers
refer to the plan as it stands, at 11,282 lines.

## What was checked, and how

**Read in full**
- The plan, every line.
- `part3-rulings.md` and `part3-revision-log-4.md`.
- From the spec: "One click, end to end", "The virtual computer", "Action gateway and live view", "Error
  handling" and "Testing".
- `visualization-ux.md` §4.1–4.5, §4.11 and §4.12.
- From the Part 2 plan: Tasks 9–15 (code blocks included), "Interfaces Part 3 builds on" and "Part 3 obligations".
- The Part 2 ledger (`progress.md`, every CARRY and ruling) and S8's `FINDINGS.md`.
- From S2/S6: the driver's tool surface and the `xilog.py` listener.

**Committed code read** (via `git show`, never the working tree)
- desktopd: `app.ts`, `xsettings.ts`, `auth.ts`, `main.ts`, `build.mjs`, the package manifest and the tests.
- daemon: `app.ts`, `main.ts`, `clock.ts`, `event-log.ts` and its tests, `event-stream.ts`, `port.ts` and `paths.ts`.
- daemon `cells/`: `types.ts`, `secrets.ts`, `spec.ts`, `readiness.ts`, `orchestrator.ts` and its tests,
  `testing/docker-cli.ts`, `testing/fake-docker.ts` and `desktop-image.docker.test.ts`.
- `protocol`, `stage` and `providers`, all of each.
- Image files: `xfwm4.xml.in`, `xsettings.xml.in`, the Dockerfile, `localdot-plank` and `.dockerignore`.

**Part 2's Task 8 landed during this scan**, as 043e6a7 (specs) and a2531c0 (orchestrator). The base is
therefore `feat/core-part2` at a2531c0, Tasks 1–8, with Task 8 committed but not yet reviewed. Two more
commits landed before I finished: 977b1ff (the orchestrator Docker test) and bfd71bb (per-cell queues for
start, stop and remove). F17 was re-checked against bfd71bb's orchestrator.

**Assembled toolchain run.** The scratch copy is `.../scratchpad/part3-preflight/repo/`, built with
`git archive feat/core-part2`.
- **Part 2 Tasks 9–15 are stubbed from the Part 2 plan's code blocks.** That is 51 whole files plus the
  App and app.css fragments. They follow the plan's text, so they do **not** include S8's CARRY changes.
- **All 194 of Part 3's code blocks were applied.** Whole files went in verbatim and fragments by exact
  replacement.
  - Some fragments are scattered across the plan, and these I assembled by hand:
    - the daemon's `app.ts` and `main.ts`;
    - desktopd's `app.ts` and `main.ts` (Tasks 3, 6 and 7);
    - `App.tsx` (Task 13);
    - `gateway/routes.ts` and `routes.test.ts` (Tasks 4, 9 and 13).
  - The import-order diagnostics in hand-assembled files are not counted against the plan.
  - Task 10's orchestrator edit could not be applied, because its target line does not exist (F17).
- **Tools.** pnpm 10.29.3 installed everything (pixi.js 8.21.0, React 19.3.0, @playwright/test 1.63.0,
  sharp 0.35.5) from a scratch store. Then:
  - TypeScript 7.0.2 `tsc --noEmit -p` for protocol, stage, providers, desktopd, the daemon, web and web/e2e;
  - Biome 2.5.15 `format --write`, then `check .`;
  - Vitest 5.0.3, the full unit run (385 tests);
  - Vite 8.3.1 `build` of apps/web;
  - an esbuild metafile of desktopd's bundle;
  - `python3 -m py_compile` on `xhelper.py` (it passes), plus a read of python-xlib 0.33's source and of
    XI2proto.txt.
- **Probes I ran:**
  - pnpm's handling of `--`;
  - Vitest's file filter after `--`;
  - the calibration script's own parser, fed the plan's command lines;
  - five fix experiments (Appendix B).
- **Not run:** Docker, the Playwright e2e and calibration, or a real Selkies. Part 3 has no Go.

## Table A — task pairs and shared interfaces

| Pair | Shared file / interface | Produced | Consumed | Finding |
|---|---|---|---|---|
| T1→T3 | `Injector` (`events.ts`) | `z.enum(["xtest","driver"])` | `desktopd.ts` `Injector.default("xtest")` | ✓ |
| T1→T8 | `action.dispatch` | `{input, pressT, ringAt, injector}`, µs | gateway appends `#pressT()` session µs, `ringOnset.onset` µs | ✓ units (P3-C2) |
| T1→T11 | `pressT`/`ringAt` µs, `PointerPlan` ms | schema + comment (T8 5822) | `model.ts` `microsToMs(...)`, `pointerAt(plan, tMs)` | ✓ |
| T1→T11 | `timing.ts` | 21 constants (Interfaces list) + `TARGET_IN_MS`, `CANCEL_SHAKE_MS` | `scene.ts` imports both unlisted ones | Minor doc drift (F27) |
| T1→T8 | `travel.ts` | `intentLeadMs`, `typingPaceMs`, `INSTANT_LEAD_MS` | gateway | ✓ |
| T1→T4,5,8,9,11–14 | `time.ts` | `microsToMs`, `msToMicros`, `msToSeconds`, `sessionMsOf` | everywhere | ✓; calibrate's in-page µs math is a documented exception (F37) |
| T2→T3,T6 | `XHelper`/`XEvent`, xhelper commands | `ping pointer windows activate move click scroll keys char arm settle quit` | `input.ts`, `settle.ts`, `hit-test.ts`, `observe.ts`, `find.ts` | ✓ names/args; raw events duplicated (F33) |
| T2→T3,6,6b,7 | `testing/desktop-container.ts` | `DESKTOP_IMAGE`, `startDesktopContainer`, `execAsDesktopUser`, `launchInDesktop`, `windowGeometry`, +`copyIntoDesktop` (T6) | Docker tests | ✓; readiness wait ignores `ok` (F34) |
| T3→T4 | `@localdot/protocol` `desktopd.ts` | `InputResult`, `TypeProgress/Result`, `SettleResult`, `HitTestResult` (Target max lengths) … | `DesktopdClient` parses every reply | conflicts with T8's test (F8d) |
| T3→T4 | desktopd routes | `/clock /input /type(NDJSON, {error,status}) /settle /arm /launch` | `DesktopdClient` paths, timeouts, NDJSON reader | ✓ |
| T3→T6 | `Injectors`, `DriverInjector` | `{ xtest: true; driver? }`, `click`/`type` | `driverInjector(driver, x)` | ✓ |
| T4→T4 | `FakeDesktopd` default `/input` | `armedMono` computed **after** `pressMono` | `routes.test` expects armed < press | ✗ F8b |
| T4→T8,T9 | `DesktopdRegistry.for` | `{ client, clocks }` | gateway `#ready`, runner | ✓ |
| T4→T8,T13 | `EventLog.toSessionT`, `originOf` | session µs | gateway, `/api/sessions/:id/clock` | ✓ |
| T4→T5 | `/api/clock`, raw `/input` | `{nowMicros}`, `pressDaemonMicros` | calibrate | ✓ |
| T4↔T5/T7 | `CalibrationFile` | `{v, measuredAt, machine?, trials?, onsetMs}` | calibrate writes it | ✓ shape; CLI misparse (F3) |
| T5→T12a,13,14 | `sessionMsAt`, `SessionClock` | `{offsetMicros, originMicros}` | worker `StageClock` (same shape), `setClock`, oracle | ✓ |
| T5→T12a | `probe.ts` | `meanLuma`, `ProbeRect`, `Flip`, `wallNow` | worker `probing` | ✓ |
| T5/T12a/T12b ↔ P2 T14 (CARRY) | `render-worker.ts`, `WorkerIn.frames`, `pumpFrames`, `StageCanvas.attach`, `Stage` | P2 T14: `FrameSource.first`, `pumpFrames(…,{first})`, re-ticket/remount, storage cleanup | Part 3 replaces all three files without them | ✗ F2 |
| T5→T14,T15 | `e2e/cells.ts` | `createReadyCell`, `removeCell`, `CellRef` | specs | ✓ |
| T6→T6 | `clipText` | protocol `text.ts` | `observe.ts` uses it without importing | ✗ F8c |
| T6→T7 | `ChromiumPerception` | stub interface | T7 class `implements` itself (merged) | ✗ lint F10 |
| T6→T6 | `PerceptionDeps.readScaling` | `() => Promise<number>` | `main.ts` `scaling` calls `readXsettings()` | ✗ F1 |
| T7→T4 | driver calibration rows | `driver.click` | onset table | ✓ (but never measured, F3) |
| T8→T9 | `ActionGateway`, `GuiAction` | `run`, `observe` | runner `actionOf` | ✓ |
| T8→T9 | `FrameStore` | `save`/`path` | frame route | ✓ |
| T9→T13 | `/live`, `/stop`, `/frames`, `LiveSessions` | routes | `useLiveSession`, `thumbnails` | ✓ |
| T9→T14 | `oracle.json` | 10 dispatches, kiosk flash page | spec check 3 | ✓ counts; kiosk path ✗ F12 |
| T9→T15 | `demo-multiapp.json` | 10 steps, labels | HUD texts, 10 step rows | ✓ |
| T10↔P2 T11 | `relay()` | `let client: WebSocket \| undefined` | T10 handler uses `client.` | ✗ tsc F9 |
| T10↔P2 T8 (built) | `#watch` | `#current(id, entry)` guards (F13) | generation counter edit | ✗ obsolete F17 |
| T11→T12a,13,14 | `foldEvents`, `sceneAt`, `Scene` | model + scene | worker, `session-view`, oracle | ✓ API; model history gap F4 |
| T13→T11 | `SessionModel.frames` | added by T13 | `stepRows` | ✓ (model test still `toEqual`) |
| T12a→T12b,14 | `worker-protocol.ts` | `WorkerIn/Out`, `OracleCommand` union | `StageCanvasHandle.oracle(Omit<OracleCommand,"id">)` | ✗ non-distributive Omit (F9) |
| T12a→T14 | `PixiPresenter` | `extract`, `presented`, `frameSize`, `app.renderer` | `OracleCapture` | ✓ |
| T12b→T13 | `StageHandle`, `control` prop | handle + rim | `useLiveSession`, `App.tsx` | ✓; Part 2 `Stage.test` lacks `control` (F9) |
| T13→T13 | `ApiClient` | `authorization()`, `fetch`, `token` | `useLiveSession`, `thumbnails` | ✓ (file not in Files, F26) |
| T2 ↔ P2 T3b | `chromium.desktop` override | `/usr/local/share/applications` | Plank launchers hard-code `/usr/share/applications/chromium.desktop` | ✗ F13 |
| T3 ↔ P2 T5 (built) | desktopd `app.ts`/`main.ts` | `readXsettings(): Promise<Xsettings\|null>`, `readXsettings(uid)` | T3 rewrites to `Promise<Xsettings>`, no uid | ✗ F1 |
| T15 ↔ P2 T15 | finding the cell's desktop | `desktopContainer(cellId)` (label `localdot.cell=<id>`) | T15 uses "first `localdot.role=desktop`" | ✗ F14 |
| T5/T14 ↔ P2 T3b/T5 | xfwm4 template | compositor on, `vblank_mode=off`, `unredirect_overlays=true` | calibration/oracle in `--kiosk` | ✗ F11, F12 |
| T4,T9 ↔ pnpm | `zod` import in `apps/daemon` | — | `onset-table.ts`, `puppet/script.ts` | ✗ F7 |

## Table B — every task

| Task | Tests vs code | Files vs steps | Part 2 assumptions |
|---|---|---|---|
| **0 (missing)** | — | P3-C15 asks for a first task; none exists | ✗ F11 |
| 1 | 6 new/changed protocol tests pass; the "observe never image" test is half vacuous (F22). Stage/provider tests pass. | ✓ ("add four tests" is 1 replacement + 3, F24) | Part 2 obligations 1–5 covered ✓ |
| 2 | `helper.test` 5/5 pass. Docker part 1 (6) not run. | `.dockerignore` "replace" is byte-identical (F26) | Dock override ✗ (F13); probes lack status (F21); panel 54 ✓ |
| 3 | **2 committed Part 2 tests fail** (F1). `input.test` 1 fails (F8a). tsc: 4 errors (F9) + 3 (F1). Lint: 7 errors (F10). | Expected "Part 2's 5" desktopd tests: there are 12 (F24) | `/healthz` "not ready" and the xfconf guard regressed (F1) |
| 4 | routes 1 fails (F8b). 3 tsc errors (F9). `zod` unresolved (F7). | `registry.ts` missing from the file map (F26) | `createApp`/`FakeOrchestrator`/`CellApi` shapes ✓ |
| 5 | probe and clock-sync pass. `calibrate.ts` tsc ×5 (F9) and lint (F10). | ✓ | Drops S8's seed (F2); the CLI misparses (F3); P3-C15 (F11); kiosk (F12) |
| 6 | mapping 7/7, hit-test 6/6. **observe fails** (F8c). Lint: `text.ts` (F10). | `cdp.ts` stub not listed (F26) | `main.ts` repeats F1 |
| 6b | Can't pass: in-process proxy (F6) | ✓ | Breaks the Part 2 F31/Task 1 ruling |
| 7 | cdp 5/5. tsc ×3 (F9), lint `noUnsafeDeclarationMerging` (F10). | "Expected: 5 tests" for 2 files holding 11 (F24) | Driver rows never measured (F3) |
| 8 | gateway 11/12 (F8d). tsc ×2 (F9). | ✓ | Hold policy ignores viewers (F28) |
| 9 | puppet 5/5, routes puppet test ✓. `zod` (F7). | Lists `app.ts` as modified, but it isn't (F26) | ✓ |
| 10 | Relay test red→green ✓. **Orchestrator test passes before any change** (F17). tsc ×5 (F9). | Edit target absent | F13 guards already built; F25 obligation missing (F16); P3-C6 (F18) |
| 11 | **13 of 15 scene tests fail**; 1 more after fixing seq (F4) | ✓ | — |
| 12a | **Part 2's `Stage.test` and `App.test` fail** in jsdom (F5). tsc ×1 (F9). | Breaks a Part 2 test file it doesn't list | Drops the seed/re-ticket (F2) |
| 12b | No new tests. Keycap leak (F20). | Must also touch Part 2's `Stage.test.tsx` (tsc, F9) | Same as 12a |
| 13 | session-view ✓. New App test fails until F5 is fixed (then 5/5). Lint ×2 (F10). | `lib/api.ts`, `useNowMs.ts`, `packages/stage` not in Files (F26) | ✓ `hudFor`/`openSocket` shapes |
| 14 | oracle-check 5/5, oracle 4/4 ✓. tsc: `Omit` union (F9). | ✓ | Oracle flash clicks in kiosk (F12) |
| 15 | e2e not run | ✓ | Pauses the first desktop (F14) |

## Findings

### Critical

**F1 — Task 3 rewrites desktopd's `app.ts`/`main.ts` from Part 2's pre-fix plan text. This undoes the
committed "not ready" semantics and the xfconf guard. Task 6 repeats it.**
(Plan 2477–2563, 2626–2685, 2692, 4878–4891.)
- **Part 2, committed** (123f443; ledger 165, 181, 198):
  - `readXsettings(): Promise<Xsettings | null>` — "null until the session's settings can be read without
    disturbing its start";
  - `hidpiReport(scale, x: Xsettings | null)` — "Unknown settings (null) are never ok";
  - `main.ts`: `readXsettings: () => readXsettings(uid)`.
- **Part 3:**
  - 2502 `readXsettings(): Promise<Xsettings>;`
  - 2529 `hidpiReport(scale: Scale, x: Xsettings)`
  - 2673 `readXsettings,` with no uid;
  - 4878 `const scaling = async () => (await readXsettings()).windowScalingFactor ?? 1;`
- **Evidence:**
  - Vitest: committed `app.test.ts` "reports not ready … unknown" gets **500** instead of 200;
    `xsettings.test.ts` "a failed read is never ok at 1x" throws `TypeError … reading 'windowScalingFactor'`.
  - tsc: `main.ts(52)` `(uid: number, run?: Run) => Promise<Xsettings | null>` is not assignable to
    `() => Promise<Xsettings>`; `main.ts(47)` errors TS2531 and TS2554.
  - Forced through, `pgrep -u undefined` fails, so `/healthz` never reaches `ok: true` and cells never become ready.
- **Fix.** Task 3 *edits* the committed `app.ts`: add the routes and the deps, keep the health code and its
  types. `main.ts` keeps `uid` and passes `readXsettings: () => readXsettings(uid)`. Task 6's `readScaling`
  uses `(await readXsettings(uid))?.windowScalingFactor ?? deps.scale`. The expected count is "12 + new".

**F2 — Tasks 5, 12a and 12b replace the stage's video path and drop S8's mandated seed and re-ticketing.**
(Plan 3660–3737, 8153–8168, 8196–8207, 8387–8531 (8522), 8557–8645 (8628–8632), 8647–8727 (8691–8700),
9036–9163 (9124–9128), 9165–9269 (9219–9228).)
- **Ledger CARRY → Task 14** (progress.md 155–160):
  - "(a) seed the stage at tap time from the iframe `<video>` (`new VideoFrame(video)`, transferred) through
    `FrameSource.first` → `pumpFrames`; pumpFrames closes `first` in a finally";
  - "(b) re-mint the ticket and remount the iframe on daemon-socket reconnect, and after 10 s without a
    reachable `#videoStream`";
  - "(c) delete stale `…_cells_<id>_desktop_*` localStorage keys".
  - S8: "Task 14 must seed the stage from the `<video>`'s current frame, or it stays black after every connect."
- **Part 3:**
  - `{ type: "frames"; readable: ReadableStream<VideoFrame> }` (8199);
  - `pumpFrames(m.readable, probing(presenter), …)` (8522);
  - `attach` posts only `readable` (8631, 9127);
  - `Stage` mints only on `[api, cellId, ready, support.ok]` (8700, 9228);
  - "replace the whole file" ×4.
- **Effects:**
  - the stage stays black after connect on a still screen;
  - the un-transferred `first` frame (~12 MB) is never closed;
  - Task 12a's pump change ("the loop no longer closes the frame") collides with the CARRY's `pumpFrames`
    (Task 14 is not built yet), which presents `first` and then closes it while the PixiPresenter still
    holds it as `#pending`;
  - the calibration (3981) and the oracle (10766) wait for `data-frames > 0` right after connect on a still
    screen and would time out, or pass only on the minute's clock repaint.
- **Fix:**
  - Tasks 5, 12a and 12b edit Part 2's built files rather than replacing them;
  - `WorkerIn.frames` gains `first?`, and `attach` transfers it;
  - the worker passes `{ first: m.first }`;
  - the pump hands `first` to the presenter, which owns it, and closes it only on a throw;
  - Stage keeps Part 2's re-ticket, remount and storage cleanup.

**F3 — Every calibration command in the plan is misparsed. The 1× and driver rows are never measured, and
the "record only" control overwrites `~/.localdot/calibration.json`.**
(Plan 3557, 3921, 3924–3925, 4057–4058, 4071, 5535–5536, 11029.)
- pnpm 10.29.3 forwards a literal `--`. A probe printed `["--","--scale","1","--trials","500"]`. The
  parser pairs argv from index 2 (`args.set(argv[i].replace(/^--/,""), argv[i+1])`).
- I fed it the plan's own lines:

  | Command | Parsed as |
  |---|---|
  | `--scale 1` run | scale **2** |
  | `--injectors driver --kinds click` | `["xtest"]`, `["click","key"]` |
  | `--page up --out /tmp/calibrate-up.json` | page `down`, out = `<home>/calibration.json` |
  | No `--` | correct |

- So Task 5's 1× pass measures 2× again, Task 7's driver pass measures xtest again, and the release-acting
  control writes a fresh down-page table into the real file.
- **Fix.** Drop the `--` from all six invocations and the README; Part 2's ruling F9 dropped it from
  `test:docker`. Also make the parser skip a leading `--` and refuse unknown or odd arguments.

**F4 — Task 11's scene tests fail as written: 13 of 15, then one more after the obvious fix.**
(Plan 7267–7277, 7271–7275, 7515–7518, 7499–7507, 7739–7744, 7419–7425.)
- **First cause: fixture order.** The module-level events take low `seq` numbers (`intent`, `target`,
  `dispatch` and `result` at 7272–7275, and `typeIntent`/`typeDispatch` at 7371–7372). Each test then calls
  `base()`, which mints higher ones. `foldEvents` skips `e.seq <= model.lastSeq` (7517), so the actions are
  dropped, and the failures read like "expected null to match object { x: 100, y: 100, visible: true }".
- **Second cause: the model keeps only the latest agent state.** With the log renumbered in order, 14 of 15
  pass. "lights control while the agent acts…" still fails: `controlAt` reads `model.agentState`, the latest
  one (`done` at 2300), so `s.t > t` makes control false at t = 1500. `render(log, t, view)` is therefore
  wrong for any `t` before the last `agent.state`, which breaks the determinism and replay contract (§4.1.8).
- **Fix:** build each test's log in order (factories, or renumber `seq` by index), and keep an `agent.state`
  history in the model, looked up at `t`.

**F5 — Task 12a's `Stage` crashes in jsdom. It breaks Part 2's ruled `Stage.test` (F17) and every Theatre
test.** (Plan 8671, 8677–8678, 9199, 9205–9206, 8063.)
- During render, `useState(() => reducedMotionQuery().matches)` throws "window.matchMedia is not a function".
- `readTheme(getComputedStyle(document.documentElement))` throws `unsupported CSS colour ""`, because jsdom
  loads no theme.css.
- Failing tests:
  - Part 2's `Stage.test` "says a Chromium browser is needed…";
  - `App.test` ×2, plus Task 13's new test.
- With both stubbed, App and Stage go 5/5.
- **Fix.** Read the theme and the motion query only on the supported path. Split `Stage` into a support gate
  plus a `LiveStage` that holds the hooks, or guard with `window.matchMedia?.` and a token fallback.

**F6 — Task 6b's proxy can never see traffic: an in-process server reached while the thread is blocked.**
(Plan 5043–5052, 5055–5065, 5071–5082.)
- `runDriver` is synchronous: `docker()`/`dockerExecAs` → spawnSync, then `sleepSync(5000)`. The CONNECT
  logger lives in the test's own event loop, and `connects` is read in the same synchronous turn.
- The proxy's `data` handler cannot run before the assertion. The control always fails, and the opt-out test
  passes vacuously. The plan's fallback would then record a false "method can't confirm".
- Ledger, Task 1: "the brief's in-process listener deadlocks against spawnSync … plan fixer as F31".
- **Fix.** Run the proxy in a worker thread or a child process (as Task 1's keyd listener does), or make
  `runDriver` async (`execFile` promise plus an awaited delay) before reading `connects`.

**F7 — `zod` is not a dependency of `apps/daemon`.** (Plan 3326–3327, 3512–3513, 6484–6485.)
- `onset-table.ts` (T4) and `puppet/script.ts` (T9) `import { z } from "zod"`. Task 4 adds only
  `@localdot/stage` and `@localdot/providers`.
- Under pnpm's isolated `node_modules`, Vitest reports "Cannot find package 'zod' imported from …/onset-table.ts"
  (and the same for `script.ts`). tsc reports TS2307 ×2.
- **Fix:** Task 4 adds `"zod": "4.6.5"` to `apps/daemon` dependencies.

**F8 — Four unit tests fail as written on fixture or contract bugs.**
- **(a) Task 3 `input.test`.** "arms, activates…" expects `res.armedMono < 500`, but the scripted helper starts
  `let mono = 1000` (1907), so `arm` returns 1001 while the press is stamped 500 (1957, 1965). Actual: "expected
  1001 to be less than 500". **Fix:** `let mono = 100`.
- **(b) Task 4 `FakeDesktopd`.**
  - The default `/input` reply, `{ pressMono: this.mono(), presses: [this.mono()], …, armedMono: this.mono() - 1 }`
    (2841), arms **after** the press.
  - `routes.test` asserts `armedDaemonMicros < pressDaemonMicros` (3056). Actual: "expected 8537 to be less than 7537".
  - **Fix:** take `armed` first, then `press`.
- **(c) Task 6 `observe.ts`.** `windowInfo` calls `clipText` (4786), but the import at 4756 lacks it. The
  result is `ReferenceError: clipText is not defined` (and tsc TS2304 ×2). **Fix:** import `clipText`.
- **(d) Task 8 `gateway.test`.**
  - "truncates a 300-character name" (5931–5948) feeds desktopd replies longer than the schema allows.
    `DesktopdClient.find/hitTest` parse with `HitTestResult` (1840–1844, `Target.name` max 64), so `find`
    throws and the step is cancelled with preflight; there is no intent.
  - With a lenient parse, all 12 tests pass.
  - **Fix:** give the wire schema an unbounded wire target (desktopd clips at the source and the gateway's
    `clipTarget` enforces the event limits, Review Focus 3), or make the fake return in-limit values and keep
    truncation in `text.test`.

**F9 — `pnpm typecheck` fails at the commit gates of Tasks 3, 4, 5, 6, 7, 8, 10, 12a, 12b and 14.** These are
in addition to F1 and F7. The tsc 7.0.2 errors:

| Task | Plan line | Error | Fix |
|---|---|---|---|
| 3 | 2592 | `/type`: `(p) => out.write(…)` is `Promise<StreamingApi>`, not `void \| Promise<void>` | `async (p) => { await out.write(…); }` |
| 3 | 2039, 2049, 2067 | `(p) => progress.push(p)` returns number, not `void \| Promise<void>` | block bodies |
| 4 | 2884 | `RequestInfo` unknown (TS2552, no DOM lib) | `string \| URL \| Request` |
| 4 | 3463 | `c.text(msg, <number>)`: no overload (TS2769) | cast to `ContentfulStatusCode` |
| 4 | 3065 | spread of `never` (TS2698) | `as CellSummary` |
| 5 | 3982, 3998, 4004, 4006–4007 | `window.__localdot` missing in `tsc -p e2e` (the augmentation lives in `src/stage/Stage.tsx`) | cast as the oracle spec does, or add an e2e `declare global` |
| 6 | 4891 | the perception getter widens `scale` to `number` (TS2322) | `const scale: 1 \| 2` |
| 7 | 5380–5382 | `.catch(() => ({ node: {} }))` union has no `attributes` (TS2339, TS7006 ×2) | `{ node: {} as { attributes?: string[] } }` |
| 8 | 6043, 6051 | `?.data.ringAt - …` possibly undefined (TS2532 ×2) | `?? 0` / guard |
| 10 | 7156–7165 | `client` possibly undefined ×5 (P2 relay declares `let client: WebSocket \| undefined`) | early `if (!client …) return` and capture it |
| 12a | 8090 | `cursorPolygon(1)[3] * 2` (TS2532, noUncheckedIndexedAccess) | `?? 0` |
| 12b | 9201 | Part 2's `Stage.test.tsx` renders `<Stage>` without `control` (TS2741) | add `control={false}` there (and list the file), or make it optional |
| 14 | 9054/9190 + 10652, 10655 | `Omit<OracleCommand,"id">` on a union drops `zooms`/`tMs` (TS2353 ×2) | a distributive omit, e.g. `OracleCommand extends infer C ? C extends unknown ? Omit<C,"id"> : never : never` |

**F10 — `pnpm lint` fails on more than log 4 listed.**

| Plan line | Rule | Note |
|---|---|---|
| 3569–3578 `flash.html` | parse error ("Expected a closing tag"), `noNoninteractiveTabindex` | Biome 2.5.15 lints HTML; add `</body></html>`, drop `tabindex`, focus the page another way |
| 5447–5449 `marker.html` | `useButtonType` ×3 | `type="button"` |
| 4174 `text.ts` | `noControlCharactersInRegex` ×2 | `/\p{Cc}+/gu` |
| 5330 `cdp.ts` | `noUnsafeDeclarationMerging` | rename the interface or the class |
| 2099 `launch.test.ts` | `noUnsafeOptionalChaining` | `seen[0]?.opts.env` → non-optional after an `expect` |
| 1912–1913, 2033; 2392, 2394, 2398 | `noAssignInExpressions` ×6 | pre-increment in a statement |
| 4036 `calibrate.ts` | `noAssignInExpressions` ×2 | split the `??=` chain |
| 9721 `StepRow.tsx` | `useAriaPropsSupportedByRole` (aria-label on span) | `role="img"` |
| 9800–9802 `useNowMs.ts` | `useExhaustiveDependencies` (`version`) | restructure, or a justified ignore |
| 1530–1531 | import order (new block; log 4 lacked it) | `desktop-container` sorts before `docker-cli` |

- Warnings: `cell` unused (1534), `req` unused (5166), `useOptionalChain` ×3 (7841, 7853, 7871).
- Log 4's 15 import blocks and the `tick()` errors are reconfirmed.
- **Fix, for all import orders:** add Part 2's F5 Global Constraint to Part 3: fix organizeImports with
  `pnpm exec biome check --write <files>`.

### Important

**F11 — P3-C15 is not in the plan at all.** The plan text never mentions vblank, compositor, XPresent, tearing
or P3-C15. The ruling, as amended: "Part 3's first task shrinks to verifying that, plus a tearing check on a
motion capture … The calibration gate still validates the harness with the compositor off (S6 conditions), and
the onset table is calibrated with the production config (vsync off)." Here is exactly where the text must
change:

1. **Insert a new first task**, before 197–198: "Task 0: Low-latency compositing — verify vsync off and check
   tearing". It holds these steps:
   - **(a) Probe the setting.** Re-run Part 2's probe ("composites without vsync", `desktop-image.docker.test.ts:330`,
     `/general/vblank_mode` = `off`). Then check the running mode behaviourally: S8's harness
     (`spikes/s8-hosted-client/latency-send.mjs` + `recorder.js`) on S6's flash page in a **normal** window
     should give send→frame p50 ≈ 25 ms (vsync off), not ≈ 46–51 (XPresent).
   - **(b) Tearing check.** Run a motion page, for example a full-height high-contrast bar moving 16 px per
     rAF, in a normal maximized window. Capture decoded frames from the stage tap, at 2× and 1×, and flag any
     frame whose bar position differs between rows (a tear line).
   - **(c) Decide.** No tearing: keep `off`. Tearing: set `vblank_mode` `xpresent` in
     `cells/desktop/root/defaults/localdot/xfwm4.xml.in`, update Part 2's probe, rebuild, and accept the latency.
   - **(d) Record** it in `docs/measurements/2026-10-compositor.md`.
   - Add that file, and the motion page if it lives in the image, to the File map (164–195). Mention the task
     in Goal/Architecture (5–23) and "This is Part 3" (45–48).
2. **Task 5 intro (3530–3537) and Interfaces (3553–3558):**
   - The S6 gate runs with xfwm4's compositor **off**, toggled live in the cell:
     `xfconf-query -c xfwm4 -p /general/use_compositing -s false` through Part 2's `desktopContainer(cellId)`.
   - The table run uses the production config: compositor on, the Task 0 vsync mode.
   - The CLI gains a `--compositor off|on` switch; only `on` writes `onsetMs`.
3. **`calibrate.ts`** — in 3975, 4020–4026 and 4031–4041, gate only the `off` pass against S6, and write the
   table only from the `on` pass, in a normal window (F12).
4. **Step 4 (4053–4071):**
   - commands for both passes, with no `--` (F3);
   - expected lines per pass;
   - in the troubleshooting text (4063–4067), P3-C15's note: "if the compositor-off pass misses S6 by more than
     ±3 ms, re-baseline the gate with S6's own script run on the current image; don't loosen the tolerance."
5. **The measurement template (4074–4099)** gets a gate block (compositor off) and a table block (production).
6. **Task 7 Step 3 (5532–5539)**: the same two passes for the driver rows.
7. **P3-R5 (11167–11171)** must state the gate/table split. Update the Tech Stack line (25–31) if a motion
   page or script is added.

**F12 — The calibration and the oracle run Chromium `--kiosk`, which the image's compositor bypasses.**
- The committed `xfwm4.xml.in` has `<property name="unredirect_overlays" type="bool" value="true"/>`.
- S8: "S6's flash page in a normal window (`unredirect_overlays` is on, so fullscreen would bypass the compositor)".
- Calibration (3975) and the oracle's flash clicks (6962) use `--kiosk`. The table, and check 3 of the oracle,
  therefore measure the uncomposited path (S8: p50 21 against 25 ms), not the maximized composited windows
  users see. That conflicts with P3-C15's "the table must match what users see".
- **Fix.** Open the flash page with `--new-window` (maximized by the wrapper) for the production pass and in
  `oracle.json`. Give it one untimed click so it holds focus for key trials. Keep `--kiosk` only in the
  compositor-off gate pass.

**F13 — The dock launches Chromium without the wrapper.**
- The plan (1424–1426) claims "XDG looks in `/usr/local/share/applications` … so the menu and the dock use the
  wrapper too".
- The committed `localdot-plank` writes
  `Launcher=file:///usr/share/applications/%s.desktop` for `chromium`.
- So a dock launch gets no `--remote-debugging-port=9222` and no `--force-renderer-accessibility`. Because
  Chromium is single-instance, later `localdot-chromium` launches join that instance and their flags are ignored.
  CDP perception (Task 7) then fails for the whole session.
- The Docker test (1647) only greps the file.
- **Fix.** Task 2 also edits `localdot-plank` to point at `/usr/local/share/applications/chromium.desktop`, and
  adds a probe of the dockitem.

**F14 — Task 15 pauses whichever desktop container comes first.**
- Plan 10969: `docker ps --filter label=localdot.role=desktop … .split("\n")[0]`. This can pause the user's own
  cell, against Part 2's ruling F10 (ledger 21).
- Part 2's `e2e/daemon.ts` exports `desktopContainer(cellId)`, which filters on `localdot.cell=<id>`.
- **Fix:** `execFileSync("docker", ["pause", desktopContainer(cell.id)])`.

**F15 — `pnpm test:docker -- <file>` runs every Docker suite.**
- Plan 1654, 2751, 4998, 5089 and 5529.
- With `--`, Vitest reports "Test Files 7 skipped (7), Tests 43 skipped" (all files); without it, "1 file, 8 tests".
- This is Part 2's ruling F9 again ("drop the `--` from every `pnpm test:docker -- <file>`").
- **Fix:** drop the `--`.

**F16 — Part 2's F25 obligation is not carried by any task.**
- Part 2's "Part 3 obligations" (Part 2 plan 9109–9112): "A wedged Docker socket hangs daemon startup … Give each
  request an `AbortSignal` timeout and reconcile in the background". Ledger 36 records the same.
- Task 10 ("Part 2's daemon obligations", 7013–7020) covers only the watch loop and backpressure.
- **Fix:** add a Task 10 step for the request timeout plus a non-blocking `reconcile()` in `main.ts`, with a test.

**F17 — Task 10's first half is obsolete against the built orchestrator.**
- The ledger (64): "the double-#watch obligation removed, F13's guards close it".
- The committed a2531c0 has `#current(record.id, restarting)` guards. The plan's replace target,
  `if (this.#live.get(record.id)?.state !== "starting") return;`, does not exist.
- Task 10's new test **passes unchanged on both a2531c0 and bfd71bb** (bfd71bb also queues each cell's
  start, stop and remove), so the stated red run ("Expected: FAIL", 7108–7110) cannot happen. Adding a
  generation counter would duplicate the guards.
- **Fix.** Keep the test as a regression pin and drop the counter, P3-R14 (11199–11200) and the "Expected: FAIL" claim.

**F18 — P3-C6 is checked at the daemon but not at Selkies, and the plan does not say so.**
- Part 2's `relay()` dials one upstream per viewer (Part 2 plan 6305–6330), so the ruling's condition holds.
- The plan (7013–7020, P3-R13) never cites P3-C6, and nothing verifies its purpose: "pausing one slow viewer
  never stalls another viewer". Selkies' own fan-out to its WebSocket clients is untested (S8 used one viewer).
- **Fix.** Add a two-viewer check: pause one viewer's socket and assert the other's `data-frames` keep rising, in
  an e2e or Docker test. If it fails, shed with a keyframe request.

**F19 — desktopd's bundle ships 15 more third-party packages without their notices.**
- With Part 3, the esbuild metafile lists:
  - **hono:** `@hono/node-server`, `hono`;
  - **Part 3's new direct dependencies:** `@modelcontextprotocol/sdk`, `zod`, `ws`;
  - **pulled in by the MCP SDK:** `ajv`, `ajv-formats`, `fast-deep-equal`, `fast-uri` (BSD-3), `json-schema-traverse`,
    `zod-to-json-schema`;
  - **pulled in by `cross-spawn`:** `cross-spawn`, `isexe`, `which` (ISC), `path-key`, `shebang-command`, `shebang-regex`.
- The bundle is 1.48 MB.
- `build.mjs`'s banner carries only `hono` and `@hono/node-server` (Part 2 Task 5 ruling: "MIT notices in the
  bundle header and THIRD-PARTY.md").
- `build.mjs` is in the File map (176), but no task edits it.
- **Fix:** Task 6 extends the notice list, the banner and `THIRD-PARTY.md`.

**F20 — The keycap overlay leaks Pixi objects every frame.**
- `#drawKeycaps` (8999–9018) runs `removeChildren()` and builds new `Chip`s, each a Graphics plus a Text texture,
  on every rAF while keycaps show. That is about 120 frames per combo, never destroyed, so GPU memory grows
  with every shortcut.
- **Fix:** cache chips by label, or destroy the removed children.

**F21 — Docker probes check output without checking the exit status.** Part 2 Task 2 ruling (ledger 84): "each
probe whose output is checked also asserts its EXPECTED exit status".
- `dockerExec(C,"node",…).out` (1565);
- `execAsDesktopUser(… xfconf-query …).out` (1636);
- `curl -sf … /json/version` `.out` (1646);
- `cat /tmp/typed.txt` (1619) and `cat /tmp/http.txt` (2737);
- `identify … .out` (4960);
- the AT-SPI python probe (4988–4991);
- `convert … info:` (5471);
- `windowGeometry`'s `xdotool` calls (1514–1516).
- **Fix:** assert `.status` first, then the output.

### Minor

- **F22.** Task 1's "keeps observe frames out of the log" test rejects only because `"frame-1"` isn't a ULID. A
  valid frameId with `image` parses, and zod strips the image (verified). **Fix:** assert the strip, or
  `.strict()` (278–292).
- **F23.** Task 6b's `expect(out).toContain("list_windows")` (5080) doesn't prove a successful call. **Fix:**
  assert the id-2 response has `result`.
- **F24. Stale counts and outputs:**
  - Task 3 "Part 2's 5" desktopd tests: there are 12 (2692);
  - Task 7 "5 tests" for two files holding 11 (5429–5430);
  - Task 1 "add four tests" is 1 replaced + 3 (245–246);
  - the 12a worker chunk is "about 1.4 MB" but measured 463 kB plus lazy Pixi chunks (8738);
  - the mapping fixture uses a 26 px 1× panel, where the built one is 27 (4199).
- **F25.** Revision log 4 checked Playwright 1.61.1 and sharp 0.35.4. The plan pins 1.63.0 and 0.35.5 (27);
  this scan used the pins.
- **F26. Files and the File map drift:**
  - `desktopd/registry.ts`, `web/src/lib/api.ts` and `useNowMs.ts` are missing from the File map or Files;
  - the Task 6 `cdp.ts` stub is not in Create;
  - Task 9 lists `app.ts` but doesn't change it;
  - Task 13's Files omit `packages/stage`;
  - the Task 2 `.dockerignore` "replace" is a no-op;
  - `build.mjs` is listed but never touched;
  - Task 12a/12b also need Part 2's `Stage.test.tsx`.
- **F27.** Task 1's Interfaces omit `TARGET_IN_MS` and `CANCEL_SHAKE_MS` (225–230).
- **F28.** `holding()` ignores `viewers` (6143). A stale `disconnected` with 0 viewers, left when the upstream
  drops and the tab closes before the client reloads, holds dispatch until Stop. That contradicts Review Focus 1's
  "never hold when nobody watches". **Fix:** hold only while `viewers > 0`.
- **F29.** Stop doesn't reach an in-flight `/type`: `DesktopdClient.type` takes no signal (3162, 6276), so a long
  Watch-paced string finishes typing after Stop.
- **F30.** `#lastFrame` is one instance field (6306) shared by concurrent actions, so the wrong `frameId` is
  possible. **Fix:** return it from `#finish`.
- **F31.** `findTarget` (4689–4709) doesn't skip the panel, dock or desktop windows (P3-R28 covers only
  `windowUnder`). It also walks every window's tree (each up to 2.5 s) inside the client's 5 s `find` timeout.
- **F32.** The `LaunchApp` allow-list regex (2355) accepts `..` segments under `/config` and `/opt/localdot`.
- **F33.** The X helper:
  - announces XI 2.0: python-xlib 0.33 `query_version` sends 2.0. XI2proto says "Clients supporting XI 2.0 receive
    raw events when the device is not grabbed…";
  - selects `AllDevices` (873–879), so every press arrives twice (slave and master);
  - so `withPress(count > 1)` counts duplicates: combos time from the first key, and double-click `presses` repeat
    the first click.
  - S6's listener was `xinput test-xi2`, which is XI 2.2.
  - **Fix:** send XIQueryVersion 2.2 and keep only `deviceid == sourceid`.
- **F34.** `startDesktopContainer` waits for `curl -sf /healthz` (1501), which succeeds on Part 2's "not ready"
  200. It should require `ok: true`.
- **F35. Recovery gaps:**
  - after an xhelper `fatal`, desktopd marks it dead but never kills it, and `ensureHelper` spawns another
    (1341–1344, 2648–2665);
  - `CdpSession`s are never evicted when closed (5347–5355);
  - `ClockMap.start` swallows sync errors (3261);
  - the registry never forgets removed cells (3294–3313).
- **F36.** Theatre: the crosshair's xenon fill isn't gated by `control` (8911). `WorkerOut.warn` is declared and
  handled but never posted; the presenter only `console.warn`s (8212, 8303).
- **F37.** P3-C2: calibrate's in-page µs math (3958–3960) is avoidable. **Fix:** return raw ms and convert with
  `msToMicros` in Node.
- **F38. Spec and §4 gaps:**
  - §4.5's "max blocking presentation" (Watch 800 ms, Fast 350 ms) against lead + travel + dwell of up to 910 and
    455 ms;
  - the idle float only while thinking (§4.5: after 1.2 s idle);
  - keycaps without the 20 px rise;
  - the target chip uses `.slice(0,32)` against P3-R24 (7833);
  - the W floor of 16 isn't scaled to device px (6211).
- **F39. Duplication:**
  - two `DECOR` sets (4614, 4809);
  - two key-name maps (5717, 7635);
  - two finite-guards (332–335, 538–541);
  - two `FrameStore`s in `main.ts` (6853, 6857).
- **F40.** Task 15's pause path takes about 5.3 s against the 6 s wait (10968–10974). Step rows vanish 5 s after
  `session.end` (9592–9595), so `13-done.png` may miss them.
- **F41.** Oracle check 5 asserts zero xenon-like pixels (±6) in lossy WebPs of a desktop with blue WhiteSur
  icons (10874–10882). It's brittle; compare against the nearest no-overlay baseline, or bound the count.
- **F42.** The `received` comment (3695, 8428) assumes Selkies' page clock. The client runs in an iframe with its
  own `timeOrigin`, and seeded frames carry the video's time, so `Flip.received` is not comparable. It is unused.
- **F43.** Task 6's `copyIntoDesktop` append puts an `import` at the end of `desktop-container.ts` (4899–4905).
  It's valid ESM but odd; move it to the top.

## Appendix A — tool output

**tsc 7.0.2, end state (zod added to isolate the other errors):**
- daemon: `stream-proxy.ts` ×5, `fake-desktopd.ts`, `gateway.test.ts` ×2, `routes.test.ts`, `routes.ts`.
- desktopd: `app.test.ts:103`, `app.ts:119`, `input.test.ts` ×3, `main.ts` ×4, `cdp.ts` ×3, `observe.ts` ×2,
  `xsettings.test.ts:95`.
- web: `Stage.test.tsx`, `Stage.tsx` ×2, `geometry.test.ts`.
- web/e2e: `calibrate.ts` ×5.
- Without zod: `onset-table.ts` and `script.ts` fail with TS2307.

**Biome 2.5.15, after `format --write`:** 40 errors and 8 warnings. My hand-assembled `main.ts`, `App.tsx`,
`routes.test.ts` and the two `index.ts` export blocks are excluded from F10.

**Vitest 5.0.3:** 385 tests, 23 failed, in nine files:
- `scene.test` 13;
- `App.test` 3;
- `Stage.test` 1;
- `gateway.test` 1;
- `routes.test` 1;
- desktopd `app.test` 1;
- `xsettings.test` 1;
- `input.test` 1;
- `observe.test` 1.

Two more suites fail without zod.

**Builds:**
- vite 8.3.1: `dist/assets/render-worker-*.js` 463 kB, plus Pixi's lazy `webworkerAll`/`init` chunks. Built.
- desktopd esbuild: 1.48 MB, 17 packages.

**Probes:**
- `py_compile xhelper.py` passes.
- The python-xlib 0.33 calls (`ge_add_event_data`, `xinput_select_events`, `damage_create`/`damage_subtract`,
  `xtest_fake_input`, `get_extension_major`) exist with the signatures the helper uses.
- pnpm `--` is forwarded to scripts.
- Vitest with `--`: 7 files and 43 tests; without it, 1 file and 8 tests.

## Appendix B — experiments in the scratch copy

- **Scene fixture:** renumbering `seq` in log order took the file from 2/15 to 14/15. The one left is
  `controlAt`'s history (F4).
- **Gateway:** a lenient `HitTestResult` parse took it to 12/12 (F8d).
- **jsdom:** stubbing `matchMedia` and the 12 tokens took App and Stage to 5/5 (F5).
- **Relay backpressure:** with Part 2's relay restored, the test fails ("expected 0 to be greater than 0"); with
  Task 10's handler it passes.
- **Orchestrator:** Task 10's test passes on a2531c0 with no change (F17).
- **Observe schema:** with a valid frameId and an `image`, it parses and the image is stripped (F22).
