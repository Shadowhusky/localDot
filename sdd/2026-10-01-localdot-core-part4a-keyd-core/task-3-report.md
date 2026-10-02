# Task 3 report: sealed intake, so the daemon relays a key it cannot read

**Status:** DONE_WITH_CONCERNS. I implemented the brief verbatim and every check passes. One
deviation needs a ruling, as Task 2's did. A separate test-only commit pins three security properties
that the controller listed and that no brief test pins:
- the base URL in the AAD;
- a fresh ephemeral key per seal;
- a fresh nonce per seal.

It adds 2 tests. See "Gaps" and "Concerns".

**Commits** on `feat/core-part4a`. The author is shadowhusky, and no commit carries a
`Co-Authored-By`, session or AI line; a grep over `8a48ce7..HEAD` bodies finds 0. `main` is
unchanged at `992e82d`.
- `517166a feat(keyd): sealed secret intake`: the brief, byte for byte.
- `5376140 test(keyd): pin a fresh seal key and nonce and the base URL binding`: one new test file,
  `seal_integrity_test.go`. It changes no production code and no file from the brief.

## What I implemented

- **The brief.** It is identical to the plan's lines 1434–1743 (`diff`).
- **`seal_test.go` and `seal.go`.** I extracted them with `sed` from the brief's fences. At HEAD,
  both are still `diff`-identical to the plan's lines 1465–1578 and 1590–1727.
- **`seal_integrity_test.go`** (commit 2) reuses `weatherRecord` and `fakeValue` and declares nothing
  else. It holds two tests:
  - `TestSealUsesAFreshKeyAndNonce`: two seals of the same value for the same record must differ in
    `EPK` and in `Nonce`.
  - `TestOpenRefusesAnotherBaseURL`: a value is sealed for an `openai-compatible` record with
    `https://llm.example.test/v1`. It must open there (positive control) and must not open with
    `https://evil.example.test/v1`.

## Tests: RED, then GREEN

RED (only `seal_test.go` present, `go test ./internal/vault/`). It matches the brief:
```
# github.com/shadowhusky/localdot/keyd/internal/vault [github.com/shadowhusky/localdot/keyd/internal/vault.test]
internal/vault/seal_test.go:13:12: undefined: NewOpener
internal/vault/seal_test.go:17:12: undefined: Seal
internal/vault/seal_test.go:28:10: undefined: NewOpener
...
internal/vault/seal_test.go:48:11: too many errors
FAIL	github.com/shadowhusky/localdot/keyd/internal/vault [build failed]
```

GREEN:
- **After commit 1:** `ok`, with **18 tests: 17 pass and `TestKeychainAgainstTheLoginKeychain` is
  skipped.** The brief's Step 4 says "15 tests, one skipped". The extra 3 are Task 2's kept tests
  (ruling on `8a48ce7`), as the controller said.
- **After commit 2:** 20 tests (19 pass, 1 skipped).

The two pins test behaviour the code already has, so their RED is the mutants in the next section:
A04, D01 and D02 fail them, and the unmutated code passes.

### Every test can fail: the mutation matrix

**Harness** (`scratchpad/mutate.py`):
- For each mutant, it copies the module into the scratchpad and applies exact-match edits to
  `seal.go`, asserting that each edit matches exactly once.
- It runs only the five seal tests, with `KEYD_KEYCHAIN_TEST` removed from the environment, so no
  mutant can reach any Keychain.
- 40 mutants plus the unmutated tree, which passes all five tests. The full output is in
  `scratchpad/mutants.txt`; the re-run against the final pins is in `mutants-final-pins.txt`.

| Brief test / case | Fails on (mutant: what it does) |
|---|---|
| `TestSealOpenRoundTrip` | B08: `Open` salts with keyd's key twice. D03: `Seal` drops the AAD. D04: `Seal` swaps the salt order. D05: `Seal` posts the wrong EPK. E02: `PublicKey` in padded std base64. |
| Refuses: other secret id | A01: id not bound. A12: no AAD. C07: AEAD failure ignored. C08: unauthenticated decryption (GCM's CTR, tag unchecked). Each fails with `other secret id: Open succeeded`. |
| other hosts | A05: hosts not bound; A12; C07; C08 |
| a host added | A05; A06: only the first host bound; A12; C07; C08 |
| other header | A07: header not bound; A12; C07; C08 |
| other format | A08: format not bound; A12; C07; C08 |
| other recipient | E01: `NewOpener` with a fixed key; C07; C08 |
| tampered ciphertext | C07; C08 |
| bad version | C01: no version check |
| short nonce | C02: no length check (`panic: crypto/cipher: incorrect nonce length given to GCM`); C03: decode or nonce failure returns a nil error |
| bad point | C05: returns a nil error; C06: error dropped (nil-pointer panic) |
| not base64 | C03. C04, which ignores decode errors, survives everything because the AEAD still refuses the garbage. That is defence in depth, not a gap. |
| method limit (after the table) | A09: methods not bound; A12; C07; C08 |
| WebCrypto: the `PublicKey` pin | E03: padded base64url everywhere (`PublicKey = BG2x…FwgM=`) |
| WebCrypto: `anthropic` vector | A01, A02 (kind), A03 (provider), A12, A14 (trailing newline), A15 (absent lists as `null`), A16 (no `:` after the prefix), B01–B07 (salt sender-only, swapped or none; empty info; AES-128; SHA-224; key from the public keys without the ECDH secret), B08 |
| WebCrypto: `weather` vector | A01, A02, A05–A12 (A10: paths not bound; A11: header and format swapped), A13 (HTML escaping left on, from the `&`), A14, A16, B01–B08 |

### Gaps: the controller's properties against the brief's tests

| Property | Mutant | Brief's tests | With `5376140` |
|---|---|---|---|
| On-curve check | C05, C06 (`NewPublicKey`'s error dropped) | caught by "bad point" | same. See the next section: no stdlib API skips the check itself. |
| HKDF salted with both public keys | B01, B02, B03, B08, D04 | caught (vectors, round trip) | same |
| Fresh ephemeral key per seal | D02 (`NewPrivateKey` from a fixed scalar) | **survived** | caught: `two seals share a key or a nonce` |
| Fresh nonce per seal | D01 (zero nonce, no `rand.Read`) | **survived** | caught |
| Opener key made per process | E01 | caught ("other recipient") | same |
| id in the AAD | A01 | caught | same |
| hosts, header, format, methods in the AAD | A05–A09 | caught | same |
| kind, provider, paths, field order, the encoder's details | A02, A03, A10, A11, A13–A16 | caught, by the vectors only | same |
| **base URL in the AAD** (review 1, M6, names it) | A04 (`""` in its place) | **survived**: no case changes it, and neither vector has one. No later task's test does either; Task 16's admin tests seal for another id and another host only. | caught: `a value sealed for one base URL opened for another` |
| Authenticated decryption | C07, C08 | caught | same |
| No plaintext in errors or logs | — | Holds by construction: `Open`'s error paths all precede or are the AEAD failure (Go's GCM clears its output on failure), and `Seal`'s errors come from base64, ecdh, aes and rand, which never see the plaintext. `seal.go` has no `os`, `io`, `log` or `fmt.Print` (grep). | — |
| Private key never written | — | `Opener.priv` is unexported, with no I/O in `seal.go`. `%v`, `%+v` and `%#v` of `o` and `*o` print a pointer, and `json.Marshal(o)` is `{}` (scratch probe). | — |

### The on-curve check, verified empirically (scratch test, not committed)

`ecdh.P256().NewPublicKey` refuses each of these:
- the vector's EPK with y's last bit flipped: `P256 point not on curve`;
- the order-2 twist point (1, 0): `P256 point not on curve`;
- an on-curve point (x = 5) encoded with x + p: `invalid P256 element encoding`;
- the identity `00`, a compressed `02…` and the 3-byte `BAAA`: `invalid public key` / `invalid P256 point encoding`.

A full invalid-curve blob, crafted for the shared secret x = 1 that an unchecked opener with an odd key
would compute, gets `vault: cannot open the sealed secret` from `Open`.

I added no test for this. The brief's "bad point" exercises the length check. A test aimed at the
curve check could only fail against a hand-rolled curve implementation, so with `crypto/ecdh` it would
be vacuous.

### WebCrypto interop beyond the two vectors (scratch, not committed)

I extracted the plan's `sealSecret` snippet as written, ran it with Node 25.6.0, and sealed 8 records to
the vectors' key. Go decoded each record as JSON, as the admin handler does, and opened it with the
fixed-key `Opener`:
- **7 opened to `fake-key-from-webcrypto`:**
  - `anthropic`;
  - HTTP with two hosts, two methods and `&<>"'` in a path;
  - `openai-compatible` with a base URL holding `?a=1&b=<2>`;
  - `azure` with a non-ASCII base URL;
  - explicit `""` and `[]`;
  - a backslash, a quote, `/` and DEL;
  - `\t \b \f \u0001`.
- **The 8th is refused:** U+2028 in a base URL. Go's encoder always escapes U+2028 and U+2029 and
  `JSON.stringify` does not (Concern 2).
- All 8 are refused under another id.

## Verification

| Check | Result |
|---|---|
| `gofmt -l keyd` (repo root) and `gofmt -l .` (in `keyd/`) | no output |
| `go vet ./...` (host, `GOOS=darwin`, `GOOS=linux`) | clean |
| `go mod tidy -diff` | no changes |
| `go test -count=1 -race ./...` | `ok` surrogate, `ok` vault |
| `go test ./internal/vault/` | `ok`: 20 tests (19 pass, 1 skipped); 18 at commit 1 |
| `pnpm lint` | exit 0 (biome; it doesn't cover Go) |
| `pnpm hygiene` | exit 0 (it scans tracked and untracked files) |
| Opt-in Keychain test | not run, as instructed |

## Files changed

- `keyd/internal/vault/seal.go` (new, 138 lines)
- `keyd/internal/vault/seal_test.go` (new, 114)
- `keyd/internal/vault/seal_integrity_test.go` (new, 42; commit 2)

Nothing else changed: no shared file, and nothing under `apps/`, `cells/`, `packages/`, `spikes/`
or `scripts/`. My only contact with `/Volumes/Husky's SSD 4T/Projects/localdot` was one read-only
`git log -1`, with no edit, stage or checkout.

## Self-review

- **Scheme:**
  - ECDH P-256, with the point validated by `crypto/ecdh` (uncompressed, canonical, on the curve).
  - HKDF-SHA256 over the shared secret, salted with `epk ‖ keyd public key`, with info
    `localdot-keyd seal v1`.
  - AES-256-GCM with a 12-byte nonce (enforced before GCM can panic).
  - AAD: `localdot-keyd seal v1:` plus the 9-field binding array without HTML escaping.
  - Every check above is pinned except the curve check, which is the library's and was verified
    empirically.
- **No oracle:** every decryption failure returns the same `errSealed`. Only the version error
  differs, and it echoes nothing but the caller's integer. The admin handler relays `Open`'s
  message as `bad-seal`, so neither error carries a value.
- **Per boot:** the key comes from `GenerateKey` in `NewOpener` and lives only in the `Opener`. A blob
  from an earlier boot cannot open.
- **Accepted by design (R2):** a blob captured within a boot can be replayed under the same binding.
  That re-stores the same value and revokes its surrogates, which the daemon could also do with
  `DELETE`. The binding stops re-targeting, which is what M6 asks for.
- **Interfaces:** exactly the brief's `Sealed`, `NewOpener`, `PublicKey`, `Open` and `Seal`. `Seal` has
  no production caller. Task 16's tests use it, and the UI seals in WebCrypto.

## Concerns

1. **A ruling is needed on commit `5376140`.** It is test-only, in its own file, and leaves the
   brief's files untouched. It closes A04 (the base URL left out of the AAD, the M6 property that
   nothing pins), D01 and D02. If it stays, the counts move by +2 on top of Task 2's +3:
   - this task: **20** (one skipped), not 15;
   - Task 17's whole-module run: **180** tests (one skipped), not 175.

   To reject it, run `git reset --hard 517166a` before Task 4 builds on it.
2. **Low, fails closed.** `sealAAD`'s comment says `JSON.stringify` writes the array "byte for byte
   the same". That holds for everything a validated binding can carry except U+2028 and U+2029 (and
   invalid UTF-8) in a base URL. Ids, hosts, headers, methods and paths are ASCII-checked, but
   `keys.FromRecord` checks a base URL only with `url.Parse` and `path.Clean`, so a path with U+2028
   passes there. `Open` then refuses the blob (`bad-seal`). Resealing doesn't help, but nothing leaks.
   - Option: the keys task could require printable ASCII in base URL paths, as it already does for
     path prefixes. I made no change, because the code is the brief's.
3. **Low, no change.** Two brief cases are weaker than their names suggest, and neither matters for
   safety:
   - "bad point" uses a 3-byte encoding, so it tests the length check, not the curve check (see
     above).
   - "not base64" fails only if the decode path returns a nil error (C03). Ignoring decode errors
     (C04) is still refused by the AEAD.
