# Job: write the Part 6 plan: M5 Control and safety

- **Output branch:** made from `origin/planning`, named `claude/plan-part6`. Commit:
  - `docs/superpowers/plans/2026-10-01-localdot-core-part6-control-safety.md`;
  - `reports/plan-part6-report.md`.
  Push it. Follow `jobs/PLAN-WRITING.md` and `jobs/PROCESS.md`.
- **Format:** M5 uses the **interface-and-test** format. Most of M5 is the security boundary, so give complete code where PLAN-WRITING says so, and label each task's review tier (`full` for approvals, the kill switch, Stop, guards and takeover).

## Scope
The M5 row: autonomy levels, risk rules, approvals, takeover and hand-back, pause, Stop and the kill switch, guards, and the budget UI. Read the spec's "Safety and control" in full, plus every line that names M5.

## Inputs
- **Part 5a's seams:** `git show origin/claude/plan-part5a-providers:docs/superpowers/plans/2026-10-01-localdot-core-part5a-agent-core.md`. Find where its policy hook, approvals seam and the tool table leave M5's place.
- **Part 5c's approval filter**, if `origin/claude/plan-part5c` exists.
- **Part 3's plan** (`ActionGateway`, takeover and the input path).
- **Part 4a's plan:** the kill switch (Task 15), budgets (Task 13) and the admin socket (Task 16).
- **Part 4b's plan,** on `origin/claude/plan-part4b-fix2`: Stop, freeze and the keyd close.
- **Part 7's plan,** on `origin/claude/plan-part7`: approval and takeover markers in replay.
- **The spec** and its research.

## Rules
- **Review Focus, each with a pinning test:**
  - prompt injection from a web page triggering a risky action at each autonomy level;
  - an approval prompt spoofed by on-screen content;
  - Stop and the kill switch while a tool call is mid-flight (nothing more reaches keyd or the desktop);
  - takeover racing an agent action;
  - budget exhaustion mid-step.
- Part 6 runs after Parts 5a and 5b, on `feat/core-part6`.
- Where the spec is silent, decide, and record it as `P6-R…`.
