# Task 2 report: the vault — secret records, the Keychain and in-memory stores

**Status:** DONE_WITH_CONCERNS. The brief is implemented verbatim and every check passes. One
deviation needs a ruling: I added three test-only pins in a separate commit, because three of the
security properties the controller listed (and Delete's cleanup) were not pinned by the brief's
tests. See "Gaps" and "Concerns".

**Commits** on `feat/core-part4a` (author shadowhusky; no `Co-Authored-By`, session or AI line;
`main` unchanged at `992e82d`; `/Volumes/Husky's SSD 4T/Projects/localdot` never touched):
- `dbceb10 feat(keyd): vault with Keychain and in-memory stores`: the brief, byte for byte.
- `8a48ce7 test(keyd): pin the Keychain read-back, hex encoding and chunk deletion`: one new test
  file. No production change and no edit to the brief's files.

## What I implemented

- `store.go`, `keychain.go`, `vault.go`, `vault_test.go` and `keychain_test.go`: extracted with `sed`
  from the brief's fences. Each is `diff`-identical to the plan (lines 971–1024, 1029–1187,
  1192–1412, 558–743 and 748–959), checked again at HEAD after both commits. The brief itself is
  identical to the plan's lines 521–1433.
- `keychain_integrity_test.go` (commit 2). It holds three tests that reuse the brief's helpers
  (`fakeKeychain`, `fakeSecurity`, `longValue`, `carries`) and declare nothing else, so nothing clashes
  with Task 3's `seal_test.go` (`weatherRecord`, `Sealed`, `Opener`, `b64`, `list`, …):
  - `TestKeychainRefusesAWriteThatDoesNotReadBack`. A fake that exits 0 but keeps the old items, as
    a failed update would. `Put` must fail, and its error must carry neither the new value nor the old.
  - `TestKeychainKeepsEveryPrintableCharacter`. Every byte from 0x20 to 0x7e (space, quotes,
    backslash, `*?[`) round-trips. Without hex, word splitting cuts the value.
  - `TestKeychainDeleteLeavesNoChunk`. After `Delete` of an 8,192-byte value, the fake store is empty.

## Tests: RED, then GREEN

RED (test files only, `go test ./internal/vault/`, exit 1). It matches the brief:
```
# github.com/shadowhusky/localdot/keyd/internal/vault [github.com/shadowhusky/localdot/keyd/internal/vault.test]
internal/vault/vault_test.go:15:35: undefined: Store
internal/vault/vault_test.go:15:44: undefined: Vault
internal/vault/vault_test.go:25:28: undefined: Record
...
internal/vault/keychain_test.go:147:37: too many errors
FAIL	github.com/shadowhusky/localdot/keyd/internal/vault [build failed]
```
GREEN (after commit 1): `ok`, 12 tests: 11 pass, and `TestKeychainAgainstTheLoginKeychain` is skipped.
After commit 2: 15 tests, 14 pass, 1 skipped.

### Every test can fail: the mutation matrix

The harness copies the module into the scratchpad for each mutant, applies exact-match edits (each
asserted unique) and runs the whole package. In every mutant, `NewKeychain`'s path is rewired to a
nonexistent file, and the harness refuses to run if any reference to `/usr/bin/security` survives in
code. No mutant could reach the real keychain. Results on the final tree:

| Test | Fails on (mutant: failure message) |
|---|---|
| RoundTripThroughTheSecurityTool | K1 value as argv: `the secret reached the command line: …`; K9 exit 44 not mapped: `keychain: delete weather.1: security exited with status 44`; K2 |
| KeepsLongValuesWhole | K3 2,048-byte chunks: `Put of 3000 bytes: keychain: store weather.0: security exited with status 1`; K3b no chunking; K7 no stale-chunk cleanup: `7 items after a short value replaced a long one`; K1 |
| ErrorsNeverCarryTheValue | K5 tool's stderr in the error: `Put through a failing tool: … cannot store <hex>`; K5b chunk in the torn error; K6 no write-id check: `Get of a torn value: <nil>` |
| ReportsToolFailures | K10 a missing tool reads as not found: `Get through a missing tool: vault: secret not found` |
| AgainstTheLoginKeychain | O1 Delete leaves chunks: `an item of the test service outlived Delete`; O2 2,048-byte chunks: `Put of 8192 bytes: …status 1`; O3 exit 44 not mapped. These ran against an extended fake in scratch: the brief's fake plus service-wide `find-generic-password -s`. O0, unmutated, passes there (0.48 s, not skipped). |
| PutStoresValueAndIndexWithoutTheValue | V1 plain value in the index: `the index file contains the secret value`; V2 `index mode -rw-r--r--, want 0600`; V3 zero CreatedAt |
| OpenReloadsTheIndex | V4 Open ignores the index: `Records = []` |
| PutRejectsBadIDsAndValues | V5a–f, one per bad id (`"lmstudio"`, `"Weather"`, `"-x"`, 65 chars, `"a b"`, `""`); V6a–g, one per bad value (nil panics at `value[0]` when the minimum is 0); V6h `a rejected Put left a record` |
| DeleteRemovesValueAndRecord | V7 `store after delete: <nil>`; V9 `second Delete: <nil>` |
| ValueReadsTheStoreOnceThenCaches | V10 `store read 3 times, want 1` |
| PutKeepsCreatedAtOnUpdate | V11 CreatedAt overwritten; V12 UpdatedAt kept; V13 old value cached: `Value = "real-secret-value-for-test"` |
| AnEmptyIndexPathKeepsEverythingInMemory | V14 `rename ./.secrets-… : no such file or directory` |
| RefusesAWriteThatDoesNotReadBack (new) | K4 no read-back: `Put through a tool that kept the old items: <nil>`; K4b read-back error carries what came back |
| KeepsEveryPrintableCharacter (new) | K2b raw both ways: `keychain: store weather: the value did not read back intact` |
| DeleteLeavesNoChunk (new) | K8 Delete leaves chunks: `6 items outlived Delete` |

### Gaps: the controller's properties against the brief's tests

| Property | Mutant | Brief's tests | With commit 2 |
|---|---|---|---|
| Never on a command line | K1 | caught (2 tests) | same |
| Hex-encoded on stdin | K2, raw out and hex in | caught | same |
| | K2b, raw both ways | **survived** | caught |
| Chunks under the 4,095-character line | K3, K3b | caught | same |
| Every write read back and verified | K4 | **survived** | caught |
| No value in an error | K5b, torn read | caught | same |
| | K4b, read-back error | **survived** (the path never ran) | caught |
| No tool output in an error | K5 | caught | same |
| Never in a log | — | the package has no `log`, `fmt.Print*` or `os.Std*` (grep) | — |
| A read never mixes two writes | K6 | caught | same |
| Delete leaves no chunk | K8 | **survived in CI**; only the opt-in test catches it | caught |

## The opt-in Keychain run (run once) and the cleanup check

- Before: `security find-generic-password -s localdot-keyd-test` exited 44.
  `security show-keychain-info …/login.keychain-db` printed `no-timeout` and exited 0, so the
  keychain was reachable without an unlock prompt.
- The run (2026-10-01T16:57:51Z):
  `KEYD_KEYCHAIN_TEST=1 go test -count=1 -timeout 90s -run LoginKeychain -v ./internal/vault/`
  ```
  === RUN   TestKeychainAgainstTheLoginKeychain
  --- PASS: TestKeychainAgainstTheLoginKeychain (1.11s)
  PASS
  ok  	github.com/shadowhusky/localdot/keyd/internal/vault	1.291s
  ```
  It stored 26 bytes, then 8,192 bytes (six chunk items and the head), then 26 bytes, reading each
  back. It then deleted the item and its chunks and checked that nothing of the service was left.
- **No GUI prompt.** The run finished in about a second. A dialog would have blocked `security` until
  the 90 s timeout. I can't see the screen, so this is an inference from the timing.
- After: `security find-generic-password -s localdot-keyd-test; echo $?` printed
  `security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.` and
  `44`, so nothing was left. `pgrep -x security` found no lingering process. No other Keychain item was
  read, written or deleted.

## Verification

| Check | Result |
|---|---|
| `gofmt -l keyd` | no output |
| `go vet ./...` (host, `GOOS=darwin`, `GOOS=linux`) | clean |
| `go test -count=1 -race ./...` | `ok` surrogate, `ok` vault |
| `go mod tidy -diff` | no changes |
| CI's `/bin/sh` is dash | the four Keychain tests pass with the fake under `/bin/dash` (scratch copy) |
| `pnpm lint` | exit 0 (biome; it doesn't cover Go) |
| `pnpm hygiene` | exit 0; the new files are tracked, so it scanned them |
| Longest `security -i` line (64-char id, chunk 5, the test service) | 3,288 characters, under 4,095 |

## Files changed

- `keyd/internal/vault/store.go` (new, 54 lines)
- `keyd/internal/vault/keychain.go` (new, 159)
- `keyd/internal/vault/vault.go` (new, 221)
- `keyd/internal/vault/vault_test.go` (new, 186)
- `keyd/internal/vault/keychain_test.go` (new, 212)
- `keyd/internal/vault/keychain_integrity_test.go` (new, 55; commit 2)

## Self-review

- **Fit:** the interface is exactly the brief's. Only `keyd/internal/vault/` changed: nothing under
  `apps/`, `cells/`, `packages/`, `spikes/` or `scripts/`, and no shared file.
- **Secrets:**
  - Values reach `security` only as hex on `-i` stdin, one line per item. `find`, `delete` and the
    test's service search use argv, which carries ids only.
  - `run` drops stdout and stderr, and every error names an operation, an item and an exit status.
  - The index is built from `Record`, which has no value field. It is written 0600 through a temp
    file and a rename.
- **Bounds:** `parseHead` caps the chunk count at `maxChunks` (6), so a forged head cannot cause
  unbounded reads. `ErrNotFound` is exit status 44, which matches the real tool here.
- **Known and accepted (plan reviews):** a Keychain write that fails midway leaves the old value torn
  until it is stored again (review 2 §5). The vault lock spans Keychain I/O (N6, recorded in R3).

## Concerns

1. **Ruling needed on commit `8a48ce7`.** It is test-only, in its own file, and the brief's files are
   untouched. It closes K2b, K4, K4b and K8. If it stays, test counts move by +3:
   - Task 2: 15 tests (14 pass, 1 skipped), not 12.
   - Task 3's "15 tests, one skipped" becomes 18.
   - The revision logs' vault counts shift the same way.

   If it is rejected, `git reset --hard dbceb10` before Task 3 builds on it.
2. **Low: still unpinned, outside the listed properties.** I did not add tests for these. Each is cheap
   if wanted.
   - V1b: the index test looks only for the raw bytes. A base64 copy, for example from a `[]byte`
     field added to `Record`, would pass.
   - V6i: the kind check (`llm` or `http`) is untested.
   - V15: `Records()` order is untested; every test has at most one record.
   - Two more survivors are harmless:
     - V8: the cache entry `Delete` would keep can't be observed through the API.
     - K3c: one session per item is backstopped by the read-back, now pinned.
3. **Low, new observations (no change made):**
   - `Keychain.add` puts the account into the `security -i` line unquoted. An id with a space or a
     newline could inject arguments or a second command. This is unreachable: `Vault.Put` checks
     `ValidID` first, and Task 16 wires `NewKeychain` only through `vault.Open`. Anything that ever
     calls a `Store` directly must validate the id.
   - Slices alias: `Put` keeps the caller's `Hosts`/`Methods`/`Paths`, and `Record`/`Records` hand out
     the vault's own. A caller that mutates them changes the in-memory binding.
   - If the index write fails after the store write, the record is live in memory but missing on
     disk. It is lost at restart, and its Keychain items are orphaned.

---

# Fix round 1: the vault (review of Task 2), the seal (Task 3), netguard (Task 4)

**Status:** DONE_WITH_CONCERNS. Every item is fixed and pinned by a test that fails first, and
every check passes. The concerns are three deliberate widenings and a few residuals. They are listed
at the end.

**Commits** on `feat/core-part4a`, on top of `00d1e37`. Author shadowhusky, with no attribution
line. `main` is unchanged at `992e82d`.
- `093da2c fix(keyd): roll back failed vault writes and refuse an untrusted index` (A)
- `41986f8 test(keyd): pin the uniform error for an off-curve seal key` (B)
- `6463c11 fix(keyd): netguard refuses the zero address and every network but TCP and UDP` (C)

**Test counts.**
- Before this round: surrogate 9, vault 20, netguard 19.
- After it: surrogate 9, vault 32 (one opt-in skip), netguard 22, so 63 top-level tests.
- Task 17's expected total moves by +15.

## A. The vault

### What changed

**A1 (Important): a failed `Put` changes nothing** (`vault.go`).
- `Put` keeps `old, had := v.records[rec.ID]`. For an existing secret, it first reads the old value
  from the cache or the store.
- A failed store write or index save then does three things:
  - It puts the old record back, or drops the new one.
  - It saves the index again, because the A7 directory sync fails after the rename has landed.
  - It restores the old value in the store (`restoreValueLocked`). With no old value to restore, it
    deletes the item, so a restored record never meets the new value.
- The new value is cached only once the index is saved.
- **This goes beyond the ruling's wording**, which was "restore the record and drop the cache
  entry". By then the store already holds the rotated value, so with only that fix the next
  `Value()` would read the new key back under the old binding. That is the review's hazard.
  - Mutant L1, the literal fix, fails the new test with: `warm: after a failed Put the hosts are
    [api.example.test], the value "rotated-fake-value-for-test" (<nil>), the store
    "rotated-fake-value-for-test"`.
  - The cost: updating a secret that isn't cached reads it once from the Keychain first. That is up
    to 7 `security` runs, under the vault lock.

**A2: `Keychain.Delete`.** A chunk error now replaces a nil or `ErrNotFound` head error. So when
Delete is retried after the head is gone, it can no longer report success over a chunk left behind.

**A3: a failed `Keychain.Put` leaves no fragments.**
- If anything was written, a failure at a chunk, the head or the read-back deletes the whole item,
  best effort.
- If chunk 0 fails, nothing was written and the old value is untouched.
- This is broader than "remove the chunks you wrote". It also removes the old head and the old
  value's remaining chunks, which are dead fragments by then: once one chunk is overwritten, the old
  value no longer reads back (its write id doesn't match).
- An error from removing a stale chunk is now returned.

**A4: `Keychain.Put` refuses what it can't store safely.**
- It refuses an id that fails `idPattern`, so the `-i` line can't be injected.
- It refuses a value over `maxValueLen`.
- It also refuses an empty value, which I added. An empty value would write a head that the
  read-back rejects, and A3's cleanup would then delete the old value.

**A5: records are copied on the way in and out.** `Record.clone()` copies Hosts, Methods and Paths in
`Put`, `Record` and `Records`. `Value` now reads through `valueLocked`: the cache keeps the store's
fresh slice, and every caller gets a copy.

**A6: `Open` fails closed.** It refuses:
- a version other than 1, including a missing `v`;
- an invalid or reserved id;
- an unknown kind;
- a repeated id. This one is an addition. The index is keyd's own, so a repeat means it was edited,
  and either binding could be the stale one.

**A7: `writeFileAtomic` syncs.** It calls `Sync` on the file before the rename, and on the directory
after it. I checked first that `Sync` on a directory works on APFS, on both the internal disk and this
SSD.

### Tests: 12 new

Nine of them fail on `00d1e37`. I ran them on a copy of the tree at `00d1e37` with the new test
files added:

| Test | Item | Failure on `00d1e37` |
|---|---|---|
| `TestAFailedPutChangesNothing` | A1 | `warm: after a failed Put the hosts are [new-host.example.test], the value "rotated-fake-value-for-test" (<nil>), the store "rotated-fake-value-for-test"`; the same for `cold`; and the new secret outlived its failed Put |
| `TestAFailedDirectorySyncPutsTheOldIndexBack` | A1, A7 | `Put succeeded without syncing the index's directory` |
| `TestKeychainDeleteReportsAChunkItCannotRemove` | A2 | `Delete 2 with a chunk left behind: <nil>`, and the vault dropped the record |
| `TestKeychainAFailedPutLeavesNoFragment` | A3 | `with the write of weather.3 failing, localdot-keyd-test.weather.0 kept part of the value`, and 8 more items |
| `TestKeychainPutReportsAnOldChunkItCannotRemove` | A3 | `Put succeeded with a chunk of the old value left behind` |
| `TestKeychainPutRefusesWhatItCannotStoreSafely` | A4 | `Put of id "Weather" succeeded`; the same for `"weather.0"`; `Put of 8193 bytes succeeded`; the injected id tore the victim |
| `TestRecordsAreCopiedInAndOut` | A5 | `a copy changed the vault's record: {… Hosts:[lister.example.test] Methods:[PATCH] …}` |
| `TestConcurrentUseKeepsMemoryAndIndexInStep` | A5, A8 | `memory holds {ID:s0 … Hosts:[edited.example.test] …}` in 3 of 3 runs; under `-race`, 7 `DATA RACE` warnings, the json marshal racing the callers' edits |
| `TestOpenRefusesAnIndexItCannotTrust` | A6 | `Open succeeded` for all 8 cases: unknown version, no version, reserved id, invalid id, injected id, unknown kind, no kind, repeated id |

The other three pin behavior that `00d1e37` already had. They pass there, so I showed their failures
on mutants (P1–P5 below):
- `TestPutRejectsUnknownKinds`
- `TestRecordsAreSortedByID`
- `TestTheIndexHoldsNoCopyOfAValue`, which looks for the value raw, in hex, and in base64 in both
  alphabets at all three byte alignments.

**Fails even as root.** I cross-compiled static linux/arm64 test binaries and ran them as root in
`localdot/probe:test` (Alpine, busybox `sh`, `--network none`).
- On `00d1e37`, `TestAFailedPutChangesNothing` fails, both warm and cold.
- On the fix, everything passes.
- `TestAFailedDirectorySyncPutsTheOldIndexBack` skips as root, by design: root can read any
  directory.

**Mutants of the fixed tree.** Each ran in its own scratch copy, with `NewKeychain` rewired to a
nonexistent path and `KEYD_*` removed. Every piece of the fix fails a test on its own:

| Mutant | Result |
|---|---|
| P1: `Put` takes any kind | killed: `Put of kind "" succeeded`, and for `weird` and `LLM` |
| P2: `Records` unsorted | killed: `Records() in the order [weather anthropic zeta …]` |
| P3, P4, P5: the index holds the value as a string, as `[]byte` (base64), as hex | each killed: `the index holds a copy of weather's value` |
| L1: the literal A1 fix | killed (see A1) |
| F1: a failed save keeps the new record | killed |
| F2: no read of the old value before the write | killed: `the value "" (vault: secret not found)` |
| F3: Delete precedence reverted | killed |
| F4: a failed Put leaves its chunks | killed |
| F5: stale-chunk errors ignored | killed |
| F6, F7: `Keychain.Put` takes any id, any size | each killed |
| F8, F9, F10: no clone in `Put`, `Record`, `Records` | each killed; F10 under `-race` also gives 4 `DATA RACE` warnings |
| F11–F14: `Open` takes any version, id, kind, a repeated id | each killed |
| F15: no re-save after a failed save | killed: `after the failed Put the index holds the hosts [new-host.example.test]` |
| F17: no directory sync | killed: `Put succeeded without syncing the index's directory` |
| F16: no file sync | **survives.** Making `File.Sync` fail needs fault injection, so I checked it by reading the code |

**Also:**
- The patched fake tools pass under `/bin/dash` (CI's `/bin/sh`) and under busybox.
- I did not run the opt-in test against the real keychain. Its body passed against the extended
  fake, with the path rewired in a scratch copy, and left 0 items.
- `security find-generic-password -s localdot-keyd-test` exits 44 before and after.

## B. The seal (from Task 3's review)

- **The row.** `seal_test.go` gains a row with an off-curve 65-byte sender key, the point (0,0).
  - The loop now also requires every version-1 case to fail with the uniform `errSealed`. The
    version case keeps its own error, as the brief has it.
  - crypto/ecdh rejects the new row as `P256 point not on curve`, so the row reaches the curve check.
- **The comment.** `sealAAD`'s comment (`seal.go:122`) now says that `JSON.stringify` differs from
  Go's encoder at U+2028 and U+2029, so such a seal fails closed.
  - Checked on this toolchain: Go writes ` ` and ` ` escaped, and Node writes them raw.
- **RED.** The curve check already holds on `00d1e37`, so I showed RED with mutants:

  | Mutant | New row and loop | `00d1e37`'s `seal_test.go` |
  |---|---|---|
  | B1: every bad point gets its own error | killed by both point rows: `bad point: vault: bad sender key: invalid P256 point encoding, want the uniform error`; `off-curve point: … P256 point not on curve, …` | survives |
  | B2: only an off-curve 65-byte point gets its own error | killed by the new row alone: `off-curve point: vault: sender key is not on the curve, want the uniform error` | survives |

  A mutant that *accepts* an off-curve point can't be built on crypto/ecdh. So the row pins the
  uniform error, and it is a tripwire for a library swap.

## C. netguard (from Task 4's report and review)

- **The zero address.** `Check` denies an invalid `AddrPort` ("invalid address") before the allow
  list, so not even a zero allow entry passes it.
  - `TestCheckRefusesTheZeroAddress` uses `New(noOwn)` and `New(noOwn, netip.AddrPort{})`.
  - On `00d1e37` it fails: `Check(netip.AddrPort{}) = <nil>, want it denied`.
  - Placing the check after the allow list (mutant C2) is killed by the zero allow entry.
- **The network.**
  - `DialContext` refuses any network other than `tcp`, `tcp4`, `tcp6`, `udp`, `udp4` and `udp6`
    (`checkNetwork`, a `DeniedError` naming the network). It does so before it resolves or makes a
    socket.
  - **`Control` refuses one too (an addition).** The reviewer found that it ignores the network as
    well, and it is the connect-time backstop. For a Unix dial, Go hands it the network `unix` and
    the socket path.
  - `TestOnlyTCPAndUDPAreDialled` binds a Unix socket named `8.8.8.8:443` in a temporary
    directory. It tries `unix`, `unixgram`, `unixpacket` and `""` through both doors. For
    `DialContext` it requires a refusal before any socket, meaning no `net.OpError`.
  - On `00d1e37` the test fails: `DialContext over "unix": <nil>`, then `the listener saw a
    connection`. That reproduces the review.
  - With the "before any socket" assertion, removing either layer on its own (mutants C1 and C1b)
    is killed.
  - No later task is affected. Every planned `netguard.Dialer` call dials `"tcp"`. The plan's one
    `"unix"` dial (Task 16's admin-socket client) uses a plain `net.Dialer`.
- **The IPv6 network length.** `TestInterfacePrefixesKeepTheIPv6NetworkLength` asserts that lo0's
  `fe80::1/64` is present. It runs only on darwin and skips on Linux, which I checked in Alpine as
  root. It kills R3 and also G21.
- **The exact-rule table** in `TestEveryStaticRuleAndEmbeddedFormIsDenied` now covers every one of
  the 27 static rules:
  - each range's first and last address, by exact `Rule`. For ::/96 the "first" is `::2`, because
    `::` and `::1` belong to earlier rules.
  - the docker range's neighbors, `192.168.64.255` and `192.168.66.0`, named `private`;
  - 38 addresses just outside a range that no other rule covers, which must pass.
- **Mutants**, with the reviewer's harness (`t4review/mutate.py`) copied, pointed at the new tree and
  extended. It keeps the `sandbox-exec` loopback-only profile and `GOTOOLCHAIN=local`.
  - The output is in `scratchpad/t2fix/t4/mutants.txt`.
  - The unmutated base passes.
  - Every one of the reviewer's mutants is killed by the pins:
    - R3 by the IPv6 test;
    - N1–N7 by the table;
    - the earlier ones (D01–D05, R1, R2, G05, G21) as before.
  - C0, C1 and C1b are killed by the new tests.
  - For every rule I also built a mutant that narrows it by one bit (24) and one that widens it by
    one bit (27), each keeping the rule's name. **48 of the 51 are killed.**
  - The 3 survivors are equivalent: the widened part is wholly covered by an earlier rule, so nothing
    a test could observe changes.
    - `240.0.0.0/4`→`224.0.0.0/3`: multicast comes first.
    - `::1/128`→`::/127`: unspecified comes first.
    - `fec0::/10`→`fe80::/9`: link-local comes first.

## Verification (final tree)

| Check | Result |
|---|---|
| `gofmt -l keyd` | no output |
| `go vet ./...` (host, `GOOS=darwin`, `GOOS=linux`) | clean |
| `go test -count=1 -race ./...` | `ok` netguard, surrogate and vault |
| `go mod tidy -diff` | no changes |
| `pnpm lint` | exit 0 |
| `pnpm hygiene` | exit 0 |
| Linux as root (Alpine, `--network none`) | vault and netguard pass; the expected skips (directory-sync test as root, darwin IPv6 test, opt-in Keychain test) |
| Real keychain | not touched this round; the test service still exits 44 |

## Concerns

1. **Three deliberate widenings.** Each is explained above, and each is easy to back out.
   - A1 also restores the store, not only the record and the cache. Without that, the hazard
     remains (mutant L1).
   - A3 deletes the whole item, not only this write's chunks.
   - A4 refuses empty values; A6 refuses repeated ids; C's network check also sits in `Control`.
2. **Residuals in the A1 rollback.**
   - When the store refuses both the write and the restore, `Put` falls back to deleting the item.
     In process, the old record and value stay in force, from the cache. After a restart the secret
     is missing, which fails closed.
   - Only a triple failure (the save, the restore and the delete) could leave the old record and the
     new value together after a restart.
   - The index and the Keychain still have no shared transaction. A crash between the store write
     and the index save is the same window as before.
3. **Unpinned:** F16, the file `Sync`, needs fault injection to test. The test counts move by +15
   (vault +12, netguard +3).
