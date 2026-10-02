# Job: implement keyd Task 10, the cell listener (token, self-test name, plain HTTP)

- **Base:** `origin/feat/core-part4a` at `70a534e`.
- **Code branch:** `git checkout -b claude/part4a-task10 70a534e`. Commit there and push it.
- **Report:** commit `reports/part4a-task10-report.md` on a branch made from `origin/planning` named `claude/part4a-task10-report`, and push that too.

## Read first
`sdd/2026-10-01-localdot-core-part4a-keyd-core/` on planning:
- `task-10-brief.md`: your requirements; use its exact values verbatim.
- `global-constraints.md`.
- `progress.md`, for context on Tasks 1–9 as built.

Then read the as-built code (`keyd/internal/*`) where it differs from the brief's quotes.

**As built:**
- **policy (`fb12271`):** bare reserved names are denied; non-ASCII hosts and non-canonical ports give `host-invalid`; a bracketed host gives `ip-literal` or `host-invalid`.
- **scrub:** `New` refuses an empty replacement, and the hold is under 6 × the longest needle.
- **keys (through `70a534e`):**
  - lenient Basic detection, with only canonical Basic swapped;
  - userinfo, opaque targets and fragments are scanned;
  - path-limited bindings refuse `..`-like segments and `?`/`#`;
  - `ApplySwaps` is all-or-nothing;
  - one Basic header may carry one bound `basic-user` plus one bound `basic-password`;
  - `Lookup`/`ForCell` entries share slices, so never mutate them.

## Controller rulings (binding)
1. **Policy:**
   - Add doc comments on `policy.(Policy).Connect` and `PlainHTTP`: `t` must come from `ParseHostPort`.
   - Call sites pass only `ParseHostPort` output.
   - Dial the absolute name (`t.Host + "."`), so search domains never apply. SNI and Host stay without the dot, and netguard remains the backstop.
2. **Relay:**
   - Keep `Content-Length` dropped on scrubbed responses.
   - Scrub trailers at the body's EOF.
   - Never relay an upstream reason phrase.
   - Decode gzip at most one layer (P4a-R10).
   - Scrub 1xx headers through `scrubbedWriter` if you relay them.
   - `scrubberFor` substitutes `keyd-redacted` for a missing surrogate.
3. **Order:** a plain request is inspected for surrogates BEFORE its host is checked. Pin that a surrogate in the host name, path, query, userinfo or a header is refused or alerted before any dial.
4. **Leaks:** errors, logs and audit lines never carry a real value, a full surrogate or the cell token. The 407 audit fires at most once a second (P4a-R12/R13).
5. **Escape hazard:** extract the brief's Go blocks mechanically (awk/sed) and `cmp` them. Build backslash sequences in added tests from a constant.
6. **Network in tests:** loopback `httptest` only.

## Do
- TDD exactly as the brief says, keeping the RED evidence.
- Verify, in `keyd/`:
  - `gofmt -l .`, which must print nothing;
  - `go vet ./...` for linux and `GOOS=darwin`;
  - `go test -race ./...`;
  - `go mod tidy -diff`;
  - at the repo root, `pnpm lint` and `pnpm hygiene`.
- **Hunt for bypasses:**
  - requests reaching an upstream without the cell token, or carrying a surrogate they shouldn't;
  - value or surrogate leaks;
  - reaching hosts the policy refuses: absolute or relative names, a `Host` header that differs from the request-URI host, proxy-form vs origin-form, `Expect: 100-continue`, chunked bodies, hop-by-hop headers such as `Proxy-Authorization` forwarded upstream, and `Connection`-listed headers.
- Mutation-test the egress package on a scratch copy.
- Put pins for real gaps in a test-only `keyd/internal/egress/egress_integrity_test.go` commit.
- Report production changes beyond the brief as concerns; don't apply them.
