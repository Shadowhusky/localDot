# Job: review the Part 7 plan (M6 Replay)

One review, then the controller applies its rulings in one fix pass (`jobs/PROCESS.md`).

- **Plan:** `docs/superpowers/plans/2026-10-01-localdot-core-part7-replay.md` on `origin/claude/plan-part7` (head `af14d3d`). Its report is `reports/plan-part7-report.md` on the same branch.
- **Output branch:** `claude/review-plan-part7`, made from `origin/planning`. Commit `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part7-review-1.md` and push it.
- **Format:** the plan uses the interface-and-test format (see `jobs/PLAN-WRITING.md`, "Plan format by milestone"). Review it against that, and don't ask for full code.

## Check
- **Spec coverage:** M6's row, success criterion 4, and every Replay line of the spec ("Interface", "Setup and operations", "Error handling", "Testing", "Repository" for mediabunny and the MPL-2.0 licence).
- **Recording in the daemon (P7-R…):**
  - is the passive Selkies client sound;
  - is spike S9 a real gate with workable fallbacks;
  - what happens with no keyframe on a still screen.
- **Interfaces** against Part 3's closing interfaces and Part 2 as built. Name the protocol events it relies on.
- **Task 12's change to Part 1's EventLog:** is it correct, and is it compatible with existing logs?
- **The Review Focus pins:**
  - seek accuracy;
  - a crash mid-recording;
  - a full disk;
  - a 2-hour session's memory and CPU;
  - overlay determinism;
  - privacy of exports.
  Run the pins that are runnable in Node in a scratch copy.
- **Enough detail:** does every task have enough interface, test and edge-case detail for an implementer to write it once, correctly?

## Output
Findings as Critical, Important and Minor, each with a location, the evidence and the smallest fix. End with a verdict: **READY** or **FIXES_NEEDED**.
