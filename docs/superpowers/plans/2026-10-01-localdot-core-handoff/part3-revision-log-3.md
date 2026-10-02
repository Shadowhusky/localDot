# Part 3 plan — revision 4 change log (controller ruling P3-C12; line numbers refer to the revised plan, 11,228 lines)

## Items

- P3-C12 — The oracle keeps its latest-frame clone (`#latest`) only while it is enabled, never in production.
  - Task 14 `OracleCapture.onFrame` (10474–10485) now starts with `if (!this.enabled) return;` (10480). While the oracle is off it neither clones nor keeps anything. While it is on, it closes the clone it replaces, keeps the new clone and crops it for the open windows, as before; `#lumaCrops` is now called without the `if (this.enabled)` guard (10484), because the early return already covers that. The comment states P3-C12 and the cost: about 12 MB at 2× I444, which can starve the decode frame pool (10474–10478).
  - `dispose()` is unchanged and still closes `#latest`. The `enable` case still keeps a kept frame; its comment now says a frame kept while already on stays (10557).
  - There is no disable path: `OracleCommand` has only enable, dump, template and render-twice. The clock note says so, and says a kept frame is closed only when the next one replaces it or on `dispose` (10593–10596). It also says `onFrame` returns at once while the oracle is off.
  - Every existing close guarantee is kept: the replaced clone is closed in `onFrame`, the crop copy in `#lumaCrops`' `finally`, and `#latest` on `dispose`. The frames themselves are never closed by the oracle.
- Task 12a `probing` keeps calling `oracle.onFrame(frame, at, presented)` for every frame, since the oracle itself checks whether it is enabled. The comment now says the oracle ignores frames while off and, only while on, keeps a clone of the newest (8438–8440). The skeleton prose says the same (8523–8526). The skeleton's code is unchanged.
- Task 14 unit tests (`oracle.test.ts`, still red first):
  - Intro (10189–10191) mentions that no frame is kept while the oracle is off.
  - Test 1 now enables the oracle before the still frame arrives (10249–10252). Its comment says the oracle is on before the screen's last frame (900 ms) arrives. Every assertion is unchanged.
  - Test 2 is renamed "keeps one clone of the newest frame while on, closing the one it replaces and on dispose" (10275–10292). It is now async, enables the oracle first with `emptyModel()`, and also asserts `b.clones` has length 1. Its last comment now says "with no window open nothing is cropped".
  - New test 3, "keeps no clone while the oracle is off" (10294–10325).
  - The red-run expectation now says all 3 tests fail and why (10329–10331).
  - The Step 2 Run expects 3 + 5 tests (10614).
- e2e check 3 comment (10795–10801): explains that `baseline > 0` still holds under P3-C12. The oracle is on before the puppet starts, and the script's first step (the kiosk launch) repaints the screen before any window opens. The assertion is unchanged.
- Prose:
  - Task 14 intro (9965–9972): the clone is kept while the oracle is on, never while it is off, in production (P3-C12, with the 12 MB / frame-pool reason).
  - Interfaces (9982): `onFrame` "while enabled keeps a clone of the newest, while off returns at once, P3-C12"; a new window's baseline comes from the kept frame "when one is kept".
  - P3-R15 (11148–11155, changed 11151–11153): the clone is kept only while the oracle is enabled (P3-C12); with the oracle off, in production, nothing is kept.
  - P3-R20 (11176–11188, changed 11179–11182): "that frame is kept only while the oracle is on, P3-C12 and P3-R29" (the next lines are reflowed only).
  - New P3-R29 "The oracle's kept frame (P3-C12)" (11220–11228), in the same format as P3-R25 to P3-R27. The Decisions heading now reads "P3-R1 to P3-R29" (11092).
  - Checked and left unchanged: the file map (188) and Task 14's Files list (9974–9978) only list `oracle.test.ts` and state no count or kept-frame behaviour. The Task 12a skeleton code and the worker's `stop`/`frames` → `dispose()` path are also unchanged.

## Hand-derived values for every test touched

- The cost figure: 2× is 2560 × 1600 = 4,096,000 px. I444 at 8 bits stores Y, U and V at full resolution, so 3 B/px gives 12,288,000 B ≈ 12 MB.
- Shared setup (unchanged from revision 3):
  - Clock {offsetMicros 0, originMicros 1e9}, so sessionMsAt(w) = microsToMs(msToMicros(w) + 0 − 1e9). Examples: wall(900) = 1_000_900 → 1_000_900_000 − 1_000_000_000 = 900_000 µs = 900 ms. wall(884) → 884, wall(1700) → 1700. All exact.
  - Window: arrival = 1120 + 400 = 1520, so from = 1420 and until = 1520 + 1500 = 3020 (no dispatch). The point is `plan.to` = (300, 400).
  - lumaRect((300, 400), 2560×1600) = {x max(0, min(2496, 268)) = 268, y max(0, min(1536, 368)) = 368, 64, 64}.
  - `#lumaCrops` returns before it clones when there is no clock or no region.
- oracle.test.ts test 1, "gives a window opened on a still screen one baseline crop from the newest frame" (enable moved first):
  - After `enable`: enabled true, frames [], `#opened` empty, `#latest` null.
  - onFrame(still, 900 ms, 7): there is nothing to close. still.clones[0] is kept. `#regions` is [] (no tick yet), so no crop and no second clone.
  - Tick 1400 < 1420: no window.
  - Tick 1450: the window opens and is not in `#opened`. It gets one crop of the kept clone through the copy still.clones[1]: {t 900, presented 7, actionId ID}, rect {268, 368, 64, 64}, bytes 4096 × 10. The copy is closed in `finally`.
  - Tick 1500: ID is already in `#opened`, so there is no crop. frames has length 1.
  - onFrame(lit, 1700 ms, 8): closes still.clones[0], keeps lit.clones[0] and crops it once through lit.clones[1]. Tick 1716 adds nothing. frames = [[900, 7], [1700, 8]].
  - still.clones = [kept clone, baseline copy]: length 2, each closed once. These are the same values as in revision 3.
- oracle.test.ts test 2, "keeps one clone of the newest frame while on, closing the one it replaces and on dispose" (now enabled):
  - The clock is null, so `#lumaCrops` returns at `!this.clock` and there are no crop copies.
  - a keeps a.clones[0]. When b arrives, a.clones[0] is closed (1 call) and b keeps b.clones[0]. So a.clones and b.clones each have length 1.
  - b.clones[0] gets 0 closes, then 1 after `dispose()`.
  - a.frame and b.frame are never closed (0 calls). frames = [].
- oracle.test.ts test 3, "keeps no clone while the oracle is off" (new):
  - Off: onFrame(early, 884 ms, 6) and onFrame(still, 900 ms, 7) return at once, so early.clones = [] and still.clones = [].
  - `enable`. Ticks 1450 and 1500: the window [1420, 3020] is open but `#latest` is null, so there is no crop and ID stays out of `#opened`. frames = [] and still.rects = [].
  - onFrame(lit, 1700 ms, 8): keeps lit.clones[0]. `#regions` is the window (set by tick 1500), so `#lumaCrops` crops once through lit.clones[1] and marks ID. frames = [[1700, 8]] and lit.rects = [{268, 368, 64, 64}].
  - Tick 1716: ID is in `#opened`, so there is no second crop and lit.rects keeps 1 entry.
  - lit.clones has length 2. [0] has 0 closes until `dispose()` and 1 after. [1] has 1 close (from `finally`).
- Red run against the Task 12a skeleton (`onFrame` and `dispose` are no-ops, there is no `frames` property, and `handle` sets `enabled`):
  - Test 1 fails at `expect(oracle.frames).toHaveLength(1)` because `frames` is undefined.
  - Test 2 fails at `expect(a.clones).toHaveLength(1)` because the length is 0.
  - Test 3 passes its two empty-clone checks and fails at `expect(oracle.frames).toEqual([])` because `frames` is undefined.
  - So all 3 fail.
- pixel-oracle.spec.ts check 3, `baseline > 0` under P3-C12:
  - The spec's order: `goto ?oracle=1` → "Live" → `data-frames > 0` → `enable([1, 2])` → `template()` → `runPuppet`. The `page.evaluate` of `enable` resolves only when the worker replies, because `StageCanvas.oracle` resolves on `oracle-reply`. So the oracle is on before the puppet's first event.
  - Step 1 of `oracle.json` is `launch` chromium `--kiosk` flash.html. The runner calls `client.launch` first. It then appends an `action.intent` with verb `wait` and no point, so `regionsAt` skips it and no window opens. Then it sleeps 8000 ms. The kiosk window repaints the whole screen, Selkies sends frames, and each one is kept.
  - The first click window opens at arrival − 100 ms, after that wait, with `#latest` set. The oracle never turns off, so every later window also opens with the newest frame kept. By revision 3's bound, each window opens ≥ 100 ms before pressT (Watch ≥ 190, Fast ≥ 145, Instant ≥ 160), so the baseline's t < pressT and baseline ≥ 1 for all five flash clicks and the marker-page clicks.
  - Unchanged by this ruling: a stream replacement (`frames`/`stop` → `dispose`) during the run on a still screen would drop the kept frame until the next frame. That was true before P3-C12.
