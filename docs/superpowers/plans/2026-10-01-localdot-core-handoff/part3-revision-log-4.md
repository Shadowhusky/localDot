# Part 3 plan — revision 5 change log (review-3 fixes F1–F6; line numbers refer to the revised plan, 11,282 lines)

## Items

- F1 — Key dispatches skip the capture checks (review §5, first bullet).
  - `pixel-oracle.spec.ts`: after `pressT` is converted (10787), `if (input.kind === "key") continue;` (10789) follows a one-line comment (10788). The tick count (10790–10791), checks 1–3 (the click branch, 10793) and check 4 (the type branch, 10867) now run only for clicks and typing.
  - `oracle.json` yields 10 dispatches: 5 flash clicks, 2 typings, 2 marker-page clicks and the `space` key. `launch` and `wait` steps append no `action.dispatch` (gateway `wait` case 6172–6177, runner 6670–6676), so the key is the only dispatch without a point.
  - The checks that still run for the key are listed in their own section below.
- F2 — Crop failures are recorded and asserted (review §3, first Minor).
  - `OracleCapture` gains `errors: string[]` (10500). `enable` clears it (10609) and `dump` returns it (10615). `OracleDump` gains `errors: string[]` (10410).
  - `#lumaCrops` (10527–10548): each job's copy and push sit in a `try` (10539–10544). The `catch` records `` `${job.id}: ${message}` `` (10543), with the message taken as the worker does elsewhere (`err instanceof Error ? err.message : String(err)`).
  - A failed job no longer drops the frame's other jobs. The copy is still closed once, in the `finally` (10547), on every path. The async body can no longer reject, so nothing goes unhandled.
  - The comment says this in one sentence (10529–10530). `#opened` is still marked before the copy, so a window is never cropped twice.
  - The spec asserts `dump.errors` is empty right after it reads the dump, and the message prints them (10775).
  - Interfaces (9993, 9995) and P3-R20 (11232–11236) name `errors`.
- F3 — The Instant baseline is taken when the intent is folded (review §4).
  - `OracleCapture.onModel(model, t, screen)` (10550–10558) holds the first four lines of the old `onTick`. It sets `#screen` and `#regions` and gives each newly opened window one baseline from the kept frame. `onTick` now calls it first (10561). Its comment says why (10550–10552).
  - Worker (Task 12a `render-worker.ts`): the `events` case (8486–8493) is now a block. After `foldEvents` it calls `oracle.onModel(model, t, screenNow())` when the oracle is enabled and `t` is not null (8491).
  - The time is `freeze ? frozenT : sessionNow()` (8490). That is the value `tick()` hands to `onTick`, read without changing `frozenT`. While frozen and before the first frozen tick, `t` is null and the tick does the work.
  - The screen comes from a new helper `screenNow()` (8420–8422), the expression `tick()` had inline. `tick()` now calls it too (8452). No new state.
  - The Task 12a skeleton gains a no-op `onModel` (8548).
  - New test 4 in `oracle.test.ts`, "takes a window's baseline when its intent arrives, before any tick" (10338–10357). It reuses the file's helpers (`clickModel`, `fakeFrame`, `clock`, `wall`, `screen`, `noPresenter`, `settle`).
  - The red-run claim says all 4 fail and why (10362–10364). Step 2's Expected is 4 + 5 tests (10663).
  - Prose: the Task 14 intro (9978–9980), Interfaces (9993), the note after `oracle.ts` (10641–10645, which now says the `events` case calls `onModel`) and P3-R20 (11232–11233).
- F4 — The check-3 comment (10847–10854, changed 10850–10854) now says the baseline is taken before the press. For Watch and Fast that happens when the window opens, at arrival − 100 ms. For Instant it happens when the intent reaches the worker, about 60 ms before the press is due. The derivation is under the hand-derived values.
  - This was the only place in the plan that stated the "100 ms or more before the press" bound. The window comment at 10476–10478 ("from 100 ms before the planned arrival (the press comes after a ≤ 90 ms dwell)") describes the window, not the baseline, so it stays.
- F5 — Task 5's commit stages `pnpm-lock.yaml` (4106), like the other dependency-adding commits (2758, 3523, 5006, 8755).
- F6 — The spec's imports are in Biome's order (10731–10740): the `node:` builtins, then `@localdot/protocol`, `@playwright/test` and `sharp`, then the relative paths. This matches the calibration script's block (3913–3919).
  - Biome 2.5.15, the version Part 1 pins, also puts `../src/stage/oracle.ts` before `../src/stage/oracle-check.ts` (it was run on the block), so those two lines are swapped as well. No other block in the plan has an `x.ts` / `x-y.ts` pair to follow.

## Checks that run for a key dispatch after F1

- In the loop (10783–10872), before the skip:
  - the intent lookup by step (10785–10786): a dispatch without its intent is skipped, as before;
  - `microsToMs(Number(d.data.pressT))` (10787), which throws a RangeError if the key's `pressT` is missing or not finite.
- Skipped for the key (10789): the tick count, checks 1–3 (they need `input.at` and the window's captures) and check 4 (it needs the window's ticks). The loop had no key-specific assertion, so none is lost.
- After the loop, these session-level checks still cover the key action:
  - the session ends "done" (10773);
  - `dump.errors` is empty (10775);
  - there are more than 50 ticks overall (10776);
  - check 5 scans every observe frame, including the one taken after the key press (10874–10882);
  - `intents.length ≥ 10` counts the key's intent (10892).
- Check 6 renders only the first three dispatches, all flash clicks (10885), so it never involved the key.

## Consumers of `OracleDump` and `dump()` checked

- These spell out the fields and are updated: the interface (10407–10412), `handle`'s `dump` case (10615, `satisfies OracleDump`), Interfaces (9995) and P3-R20 (11235, "the dump's `errors`").
- These pass the reply through without naming fields and are unchanged:
  - `OracleCommand`'s `dump` op (8217);
  - `StageCanvasHandle.oracle` and `StageCanvas`'s `oracle` (9054, 9152);
  - `StageHandle.oracle` and the Stage handle (9190, 9256);
  - the `?oracle=1` hook's `dump` (10653);
  - `window.__localdot`'s `oracle?: unknown` (8667, 9195) and the Interfaces' `window.__localdot.oracle` (9996).
- The spec uses the dump in these places:
  - `import type { OracleDump, … }` (10736);
  - the read (10774) and the new assertion (10775);
  - `dump.ticks` (10776, 10790), `dump.dpr` (10833, 10835, 10839, 10841) and `dump.frames` (10855).
- Task 15 (10921–11043): `visual-core.spec.ts` neither loads `?oracle=1` nor calls `dump()`, and the README text only names the pixel oracle. Nothing changes there.

## Hand-derived values for every test touched

- Shared setup (unchanged):
  - sessionMsAt(wall(900)) = microsToMs(msToMicros(1_000_900) + 0 − 1_000_000_000) = microsToMs(900_000) = 900.
  - `clickModel`'s intent folds with intentT 1000, plan startsAt 1120 and durationMs 400, with no target and no dispatch. So arrival = 1520, from = 1420, until = 1520 + 1500 = 3020, and the point is `plan.to` (300, 400).
  - lumaRect((300, 400), 2560×1600) = {x max(0, min(2496, 268)) = 268, y max(0, min(1536, 368)) = 368, 64, 64}.
- Test 4 (new):
  - `enable`: enabled is true; frames, errors and `#opened` are empty; `#latest` is null.
  - onFrame(still, wall(900), 7): there is nothing to close, and still.clones[0] is kept. `#regions` is [] (no `onModel` or tick yet), so `#lumaCrops` returns before it clones.
  - onModel(model, 1450, screen): 1450 lies in [1420, 3020], so `#regions` = [ID], and ID is not in `#opened`. `#lumaCrops` clones once (still.clones[1]) and marks ID. It reads rect {268, 368, 64, 64} once and pushes {t 900, presented 7, actionId ID}. The `finally` closes still.clones[1].
  - After `settle()`: frames = [[900, 7]] and still.rects = [{268, 368, 64, 64}]. still.clones has length 2: [0] has 0 closes and [1] has 1. After `dispose()`, [0] has 1. still.frame is never closed.
  - No `onTick` runs, so the test covers the fold path alone.
- Tests 1–3: the path is the same, because `onTick` → `onModel` runs the same four lines and the `try` changes nothing for a copy that succeeds. Their values are unchanged from revision 4:
  - test 1: frames [[900, 7], [1700, 8]], and still.clones has 2 entries, each closed once;
  - test 2: a.clones and b.clones have 1 entry each, and frames is [];
  - test 3: frames [[1700, 8]], lit.rects [{268, 368, 64, 64}] and lit.clones 2.
- The red run against the Task 12a skeleton. The skeleton has no `frames`; `onFrame`, `onModel`, `onTick` and `dispose` are no-ops; `handle` sets `enabled`.
  - Test 1 fails at `expect(oracle.frames).toHaveLength(1)` (10268), because `frames` is undefined.
  - Test 2 fails at `expect(a.clones).toHaveLength(1)` (10293), because the length is 0.
  - Test 3 passes its clone checks (10314–10315) and fails at `expect(oracle.frames).toEqual([])` (10321).
  - Test 4's `onModel` call reaches the no-op. It fails at `expect(oracle.frames).toHaveLength(1)` (10348).
- e2e check 3's timing (F4), from `#pointerAction` (6197–6259):
  - Instant: `durationMs` and `leadMs` are 0, so startsAt = round(session ms of t0). The window opens at startsAt − 100, before the intent exists. The intent is appended synchronously at t0, and the press is due at startsAt + INSTANT_LEAD_MS = startsAt + 60. So `onModel` takes the baseline when the intent reaches the worker, about 60 ms before the press is due, less a few ms of transport.
  - Watch and Fast: the press is due at arrival + 90 or + 45 ms, so a window opening at arrival − 100 opens 190 or 145 ms before it. The intent is appended 120 or 60 ms before startsAt, and durationMs is at least 220 or 110. So arrival − 100 ≥ t0 + 240 or t0 + 70: the intent normally arrives first, and a tick takes the baseline.

## Checks run on the plan's code

- The changed blocks and the code they depend on were extracted into a scratch harness: time.ts, clock-sync.ts, model.ts, camera.ts, worker-protocol.ts, render-worker.ts, both oracle.ts versions, both test files, oracle-check.ts, puppet.ts, cells.ts and the spec. The presenter, pump, probe, theme and the protocol's event types were stubbed.
- Toolchain: TypeScript 7.0.2, Vitest 5.0.3 and Biome 2.5.15 (Part 1's pins). The spec was checked against Playwright 1.61.1 and sharp 0.35.4 types.
- `tsc` passes with Part 1's base options (strict, noUncheckedIndexedAccess, verbatimModuleSyntax) for:
  - `oracle.ts` with `oracle.test.ts`;
  - `render-worker.ts`, with the full oracle and with the Task 12a skeleton;
  - the spec.
- Vitest: the 4 `OracleCapture` tests and the 5 oracle-check tests pass. Against the skeleton, all 4 fail at the lines given above.
- Two scratch-only tests, not in the plan:
  - A `copyTo` that rejects for one window records `"<id>: <message>"` and still crops the other window. Each copy is closed once, the presenter's frames are left alone, and there is no unhandled rejection. `dump` returns `{ ticks, frames, errors, dpr }`, and `enable` clears `errors`.
  - The worker's `events` case calls `onModel` only while the oracle is on and the clock is set, with `sessionNow()` and `model.screen`. While frozen it skips until the first frozen tick, then passes the same `t` and screen that `tick()` passed to `onTick`.
- Biome `check` (formatter off) on the changed files: F6 removes the spec's `organizeImports` error, and these edits add no diagnostic.

## Not changed

- Review §5's third bullet (`lumaRect` with a frame of another size), as ruled.
- `#opened`'s comment (10504) still says "already have a luma crop". A window is marked when its crop starts. A failed crop now shows up in `errors`, and the spec fails on it.
- revision-log-2's "Instant ≥ 160" bound is in a log, not the plan, and stays as history.
- Out of scope. Biome 2.5.15 found these while F6 was being checked, and all of them predate this pass:
  - `pnpm lint` (`biome check .`) flags the import order of 15 other blocks:
    - the specifier order in `render-worker.ts` (8389) and `oracle.ts` (10368), which want `type Scene, type SessionModel, sceneAt`;
    - the specifier order in `oracle-check.test.ts` (10007), which wants `type Rgba, ringBandMask`;
    - group or path order in the blocks at 2144, 2479, 2803, 3663, 4324, 4477, 4915, 5031, 5455, 6744, 6843 and 7260. Some of these are fragments that merge into existing files.
  - `tick()`'s `freeze ? (frozenT ??= sessionNow()) : ((frozenT = null), sessionNow())` (8454) gets two `noAssignInExpressions` errors and a `noCommaOperator` warning.
  - The spec's `type LoggedEvent` import is unused, which `noUnusedImports` reports as a warning.
