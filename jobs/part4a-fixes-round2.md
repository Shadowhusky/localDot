# Job: keyd Tasks 9 and 10, fix round 2 (the re-review's two Importants)

Review tier: `full`. A scoped re-review of only these items follows.

- **Base:** `18e2a47` (`origin/claude/part4a-task10-fix` without its report). Keyd Task 11 runs in parallel on the same base, and the controller merges the two branches.
- **Branch:** `git checkout -b claude/part4a-fixes-round2 18e2a47`. Commit there and push it.
- **Report:** `reports/part4a-fixes-round2-report.md`, as the LAST commit, touching only that file.

## Input
`git show origin/claude/review-part4a-fixes:reviews/part4a-fixes-review.md`: its two Importants, and its reproductions.

## Apply
Each item gets a pin that FAILS on `18e2a47`. Show the RED evidence. Pins for resource bounds assert counts or sizes, not wall time, so they stay stable under load.
1. **CPU per request:**
   - make `order()` in `keys/inspect.go` linear (dedupe with a map);
   - index the case-folded surrogate lookup so a hit costs O(1) and doesn't scan the registry;
   - set the cell listener's `MaxHeaderBytes` to 64 KiB.

   Pin these with:
   - the review's 1 MiB request, now refused by the header cap;
   - a 64 KiB request full of surrogate-shaped strings, with the work bounded (for example, a counter of comparisons in a test hook, or a benchmark-free bound on calls);
   - a 4-way parallel run that finishes.
2. **Unauthenticated connections:**
   - every 407 sends `Connection: close` and closes the connection;
   - add a per-cell cap on concurrent connections, with a named constant and a comment on how the value was chosen. Over the cap, refuse at accept time with one rate-limited audit line (P4a-R12/R13), never logging the token.

   Pin that:
   - a 407 connection is closed;
   - connections past the cap are refused;
   - the listener recovers once they close.
3. **Do NOT apply the four Minors.** They are batched to the final review. The exception is the IPv6 refusal message: fix it if it's a one-line change.

## Verify
In `keyd/`:
- egress and keys at `-race -count=10`;
- `gofmt -l .`;
- `go vet ./...` for linux and `GOOS=darwin`;
- `go test -race ./...`;
- `go mod tidy -diff`.
At the repo root, `pnpm lint` and `pnpm hygiene`.

Mutation-test the changed code. Re-run the review's reproductions and report before/after numbers.
