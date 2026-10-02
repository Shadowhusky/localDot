# Review: keyd Part 4a, Task 9 (the surrogate registry)

Diff: `97bfb65..70a534e` on `feat/core-part4a` (9 commits). This was a read-only review: the probes ran in a scratch worktree at `70a534e` and were deleted afterwards. Go 1.27.1, linux/amd64.

Paths are relative to `keyd/internal/keys/`. Line numbers are at `70a534e`.

## How the review was done

- **Brief fidelity.** I extracted the brief's five Go blocks and compared each one with `cmp` against `6bda612`. All five are byte-identical. `binding_test.go` and `inspect_test.go` are unchanged from `6bda612` to `70a534e`, so no brief test was weakened. Every later change is in `binding.go`, `inspect.go` or the new `keys_integrity_test.go`.
- **Tests.** The keys package has 37 tests. `go test` passes, `go test -race -count=3` passes, `go vet` is clean and `gofmt -l .` prints nothing.
- **Focused probes.** These ran in a temporary `zz_probe_test.go`:
  - about 36 hand-built requests;
  - 8 records;
  - a race test with 8 goroutines running `Mint`, `Inspect`, `ApplySwaps`, `ForCell`, `RevokeCell` and `RevokeSecret` together, under `-race` (clean).

## What I checked (security focus)

- **Inspection completeness.**
  - In the request line: `Host`, the escaped and the decoded path, the raw query and the query decoded escape by escape, the opaque form raw and decoded, the fragment, and the decoded userinfo (`inspect.go:181-185`).
  - In the headers: every name and every value, duplicates included. Header names are searched (`:201`). Bytes are matched exactly, so NUL, CR/LF and non-ASCII bytes neither hide a token nor create one.
  - Canonical Basic is decoded strictly (`:266-277`), and every other spelling is decoded loosely (`:235-260`).
- **Placement** (`:147-176`):
  - a token in the wrong header or the wrong half;
  - a second copy in the URL, another header, a second value or a header name;
  - two secrets in one value;
  - Q1 combinations: the pair, the pair reversed, a user secret with a free password, and a user secret followed by extra colons.
- **Path and method limits** (`:80-118`):
  - `..` in plain, encoded, capital, double-encoded, backslash and overlong-UTF-8 forms;
  - `..%20`, `.%20`, `%20..`, a Unicode slash, and `..` in the fragment;
  - `;` parameters, a trailing slash and prefix boundaries;
  - override headers, including a non-canonical key;
  - `_method` spelled `+_method`, `_method%00` and `_method[]`.
- **`FromRecord` and `LocalRoutes`:**
  - base URLs with an empty port, an encoded slash, `;` or a bare `?`;
  - path prefixes containing `?`, `//` or `/..x`;
  - aliasing.
- **`ApplySwaps`:**
  - every error path, which is only `value()`: `h` stays untouched;
  - Q1 composition;
  - a header changed between `Inspect` and `ApplySwaps`.
- **Registry concurrency** under `-race`.

## Spec Compliance

- ✅ **Interfaces exactly as the brief lists them:**
  - `Format`, `Op` with `ModelFrom`, `Binding` with `Op` and `Permits`, `FromRecord`, `LocalRoutes` and `ValidValueFor` (`binding.go`);
  - `Entry`, `Registry` with `Mint`, `Lookup`, `ForCell`, `RevokeCell` and `RevokeSecret` (`registry.go`);
  - the reasons, `Dest`, `Verdict`, `Inspect` and `ApplySwaps` (`inspect.go`).
- ✅ **Ruling 1: one surrogate, alone, exactly in its place** (`inspect.go:147-176`).
  - Exactly one occurrence is required, in the bound header, with exactly one value for that header.
  - Raw and Bearer need exact equality. Two in one value, extra text, the same surrogate twice, another header, a second instance of the bound header and the URL are all refused. My probes and the 66 + 54 + 10 pins agree.
  - **Exception:** surrogates hidden in a non-canonical Basic spelling that the loose decoder misreads. See Important 1.
- ✅ **Q1** (`inspect.go:165-173`, `:295-305`).
  - The bound user plus the bound password in canonical Basic is allowed with 2 swaps.
  - The pair reversed is refused, as are wrong formats, a different host and another cell.
  - A single user secret with a free password half is allowed, as the brief's "basic user" case requires.
- ✅ **Ruling 2.** `bound` matches `Dest.Host` exactly against hosts that `policy.ValidBindingHost` accepted (`inspect.go:144`, `binding.go:227-231`), so an un-normalised `Dest.Host` fails closed.
  - ⚠️ That `Dest.Host` always comes from `policy.ParseHostPort` is up to Task 10's callers.
- ✅ **Ruling 3: no value and no full surrogate in errors.**
  - Verdicts name a surrogate by `surrogate.ID` only (`inspect.go:54-57`).
  - The package does not log.
  - `ApplySwaps` reads every value before it writes any header, so an error leaves `h` untouched (`inspect.go:281-311`).
- ⚠️ **C1: lenient Basic detection is incomplete** (`inspect.go:212-216`, `:235-260`). Only canonical Basic is swapped (`:266-277`, which also refuses U+017F and set padding bits). But detection joins every field and decodes the result once, so a token in a field after a misaligned chunk is never seen. See Important 1.
- ✅ **C2.** Userinfo (decoded), the opaque form (raw and decoded) and the fragment are scanned (`inspect.go:181-185`). Probed with plain and escaped userinfo: both refused.
- ✅ **C3** (`inspect.go:92-103`):
  - no decoded `?` or `#`;
  - no segment led by `..`;
  - the escape check covers both `RawPath` as sent and `EscapedPath()`.
  - Probes: `..` in the fragment, a Unicode slash and a trailing `..` are all refused.
- ✅ **C4.** Ops are cloned per binding (`binding.go:148`, `:193`). Hosts, Methods and Paths are cloned (`:263-267`). `Upstream` is parsed fresh each time.
  - Not done: copying in `Mint`, `Lookup` and `ForCell`, which the controller deferred as a minor.
- ✅ **C5.** `badBaseURL` returns a fixed reason and never echoes the URL (`binding.go:198-217`).
- ✅ **Brief tests intact.** `TestInspect` (50 cases), `TestApplySwaps`, `TestRegistry` and the binding tests are unchanged and passing.

## Strengths

- **Fail-closed structure.** `Inspect` looks up every token it finds and refuses on the first fault. `placed` re-derives the placement from the header itself rather than trusting the occurrence list.
- **Canonical-only swapping is clean.** `decodeBasic` with `StdEncoding.Strict()` and an exact 5-byte scheme check means a non-canonical spelling can only be refused, never rewritten.
- **`ApplySwaps` is all-or-nothing by construction.** It collects into `set`, then writes; nothing in the write loop can fail. Its pins cover four orderings.
- **Pins and fuzz.** The integrity pins are thorough and each targets a mutant. The fixed-seed path fuzz (`keys_integrity_test.go:948`) uses an independent percent-decoder and has a floor on allowed paths, so it cannot pass vacuously.
- **Honest report.** It separates applied fixes from residuals (R1–R5) and carries (K1, K2), and those claims held up in my probes: double encoding, non-Basic encodings and PHP-mangled `_method` all behave as the report says.

## Issues

### Critical

None. No probe got a real value into anything but its bound header, on its bound host, in its bound format.

### Important

**1. The loose Basic decoder misses a surrogate that follows a misaligned field, so it escapes unflagged (`inspect.go:235-260`, used at `:212-216`).**

- **What happens.** `looseBasic` joins every field after the scheme and runs a single raw base64 decode over the result. When an earlier field's length is not a multiple of 4 after filtering, every later field is decoded out of alignment, and a surrogate there is never found.
- **Probe results.** `A = base64("x:" + passSurrogate)`, sent to an unbound host:
  - `Authorization: Basic Z <A>` → `allow=true, swaps=0`.
  - `Authorization: Basic Zm9vOmJhcg==, Basic <A>` → `allow=true, swaps=0`.
  - Sent to the bound host, the first value is also allowed with 0 swaps, with the surrogate in it unswapped.
- **Why it matters.** Ruling C1 says a surrogate in any non-canonical Basic form refuses the request. A server that takes the last field (`split(' ').pop()`) or reads a comma list decodes `<A>` and sees the surrogate, so a surrogate leaves for an unbound destination without an alert. That is the "surrogate escapes unflagged" failure this task exists to stop. No real value is swapped, which is why this is Important rather than Critical.
- **Fix.** Search more than one decoding: the joined form as now, each whitespace- or comma-separated field decoded on its own, and each `=`-delimited chunk decoded on its own. A token in any of them becomes a non-Basic occurrence. Pin both probe values above, and a token in field 2, 3 or 4 after fields of each length modulo 4.

### Minor

**1. `ApplySwaps` writes the real value without checking that the header still holds the surrogate (`inspect.go:289-305`).**

- A caller that changes `h` between `Inspect` and `ApplySwaps` gets the real value written anyway. The probe produced `Bearer REAL` after the header had been changed to `Bearer something-else`.
- For Basic, a header that no longer decodes yields `Basic base64(real:)`.
- **Fix:** before writing, confirm each bound header still equals what `Inspect` saw (or re-run `placed`), and return an error otherwise. This is cheap defence in depth for Tasks 10, 12 and 14.

**2. Q1 composition re-parses its own output (`inspect.go:295-305`).**

- The password swap decodes the header the user swap just wrote and splits it at the first colon. If a real basic-user value contained a colon, it would be cut short. The probe gave `real:realpw` for user value `real:user`. Nothing leaks.
- **Fix:** decode the original header once, swap the halves, and encode once. Also make sure Task 16 calls `ValidValueFor` when a secret is stored.

**3. Swaps are keyed by `SecretID` only (`inspect.go:284`).**

- If a secret is replaced between `Inspect` and `ApplySwaps`, the new value is sent under the old binding's hosts. `RevokeSecret`'s doc comment says it guards against exactly this.
- **Fix:** carry a secret version or generation in `Entry` and have `value()` check it, or record as a carry for Tasks 10 and 16: revoke, then replace, while holding a lock the swap path also takes.

**4. `badBaseURL` lets through hosts and paths it means to refuse (`binding.go:206`, `:214`).**

- `https://api.example.test:/v1` is accepted, because `Port()` is empty for an empty port. `Upstream` then keeps `host:`.
- `https://api.example.test/v1%2fadmin` passes the clean-path check, which only looks at the decoded path, but `Upstream.String()` sends `/v1%2fadmin`.
- These URLs are the user's own configuration, not something a cell controls.
- **Fix:** require `u.Host == u.Hostname()`, and `u.RawPath == ""` or `u.EscapedPath() == u.Path`.

**5. `FromRecord` accepts path prefixes that can never match (`binding.go:256`).**

- Prefixes containing `?` or `#`, `//`, and `/..x` are accepted. Since C3, `Inspect` refuses every request path such a prefix would need, so the binding silently permits nothing.
- **Fix:** refuse `?`, `#` and `..`-led segments in prefixes, matching `unambiguousPath`.

**6. Registry aliasing (`registry.go:27-34`, `:39-56`; deferred by the controller).**

- `Mint` stores the caller's `Binding` as given, and `Lookup` and `ForCell` return entries that share its slices and `*url.URL`.
- **Fix:** clone at `Mint` and on the way out.

**7. Surrogates show in default formatting (report C6).**

- `Entry` and `Verdict` (through `Swaps`) print the full surrogate under `%v`.
- **Fix:** give `Entry` a `Format` or `String` method that prints `surrogate:<ID>`.

**8. Limits are taken from `Dest` alone (`inspect.go:62`, `:87`).**

- `Inspect` never compares an absolute-form `u.Host` with `d.Host`. The probe allowed `https://evil.example.test/v1/x` with `Dest.Host = ro.example.test`.
- This is correct only if Tasks 10 and 12 always forward to `Dest`.
- **Fix:** refuse when `u.Host != ""` and `u.Host != d.Host`, or carry the rule to Task 10 as an explicit contract.

**9. Leading-space dot segments pass a path limit.**

- `/v1/%20../admin` passes the path limit, because the segment ` ..` does not start with `..`. No common server is known to strip leading spaces from segments.
- **Fix:** refuse decoded spaces in limited paths, which are rare in APIs.

## Assessment

**Task quality: Needs fixes**

**Reasoning:**

- The brief's code is in byte for byte, and the fixes for ruling 3 and C2–C5 are correct and well pinned.
- No bypass gets a real value out of its bound place, and atomicity and concurrency hold.
- But C1 as ruled ("a surrogate in any non-canonical Basic form refuses the request") is not fully met. A surrogate in a later field after a misaligned base64 field (`Basic Z <b64>`, or a comma-joined second credential) escapes unflagged to any destination (Important 1).
- That is a small, local fix to `looseBasic` plus pins. Minors 1–3 are worth folding into the same round as defence in depth for the swap path. The rest can be deferred or carried.
