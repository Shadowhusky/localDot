# Part 3 plan re-review 3: the 12 items, P3-C12/C13, fix-diff breakage, Instant baseline

Line numbers are in the current plan (`plans/2026-10-01-localdot-core-part3.md`, 11,228 lines) unless marked v2, Part 1 or Part 2.
Inputs read: the v2→current diff (all 37 hunks), part3-review-2.md, both revision logs, part3-rulings.md. Every value below was re-derived from the plan's code, not taken from the logs.

## 1. Item Verdicts (12)

- **C1: ADDRESSED.** The deterministic `baseline = 0` on a still screen is gone.
  - The worker hands every frame to `oracle.onFrame` (8438–8440), and `stop`/`frames` call `oracle.dispose()` (8506–8510).
  - While enabled, `OracleCapture` keeps one clone in `#latest` (10468, 10479–10485). `dispose` closes it (10487–10490).
  - `onTick` gives each newly opened window one baseline crop of the kept frame, with that frame's own `t`/`presented` (10495–10508, 10513–10514). `enable` keeps the frame and clears `#opened` (10556–10564).
  - The kept frame exists in the spec's run: `enable` (10718) precedes `runPuppet` (10722), and the kiosk launch (6962) repaints after that. Pinned by `oracle.test.ts` (10245–10325) and the one-baseline `firstChange` case (10067–10068).
  - Residual timing risk for the Instant click only: see §4.
- **I1: ADDRESSED.** The test now uses `cross(58, 58)` and `cross(64, 64)` (10054–10055).
  - Against the mask (10158–10165): r = 14.14 is below the ring (16.5 ≤ r ≤ 19.5) and not on an arm (|dx| = 10 > 1.5), so false.
  - r = 22.63 is above the ring and off the arms (|dx| = |dy| = 16), so false.
  - The other rows still hold: (66, 48) is on the ring, (48, 26) is on an arm, (49, 48) is in the dot.
- **I2: ADDRESSED.** The check now uses only zoom-1 ticks with `arrival ≤ t < pressT` (10762–10764), and a dwell with no capture is reported, not failed (10765–10766). The Expected text says so (10850–10852).
  - Premise checked: `pointerAt` returns `plan.to` exactly for t ≥ startsAt + durationMs, and for Instant through `positionOnPlan` (600, 7790–7795).
  - Before dispatch, the region point is `target.point`. That equals `plan.to` because the CDP hitTest returns the queried point (5383, 5397–5406) and find clicks use `found.target.point` (6205).
  - Units match: everything is session ms, and `pressT` goes through `microsToMs` (10737).
  - The optional throttle is in: `SHOT_EVERY_MS` (10401), `#lastShot` (10471–10472, 10531–10537), cleared on enable (10563).
- **m1: ADDRESSED.** `sharpTick` (10747–10754). No other `sharp` binding is left in the spec.
- **m2: ADDRESSED.** `import type { Injector, Input }` (3326). `Injector` appears only in type positions in that file (3353, 3368, 3398), and `Input` only in 3394.
- **m3: ADDRESSED.** `let clockCalls = 0` (9909) now comes before the `fetchImpl` closure (9910).
- **m4: ADDRESSED.**
  - Both wrappers now use `microsToMs(frame.timestamp)`: Task 5 (import 3663, use 3696) and Task 12a (import 8388, use 8424).
  - The dependency moved to Task 5 Step 2 (3656–3658), where `clock-sync.ts` (3825) already needs it. Step 3 keeps only the script (4050–4051).
  - Task 12a Consumes lists `microsToMs` (7981) and says the protocol dependency "is there since Task 5" (8175).
  - No inline `/1000` is left in the touched code.
- **m5: ADDRESSED.** The comment (4610–4613) now matches the code and the test: `windowUnder` finds no window, so `hitTest` returns `done(null, null)` (4667). The test asserts `onPanel.target` is null (4531–4533), and Task 2's filter uses the same class set (1577).
- **m6: ADDRESSED.** The expected CLI line now reads `… action.intent Click "Name Box"` (6998–6999), which is what `clickLabel` (5719–5722) produces for that find click.
- **m7: ADDRESSED.** The vacuous self-comparison is gone (8116–8120).
  - Re-derived: `cameraFor(1280×800, 2560×1600, 1)` gives scale 0.5, tx = ty = +0. `videoPlacement` gives sx = sy = 2.
  - So `toCanvas(cam, (300, 400))` = (150, 200) for both new rows. The frame-built camera has scale 1, so (300, 400) maps to (300, 400).
  - All values are exact, with no −0.
- **m8: ADDRESSED.** The action crop is centred: `CROP_CENTRE` (48, 48), `cropAt` (10399, 10408, 10520). The cursor shot keeps `SHOT_TIP` (32, 24) (10400, 10534).
  - Re-derived: `expected` falls in [47.5, 48.5]. The DPR-2 band (22–42 px) spans about 5.5–90.5, and the DPR-1 band spans 26.5–69.5, so both lie inside the 96 px crop.
  - The template origin is (16, 14), which is inside [0, 32]².
  - Comments and docs match (10394–10397, 9983, 11177–11178).
- **m9: ADDRESSED.** The comment (2284–2286) is now true: `withPress` awaits `act()` (2188) before it returns, so the single progress line follows the delivery. P3-R25 is aligned (11204–11205).

Result: 12 of 12 ADDRESSED.

## 2. P3-C12 / P3-C13

**P3-C12 is applied completely and consistently.** I checked each place the kept frame is described or used:
- `probing` comment (8438–8439): "ignores it while off and, only while on, keeps a clone". OK.
- Skeleton prose (8523–8526): "while the oracle is on, never while it is off (P3-C12)". The skeleton code is no-ops (8537–8538). OK.
- Task 14 intro (9965–9970): kept while on; off in production keeps none; gives the 12 MB / frame-pool reason. OK.
- Interfaces (9982): "while enabled keeps a clone…, while off returns at once"; a baseline only "when one is kept". OK.
- `oracle.ts` comment and code (10474–10485): the guard `if (!this.enabled) return;` runs first, at 10480. OK.
- Note after `oracle.ts` (10593–10596): there is no disable op, and the frame is closed only on replace or `dispose`. OK.
- `oracle.test.ts`: test 1 enables first (10250); test 3 pins "no clone while off" (10294–10311). OK.
- e2e check-3 comment (10799–10801): "keeps that frame only while it is on (P3-C12)". OK.
- P3-R15 (11151–11153), P3-R20 (11180–11181) and P3-R29 (11220–11228) all say only while enabled. OK.
- Searches for "page load", "before frames flow" and "worker init" find nothing. No text says a clone is kept while the oracle is off.

**The code never holds a clone while the oracle is off.**
- `onFrame` returns before any clone (10480).
- `onTick` runs only when `oracle.enabled` (8458). It clones only `#latest`, which is set only after the guard (10483, 10513–10514).
- `#lumaCrops` returns before cloning when there is no clock or no region (10496).
- No `OracleCommand` turns the oracle off (8217), so an on→off leak path cannot exist.

**P3-C13's argument holds.**
- **The oracle is on before the launch repaints.** `page.evaluate(enable)` awaits `StageCanvas.oracle`, which resolves only on `oracle-reply` (9142–9148, 9083–9085). The worker sets `enabled` synchronously in `handle` (8501–8503, 10556–10558). `data-frames > 0` (10717) guarantees a presenter exists, so the reply is not `{error: "no presenter"}`. A no-op would fail loudly anyway, at `dump.ticks.length > 50` (10726).
- **The puppet starts after `enable` and `template`.** The runner then does `session.start`, `observe` and step 1 `launch` of `chromium --kiosk` flash.html (6653–6675, 6962). It appends a point-less `wait` intent, which `regionsAt` skips (10448–10449), then sleeps 8000 ms, settles and observes. The first click window opens only after that, at arrival − 100 ms. The kiosk repaint sends frames while the oracle is on, so each frame is kept.
- **Nothing in between calls `dispose()`.** It is reached only from `stop`/`frames` (8506–8510):
  - `stop` comes from `detach()` in Stage's stream-ticket effect when `!cellId || !ready || !support.ok` (9209–9213). Its deps are stable: `api` is memoised on `[token, fetchImpl]` (Part 2 7332–7345), and the cell stays ready.
  - `frames` comes from `attach()`, which DesktopFrame calls only when Selkies' track id changes, i.e. on a (re)connect (Part 2 8158–8173). `src` and `onSource` are stable (9226).
  - Every other message on this path (`session-reset`, `clock`, `events`, `view`, `resize`, `theme`, `oracle` `template`) leaves the oracle's frame alone (8475–8505).
  - The Stage is not remounted when the session goes live: it sits at a fixed spot in `StageColumn` (9772–9774).
- **Remaining exposure** is a spontaneous Selkies reconnect on a still screen. Even then the new track's first frame would normally re-seed `#latest`, and a miss fails loudly at 10804. This matches the ruling's stated cost.

## 3. New Breakage in the Fix Diff

**Checks run, all passing:**
- **oracle-check masks:** `crosshairMask` rows as in §1 I1. `arrowRect({40,40}, 2)` = {34, 34, 48, 58}: (41, 60) is inside, (30, 40) and (40, 100) are outside. `outsideRect({10,10,20,20}, 2)`: (5, 5) true, (9, 20) false, (33, 20) true.
- **firstChange:** `[F0 (10), F3 (200, presented 103)]` with baseline 1 has mean 10 and diff 190 > 8, so it returns 103. The older rows return 103 and undefined.
- **Cast `[frames[0], frames[3]] as typeof frames` (10068):** this is legal. `X[]` is assignable to `(X | undefined)[]`, so the assertion types are comparable under `noUncheckedIndexedAccess`.
- **Geometry camera values:** as in §1 m7.
- **Clock in `oracle.test.ts`:** `sessionMsAt` (3860–3862) maps wall(900) = 1,000,900 to 900 exactly (round(1,000,900 × 1000) − 1e9 = 900,000 µs). wall(1700) maps to 1700.
- **Window:** `foldEvents` (7515–7543) gives `id` = ID, `plan.startsAt` 1120, `durationMs` 400. So arrival is 1520, the window is [1420, 3020], and `lumaRect((300, 400))` = {268, 368, 64, 64}. Dedup is by seq, so the shared envelope `id` and the module-level `seq` are harmless; Task 11's helper uses the same pattern (7217–7219).
- **Test 1 traced:**
  - `onFrame(still)` keeps clone[0] and crops nothing (no regions yet).
  - Tick 1400 opens no window. Tick 1450 crops once through clone[1], giving {t 900, presented 7} with 4096 × 10 bytes. Tick 1500 adds nothing.
  - `onFrame(lit)` closes clone[0] and crops once. Frames = [[900, 7], [1700, 8]].
  - Result: 2 clones, each closed once. Passes.
- **Test 2 traced:** there is no clock, so no crop copies. a.clones[0] is closed once when b arrives. b.clones[0] is closed only on `dispose`. Neither original is closed. Frames = []. Passes.
- **Test 3 traced:**
  - While off, no clones. Ticks 1450 and 1500 open the window, but `#latest` is null, so there is no crop and ID is not marked.
  - `onFrame(lit)` crops once through lit.clones[1] and marks ID. Tick 1716 adds nothing.
  - lit.clones[0] stays open until `dispose`; lit.clones[1] is closed once. Passes.
- **Red run against the Task 12a skeleton** (8533–8544, which has no `frames` field):
  - Test 1 fails at `toHaveLength(1)` on undefined (10257).
  - Test 2 fails at `a.clones` length 0 (10282).
  - Test 3 passes both empty-clone checks, then fails at `frames toEqual([])` (10310).
  - So all 3 fail, as stated in 10329–10331.
- **Test counts:** oracle-check has 5 tests (2 locateTemplate, 2 masks, 1 firstChange), and `OracleCapture` has 3. This matches 10185 and 10614.
- **Imports and Biome:**
  - Worker imports are sorted, every type-only name is marked `type`, and the unused `Flip` is dropped (8388–8395).
  - `oracle.ts` and `oracle.test.ts` imports resolve: `@localdot/protocol` since Task 5, `@localdot/stage` since Task 12a (8175), exports at 7941. The test pulls in no pixi.js at runtime (`PixiPresenter` is type-only).
  - The self-reference to `make` inside `clone` runs later, so it is not a use-before-declaration.
  - The module-level `screen` in the test shadows only the DOM global; that is legal and no Biome rule flags it.
- **VideoFrame discipline:**
  - The kept clone is closed exactly once, on replace (10481) or `dispose` (10488), and is then unreferenced.
  - The crop copy is closed in `finally` (10507), on success and on failure.
  - The presenter's frames are never closed by the oracle (asserted at 10289–10290).
  - The probe keeps its own clone (8429–8436).
  - `onFrame` cannot throw synchronously: `clone()` runs on the not-yet-presented frame, and the crop work is inside an async IIFE. So it cannot kill the pump through `present` (8160–8165).

**Findings (none Critical or Important):**
- **Minor, 10501–10507.**
  - What's wrong: a `copyLuma` rejection is unhandled. The `finally` re-rejects into a `void`, and the worker only logs "Uncaught (in promise)". The loop also drops that frame's remaining jobs.
  - Because `#opened` was marked before the copy (10499), those windows never get a baseline. The failure then shows up later as a misleading "baseline frames before the press" (10804) rather than the real error.
  - How it can happen: an odd rect offset under the optional 4:2:0 stream (Part 2 8320), or a frame/session size mismatch (see §5).
  - Smallest fix: add `.catch((err) => …)` before `.finally` that records the message (for example in the dump, or with `console.error`), or mark `#opened` only after a successful crop.
- **Minor, 10796–10801.**
  - What's wrong: the comment says the baseline is "taken when the window opened, 100 ms or more before the press". That is false for the Instant click. The window can open in the worker only once its intent has been folded (about startsAt), roughly 60 ms before the press.
  - revision-log-2's "Instant ≥ 160" bound has the same error.
  - Smallest fix: reword to say the baseline is "taken when the window opens, or when the intent reaches the worker for an Instant click, before the press's frame". See §4.
- **Minor, 4106 (carried by the m4 hunk at 3656–3658).**
  - What's wrong: Task 5 Step 2 now runs `pnpm install` for a new workspace dependency, which changes `pnpm-lock.yaml`. Task 5's commit stages no lockfile, unlike every other dependency-adding commit (2758, 3523, 5006, 8745).
  - The change gets swept into Task 6's commit, and a `--frozen-lockfile` CI run fails in between.
  - Smallest fix: add `pnpm-lock.yaml` to the `git add` at 4106. This predates the diff.

## 4. Named Risk: Instant Baseline

**The intent's path, traced:**
- **Gateway** (`#pointerAction`, 6197–6259):
  - `t0` (6199). `durationMs` = 0 for instant (543–554). `leadMs` = 0 (6213). `startsAt` = round(session ms of t0) (6214).
  - The `action.intent` is appended synchronously (6217–6223). `EventLog.append` writes, indexes and calls its listeners in the same call (Part 1 2993–3003), and `streamSession` sends immediately (Part 1 3286–3297).
- **Page:**
  - The `useLiveSession` socket `onMessage` parses, folds into the React model and calls `stage.current?.pushEvents([event])` (9574–9577).
  - The Stage handle (9242) passes it to StageCanvas, which posts `{type: "events"}` (9127–9129).
- **Worker:**
  - `case "events"` folds synchronously (8482–8484).
  - The next rAF `tick()` (8446–8461) does `sessionNow`, `sceneAt`, `draw`, `render`, then `oracle.onTick` (8458).
  - `regionsAt` finds the Instant window open: from = startsAt − 100 (10451–10454).
  - `#lumaCrops(latest, [new window])` (10513–10514) takes the baseline from the kept pre-press frame. Its `t` is below pressT.

**The press's competing path:**
- `pressAtMs = startsAt + INSTANT_LEAD_MS` (6241; INSTANT_LEAD_MS is 60, at 536).
- Then `#sleepUntil`, `#waitForStream` and the desktopd `/input` HTTP call with XTest (6242–6247, 6355–6382).
- Then Chromium repaints, Selkies sends, the frame is decoded, and `probing.present` calls `oracle.onFrame` (8440).
- `onFrame` replaces `#latest` and crops only for `#regions` from the previous tick (10484).
- **Failure mode:** if the changed frame is presented after the fold but before a tick runs, the new window's first crop is the changed frame (t > pressT). `baseline` is then 0, and 10804 fails, naming "Click the page (instant)". The failure is loud, not silent.

**Margin estimate:**

| Path | What it adds | Total after startsAt |
|---|---|---|
| Frame | 60 ms lead + about 2–5 ms timer, HTTP and XTest + press→frame (S6 2× xtest click p50 13.8 ms, p99 23.1 ms; 3348, 3939) | about 73–88 ms |
| Intent, typical | about 1–2 ms transport (synchronous append, localhost WebSocket) + main thread (React commits ≤ 10 Hz) + next rAF (≤ 16.7 ms) + draw/render (a few ms) | about 10–25 ms |
| Intent, pessimistic | the typical leg + up to 10 ms main thread + one in-progress tick D. The Fast click's window (open until its dispatch + 1500 ms) is very likely still open when the Instant intent arrives about 1.0–1.3 s after it. Each tick then runs 2–4 `extract` calls, each with two overlay redraws, a render-to-texture and a synchronous readback (8337–8351), so D is about 5–30 ms. | about 55–60 ms |

- Resulting margin: about 50–75 ms typical and about 15–25 ms pessimistic. It goes negative only if the worker or main thread stalls for ≳ 50 ms in that window (a major GC or a long readback).

**Assessment:** this is not a correctness bug. The margin is positive but rests entirely on worker scheduling the plan does not bound, and the plan's own stated bound ("100 ms or more", log "≥ 160") overstates it. Severity: Minor (robustness).

**Recommended change (small, takes the rAF wait out of the race):**
- Take the baseline when the intent is folded instead of on the next tick.
- Split the first lines of `onTick` (10511–10514) into a public `onModel(model, t, screen)` that sets `#regions` and runs `#lumaCrops(latest, not-yet-opened)`.
- Call it from `onTick`, and from the worker's `events` case after `foldEvents`:
  ```ts
  if (oracle.enabled) {
    const t = sessionNow();
    if (t !== null) oracle.onModel(model, t, screenNow);
  }
  ```
  Add a no-op `onModel` to the Task 12a skeleton.
- The margin then becomes about 60 ms + press→frame − transport, about 65 ms or more, whatever a tick costs.
- Also fix the check-3 comment (§3, second Minor).
- If no change is made: a loss is loud and attributable, at 10804 naming the click.

## 5. Out-of-Scope Observations

- **10739: the pixel-oracle spec fails deterministically at the key dispatch. Predates the diff (v2 10512).**
  - `expect(ticks.length…).toBeGreaterThan(5)` runs for every dispatch, including `oracle.json`'s `{ "do": "key", "combo": ["space"] }` (6975).
  - Key intents carry no point (6293), and `regionsAt` skips point-less actions (10448–10449), so that dispatch has 0 ticks.
  - Smallest fix: `if (input.kind === "key") continue;` before 10739, or move the count assertion into the click and type branches.
- **10685–10686:** `import { microsToMs } from "@localdot/protocol"` comes after `import sharp from "sharp"`. Biome's import sorting would flag this if `pnpm lint` runs `biome check` with organizeImports.
- **10410–10415:** `lumaRect` clamps to the session screen (`#screen`) but reads the decoded frame's pixel grid. With a frame of another size (the case P3-R15 supports), the crop reads the wrong pixels or exceeds the coded size, and `copyTo` throws (see the first Minor in §3). This does not arise in the e2e, where frame size equals session size.

## 6. Verdict

**Ready for the user.** All 12 items are ADDRESSED. P3-C12 is applied completely and consistently, and P3-C13's argument holds. The fix diff introduces no Critical or Important breakage.

Optional Minor follow-ups:
- the `#lumaCrops` rejection handling (10501–10507);
- the check-3 comment for Instant (10796–10801);
- `pnpm-lock.yaml` in Task 5's commit (4106);
- the Instant baseline hardening (§4).

Strongly advised before Task 14 runs, though outside this review's scope: the deterministic key-dispatch failure at 10739 (§5).
