# Job: scoped re-review of keyd Task 9's fix round, Task 10, and Task 10's fix round

Review tier: `full`. This is the re-review that closes Tasks 9 and 10. It is read-only for code: you push only a review file.

- **Diff:** `70a534e..18e2a47` (`origin/claude/part4a-task10-fix` without its report commit). It holds Task 9's fix round (`c918f27..b11c3ac`), Task 10 (`3d8b34f..950c0ac`), their merge, and Task 10's fix round (`30b5e59..18e2a47`).
- **Output branch:** `claude/review-part4a-fixes`, made from `origin/planning`. Commit `reviews/part4a-fixes-review.md` there and push it.
- Probe in a scratch worktree at `18e2a47` under `/tmp/job-review-part4a-fixes/`, and delete it afterwards.

## Read first
- The Task 9 review: `git show origin/claude/review-part4a-task9:reviews/part4a-task9-review.md`. Follow its shape: how the review was done, what was checked, then findings as Critical, Important and Minor, each with a file:line, a reproduction and a suggested fix.
- The three job reports (`reports/…` on `origin/claude/part4a-task9-fix`, `origin/claude/part4a-task10` and `origin/claude/part4a-task10-fix`).
- `sdd/2026-10-01-localdot-core-part4a-keyd-core/`: `task-9-brief.md`, `task-10-brief.md`, `global-constraints.md` and `progress.md`. The Task 9 rulings are in `progress.md`, and Task 10's are in `jobs/part4a-task10.md`.

## Check
1. **Every Task 9 review item:** verdict each one fixed, partly fixed or not fixed, with evidence (the pin, and a probe of your own).
2. **Task 10 against its brief and the six rulings** in `jobs/part4a-task10.md`.
3. **Task 10's fix round:** its five items, and that the upgrade refusal can't be bypassed.
4. **The merge:** nothing lost or double-applied, and the `Dest.Host` contract holds on every path.
5. **A fresh security hunt** over the listener and keys:
   - leaks of real values, surrogates or the token in errors, logs and audit;
   - requests reaching an upstream unauthenticated;
   - policy bypasses;
   - races (run probes under `-race`);
   - resource exhaustion (huge headers, many connections, slowloris).
6. **Tests:** `go test -race ./...` and gofmt/vet; also that no brief test was weakened.

End the review with one verdict: **APPROVED**, **APPROVED_WITH_MINORS** (the Minors are batched to the final review), or **FIXES_NEEDED** with the exact list.
