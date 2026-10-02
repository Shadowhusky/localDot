# Job: keyd Task 9 (surrogate registry), fix round 1

- **Base:** `origin/feat/core-part4a` at `70a534e`.
- **Branch:** `git checkout -b claude/part4a-task9-fix 70a534e`. Commit there and push it.
- **Report:** `reports/part4a-task9-fix-report.md`, as the LAST commit, touching only that file.

## Read first
- **The review to fix:** `git fetch origin claude/review-part4a-task9`, then `git show origin/claude/review-part4a-task9:reviews/part4a-task9-review.md`.
- **The controller's rulings:** the "Task 9:" lines at the end of `sdd/2026-10-01-localdot-core-part4a-keyd-core/progress.md` on planning.
- **Requirements:** the brief, `task-9-brief.md`; the earlier rulings in the same `progress.md`; and `global-constraints.md`.
- **Code:** `keyd/internal/keys/` (`binding.go`, `registry.go`, `inspect.go`, `keys_integrity_test.go`).

## Apply
Each item gets a pin in `keys_integrity_test.go` that FAILS on `70a534e`. Show the RED evidence in the report.
1. **Important 1:** `looseBasic` must find a surrogate in every non-canonical Basic spelling.
   - Decode the joined form AND each whitespace- or comma-separated field on its own AND each `=`-delimited chunk on its own. A token found in any decoding is a non-canonical occurrence, so refuse.
   - Pin the review's two probes (`Basic Z <b64("x:"+surrogate)>`, and `Basic Zm9vOmJhcg==, Basic <b64>`) against a bound AND an unbound host.
   - Pin a token in field 2, 3 or 4 after fields of every length modulo 4.
2. **Minor 1:** `ApplySwaps` confirms each bound header still holds exactly what `Inspect` saw (re-run the placement check) before writing, and errors otherwise. It must stay all-or-nothing.
3. **Minor 2:** Q1 composition decodes the original Basic header once, replaces both halves, and encodes once. A colon inside a real user value must survive intact (use a test value with a colon, through `ValidValueFor` rules).
4. **Minor 4:** `badBaseURL` requires `u.Host == u.Hostname()` (no empty port such as `host:`) and `u.RawPath == ""` or `u.EscapedPath() == u.Path` (so `/v1%2fadmin` is refused). The fixed reason text never echoes the URL.
5. **Minor 5:** `FromRecord` refuses path prefixes containing `?`, `#`, `//` or a `..`-led segment, matching `unambiguousPath`.
6. **Minor 6:** clone the `Binding` (slices, `Ops`, `*url.URL`) at `Mint`, and again when returning from `Lookup` and `ForCell`. Test that mutating a returned entry can't change the registry.
7. **Minor 7:** `Entry` (and anything that prints a surrogate, `Verdict` via `Swaps`) formats it as `surrogate:<ID>` under `%v`, `%+v` and `%s`, using `Format`/`String` methods. Test that `fmt.Sprintf("%v", entry)` never contains the token.
8. **Minor 8:** `Inspect` refuses when an absolute-form `u.Host` is set and differs from `Dest.Host` after the policy's normalisation (`policy.ParseHostPort`).
   - Origin-form requests (an empty `u.Host`) are unaffected. Check that the brief's tests still pass.
9. **Minor 9:** a path-limited binding refuses a request whose decoded path contains a space anywhere.

Do NOT apply Minor 3 (secret generation): it's carried to Task 16, because the `ApplySwaps` signature must not change now.

## Verify
In `keyd/`:
- the keys package at `-count=50` and `-race -count=10`;
- `gofmt -l .` (it must print nothing);
- `go vet ./...` for linux and `GOOS=darwin`;
- `go test -race ./...`;
- `go mod tidy -diff`.
At the repo root, `pnpm lint` and `pnpm hygiene` if Node is available.

Mutation-test your new code on a scratch copy. In the report, give per item what changed, the pin, and its RED/GREEN result.
