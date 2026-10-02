# Part 3 plan — revision 3 change log (fixes for part3-review-2.md; line numbers refer to the revised plan, 11,170 lines)

## Items

- C1 — The worker keeps the newest frame for the oracle and every capture window starts with a baseline. Task 12a's `probing` (8420–8443) hands every frame to `oracle.onFrame(frame, at, presented)` (oracle on or off), with the probe keeping its own clone. Its `stop`/`frames` case calls `oracle.dispose()` (8509), and the skeleton gains `onFrame(): void` and `dispose()` (8522–8543). Task 14's `OracleCapture` (10419–10548) gains three fields: `#latest: KeptFrame`, which is cloned in `onFrame` and closes the clone it replaces (10434–10442) and closes on `dispose()` (10444–10447); `#opened`; and `#lumaCrops(kept, regions)`, which marks the windows synchronously and reads from its own clone, closed in `finally` (10449–10465). `onTick` gives each window it has not seen one baseline crop from `#latest` with that frame's own `t` and `presented` (10469–10472), before the `!scene` return. `enable` clears `#opened` and keeps the frame (10512–10521). The clock note covers `onFrame`/`dispose` (10550–10551). New unit test `oracle.test.ts`, run red first (10186–10292), and Step 2 Run now expects 2 + 5 tests (10569). Also: firstChange test gains a one-frame baseline case (10064–10065). Spec comment at check 3 (10750–10754) explains why the unconditional `baseline > 0` (10757) holds. Updated: Task 14 intro, Files and Interfaces (9962–9981); file map (188); P3-R15 (11101–11107); P3-R20 (11128–11139).
- I1 — `cross(60, 60)` (r 16.97, which is on the ring) replaced by `cross(58, 58)` (r 14.14) and `cross(64, 64)` (r 22.63), both false, with a comment (10050–10052). The test count stays 5.
- I2 — "Scene cursor on the dispatch point at the press" now uses only zoom-1 ticks with `arrival ≤ t < pressT`, where `arrival = pointer.startsAt + pointer.durationMs`. Both are session ms like the ticks, so there is no unit conversion; `pressT` already goes through `microsToMs`. When no tick falls in that window, the spec pushes a report line and skips the assertion (10712–10725). The Step 3 Expected text mentions the report line (10803–10806). I also applied the reviewer's optional note: cursor shots stay visible-only and are throttled per action and zoom to one every `SHOT_EVERY_MS` = 50 ms (constant 10361, `#lastShot` 10431–10432, check 10488–10491, cleared on enable 10519–10520). The interfaces (9980) and P3-R20 are updated to match. I used 50 ms rather than 16 because at a 60 Hz rAF ticks are already ≥ 16.7 ms apart, so a 16 ms throttle would never drop a shot.
- m1 — In the spec's zoom loop, `sharp` is renamed `sharpTick` (10702–10710).
- m2 — `import type { Injector, Input } from "@localdot/protocol"` in onset-table.ts (3326).
- m3 — `let clockCalls = 0` moved above `fetchImpl` in the App test (9907); no expected value changed.
- m4 — `received = performance.timeOrigin + microsToMs(frame.timestamp)` in both `probing()` wrappers (Task 5: 3663 import, 3696; Task 12a: 8388 import, 8424; Task 12a Consumes lists `microsToMs`, 7981). Carried with it: Task 5 Step 2 now adds the `@localdot/protocol` dependency (3656–3658), because both the Step 2 worker and `clock-sync.ts` import it before Step 3. Step 3 keeps only the `calibrate` script (4050–4051).
- m5 — The `DECOR_CLASSES` comment now says a point on the panel strut has no window, so `hitTest` returns a null target and the gateway keeps the crosshair (4611–4613).
- m6 — Task 9 Step 4 expected CLI line is now `… action.intent Click "Name Box"` (6998–6999).
- m7 — The vacuous last geometry assertion is replaced by three: the 1280×800 frame placed into the 2560×1600 session, the overlay at the same point, and a frame-built camera for contrast (8116–8120).
- m8 — The band crop is centred on the action point (`CROP_CENTRE`, `cropAt`; 10354–10368, used at 10477). The cursor shot keeps its tip at (32, 24) (`SHOT_TIP`). Comments at 10307–10310 and 10354–10357, the Interfaces (9980) and P3-R20 are updated to match.
- m9 — The `type_text` comment now says `withPress` awaits the driver call, so the single progress line follows the delivery, carrying the whole count and stamped with the first raw press (2284–2286). P3-R25 is aligned (11153–11156).

## Hand-derived values for every test touched

- geometry.test.ts "builds the camera from the session screen, not the frame" (m7, 8105–8121):
  - `cameraFor(1280×800 stage, 2560×1600 desktop, zoom 1)` gives base = min(1280/2560, 800/1600) = 0.5, so scale 0.5, shown 1280×800, tx = ty = (1280 − 1280)/2 = 0.
  - `videoPlacement({1280,800},{2560,1600})` = {sx 2, sy 2, mismatch true}.
  - `toCanvas(cam, (150·2, 200·2))` = (300·0.5, 400·0.5) = (150, 200).
  - `toCanvas(cam, (300, 400))` = (150, 200).
  - `cameraFor(1280×800 stage, 1280×800 desktop)` gives scale 1, tx = ty = 0, so (300, 400) maps to (300, 400).
  - All values are exact binary floats.
- oracle-check.test.ts "excludes the arrow's footprint and the crosshair's own pixels" (I1, 10038–10054). `crosshairMask(48, 48, 1)` is true on the ring (r ∈ [16.5, 19.5]), on the arms (|dx| ≤ 1.5 or |dy| ≤ 1.5, with r ∈ [13, 25]) and on the dot (r ≤ 3):
  - (66, 48): r = 18, on the ring → true.
  - (48, 26): r = 22, dx = 0, on an arm → true.
  - (58, 58): r = √200 = 14.14, |dx| = |dy| = 10 > 1.5 → false.
  - (64, 64): r = √512 = 22.63 > 19.5, |dx| = |dy| = 16 → false.
  - (49, 48): r = 1 ≤ 3 → true.
  - Unchanged rows re-checked: `arrowRect({40,40}, 2)` = {34, 34, 48, 58}, so (41, 60) is inside → false, (30, 40) has x < 34 → true, (40, 100) has y > 92 → true. `outsideRect({10,10,20,20}, 2)`: (5, 5) → true, (9, 20) → false, (33, 20) → true.
- oracle-check.test.ts firstChange (C1, 10057–10066):
  - [F0 (luma 10), F3 (luma 200, presented 103)] with baseline count 1: the mean is 10 and F3 differs by 190 > 8, so the result is presented 103.
  - The existing rows still give 103 (baseline 2) and undefined (one frame, baseline 1).
- oracle.test.ts test 1, "gives a window opened on a still screen one baseline crop from the newest frame" (C1):
  - Clock {offset 0, origin 1e9}: sessionMsAt(w) = microsToMs(round(w·1000) − 1e9). So wall(900) = 1_000_900 gives 900 and wall(1700) gives 1700, both exact.
  - Window: arrival 1120 + 400 = 1520, from 1420, until 1520 + 1500 = 3020 (no dispatch).
  - Tick at 1400: no window, no crop.
  - Tick at 1450: the window opens and gets one baseline from the frame kept while the oracle was off: {t 900, presented 7, actionId ID}. `lumaRect((300, 400), 2560×1600)` = {x max(0, min(2496, 268)) = 268, y max(0, min(1536, 368)) = 368, 64, 64}; the bytes are 4096 × 10.
  - Tick at 1500: nothing new, so frames has length 1.
  - The lit frame at 1700 (presented 8) arrives while the window is open and is cropped once in `onFrame`. The tick at 1716 adds nothing, so frames = [[900, 7], [1700, 8]].
  - still.clones = [kept clone, closed when the lit frame replaced it; baseline copy, closed after its crop]: length 2, each closed once.
- oracle.test.ts test 2, "keeps one clone of the newest frame, closing the one it replaces and on dispose" (C1):
  - a's kept clone (1) is closed when b arrives. b's kept clone stays open until `dispose()`, then is closed once.
  - The frames themselves are never closed by the oracle. The oracle is off, so frames = [].
  - Red run against the Task 12a skeleton: there is no `frames` property and no clones, so both tests fail.
- App.test.tsx "shows the session label…" (m3): declarations reordered only; same expectations.
- pixel-oracle.spec.ts (e2e):
  - C1, `baseline > 0`: a window opens at arrival − 100 ms. The press comes at arrival + dwell (Watch 90 ms, Fast 45 ms) or, for Instant (durationMs 0, so arrival = startsAt), at startsAt + 60 ms, plus dispatch latency. So every window opens ≥ 100 ms before pressT (Watch ≥ 190, Fast ≥ 145, Instant ≥ 160). Its baseline is the newest frame at the first tick in the window, so its t < pressT and baseline ≥ 1.
  - I2: for t ≥ startsAt + durationMs, `pointerAt` returns `plan.to` exactly (pointer-path.ts). Before the dispatch, `regionsAt`'s point is `target.point` or `plan.to`, the same point for point and find clicks; after it, the point is `input.at`, again the same. So cursorInCrop − expected = (0, 0) ≤ 0.5. The dwell window holds ≥ 90, 45 or 60 ms plus latency; when it holds no tick, the spec writes a report line instead.
  - m8: crop.x = round(c.x − 48), so expected ∈ [47.5, 48.5]. At DPR 2 the band is r ∈ [22, 42], spanning [5.5, 90.5] ⊂ [0, 95]; at DPR 1 it is r ∈ [11, 21], spanning [26.5, 69.5]. The whole band is in the crop. The cursor shot still puts the tip at (32, 24), so the template origin is (16, 14) ∈ [0, 32]².
  - Throttle: the first tick of each window always shoots (last = −∞). After that there is at most one shot per 50 ms per zoom. The qualifying window (press 0, alpha 1) lasts more than 1 s per click, so `sharpTick` exists at both zooms.
