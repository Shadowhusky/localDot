# keyd Task 9 (surrogate registry), fix round 1: report

**Status: DONE_WITH_CONCERNS** (all items applied and pinned; the concerns are integration notes for Task 10 and the merge, listed at the end)

Branch `claude/part4a-task9-fix`, base `70a534e`. Minor 3 was not applied: it is carried to Task 16, and the `ApplySwaps` signature is unchanged.

## Commits

| sha | commit | items |
|---|---|---|
| `c918f27` | fix(keyd): search a loose Basic credential however a server may split it | Important 1 |
| `2e89756` | fix(keyd): swap only surrogates still in place, decoding a Basic header once | Minors 1, 2 |
| `7b92dc4` | fix(keyd): refuse a target host other than the destination and spaces in limited paths | Minors 8, 9 |
| `66bc3fc` | fix(keyd): refuse empty base URL ports, escaped base paths and unmatchable prefixes | Minors 4, 5 |
| `b11c3ac` | fix(keyd): hand out copies of bindings and print entries as surrogate:<ID> | Minors 6, 7 |

Each commit holds its fix and its pins, and each was checked twice: its pins fail on the code before the fix, and the whole package passes after it. Only `binding.go`, `inspect.go`, `registry.go` and `keys_integrity_test.go` change. `binding_test.go` and `inspect_test.go` (the brief's tests) are unchanged from `70a534e`.

## RED evidence

I ran the final `keys_integrity_test.go` against the `70a534e` versions of `binding.go`, `inspect.go` and `registry.go` (in a scratch copy). **Exactly the 9 new tests fail, and the 37 existing tests pass.** Failing assertion lines per test:

| test | item | failing lines on 70a534e |
|---|---|---|
| TestABasicCredentialIsSearchedHoweverAServerSplitsIt | I1 | 1904 |
| TestApplySwapsRefusesAHeaderChangedSinceInspect | m1 | 12 |
| TestBasicHalvesAreSwappedFromTheOriginalHeader | m2 | 2 |
| TestABaseURLNamesNoPortAndNoEscapes | m4 | 6 |
| TestPathPrefixesAreOnlyThoseALimitedPathCanMatch | m5 | 14 |
| TestTheRegistryHandsOutCopies | m6 | 25 |
| TestEntriesPrintOnlyTheSurrogateID | m7 | 94 |
| TestTheURLHostIsTheDestination | m8 | 17 |
| TestALimitedPathRefusesSpaces | m9 | 8 |

Sample lines on 70a534e:
- `"Basic Z <b64>" to unbound.example.test: {Allow:true … Swaps:[]}`
- `"Basic Zm9vOmJhcg==, Basic <b64>" to unbound.example.test: {Allow:true …}`
- `a bearer value replaced: ApplySwaps wrote map[Authorization:[Bearer real-bearer-value]]`
- `a surrogate sent to https://evil.example.test/v1/x: {Allow:true …}`
- `limited path "/v1/%20../admin": {Allow:true …}`
- `%v of an entry = "{ld_key_… …}"`

**GREEN:** all 46 tests pass at `b11c3ac`.

## Per item

**I1: `looseBasic`** (`inspect.go`)
- **Change.** `looseBasic` now returns every decoding of the credential:
  - the joined form;
  - each field on its own (fields end at whitespace or a comma);
  - each `=`-delimited chunk of the joined form;
  - each of these at all 4 base64 alignments.
- **Scheme.** The `Basic` scheme is now recognised as any field, not only the first, so `Bearer x, Basic <b64>` is searched too.
- **Result.** A token found in any decoding is a non-canonical occurrence, so `placed` refuses it.
- **Pin.**
  - The review's two probes, plus 4 more spellings, are sent to a bound and an unbound host; all are denied `misplaced-surrogate`.
  - An unknown surrogate after a misaligned field is denied `unknown-surrogate`.
  - A credential sits in field 2, 3 or 4 after fields of every combination of lengths 1–4 (all 84 combinations). This runs under 5 separators and 3 encodings (padded, unpadded, URL-safe with no colon), against both hosts: 2,520 values. Every one must be denied, naming that surrogate's ID.

**m1: `ApplySwaps` re-checks placement** (`inspect.go`)
- **Change.** Before reading any value, `ApplySwaps` re-scans `h` and runs `placed` for every swap. It also refuses if the headers hold any surrogate that is not one of the swaps, which is stricter than the ruling but matches what an allowed `Inspect` leaves behind.
- **Error text.** Errors name `surrogate:<ID>` only.
- **Atomicity.** It is still all-or-nothing: on a refusal no value is read and no header is written.
- **Pin.** 12 changes made after `Inspect`:
  - a value replaced, suffixed or put under another scheme;
  - a header removed or given a second value;
  - a copy in another header;
  - the second of two raw headers changed;
  - Basic: no longer decodes, half moved, half replaced, one half of a pair replaced, another surrogate added.

  Each must return an error with `h` unchanged, 0 value reads, and no surrogate in the error.

**m2: Q1 composition** (`inspect.go`)
- **Change.** The original header is decoded once, both halves are replaced, and the result is encoded once.
- **Pin.**
  - `ValidValueFor` accepts the password `real:password:value` and refuses the user `real-user:value`.
  - Three combinations, in both swap orders, must produce `basicOf(user, pass)` exactly. On 70a534e, the user with a colon was cut when the user swap ran first.
  - A password with colons under a free user half.

**m4: `badBaseURL`** (`binding.go`)
- **Change.**
  - `u.Host != u.Hostname()` is reported as "must not name a port".
  - New case: `u.RawPath != "" && u.EscapedPath() != u.Path` is reported as "path must not hold escapes".
  - The reasons are fixed text.
- **Pin.**
  - Refused: `host:/v1`, `/v1%2fadmin`, `/v1%2Fadmin`, `/v%31`, `/%2e%2e/v1` (plus two that embed a fake secret). Each error must not contain the secret, the host or a `%`.
  - Still accepted: four clean base URLs, with `Upstream` checked.

**m5: path prefixes** (`binding.go`)
- **Change.** `FromRecord` also refuses `?`, `#`, a space, `//` and any `/..` (a segment led by `..`).
- **Note.** The space goes beyond the listed set. I added it to match m9, since a prefix with a space could never match.
- **Pin.**
  - 14 refused prefixes.
  - 7 accepted prefixes (`/`, `/v1`, `/v1/`, `/v1/a..b`, `/v1/.well-known/`, …). Each one also allows a real request under it.

**m6: registry copies** (`binding.go`, `registry.go`)
- **Change.** `Binding.clone` copies `Hosts`, `Ops`, `Methods`, `Paths` and `*Upstream`. `Mint` stores a clone and returns another, and `Lookup` and `ForCell` return clones. `Inspect` uses `Lookup`, so verdict swaps are copies too.
- **Pin.** For an HTTP binding and an LLM binding, the test vandalises in turn:
  - the binding given to `Mint`;
  - the entry `Mint` returned;
  - the `Lookup` result;
  - the `ForCell` results;
  - verdict swaps.

  After each one, the stored binding must be intact and `Inspect` must still allow GET `/v1/x`, refuse DELETE (policy) and refuse another host.

**m7: printing** (`registry.go`)
- **Change.** `Entry.String()` returns `surrogate:<ID>`, falling back to `surrogate.ID(Token)` when `ID` is empty. `Entry.Format` prints that under every verb, so `Verdict` (through `Swaps`), slices, maps and pointers never print a token.
- **Pin.** 9 verbs (`%v %+v %#v %s %q %x %X %d`, `%T %v`) on an entry, a pointer to one, a slice, a map, a verdict, a pointer to a verdict and a struct holding an entry. None may contain the token, `ld_` or the token's hex, and the text verbs must name `surrogate:<ID>`.

**m8: target host** (`inspect.go`)
- **Change.** After the surrogate checks, an absolute-form `u.Host` must equal `d.Host` once `policy.ParseHostPort(u.Host, 443)` has normalised it, and a host it refuses is refused.
- **Reasons.** A request carrying surrogates is denied `misplaced-surrogate`; one without is denied `surrogate-policy`.
- **Origin form.** Requests with an empty `u.Host` are unaffected, and the brief's `TestInspect` passes unchanged. Its "in the host name" case still gets `unknown-surrogate`, because the surrogate loop runs first.
- **Pin.**
  - Denied with and without a surrogate: 9 foreign or invalid hosts (evil host, subdomain, suffix trick, IPv4 and IPv6 literals, port `0443` and `99999`, `%2e`).
  - Allowed: 7 matching spellings (case, trailing dot, `:443`, `http://`, origin-form, `*`).
  - For the gateway: origin-form is allowed, and 4 absolute-form targets are denied, unparsable hosts included. Those were added after mutant 4d survived.

**m9: spaces in limited paths** (`inspect.go`)
- **Change.** `unambiguousPath` refuses a decoded space.
- **Pin.** 7 paths (`/v1/%20../admin`, `/v1/a%20b`, …) are denied `surrogate-policy` for a `/v1/` binding and allowed for an unlimited binding on the same host. A literal space is denied too.

## Verification (in `keyd/`, go1.27.1)

- keys package: `-count=50` ok and `-race -count=10` ok, 46 tests.
- `gofmt -l .`, using the toolchain's gofmt, prints nothing.
- `go vet ./...` is clean for linux and for `GOOS=darwin`.
- `go test -race ./...`: all 9 packages ok.
- `go mod tidy -diff` is clean.
- At the repo root (Node 24.21, pnpm 10.29.3): `pnpm lint` (Biome, 53 files) clean, `pnpm hygiene` exit 0.

## Mutation testing (scratch copies)

**35 mutants of the new code: 30 killed and 5 survivors, all equivalent.**

- **Killed (30).** Every one is killed by the intended new pin, sometimes along with others:
  - placement check removed, or moved after the value read;
  - foreign-surrogate check removed;
  - old re-decode composition; always decoding from `h`;
  - host check removed, compared unnormalised, policy reason ignored, or a single reason;
  - space in limited paths allowed;
  - empty port allowed; escaped path allowed;
  - each of `?#space`, `//` and `/..` allowed in prefixes;
  - `Mint`, `Lookup` or `ForCell` without a clone;
  - each field not cloned;
  - `Format` removed; `ID` fallback removed; `String` printing the token;
  - one alignment only; scheme only as the first field; `len%4==1` not trimmed.
- **Equivalent (5).**
  - **1a, 1b, 1c, 1f:** joined form only, no fields, no chunks, commas not ending fields. Decoding the filtered joined stream at all 4 alignments already recovers every base64 blob at any position: decoding is a bit stream, and a following blob cannot corrupt the bytes of an earlier one. So the field and chunk decodings the ruling asks for are kept, but they are redundant. A differential fuzz of 300,000 structured values (random junk fields, `=`, commas, tabs, stray bytes, 4 encodings, 5 prefixes and 4 suffixes around the token) found 0 differences between the full decoder and the joined-only one.
  - **1g:** dropping the dedupe of loose finds. A duplicate non-Basic occurrence is refused either way, so the dedupe only keeps the occurrence list small.

## Concerns (for the controller)

1. **Task 10 integration (m8).** `Inspect` now refuses any absolute-form request whose `u.Host` does not normalise to `Dest.Host`, even one without a surrogate. Task 10, which runs in parallel and was coded against 70a534e, must:
   - pass `Dest.Host` from `ParseHostPort` for plain-http proxy requests and CONNECT;
   - send the gateway origin-form only.

   Otherwise legitimate absolute-form requests will be refused. Run the module's tests after the merge.
2. **Port (m8).** Only the host is compared, because `Dest` has no port. `http://api.example.test:8080/` with `Dest.Host = api.example.test` is allowed. Task 10 forwards to Dest's port, so this is safe only if it does not forward to `u`'s port.
3. **`ApplySwaps` is stricter (m1).** It now errors when `h` holds any surrogate that is not in `swaps`, including when called with empty swaps on a header holding one. That is correct after an allowed `Inspect` on the same `h`, but callers must not call it on a refused verdict or after editing headers.
4. **Shared regexps (m6).** Clones share `Op.Path` regexps. Nothing calls the one mutating method, `Regexp.Longest`.
5. **Base URL with an escaped space (m4).** `https://host/v1%20x` is still accepted, because `RawPath` is empty and the ruling's rule passes it. `Upstream` sends it consistently as `%20`.
6. **Colon in a Basic user (m2).** `ValidValueFor` still refuses a basic-user value with a colon. The swap now preserves one if it ever arrived. Task 16 must call `ValidValueFor` when a secret is stored (review carry).
7. **Not verified here.** No darwin test run (only `GOOS=darwin go vet`). The opt-in keychain test (`KEYD_KEYCHAIN_TEST=1`) was not run. keyd has no Docker suites, and none were run.
