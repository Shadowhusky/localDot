# Production input and overlay acceptance — 2026-10-03

Measured on Richard's Mac Studio through the production daemon, authenticated
Selkies stream, desktopd raw input timestamps, installed Chrome and the final
stage renderer. Each required calibration group contains 500 measured trials.
Driver keys have no raw press timestamp and are deliberately excluded (P3-C9).

## Compositor-off reference gate

All six accepted groups have zero missed flips and pass the existing S6 gate:
median within 3 ms of the reference, p99 no more than one 16.7 ms frame above it,
and at most 1% missed. Times below are milliseconds.

| Scale | Input | Median | p99 | Maximum |
| --- | --- | ---: | ---: | ---: |
| 1× | xtest.click | 11.9 | 27.0 | 37.2 |
| 1× | xtest.key | 11.7 | 22.7 | 24.1 |
| 1× | driver.click | 8.6 | 18.6 | 19.3 |
| 2× | xtest.click | 16.3 | 39.3 | 48.3 |
| 2× | xtest.key | 16.0 | 25.9 | 31.0 |
| 2× | driver.click | 14.9 | 28.8 | 44.3 |

Two earlier 500-trial click runs missed the p99 gate (1×: 36.304 ms; 2×: 42.306 ms).
Their records are retained as CHECK, not counted as passes. The accepted bounded
click reruns above use the same gate without relaxed thresholds. The original
12-trial probe is diagnostic only. Other accepted rows retain their full 500-trial
measurements; they were not rerun merely to replace a valid result.

## Production compositor-on onset table

Every group has zero missed flips. The generated local calibration stores each
p99, rounded to one decimal place, as its ring onset.

| Scale | Input | Median | p95 | p99 / onset | Maximum |
| --- | --- | ---: | ---: | ---: | ---: |
| 1× | xtest.click | 15.1 | 24.9 | 35.8 | 41.9 |
| 1× | xtest.key | 15.3 | 23.2 | 25.4 | 43.1 |
| 1× | driver.click | 11.4 | 18.2 | 19.9 | 20.8 |
| 2× | xtest.click | 21.6 | 33.8 | 44.6 | 46.9 |
| 2× | xtest.key | 21.3 | 30.4 | 32.7 | 37.1 |
| 2× | driver.click | 21.7 | 28.6 | 33.2 | 45.6 |

The independent release-acting control at 2× contains 200 XTest clicks, zero
misses, median 27.3 ms, p99 48.7 ms and maximum 50.4 ms. It is recorded separately
and does not overwrite the production press-acting onset table.

Both real-browser pixel-oracle projects pass (1× and 2×, 79.31 s combined). They
verify cursor hotspot placement at stage zoom 1/2, absence of click rings before
raw press, ring presentation no more than one frame ahead of a press-acting page
change, typing display bounded by actual typed count, clean model observations,
and deterministic repeated overlay rendering. A subframe Fast dwell can have no
captured cursor-at-press sample; that diagnostic is reported rather than invented.
The earlier compositor motion test also measured zero torn frames at both scales;
see `2026-10-compositor.md`.

## Evidence and reproduction

Raw JSON and screenshots are local ignored files under `apps/web/e2e/out/`:

- Off: `calibrate-1x-off-down-1790967315745.json`,
  `calibrate-1x-off-down-1790990799788.json`,
  `calibrate-2x-off-down-1790962324511.json`,
  `calibrate-2x-off-down-1790966560013.json`.
- On: `calibrate-1x-on-down-1790991692223.json`,
  `calibrate-2x-on-down-1790992410338.json`.
- Release control: `calibrate-2x-on-up-1790992520109.json`.
- Final local `calibration.json`; `oracle-hidpi.png`, `oracle-lodpi.png`.
- Commands, exit codes and wall times: `/tmp/localdot-m2-final-calibration-resume/results.json`.
  The first resumed attempt had a missing local dependency link before measurement;
  its failed setup log is retained and supplies no acceptance sample.

Run `pnpm --filter @localdot/web calibrate --compositor on --scale 1 --trials 500
--injectors xtest,driver --kinds click,key --out <local-calibration-path>` and repeat
at scale 2. Use `--compositor off` for the reference gate. The release control adds
`--page up --trials 200 --injectors xtest --kinds click`. Then run
`pnpm --filter @localdot/web e2e pixel-oracle.spec.ts`. This run used Node 24.19.0,
owned disposable Docker cells and test keyd ports 4791–4796. Other services and the
user's private avatar preview were preserved. Do not reuse this machine-specific
calibration as a universal timing guarantee.

The representative Theatre screenshot was delivered to the user's explicitly
confirmed private Telegram chat as message 12070. M2 acceptance is complete;
full agent chat and the later app milestones remain separately tracked.
