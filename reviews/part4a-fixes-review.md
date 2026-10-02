# Re-review: keyd Task 9 fix round, Task 10 and Task 10 fix round

Diff: `70a534e..18e2a47` (`origin/claude/part4a-task10-fix` without its report commit). This range holds the Task 9 fix round (`c918f27..b11c3ac`), Task 10 (`3d8b34f..950c0ac`), their merge (`b5e80a4`) and the Task 10 fix round (`30b5e59..18e2a47`). Review tier: `full`. The review was read-only. Probes ran in a scratch worktree at `18e2a47` under `/tmp/job-review-part4a-fixes/`, which was deleted afterwards. Go 1.27.1, linux/amd64, 4 cores shared with other jobs.

Paths are relative to `keyd/internal/`. Line numbers are at `18e2a47`.

## How the review was done

- **Brief fidelity (Task 10).** I extracted the brief's 7 Go blocks with awk and diffed each one against `18e2a47`.
  - `cell_test.go` and `deps.go` are byte-identical.
  - `harness_test.go` differs only by the documented 6-line trailing-dot trim in the fake resolver and `portMap`. No assertion changed.
  - `generation.go`, `cell.go`, `internal.go` and `forward.go` differ only by the ruled changes: the absolute dial, `isInternal`, `DisableGeneralOptionsHandler`, the parsed host in the first `Inspect`, `refusesSwitch`/`boundTo`/`errSwitch` and the atomic counter.
- **Brief tests (Task 9).** `keys/binding_test.go` and `keys/inspect_test.go` are unchanged from `70a534e` to `18e2a47`, so no brief test was weakened.
- **The merge (`b5e80a4`).**
  - `git diff b11c3ac b5e80a4 -- keys/` is empty.
  - `git diff 950c0ac b5e80a4 -- egress/ policy/` is empty.
  - The two sides touch disjoint files, so the merge is their exact union: nothing was lost or applied twice.
- **Tests.**
  - `go test -race ./...`: all 10 packages pass.
  - keys and egress pass at `-race -count=3`. keys has 47 tests and egress has 39, matching the report.
  - The toolchain's `gofmt -l .` prints nothing.
  - `go vet ./...` is clean for linux and for `GOOS=darwin`.
  - `go mod tidy -diff` is clean.
- **RED replay.** With `b5e80a4`'s `forward.go` swapped in, `TestAnEarlyAnswerDoesNotRaceTheRequestBodyCount` fails under `-race` with 10 race reports (`forward.go:121` against `:340`). At `18e2a47` it passes.
- **My own mutants.** I wrote 30 mutants of the changed code, applied each one in the scratch tree and ran its package (egress under `-race`). **All 30 are killed**, and each is killed by the pin meant for it:
  - `refusesSwitch` without the bound-host clause;
  - the pre-dial upgrade check off, and the 101 check off;
  - `isUpgrade` ignoring `Upgrade`;
  - a bad host hiding the surrogate alert;
  - the first `Inspect` without a host;
  - no `Connection: close` on the 502, and `errSwitch` mapped as `upstream-error`;
  - the OPTIONS handler back on;
  - `isInternal` taking non-ASCII or any port;
  - no absolute dial;
  - names not lower-cased, the fold not resolved, and `lookupFolded` matching exactly;
  - `targets` off, and `targets` using a suffix match;
  - `looseBasic` with only the first field or only one alignment;
  - `ApplySwaps` without its foreign-surrogate check or its placement check;
  - Basic halves not taken from the header;
  - a space allowed in a limited path;
  - an empty port allowed, an escaped base path allowed, and a `//` prefix allowed;
  - `Methods` or `Upstream` not cloned, and `Lookup` returning without a clone;
  - `Format` printing the token.
- **Probes.** These ran in temporary `zz_probe_test.go` files in keys and egress:
  - about 40 hand-built `Inspect` cases;
  - raw loopback requests to the listener: trailers, 101 answers, websocket and Revoke, 2,000 connections, slowloris, and 1 MiB headers;
  - two concurrency probes under `-race`:
    - keys: 8 goroutines running `Mint`, `Inspect` with folded names, `ApplySwaps`, vandalising `ForCell` results, `RevokeSecret` and `RevokeCell`;
    - egress: 6 goroutines sending upgrades to a host while a seventh binds and deletes its secret and calls `Revoke` every 20 ms, for 2,412 requests in all.

    Both were clean under `-race`.

## 1. Task 9 review items

| Item | Verdict | Evidence (pin, then my probe) |
|---|---|---|
| **I1** loose Basic after a misaligned field | **Fixed** | Pin `TestABasicCredentialIsSearchedHoweverAServerSplitsIt` covers 2,520 values. Probe: `Basic Z <A>` and `Basic Zm9vOmJhcg==, Basic <A>` are now denied `misplaced-surrogate` on the bound and the unbound host, as are `basic\t\tZm9\v<A>`, `…==;<A>`, `Zm9v%3D<A>`, `<A>===`, a credential split mid-blob, and NBSP after the scheme. Mutants "first field only" and "one alignment" are killed. The implementer's argument that the joined form at 4 alignments already finds every contiguous blob holds: a blob at letter offset k is byte-aligned by the shift ≡ k (mod 4). |
| **m1** `ApplySwaps` re-checks placement | **Fixed** | Pin covers 12 changes. Probe: a changed bearer value errors and `h` is untouched. A non-canonical duplicate key (`h["authorization"]`) is also refused. |
| **m2** Q1 composition | **Fixed** | Probe: user `real:user` plus password `real:pw` decodes to exactly `real:user:real:pw`. |
| **m3** swaps keyed by SecretID | **Not fixed (carried by ruling)** | `progress.md:202` carries it to Task 16. The `ApplySwaps` signature is unchanged. |
| **m4** `badBaseURL` | **Fixed** | Probe with `openai-compatible`: `host:/v1`, `%2f`, `%2F`, `%2e%2e`, `v%31` and `:443` are refused. `/v1%20x` is accepted with a consistent `Upstream` (report concern 5). See Minor 3 for the IPv6 wording. |
| **m5** unmatchable prefixes | **Fixed** | Probe: `?`, `#`, `//`, `/..x`, `/v1/..` and a space are refused, while `/v1/`, `/a..b` and `/v1/.x` are accepted. |
| **m6** registry aliasing | **Fixed** | Probe: vandalising the `Mint` result, the `Lookup` result and the `ForCell` results leaves the stored hosts intact. A `-race` probe that vandalises `ForCell` concurrently is clean. |
| **m7** surrogates in `%v` | **Fixed** | Probe: 8 verbs on a `Verdict`, a `*Verdict`, `[]*Entry` and `map[string]Entry` never print the token or its hex. `%v` prints `[surrogate:<ID>]`. |
| **m8** absolute-form host ≠ `Dest.Host` | **Fixed** | Probe: `evil.example.test`, a suffix trick and userinfo-then-evil are refused, and `RO.example.test.` is allowed. Only the host is compared, so `:8443` is allowed (report concern 2). That is safe here, because `servePlain` forwards to the parsed target, whose port policy pins to 80. Task 12 must keep that property. |
| **m9** spaces in limited paths | **Fixed** | Probe: `/v1/%20../admin`, `/v1/x%09` and `/v1/a b` are denied `surrogate-policy`. |

## 2. Task 10 against its brief and the six rulings

- ✅ **Interfaces** as the brief lists them. `Open` refuses a token under 32 characters and a busy port (`ErrPortInUse`).
- ✅ **Ruling 1.**
  - `Connect` and `PlainHTTP` carry the doc comment (`policy/policy.go:58-60`, `:71-72`).
  - The only policy call site, `PlainHTTP(t)` at `egress/forward.go:59`, takes `ParseHostPort` output.
  - `generation.go:302-304` dials `absolute(address)`, while Host and SNI keep the name without the dot. Pinned, and the mutant is killed.
- ✅ **Ruling 2.** The brief's relay already does every item, and the Task 10 pins cover each one.
- ✅ **Ruling 3: order.** `forward.go:48-57` refuses on `Inspect`'s verdict first whenever a surrogate was found, and only then on the parse reason. A mutant that lets a bad host hide the alert is killed by the brief's `TestSurrogateTextNeverReachesTheAuditOrTheEvents`.
- ✅ **Ruling 4: leaks.**
  - The 407 audit is spaced at 1 s and its suppressed count is pinned.
  - In my probes, neither the audit file nor the events held a token or a real value, trailer probes included.
  - `Detail` carries only transport error text. Plain HTTP never swaps, so no real value is ever in a header that could reach it.
- ✅ **Ruling 5.** Extraction and diff as above.
- ✅ **Ruling 6.** Tests use the fake resolver and loopback listeners only. Nothing uses `net.DefaultResolver`.

## 3. Task 10 fix round (5 items)

- ✅ **Item 1: atomic counter** (`forward.go:367-376`). RED replayed, GREEN at `-race -count=3`.
- ✅ **Item 2: upgrade to a bound host** (`forward.go:74-78`, `:141-144`, `:182-184`, `:214-231`). I tried to bypass it four ways:
  - **The pre-dial check is a superset of ReverseProxy's own detection.** `isUpgrade` takes any `Upgrade` value, or `upgrade` as a substring of any `Connection` value. `upgradeType` needs the `Upgrade` token in `Connection` plus a non-empty `Upgrade`.
  - **The 101 check is a backstop for every case.** It runs in `ModifyResponse` before `handleUpgradeResponse`. Probe: a bound host answering 101 to a plain GET with no upgrade asked gets 502, and the echo is not relayed.
  - **The concurrency probe found no leak.** While a secret was bound and unbound every 20 ms, with `Revoke` between, 2,412 requests produced no 101 that carried the echo.
  - **Revoke ends an allowed websocket tunnel to an unbound host.** Probe: the upstream side closes and the client reads EOF.

  The remaining window is a secret bound after the 101, which the fix report records as concern 1 (carry, below).
- ✅ **Item 3: surrogate in a header name** (`keys/inspect.go:57-63`, `:233-235`; `keys/registry.go:70-79`). Probe: the raw, upper-case, canonical, `X-` prefixed and glued spellings of a known token are each denied `misplaced-surrogate` under the token's own ID. `ApplySwaps` refuses them too. Pinned through the listener. See Important 1 for the cost of `lookupFolded`.
- ✅ **Item 4: `OPTIONS *`** (`cell.go:85`). It now goes through the token check. The mutant is killed.
- ✅ **Item 5: `keyd.ldot`** (`internal.go:13-17`). U+212A, any port other than `:80`, `:080` and an empty port all go to `servePlain`, which refuses them. Both mutants are killed.

## 4. The merge and the `Dest.Host` contract

- **The merge.** It is an exact union of the two parents (see the method above). `ac6d909` made the first `Inspect` pass `t.Host`, so after the merge proxy-form requests are not refused by Task 9's `targets()`. That is pinned by `TestProxyFormRequestsPassInspectionUnderTheirOwnHost`, and the "no host" mutant breaks 3 brief tests.
- **The `Dest.Host` contract.** `Inspect` has three paths, and each holds:
  - `servePlain` → `ParseHostPort(r.URL.Host, 80).Host` (`forward.go:48-49`);
  - `forward` → `rt.dest`, built from the same `t.Host` (`:64`, `:79`);
  - `serveInternal` never inspects, and nothing leaves keyd on that path.

  `ApplySwaps` is reached only from `swap`, after an allowed `Inspect` on the same `r.Header`.

## 5. Fresh security hunt (listener and keys)

**Held:**
- **No token, no upstream.** Every request goes through `authorize` before anything else, `OPTIONS *` included. Pipelined requests are checked one by one.
- **The token.** It is deleted before `Inspect` and never logged. A surrogate hidden in the `Proxy-Authorization` user half is dropped with the header.
- **Request trailers.** A surrogate in a declared or undeclared request trailer never reaches the upstream. The upstream saw `X-Leak: []` or nothing (K2 holds at `18e2a47`).
- **Slow headers.** A slowloris on the headers is closed at 10 s (`ReadHeaderTimeout`).
- **Races.** None, under the two concurrency probes above.

**Gaps:** Important 1 and 2 and Minors 1–4 below.

## Strengths

- **Faithful rounds.** Each fix round did exactly what was ruled, each item has a pin that fails on its base, and the RED evidence I replayed matches.
- **`refusesSwitch` reuses `boundTo`.** It shares `boundTo` with `scrubberFor`, so the scrub set and the upgrade refusal cannot drift. The second check at the 101 closes the time-of-check gap a pre-dial check alone would leave.
- **Fold resolution keeps the real ID.** A header-name hit resolves to the registered token, so the alert names the real secret and surrogate ID instead of a lower-cased stranger.
- **Honest reports.** Each report records the stricter-than-ruled choices: `ApplySwaps` refusing foreign surrogates, `Connection: close` on the pre-dial 403, and the space in prefixes. Residuals and carries are listed, not hidden.

## Issues

### Critical

None. No probe got a real value or an echoed secret to the cell or to a host it is not bound to, and no request reached an upstream without the token.

### Important

**1. Inspection is quadratic in the number of surrogate shapes, so one request from a cell costs keyd seconds of CPU (`keys/inspect.go:260-268`, `keys/inspect.go:57-63` with `keys/registry.go:70-79`, `egress/cell.go:79-86`).**
- **What happens.**
  - `order` deduplicates with `slices.Contains` over a growing slice, which is O(n²) in occurrences.
  - The cell listener sets no `MaxHeaderBytes`, so Go's default of about 1 MiB applies.
  - The fix round's `lookupFolded` adds a linear registry scan, with a `ToLower` per entry, for every header-name occurrence.
- **Probe (through the listener).** An authenticated `GET http://free.example.test/` carrying 16 headers of 1,800 distinct token shapes each (1,037,098 bytes) answers `403 unknown-surrogate` after **2.4 s**. Four of them in parallel take 2.6–3.1 s each and keep all 4 cores busy.
- **Probe (in the keys package).** Inspecting 27,000 header names takes 2.0 s with a 1-entry registry and 3.3 s with a 200-entry registry. `order` alone takes 2.1 s, and 29,125 value tokens take 2.2 s. The listener's per-header memory accounting limits how many names fit, so values are the worst case in practice.
- **Why it matters.** A cell's CPU is capped by its container, but keyd's is not. About 1 MB of request buys about 2.4 s of host CPU, repeatable from every connection. The audit line and the event fire once per request, so nothing slows the cell down. `order` comes from the brief, but Task 10 is what exposes it to cells.
- **Fix.**
  - Deduplicate in `order` with a `map[string]bool`.
  - Resolve folded tokens through a lower-case index kept by `Mint` and the revokes, or lower-case once per call.
  - Set `MaxHeaderBytes` on the cell's `http.Server`. 64 KiB is plenty for API traffic.
  - Optionally, refuse a request with more than about 64 token shapes before resolving any.
- **Pin.** The 1 MiB request above is answered in well under a second, and stays so at `-count=3`.

**2. Connections without the token stay open, with no cap per cell (`egress/cell.go:79-86`, `:165-179`).**
- **What happens.** A 407 leaves the connection in keep-alive, and `IdleTimeout` is 2 minutes. Nothing limits the number of connections a listener accepts.
- **Probe.** 2,000 loopback connections each sent one request without the token. All 2,000 got 407, and all were still open 12 s later, past `ReadHeaderTimeout`. The test process went from 10 to 4,010 file descriptors (both ends are counted).
- **Why it matters.**
  - The brief notes that any container with egress can reach the listener through `host.docker.internal`, and this needs no token at all.
  - keyd's file descriptors are shared by every cell's listener, its upstream dials, the audit log and the vault.
  - One client re-sending a request every 2 minutes can hold descriptors until keyd cannot accept or dial for any cell. Everything still fails closed, so this is availability only.
  - Unverified here: whether Docker Desktop's port proxy caps connections before keyd sees them.
- **Fix.**
  - Set `Connection: close` on every 407 in `refuseAuth`, so a client without the token holds a connection for at most `ReadHeaderTimeout`.
  - Cap accepted connections per cell, for example with `netutil.LimitListener` at 256, or a counter in `ConnState`.

  If the controller prefers to carry the cap to M9's per-cell budget, the `Connection: close` line alone is the minimum for this round.
- **Pin.** A 407 answer carries `Connection: close` and the server closes the connection. Connection N+1 over the cap waits or is refused while N are open.

### Minor

**1. A record that `FromRecord` refuses is neither scrubbed nor protected from upgrades (`egress/forward.go:219-231`).**
- **What happens.** `boundTo` skips any record `FromRecord` refuses, so its secret is not scrubbed and its hosts take upgrades. `vault.Put` does not validate with `FromRecord`.
- **When it matters.** Since Task 9's fix round, a stored HTTP record with, for example, a `//` path prefix is valid for the vault but skipped here. No surrogate can be minted for it, so keyd never sends the value. An echo needs the provider to know the value from elsewhere.
- **Fix:** match `rec.Hosts` directly for HTTP records and fail closed on a parse error, or carry it to Task 16: `putSecret` must run `FromRecord` before `Put`.

**2. `c.intercepted` is read with no lock (`egress/forward.go:215`, brief code at `egress/cell.go:60`).**
- **What happens.** `refusesSwitch` now reads it on every upgrade. Nothing writes to it today.
- **Carry to Tasks 11 and 12:** fill it under `c.mu`, or swap in a copy atomically. Otherwise `-race` will flag the first writer.

**3. `badBaseURL` gives an IPv6 literal the port reason (`keys/binding.go:219`).**
- `https://[::1]/v1` is refused as "must not name a port", because `u.Host` (`[::1]`) is not equal to `u.Hostname()` (`::1`). The URL is still refused; only the message misleads the key form.
- **Fix:** check the host before the port, or compare against `u.Port() != ""` and `strings.HasSuffix(u.Host, ":")`.

**4. A Basic scheme glued to its credential is not searched (`keys/inspect.go:276-280`).**
- `Basic<b64(x:surrogate)>` and `Basic:<b64>` are allowed with 0 swaps to an unbound host, because `looseBasic` needs `Basic` as a whole field. Servers that strip a `basic` prefix with a regexp read these spellings.
- This is the same class as the accepted `Basicx` row and R1 (base64 in non-Basic forms), so it is a Minor.
- **Fix:** also accept a field that begins with `basic` in any case followed by a non-letter, and decode the rest.

### Carries confirmed (no new action)

- **Task 9, m3, to Task 16.** Replace a secret under a lock, or with a generation number.
- **Task 10 fix, concern 1, to Task 16.** A secret bound after a 101, or mid-stream, does not end that tunnel or stream. Revoke the affected cells' generations when a binding changes.
- **Task 10 fix, concern 3, to Tasks 11 and 12.** The bound-host upgrade refusal is broad, and lifting it is their call.
- **The per-request dial deadline** is still carried (progress CARRY).
- **m8, port.** `targets` compares hosts only. Task 12 must forward to the parsed target, never to `u`'s port.

## Assessment

**Verdict: FIXES_NEEDED**

All Task 9 review items are fixed (I1, m1, m2, m4–m9) or carried by ruling (m3). Task 10 matches its brief and all six rulings. All five fix-round items are applied, pinned and mutation-tight, and the upgrade refusal held every bypass I tried. The merge is clean, and `Dest.Host` comes from `ParseHostPort` on every path.

The fresh hunt found two availability gaps that a cell, or any container, can reach through the listener this task opens. Both fail closed.

**Exact list for the fix round:**
1. **Important 1.**
   - Deduplicate `order` with a map.
   - Index or lower-case the folded lookup once.
   - Set `MaxHeaderBytes` (about 64 KiB) on the cell listener.
   - Pin: a 1 MiB header full of token shapes is answered quickly.
2. **Important 2.**
   - Set `Connection: close` on every 407.
   - Cap connections per cell.
   - Pin both. If ruled, the cap may go to M9's per-cell budget with the 407 close kept here.

Minors 1–4 can be batched to the part's final review. Minor 1 can instead be folded into Task 16's `putSecret`, and Minor 2 into Tasks 11 and 12.

## Not verified

- **macOS.** No darwin test run; only `GOOS=darwin go vet`. The descriptor limit and the Docker Desktop port proxy were not tested on macOS.
- **Docker.** Not available, and keyd has no Docker suites.
- **Keychain.** The opt-in keychain test (`KEYD_KEYCHAIN_TEST=1`) was not run.
- **Repo root.** `pnpm lint` and `pnpm hygiene` were not re-run, because the diff touches only `keyd/` Go files. The fix report says both exit 0.
