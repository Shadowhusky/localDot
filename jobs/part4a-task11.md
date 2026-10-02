# Job: implement keyd Task 11, CONNECT (goproxy's front door and SNI-checked passthrough)

Review tier: `full` (`jobs/PROCESS.md`). A separate review job follows yours.

- **Base:** `origin/claude/part4a-task10-fix` at `18e2a47`: Task 9's fix, Task 10 and Task 10's fix, without the report commit.
- **Code branch:** `git checkout -b claude/part4a-task11 18e2a47`. Commit there and push it.
- **Report:** `reports/part4a-task11-report.md`, as the LAST commit, touching only that file.

## Read first
- **The task:** `docs/superpowers/plans/2026-10-01-localdot-core-part4a-keyd-core.md` on planning, "Task 11: CONNECT …". No separate brief was extracted, so the plan's task text IS the brief, and you use its exact values verbatim.
  - Extract its Go blocks mechanically (awk/sed), commit them unchanged first, and `cmp` them.
  - Build backslash sequences in added tests from a constant.
- `sdd/2026-10-01-localdot-core-part4a-keyd-core/`: `global-constraints.md` and `progress.md` (every ruling, P4a-R…).
- **As built, where the plan's quotes differ:**
  - Task 10's report: `git show origin/claude/part4a-task10:reports/part4a-task10-report.md`.
  - Task 10's fix report: `git show origin/claude/part4a-task10-fix:reports/part4a-task10-fix-report.md`. Note that a plain-HTTP upgrade to a host with a scrub pair is refused until interception (Tasks 11 and 12) fills `c.intercepted`.
  - Task 9's fix report: `git show origin/claude/part4a-task9-fix:reports/part4a-task9-fix-report.md`. `Inspect` compares an absolute-form host with `Dest.Host`.
  - Adapt the task's code to the as-built APIs only where it won't compile or contradicts a ruling. Record each adaptation as a concern.

## Do
- TDD exactly as the task says, keeping the RED evidence.
- **Verify,** in `keyd/`:
  - `gofmt -l .` (it must print nothing);
  - `go vet ./...` for linux and `GOOS=darwin`;
  - `go test -race ./...`;
  - egress at `-race -count=10`;
  - `go mod tidy -diff`;
  - at the repo root, `pnpm lint` and `pnpm hygiene`.
- **Hunt for bypasses:**
  - a CONNECT target that differs from the TLS SNI;
  - no SNI;
  - SNI with an IP, a trailing dot or a different case;
  - a CONNECT to an IP literal;
  - a reserved or internal name;
  - a non-443 port;
  - a CONNECT without the cell token, or with it in a different header case;
  - a second CONNECT inside the tunnel;
  - an HTTP/2 preface;
  - ALPN;
  - a slow or partial ClientHello;
  - a ClientHello split across records;
  - early data;
  - a passthrough to a host with a bound secret, which must be intercepted (Task 12) or refused, never passed through.
- Mutation-test the changed packages on a scratch copy.
- Put pins for real gaps in the integrity test files, in a test-only commit.
- Report production changes beyond the task as concerns; don't apply them.
