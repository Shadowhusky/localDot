# Job: Part 5a plan (M4 agent core), fix pass 1

The plan's one fix pass (`jobs/PROCESS.md`). The review found a Critical, so a re-review of the changed sections follows.

- **Base:** `origin/claude/plan-part5a-providers~1` (`7ef037c`, the plan without its report). Then merge `origin/planning`.
- **Branch:** `git checkout -b claude/plan-part5a-fix1 7ef037c`. Commit there and push it. The controller merges this branch in place of `claude/plan-part5a-providers`.
- **Commit:**
  - the edited plan, and Part 4a's plan where keyd must change;
  - `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part5a-revision-log-1.md` (per finding: what changed, where, and the pinning test; plus a list of every changed section, for the re-review);
  - LAST, `reports/plan-part5a-fix1-report.md`, touching only `reports/`.

## Input
The review: `git show origin/claude/review-plan-part5a:docs/superpowers/plans/2026-10-01-localdot-core-handoff/part5a-review-1.md`, and its report on the same branch.

## Apply
- **The Critical:** tool calls longer than 5 minutes must not crash the brain. Read the reviewer's proposed fix.
  - The tool client needs no headers timeout for long calls, or a long-poll/heartbeat protocol, with its own explicit per-tool deadline.
  - A restarted brain must never act while the user holds the screen.
  - Pin both: a 6-minute call with fake timers or an injected clock, and a restart during a takeover.
- **All 9 Importants,** each with the smallest complete fix and a pin:
  - **budgets:** spend is tracked per task or session across restarts and follow-ups, not per cell. Amend Part 4a's plan (Task 13) if keyd must carry it;
  - **taint:** `remember` is refused or quarantined while the session is tainted, and memory written under taint is never presented as the user's;
  - **screenshots taint** the session (M5's main injection channel);
  - **freshness:** every action in a batch is checked against a frame the model actually saw. A target next to animation can still be clicked (define a stable-region rule);
  - **keyd restart:** paused tasks resume against a fresh keyd cell;
  - **idle follow-ups:** a follow-up to a finished task is never dropped;
  - **shell background processes:** they don't block until the timeout. Detach them, or document and pin the behaviour;
  - **review tiers:** add `Review tier: full|light` to every task, per `jobs/PROCESS.md`;
  - the remaining Important in the review, as written there.
- **The 18 Minors:** apply the plainly correct ones. For any you decline, give the reason in the log.
- **Formatting:** run Biome's formatter on the plan's code blocks, so files and snippets come out as Biome would write them.

## Verify
Assemble the plan's code on Part 2 in a scratch copy, as the review did. Typecheck, Biome lint and format, all tests and the review's four probes must pass. If Part 4a's plan changed, compile its Go against `origin/feat/core-part4a` in scratch and run `go test -race`. Make no provider calls and run no Docker.
