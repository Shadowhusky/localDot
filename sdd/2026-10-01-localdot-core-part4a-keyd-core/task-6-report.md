# Task 6 report: the per-cell CA (name-constrained, in memory only)

**Status:** DONE_WITH_CONCERNS. The brief is in byte for byte, the security properties on the controller's
list are checked by hand and pinned in a separate test-only commit, and every check passes.
- **C1 needs a ruling.** The X.509 constraint also covers every subdomain of a bound host. The brief
  accepts this in its prose, but I reproduced it in Chromium 154 and curl with the brief's own CA, and
  I have a verified fix for it.
- **C2** is a defence-in-depth gap.
- **C3** is informational.

I changed no production code.

**Commits** on `feat/core-part4a`, BASE `fd288ad`. Both are authored by shadowhusky, with empty bodies and no
`Co-Authored-By` or AI attribution. `main` is still at `992e82d`.

| Commit | What |
|---|---|
| `4b3fe2f feat(keyd): per-cell name-constrained CA` | the brief's two files, byte for byte (brief lines 29–208 and 220–381) |
| `f636b2b test(keyd): pin the cell CA's address exclusions, leaf profile and key isolation` | `keyd/internal/cellca/cellca_integrity_test.go` (7 tests, test-only) |

## 1. The brief's work (`4b3fe2f`)

- The brief (398 lines) is identical to the plan's Task 6 section (plan lines 3091–3488), checked with `diff`.
- I extracted both files from the brief with `sed`, and `diff` confirms they are identical after the commit.
- **RED (Step 2)**: `go test ./internal/cellca/` exits 1 with the brief's expected output:
  ```
  internal/cellca/cellca_test.go:18:15: undefined: CA
  internal/cellca/cellca_test.go:24:17: undefined: CA
  ... undefined: New ... undefined: ErrNotPermitted ... too many errors
  FAIL	github.com/shadowhusky/localdot/keyd/internal/cellca [build failed]
  ```
- **GREEN (Step 4)**: `ok`, with 9 tests, also under `-race`. The brief's error-text claim holds. The two
  forged leaves fail with:
  - `x509: a root or intermediate certificate is not authorized to sign for this name: DNS name "bank.example" is not permitted by any constraint`
  - `x509: a root or intermediate certificate is not authorized to sign for this name: IP address "93.184.215.14" is excluded by constraint "0.0.0.0/0"`
- **Step 5**: `gofmt -l .` printed nothing, `go vet ./...` was clean, and the commit uses the brief's message.

## 2. Hand checks (controller note 2)

The probes ran in a scratch copy of the module. Paths are in section 7.

### NameConstraints: critical, permitted-only, exactly the bound DNS names, no IP

**What holds:**
- **Critical.** The NC extension (2.5.29.30) is critical. The KU and BC extensions are critical too (Go
  always marks them).
- **Exact permit list.** `PermittedDNSDomains` is exactly the hosts, or `["invalid"]` for a cell with
  none. `ExcludedIPRanges` is exactly `0.0.0.0/0` and `::/0`. Nothing else is set: no excluded DNS
  names, no permitted IP ranges, and no email or URI subtrees.
- **Every SAN is checked.** Go (`Verify`), Chromium and curl check every SAN, so a forged leaf can't
  carry an unbound name or an IP alongside a bound one:
  - `[api.example.test, bank.example]` is refused.
  - `api.example.test` plus `93.184.215.14` is refused.
  - IPv6 (`2606:2800:…`, `::1`) is refused under `::/0`.
- **IPv4-mapped SANs fail closed.** A hand-built IPv4-mapped 16-byte IP SAN can't even be parsed by
  Go 1.27 (`x509: SAN iPAddress contains IPv4-mapped IPv6 address`). OpenSSL refuses it
  (`excluded subtree violation`).
- **Forged intermediates are refused.** The CA key can sign an unconstrained CA certificate. Go refuses
  any leaf under it, for bound names too, with `x509: too many intermediates for path length
  constraint`.
- **The EKU limits chaining.** Leaves with `anyExtendedKeyUsage` or no EKU still fail client-auth
  verification in Go, because the CA's `[serverAuth]` crosses the usage out.

**Gaps:**
- **Not exact in X.509 terms: C1.** A permitted `dNSName` subtree includes every subdomain, so
  `x.api.example.test` and `*.api.example.test` are inside the constraint. The brief says so. Only
  `Leaf` is exact.
- **Email and URI SANs are unconstrained**, because there are no subtrees for them. A forged leaf with
  `api.example.test` plus `a@bank.example` verifies for server auth. That doesn't matter for TLS hostname
  checks, and the CA's EKU (with its C3 caveat) covers other uses.

### The CA private key never leaves memory

- **No I/O.** The package imports only `crypto/*`, `encoding/pem`, `errors`, `math/big`, `net`,
  `slices`, `sync` and `time`. It has no `os`, `io`, `log` or `fmt`, so there is no file and no log.
  Task 15 writes `CertPEM()` only.
- **Errors.** `New` and `Leaf` return only crypto-library errors or the sentinel `ErrNotPermitted`,
  which names neither a host nor a key.
- **`%v` and JSON.** All fields are unexported:
  - `json.Marshal(ca)` gives `{}`.
  - `%v`, `%+v`, `%#v`, `%s`, `%q`, `%x`, `%X` and `%d` on the `*CA` and on the returned
    `*tls.Certificate` print the key fields as pointer addresses. I checked against D (decimal, hex and
    base64), SEC1 (hex and base64) and PKCS#8 (base64).
- **Leaves never carry the CA key.** `Leaf` uses a separate leaf key. Neither its private key nor the
  leaf's public key is the CA's.
- **Inherent exposure, not a defect.** `%v` of `cert.PrivateKey` prints the *leaf* key's D. A
  `tls.Certificate` has to carry its key, so callers must never log that field.

### Leaves: short-lived, exact SAN, cached safely

- **Lifetime.** Each leaf runs from `now−1h` to `now+30d` (721 h). Near the CA's end, `NotAfter` is
  cut to the CA's.
- **Profile.**
  - **Names:** `DNSNames == [host]`, with no IP, email or URI SANs.
  - **Usage and type:** `IsCA` false with basic constraints present, `KeyUsage` digitalSignature only,
    EKU `[serverAuth]`.
  - **Issuer:** the AKI equals the CA's SKI.
  - **Strict mode:** `openssl verify -x509_strict -purpose sslserver` gives OK.
- **Exact host only.** `Leaf` refuses `API.EXAMPLE.TEST`, `api.example.test.`, ` api.example.test`,
  and `invalid` (even for a host-less CA). Those fail closed. Task 8's `ParseHostPort` normalises
  first.
- **Concurrency.** The `hosts` map is read-only after `New`, and the cache sits behind `mu`. With 64
  concurrent callers, each host gets one shared `*tls.Certificate`, clean under `-race`.
- **Minor M2.** Within the CA's last 24 h, every call mints a new leaf. After the CA expires, `Leaf`
  mints leaves whose `NotAfter` precedes `NotBefore`, and verifiers reject them (fail closed). Both
  need one keyd process to hold a cell for 396+ days.

### Go's verifier and Leaf both reject an unbound name

- **Leaf.** `Leaf` returns `ErrNotPermitted` for `example.com`, `evil.test`, `x.api.example.test` and
  `""`.
- **Go's verifier** refuses forged leaves with `CANotAuthorizedForThisName`, for unbound names, IP
  addresses, mixed SANs and a host-less CA.
- **CN-only forged leaves are refused everywhere:**
  - Go refuses with `x509: certificate relies on legacy Common Name field`.
  - Chromium refuses with `ERR_CERT_COMMON_NAME_INVALID`.
  - OpenSSL applies the DNS constraint to the CN (`permitted subtree violation`).

### Chromium parity with S4 (D7): run on the brief's actual CA

**Profile match.** `openssl x509 -text` of a `cellca.New` CA matches S4's `make-ca.sh` wherever the two
overlap:
- `Key Usage: critical, Certificate Sign, CRL Sign`
- `Basic Constraints: critical, CA:TRUE, pathlen:0`
- SKI
- `Name Constraints: critical, Permitted: DNS:<host>`
- P-256 with ECDSA-SHA256

The brief adds two things S4 never ran: `Extended Key Usage: TLS Web Server Authentication` (not
critical) and `Excluded: IP:0.0.0.0/0, IP:::/0`.

**Chromium run.** I replayed S4 Step 5 against those two extras:
- **Image:** the same image, `lscr.io/linuxserver/webtop:ubuntu-xfce` `73f966bd414c`, running Chromium
  154.0.8037.57.
- **Container:** a throwaway `ld-t6-chromium`, with the image's own wrapper (`--no-sandbox`, as S4
  had).
- **Trust:** an NSS DB built with Homebrew NSS 3.124 `certutil -A -t "C,,"`, as S4 imported its CA.
- **Server:** a scratch Go server on 127.0.0.1:4790–4799, reached as `192.168.65.254` through
  `--host-resolver-rules`.
- **CA B:** the brief's CA re-signed with `ExcludedDNSDomains ".api.example.test"`, to test the C1 fix.

| Case | Chromium 154 | curl 8.14.1 / OpenSSL 3.5.8 (`localdot-spike-cell`) |
|---|---|---|
| control, before the import | `ERR_CERT_AUTHORITY_INVALID` ("No matching issuer found") | n/a |
| A: `Leaf("api.example.test")` | **loaded**, `TRUSTED_ANCHOR+enforce_anchor_expiry+enforce_anchor_constraints` | served |
| A: forged `bank.example` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `permitted subtree violation` |
| A: forged `x.api.example.test` | **loaded** (C1) | **served** (C1) |
| A: forged `[api.example.test, bank.example]` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `permitted subtree violation` |
| A: forged IP SAN `192.168.65.254` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `excluded subtree violation` |
| A: forged CN-only `bank.example` | `ERR_CERT_COMMON_NAME_INVALID` | `permitted subtree violation` |
| C: host-less CA, forged `example.com` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `permitted subtree violation` |
| B: `Leaf("api.example.test")` | **loaded** | served |
| B: forged `x.api.example.test` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `excluded subtree violation` |
| B: forged `*.api.example.test` (visiting `y.api.example.test`) | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `excluded subtree violation` |

So the brief's extras don't break trust, and Chromium and curl both enforce the IP exclusion. The
subdomain result repeats S4's own `www.postman-echo.com` "loaded".

I tore down the container and the server afterwards. Ports 4790–4799 are free, and nothing else
changed.

## 3. The pins (`f636b2b`, `cellca_integrity_test.go`, 7 tests)

| Test | Pins |
|---|---|
| `TestTheCAKeepsTheProfileS4ProvedInChromium` | P-256; CA key usage exactly certSign\|CRLSign; lifetime exactly 397 d + 1 h, starting an hour before `New` (one provenance comment: S4/D7) |
| `TestTheConstraintsPermitTheHostsAndNoAddress` | the permitted DNS set equals the hosts; `ExcludedIPRanges` exactly `0.0.0.0/0` and `::/0` |
| `TestAForgedCertificateCannotWidenTheConstraints` | forged leaves with an unbound name, an IPv4 address or an IPv6 address beside the bound name get `CANotAuthorizedForThisName`; a leaf under a CA forged with the cell key gets `TooManyIntermediates` |
| `TestLeafIsAShortLivedServerCertificateForItsHostAlone` | exactly one SAN, the host; not a CA; KU and EKU exact; `now−1h` to `now+30d` exactly; `NotAfter` cut to the CA's near its end |
| `TestTheCAKeyIsNeverHandedOut` | the leaf's key and public key are not the CA's; no form of the CA key in JSON, 8 fmt verbs on the `*CA` and the leaf, `CertPEM`, or the refusal error |
| `TestConcurrentCallersShareOneLeafPerHost` | 64 concurrent callers behind a start barrier: one shared leaf per host, distinct across hosts |
| `TestHostsAreExactlyTheNamesLeafServes` | `Hosts()` sorted and unique (the interface says sorted, and no brief test calls it), each one served by `Leaf`; a host-less CA lists none and refuses `invalid` |

**RED, by mutation.** These pin properties the brief's code already has, so they pass on it. Their RED
is the mutants below. I applied each to a scratch copy of `cellca.go` with perl, checked that the
substitution applied, and ran the brief's nine tests and the pins, each with `-race`.

| Mutant | Brief's 9 tests | Pins |
|---|---|---|
| M01 `::/0` narrowed to `2000::/3` | survives | killed (exact ranges) |
| M02 `0.0.0.0/0` narrowed to `/1` | survives | killed (exact ranges; forged `203.0.113.7`) |
| M03 the leaf is made and served with the **CA key** | survives | killed (key test) |
| M04 the leaf also carries `*.<host>` | survives | killed (leaf profile) |
| M05 the leaf is a CA with certSign | survives | killed (leaf profile) |
| M06 leaves live 300 days | survives | killed |
| M07 the CA lives 3970 days | survives | killed |
| M08 / M09 leaf / CA start 48 h back | survives | killed |
| M10 no cut at the CA's `NotAfter` | survives | killed |
| M11 no lock around the cache | survives | killed (data race; also 20/20 runs without `-race`) |
| M12 `Leaf` allowed for the `permitted` list (so `invalid` too) | survives | killed |
| M13 `Hosts()` unsorted | survives | killed |
| M14 the CA key on P-384 | survives | killed |
| M15 the CA's KU without certSign | killed (Go refuses) | killed |
| M16 a `String()` that prints the key | survives | killed |
| M17 a `MarshalJSON` that writes the key | survives | killed |
| C01 / C02 controls: no refusal; NC not critical | killed | killed / survives (the brief pins it) |

All 16 mutants that survive the brief are killed. Flakiness: `-count=200`, and `-count=50 -race`, are both
clean.

## 4. Concerns

### C1 (needs a ruling): the X.509 constraint covers every subdomain of a bound host

**What happens.** A stolen CA key can forge `x.api.example.test` or `*.api.example.test`, and Go
(probe), Chromium 154 and curl/OpenSSL 3.5.8 (table above) all accept it. Only `Leaf` is exact.

**What the brief says.** Its prose says "permitting exactly the cell's bound hosts", but it also says
`Leaf` is stricter "even though the X.509 subtree rule would allow its subdomains". So this was a known
trade-off. The controller's checklist says "exactly the bound DNS names".

**What it reaches.**
- **A bound apex.** `github.com` would cover `api.github.com` and `gist.github.com`.
- **Suffix-like names.** Names that pass `policy.ValidBindingHost` (two LDH labels, letter TLD) can
  cover far more. Reproduced: `New("c", ["co.uk"])` makes a forged `www.bbc.co.uk` verify. A binding
  to `s3.amazonaws.com` would cover every bucket host.

**Mitigations.** The key exists only in keyd's memory. Whoever can read it can also read the real
secrets. The CA is trusted only inside the cell.

**Fix (verified, not applied, because it changes the brief's code).** Add `ExcludedDNSDomains: "."+h` for
each bound host `h` that has no other bound host beneath it.
- Chromium 154, curl, OpenSSL and Go then refuse forged subdomain and wildcard leaves, and still
  accept the genuine leaf (CA B in the table).
- **The nested-host rule is required.** Excluding every host's subtree breaks nested bindings. With
  `example.test` and `api.example.test` both bound, `.example.test` refuses the bound
  `api.example.test` (Go probe), because exclusions win.
- **Residual.** In that nested case the parent's other subdomains stay open (`www.example.test` is
  still accepted).
- **Test.** A test would forge `x.<host>` and expect `CANotAuthorizedForThisName`.

### C2 (defence in depth, low): `New` trusts its caller's host strings

Go and Chromium both treat an empty dNSName constraint as matching every name. Reproduced in the probe:
- **`New("c", [""])`** gives an **unconstrained** CA: forged `bank.example` and `www.bbc.co.uk` verify.
- **`"test"`** covers all of `.test`.
- **`".example.test"`** covers every subdomain.
- **`"*.example.test"`** lets `Leaf` mint a wildcard leaf, valid for `x.example.test`.

This is unreachable in the plan. Task 15 is `New`'s only caller, and it passes hosts from bindings that
`policy.ValidBindingHost` (Task 8) accepted: lowercase LDH, two or more labels, no wildcard, no IP, no
trailing dot.

Suggested fix: `New` refuses an empty, wildcard or dot-edged host, or calls `policy.ValidBindingHost`
once Task 8 lands. That way a future caller can't make an unconstrained CA by accident.

### C3 (informational): EKU chaining depends on the verifier

Review M8's claim ("a stolen key could not sign a client, mail or code-signing certificate") holds in
some verifiers but not all:
- **Go** refuses client, code-signing and mail leaves (`IncompatibleUsage`).
- **OpenSSL `sslclient`, `smimesign`** refuse at depth 1 (`unsuitable certificate purpose`).
- **OpenSSL 3.6.3 `-purpose codesign`** gives `codesign.pem: OK` for a code-signing leaf under the CA:
  that purpose checks only that issuers are CAs.

For non-TLS uses, the effective limit is how the cell trusts the CA. NSS `-t "C,,"` (SSL only, as S4
imported it) is safe. A later task that adds the CA to an OpenSSL bundle should keep it TLS-only, for
example as a `TRUSTED CERTIFICATE` with `-addtrust serverAuth`. Worth a line in Task 15 or Part 4b.

### Minor (deferred)

- **M1.** `Certificate()` returns the CA's own `*x509.Certificate`. A caller that mutates it (for example
  its `NotAfter`) changes how `Leaf` caps leaves. This is in-process only.
- **M2.** The renewal behaviour around the CA's own expiry, described in section 2.
- **M3.** `Leaf` returns the cached `*tls.Certificate` itself. This is fine for `crypto/tls`.

## 5. Verification (at `f636b2b`)

| Check | Result |
|---|---|
| `gofmt -l keyd` (repo root) | prints nothing |
| `go vet ./...`, `GOOS=darwin go vet ./...`, `GOOS=linux go vet ./...` (in `keyd/`) | clean |
| `go mod tidy -diff` | no changes (stdlib only) |
| `go test -race -count=1 ./...` (in `keyd/`) | ok: audit, cellca, events, netguard, surrogate, vault |
| Top-level tests | cellca 16 (the brief's 9, plus 7 pins); audit 16, events 3, netguard 22, surrogate 11, vault 36 + 1 skip (the opt-in Keychain test, not run). That is 104 passing and 1 skipped. Task 17's total moves +7 if the pins stay |
| `pnpm lint` | exit 0 (`Checked 53 files … No fixes applied.`) |
| `pnpm hygiene` | exit 0. `git ls-files` lists all three cellca files, so they are scanned |
| Working tree | clean; `main` still at `992e82d` |

## 6. Self-review

- **Brief code.** The production code is the brief's, unchanged, and the brief's tests are untouched.
- **Pins.** They live in their own file, following the `*_integrity_test.go` convention of Tasks 2–4.
  They reuse the brief's helpers (`forge`, `verify`, `notAuthorized`, `pool`).
- **Comments.** One provenance comment (S4/D7) and no others.
- **Test hygiene.** No network and no fixed ports in tests. Fake names only (`*.example.test`,
  `bank.example`, and the TEST-NET and documentation addresses).

## 7. Scratch and side effects

- **Shared scratchpad.** It is shared by the controller's whole session. At 20:20 another agent
  overwrote my top-level `scratchpad/mutate.sh` with its own script, which mutates files in **Part 2's
  checkout** (`/Projects/localdot`) and keeps a backup at `scratchpad/mut.bak`.
  - My next run executed their script without arguments. It stopped at `label=$1` (under `set -u`)
    before its first `cp`, so nothing was touched.
  - My own script only ever wrote inside my scratch module copy.
  - However, I had first written `mutate.sh` at about 20:19. If their agent invoked it between then
    and 20:20, it ran my script, which ignores arguments and does nothing, so **any mutation result
    that agent recorded in that minute is void.**
  - I then moved every file of mine into `scratchpad/task6-cellca/`, and left `mutate.sh` and
    `mut.bak` alone.
  - My first probes ran `rm -rf` on top-level `probe`, `mut`, `t6out` and `nssdb`. No ledger mentions
    those names, and they held only my files when I moved them.
  - **Recommendation:** have agents use task-named subfolders.
- **Probes** are in `scratchpad/task6-cellca/`:
  - `probe/keyd/internal/cellca/{probe,probe2,probe3}_test.go`, `export_probe.go` (scratch-only
    `ProbeSign` and `NewExcludingSubdomains`), and `probe/keyd/cmd/t6probe` (the TLS server);
  - `chromium-results.txt`, `curl-results.txt`, `netlog-*.json`, and `osslcases/`;
  - `mutants.tsv`, `mutate-cellca.sh`, and `mutation-results.txt`.
- **Network (corrected in the fix round).** This bullet first said Chromium reached
  `redirector.gvt1.com` once and nothing else. That was wrong.
  - **What the NetLogs show.** In both rounds, the image's headless Chromium made its own background
    connections to Google on every visit, with or without `--disable-background-networking`:
    `update.googleapis.com`, `accounts.google.com`, `www.google.com`, `redirector.gvt1.com` and
    `r*.gvt1.com`. That came to 66 verifications in round 1 and 54 in the fix round.
  - **What it carried.** Nothing of ours: those were TLS connections to Google's own hosts, verified
    against the system roots.
  - **Our traffic.** All test traffic went to 127.0.0.1:4790–4799 (the spike and e2e range), which the
    container reached as `192.168.65.254`.
  - **Next time.** To avoid this, run the container with `--network none` plus a host-gateway route,
    or block egress.

---

# Fix round 1 (controller rulings on C1 and C2)

**Status:** DONE_WITH_CONCERNS. C1 is applied as ruled, along with C2's empty-host refusal. Two clauses
of the ruling can't be applied as written, and each needs a decision (A and B below).

**Commit:** `21da3b7 fix(keyd): exclude bound hosts' subdomains from the cell CA and refuse an empty host`.
It touches `keyd/internal/cellca` only (`cellca.go` +20, `cellca_integrity_test.go` +63). It has an empty
body and no attribution. The tree is clean, and `main` is still at `992e82d`.

## What changed

- **C1.** `ExcludedDNSDomains` is `subdomainsOf(hosts)`, which lists `"."+h` for each bound host `h` that
  no other bound host sits beneath.
  - **Rule.** "Beneath" means `strings.HasSuffix(o, "."+h)`, so the match needs a dot boundary.
  - **Result.** `api.example.test` gives `[.api.example.test]`. The pair `example.test` and
    `api.example.test` gives `[.api.example.test]` only.
  - **Unchanged.** A host-less CA gets no excluded names (it is still `invalid` only).
  - **Comment.** One comment on `subdomainsOf` states why the nested exception exists.
- **C2.** `New` refuses any empty host before generating keys, with the unexported sentinel
  `errEmptyHost` ("cellca: an empty host would permit every name").
  - **Why a sentinel.** Without the explicit check, Go 1.27 still fails `New`, but only by accident:
    `x509: failed to parse dnsName constraint "."`, from the new exclusion of `"."+""`. Chromium
    reads an empty permitted name as "everything", so the check must not rely on Go's parser. The test
    therefore asserts `errors.Is(err, errEmptyHost)`.
- **Tests.** The cellca package goes from 16 to 19 tests: the brief's 9, my 7, and 3 new.
  - **Extended:** `TestTheConstraintsPermitTheHostsAndNoAddress` now checks the exact excluded names
    `{.api.example.test, .postman-echo.com}`.
  - **New: `TestAForgedLeafForASubdomainOfABoundHostIsRefused`** binds `api.example.test` and
    `pi.example.test`. The latter catches a check without a dot boundary, since `api.example.test`
    ends in `pi.example.test`. Forged `x.api…`, `*.api…` (visited as `y.api…`), `x.pi…` and
    `a.b.pi…` all get `CANotAuthorizedForThisName`, and both bound hosts' `Leaf`s verify.
  - **New: `TestNestedBoundHostsBothVerifyAndTheInnerSubtreeIsRefused`** binds `example.test` and
    `api.example.test`. Both bound leaves verify, a forged `x.api.example.test` is refused, and the
    excluded names are exactly `[.api.example.test]`.
  - **New: `TestNewRefusesAnEmptyHost`** covers `[""]` and `["api.example.test", ""]`. Each gets
    `errEmptyHost` and no CA.

## A. Not applied: "an unbound sibling (`x.example.test`) doesn't [verify]" is impossible for one CA

**Why.** RFC 5280 DNS constraints are subtrees, and every verifier lets an exclusion beat a permission.
- Any permitted subtree that holds `example.test` holds every `*.example.test`.
- An exclusion that covers every sibling (`.example.test`) also refuses the bound `api.example.test`.
- Excluding a named sibling only moves the thief to another name.

**Evidence.** The real fixed CA, in Chromium 154 and curl (tables below): `B-forged-parent-sibling` is
loaded and served. The nested test therefore asserts what is achievable, and its comment records the
residual. It does not pin the residual as expected behaviour.

**Options:**
- **(i) Accept the residual (my recommendation).** It needs nested bindings in one cell. `Leaf` stays
  exact, and only someone holding the key reaches the parent's other subdomains.
- **(ii) `New` refuses nested hosts.** Every CA is then exact, but a cell can no longer hold, say, a git
  credential for `github.com` alongside an API token for `api.github.com`.
- **(iii) One CA per nesting depth.** Exact for every name, but an interface change: `CertPEM` returns
  several blocks, and the cell installs several anchors.

## B. Not applied: refusing an empty host *list* conflicts with the brief and the plan

**Not unconstrained.** An empty list doesn't make an unconstrained CA. `New(id, nil)` is the brief's
`invalid`-only CA. Chromium 154 and curl both refused a forged `example.com` under it (row C below).

**What refusing it would break:**
- The brief's own `TestACellWithoutHostsCanVouchForNothingReal`, which requires `New("cell-2", nil)` to
  succeed.
- Its interface text "(or the reserved name `invalid` when it has none)".
- The plan's Task 15. `Manager.Open` calls `cellca.New(req.CellID, slices.Compact(hosts))` for every
  cell (plan line 12457). Every brain cell is host-less by design ("it holds no HTTP secret, so it has no
  bound hosts", line 14279).
- The planned tests that open host-less cells and expect success: lines 12172 (desktop, no secrets),
  12197 and 12298 (brain with `anthropic`), and 13130 (`POST /v1/cells`, brain).

**If you still want it.** It is a three-line change, but it needs the brief's test replaced and Task 15
amended: no CA for host-less cells, `Config.CA` nil (Task 12 already allows that), and no
`ca.pem`/`caCertPem`.

## RED (each new or extended test fails on `f636b2b`)

I ran the final test file against `f636b2b`'s `cellca.go` plus only the behaviour-free `errEmptyHost`
declaration, so the sentinel compiles:
```
--- FAIL: TestTheConstraintsPermitTheHostsAndNoAddress: excluded names [], want every host's subdomains
--- FAIL: TestAForgedLeafForASubdomainOfABoundHostIsRefused: a forged leaf for x.api.example.test: <nil>
    (and *.api.example.test, x.pi.example.test, a.b.pi.example.test: <nil>)
--- FAIL: TestNestedBoundHostsBothVerifyAndTheInnerSubtreeIsRefused: a forged leaf beneath the inner bound host: <nil>
    excluded names [], want only the inner host's subdomains
--- FAIL: TestNewRefusesAnEmptyHost: New([""]): CA made true, error <nil> (and ["api.example.test" ""])
```
**GREEN:** 19/19 under `-race`, also at `-count=200` and at `-race -count=50`.

## Mutation run on the fix (scratch copy, each run with `-race`)

| Mutant | The other 15 tests | The 4 new or extended |
|---|---|---|
| F1 no exclusions (that is, `f636b2b`) | survives | killed (3 tests) |
| F2 exclude every host, no nested rule | survives | killed (the nested test: `api.example.test` refused) |
| F3 no dot boundary (`o != h && HasSuffix(o, h)`) | survives | killed (`x.pi.example.test` verified) |
| F4 only the first host excluded | survives | killed (3 tests) |
| F5 exclude the host itself (no leading dot) | killed (`TestLeafVerifiesForAPermittedHost`) | killed |
| F6 no empty-host check | survives (Go's parser fails `New` anyway) | killed (`errEmptyHost` expected) |
| F7 only `hosts[0]` checked | survives | killed |

## Chromium 154 and curl, re-run on the fixed `cellca.New` (no re-signing)

**Setup.** As in section 2:
- the same image `73f966bd414c` and an NSS DB with `-t "C,,"`;
- a scratch server on 127.0.0.1:4790–4799, reached as `192.168.65.254`;
- curl 8.14.1 / OpenSSL 3.5.8 in `localdot-spike-cell`.

**CAs.** A = `New("cell-a", ["api.example.test"])`, B = `New("cell-b", ["example.test",
"api.example.test"])`, C = `New("cell-c", nil)`. `openssl x509 -ext nameConstraints` shows:
- A: `Permitted: DNS:api.example.test`, `Excluded: DNS:.api.example.test`, plus both IP ranges.
- B: `Permitted: DNS:example.test, DNS:api.example.test`, `Excluded: DNS:.api.example.test`.
- C: `Permitted: DNS:invalid`.

| Case | Chromium 154 | curl / OpenSSL 3.5.8 |
|---|---|---|
| A `Leaf("api.example.test")` | loaded (`TRUSTED_ANCHOR+enforce_anchor_expiry+enforce_anchor_constraints`) | served |
| A forged `x.api.example.test` | `ERR_CERT_INVALID`, "Not permitted by name constraints" (**was loaded before the fix**) | `excluded subtree violation` |
| A forged `*.api.example.test` (visiting `y.api.example.test`) | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `excluded subtree violation` |
| A forged `bank.example` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `permitted subtree violation` |
| A forged IP SAN `192.168.65.254` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `excluded subtree violation` |
| B `Leaf("example.test")` | loaded | served |
| B `Leaf("api.example.test")` | loaded | served |
| B forged `x.api.example.test` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `excluded subtree violation` |
| B forged `x.example.test` (A above) | **loaded** | **served** |
| C forged `example.com` | `ERR_CERT_INVALID`, "Not permitted by name constraints" | `permitted subtree violation` |

I removed the container and stopped the server afterwards, and ports 4790–4799 are free.

**Outside traffic.** Chromium in the container still made its own background connections to Google
(updater, accounts, www, gvt1) despite `--disable-background-networking`. That came to 54 verifications
in this round, and none carried anything of ours. See the corrected network bullet in section 7.

## Verification (at `21da3b7`)

| Check | Result |
|---|---|
| `gofmt -l keyd` (repo root) | prints nothing |
| `go vet ./...`, `GOOS=darwin`, `GOOS=linux` (in `keyd/`) | clean |
| `go mod tidy -diff` | no changes |
| `go test -race -count=1 ./...` | ok: audit 16, cellca 19, events 3, netguard 22, surrogate 11, vault 36 + 1 skip. That is 107 passing, and Task 17's total moves +10 over the brief's 9 cellca tests |
| `pnpm lint`, `pnpm hygiene` | both exit 0 |

**Scratch.** All of this round's files are in `scratchpad/task6-cellca/`:
- `fix-red.txt`, `fix-green.txt`;
- `fixmut/`, `fixmutants.tsv`, `fixmutate.sh`, `fix-mutation-results.txt`;
- `fixprobe/` (scratch-only `ProbeSign` and `cmd/t6probe2`), `fixout/`, `nssdb2/`;
- `fix-chromium-results.txt`, `fix-curl-results.txt`, `fix-netlog-*.json`;
- `redcheck/`.

Nothing was written at the scratchpad's top level.

---

# Micro fix (after the review approved the CA; residual A and behaviour B accepted)

**Status:** DONE. All three items are done.

**Commit:** `ac226f0 fix(keyd): lowercase cell CA hosts, hand out copies of its certificate, pin serials and
renewal`, on top of `b441b98`. It touches `keyd/internal/cellca` only (`cellca.go` +19/−6,
`cellca_integrity_test.go` +110). It has an empty body and no attribution. The tree is clean, and `main` is
still at `992e82d`.

## Changes

1. **Pins for the reviewer's three surviving-mutant findings.** They are test-only; the behaviour was
   already right.
   - **`TestSerialsAreRandom127BitNumbersNeverReused`.** It collects 41 serials: the CA's, plus 4 hosts ×
     10 renewal rounds of leaves. It requires that each has more than 64 and at most 127 bits, that none
     repeats, and that the widest has exactly 127 bits.
     - **Flake odds** are under 2^-41 per run, which a one-line comment states. The run passed at
       `-count=200` and `-race -count=50`.
     - **Not covered:** a test can't prove the source is `crypto/rand`. A 127-bit draw from a seeded
       PRNG would pass.
   - **`TestALeafIsRenewedExactlyADayBeforeItExpires`.** At `NotAfter − 24h − 1s` it gets the same
     leaf, and at `NotAfter − 24h` a new one.
   - **`TestASingleHostCARefusesItsSubdomains`.** A forged `x.api.example.test` under a CA for the one
     host `api.example.test` gets `CANotAuthorizedForThisName`.
2. **Lowercase hosts.**
   - **`New`.** It lowercases the hosts into a new slice, so the caller's slice is untouched. The
     permitted names, the excluded names, `Hosts()` and the names `Leaf` serves are all lowercase.
   - **`subdomainsOf`.** Its nesting check compares lowercased names, and the doc comments say so.
   - **`Leaf` is still exact.** It serves the lowercase names, which Task 8's `ParseHostPort` already
     produces.
   - **Tests:**
     - `TestNewLowercasesItsHosts`: `New(["Example.test","api.example.test"])`. Both bound hosts' leaves
       verify, `Hosts()` is `[api.example.test example.test]`, and the caller's slice is unchanged.
     - `TestSubdomainsOfFindsANestedHostInAnyCase`: `subdomainsOf(["Example.test","api.example.test"])`
       gives `[.api.example.test]`.
3. **`Certificate()` returns a copy**, made with `x509.ParseCertificate(slices.Clone(ca.cert.Raw))`. The
   clone matters because `ParseCertificate` aliases its input. `Leaf` keeps signing under the internal
   certificate. The `panic` on a parse error can't be reached: the bytes are an exact copy of ones that
   parsed in `New`.
   - **`TestChangingTheReturnedCertificateChangesNothing`** first mutates a returned copy:
     - it sets another `PublicKey`;
     - it sets `PermittedDNSDomains[0] = "bank.example"`;
     - it moves `NotAfter` 10 years later;
     - it flips `Raw[0]`.
   - **Then** `Leaf` and the verification still succeed, and a fresh `Certificate()` keeps the original
     `NotAfter` and permitted names.

## RED

- **Items 2 and 3** fail on `b441b98` itself, with `cellca.go` unchanged and the new tests added:
  ```
  TestNewLowercasesItsHosts: Leaf("example.test"): cellca: not one of this cell's intercepted hosts
    the bound api.example.test: x509: … DNS name "api.example.test" is excluded by constraint ".Example.test"
    Hosts [Example.test api.example.test]
  TestSubdomainsOfFindsANestedHostInAnyCase: excluded names [.Example.test .api.example.test], want only the inner host's subdomains
  TestChangingTheReturnedCertificateChangesNothing: x509: provided PrivateKey doesn't match parent's PublicKey
  ```
- **Item 1's pins** pin behaviour that is already correct, so they pass on `b441b98`. Their RED is the
  reviewer's mutants, each applied to `b441b98`'s `cellca.go`. Every one survives the 19 earlier tests:

| Mutant | Killed by |
|---|---|
| constant serial `1` | serials test: `serial 1 has 1 bits, want a random number below 2^127` |
| 16-bit serial | serials test: `serial 6fcb has 15 bits …` |
| `renewBefore` 13 h | renewal test: `a leaf a day from expiry was reused` |
| `renewBefore` 29 days | renewal test: `a leaf was renewed more than a day before it expires` |
| exclusions only for 2+ hosts | single-host test: `a forged leaf for x.api.example.test: <nil>` |

## Mutants of the fix (each survives the other 22 tests, and the new tests kill it)

| Mutant | Killed by |
|---|---|
| no lowercasing in `New` | `TestNewLowercasesItsHosts` (`Leaf("example.test")` refused) |
| lowercasing the caller's slice in place | `TestNewLowercasesItsHosts` (`New changed its caller's hosts`) |
| a case-sensitive nesting check | `TestSubdomainsOfFindsANestedHostInAnyCase` |
| `Certificate()` returns the internal pointer (`b441b98`) | the copy test: `provided PrivateKey doesn't match parent's PublicKey` |
| `ParseCertificate(ca.cert.Raw)` without the clone | the copy test (panic: the flipped `Raw[0]` broke the CA's own bytes) |
| a shallow copy `c := *ca.cert` | the copy test (the shared `PermittedDNSDomains` refused `api.example.test`) |

## Verification (at `ac226f0`)

| Check | Result |
|---|---|
| `gofmt -l keyd` | prints nothing |
| `go vet ./...`, `GOOS=darwin`, `GOOS=linux` | clean |
| `go mod tidy -diff` | no changes |
| `go test -race -count=1 ./...` | ok: audit 19, cellca 25, events 7, netguard 22, surrogate 11, vault 36 + 1 skip. That is 120 passing. cellca is the brief's 9 plus 16 |
| repeats | cellca at `-count=200` and `-race -count=50`: clean |
| `pnpm lint`, `pnpm hygiene` | both exit 0 |

**Scratch.** Everything is in `scratchpad/task6-cellca/`: `micro/` (the mutation copy, the `b441b98` and
fixed sources, both mutant lists), `micro-red.txt`, `micro-green.txt`, `micro-mutation-red.txt` and
`micro-fix-mutation.txt`. Nothing was written at the scratchpad's top level, and nothing used the network
or Docker.
