# Task 7 report: the scrubber

**Status: DONE_WITH_CONCERNS.** I found no way to get a real value past the scrubber in any encoding the brief names, apart from the overlap class the review found afterwards (matches or replacements next to each other rebuilding some or all of a secret; ruled a residual, see Fix round 1). That held at every two- and three-chunk split, through gzip, and in headers, including a real 103 Early Hints and a trailer. There are three concerns:

1. **F1, a contract gap in `New`.** It accepts an empty replacement, and an empty replacement can rebuild the secret from the text on either side. No caller can pass one today, but closing it would change production code, so it needs a ruling.
2. **F2, a test-only pin commit beyond the brief's file list.** The brief's tests miss 24 mutants. Twenty-two of them would weaken security, and the new pins kill them all.
3. **A performance note** for hosts with many bound secrets (see Performance).

*Addendum at the end: the controller's rulings and the F1 fix (`fa07db9`).*

## Commits (branch `feat/core-part4a`, base `ac226f0`)

- `9f4f0f3 feat(keyd): streaming response scrubber`: `keyd/internal/scrub/scrub.go` and `keyd/internal/scrub/scrub_test.go`. Both files are byte-identical to the brief. I extracted the brief's two Go blocks with awk rather than retyping them, then checked them with `cmp`.
- `aa65b40 test(keyd): pin the scrubber's escape spellings, base64 forms, EOF flush and header values`: `keyd/internal/scrub/scrub_integrity_test.go`, 9 tests, test-only. It follows the `*_integrity_test.go` convention from Tasks 2–6.

Neither commit body contains a `Co-Authored-By` line or any AI attribution (checked with `git log --format=%B`). The working tree is clean.

## TDD evidence

- **RED.** I wrote the test file only and ran `go test ./internal/scrub/`. It gave `FAIL … [build failed]`, and the first error was `internal/scrub/scrub_test.go:27:30: undefined: Scrubber`. That is exactly what Step 2 expects.
- **GREEN.** `go test -race ./internal/scrub/` gave `ok` with 11 tests, as Step 4 expects.
- **Pins.** All 9 pins pass on the brief's code. Each one kills at least one mutant that the brief's tests miss (see the mutation table), so each pin can fail.

## Verification

All commands ran in `keyd/` unless noted.

- **Format and vet:** `gofmt -l .` prints nothing. `go vet ./...`, `GOOS=darwin go vet ./...` and `GOOS=linux go vet ./...` are clean, and so is `go mod tidy -diff`.
- **Module tests:** `go test -race ./...` passes for audit, cellca, events, netguard, scrub, surrogate and vault.
- **scrub package:** 20 tests (the brief's 11 plus 9 pins). They are stable at `-count=50` and at `-race -count=10`. The timing-based test (`TestAChunkThatCannotStartTheSecretIsNotHeldBack`) and two others are stable at `-race -count=300`.
- **Repo root:** `pnpm lint` exits 0 (biome checked 53 files and applied no fixes). `pnpm hygiene` exits 0. It lists untracked files too, so it also scanned the package before the commit.
- **Escape hazard:** the three files contain no non-ASCII byte and no literal backslash-u escape (checked with a perl scan). Every backslash-u form is built in code.

## The brief against the controller's checklist

- **Go-JSON, .NET-JSON and HTML-escaped echoes:** covered by `TestEscapedReflectionsAreReplaced`, and in a stream by `TestEscapedReflectionsStreamLikeOneShot`.
- **The Go escape rule's test can fail (review 1, I1):** its guard checks that `json.Marshal` still escapes `<` and `&`. Removing either backslash-u spelling from the escape table (mutants M01 and M02) makes it fail.
- **Gzip only, at most one layer:** the brief says so and leaves it to Task 10 (P4a-R10). No compression code belongs in this package.
- **1xx headers: the Task 7 brief does not mention them.**
  - They belong to Task 10's wiring: `scrubbedWriter` (plan, around line 6939) for 1xx headers, and `atEOF: scrubber.Header(resp.Trailer)` for trailers.
  - Task 12 tests the wiring (`TestInformationalResponseHeadersAreScrubbed`). This package only provides `Header`.
  - My probe ran a real HTTP/1.1 exchange that echoed the secret three ways: a 103 Early Hints `Link` with it URL-encoded, the body, and a JSON-escaped trailer. `Header` and `Reader` replaced all three.
  - Nothing is missing from Task 7.
- **The escape hazard is live:** while I was writing a scratch probe, my file-writing tool turned the six-character escape for U+00A0 into the raw bytes `C2 A0`. That is the hazard behind review 1's I1. So I extracted the brief's files mechanically, and the pin file builds every backslash sequence from a one-character constant (`bsl`).

## Bypass hunt

### Method

**Secrets.** I used 11 secrets:
- the brief's `secret` and `punct`
- `real-secret-value-for-test`, a typical key
- `fake/Base64+Like/Secret0123456789+abcd==`, which looks like base64
- `real%secret&amp;value\path\\x`, dense with escapable bytes
- `abcdefgh`, the 8-byte minimum
- `real secret value with spaces`
- `+starts/with+punct=` and `/real-secret-value`, which open with an escapable byte
- `real~secret~value`
- `real&secret&&end&`

**Forms.** There are 58:
- 36 in scope: every encoding the brief names, alone, mixed byte by byte, and layered (base64 then percent, then .NET JSON, then PHP's `\/`, then HTML references).
- 22 residuals: encodings the brief excludes or doesn't name.

**Checks.** Each form was tested bare and inside a JSON error body, in these ways:
- one-shot `Bytes`
- every two-chunk split, in both contexts
- every three-chunk split of the bare encoded value
- 1,500 random three-chunk splits with the context
- byte by byte, read one byte at a time

Each streamed output was compared with the one-shot output.

**The leak oracle** is independent of the scrubber.
- It decodes the output every way it knows: URL, JSON (backslash-u and short escapes), JavaScript `\x`, HTML references, quoted-printable, NUL-stripped and whitespace-stripped. It applies each decoding alone and in every pair.
- It then decodes every hex, base64 and base32 run in those views. Base64 runs are tried at all 4 alignments, in both alphabets.
- It decodes the results once more, to catch combinations such as base64 of hex.
- A row counts as a leak if any view contains the secret, a case-folded copy of it, or a copy with `+` turned into a space.

I validated the oracle on the residual forms. It finds a leak in every residual row where the encoder actually changes the secret.

### Totals

- **Coverage:** 638 rows (11 secrets × 58 forms), covering 67,304 two-chunk splits and 1,588,617 three-chunk splits. Every stream matched the one-shot output.
- **In scope:** all 396 rows were caught. The longest stretch of any secret left in any decoded view of an in-scope output is 3 bytes, and it always comes from the context around the echo (for example `val` in `invalid`).
- **Residual rows counted as "caught":** in these, the encoder left that particular secret unchanged. For example, Java's `URLEncoder` changes nothing in a secret that has no `~`. There is one oracle blind spot: base32 of the 8-byte secret is shorter than the oracle's 16-character minimum run.

### Results by encoding (each row aggregates the 11 secrets)

| # | Encoding / form | Scope | Caught (of 11 secrets) | Leaked | 2-chunk splits | 3-chunk splits | Stream = one-shot |
|---|---|---|---|---|---|---|---|
| 1 | plain | in scope | 11 | 0 | 833 | 19497 | yes |
| 2 | hex lower | in scope | 11 | 0 | 1347 | 29226 | yes |
| 3 | hex upper | in scope | 11 | 0 | 1347 | 29226 | yes |
| 4 | base64 std padded | in scope | 11 | 0 | 1031 | 22417 | yes |
| 5 | base64 std raw | in scope | 11 | 0 | 1011 | 22095 | yes |
| 6 | base64 url padded | in scope | 11 | 0 | 1031 | 22417 | yes |
| 7 | base64 url raw | in scope | 11 | 0 | 1011 | 22095 | yes |
| 8 | url.QueryEscape (upper %) | in scope | 11 | 0 | 965 | 21588 | yes |
| 9 | QueryEscape, lower % | in scope | 11 | 0 | 965 | 21588 | yes |
| 10 | url.PathEscape | in scope | 11 | 0 | 917 | 20816 | yes |
| 11 | encodeURIComponent upper | in scope | 11 | 0 | 981 | 21840 | yes |
| 12 | encodeURIComponent lower | in scope | 11 | 0 | 981 | 21840 | yes |
| 13 | Python quote | in scope | 11 | 0 | 961 | 21501 | yes |
| 14 | Python quote_plus | in scope | 11 | 0 | 965 | 21588 | yes |
| 15 | every punct %XX upper | in scope | 11 | 0 | 985 | 21929 | yes |
| 16 | every punct %xx lower | in scope | 11 | 0 | 985 | 21929 | yes |
| 17 | Go json.Marshal | in scope | 11 | 0 | 967 | 21430 | yes |
| 18 | Go json, no HTML escape | in scope | 11 | 0 | 887 | 20150 | yes |
| 19 | .NET System.Text.Json | in scope | 11 | 0 | 1045 | 23001 | yes |
| 20 | PHP json_encode (\/) | in scope | 11 | 0 | 899 | 20330 | yes |
| 21 | JSON backslash-u (upper) of every punctuation byte | in scope | 11 | 0 | 1213 | 27302 | yes |
| 22 | JSON backslash-u (lower) of every punctuation byte | in scope | 11 | 0 | 1213 | 27302 | yes |
| 23 | html.EscapeString (Go) | in scope | 11 | 0 | 909 | 20612 | yes |
| 24 | PHP htmlspecialchars ENT_QUOTES | in scope | 11 | 0 | 913 | 20701 | yes |
| 25 | PHP ENT_HTML5 (&apos;) | in scope | 11 | 0 | 913 | 20701 | yes |
| 26 | Python html.escape (&#x27;) | in scope | 11 | 0 | 913 | 20701 | yes |
| 27 | Handlebars (&#x3D; &#x60;) | in scope | 11 | 0 | 963 | 21616 | yes |
| 28 | decimal refs every punct | in scope | 11 | 0 | 1137 | 25281 | yes |
| 29 | 3-digit decimal refs every punct | in scope | 11 | 0 | 1213 | 27302 | yes |
| 30 | hex refs lower every punct | in scope | 11 | 0 | 1213 | 27302 | yes |
| 31 | hex refs upper every punct | in scope | 11 | 0 | 1213 | 27302 | yes |
| 32 | base64 std then QueryEscape | in scope | 11 | 0 | 1079 | 23225 | yes |
| 33 | base64 std then lower % | in scope | 11 | 0 | 1079 | 23225 | yes |
| 34 | base64 std then .NET JSON | in scope | 11 | 0 | 1051 | 22727 | yes |
| 35 | base64 std then PHP \/ | in scope | 11 | 0 | 1031 | 22417 | yes |
| 36 | base64 std then hex refs | in scope | 11 | 0 | 1151 | 24572 | yes |
| 37 | RESIDUAL %XX of every byte | residual | 0 | 11 | 1861 | 45698 | yes |
| 38 | RESIDUAL Java URLEncoder (~ as %7E) | residual | 10 | 1 | 973 | 21658 | yes |
| 39 | RESIDUAL JSON backslash-u of every byte, letters too | residual | 0 | 11 | 3403 | 135572 | yes |
| 40 | RESIDUAL &#X3C; capital X | residual | 3 | 8 | 1213 | 27302 | yes |
| 41 | RESIDUAL &#0060; 4-digit decimal | residual | 3 | 8 | 1289 | 29553 | yes |
| 42 | RESIDUAL &#x03c; 3-digit hex | residual | 3 | 8 | 1289 | 29553 | yes |
| 43 | RESIDUAL HTML5 named (&plus; &sol;) | residual | 4 | 7 | 1205 | 27129 | yes |
| 44 | RESIDUAL double: %-encoded backslash-u | residual | 8 | 3 | 1207 | 26410 | yes |
| 45 | RESIDUAL double: %25XX | residual | 3 | 8 | 1117 | 24836 | yes |
| 46 | RESIDUAL double: &amp;lt; | residual | 8 | 3 | 989 | 22448 | yes |
| 47 | RESIDUAL PHP addslashes (\') | residual | 10 | 1 | 845 | 19665 | yes |
| 48 | RESIDUAL JS \xHH | residual | 3 | 8 | 1061 | 23490 | yes |
| 49 | RESIDUAL hex mixed case | residual | 1 | 10 | 1347 | 29226 | yes |
| 50 | RESIDUAL hex with spaces | residual | 0 | 11 | 1839 | 44949 | yes |
| 51 | RESIDUAL plain lower-cased | residual | 10 | 1 | 833 | 19497 | yes |
| 52 | RESIDUAL plain upper-cased | residual | 0 | 11 | 833 | 19497 | yes |
| 53 | RESIDUAL '+' decoded to a space | residual | 7 | 4 | 833 | 19497 | yes |
| 54 | RESIDUAL base64 MIME-wrapped | residual | 0 | 11 | 2659 | 77658 | yes |
| 55 | RESIDUAL base64 of hex | residual | 0 | 11 | 1727 | 40559 | yes |
| 56 | RESIDUAL base32 | residual | 1 | 10 | 1215 | 25823 | yes |
| 57 | RESIDUAL UTF-16LE | residual | 0 | 11 | 1347 | 29226 | yes |
| 58 | RESIDUAL quoted-printable | residual | 6 | 5 | 901 | 20580 | yes |

### Other probes

- **Base64 inside a longer value** (`Basic base64(prefix + secret + suffix)`):
  - Cases: 11 secrets × 4 encodings × 6 escape layers × 9 prefixes × 6 suffixes = 14,256. The escape layers were none, `QueryEscape`, lower-case percent, .NET JSON, PHP's `\/`, and HTML hex references.
  - Result: no leaks.
  - The longest fragment of any secret in any decoded view was 4 bytes, and it was the context prefix `abcd`, which also happens to occur inside one secret.
  - The secret's own bytes survive only as the at most 4 bits at each edge that share a base64 character with the neighbouring bytes.
- **44,000 random spellings:** each escapable byte was spelled at random from every family.
  - Inputs: the plain value, its base64, and its URL-safe base64 at a random offset, in random, punctuation-heavy context.
  - Result: all were replaced, and random chunkings matched the one-shot output.
- **All 11 secrets in one scrubber:** 3,000 random bodies, each mixing in-scope forms of several secrets. No leaks, and byte-by-byte streams matched the one-shot output.
- **The vault's maximum:** a random 8,192-byte printable secret, in every in-scope form. Each was checked one-shot and with 20 random chunkings (1 B to 2 KiB parts). No leaks.
- **gzip:**
  - Body: one carrying the plain, URL-encoded, Basic-base64, hex and .NET forms.
  - Streams: the body gzipped with a flush at each of 33 points (so the decompressor hands every form over in pieces), plus a two-member gzip that splits the secret across members.
  - Every two-chunk split of each compressed stream went through `gzip.Reader` and then `Reader`: 8,217 runs, all equal to the one-shot output and clean.
- **Headers:** I checked `Location`, three `Set-Cookie` values, a 103-style `Link` (lower-case percent), a `WWW-Authenticate` quoted string with `\"` and `\\`, four `X-Echo` encodings, and a Basic value. All were clean, and so was the real 103 plus trailer exchange.
- **Upstream errors:** an error after every prefix of 7 forms released no secret byte beyond the baseline that `"ok "` alone shares with the secret.
  - A clean EOF after a prefix does release that prefix (up to 26 of 27 bytes). That is the documented truncation residual (P4a-R18), and the one-shot path behaves the same way.
  - An EOF wrapped in another error is treated as an error, so the held tail is dropped.
- **SSE:** none of 2,000 random, punctuation-heavy SSE events was held back.
- **Concurrency:** one `Scrubber` shared by 32 goroutines calling `Bytes`, `Header` and `Reader`, under `-race`: clean.

### Findings

**F1: an empty `Replacement` is accepted (contract gap, not reachable today; needs a ruling).**
- `New` refuses a replacement only if it has a character outside `A–Z a–z 0–9 -._~`, and an empty replacement has none.
- Deleting a secret can then let the text on either side close up into the secret. Reproduction:

```go
s, _ := New(Pair{Secret: []byte("real-secret-value+for/test="), Replacement: nil})
s.Bytes([]byte("real-secret" + "real-secret-value+for/test=" + "-value+for/test="))
// == "real-secret-value+for/test=", the secret, rebuilt
```

- **Why it can't happen today:** the plan has one caller, Task 10's `scrubberFor`. It substitutes `keyd-redacted` when the cell holds no surrogate, and a surrogate is never empty.
- **Proposed hardening (production code):** refuse an empty replacement in `New`, for example `if len(p.Replacement) == 0 || slices.ContainsFunc(p.Replacement, …)`, with the error text widened to say so. Mutant M51 shows this breaks no existing test.
- **Not pinned:** a pin would fail on the brief's code until the ruling.

**F2: 24 mutants survive the brief's tests. 22 of them would weaken security, and all 22 are now pinned (`aa65b40`).** The most important ones:
- **M43, the EOF flush.** At EOF the held tail would be released without the final scan. A body that ends in a complete form that could still have grown would then reach the cell raw. Two examples: the unpadded base64 of a secret whose length isn't a multiple of 3, or a secret ending in `&`, `%` or `\`.
- **M24, multi-valued headers.** `Header` would scrub only the first value of each key, so a second `Set-Cookie` would leak.
- **M18, escaped first bytes.** The first-byte table would ignore escapes of a secret's first byte. A key drawn from base64 can begin with `+` or `/`, and an echo of it spelled `%2B…` or `\/…` would pass.
- **M27–M33, base64 forms.** These cover base64 at offset 0 inside a longer value, the URL-safe alphabet's cores, and the padded and unpadded whole-value forms. The brief's 27-byte secret cannot see any of them, for two reasons:
  - Its length is a multiple of 3, so the padded form, the raw form and the offset-0 core are the same string.
  - It contains none of `>`, `?` or `~`. Those are the only printable bytes that put `+` or `/` into base64, so without them both alphabets give the same output.
- **M06–M08, M11, M13, M14 and M48, escape spellings:**
  - PHP's `&#039;`, `&quot;`, `&apos;` and `\/`
  - Python's `&#x27;`
  - Handlebars' `&#x3D;`
  - the escapes of `|` and `}`
- **M37, M38 and M46:** the 8-byte boundary. The vault accepts 8-byte values.
- **M22 and M47:** committing a shorter match while a longer spelling is still arriving. M47 also covers a longer secret that starts with a shorter bound secret.

The other two survivors are M50 (an empty scrubber returns its input slice, which is harmless) and M51 (F1's proposed hardening).

**F3: residuals beyond P4a-R18's list.** These are for the record: none is a spelling the brief claims to catch.
- PHP `addslashes`' `\'`
- JavaScript `\xHH`
- HTML5 named references (`&plus;`, `&sol;`, `&equals;`, and so on)
- zero-padded hex references (`&#x03c;`)
- hex that mixes upper and lower case
- `+` decoded to a space
- MIME-wrapped base64 (a line break inside the value)
- base64 of hex, base32, UTF-16 and quoted-printable
- a value in a header name, or split across two header values
- echoes in a different letter case
- the clean-EOF truncation above

Each one needs an upstream that transforms the key in an unusual way, and the oracle confirms that each one leaks.

## Mutation testing

I ran 52 mutants against a scratch copy of `scrub.go`; the worktree copy was never mutated.

| Test set | Killed | Survived |
|---|---|---|
| Brief's tests alone | 28 | 24 |
| Brief's tests plus the pins | 50 | 2 |

The two remaining survivors are M50 (harmless) and M51 (F1's hardening).

| Mutant | Brief tests alone | With the pins |
|---|---|---|
| M01 no upper backslash-u | killed | killed |
| M02 no lower backslash-u | killed | killed |
| M03 no lower percent | killed | killed |
| M04 no upper percent | killed | killed |
| M05 no &#d; | killed | killed |
| M06 no &#0dd; | survived | killed by `TestEveryEscapedByteMatchesInEverySpelling`, `TestPHPPythonAndTemplateEscapesAreReplaced` |
| M07 no &#xH; upper | survived | killed by `TestASecretOpeningWithAnEscapedByteIsReplaced`, `TestEveryEscapedByteMatchesInEverySpelling`, `TestPHPPythonAndTemplateEscapesAreReplaced` |
| M08 no &#xh; lower | survived | killed by `TestEveryEscapedByteMatchesInEverySpelling` |
| M09 no + for space | killed | killed |
| M10 no backslash-quote | killed | killed |
| M11 no &quot; | survived | killed by `TestPHPPythonAndTemplateEscapesAreReplaced` |
| M12 no &amp; | killed | killed |
| M13 no &apos; | survived | killed by `TestPHPPythonAndTemplateEscapesAreReplaced` |
| M14 no backslash-slash | survived | killed by `TestASecretOpeningWithAnEscapedByteIsReplaced`, `TestPHPPythonAndTemplateEscapesAreReplaced` |
| M15 no &lt; | killed | killed |
| M16 no &gt; | killed | killed |
| M17 no double backslash | killed | killed |
| M18 first table ignores escapes of the first byte | survived | killed by `TestASecretOpeningWithAnEscapedByteIsReplaced` |
| M19 never hold back | killed | killed |
| M20 no hold on a partial escape | killed | killed |
| M21 no hold when data runs out | killed | killed |
| M22 shortest spelling wins | survived | killed by `TestStreamingMatchesOneShotWhenALongerSpellingCouldFollow` |
| M23 release held tail on error | killed | killed |
| M24 Header scrubs first value only | survived | killed by `TestEveryValueOfAHeaderIsScrubbed` |
| M25 no base64 core at offset 1 | killed | killed |
| M26 no base64 core at offset 2 | killed | killed |
| M27 no base64 core at offset 0 | survived | killed by `TestBase64CoresOfBothAlphabetsAreDestroyed` |
| M28 cores std alphabet only | survived | killed by `TestBase64CoresOfBothAlphabetsAreDestroyed` |
| M29 cores url alphabet only | survived | killed by `TestBase64CoresOfBothAlphabetsAreDestroyed` |
| M30 no full raw url form | survived | killed by `TestBase64OfASecretEndingInAPartialGroup`, `TestStreamingMatchesOneShotWhenALongerSpellingCouldFollow` |
| M31 no full raw std form | survived | killed by `TestAFormThatCouldStillGrowIsReplacedAtEOF`, `TestBase64OfASecretEndingInAPartialGroup` |
| M32 no full url padded form | survived | killed by `TestBase64OfASecretEndingInAPartialGroup` |
| M33 no full std padded form | survived | killed by `TestBase64OfASecretEndingInAPartialGroup`, `TestStreamingMatchesOneShotWhenALongerSpellingCouldFollow` |
| M34 no upper hex | killed | killed |
| M35 no lower hex | killed | killed |
| M36 no plain form | killed | killed |
| M37 minSecret 7 | survived | killed by `TestTheShortestSecretIsEightBytes` |
| M38 minSecret 9 | survived | killed by `TestTheShortestSecretIsEightBytes` |
| M39 replacement unchecked | killed | killed |
| M40 slash unreserved | killed | killed |
| M41 no escapes for space | killed | killed |
| M42 base64 core left intact | killed | killed |
| M43 EOF releases the tail unscanned | survived | killed by `TestAFormThatCouldStillGrowIsReplacedAtEOF` |
| M44 held tail dropped | killed (does not compile; M52 is the compiling form) | killed |
| M45 no escape at the very end | killed | killed |
| M46 refuse an 8-byte secret | survived | killed by `TestTheShortestSecretIsEightBytes` |
| M47 hold only when nothing matched yet | survived | killed by `TestStreamingMatchesOneShotWhenALongerSpellingCouldFollow` |
| M48 no escapes for bytes 0x7c-0x7e (pipe, close brace) | survived | killed by `TestEveryEscapedByteMatchesInEverySpelling` |
| M49 Close does not close | killed | killed |
| M50 empty scrubber returns its input | survived | survived |
| M51 empty replacement refused (hardening probe, not a bug) | survived | survived |
| M52 held tail dropped (compiles) | killed | killed |

## Performance

Measured on an Apple M3 Ultra: `Reader` through `io.Copy` over 10 MiB, best of 3.

| Input (10 MiB) | ns/byte | MB/s | Allocated bytes per byte |
|---|---|---|---|
| SSE JSON text, test secret | 4.7 | 214.8 | 2.3 |
| random bytes, test secret | 1.4 | 710.6 | 2.0 |
| random base64 text, test secret | 4.5 | 220.7 | 2.1 |
| random hex text, test secret | 6.7 | 148.4 | 2.1 |
| the secret minus its last byte, repeated | 24.7 | 40.5 | 10.5 |
| `r` repeated (the secret's first byte) | 34.9 | 28.7 | 2.5 |
| escape-dense input, secret of `%`, `&` and `\` | 3.4 | 298.5 | 2.1 |
| escaped prefix of `punct`, repeated | 19.9 | 50.2 | 7.4 |
| SSE JSON text, 8 KiB random secret | 2.8 | 351.5 | 2.0 |
| SSE JSON text, 10 secrets bound to the host | 131.7 | 7.6 | 3.6 |

- **Typical cost:** one secret on an LLM SSE stream costs about 50 ms per 10 MiB. The worst adversarial single-secret input costs about 0.37 s per 10 MiB.
- **Many secrets per host:** every candidate byte tries every needle (about 12 per secret). With 10 secrets bound to one host, that is about 1.4 s per 10 MiB. Indexing the needles by first byte would bring this close to the one-secret cost, if hosts with many bound secrets become common. I didn't optimise it, because the brief doesn't ask.
- **Re-scanning a held tail is quadratic:** when the held tail grows by one byte per upstream read, it is re-scanned on every read. The cost depends on the secret's size:

  | Secret size | Cost |
  |---|---|
  | 64 B | 0.1–0.2 ms |
  | 512 B | 3–10 ms |
  | 2 KiB | 54–142 ms |
  | 8 KiB | 0.86–2.4 s |

  Only an upstream that already holds the real secret can build a hold like this. The cell can't, because it never sees the value.

## Notes for later tasks

- **Task 10, `Content-Length`:** keep it dropped, as the plan already does, because replacements change lengths. For example, the base64 of a 36-byte surrogate is 48 characters, where the secret's base64 was 36.
- **Tasks 10 and 12, trailers:** they are scrubbed at the body's EOF. `ReverseProxy` copies trailers only after the body copies cleanly, so an aborted body never relays unscrubbed trailers.
- **Tasks 10 and 12, reason phrases:** no later task relays an upstream reason phrase.
  - Task 12 serves intercepted connections with `http.Server` and `ReverseProxy`, which writes the status code only.
  - goproxy's own MITM loop, which would write `resp.Status`, is not used.
- **Surrogates:** surrogates (`ld_<tag>_<base62>_<base62>`) pass `New`'s replacement check. Their base64 never contains `+` or `/`.
- **Task 17's count:** the scrub package now has 20 tests, 9 more than the brief's 11.

## Artifacts

All in the shared scratchpad, under `/private/tmp/claude-501/-Volumes-Husky-s-SSD-4T-Projects/8ea76523-70ba-4eef-a6ab-cd9a3032d328/scratchpad/t7-scrub/`:

- `mod/internal/scrub/probe_test.go`, `probe_oracle_test.go` and `probe2_test.go`: the bypass probes and the oracle. Run them with `PROBE_OUT=<file> go test -run TestProbe ./internal/scrub/`.
- `mod/internal/scrub/perf_test.go` and `perf2_test.go` (run with `SCRUB_PERF=1`), and `conc_test.go`.
- `bypass-table.md` (all 638 rows) and `bypass-summary.md` (per form).
- `mutants.txt`, `mutate.pl`, `mutants-brief.txt` and `mutants-final.txt`; `mut/` is the mutation module.

## Addendum: controller rulings and the F1 fix

**Rulings (controller):**
- F1: accepted, and applied below.
- F2: the 9 pins in `aa65b40` are accepted.
- F3: the residuals are recorded.
- Performance (about 1.4 s per 10 MiB with 10 secrets bound to one host; index the needles by first byte if that ever matters): deferred.

**F1 fix: `fa07db9 fix(keyd): refuse an empty replacement in the scrubber`**
- `New` now refuses a pair whose `Replacement` is empty (nil or zero-length). The test sits in the same `if` as the unreserved-character rule, and the error text is widened to `scrub: a replacement must be one or more letters, digits and -._~, which no encoder escapes`. One comment line gives the reason: an empty replacement would let the text on either side of a deleted secret close up into it.
- Pin: `TestAnEmptyReplacementIsRefused` in `scrub_integrity_test.go`, covering `nil` and `[]byte{}`.
  - RED: on `aa65b40`'s `scrub.go` it fails with `New accepted the empty replacement []byte(nil)`. I replayed this in the scratch module, so the worktree was never reverted.
  - GREEN: it passes with the fix.
- Mutation spot-check on the changed `New`:
  - Dropping the empty check is killed by `TestAnEmptyReplacementIsRefused`.
  - Dropping the character check while keeping the empty check is killed by the brief's `TestNewRefusesShortSecretsAndEmptyIsANoOp`.
  - The two 8-byte boundary mutants (7, and refusing 8) are still killed by `TestTheShortestSecretIsEightBytes`.
- No caller changes: Task 10's `scrubberFor` already puts `keyd-redacted` in place of a missing surrogate.
- Verification:
  - `gofmt -l keyd` prints nothing; `go vet ./...` is clean on the host, darwin and linux.
  - `go test -race ./...` passes in every package (audit, cellca, events, netguard, scrub, surrogate, vault), and scrub is stable at `-count=30`.
  - `pnpm lint` and `pnpm hygiene` exit 0.
  - No Task 7 commit carries an attribution line, and the working tree is clean.
- `scrub.go` now differs from the brief only by this check (3 lines changed); `scrub_test.go` is still byte-identical to the brief.
- Counts: the scrub package now has 21 tests (the brief's 11, 9 pins in `aa65b40`, and 1 in `fa07db9`), so Task 17's expected total grows by 10, not 9.

Task 7 commits: `9f4f0f3`, `aa65b40`, `fa07db9`.

## Fix round 1 (the review of Task 7)

**Important 1: nothing pinned the release side of the streaming contract.**
- Two one-line mutants of `scrub.go:107` survived all 21 tests:
  - `if (more || true) && !final` holds from any candidate byte until EOF;
  - `if (more || end > 0) && !final` holds from any complete match until EOF.

  The SSE test's event contains none of this secret's candidate first bytes (`s.first` is `7Jcry`), so it only exercised the fast path.
- The pin is `TestAnOpenStreamReleasesEverythingItHasDecided`, in `keyd/internal/scrub/scrub_integrity_test.go`, committed as `97bfb65 test(keyd): pin that an open scrub stream releases what it has decided`. It is test-only: `scrub.go` is unchanged since `fa07db9`.
- **How it streams:** through an `io.Pipe` that stays open, read by one goroutine. `t.Cleanup` closes the writer, so a failure leaks no goroutine, and every wait is a `select` with a 5-second ceiling.
- **Step 1:** `data: {"delta":"cry"}\n\n` must come back whole before anything more is written. `c`, `r` and `y` each open a needle for this secret, so this event cannot take the fast path.
- **Step 2:** an event that echoes the secret, followed by more text and an event boundary, must come back scrubbed before EOF.
- **Step 3:** I write 1,000 bytes of `cry ` filler, then the hex form minus its last character.
  - Everything written must have come back except fewer than 6 × 54 bytes (54 bytes is the hex form, the longest form).
  - None of what came back may come from the hex prefix.
  - Writing the last character and an event boundary must then bring back the hex of the surrogate, before EOF.
- **Proof on a scratch copy** (the worktree's `scrub.go` was never mutated):
  - `if (more || true) && !final` is killed at step 1.
  - `if (more || end > 0) && !final` is killed at step 2.
  - I added a third mutant, `return out[:0], 0`, which holds the whole chunk whenever a match could still grow. It is killed at step 3, and also by `TestAnUpstreamErrorDropsTheHeldBytes`.
  - The review's `if !final` doesn't compile (`declared and not used: more`). `(more || true)` is its compiling form.
- **Verification:**
  - The scrub suite passes at `-count=50` and at `-race -count=10`.
  - `gofmt -l .` (in `keyd/`) and `gofmt -l keyd` (from the repo root) print nothing. `go vet ./...` is clean on the host, darwin and linux.
  - `go test -race ./...` passes in all 8 packages, now including Task 8's `policy`.
  - `pnpm lint` and `pnpm hygiene` exit 0. No commit has an attribution line, and the tree is clean.
- **Counts:** the scrub package now has 22 tests, so Task 17's total grows by 11 over the brief's 11.

**Minor 1: the overlap class is ruled a residual, with no code change.**

The review's reproductions are in `/private/tmp/claude-501/-Volumes-Husky-s-SSD-4T-Projects/8ea76523-70ba-4eef-a6ab-cd9a3032d328/scratchpad/t7review/fuzz/internal/scrub/zz_repro_test.go`. I re-ran them on `fa07db9`, and stream and one-shot agree in every case. They show that leftmost-longest matching can let a secret through when it touches another match or a replacement:
- **A secret that opens with `=`, right after a raw (unpadded) base64 form** of itself or of another bound secret.
  - The padded needle takes the `=` as padding, and the rest of the secret passes.
  - With `keyd-redacted`, whose base64 ends in `==`, the output holds the whole secret again.
  - With a 36-byte surrogate, the output holds all of the secret but its first byte.
- **A secret ending in `%`, `&` or `\`, right before a second secret that opens with the rest of that byte's escape** (`25…`, `amp;…`). The first match takes those bytes, and the second secret passes without its opening bytes.
- **A truncated echo right before a full one, when the secret ends with the replacement's first bytes.** `real-secret-value-` followed by `ld_key_…` spells the secret `real-secret-value-l` again. This also needs P4a-R18's truncation residual.

Each case needs a secret shaped to fit what sits next to it: an opening `=`, an escape byte at the end, or an ending that matches the start of the replacement. It also needs an upstream that puts the echoes back to back. I've recorded the class alongside F3's residuals.

**Claim narrowed:** the status line now excludes this class. It says no way past the scrubber was found in any encoding the brief names, apart from the overlap class.

Task 7 commits: `9f4f0f3`, `aa65b40`, `fa07db9`, `97bfb65`.
