# Part 4a Task 10: cell listener (token, self-test name, plain HTTP). Report

**Status: DONE_WITH_CONCERNS**

Branch `claude/part4a-task10`, base `70a534e`. Code commits, oldest first:
- `3d8b34f` feat(keyd): per-cell listener with token auth and plain HTTP. The brief's 7 files are byte-identical: blocks were extracted with awk and each was checked with `cmp`.
- `6ee9d40` docs(keyd): policy decisions take only ParseHostPort targets (ruling 1, doc comments on `Connect`/`PlainHTTP`).
- `0e27bf6` fix(keyd): dial upstream names as absolute names (ruling 1).
  - The transport's `DialContext` appends `.` to a name. IPs and already-dotted names are left alone.
  - Host and SNI keep the name without the dot.
  - The harness's fake resolver and `portMap` now trim the trailing dot, a 6-line change to `harness_test.go`. Without it, 8 brief tests fail.
  - Pin: `TestPlainHTTPDialsTheAbsoluteName`. It was RED before the fix: `dialled "ports.example.test:80"`.
- `1cb8efb` test(keyd): 14 integrity pins in `egress_integrity_test.go` (test-only).
- `ac6d909` fix(keyd): name the parsed host in a plain request's first inspection. This is the coordinator's Task 9 compatibility request; see the merge item below.
- `950c0ac` test(keyd): pin that Close ends pooled upstream connections and that only Basic carries the token (test-only).

## RED / GREEN
- RED: `go test ./internal/egress/` gives `[build failed]`, starting `internal/egress/cell_test.go:38:19: undefined: Cell`, exactly as the brief says.
- GREEN: the brief's code passes its 16 tests with `-race`, stable at `-count=10`.

## Verification (in `keyd/`, go1.27.1)
- `gofmt -l .` prints nothing.
- `go vet ./...` is clean for the host, `GOOS=linux` and `GOOS=darwin`.
- `go mod tidy -diff` is clean.
- `go test -race ./...` passes all 10 packages: 227 tests pass and 4 skip.
- egress: 32 tests (16 from the brief, 16 pins), stable at `-race -count=10` and at `-count=30` for the timing-sensitive pins.
- At the repo root, `pnpm lint` and `pnpm hygiene` both exit 0.
- One flake: `events.TestTheHubSurvivesChurn` failed once (Publish took 201 ms) at load average 7 on 4 cores, with sibling jobs running. It passed on rerun. I did not touch that package.

## Rulings applied
1. Applied as described in the commits above.
2. The brief's relay already does each item. I pinned them: Content-Length is dropped, trailers are scrubbed at EOF (declared and undeclared), the reason phrase is keyd's, gzip is decoded one layer (any case), 1xx headers are scrubbed, and a missing surrogate becomes `keyd-redacted`.
3. A surrogate (known or unknown) is refused and alerted before any dial in each of these places: the host (valid, malformed, denied, wrong port), the path (raw and `%6c`-escaped), the query (raw and escaped), the userinfo user or password, the fragment, and the Authorization, X-Note and Cookie headers. The recording dialer saw 0 dials and there were 28 key.use alerts. A surrogate in the Host header is dropped and never forwarded.
4. No real value, full surrogate or cell token reached the audit lines or events in any pin. The 407 audit is spaced at 1 s, and the count of suppressed refusals is pinned.
5. Blocks were extracted mechanically and checked with `cmp`. The added tests contain no backslash sequences beyond `\r\n`.
6. Tests use loopback `httptest` and raw loopback listeners only.

## Bypass hunt (all on loopback)
**Held:**
- A token is always required.
- Origin-form, `https://`, `ftp://` and `ws://` targets get 400.
- CONNECT gets 405 with the token and 407 without.
- The request-URI decides; a differing Host header is ignored for both policy and forwarding.
- Absolute and relative names: a trailing dot is normalised, single-label names are refused, `keyd.ldot.` and `x.keyd.ldot` are denied.
- `Expect: 100-continue` to a denied host gets 403 with no dial.
- Chunked bodies are re-framed, and chunked plus Content-Length is accepted with the body re-framed correctly.
- A request trailer is not forwarded with its value.
- `Proxy-Authorization`, `Connection`-listed headers, `Proxy-Connection`, `Keep-Alive`, `X-Forwarded-*` and `Forwarded` never reach the upstream.
- `Transfer-Encoding: gzip, chunked` gets 502.

**Gaps:** see the concerns below.

## Mutation testing (scratch copy, 73 compiling mutants of egress)
- With the brief's tests plus the absolute-dial pin, 27 of 64 were killed.
- With all the pins, 61 of 73 are killed.
- The 12 survivors are equivalent or unreachable in Task 10:
  - https or intercept paths, which arrive in Tasks 11 and 12: the upgrade check, the second Inspect, the swap's audit check, and the surrogate-policy alert;
  - upstream TLS, Task 12: MinVersion and the `upstream-tls` reason;
  - no observable effect: answering a client that has gone, `FlushInterval` 0 (Go flushes chunked and SSE anyway), and keeping `Proxy-Authorization` (ReverseProxy strips it);
  - the transport decoding gzip, which cannot happen because keyd sets Accept-Encoding itself;
  - the dot added to dotted names or IPs, which ParseHostPort never produces.
- The brief's `TestRevokeEndsUpstreamRequestsAndKeepsTheListener` passes even with no cancel on Revoke: the 10 s client timeout ends the stream. `TestRevokeEndsStreamsAtOnceAndServesAgain` now pins a stop within 2 s.

## Merge item for the controller
After the Task 9 fix round (`7b92dc4`, `targets()`), `Inspect` refuses an absolute-form target whose host is not `Dest.Host`.
- The brief's first Inspect passed `Dest{Scheme:"http"}` with no Host.
- On a simulated merge, with the keys files from `f552498` overlaid on my keyd, 19 egress tests failed: every plain request was refused as `surrogate-policy` and alerted.
- `ac6d909` parses first, passes `Host: t.Host`, and keeps the parse reason for a bad host unless a surrogate was found.
- With it, the full module passes `-race` on the simulated merge.
- `TestProxyFormRequestsPassInspectionUnderTheirOwnHost` pins proxy-form requests with and without a bound surrogate. It is RED on the merge without the fix.
- Before the merge, the Host field has no effect.

## Concerns (production changes beyond the brief; not applied)
1. **Data race (Important).** The transport's body writer increments `counter.n` (forward.go:340) while `finish` reads it (forward.go:121) when the response comes before the request body has been sent. Example: a 204 or an early answer to a streaming POST. `-race` reproduces it, with 9 reports in 20 requests. Fix: make the count an `atomic.Int64`.
2. **Plain-HTTP upgrade to a bound host is relayed unscrubbed.** `c.intercepted` is never filled in Task 10, so a 101 from `http://<bound host>` passes. The probe showed a secret echoed after the 101 reaching the cell. This needs the secret's own provider to echo it. Fix: refuse an upgrade when `scrubberFor` has any pair, or fill `intercepted` (Tasks 11 and 12).
3. **keys, minor.** The Go server canonicalises header names (`ld_` becomes `Ld_` and the rest is lower-cased), so `Inspect`'s header-name scan never fires. A surrogate in a header name reaches a plain upstream case-folded and without an alert. Fix: scan names case-insensitively.
4. `http.Server` answers `OPTIONS *` itself (200, before `ServeHTTP`), so that request gets no token check and no audit. Nothing reaches an upstream. Fix: `DisableGeneralOptionsHandler = true`.
5. `keyd.ldot` is matched with `strings.EqualFold`, which folds Unicode (U+212A K) and matches on any port. It is internal only and harmless.
6. The progress CARRY has no per-request dial deadline (netguard waits 10 s per answer). It was not among the rulings, so it is not applied.

## Not verified
- Docker suites are N/A for this task.
- macOS was checked only by `GOOS=darwin go vet`; no tests ran on darwin.
- The TLS upstream paths belong to Task 12.
