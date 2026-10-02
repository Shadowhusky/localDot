# Part 3 plan — revision 2 change log (line numbers refer to the revised plan, 10,971 lines)

## Critical
1. (P3-C2) `packages/protocol/src/time.ts` (`MICROS_PER_MS`, `microsToMs`, `msToMicros`, `msToSeconds`, `sessionMsOf`) + `time.test.ts` added to Task 1 (files 203–205, interfaces 225–230, test 295–316, code 322–353, index export 353); every listed site converts through it: clock-map.ts 3240–3256, clock-sync.ts 3840–3860 (+ new `SessionClock`/`sessionMsAt` 3846–3856, test 3870–3885), calibrate.ts 4001–4003 (page-side `viewerClock` keeps the two-line arithmetic with a comment, 3952–3956), ring-onset.ts 5633, gateway.ts 6206 and 6348, gateway tests 5868–5875/5905/5942, puppet-main.ts 6894, model.ts 7511 and 7517, scene.ts 7792, model/scene test fixtures 7196–7210 and 7233–7236, render-worker.ts `sessionNow` 8402–8405, oracle.ts `onFrame` 10237, pixel-oracle.spec.ts 10506 and 10587, session-view/StepRow seconds 9402/9440/9502; P3-R1 names it (10853–10861); Interfaces 10812–10813; file map 168; apps/web gains the `@localdot/protocol` dependency in Task 5 (4044–4046).
2. Task 6 hit-test fixtures: terminal listed first so `windowUnder` returns it for (600,400) (4505–4525); password frame `{x:10,y:40,w:100,h:20}` → device (20,80,200,40), asserted (4533–4542); a panel test added (4523–4531).
3. Task 8: `FakeDesktopd` tracks the last `/input` point as its pointer and `observe` echoes it (2823–2838, 2866), the first test asserts both the fake's pointer and `cursorOf` (5912–5916); the 80-char label expectation moved to a `find` click, a point click asserts `Click at (2, 2)`, the 64/256 clipping stays (5918–5941).
4. Task 11: cursor hidden at `2210 + 60_000 + 180`, still fading at +60_001 (7300–7308); the box sampled at 2300 with `toBeCloseTo(…, 3)` per field (7338–7350); typing pill: one rule `max(stop, last.t) + TYPING_HOLD_MS` in scene.ts (7845–7850) and both orders tested (7370–7386).
5. Task 14 band check: the arrow's footprint (`arrowRect` from the tick's `cursorInCrop`, `outsideRect`), the box edges and the crosshair's own pixels (`crosshairMask`) are excluded; band 11–21 CSS px × dpr; the scene-level `rings === 0` check stays (10538–10558; helpers 10117–10142, tests 10020–10036; `TickCapture.cursorInCrop` 9953–9972).
6. `PixiPresenter.extract(crop, layer, cam, scene)` sets the camera, redraws the scene, renders, restores the camera and the last scene (8313–8338); callers pass the scene (onTick 10225–10262, template/render-twice 10344–10364); `draw` records `#lastScene` (8305–8310).

## Important
7. (P3-C9) Driver fallback = clicks + `type_text`: `DriverInjector { click; type }`, `inject` refuses other kinds through the driver with `UnsupportedInputError` (501), `typeText` gains the driver path (2203–2232, 2272–2290; tests 2002–2025, 2055–2076; `/type` passes injectors 2602); `find.ts` injector rewritten (4790–4826); `CuaDriver.pressKey` removed (4440–4446, interfaces 4132–4134); onset table has no `driver.key` row, driver-typed text uses the click row (3340–3402, test 2976–2980); calibrate skips driver key and S6 loses the row (3930–3936, 3982–3986); measurements table (4084–4088); Task 7 Step 3 measures driver clicks only (5524–5533); Review Focus 96–99; obligations 10826–10829; P3-R25 (10952–10958).
8. `useLiveSession.clock()` uses `api.fetch` inside try/catch (9533–9545); `ApiClient` gains `fetch` beside `authorization()` (9466–9468); the App test counts `/api/clock` calls through its `fetchImpl` (9893–9906).
9. (P3-C10) Task 12 split: Task 12a (7948–8729: pure parts, protocol, `PixiPresenter`, overlay skeleton, worker loop, reduced `StageCanvas`/`Stage`, theme tokens, "see it draw") and Task 12b (8731–9265: the full `Overlays`, the handle methods, `Stage` forwardRef + rim, app.css); Task 6's opt-out proxy test became Task 6b (5003–5095), Task 6 Step 6 is perception only (4905–4994); cross-references updated (3654, 6992, 8508, 9285, 9951, 10365, 10835); P3-R26 (10960–10963).
10. The gateway test's `sleep` yields a macrotask after advancing the clock (5868–5875), so the hit test resolves before `/input` and `window: 77` is deterministic.
11. `ensureHelper` keeps one in-flight start promise (2641–2662).
12. `/usr/bin/python3` pinned in desktopd main.ts (2652), the Task 2 Docker exec (1553–1554) and the Task 6 AT-SPI check (4972).
13. Review Focus 4 now cites Task 12a's "builds the camera from the session screen, not the frame" (new geometry test 8097–8110) and "places a frame of another size…", and names `PixiPresenter.warned` (152–158).
14. Instant mode: a plan with `durationMs` 0 never travels; the cursor appears at the target and fades in over `INSTANT_FADE_MS` 150 (scene.ts 7622–7623, 7777–7797; test 7309–7318; P3-R18 10922–10926).
15. All five flash-page clicks labelled "Click the page (…)" (6955–6964); the press-acting check asserts a baseline and covers every one (10560–10566).
16. (P3-C11) `demo-multiapp.json` gains `{ "do": "wait", "ms": 6000, "label": "Wait for the sheet" }` after the typing step (6942); Task 15 waits for the HUD "Waiting for the sheet" before `docker pause` (10668–10678); P3-R27 (10964–10966).

## Minor
- `pct` is nearest-rank and `early` is gone (3937–3941, 3999).
- `CdpSession` keeps a persistent no-op `error` listener (5278–5281).
- Launch `ARGUMENT` allow-lists `--kiosk`, `--new-window`, `--incognito`, `about:blank` and the file paths; tests refuse `--remote-debugging-address`, `--proxy-server`, `--user-data-dir` (2351–2354, 2102–2110); P3-R11 (10894–10897).
- `Accessibility.enable` once per CDP session, scripted in both tests (5343–5347, 5195, 5213, 5207).
- `deviceScaleFactor` asked only for Chromium windows via `chromeScale` (4668–4681).
- Hotspot capture: a second 96 px crop around the drawn cursor with its `press`/`alpha`; the spec picks the latest unsquashed, opaque capture instead of a tick near `pressT` (oracle.ts 9953–9972, 10219–10262; spec 10512–10536). CROP 48→96 and the template 64 px with tip (16,10) so a DPR-2 arrow fits (10219–10226).
- 20 ms sleep after a keycode remap (1073–1077).
- Raw route stamps renamed `pressDaemonMicros`/`armedDaemonMicros` (2729–2731, 3053–3055, 3429–3433, 3894–3898, 4003).
- `windowInfo` clips with `clipText` (4778); P3-R24 (10951).
- Premultiplied-RGBA note at `extract` (8319–8321) and at the band check (10541–10543).
- CLI prints seconds through `msToSeconds(sessionMsOf(e))` (6894).
- `windowUnder` skips `Xfce4-panel`, `Plank`, `Xfdesktop` (4600–4607); the Task 2 windows test filters the same classes (1575–1588); P3-R28 (10967–10971).

## Also found while re-deriving
- Task 15/13 HUD expectations (`Opening calc`, `Clicking "Name Box"`) did not match the demo script's explicit labels; the two labels were dropped from `demo-multiapp.json` so the runner's and the gateway's default labels produce exactly those texts (6938–6939).
- Decisions heading now P3-R1 to P3-R28; Interfaces Part 4 lists `time.ts`, `sessionMsAt`, `DriverInjector`, `ApiClient.fetch` (10805, 10812–10817).
