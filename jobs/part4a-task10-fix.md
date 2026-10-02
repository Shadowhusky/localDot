# Job: keyd Task 10 (cell listener), fix round 1

Process tier: `full` (security boundary, `jobs/PROCESS.md`).

- **Base:** `origin/claude/part4a-task10-fix` at `chore: merge keyd Task 9 fix round 1 with Task 10's listener`. That is a merge of `claude/part4a-task9-fix` (`b11c3ac`, the code without its report) and `claude/part4a-task10` (`950c0ac`, the code without its report), and the full module passes `go test -race` on it.
- **Branch:** `claude/part4a-task10-fix`. Commit there and push it. The controller then merges this one branch in place of the two.
- **Report:** `reports/part4a-task10-fix-report.md`, as the LAST commit, touching only that file.

## Read first
- Task 10's report: `git show origin/claude/part4a-task10:reports/part4a-task10-report.md`, especially "Concerns" and "Merge item".
- Task 9's fix report: `git show origin/claude/part4a-task9-fix:reports/part4a-task9-fix-report.md`.
- `sdd/2026-10-01-localdot-core-part4a-keyd-core/` on planning: `task-10-brief.md`, `global-constraints.md` and `progress.md` (P4a-R10, R12 and R13).
- Code: `keyd/internal/egress/` and `keyd/internal/keys/`.

## Apply (the user approved this round, 2026-10-02)
Each item gets a pin in `egress_integrity_test.go` or `keys_integrity_test.go` that FAILS on the base. Show the RED evidence in the report.
1. **Data race (Important):** the request byte count becomes an `atomic.Int64`, or equivalent. The pin is the report's repro (a 204, or an early answer to a streaming POST) under `-race`.
2. **Plain-HTTP upgrade to a bound host (Important):**
   - refuse a plain-HTTP `Upgrade` when the destination has any scrub pair (`scrubberFor` is non-empty), with an audit line and no upstream dial when that can be decided before the dial;
   - otherwise refuse the 101 and close the connection;
   - document the refusal so Tasks 11 and 12 can lift it once interception fills `c.intercepted`;
   - pin that a secret echoed after a 101 never reaches the cell, and that an upgrade to an unbound host still works.
3. **Surrogate in a header name (Minor → fix):** `Inspect` scans header names case-insensitively, so a canonicalised name (`Ld_…`) is still found and refused or alerted, the same as in a value. Pin it through the listener, not only in `keys`.
4. **`OPTIONS *`:** set `DisableGeneralOptionsHandler = true`, so the request reaches `ServeHTTP` and the token check and audit run. Pin that `OPTIONS *` without the token gets keyd's 407.
5. **`keyd.ldot` match:** use an ASCII-only case fold and the exact expected port. Pin U+212A and a wrong port.

Do NOT apply the per-request dial deadline (the progress CARRY); it stays carried. Report any further production change you think is needed as a concern, without applying it.

## Verify
In `keyd/`:
- egress and keys at `-race -count=10`, and the timing-sensitive pins at `-count=30`;
- `gofmt -l .` (it must print nothing);
- `go vet ./...` for linux and `GOOS=darwin`;
- `go test -race ./...`;
- `go mod tidy -diff`.
At the repo root, `pnpm lint` and `pnpm hygiene`.

Mutation-test the changed code on a scratch copy. Then hunt again for bypasses around items 2–3: `Connection: upgrade` spellings, `h2c`, an `Upgrade` header listed in `Connection`, and header names with mixed case or obsolete line folding. In the report, give per item what changed, the pin, and its RED/GREEN result.
