# Task 5 report: the audit log and the event hub

**Status:** DONE_WITH_CONCERNS. The brief's work is in byte for byte, ruling 1 is implemented with tests,
and every check passes. The concerns are the ruling-3 findings below. One of them (C5, availability)
needs a ruling.

**Commits** on `feat/core-part4a`, BASE `6463c11`. All are by shadowhusky, with empty bodies and no
`Co-Authored-By` or AI attribution. `main` is still at `992e82d`.

| Commit | What |
|---|---|
| `0137cc8 feat(keyd): hash-chained audit log and event hub` | the brief's four files, byte for byte |
| `a3ba380 feat(keyd): FindIndex reports the spans of surrogate-shaped tokens` | ruling 1(a), and the two surrogate tests from 1(c) |
| `2f5db39 fix(keyd): redact overlapping surrogates in audit lines as one span` | ruling 1(b), and the audit test from 1(c) |

The tree is green at every commit. At `a3ba380` the brief's `redact` still calls `Find`, which now
runs on `FindIndex`.

## 1. The brief's work (`0137cc8`)

- I extracted all four files from the brief with `sed`, using the code fences at brief lines 36/257,
  260/334, 345/596 and 599/697. Before that, I diffed brief lines 1–712 against the plan's Task 5
  section (plan lines 2379–3090), and they are identical.
- **RED (Step 2)** came from `go test ./internal/audit/ ./internal/events/` with exit 1. It matches the
  brief:
  ```
  internal/events/events_test.go:8:38: undefined: Event
  internal/events/events_test.go:23:7: undefined: NewHub ...
  internal/audit/audit_test.go:19:30: undefined: Log
  internal/audit/audit_test.go:22:12: undefined: Open ...
  FAIL	github.com/shadowhusky/localdot/keyd/internal/audit [build failed]
  FAIL	github.com/shadowhusky/localdot/keyd/internal/events [build failed]
  ```
- **GREEN (Step 4)** came from `go test -race ./internal/audit/ ./internal/events/`, which printed `ok` for
  both: 8 audit tests and 3 events tests, as the brief expects.
- **Step 5:** `gofmt -l .` printed nothing, `go vet ./...` was clean, and the commit uses the brief's message.

## 2. Ruling 1: rewrite merged spans, never token by token

**(a) `surrogate.FindIndex(s string) [][2]int`** returns the byte span `[start, end)` of every token-shaped
substring, overlapping ones included, ordered by start offset. It is the old `Find` loop, with
`leadingToken.FindStringIndex` in place of `FindString`. `Find` is now built on it, as
`s[span[0]:span[1]]` per span, so the two can't drift. `Find`'s doc comment still states the contract,
and `FindIndex`'s comment points to it.

**(b) `redact`** now calls `redactText` on each of the seven fields the request controls, and that list
is unchanged. `redactText` walks the `FindIndex` spans. Each run of overlapping spans, or spans that touch
(`next.start <= end`), becomes one merged span. Each merged span is rewritten exactly once, as
`surrogate:<ID>` for a single token, or as `surrogate:<ID>,<ID>,…` with every token's ID in start order.
The first ID is always the first token's. The doc comment on `redact` states this format and the reason
for it.

**(c) Tests:**
- `audit.TestOverlappingSurrogatesAreWrittenAsOneSpan` has 5 cases:
  - two *minted* surrogates sharing `ld` (it mints until a checksum ends in `ld`, about 1 in 3,844);
  - a forged checksum ending on a surrogate's `l`;
  - a forged body ending on the `ld` of a surrogate with a 12-character tag, so the overlap is 9 bytes;
  - a chain of three;
  - two surrogates side by side.

  For each case, it checks the exact written `Path` and `Detail` (`surrogate:<ID>,<ID>`), that the hooked
  line equals the returned one, that `surrogate.Find` over the whole file is empty, and that no token's
  22-character body or 6-character checksum appears anywhere in the file.
- `surrogate.TestFindAndFindIndexMatchABruteForceSearch` builds 2,000 seeded random texts from minted tokens
  (tags of 2, 3, 6 and 12 characters, and the tag `ld`), their prefixes and suffixes, tokens one or two short
  of a checksum, bodies two short, and `l`/`ld`/`ld_` fragments. It checks `FindIndex` and `Find` against
  every substring that matches the exact-shape regexp. That is a full O(n²) search over all `(i, j)`, which
  shares no logic with the implementation. A coverage guard requires at least 10 overlaps of each possible
  size: 1, 2 and 9 bytes. The seeded corpus has 66, 75 and 48. It runs in 0.09 s, or about 2–3.5 s under
  `-race`.
- `surrogate.TestMintAcceptsTheShortestAndLongestTags` uses the tags `ab`, `09`, `abcdefghijkl` and
  `a1b2c3d4e5f6`. It checks that `Mint` succeeds, the result is `Valid`, it has the tag prefix, and
  `Find("x"+tok+"y") == [tok]`.

**RED on the brief's code.** I added the three tests on top of `0137cc8`, with no implementation change:
```
internal/surrogate/surrogate_test.go:192:13: undefined: FindIndex
FAIL	.../internal/surrogate [build failed]
--- FAIL: TestOverlappingSurrogatesAreWrittenAsOneSpan
  two surrogates sharing ld: ... "path":"/keys/surrogate:966e8ae4335c_ant_XybEvJ7DK0ddt2cKj6S56Z_44WkAq/x" ...
  a checksum ending on a surrogate's l: ... "/keys/surrogate:a3db7f59a5c0d_ant_XybEvJ7DK0ddt2cKj6S56Z_44WkAq/x" ...
  a body ending on a surrogate's ld: ... "/keys/surrogate:7119896eb895behind_eAmjGDU5GHtcf4GAcDEPAh_36aVMn/x" ...
  a chain of three: ... "/keys/surrogate:7e07b92c93bc_yy_cT19EjxL8Xt5TBVVv7DgyB_Ef5Gsurrogate:db37e42e638b/x" ...
  two surrogates side by side: ... "/keys/surrogate:db37e42e638bsurrogate:d8483a4186f1/x" ...
FAIL	.../internal/audit
```
In four of the five cases, the hidden surrogate's random body and checksum were written to the line. In the
fifth (side by side), the format is wrong but nothing leaks.

**Deviation: the tag-boundary test can't fail on the brief's code.** It pins behaviour that is already
correct. In a scratch copy with the brief's `surrogate.go` and without the `FindIndex` test, it passes. Its
only RED on the brief's code is the shared file's `undefined: FindIndex` build failure, and I don't count
that as meaningful. I showed what it catches by mutation instead (next section). It kills all six
tag-bound mutants, and five of them survive every test that existed before.

**GREEN:** audit 9/9, events 3/3 and surrogate 11/11, all with `-race`. They also passed repeated runs
(`-count=30` for surrogate, `-count=200` for the audit redaction tests, and `-race -count=20` for audit and
events) with no flake.

### Mutation runs (scratch copies, `perl` substitution, the substitution checked to apply)

| Mutant | New tests | Tests that existed before |
|---|---|---|
| S1 `Find` as at `acc74db` (non-overlapping `FindAllString`) | killed by the brute-force test | killed |
| S2 `FindIndex` via `FindAllStringIndex` (non-overlapping) | killed by the brute-force test | killed |
| S3 `FindIndex` skips past each match | killed by the brute-force test | killed |
| S4/S5 `tagPattern` `{3,12}` / `{2,11}` | killed by the boundary test (and brute force) | **survived** |
| S6 `leadingToken` `{3,12}` | killed | killed |
| S7 `leadingToken` `{2,11}` | killed by the boundary test and brute force | **survived** |
| S8/S9 `exactPattern` `{3,12}` / `{2,11}` | killed by the boundary test | **survived** |
| S10/S11 span end −1 / start +1 | killed | killed |
| A1 the brief's token-by-token `redact` | killed by the overlap test | **survived** the brief's 8 |
| A2 merge overlapping spans only, not touching ones | killed | **survived** |
| A3 name only the first token | killed | **survived** |
| A4 IDs without a separator | killed | **survived** |
| A5 one rewrite per span, no merging | killed | **survived** |
| A6/A7 `Detail` / `Path` not redacted | killed | killed (`TestSurrogatesAreWrittenAsTheirIDs`) |
| A8 `end = spans[i][1]` instead of `max(…)` | survived: **equivalent**. A token that starts inside another always ends past it (overlaps are only 1, 2 or 9 bytes), so ends increase | survived |
| A9 no early return when there are no spans | survived: **equivalent**. Same output, one copy fewer | survived |

## 3. Verification (at `2f5db39`)

| Check | Result |
|---|---|
| `gofmt -l keyd` (repo root) | prints nothing |
| `go vet ./...`, `GOOS=darwin go vet ./...`, `GOOS=linux go vet ./...` (in `keyd/`) | clean |
| `go mod tidy -diff` | no changes (still no dependencies) |
| `go test -race -count=1 ./...` (in `keyd/`) | ok: audit, events, netguard, surrogate, vault |
| Top-level tests | audit 9 (8 from the brief, +1), events 3, surrogate 11 (9, +2), netguard 22, vault 31 + 1 skip (the opt-in Keychain test, which I did not run). That is 77 functions, 76 passing and 1 skipped |
| `pnpm lint` | exit 0 (`Checked 53 files … No fixes applied.`) |
| `pnpm hygiene` | exit 0. `git ls-files` lists the four new Go files, so hygiene scans them |

## 4. Self-review

- **Ruling 2:** inspection scope is unchanged. Nothing new scans bodies. `redact` covers the same seven
  fields the brief lists.
- **Ruling 3:** the audit file's mode (`0600` at create, plus `Chmod`), the hash chain, `resume`, `Verify`,
  the cut-back of failed writes, the hook and the hub are exactly the brief's code. Only `redact` changed.
- **Redact before truncate:** `Detail` is still cut to 512 bytes after `redact`, as in the brief. Cutting
  first could halve a token, which would then stop being token-shaped and escape redaction.
- **Format:** the output of a merged span (`surrogate:` followed by hex and commas) can't be part of a new
  token itself, because tokens contain neither `:` nor `,`. C2 below is the one way a token shape can still
  be completed.
- **Comments:** the two doc comments (`FindIndex`, `redact`) and one comment in the brute-force test
  explaining the overlap sizes 1, 2 and 9. No narrative comments.

## 5. Concerns

These are the ruling-3 findings: places where the brief's design could put a real value or a usable
surrogate into a line, plus one availability issue. I confirmed each with a throwaway probe test in a scratch
copy of the module. None were committed. C1 to C3 apply to the brief's `redact` exactly as they do to the
new one.

- **C1. A surrogate's body without a well-formed checksum survives redaction.** Redaction works by shape
  only. `ld_<tag>_<22 random>` followed by anything other than `_` and 6 base62 characters is not token-shaped,
  so it is written as is. The probe passed `tok[:len-1]+"!"`, `tok[:len-7]` and `tok[:len-3]+"ld_x"`, and all
  three kept the body. The checksum is the public CRC32 of `ld_<tag>_<body>`, so the full surrogate can be
  rebuilt from the line. The impact is low, as in Task 1's assessment: the cell wrote its own surrogate, and
  a surrogate works only through that cell's listener and proxy token. Suggested fix: also redact body-shaped
  runs, meaning `ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}` plus any `_` and up to 6 base62 characters after it,
  merged with the token spans. This also closes C2.
- **C2. A rewrite can complete a token shape.** The probe wrote the path `/k/ld_ab_<22×Q>_` + tok. `FindIndex`
  sees only `tok`, so the line becomes `…_ld_ab_QQQ…Q_surrogate:6c514810f4e7`. `surrogate.Find(file)` then
  returns `["ld_ab_QQQQQQQQQQQQQQQQQQQQQQ_surrog"]`. Task 17's S4 probe asserts
  `len(surrogate.Find(auditFile)) == 0` (plan line 14105), so a cell sending such a path breaks that
  invariant. The completed shape is never a valid surrogate with a full `surrog` checksum, because a valid
  checksum starts with `0`–`4`. With 1–5 checksum characters before the token it can complete a real one,
  but only if the cell planted that surrogate's body, which is already C1. Fix: the body spans in C1, or
  repeat `redactText` until `FindIndex` finds nothing. That terminates, because each rewrite makes the text
  shorter: a merged run of k tokens is at least 26k+9 bytes, and its rewrite is 13k+9.
- **C3. Six string fields are not redacted:** `Cell`, `Mode`, `Reason`, `SecretID`, `SurrogateID` and
  `Usage`. The probe showed a token in any of them is written as is. The plan has keyd choose all of them,
  but `Write` doesn't enforce that, so a later caller that puts request or upstream text into `Reason`
  would leak. Suggested fix: redact every string field, which is cheap, or make this a review point for
  Tasks 9–16.
- **C4. `Write` can't recognise a real value.** Redaction matches only surrogate shapes. `Detail` (an
  error's text) is the one free-text field. The plan swaps real values only into headers, and Go's
  transport errors name a header but never print its value. Even so, Tasks 9–16 must never pass text that
  embeds a swapped header, such as a dumped request. This is a review point, not a code change here.
- **C5. Availability (Important, needs a ruling).** The fields a request controls are uncapped except
  `Detail`, but `resume` reads only the last 64 KiB (`tailWindow`).
  - **A line over 64 KiB:** the next `Open` fails permanently with `audit …: last line: invalid character
    'a' looking for beginning of value`. The probe showed this for a 70 KiB path. keyd then can't start
    until someone moves the file.
  - **A line over 1 MiB:** `Verify` and `keyd verify-audit` also fail, with `bufio.Scanner: token too long`
    (probe, 2 MiB path: `Verify = 1`).
  - **How a cell gets there:** later tasks log `r.URL.Path` as is (plan lines 6618, 6744, 6800, 8365 and
    11709), and the plan sets no `MaxHeaderBytes`. With Go's default of about 1 MiB, a single request from
    a cell can stop keyd restarting.
  - **Suggested fix:** cap each field the request controls after `redact`, as `Detail` already is. For
    example: `Path` 2 KiB, `Host`/`SNI` 255, `Method` 32, `Route`/`Model` 128. Alternatively, or as well,
    let `resume` read back past 64 KiB.
- **C6 (minor). A huge partial last line costs one failed start.** With a partial last line over 64 KiB,
  the first `Open` cuts 64 KiB and then fails with `no line end in the last 65536 bytes` (probe: 102,601 →
  37,065 bytes). The second `Open` repairs it, but its repair line counts only the rest, so the first cut is
  never recorded. This is only reachable through C5's long lines.
- **C7 (minor, tamper evidence). `Verify` misses an added `\r`.** `Verify` uses `bufio.ScanLines`, which
  drops a `\r` before `\n`. A CR inserted at the end of a line passes (probe: 489 → 490 bytes,
  `Verify = 3, nil`). The JSON is unchanged, so no record can be altered this way. Fix: a split function
  that keeps the `\r`, or treat any `\r` as broken.
- **C8 (minor).** `Detail` is cut at 512 *bytes*, which can split a multi-byte character. The file then
  holds U+FFFD, while the returned and hooked line keep the raw bytes. This is harmless.
- **Note (Task 1's deferred minor, unchanged):** `FindIndex` keeps `Find`'s fresh regexp match at each `ld_`
  offset. `redact` costs the same as in the brief.

---

# Task 5 fix round (controller rulings on C1, C2, C3, C5 and C7)

**Commit:** `bfc33b0 fix(keyd): cap and redact every audit field and check raw line bytes`. It touches
`keyd/internal/audit` only. `events` needed no change: the data of `key.use` comes from the audit line,
which is now capped and redacted.

## What changed

- **C3: every text field is redacted.** `redact` now covers all 15 text fields that `Write` takes from
  its caller: `Kind`, `Cell`, `Mode`, `Method`, `Host`, `Path`, `SNI`, `Route`, `Model`, `Decision`,
  `Reason`, `SecretID`, `SurrogateID`, `Usage` and `Detail`. `Time` and `Prev` are `Write`'s own.
  `Line` has no user-agent field, so none was added. The test finds the fields by reflection, so a text
  field added to `Line` later fails the test until `redact` covers it.
- **C5: caps.** Every text field is cut to 2,048 bytes, and `Detail` keeps its 512. A cut field ends in
  the marker `…` (U+2026), counted inside the cap. The cut happens after redaction, so a cut can never
  leave half a surrogate unrewritten; a mutant that cuts first is killed. The tests pin the exact caps as
  literals: 2048, 512 and `…`.
- **C5: bounds.** `maxLine = 256 KiB` is a bound on the longest line `Write` can produce, newline
  included. The worst case is every text field full of `<`, which JSON writes as six bytes
  (`\u003c`), with every number at its longest form. It measures **175,389 bytes**
  (corrected in fix round 2: the true worst case is 175,636 bytes).
  - `Verify`'s scanner allows lines up to `maxLine`.
  - `Open` reads a `2 × maxLine` tail. That holds the last line plus the longest partial line a crash
    can leave after it.
- **C2: bracketed rewrite.** The rewrite is now `[surrogate:<ID>]`, or `[surrogate:<ID>,<ID>]` for a
  merged run. A bracket can't be part of a token, so no token shape can extend into the rewrite, and the
  rewrite contains no `ld_`. As a result a rewritten field never holds token-shaped text.
  - On `2f5db39`, the four completions were `…_surrog`, `…_0surro`, `…_01surr` and `…_012sur`.
  - With four or five checksum characters, the token's own `ld` or `l` completes the run itself. That
    is an overlap, which was already merged, so the test covers only 0 to 3.
- **C7: `Verify`.** It splits on `\n` only (`splitLines`), keeping a `\r`, and hashes each line exactly as
  stored. It also refuses any line holding a control character below 0x20. `Write` never writes one,
  because JSON escapes them, so this catches a `\r` or a tab even in the newest line, which no later line
  vouches for.
- **C6, done alongside C5 (not ruled on).** `resume` now validates before it truncates. A log `Open`
  can't resume, either because no line end is within its window or because the last line can't be read,
  is refused without being cut. Before, it cut 64 KiB or the partial line first and then failed.
- **The brief's test changed for the new format.** In `TestSurrogatesAreWrittenAsTheirIDs`, the expected
  `named` is now `[surrogate:<ID>]`. The same change applies to `TestOverlappingSurrogatesAreWrittenAsOneSpan`.

## Tests (audit 9 → 16)

| Test | Pins | On `2f5db39` |
|---|---|---|
| `TestEveryTextFieldIsRedacted` | C3, each of the 15 fields | fails: 8 fields keep the token (it even reached `"kind"` in the file), and the other 7 use the old format |
| `TestARewriteNeverCompletesATokenShape` | C2 | fails: the four completed shapes above |
| `TestTextFieldsAreCappedAtFixedLengths` | C5 caps (2048, 512, `…`, kept exactly at the cap), plus redaction before the cut | fails: nothing is capped, and `Detail` is cut without the marker |
| `TestAOneMiBPathIsCappedAndTheLogStillOpens` | C5, the ruling's own test: a 1 MiB path is written capped, then `Open` and `Verify` succeed | fails: the path is written whole, at 1,048,577 bytes |
| `TestTheLongestLinesReopenAndVerify` | C5 bounds: 3 worst-case lines plus the longest partial line, then `Open` (repair) and `Verify` (4 lines) | fails: a 347,646-byte line |
| `TestVerifyCatchesAControlCharacterInAnyLine` | C7: a CR ending the first line, a CR ending the newest line, and a tab inside the newest line | fails: all three pass `Verify` |
| `TestOpenLeavesALogItCannotResumeUncut` | C6 | fails: it cut 65,536 bytes, and 7 bytes, before refusing |

**RED:** I captured it by running the new test file against `2f5db39`'s `audit.go` in a scratch copy. The
tests use literal caps rather than the new constants, so they compile there and fail for these reasons.
**GREEN:** 16/16 under `-race`, also at `-count=20`.

**Mutation run: all 17 killed.** The mutants:
- no cap on the 14 fields;
- a cut without the marker;
- `maxField` 4096, `maxDetail` 1024;
- a cut before the rewrite, for the fields and for `Detail`;
- the rewrite without brackets;
- `Kind`, `Usage` or `SurrogateID` left unredacted;
- `ScanLines` again, and a split that drops the CR;
- no control-character check;
- `tailWindow = maxLine`, a 64 KiB `Verify` buffer, `maxLine` at 128 KiB;
- truncate before validating.

## Residuals

- **C1 (ruled: no change):** a surrogate's body without a well-formed checksum is not token-shaped, so it
  is written as is. It is a fragment the cell itself sent, and surrogates are worthless off the Mac.
- **The newest line:** the chain can't vouch for it. An edit there other than a control character passes
  `Verify` until a later line is written; catching it would need an anchor outside the file. The `\r` the
  ruling names is caught.
- **C8, unchanged:** a cut at the byte cap can split a multi-byte character, which JSON then writes as
  U+FFFD.
- **Carry to the plan and Part 4b:** the interface text "written as `surrogate:<id>`" is now
  `[surrogate:<id>]`. The plan's later checks still match: Task 10's `Contains("surrogate:"+ID)` (plan line
  6204), and Task 17's S4 `surrogate.Find(audit) == 0` (line 14105), which can no longer be broken by crafted
  paths.

---

# Vault round 2 (re-review residuals RR1 to RR4)

**Commit:** `fd288ad fix(keyd): vault rollbacks keep intact values and fail closed otherwise`. It touches
`keyd/internal/vault` only.

## What changed

- **RR1:** after the new value reads back whole, `Keychain.Put` no longer fails on an old chunk it can't
  remove, because `Get` never reads past the count the item names.
  - It logs `keyd: storing secret <id> left an old chunk behind: keychain: delete <id>.<n>: security
    exited with status <s>`, which never includes a value, and moves on to the remaining chunks.
  - **Existing test changed:** round 1's `TestKeychainPutReportsAnOldChunkItCannotRemove` pinned the
    opposite behaviour. It is now `TestKeychainPutStandsOverAnOldChunkItCannotRemove`: with the delete of
    chunk 2 refused, the `Put` stands, `Get` returns the new value, and chunks 1, 3, 4 and 5 still go.
- **RR3:** a `Keychain.Put` that wrote nothing (its first chunk refused) now says so. Its error wraps
  `errUnchanged` (`… (nothing was written)`). `Vault.Put` then leaves the intact old value alone. Before,
  it re-put the old value, which failed the same way, and then deleted it.
- **RR2:** when the rollback has no old value to put back and the store refuses the delete, the record
  leaves memory (`restoreValueLocked`), so this process fails closed.
- **RR4:** if putting the old index back fails, the value is deleted instead of restored, and if that
  delete also fails, RR2's rule drops the record. I refined the ruling here:
  - **Why.** Applied literally ("if the re-save fails, delete"), it breaks round 1's
    `TestAFailedPutChangesNothing`. There both saves fail before any rename, the index on disk is
    unchanged, and keeping the old value is right.
  - **How.** `writeFileAtomic` now wraps errors after its rename in `errNotSynced` (via a new `syncDir`).
    `Put` re-saves only when the rename landed, and deletes when that re-save fails.
  - **What pins it.** Mutant V8 (re-save whatever failed) is killed by `TestAFailedPutChangesNothing`. The
    boundary test `TestAFailedRenameKeepsTheOldValue` (a refused rename keeps the value) kills V10.
- **Test seam:** `Vault.write`, set to `writeFileAtomic` in `Open`, like the existing `now` field. The RR4
  test uses it to fail the second save before its rename.

## Tests (vault 31 → 36, plus the opt-in skip)

| Test | Derived from | On 6463c11's logic |
|---|---|---|
| `TestAPutStandsOnceItsValueReadsBack` | RR1 probe: a torn old value, a shorter new value, every delete refused | fails: `Put … delete weather.1: security exited with status 1`, and the old binding is left on the new value |
| `TestKeychainPutStandsOverAnOldChunkItCannotRemove` | RR1 at the keychain level (converted test) | fails: `Put … delete weather.2` |
| `TestARecordThatWouldServeTheNewValueLeavesMemory` | RR2 probe | fails: `the hosts [api.example.test] still serve "rotated-fake-value-for-test"` |
| `TestAPutThatWroteNothingKeepsTheOldValue` | RR3 probe | fails: after a restart the value is gone |
| `TestAnIndexThatCannotBePutBackLeavesNoValue` | RR4 probe: the directory sync fails for real (dir 0300; skipped as root), and the re-save fails before its rename through the seam | fails: `after a restart: the hosts [new-host.example.test] keep the value "real-secret-value-for-test"` |
| `TestAFailedRenameKeepsTheOldValue` | the boundary of the RR4 refinement | passes there by design: the old code also kept the value. It kills V10 |

**RED, run on 6463c11's vault logic:** I first added the `write` seam as a separate, behaviour-free edit,
so the tests compile and fail for the reasons above.

**GREEN:** the vault package passes under `-race` with 36 tests plus the opt-in skip, and at `-count=10`
for the rollback tests.

**The reviewer's own probes, rerun on the fixed code:**
- **RR1:** passes. The `Put` stands, with the new binding and the new value both in process and after a
  restart, and five log lines name only `weather` and its chunks.
- **RR2:** the record is gone (`hosts [], Value "" (vault: secret not found)`). The probe itself then
  panics on `rec.Hosts[0]`, because it assumed the record would remain.
- **RR3:** passes. The store, the process and a restart all hold the old value.
- **RR4:** the probe needs the reviewer's `writeHook` copy, so `TestAnIndexThatCannotBePutBackLeavesNoValue`
  is its equivalent.

**Mutation run: 10 of 11 killed.** V6 (drop the record even when the old value is known) survives. That
case is a triple failure where the cache still serves the old value under the old binding. Dropping the
record costs availability only, and the ruling limits dropping to the case where the old value is
unknown.

## Residuals

- **RR2 after a restart:** the process fails closed, but the old index is still on disk and the store
  still holds the new value. A restart would serve that mix. It needs a failed read, a failed save and a
  failed delete in one `Put`.
- **The known-old-value triple failure:** if the save, the re-put of the old value and the delete all
  fail, the result is the same as the residual already accepted in round 1.
- **RR1's fragment:** an old chunk that couldn't be removed stays in the keychain as a fragment of the
  rotated-away value. It is never read, and it lasts until a later `Delete` or a longer value overwrites
  it.
- **`TestAFailedDirectorySyncPutsTheOldIndexBack` now also deletes the value.** The save putting the old
  index back renames but can't sync either. The test checks only the index, and that still passes.

## Verification (at `fd288ad`)

- `gofmt -l keyd` prints nothing.
- `go vet ./...` is clean on the host, with `GOOS=darwin` and with `GOOS=linux`.
- `go mod tidy -diff` shows no changes.
- `go test -race -count=1 ./...` passes for every package: audit 16, events 3, surrogate 11, netguard 22,
  and vault 36 plus 1 skip. That is 89 functions.
- `pnpm lint` and `pnpm hygiene` both exit 0.
- I didn't run the opt-in Keychain test. The tree is clean, and `main` is still at `992e82d`.

---

# Fix round 2 (controller rulings 1 to 7 after the review)

**Commit:** `b441b98 fix(keyd): set an unresumable audit log aside and let a slow subscriber recover`. It sits on
`21da3b7` (Task 6), touches `keyd/internal/audit` and `keyd/internal/events` only, and carries no attribution.

## What changed

1. **Set aside instead of refusing (replaces my C6 refusal).**
   - **The fast path is unchanged:** a partial tail inside the window becomes an `audit-repair` line.
   - **Where `Open` used to refuse:** that is, no line end within the 512 KiB window, or a last line that isn't JSON. It now:
     - hashes the whole file with SHA-256;
     - checks that `<path>.damaged-<UTC 20060102T150405.000000000Z>` is free (`Lstat`), then renames the log to it;
     - creates a fresh file (`O_EXCL`, 0600) whose first line starts a new chain at genesis.
   - **The first line:** `kind:keyd`, `decision:error`, `reason:"audit-rotated"`, `bytesIn` set to the damaged size, and
     `detail:"<name> sha256:<hex>: <cause>"`.
   - **One stderr line**, in RR1's style: `keyd: audit log <path> could not be resumed (<cause>); it is set
     aside as <name> and a new chain begins`.
   - **`Open` still refuses** when hashing fails, when the name is already taken, or when the rename, the new
     file or its first line fails. I/O errors from `Stat`/`ReadAt` are not damage, so they refuse too.
   - **Seams:**
     - `Open` is now `openFile` plus `start(path, f)`, so a test can hand `start` a failing file.
     - A package `clock` (default `time.Now`) stamps new Logs and the set-aside name; one test fixes it to force a name collision.
2. **`Subscribe(1)` recovers after a drop.**
   - **Slots:** a subscriber's channel holds `max(buf, 1)` events plus one slot kept for a drop notice. An
     event is sent only while it leaves that slot free, and a pending notice goes out just before it. So a
     notice always has an event behind it.
   - **Side effects:** `Subscribe(0)` now holds an event, and the brief's `TestASlowSubscriberDropsAndIsToldHowMany`
     passes unchanged.
   - **Why plain sends are safe:** the sends follow the room check, and only `Publish` sends, under `h.mu`.
   - **Deviation:** the reviewer's `TestProbeDroppedCountResets` can't pass verbatim under any hub that recovers.
     - **Why:** it needs the same state (an empty channel, a pending count) to produce a notice alone at its
       fourth `Publish` but a notice plus the event at its fifth.
     - **What I committed instead:** `TestADropNoticeCountsOnlyTheNewDrops`, which keeps both of the probe's
       points: each notice counts only new drops (this kills E1), and events flow again.
     - **Evidence:** run verbatim on the fix, the probe fails at its second notice, as predicted.
3. **Hub probes.**
   - `TestTheHubSurvivesChurn` is the reviewer's churn probe, with a 30-second stall check added.
   - `TestPublishNeverBlocks` fails fast on a blocking `Publish`:
     - it runs first in the file;
     - its subscribers read now and then, so each passes through every fill level;
     - on a stall it panics, which ends the run in about a second.
   - **Why it panics rather than calls `t.Fatal`:** a blocked `Publish` holds the hub's lock, so the brief's
     slow-subscriber test would then wedge in its deferred `cancel` until the 10-minute timeout.
   - `TestSubscribeHoldsAtLeastOneEvent` pins the `max(buf, 1)` clamp.
4. **`Verify` pins.** `TestVerifyChecksTheSequenceAndTheFirstLink` uses hand-chained lines with valid
   hashes: a skipped seq, a repeated seq, a first seq of 2, and a first link off genesis.
5. **The reflection guard.** `textFields` now fails on any `Line` field whose kind isn't string, an int or
   uint of any width, a float or bool.
6. **Accuracy.**
   - **The escape:** the test comment `\u003c` is restored. The editing tool had turned my `\u003c` into
     `<`, and did the same in this report, which is fixed too.
   - **The worst case:** the line is now measured at **175,636 bytes**, not the 175,389 I first reported.
     The new test fills every text field exactly to its cap, with a 20-digit seq, a 9-digit fraction of a
     second and `-MaxFloat64`. The reviewer's 175,632 fits a positive `MaxFloat64` (one byte shorter) and
     macOS's microsecond clock (three bytes shorter).
   - **`Open`'s doc comment** now describes both the repair and the rotation.
7. **Disk full: the partial line isn't cut before the repair line lands.**
   - The log file is no longer opened in append mode; `Write` seeks to the end it tracks.
   - A repair line is written over the partial line, and only then is the rest cut.
   - If the repair line can't be written, `Open` fails and the partial line is still there for the next
     start. At most, the start of the repair line has overwritten part of it, still without a newline.

## Tests (audit 16 → 19, events 3 → 7)

| Test | Ruling | On `fd288ad` |
|---|---|---|
| `TestOpenSetsAsideALogItCannotResume` (replaces `TestOpenLeavesALogItCannotResumeUncut`): no line end in reach, an unreadable last line, a 600 KiB NUL tail, a torn last line. Checks: set aside byte for byte, the new log verifies (1 line) and names it (name, sha256, cause, `bytesIn`), one stderr line, and a second `Open` resumes without setting anything else aside | 1 | **fails**: `Open` refuses all four shapes |
| `TestARepairThatCannotBeWrittenLeavesThePartialLine` (`start` with a failing file) | 7 | **fails**: the partial line was cut before the failed repair. Run on `fd288ad`'s logic with only the `start` seam added |
| `TestADropNoticeCountsOnlyTheNewDrops` | 2 | **fails**: a second notice arrives where the event should be (the livelock) |
| `TestSubscribeHoldsAtLeastOneEvent` | 2 | **fails**: `Subscribe(0)` was unbuffered |
| `TestOpenNeverOverwritesALogSetAsideBefore` (fixed clock, the name taken) | 1 | passes, because `fd288ad` refused every damaged log. This is a pin: it kills A3 |
| `TestVerifyChecksTheSequenceAndTheFirstLink` | 4 | passes (pins checks that exist). Kills V1 to V3 |
| `TestTheHubSurvivesChurn` | 3 | passes (pin). Kills E2 with a "send on closed channel" panic |
| `TestPublishNeverBlocks` | 3 | passes (pin). Kills E3 and E4 in 1 to 2 seconds of wall time |
| The `textFields` guard | 5 | with a `[2]string` field added to `Line`, the new guard fails both tests that use it, and `fd288ad`'s guard passes them |
| `TestTheLongestLinesReopenAndVerify` (changed) | 6 | passes. It now measures the true worst case |

**The reviewer's probes, rerun on the fix:**
- **`TestProbeC6PowerCut`:** 0 failed starts in all three shapes, where before 50 of 50 starts failed.
  - The 100 KiB NUL tail is repaired, and 3,001 lines verify.
  - The 600 KiB NUL tail and the torn line are each set aside: the new log verifies at 1 line, with one stderr line each.
- **`TestProbeHubUnderChurn`:** passes.
- **`TestProbeDroppedCountResets`:** fails at its second notice, as the deviation above explains.

**Mutation run** (each with `-race` and a 60-second timeout):
- **Events, all killed:**
  - E1: no count reset;
  - E2: close outside the lock;
  - E3: no room check;
  - E4: events take the notice slot;
  - E5: no notice slot;
  - E6: no clamp;
  - E7: double count;
  - E8: a notice without its event.

  Before `TestPublishNeverBlocks` panicked, E3 and E4 were caught only by the 60-second timeout. My first
  attempt at E8 was an equivalent substitution, and the corrected one is killed.
- **Audit, all killed:**
  - A1: cut before the repair line;
  - A2: no seek;
  - A3: overwrite an earlier set-aside log;
  - A4: rotated size 0;
  - A5: hash only the first KiB;
  - A6: no stderr line;
  - A7: every partial treated as damage;
  - A8: no cut after the repair line;
  - A9: the wrong reason;
  - A10: a new chain off genesis;
  - V1: no seq check;
  - V2: the first link unchecked;
  - V3: seq gaps allowed.

  Four of these first failed to compile, from unused imports or variables, and were redone as compiling
  equivalents.
- **Survivor:** A11 (no `O_EXCL` on the new file) is equivalent under the keyd lock.

## Residuals

- **Disk full right after the rename.** If the new log's first line can't be written then, keyd refuses to
  start. But the damaged log is already set aside, so the next start finds an empty or partial
  `audit.jsonl`. It begins a fresh chain, or repairs it, with no `audit-rotated` line. The set-aside file
  remains as evidence.
- **A repair line that can't complete** leaves the partial line partly overwritten. The next start then
  records the size of what it finds, not of the original partial line.
- **Hashing at startup:** rotation hashes the whole damaged file, so a multi-GB log costs seconds. The log is
  otherwise never rotated.

## Verification (at `b441b98`)

- `gofmt -l keyd` prints nothing.
- `go vet ./...` is clean on the host, with `GOOS=darwin` and with `GOOS=linux`.
- `go mod tidy -diff` shows no changes.
- `go test -race -count=1 ./...` passes for every package: audit 19, cellca 19, events 7, netguard 22,
  surrogate 11, and vault 36 plus the opt-in skip.
- Repeat runs are clean: events at `-race -count=20`, and the new audit tests at `-count=10`.
- `pnpm lint` and `pnpm hygiene` both exit 0.
- The tree is clean.
