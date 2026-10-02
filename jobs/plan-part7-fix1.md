# Job: Part 7 plan (M6 Replay), fix pass 1

The plan's one fix pass (`jobs/PROCESS.md`). The review found no Critical, so no re-review follows.

- **Base:** `origin/claude/plan-part7~1` (`f2fb50d`, the plan without its report). Then merge `origin/planning`.
- **Branch:** `git checkout -b claude/plan-part7-fix1 f2fb50d`. Commit there and push it. The controller merges this branch in place of `claude/plan-part7`.
- **Commit:**
  - the edited `docs/superpowers/plans/2026-10-01-localdot-core-part7-replay.md`;
  - `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part7-revision-log-1.md` (per finding: what changed, where, and the pinning test);
  - LAST, `reports/plan-part7-fix1-report.md`, touching only `reports/`.

## Input
The review: `git show origin/claude/review-plan-part7:docs/superpowers/plans/2026-10-01-localdot-core-handoff/part7-review-1.md`.

## Apply
- **All 7 Important findings,** each with the smallest fix the review proposes (or a smaller one that fully closes it). Each gets a pinning test in the task that owns it.
  - **I1:** extend spike S9's cases (recorder first then viewer, viewer leaves while recording continues, stream reset, `START_VIDEO` re-send), and bound the longest stretch without a key frame.
  - **I2:** the idle policy must not loop on a still screen. Pin it with a still-screen test that bounds the requests and bytes per idle hour.
  - **I3:** play-mode decoding must never re-seek the same key frame. Replay and export frames must never be older than their overlays.
  - **I4 (the privacy gate, tier `full`):**
    - close the race between reading the backlog and subscribing, so no takeover is missed;
    - write into the M5 seam that the user's input is closed before hand-back.

    Note the second item for Part 6 under "Interfaces later milestones build on".
  - **I5–I7:**
    - recovery on a disk that is still full never leaves a file the server treats as finished;
    - an invalid manifest never deletes a recording, it quarantines it instead;
    - a replay of a live session follows new events, so "jump to live" works.
- **The 14 Minors:** apply the plainly correct ones. For any you decline, give the reason in the log.
- Keep the plan in the interface-and-test format.

## Verify
Re-run the plan's Node-runnable pins in a scratch copy, as the review did. List what can't be verified here (Selkies, Chrome, Docker).
