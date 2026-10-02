# Job review-plan-part5a: report

**Status: DONE.** The plan's verdict is **FIXES_NEEDED**.

- **Review:** `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part5a-review-1.md`
- **Plan reviewed:** `claude/plan-part5a-providers` at `54221ad`, with its Part 4a amendment.
- **Findings:** 1 Critical, 9 Important, 18 Minor. Because of the Critical, the changed sections
  get a scoped re-review.

## Top findings
1. **C1. Tool calls die at 5 minutes.**
   - The brain's `ToolClient` uses Node's `fetch`, which has undici's 300 s header timeout
     (confirmed: `UND_ERR_HEADERS_TIMEOUT` at 300.9 s).
   - So `ask_user`, `request_takeover` and long shell commands crash the brain after 5 minutes.
   - The restarted brain can then act while the hand-off is still open.
2. **I1. The task budget resets.** keyd keys a task by cell, and each brain run is a new cell, so
   every crash restart and every follow-up starts at $0 spent.
3. **I2. Memory can carry an injection.** A tainted session can `remember` instructions, which
   every later prompt presents as written by the user.
4. **I3. Screenshots never taint the session.**
5. **I4 and I5. The freshness check has two gaps.**
   - In a batch, actions after the first are compared with frames the model never saw.
   - A target next to anything animated is never clickable.
6. **I6. A keyd restart strands paused tasks.** Their resume goes to a keyd cell that no longer
   exists.
7. **I7. Idle follow-ups can be dropped.** A resumed brain is told to "continue", calls `done`,
   and the follow-up never reaches a prompt.
8. **I8. Background programs started from `shell` block until the timeout, then are killed.**
9. **I9. No task carries a review tier.**

## Verification
- **Scratch copy:** `feat/core-part2` at `b02765f`, plus the Part 3 and Part 4b files from their
  plans and every block of this plan. It was rebuilt in `/tmp` and removed afterwards.
- **Install:** `pnpm install` added exactly the six pinned packages.
- **Static checks:** typecheck is clean in every package. Biome lint is clean; format is not, as
  written (Minor 17). Hygiene passes.
- **Tests:** this plan's 25 suites, 150 tests, all pass.
- **Bundles:** the brain bundle (19 packages, licenses found) and desktopd's both build.
- **Probes:** four scratch probes back C1, I4, I7 and I8.

## Not verified
- **No Docker:**
  - Task 15;
  - the gate's brain role;
  - the brain image;
  - `host.docker.internal` to 4751.
- **No keyd binary:** Task 16 and the admin API calls.
- **No provider calls.**
- **Not built:** Part 4b's `main.ts` wiring (Task 13). It exists only as edit text.
