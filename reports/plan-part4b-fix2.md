# plan-part4b-fix2 — report

**Status: DONE_WITH_CONCERNS** (all of P4b-C4 applied and pinned; Docker and Part 3 code paths not runnable here).

Branch `claude/plan-part4b-fix2` (from `origin/planning` `cf9e7b1`). Commits:
- `docs(planning): Part 4b fix 2 — web rebase on Part 2 b02765f, guard name and freshness`
- `docs(planning): Part 4b fix 2 — Stop falls back to stopping the computer, queued refresh, canary offsets`
- `docs(planning): Part 4b fix 2 — the cell CA is a plain anchor, pinned from OpenSSL and Go`
- `docs(planning): Part 4b fix 2 — verification, Part 4a rebase check and revision log 2`
- this report.

Files: the plan (12,766 → 13,355 lines) and `…handoff/part4b-revision-log-2.md`, which has the
detail per finding (what changed, where, the pinning test) and the verification runs.

## Applied

- **I-1:** a failed freeze closes the cell in keyd, then stops the computer (`StopOutcome.stopped`).
  Pinned by two new tests (Stop during a crash restart's backoff, and a keyd plus daemon restart),
  plus the extended closed-cell test.
- **I-2:** Tasks 12b and 13 rebased on Part 2 `b02765f` (`<Mascot />`, `api.post`, Part 2's return
  object). `App.test.tsx` is changed explicitly (2 tests). The CSP and Permissions-Policy are
  noted, and the pre-flight re-verifies the UI against Part 2's final tip.
- **Minors 1–9:** each applied with its smallest fix and a pin, except Minor 5 (recorded for M9)
  and Minor 6 (superseded by the CA ruling).
- **CA trust:** the CA is a plain anchor (system bundle and NSS `C,,`, no purpose flags), and
  `ca-system` requires it. Task 7's Docker test pins OpenSSL and Go accepting a bound-host leaf
  and refusing other-host and subdomain leaves, from a CA with `cellca`'s profile. R30 is
  rewritten.
- **Part 4a `70a534e` rebase check:**
  - the policy refusals, binding hosts and keys placement all hold; no plan change needed;
  - `cmd/keyd` and `admin` remain 4a plan text.

## Tests (Linux scratch, Node 24.21.0, Go 1.27.1)

- **TypeScript:** typecheck in every package clean, Biome clean, hygiene clean. Vitest: 59 files,
  524 passed, 3 Docker skips.
- **Go:** gofmt and vet clean; `go test -race ./...` 9 packages ok; netguard 5× under `-race`.
- **Red first:** kill-switch 6 of 19, the queued-refresh test, selftest 7 of 11, the 3 netguard
  tests, `App.test` 2 of 8 plus the TopBar typecheck error on `b02765f`, and the Keys button's
  accessible name.
- **Trust chain** (the test's own mint script and Go verifier, on Linux OpenSSL 3.0.13):
  - OpenSSL accepts the bound leaf and refuses the others with errors 47 and 48;
  - Go answers ok, not permitted and excluded;
  - against the TRUSTED form alone, Go reports an unknown authority.

## Not verified

- **Docker:** every Docker suite, including this pass's Task 7 and canary changes; the oneshot in
  the Ubuntu 26.04 image; NSS in Chromium.
- **Clients:** GnuTLS, rustls and Java.
- **Unbuilt code:** Part 3 (the routes test ran against a stand-in); Part 2's Task 15 e2e harness;
  4a's unbuilt packages.
- **Not exercised:** a NAT-PMP router, and the gateway-change test on macOS.

## Concerns

- **I-1's cost:** a computer whose freeze failed loses its running programs (stopped, not
  frozen). R6 records it.
- **Minor 1:** an API Start on a frozen computer reboots it. The HUD offers only Resume and Stop.
- **Task 7's Docker test** now builds a small Go verifier on the Mac, so it needs `go` (or `GO`).
- **`origin/planning` moved to `607e321`** during this job (review tiers). This branch touches only
  the plan, the log and this report, so it merges cleanly.
