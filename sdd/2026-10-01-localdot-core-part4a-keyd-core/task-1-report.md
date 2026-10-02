# Task 1 report: the Go module, the surrogate format and the CI job

**Status:** DONE_WITH_CONCERNS (the implementation is verbatim and every check passes; one low-severity
design concern in `Find` needs a ruling, see Concerns)

**Commit:** `acc74db feat(keyd): Go module, surrogate token format and the CI job` on `feat/core-part4a`
(author shadowhusky, no `Co-Authored-By` or AI attribution). `main` is unchanged at `992e82d`, and
`/Volumes/Husky's SSD 4T/Projects/localdot` was never touched.

## What I implemented

- Step 1: the worktree already existed, so I skipped `worktree add`. Verification:
  `git branch --show-current` printed `feat/core-part4a`, and `go version` printed `go version go1.27.1 darwin/arm64`
  (`/opt/homebrew/bin/go`).
- `keyd/go.mod`: `module github.com/shadowhusky/localdot/keyd`, `go 1.27`, `toolchain go1.27.1`. There are no
  dependencies, so there is no `go.sum`, and `go mod tidy -diff` reports no changes.
- `keyd/internal/surrogate/surrogate.go`: `Mint`, `Valid`, `Find`, `ID` and the private `checksum`.
- `keyd/internal/surrogate/surrogate_test.go`: the brief's 8 tests.
- `.github/workflows/ci.yml`: the `keyd` job, appended after `check` at the same indentation. There is no
  blank line, which matches the file (it had none).
- `.gitignore`: `keyd/bin/` appended as the last line.

Every block was extracted byte-for-byte from the brief with `sed`, and each was `diff`ed against
the plan's copy (plan lines 252–256, 263–376, 388–464, 476–490 and 498). All are identical.

## Tests: RED, then GREEN

RED (Step 3, test file only, `go test ./internal/surrogate/`, exit 1). This matches the brief's expectation:
```
# github.com/shadowhusky/localdot/keyd/internal/surrogate [github.com/shadowhusky/localdot/keyd/internal/surrogate.test]
internal/surrogate/surrogate_test.go:12:14: undefined: Mint
internal/surrogate/surrogate_test.go:22:6: undefined: Valid
internal/surrogate/surrogate_test.go:29:16: undefined: Mint
...
internal/surrogate/surrogate_test.go:72:9: too many errors
FAIL	github.com/shadowhusky/localdot/keyd/internal/surrogate [build failed]
```

GREEN (Step 5): `ok  github.com/shadowhusky/localdot/keyd/internal/surrogate 0.306s`. With `-v`, all 8 tests pass:
TestMintShapeAndChecksum, TestMintRejectsBadTags, TestMintIsUnique, TestValidRejectsTampering,
TestFindLocatesTokensInText, TestFindReportsShapeEvenWithBadChecksum,
TestFindSeesTokensGluedToOtherCharacters and TestIDIsStableAndHidesTheToken.

## Verification

| Check | Result |
|---|---|
| `gofmt -l keyd` (from the repo root) and `test -z "$(gofmt -l .)"` (in `keyd/`) | no output, pass |
| `go vet ./...`, `GOOS=darwin go vet ./...`, `GOOS=linux go vet ./...` | clean |
| `go test -count=1 -race ./...` | `ok .../internal/surrogate 1.306s` |
| `go mod tidy -diff` | no changes; the Go commands left `go.mod` unchanged |
| CI YAML parsed with Ruby's YAML | jobs `["check", "keyd"]`; the `keyd` job's structure is as specified |
| `pnpm install --frozen-lockfile` | done (an esbuild build-script warning was already there and is unrelated) |
| `pnpm lint` | `Checked 53 files ... No fixes applied.`, exit 0 |
| `pnpm hygiene` | exit 0 |
| Does hygiene cover the new files? | `git ls-files --cached --others --exclude-standard` lists `keyd/go.mod` and both `.go` files. A temporary probe file under `keyd/` with a fake `sk-`-shaped string made hygiene fail (`hygiene: OpenAI-style key in content of keyd/internal/surrogate/zz-hygiene-probe.txt`, exit 1). I then deleted it, and hygiene exits 0 again |
| `git check-ignore -v keyd/bin/keyd` | `.gitignore:11:keyd/bin/` |
| Commit hooks and template | none active, so nothing could add attribution |

## Files changed

- `keyd/go.mod` (new, 5 lines)
- `keyd/internal/surrogate/surrogate.go` (new, 77 lines)
- `keyd/internal/surrogate/surrogate_test.go` (new, 114 lines)
- `.github/workflows/ci.yml` (+15 lines: the `keyd` job)
- `.gitignore` (+1 line: `keyd/bin/`)

## Self-review

- **Spec fit:** the four signatures and the package path are exactly the brief's interface. Only the
  brief's files changed. Nothing changed under `apps/`, `cells/`, `packages/`, `spikes/` or `scripts/`,
  and there are no Docker or TypeScript changes.
- **Mint:** the rejection sampling keeps bytes below 248 (4·62), so every character is equally likely.
  22 base62 characters carry 22·log2(62) = 130.99 bits.
- **Checksum:** CRC32 fits losslessly in 6 base62 digits, because 62^6 ≈ 5.7e10 is more than 2^32.
- **Valid:** the cut index splits the body from the checksum correctly. CRC32 catches every
  single-character change, so `TestValidRejectsTampering` is deterministic, not probabilistic.
- **ID:** the first 6 bytes of SHA-256, which is 12 lowercase hex characters.
- **Comments:** only the brief's package doc, the rule comment on 248 and the doc lines.
- **Nits (kept verbatim, no action needed):** since Go 1.24, `crypto/rand.Read` never returns an
  error (it crashes instead), so `Mint`'s `err` branch can't be reached. The checksum's first
  character is always `0`–`4`, because CRC32 is less than 5·62^5. `Find` still accepts any 6 base62
  characters, so forgeries are reported, as the tests want.
- **CI:** I ran the job's steps locally but never ran the job on GitHub, because nothing in this plan pushes.
  `go-version-file: keyd/go.mod` resolves from the repo root, which is correct:
  `defaults.run.working-directory` applies only to `run` steps. `cache: false` also avoids setup-go
  looking for a `go.sum` that doesn't exist yet.

## Concerns

**1. `Find` misses a token when another token-shaped run overlaps it (low severity; swaps still
fail closed).** `Find` is `regexp.FindAllString`, which returns only *non-overlapping* matches. A
token-shaped run that ends inside the next token therefore consumes that token's first characters,
and the token is never reported. There are two ways this happens:

- the run's 6-character checksum ends on the token's leading `l` or `ld`; or
- the run's 22-character body ends on `ld` and its checksum is the first 6 characters of a tag
  that is 6 or more characters long.

So the brief's interface sentence, "every token-shaped substring, checksum or not", is not
true for overlapping runs. I reproduced this with a throwaway test against the real package. I deleted
it afterwards, and it was never committed:

```
forged4+tok   Find -> ["ld_xx_AAAAAAAAAAAAAAAAAAAAAA_AAAAld"]   real token found: false
forged5+tok   Find -> ["ld_xx_AAAAAAAAAAAAAAAAAAAAAA_AAAAAl"]   real token found: false
forged20+tag6 Find -> ["ld_xx_AAAAAAAAAAAAAAAAAAAAld_abcdef"]   real token found: false
valid hider (a minted token whose checksum ends "ld", found after 5611 mints):
  Find(m[:-2]+tok) = ["ld_key_ixvZIPa80ZGl6jDXJ3UJvq_3h02ld"]   real token found: false
  redact-style ReplaceAll leaves "surrogate:8f68b4c3f4a3_ant_M5ymPq54JndVrTLk9DIXa5_3pnQ0V"
```

What this means for the planned callers:

- **The swap still fails closed.** The shadowing match is itself token-shaped, so Task 9's `Inspect`
  refuses the request. A forged shadow is refused as `unknown`. A valid shadow is refused as
  `misplaced`, because `placed` demands that the header value equal the token exactly, and the glued
  text breaks that. This holds as long as `Inspect` keeps refusing every token that `Find` returns
  and that isn't exactly placed.
- **The residue lands in the audit log.** Task 5's `redact` uses `Find` plus `strings.ReplaceAll`.
  It would write the hidden token minus its leading `ld` (its 22 random characters and its checksum)
  into the audit line, and name only the shadow's ID. Tests that search the audit for surrogate
  text with `Find` or the full token would not catch this. The impact is low: a surrogate is not a
  secret, and the cell already holds it.

A possible fix, if the controller wants one (it changes Task 1 and Task 5, so I did not make it).
Report the anchored match at every `ld_` position. Each start has at most one match, because the tag
ends at the first `_`. Then have `redact` rewrite the union of the match spans instead of calling
`ReplaceAll` per token. I checked this in a scratch module outside the worktree. It is gofmt- and
vet-clean, passes the brief's 8 tests unchanged, and also passes an overlap test. In each case
above, it reports the shadow and then the real token.

```go
var anchored = regexp.MustCompile(`^ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}`)

func Find(s string) []string {
	var out []string
	for i := 0; i < len(s); i++ {
		j := strings.Index(s[i:], "ld_")
		if j < 0 {
			break
		}
		i += j
		if m := anchored.FindString(s[i:]); m != "" {
			out = append(out, m)
		}
	}
	return out
}
```

There are no other concerns.

---

# Fix report: the controller accepted concern 1

**Status:** DONE. Concern 1 is fixed, and no concerns remain open.

**Commit:** `81e2c7d fix(keyd): report overlapping surrogate-shaped tokens in Find`. It is a new commit on top of
`acc74db` (not amended), by shadowhusky, with no attribution. `main` is still at `992e82d`.

## What changed

- `Find` now reports every token-shaped substring, including ones that overlap. At each `ld_` offset it
  applies a start-anchored pattern, `leadingToken`. This replaces the unanchored `tokenPattern`, which
  is no longer used.
- **Order:** results come by start offset. The doc comment says so, and explains why the ruling's
  "then length" tie-break can never apply: at most one token can start at any offset, because a tag
  ends at its first `_` and every other part has a fixed length.
- **New test, `TestFindReportsOverlappingTokens`.** It has three cases, and each expects
  `[shadow, hidden]` in that order:
  - a token-shaped run whose checksum ends on the next token's `ld`;
  - the same run ending on just that token's `l`;
  - a run whose 22-character body ends on `ld` and whose checksum is the next token's 6-character
    tag (`abcdef`).
- `Mint`, `Valid` and `ID` are unchanged, and so are the brief's 8 tests. I did not touch Task 5.

## RED on `acc74db`

I added the test and left `Find` unchanged. The run exited 1. The brief's 8 tests still passed; only the new test failed:
```
--- FAIL: TestFindReportsOverlappingTokens (0.00s)
    surrogate_test.go:113: Find("ld_xx_AAAAAAAAAAAAAAAAAAAAAA_AAAAld_ant_8Wm5rRcTk01aQUfpuqO3JW_4MVPjg") = [ld_xx_AAAAAAAAAAAAAAAAAAAAAA_AAAAld], want [ld_xx_AAAAAAAAAAAAAAAAAAAAAA_AAAAld ld_ant_8Wm5rRcTk01aQUfpuqO3JW_4MVPjg]
    surrogate_test.go:113: Find("ld_xx_AAAAAAAAAAAAAAAAAAAAAA_AAAAAld_ant_8Wm5rRcTk01aQUfpuqO3JW_4MVPjg") = [ld_xx_AAAAAAAAAAAAAAAAAAAAAA_AAAAAl], want [ld_xx_AAAAAAAAAAAAAAAAAAAAAA_AAAAAl ld_ant_8Wm5rRcTk01aQUfpuqO3JW_4MVPjg]
    surrogate_test.go:113: Find("ld_xx_AAAAAAAAAAAAAAAAAAAAld_abcdef_tcnkorhCiZmIeKgmlcs7L3_0kfTM3") = [ld_xx_AAAAAAAAAAAAAAAAAAAAld_abcdef], want [ld_xx_AAAAAAAAAAAAAAAAAAAAld_abcdef ld_abcdef_tcnkorhCiZmIeKgmlcs7L3_0kfTM3]
FAIL
FAIL	github.com/shadowhusky/localdot/keyd/internal/surrogate	0.331s
```

## GREEN

All 9 tests pass: the brief's 8 plus `TestFindReportsOverlappingTokens`.
The run printed `ok  github.com/shadowhusky/localdot/keyd/internal/surrogate`.

## Checking the contract

I wrote a brute-force reference in a scratch module outside the worktree. It lists every substring that is
exactly token-shaped, ordered by start offset and then by length. I compared it with the new `Find` on
30,000 random texts, built from minted tokens, their prefixes and suffixes, and forged runs:

- The new `Find` matched the reference on every text.
- The old `Find` missed overlapping tokens in 1,551 of the texts.
- No offset ever started two token-shaped substrings.

## Checks

| Check | Result |
|---|---|
| `gofmt -l keyd` | no output |
| `go vet ./...` (host, `GOOS=darwin`, `GOOS=linux`) | clean |
| `go test -race ./...` | ok |
| `go mod tidy -diff` | no changes |
| `pnpm lint` | exit 0 |
| `pnpm hygiene` | exit 0 |

## Notes for callers

- **What `Find` returns now:** everything the old `Find` returned, plus any token that starts inside an earlier match.
- **A correctly placed token gains nothing.** "Correctly placed" means the whole value, or
  `Bearer <token>`, or a whole Basic field. Another token can only start inside it if the token is
  followed by `_<22 characters>_<6 characters>`. That can only happen in text glued on after it,
  which is refused anyway.
- **Callers that rewrite matches must merge overlapping ranges.** The controller will pass this on
  for Task 5's `redact`.
- **Task 9 works unchanged, and gets stricter.** Its `scan` and `placed` now see the hidden token as an
  occurrence of its own, and refuse it under its own ID.
