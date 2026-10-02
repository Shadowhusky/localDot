# Task 9 report: the surrogate registry

**Status: DONE_WITH_CONCERNS.**

The brief's code is in, byte for byte, and every rule the brief and the rulings state for visible surrogates holds. No probe got a real value swapped anywhere but its bound header, on its bound host, in its bound format.

What I changed beyond the brief:

- **One production change, under ruling 3.** The brief's `ApplySwaps` left a half-swapped header when a later value failed: the first real value stayed in its header while the call returned an error. Ruling 3 says it must not. I fixed it in `73ac7d8`, read as the ruling's instruction; the reasoning is in "Ruling 3" below. If you meant only a pin of the existing behaviour, drop the commit; its pin goes with it.
- **Three real gaps, reported, not applied.** Each needs a ruling. A tested patch for all three is in `scratchpad/t9-keys/c1-c3-proposed.diff`; it applies cleanly to `HEAD`.
  - **C1, Basic credentials.** A Basic credential that keyd cannot decode strictly hides a surrogate completely.
  - **C2, userinfo and opaque targets.** A surrogate in a request target's userinfo or opaque part is never seen.
  - **C3, path limits.** A path-limited binding allows segments such as `..%3F`, `..%23` and `..%20`, which some servers read as `..`.

  In all three, the surrogate leaves unswapped and unalerted. No real value leaks.
- **Two minors and one question** (C4, C5, Q1), plus residuals and carries for later tasks.

## Commits (branch `feat/core-part4a`, base `97bfb65`)

| Commit | What | Files |
|---|---|---|
| `6bda612 feat(keyd): surrogate registry, bindings and header swap` | The brief, byte for byte | `binding.go`, `registry.go`, `inspect.go`, `binding_test.go`, `inspect_test.go` |
| `7178ab3 test(keyd): pin one surrogate per place, exact formats, path and method limits, op allowlists and record checks` | 19 pins, test-only | `keys_integrity_test.go` |
| `73ac7d8 fix(keyd): read every secret before swapping any header` | Ruling 3: `ApplySwaps` is all-or-nothing, plus 2 pins | `inspect.go`, `keys_integrity_test.go` |

- All files are under `keyd/internal/keys/`.
- No commit body has a `Co-Authored-By` line or any AI attribution (checked with `git log --format=%B`).
- The working tree is clean, and nothing outside `keyd/internal/keys/` changed. I never touched the `Projects/localdot` checkout.

## TDD evidence

- **RED** (Step 2, test files alone): `FAIL ... [build failed]`. The first line was `internal/keys/inspect_test.go:14:46: undefined: Binding`, exactly as the brief expects. Saved in `scratchpad/t9-keys/red.txt`.
- **GREEN** (Step 4): `ok` with 9 tests, and `TestInspect` has 50 cases. Saved in `green.txt`.
- **Fix RED:** I ran `TestAFailedSwapLeavesEveryHeaderUntouched` against `7178ab3`'s `inspect.go`. It failed in all 4 shapes: two raw swaps from `Inspect`; bearer then raw; basic then raw; raw then basic.
  - Each time the first real value stayed in its header after the error, for example `Dd-Api-Key:[real-raw-value]` beside an untouched surrogate.
  - Saved in `atomic-red-full.txt`. It passes on `73ac7d8`.

## Verification (in `keyd/` unless noted)

- `gofmt -l .` prints nothing.
- `go vet ./...` is clean on the host, with `GOOS=darwin` and with `GOOS=linux`.
- `go mod tidy -diff` is clean.
- `go test -race ./...` passes in all 9 packages.
- The keys package has 30 tests: the brief's 9, 19 pins and 2 fix pins. It is stable at `-count=50` and at `-race -count=10`.
- At the repo root, `pnpm lint` exits 0 (53 files) and `pnpm hygiene` exits 0.
- **Escape hazard (ruling 4):**
  - I extracted the brief's five Go blocks with awk and checked them with `cmp`, against the brief and against the plan's own copy (the brief equals plan lines 4486–5601 byte for byte).
  - The blocks contain no backslash-u escape and no non-ASCII byte.
  - The pin file contains no backslash and no non-ASCII byte. It builds tab, newline, backslash, DEL, `é`, `ü` and the fullwidth dot from code points.

## The controller's rulings

### Ruling 1: one surrogate, alone, exactly in its place

These pins pass on the brief's code:

- **(a) Two surrogates in one value: `TestTwoSurrogatesInOneValueAreRefused`, 66 cases.**
  - Six separators: none, space, comma, semicolon, comma-space and semicolon-space.
  - Eleven shapes, each refused as `misplaced-surrogate`:
    - raw: the same surrogate twice, two surrogates of one secret, two secrets bound to the same header, and a secret bound to another header;
    - bearer: the same three pairings, plus a second `Bearer`;
    - Basic: the password twice in the password half, two surrogates of one secret, and the user twice.
- **(b) Text beyond the bound format: `TestASurrogateSitsExactlyInItsBoundFormat`, 45 refused and 9 accepted.**
  - Refused:
    - 21 bearer spellings: trailing or leading space, `,`, `;`, quotes, `Bearer=`, `Bearer:`, glued, a doubled space, a tab, `Token`, `Basic`, an extra word, the bare surrogate, and others;
    - 13 raw spellings;
    - 11 Basic spellings: text around the bound half, a second colon, a newline, and the surrogate in the wrong half or in both halves.
  - Accepted: `Bearer`, `bearer` and `BEARER`; exact raw; and `Basic`, `basic` and `BASIC` with exactly the bound half.
- **(c) Once anywhere: `TestASurrogateAppearsOnceInTheWholeRequest`, 10 cases.** A surrogate in its bound header is refused when it also appears:
  - in another header, including in that header's second value;
  - in a header name;
  - in the path, plain or percent-encoded;
  - in the query: plain, percent-encoded, after a bad escape, or with its last character escaped at the end of the query;
  - in the host.
- **(d) Only in its own header: `TestASurrogateTravelsOnlyInItsOwnHeader`.**
  - A raw surrogate is refused in `Authorization`, `Proxy-Authorization`, `Cookie` (as a header and as a cookie value), `X-Dd-Api-Key`, `Dd-Api-Key-2`, another binding's header, and a Basic header of another name.
  - Its own header given twice is refused whether the surrogate is first, second or in both.
  - A non-canonical key is refused, and so is a surrogate in a header name that net/http has case-folded.

Gaps the brief's code cannot pass, so they are not pinned (C1 and C2 below):

- **Basic spellings keyd cannot read** violate (b). The surrogate is invisible, so the request is allowed with 0 swaps.
- **A surrogate in the userinfo** violates (c), together with the bound header (allowed, and the bound copy swapped) or alone.

Also, **Q1**: a Basic header whose user half and password half are surrogates of two secrets bound to the same host is allowed with 2 swaps. Ruling 1 lists no colon separator, and each surrogate sits exactly in its bound half, so I left it allowed and unpinned. Only `ApplySwaps`'s composition is pinned, in `TestSwapsOnOneHeaderCompose`. If "alone" should forbid it, `placed` needs one more check.

### Ruling 2: normalisation matches the policy

`TestNamesAreNormalisedOnceAndMatchedExactly` pins both directions:

- **The record side.** `FromRecord` refuses 11 host spellings and 3 base-URL hosts. The hosts are upper case, mixed case, a trailing dot, a leading or trailing space, `:443`, brackets, an empty label, a leading dot, a path and raw `ü`. `ValidBindingHost` requires `t.Host == host`, so nothing is normalised silently. Accepted hosts are stored unchanged.
- **The destination side.** Five spellings of a CONNECT target go through `policy.ParseHostPort` and are then allowed: upper case, a trailing dot, and `XN--` upper case. An un-normalised `Dest.Host` fails closed as `misplaced-surrogate`.

### Ruling 3: errors carry no value, and swaps are all or nothing

- `TestVerdictsNameSurrogatesOnlyByID` checks unknown, misplaced and policy denials:
  - the reason is one of the three constants;
  - `SecretID` is the record's id, and `SurrogateID == surrogate.ID(token)` (12 hex characters);
  - no field holds `ld_`.
  An allowed verdict names its first swap's secret and surrogate id. Task 10's audit lines depend on that, and mutant I10 had survived the brief's tests.
- `TestErrorsNeverCarryAValue` checks three things:
  - `ValidValueFor` errors never contain the value;
  - the vault's rules apply to every format, not only basic-user (mutant B55 had survived);
  - `ApplySwaps` returns the store's error (`errors.Is` holds) without naming a surrogate.
- The keys package logs nothing.
- **Why I applied the fix:** ruling 3 states how `ApplySwaps` must behave, and the brief's code does not behave that way (RED above). So I read the ruling as covering the change and applied the minimal one: read every value into a pending map, then `Set` them all.
  - Two Basic swaps on one header still compose (user, then password).
  - On any error, `h` is untouched.
  - Its 6 mutants are all killed: writing raw, bearer or Basic before every value is read; ignoring an earlier swap on the same header; `Add` instead of `Set`; never writing.

### Rulings 4 and 5

Covered under Verification (the escape hazard) and Commits (no attribution).

## Bypass hunt

### Methods

All probes ran in `scratchpad/t9-keys/{mod,fixmod,proposal}`, never in the worktree.

- **Reachability: 39 raw requests through a real net/http server.** Each handler ran `Inspect` on what Go 1.27.1 actually parsed. Output in `probe-e2e.txt`.
- **A 156-row rules matrix** covering rulings 1 and 2 (`probe-rules.txt`).
- **A path-limit fuzz over 6 seeds** (`probe-pathfuzz*.txt`).
  - About 284,000 unique targets per seed, 1.7 million in all, built from 60 pieces: every escape the brief names in both cases, `%3f`, `%23`, `%20`, `%09`, overlong UTF-8, `%u`, a raw `#` and `?`, `;`, a backslash, dots, and others.
  - Each target was parsed with `url.ParseRequestURI`, as net/http does.
  - For every path `Inspect` allowed under a `/v1/` limit, I checked eight server readings:
    - RFC 3986 dot removal on the raw path;
    - decoding once, and decoding twice;
    - a backslash read as a slash;
    - `;` parameters stripped, before or after decoding;
    - overlong UTF-8;
    - decoding before splitting off `?` or `#`;
    - trailing spaces trimmed from segments.
- **Mutation testing** of `inspect.go`, `binding.go` and `registry.go`, described below.

### Results

| Probe | Result on the brief's code |
|---|---|
| Ruling 1(a), 76 rows | All refused. |
| Ruling 1(b), 54 rows | 13 allowed, all Basic spellings keyd cannot read. 11 can arrive through net/http (C1). `Basicx` is no Basic scheme, and a leading space is trimmed by Go. |
| Ruling 1(c)(d), 19 rows | 5 allowed. 3 can arrive: userinfo twice and opaque once (C2). A surrogate in a header name is case-folded by Go before keyd sees it (R4). A second, non-canonical key for the bound header cannot come from net/http (C7). |
| Ruling 2, 7 rows | All as ruled. |
| net/http reachability | Go accepts userinfo (`GET http://u:<s>@host/`), opaque targets (`GET http:<s>`), a raw `#`, backslashes, raw UTF-8 and every Basic spelling above. It refuses `%u` (400) and a space before the colon (400). It canonicalises header names and trims surrounding whitespace in header values. It answers `OPTIONS *` itself. |
| Path fuzz, 6 seeds | **90–134 allowed paths per seed read outside `/v1/`** (C3). With the proposed patch: **0** on every seed. |
| Header case and duplicates | All refused, including `X_Api_Key`, two cases of the bound header, and a surrogate in either of two values. |
| Query escapes | `%zz` before or after, `%5` at the end, and a final escape completing a surrogate are all caught; `unescape` is unit-pinned. Double encoding is not caught (R1). |
| Method tricks | Each of the 3 override headers in any case is refused. `_method` is refused with `;` or `&`, in upper case, `%5f`/`%5F`, `_me%74hod`, with no value, or after a bad escape. PHP's name mangling and `X_HTTP_METHOD_OVERRIDE` pass (R3). |

### C1–C3 in detail (concerns, not applied)

**C1: a Basic credential keyd cannot read strictly hides its surrogate (Important).**

- **Cause:**
  - `scan` decodes Basic only through `decodeBasic`: one space, `StdEncoding` with padding, and a colon required. `decodeBasic` returns `ok=false` when the decoded text has no colon, so even a strictly valid `Basic base64(<surrogate>)` is never searched.
  - Lenient servers do decode these spellings. Node's `basic-auth` and `Buffer` accept any number of spaces, missing padding and the URL-safe alphabet. Werkzeug splits on any whitespace and discards stray bytes. nginx skips extra spaces.
- **Effect:** the request is allowed with 0 swaps. To an unbound host the surrogate leaves unalerted; in its bound header it breaks ruling 1(b).
  - Spellings that reach `Inspect` through net/http: two spaces, a tab, no padding, the URL-safe alphabet (padded or raw), no colon (user or password), trailing junk (`,x` or ` x`), doubled padding, and a space inside the base64.
  - No real value is swapped.
- **Proposed fix:** when strict decoding fails, `scan` searches `looseBasic(value)`, a lenient decode, for surrogates and records them as ordinary occurrences, which `placed` then refuses.

**C2: userinfo, opaque and fragment parts of the target are not scanned (Important).**

- `scan` reads `Host`, the path twice and the query twice, but not `u.User`, `u.Opaque` or `u.Fragment`. So `GET http://u:<s>@api.example.test/` is allowed with 0 swaps, and `GET http:<s>` too.
- With the same surrogate also in its bound header, the request is allowed and swapped, against ruling 1(c).
- Tasks 10, 12 and 14 build their target URLs without these parts, so nothing reaches the upstream. But the brief's "every surrogate-shaped token in the request line" is not met, and the alert is lost: Task 10 later refuses an opaque target as `host-invalid`.
- **Proposed fix:** add `u.Opaque` raw and decoded, `u.Fragment`, and `u.User`'s escaped form, user and password to the URL parts.

**C3: path limits allow segments some servers read as `..` (Important; the design goal is "a path every server reads the same way").**

- A decoded segment that starts with `..` and continues with `?`, `#` or spaces passes `path.Clean`, since `..?x`, `..#x` and `.. ` are ordinary names to it. Such segments come from `%3F`, `%23`, a raw `#` or `%20`.
- Two kinds of server read them as `..`:
  - one that decodes before splitting off the query or fragment reads `/v1/..%3f` as `/v1/..`, which is `/`;
  - one that trims trailing spaces from segments, as Windows does, reads `/v1/..%20` as `/`.
- **A second issue: the code does not check what the brief's rule says.** When the target holds a raw `#`, `EscapedPath()` re-escapes from the decoded path. So `/v1/.%2e#v1` is checked as `/v1/..%23v1`, and the brief's "no encoded dot in the raw path" never sees the `%2e`. The upstream also receives the plain-dot form.
- **Proposed fix:** refuse a decoded `?` or `#`, refuse any segment starting with `..`, and also check `u.RawPath`.
  - Fuzz: 0 out-of-prefix readings on all 6 seeds.
  - Allowed targets fall from about 20,800 to about 14,700 per seed. All of the difference is targets holding `%3f`, `%23`, `#` or `..`-led segments.

**Checks on the proposed patch (93 lines):**

- All 30 tests pass, plain and with `-race`.
- `go vet` is clean.
- The e2e probe then refuses every userinfo, opaque and Basic case.
- The rules matrix keeps only the three expected differences:
  - `Basicx`;
  - the case-folded header name (R4);
  - the non-canonical duplicate key (C7).

### Smaller concerns and the question

- **C4: shared state between bindings (Minor, latent).**
  - `Mint` stores the caller's `Binding` as is.
  - `Lookup`, `ForCell` and `Inspect`'s swaps hand out entries that share `Hosts`, `Methods`, `Paths`, `Ops` and the `*url.URL` `Upstream`.
  - `FromRecord` shares the package-level preset op slices, and `LocalRoutes` shares `compatibleOps`.
  - A caller editing a returned binding would change keyd's policy for that secret, or for every binding of that provider. No planned caller does.
  - **Proposed fix:** clone in `Mint` and on the way out, as Task 2 did for records (ruling 5) and Task 6 did for its certificate.
- **C5: the base-URL error echoes the whole URL (Minor).**
  - `FromRecord`'s error includes the userinfo and the query. Task 16 returns `err.Error()` in the admin reply.
  - A key the user pasted into a base URL (`?key=...` or `u:key@`) therefore comes back in an error.
  - **Proposed fix:** name only the failing part.
- **C6: `Entry` and `Verdict` print the full surrogate under `%v` (Info).** No planned log prints one; I checked every `log.Printf` in the plan.
- **C7: a second, non-canonical key for the bound header is not counted (Info).** `placed` counts only the canonical key. In a hand-built `http.Header`, a second key that canonicalises to the bound header slips past "exactly one instance". net/http and HTTP/2 always canonicalise, so this cannot arrive.
- **Q1:** as above. A Basic header carrying two different secrets' surrogates, one per half, is allowed. Is that what "alone" means?

### Residuals (recorded, no change proposed)

- **R1: double encoding.** The path and query are decoded once, so a server that decodes twice sees a surrogate keyd does not. The same holds for percent- or base64-encoded surrogates in header values other than Basic, such as `Cookie: k=ld%5F...`; only Basic is decoded, as the spec says. The surrogate leaves unswapped and unalerted. This is the same class as Task 7's F3.
- **R2: Basic fold.** `strings.EqualFold` accepts `Baſic` (U+017F) as Basic. `ApplySwaps` rewrites it as `Basic`, so this is harmless.
- **R3: other override spellings.** Method overrides beyond the three headers and `_method` are not refused:
  - header names with underscores, such as `X_HTTP_METHOD_OVERRIDE`, which CGI, WSGI and Rack map to the same variable;
  - PHP's name mangling: `.method`, `[method`, `%20_method` and `+_method` all become `_method`.

  The frameworks that honour these (Rack, Symfony/Laravel, Express, Spring, ASP.NET) override only POST, so a GET-only binding is unaffected. A POST-allowed binding is already open through P4a-R8's form-body `_method` residual.
- **R4: header names are case-folded.** net/http folds a header name's case before keyd sees it: `X-ld_...` becomes `X-Ld_...`. `Find` misses it, and the upstream gets only a case-folded fragment. A pin checks that a folded surrogate shape is still refused.
- **R5: base-URL forms.** `https://host/v1?` (ForceQuery) and `https://host/v1#` are accepted. This is harmless: a cell request with no query gets a trailing `?`.

### Carries for later tasks

- **K1 (Tasks 10, 12, 14): the Host header.** `Inspect` sees `r.URL` and `r.Header` only, so a surrogate in the Host header is seen only if the caller copies `r.Host` into the URL.
  - Task 12's inner handler does this on a mismatch, and that is the only origin-form path.
  - Task 10's plain proxying and Task 14's gateway (dispatched on `r.URL.Hostname() == llm.ldot`) see only absolute-form requests. net/http drops their Host header, so a surrogate there is never forwarded and never alerted. Nothing leaks; only the alert is lost.
- **K2: request trailers.** These are not inspected. The probe shows `httputil.ReverseProxy`, set up like Task 10's relay, sends declared request trailers with empty values: the clone is taken before the body is read. A trailer surrogate therefore never reaches the upstream. Any task that forwards request trailers must inspect them.

## Mutation testing

- **Mutants:** 144: 77 in `inspect.go`, 62 in `binding.go` and 5 in `registry.go`. They were applied in a scratch copy of the module, never in the worktree.
- **Brief's tests alone:** kill 78.
- **With the pins:** kill 131. Pins added for the 53 survivors that matter, among them:
  - every forbidden header but Host, Cookie and Proxy-Authorization;
  - the other two override headers, `;` and upper-case `_method`;
  - raw and Basic substrings, prefixes and wrong halves;
  - an encoded dot in a clean path, and non-printable paths (overlong dots, tab, DEL);
  - `unescape` past the end and on a final escape;
  - LLM bindings on a non-gateway scheme, HTTP bindings over CONNECT;
  - the ids on an allowed verdict;
  - header names, the second header value and the decoded path in `scan`;
  - case-insensitive `basic`;
  - LLM records with a header, format, methods, paths, a port or a fragment;
  - HTTP records with a base URL or 17 hosts;
  - the path prefix printable rule;
  - hosts cloned;
  - `ValidValueFor`'s vault rules;
  - the anchors of the op allowlists (`messages/batches`, `v1/messages`, `chat/completions/x`, `models/../files`, `models/../x:generateContent`);
  - the LLM route being the record's id, not the provider;
  - `ForCell` filtering by cell.
- **The 13 survivors are equivalent.** On two fuzz seeds (about 568,000 targets), the 156 rule rows and the 39 e2e decisions, each behaved exactly like the original. They are:
  - I07: gateway bindings have no limits;
  - I18 and I25: `%5c` and the decoded backslash check cover each other;
  - I20: `%00` is covered by `printable`;
  - I21: Go's targets start with `/`, or are refused anyway;
  - I28: `//` matters only under a `/` prefix;
  - I46: a passing value pins the occurrence's header;
  - I51 and I59: base64 cannot hold `ld_`;
  - I67 and I69: each URL form is covered by its decoded twin;
  - I72: the bound header's name holds no surrogate;
  - I75: gluing the halves only refuses more.
- Per-mutant results: `mutants-brief.txt`, `mutants-pins.txt`, `mutants-fix.txt` and `equiv.txt`.

## Evidence files (`/private/tmp/claude-501/-Volumes-Husky-s-SSD-4T-Projects/8ea76523-70ba-4eef-a6ab-cd9a3032d328/scratchpad/t9-keys/`)

- TDD: `red.txt`, `green.txt`, `atomic-red.txt`, `atomic-red-full.txt`.
- Probes: `probe-e2e.txt`, `probe-rules.txt`, `probe-pathfuzz.txt`, `probe-pathfuzz2.txt`, `probe-trailer.txt`.
- The patched copy: `fix-probe-*.txt`.
- Mutation: `mutate.py`, `mutants.py`, `mutants*.json` and `mutants*.txt`; `equiv.py` and `equiv.txt`.
- Patches: `c1-c3-proposed.diff`, `proposed_patch.py`, `atomic_patch.py`.
- Probe sources: `mod/internal/keys/probe_*_test.go`.
- Verification: `verify.txt`, `verify-root.txt`.

## Fix round: the controller's rulings on C1–C5 and Q1

**Status: DONE.**

The rulings:
- `73ac7d8` and the 19 pins of `7178ab3` are accepted.
- C1–C5 are accepted.
- Q1: one Basic header may carry exactly one bound `basic-user` surrogate in the user half and one bound `basic-password` surrogate in the password half, for the same header and destination.

### Commits (base `73ac7d8`)

| Commit | Ruling | Pin, RED before the fix |
|---|---|---|
| `1427522 test(keyd): pin the one Basic header that may carry a user and a password secret` | Q1 | None: the brief's code already supports the pair. `TestABasicHeaderCarriesAtMostOneUserAndOnePasswordSecret` passes on `73ac7d8`. |
| `d12bce4 fix(keyd): find surrogates in every Basic spelling and swap only canonical Basic` | C1 | `TestASurrogateInABasicCredentialIsFoundHoweverItIsSpelled`: 20 rows RED |
| `25ebe97 fix(keyd): refuse a surrogate in the user information or opaque form of a request target` | C2 | `TestASurrogateAnywhereInTheTargetIsRefused`: 11 rows RED |
| `1c5430c fix(keyd): refuse limited paths with segments a server may read as a parent` | C3 | `TestPathLimitsRefuseSegmentsAServerMayReadAsAParent`: 17 rows RED. `TestNoPathAllowedUnderAPrefixIsReadOutsideIt`: 63 out-of-prefix readings RED (49 from decoding before splitting, 14 from trimming trailing spaces). |
| `2282e34 fix(keyd): give every binding its own operations and URL` | C4 | `TestBindingsShareNoOperationsOrURL`: 6 rows RED |
| `70a534e fix(keyd): name what is wrong with a base URL without repeating it` | C5 | `TestABaseURLErrorNamesTheFieldNotTheURL`: 11 rows RED |

- No commit has a body or any attribution line.
- **Every new pin fails on `73ac7d8`.** I ran the final test file against `73ac7d8`'s `binding.go`, `inspect.go` and `registry.go`. Exactly the six fix pins failed; the other 31 tests passed, the Q1 pin included (`pins-on-73ac7d8.txt`).

### What each fix does

- **C1 (`inspect.go`).**
  - `decodeBasic` now reads only canonical Basic: the scheme in ASCII letters of any case, one space, and `StdEncoding.Strict()`, which requires the padding and zero padding bits.
  - When strict decoding fails, `scan` searches `looseBasic(value)`, which decodes the way the most lenient servers do:
    - any run of whitespace after the scheme;
    - the scheme in any case;
    - either base64 alphabet;
    - any padding;
    - stray bytes skipped;
    - no colon needed.
  - A surrogate found there becomes an ordinary occurrence. `placed` then refuses it as `misplaced-surrogate`, or as `unknown-surrogate` if it is not a minted one.
  - Two tightenings follow from "only the canonical form is ever swapped": `Baſic` (U+017F) and padding bits set were both swapped before. Both are now refused, and both are pinned.
- **C2 (`inspect.go`).**
  - `scan` adds the opaque form, raw and decoded, the fragment, and the decoded user and password. `Inspect`'s doc comment says so.
  - I dropped `u.User.String()` from the tested patch. It adds nothing to the decoded user and password: decoding never removes a surrogate's characters, and Go refuses a userinfo with a bad escape.
- **C3 (`inspect.go`).**
  - A limited path may hold no decoded `?` or `#`, and no segment that starts with `..`. The ambiguous-escape check also reads `u.RawPath` as sent.
  - The fuzz is a pin: PCG seeds 1 and 2, 30,000 targets each, 60 pieces, nine server readings, and a percent-decoder independent of the code under test.
  - It fails if fewer than 1,000 paths are allowed, so the generator cannot quietly stop producing clean paths.
  - It takes 0.13 s, or 1.2 s under `-race`.
- **C4 (`binding.go`).** `FromRecord` and `LocalRoutes` give each binding its own copy of the preset op list. `Upstream` was already parsed fresh for each binding; the pin covers both. The op path regexps stay shared, which is safe: nothing calls `Longest`, the only call that changes one.
- **C5 (`binding.go`).** `badBaseURL` names the field and the reason, and nothing else:
  - `must use https`;
  - `must not carry a user or password`;
  - `must not name a port`;
  - `must not carry a query`;
  - `must not carry a fragment`;
  - `host is not a public, lowercase host name`;
  - `path is not clean`;
  - `does not parse`.

  The checks themselves are unchanged.
- **Q1.**
  - Allowed: `Basic base64(U:P)`, with both bound to the destination. It swaps to `Basic base64(<user value>:<password value>)`.
  - Refused (17 combinations): two user secrets, two password secrets, each in the other's half, extra text in either half, two surrogates of one secret, the password twice, a password bound to another host, and another cell's password.
  - The pair in a non-canonical spelling (two spaces, no padding) is refused under C1.

### Verification

- The keys package has 37 tests, stable at `-count=50` and `-race -count=10`.
- gofmt, vet (host, darwin and linux), `go test -race ./...` (9 packages), `go mod tidy -diff`, `pnpm lint` and `pnpm hygiene` are all clean. The worktree is clean.
- **Path fuzz on the final code:** 0 out-of-prefix readings on each of 6 seeds, about 1.7 million targets (`final-pathfuzz.txt`). On the brief's code it was 90–134 per seed.
- **Probes on the final code** (`final-probe-*.txt`):
  - The rules matrix (156 rows) keeps only the three expected differences: `Basicx`, which is no Basic scheme; the case-folded header name (R4); and the unreachable non-canonical duplicate key (C7).
  - In the e2e run, every userinfo, opaque and Basic case is refused. The only allowed requests are canonical ones and the recorded residuals: double encoding (R1), override spellings (R3), the Host header (K1) and request trailers (K2).
- **Mutation:** 175 mutants (`mutants-final.txt`):
  - the 144 originals, with the 8 that these fixes rewrote dropped and the changed patterns updated;
  - 39 new ones: 6 for the swap fix and 33 for C1–C5.

  The brief's tests kill 78; the brief plus the pins kill 159. The 16 survivors:
  - the 13 equivalent mutants from before;
  - `C1j` and `C2a`, whose decisions match the original on the probe suites (`equiv-final.txt`);
  - `C1c`, which only refuses more: it searches every scheme, so it refuses `Basicx`.

### Left as is

- Residuals R1–R5 and carries K1–K2 are unchanged.
- Registry entries that `Lookup` and `ForCell` hand out still share slices with the stored entry. C4 as ruled copies at `FromRecord` and `LocalRoutes`, and no planned caller edits an entry.
