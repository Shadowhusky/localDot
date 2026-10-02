# Task 8 report: the egress policy

**Status: DONE_WITH_CONCERNS.**

I found no numeric spelling, no deny-listed name and no spelling of a bound host that gets past the policy.

- **Numeric spellings:** the real macOS resolver, run in a sandbox where it can only answer locally, answered 4,066 names locally. The policy refused every one of them, as a CONNECT target, as a plain-HTTP target and as a binding host.
- **Bound hosts:** every spelling that normalises to a bound host is intercepted, including upper case, trailing dots, and non-ASCII letters that lower-case to ASCII.

There is one real gap and three minor ones. All are production-code changes beyond the brief, so they need rulings, and none is applied:

1. **C1, a deny-list gap.** The bare `home.arpa` is not denied. A Desktop or Browser cell may reach it, and `ValidBindingHost` accepts it. "Matches whole labels" says it should be denied. A three-line fix passes all 16 tests.
2. **C2, non-ASCII letters (minor).** `ParseHostPort` accepts `İ` (U+0130) and the Kelvin sign `K` (U+212A), because `strings.ToLower` maps them to `i` and `k`. That conflicts with the brief's own `bücher.example` row, which says non-ASCII is `host-invalid`. It is never a bypass.
3. **C3, a malformed port (minor).** `ParseHostPort` accepts `+443` through `strconv.Atoi`. Go's HTTP parser refuses it before keyd sees it, so it is unreachable today.
4. **C4, brackets around a name (note).** `ParseHostPort` accepts `[example.test]:443` as `example.test`. Go 1.27's URL parser refuses it first, so it is unreachable. No change is proposed.

## Commits (branch `feat/core-part4a`, base `fa07db9`)

- **`56990a5 feat(keyd): egress policy by role, port and name`.**
  - Files: `keyd/internal/policy/policy.go` and `keyd/internal/policy/policy_test.go`.
  - Both are byte-identical to the brief. I extracted the brief's two Go blocks with awk and checked them with `cmp`, against the brief and against the plan's own copy (plan lines 4155–4299 and 4311–4469).
- **`6040071 test(keyd): pin the policy's numeric spellings, normalisation, deny labels, ports and binding hosts`.**
  - File: `keyd/internal/policy/policy_integrity_test.go`, 9 tests, test-only.
  - It follows the `*_integrity_test.go` convention from Tasks 2–7.

Neither commit has a body, a `Co-Authored-By` line or any AI attribution (checked with `git log --format=%B`). The working tree is clean. Nothing outside `keyd/internal/policy/` changed, and I never touched the `Projects/localdot` checkout.

## TDD evidence

- **RED:** with the test file alone, `go test ./internal/policy/` gave `FAIL … [build failed]`. The first error was `internal/policy/policy_test.go:9:22: undefined: Target`, exactly as Step 2 expects. Saved in `scratchpad/t8-policy/red.txt`.
- **GREEN:** `ok` with 7 tests, as Step 4 expects.
- **Pins:** all 9 pass on the brief's code. Eight of them kill mutants the brief's tests miss (see Mutation testing). The ninth, the numeric list, is ruling 1's explicit requirement. It still fails if the top-level-domain rule is weakened (M64, M69, M71).

## Verification

All commands ran in `keyd/` unless noted.

- `gofmt -l .` prints nothing.
- `go vet ./...` is clean on the host, with `GOOS=darwin` and with `GOOS=linux`.
- `go mod tidy -diff` is clean.
- `go test -race ./...` passes in every package: audit, cellca, events, netguard, policy, scrub, surrogate and vault.
- The policy package has 16 tests: the brief's 7 and 9 pins. It is stable at `-count=50` and at `-race -count=10`.
- At the repo root, `pnpm lint` exits 0 (biome checked 53 files) and `pnpm hygiene` exits 0. Hygiene lists untracked files too (`ls-files --others`), so it scanned the pin file before its commit.
- **Escape hazard:**
  - The brief's code contains no backslash-u escape. The only non-ASCII byte in it is the raw `ü` on its `bücher.example` row, carried over unchanged by the mechanical extraction.
  - The pin file contains no non-ASCII byte and no backslash (checked with grep). It builds every special character from a code point: `İ`, `K`, `ü`, NUL, tab, newline and the Arabic-Indic digits.

## The controller's rulings

**1. Numeric spellings (carry from Task 4).** `TestEveryNumericSpellingIsRefusedNeverAllowed` covers 54 spellings, including:
- octal, hex, decimal and short forms: `0177.0.0.1`, `0177.1`, `017700000001`, `0x7f000001`, `0x7f.0x1`, `127.1`, `127.0.1`, `10.1`, `192.168.257`, `169.254.43518`, `2130706433`, `0`, `0x0`, `0.0`;
- mixed forms: `0x7f.1`, `0177.0x0.1`, `127.0x0.0.1`, `0xa9.254.0251.0376`, `0300.0xa8.1.1`;
- canonical literals;
- trailing-dot forms: `127.0.0.1.`, `127.1.`, `0x7f.0x1.`, `2130706433.`, `0177.0.0.1.`, `::1.`;
- bare, bracketed and zoned IPv6: `::1`, `[::1]`, `[::]`, `fe80::1%en0`, `[fe80::1%25en0]`, `[fe80::1%en0]`;
- IPv4-mapped and IPv4-compatible forms: `[::ffff:127.0.0.1]`, `::ffff:7f00:1`, `[::FFFF:7F00:1]`, `::127.0.0.1`;
- NAT64: `64:ff9b::7f00:1`;
- an IPv4 zone, and bracketed IPv4: `[127.0.0.1]`, `[127.1]`.

Each one is tried three ways: as a CONNECT target (port required), bare with default port 80, and with an explicit `:80`. Each must give `ip-literal` or `host-invalid`, and `ValidBindingHost` must refuse it.

Under the sandbox oracle (see Bypass hunt), macOS answered 38 of the 54 locally. The other 16 are the trailing-dot, bracketed and IPv4-zoned forms. For example, `0177.0.0.1` becomes 177.0.0.1 (read as decimal), `0177.1` becomes 127.0.0.1 (read as octal), and `0xa9.254.0251.0376` becomes 169.254.169.254.

**2. One normalisation.** `TestASpellingOfABoundOrDeniedHostIsDecidedAsTheHostItself` checks:
- **Bound host:** `API.Example.TEST.:443`, `api.example.test.:443` and `API.EXAMPLE.TEST:443` parse to `{api.example.test 443}` and are intercepted (MITM) for Desktop and Brain. `ValidBindingHost` refuses each of those spellings.
- **Deny-listed names:** `PRINTER.LOCAL.:443`, `Foo.LocalHost.:443`, `Metadata.Google.Internal.:443` and `KEYD.LDOT.:443` over CONNECT, and `NAS.Home.ARPA.:80`, `Router.LAN.` and `LLM.Ldot.` over plain HTTP, are all `host-denied`.
- **Dots:** only one trailing dot is dropped, and never a leading one.
- **Non-ASCII spellings:** `ap`+U+0130, U+212A+`eyd`, and `AP`+U+0130 with a trailing dot may be refused but never pass through a bound host. Spellings of denied names are never allowed. These checks are written to hold whichever way C2 is ruled.

`TestValidBindingHostAcceptsOnlyANormalisedPublicName` also checks that every accepted binding host parses back to itself, so the CONNECT lookup finds it.

**3. Whole labels, in both directions.** `TestTheDenyListMatchesWholeLabels` checks:
- **Denied:** subdomains of every entry, including `intranet`, `private`, `corp` and `home`, which the brief's tests never touch. Deep subdomains and `localhost` itself are denied too.
- **Not denied:**
  - `evil-localhost` and `localhost.evil.test`, as the ruling names;
  - `x.evil-localhost`, `evillocalhost.test`, `x.localhostx`, `api.mylan`, `x.notlocal`;
  - `shop.myhome.arpa`, `x.home.arpa.example`, `x.local.example.com`, `home.example`, `corp.example.com`, `x.privatex`, `intranet.example`, `ldot.example`, `x.arpa`.
- **End to end:**
  - `localhost.evil.test:443`, `x.local.example.com:443` and `shop.myhome.arpa:443` are allowed.
  - `foo.localhost:443` and `a.b.home.arpa:443` are `host-denied`.
  - `evil-localhost:443` and `x.evil-localhost:443` are `host-invalid`: the first is a single label, and the second's last label is not top-level-domain-shaped.

**4. Exact ports.**
- `TestCONNECTIsFor443AndPlainHTTPFor80Only`, for an ordinary host and a bound one:
  - CONNECT on 1, 22, 80, 442, 444, 8443 and 65535 gives `port-not-allowed`. That includes a bound host on 8443, which mutant M07 would have intercepted.
  - Plain HTTP on 1, 22, 79, 81, 443, 8080 and 65535 gives `port-not-allowed`.
- `TestMalformedAndOutOfRangePortsAreRefused`:
  - These ports are refused as `host-invalid`, with and without a default port: an empty port, `0`, `-1`, `-443`, `65536`, `99999`, `4294967739` (2^32 + 443), `0x1bb`, `1_443`, `443.0`, `1e3`, ` 443`, `443 `, `4 43`, `443a`, and 443 in Arabic-Indic digits.
  - Ports 1, 443 and 65535 parse.
  - The brief's code accepts `+443` and `0443`, so neither is pinned; see C3.

## Bypass hunt

### Method

- **Resolver oracle (the real macOS resolver, no network).**
  - **Sandbox:** I ran the probe under Task 4's `loopback-only.sb` sandbox profile (copied, not modified). I re-verified the profile first:
    - `example.com` and `apple.com` fail to resolve.
    - A UDP connect to 8.8.8.8 and the `/var/run/mDNSResponder` socket both get EPERM.
    - `127.1`, `0x7f.0x1`, `0177.0.0.1` and `localhost` still resolve, locally.
    - So any name that resolves inside it was answered by libc itself.
  - **Candidates:** 3 seeds gave 18,605 candidates:
    - fixed spellings;
    - 4,000 structured spellings of 8 loopback, private, CGNAT and metadata addresses. These used 1–4 parts, decimal, octal and hex in either case, leading zeros, trailing dots and letter suffixes;
    - 4,000 random strings over a numeric alphabet.
  - **Run:** each candidate went through `net.Resolver.LookupNetIP` with `GODEBUG=netdns=cgo`, and also with `netdns=go`.
- **Deny list:** I compared `Denied` with an independent whole-label reference over 263 hosts. Each deny entry was tried bare, glued to other text, with a prefix and suffix, and nested.
- **Unicode:** I checked every code point for a lower case that is ASCII. I also checked which of those Go's HTTP parser lets through.
- **Ports and brackets:** I checked how `ParseHostPort` reads each spelling, and whether `http.ReadRequest` and `url.Parse` would ever hand it over.
- **Fuzz:** 800,000 inputs (400,000 strings, each tried with and without `:443`). The alphabet included `İ`, `K`, `ü`, brackets, `%`, `@`, `*`, spaces, `xn--`, `0x` and the deny words. For every input that parsed, I checked three things:
  - the host satisfies an independent statement of a normalised public name;
  - parsing it again gives the same result;
  - a bound host is never passed through, and nothing the whole-label reference denies is allowed.
- **cellca cross-check (for Task 15):** I took 400 hosts that `ValidBindingHost` accepts: 13 edge cases plus 387 random ones. Each went through `cellca.New`, `Hosts()`, the CONNECT lookup in four spellings (upper case and trailing dot) and `Leaf`, and the leaf was verified with Go's x509.
- **Differential checks:** each surviving mutant was compared with the original over 300,000 inputs.

### Results

| Probe | Result |
|---|---|
| Resolver oracle | 4,066 names were answered locally (1,340, 1,364 and 1,362 per seed). The policy refused every one, as CONNECT, plain HTTP and binding host: **0 bypasses**. No name ending in a letters-only label or a trailing dot was ever answered locally. |
| Deny list against the whole-label reference | The only divergences are bare entries. All are single labels, already refused as names, except **`home.arpa`**, which is allowed (C1). |
| Unicode | Only U+0130 → `i` and U+212A → `k`. Go's HTTP parser accepts both in CONNECT and absolute-form hosts. They normalise consistently: a bound host is still intercepted, a denied name is still denied, and `ValidBindingHost` refuses both (C2). |
| Ports | `Atoi` accepts `+443`, `0443` and `00000443`. Go's request parser refuses `:+443` ("invalid port") and passes `:0443`. Passthrough dials the literal port 443 (`net.JoinHostPort(t.Host, "443")`, plan line 7546). Neither is a bypass (C3). |
| Brackets around a name | `ParseHostPort` reads `[example.test]:443` as `example.test`, and `[api.example.test]:443` is still intercepted. Go 1.27's `url.Parse` and `http.ReadRequest` refuse a bracketed non-address, so it is unreachable (C4). |
| Fuzz | 800,000 inputs; 3,863 parsed. Every one was a valid normalised name and parsed back to itself. **0 bound-host passthroughs.** The only flag was `home.arpa` accepted as a binding host (C1). |
| cellca cross-check | **400 of 400** hosts work end to end: `Hosts()` returns them unchanged, all four spellings are intercepted, and the leaf verifies. |

## Concerns (production-code changes need a ruling; none applied)

### C1: the bare `home.arpa` is not denied

- **Cause:** `Denied` matches strict subdomains (`"."+suffix`) plus a special case for `localhost`. For one-label entries that is harmless: their bare forms are single labels, which `ParseHostPort` refuses. But `home.arpa` has two labels, so the bare name parses and slips through.
- **Effect:**
  - `ParseHostPort("home.arpa:443")` gives `{home.arpa 443}`, and a Desktop or Browser CONNECT is `Allow`. The same holds for `HOME.ARPA.:443`.
  - `ValidBindingHost("home.arpa")` returns nil, so the user could bind a secret to it and keyd would mint that cell a CA for `home.arpa`.
- **Why it matters:** RFC 8375 reserves `home.arpa.` for home networks, and the brief says the list "matches whole labels: local and reserved names that no cell may reach by name". The risk is low: an apex A record is rare, and netguard denies any LAN-range answer. But it is the one reachable whole-label divergence. It also makes `ValidBindingHost` laxer than its contract, which Task 15's review relies on.
- **Proposed fix:** fold the `localhost` special case into the loop. This passes all 16 tests; it is mutant M35's simplest form, and the diff is in `scratchpad/t8-policy/f1-proposed.diff`.

```go
func Denied(host string) bool {
	for _, suffix := range deniedSuffixes {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}
```

- **Pin to add with the fix:**
  - `home.arpa` in `TestTheDenyListMatchesWholeLabels`' denied list, plus a `HOME.ARPA.:443` CONNECT that gives `host-denied`.
  - `home.arpa` in the refused list of `TestValidBindingHostAcceptsOnlyANormalisedPublicName`.
  - It isn't pinned now because it would fail on the brief's code.

### C2: non-ASCII letters that lower-case to ASCII are accepted (minor)

- **The two letters:** `strings.ToLower` maps U+0130 (`İ`) to `i` and U+212A (the Kelvin sign) to `k`. These are the only two code points whose lower case is ASCII; I checked every code point exhaustively.
- **Effect:** `ParseHostPort("ap" + U+0130 + ".example.test:443")` gives `{api.example.test 443}`. That contradicts the brief's `bücher.example` → `host-invalid` row, whose point is that a name is ASCII.
- **Not a bypass:** the spelling normalises consistently. It is intercepted when bound, denied when denied, and refused as a binding host, which compares with `t.Host != host`. The pin is written to pass either way.
- **Proposed fix:** lower-case ASCII only, or refuse any byte ≥ 0x80 before lower-casing. Mutant M73 (ASCII-only lower-casing) passes all 16 tests and changes only such spellings.

### C3: `+443` is accepted by `ParseHostPort` (minor)

- **Cause:** `strconv.Atoi` accepts a sign, so `example.test:+443` parses as port 443. Ruling 4 says malformed ports are refused.
- **Reachability:** none today. `net/url` refuses `:+443` before keyd sees it, on both the CONNECT and the plain-HTTP path.
- **Leading zeros:** `0443` is valid under RFC 3986 (`port = *DIGIT`), is reachable, and is read as 443. That is harmless, because passthrough and interception use port 443 and `t.Host`.
- **Proposed fix:** digits only. Mutant M74 does it with `if strings.TrimLeft(portText, "0123456789") != "" { err = strconv.ErrSyntax }`. It passes all 16 tests, refuses `+443` and keeps `0443`. A ruling should also say whether leading zeros stay.

### C4: brackets around a name (note only)

- `net.SplitHostPort` strips the brackets from `[example.test]:443`, and the default-port path does the same for `[example.test]`.
- The result is normalised consistently.
- Go 1.27's URL parser refuses a bracketed non-address (`invalid host: ParseAddr(...)`), so keyd's HTTP entry points never pass one.
- Mutant M75 (brackets must hold an address) passes all 16 tests if a ruling wants it. I don't propose it.

## Mutation testing

I ran 89 mutants against a scratch copy of `policy.go`; the worktree was never mutated. Each mutant ran against the brief's tests alone, then against the pins. After the pin commit I ran the whole set again on the committed files, with the same result.

| Test set | Killed | Survived |
|---|---|---|
| Brief's tests alone | 47 | 42 |
| Brief's tests plus the pins | 81 | 8 |

The 8 survivors:
- **Four equivalent mutants**, checked differentially over 300,000 inputs:
  - **M26:** the IP-literal check moved after normalising. It changes only the reason for `127.0.0.1.` and `::1.` (`ip-literal` instead of `host-invalid`), never whether an input is accepted; ruling 1 accepts either.
  - **M62:** upper case accepted in a label. The input is lower-cased first. 0 differences.
  - **M77:** `ValidBindingHost` parsing with a default port. 0 differences.
  - **M80:** a required port made optional. Port 0 is then refused anyway. 0 differences.
- **Four fix probes:** M35 (C1), M73 (C2), M74 (C3) and M75 (C4).

What the pins catch that the brief misses:
- CONNECT or HTTP ports below the allowed one (M02, M05).
- A bound host intercepted on any port (M07).
- Check order: deny before role (M12), and plain HTTP checking the role before the port (M13).
- An unknown role that errs but carries a web policy (M18).
- Ports 65536 and above accepted, or hex and underscore ports (M22, M24).
- Every trailing dot dropped, or leading dots dropped (M30, M31).
- `localhost` itself not denied (M32).
- Deny matching inside a label or anywhere in a name (M33, M34).
- Each of `intranet`, `private`, `corp` and `home` dropped from the list (M39–M42).
- `home.arpa` widened to `arpa` (M46).
- `ValidBindingHost` without its reason check (M47).
- The 253- and 254-byte name boundaries, and a 63-byte label (M52, M53, M56).
- A trailing hyphen (M58).
- `xn-` or a contained `xn--` accepted as a top-level domain (M66, M67).
- A hyphen in a top-level domain (M70).
- The wire names of the five reasons and three roles (M81–M88).

The wire names matter because audit lines and `X-Keyd-Reason` carry the reasons (plan line 14360), and the admin API takes `Role: "desktop"` as a string. A changed constant would survive every Task 8 test.

| Mutant | Brief's tests | With the pins |
|---|---|---|
| M01 CONNECT accepts any port | killed | killed |
| M02 CONNECT accepts ports below 443 | **survived** | killed by `TestCONNECTIsFor443AndPlainHTTPFor80Only` |
| M03 CONNECT accepts ports above 443 | killed | killed |
| M04 plain HTTP accepts any port | killed | killed |
| M05 plain HTTP accepts ports below 80 | **survived** | killed by `TestCONNECTIsFor443AndPlainHTTPFor80Only` |
| M06 plain HTTP accepts ports above 80 | killed | killed |
| M07 a bound host is intercepted on any port | **survived** | killed by `TestCONNECTIsFor443AndPlainHTTPFor80Only`, `TestDecisionsCheckThePortThenTheBindingThenTheRole` |
| M08 a bound host is passed through, not intercepted | killed | killed |
| M09 a bound host is intercepted only for a role without the web | killed | killed |
| M10 every role has the web | killed | killed |
| M11 no deny list | killed | killed |
| M12 deny list checked before the role | **survived** | killed by `TestDecisionsCheckThePortThenTheBindingThenTheRole` |
| M13 plain HTTP checks the role before the port | **survived** | killed by `TestDecisionsCheckThePortThenTheBindingThenTheRole` |
| M14 the brain gets the web | killed | killed |
| M15 desktop and browser get the gateway | killed | killed |
| M16 the browser role is refused | killed | killed |
| M17 an unknown role gets the web | killed | killed |
| M18 an unknown role errs but carries a web policy | **survived** | killed by `TestForRoleRefusesEveryOtherRoleWithNoEgress` |
| M19 a required port defaults to 443 | killed | killed |
| M20 brackets kept on a bare literal | killed | killed |
| M21 port 0 accepted | killed | killed |
| M22 port 65536 accepted | **survived** | killed by `TestMalformedAndOutOfRangePortsAreRefused` |
| M23 no upper port bound | killed | killed |
| M24 hex and underscore ports (ParseInt base 0) | **survived** | killed by `TestMalformedAndOutOfRangePortsAreRefused` |
| M25 no IP-literal check | killed | killed |
| M26 IP-literal check after normalising | **survived** | survived: equivalent under ruling 1 (only the reason for `127.0.0.1.`/`::1.` changes) |
| M27 IPv6 literals judged as names | killed | killed |
| M28 no lower-casing | killed | killed |
| M29 the trailing dot is kept | killed | killed |
| M30 every trailing dot is dropped | **survived** | killed by `TestASpellingOfABoundOrDeniedHostIsDecidedAsTheHostItself` |
| M31 leading dots are dropped too | **survived** | killed by `TestASpellingOfABoundOrDeniedHostIsDecidedAsTheHostItself` |
| M32 Denied: localhost itself is not denied | **survived** | killed by `TestTheDenyListMatchesWholeLabels` |
| M33 Denied: suffix matches inside a label | **survived** | killed by `TestTheDenyListMatchesWholeLabels` |
| M34 Denied: an entry matches anywhere in the name | **survived** | killed by `TestTheDenyListMatchesWholeLabels` |
| M35 Denied: the bare entry is denied too (C1 fix probe) | **survived** | survived: C1 fix probe |
| M36 deny entry dropped: localhost | killed | killed |
| M37 deny entry dropped: local | killed | killed |
| M38 deny entry dropped: internal | killed | killed |
| M39 deny entry dropped: intranet | **survived** | killed by `TestTheDenyListMatchesWholeLabels`, `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M40 deny entry dropped: private | **survived** | killed by `TestTheDenyListMatchesWholeLabels`, `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M41 deny entry dropped: corp | **survived** | killed by `TestTheDenyListMatchesWholeLabels`, `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M42 deny entry dropped: home | **survived** | killed by `TestTheDenyListMatchesWholeLabels`, `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M43 deny entry dropped: lan | killed | killed |
| M44 deny entry dropped: home.arpa | killed | killed |
| M45 deny entry dropped: ldot | killed | killed |
| M46 deny entry home.arpa widened to arpa | **survived** | killed by `TestTheDenyListMatchesWholeLabels` |
| M47 ValidBindingHost: no reason check | **survived** | killed by `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M48 ValidBindingHost: the normalised form is not required | killed | killed |
| M49 ValidBindingHost: deny list not checked | killed | killed |
| M50 ValidBindingHost: case-insensitive | killed | killed |
| M51 ValidBindingHost: a trailing dot is allowed | killed | killed |
| M52 a 254-byte name is accepted | **survived** | killed by `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M53 a 253-byte name is refused | **survived** | killed by `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M54 a single label is accepted | killed | killed |
| M55 a 64-byte label is accepted | killed | killed |
| M56 a 63-byte label is refused | **survived** | killed by `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M57 a leading hyphen is accepted | killed | killed |
| M58 a trailing hyphen is accepted | **survived** | killed by `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M59 an empty label is accepted | killed | killed |
| M60 an underscore is accepted | killed | killed |
| M61 a star is accepted | killed | killed |
| M62 upper case is accepted in a label | **survived** | survived: equivalent (input is lower-cased first; 0 diffs in 300,000) |
| M63 non-ASCII is accepted in a label | killed | killed |
| M64 any top-level label | killed | killed |
| M65 no IDN top-level label | killed | killed |
| M66 a top-level label starting xn- is accepted | **survived** | killed by `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M67 a top-level label containing xn-- is accepted | **survived** | killed by `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M68 the first label is checked as the top-level one | killed | killed |
| M69 a top-level label needs only one letter | killed | killed |
| M70 a hyphen is accepted in a top-level label | **survived** | killed by `TestTheDenyListMatchesWholeLabels`, `TestValidBindingHostAcceptsOnlyANormalisedPublicName` |
| M71 a top-level label must merely not be all digits | killed | killed |
| M72 interception looked up with a trailing dot | killed | killed |
| M73 ASCII-only lower-casing (C2 fix probe) | **survived** | survived: C2 fix probe |
| M74 port text must be digits only (C3 fix probe) | **survived** | survived: C3 fix probe |
| M75 brackets must hold an address (C4 fix probe) | **survived** | survived: C4 fix probe |
| M76 the Target keeps the original spelling | killed | killed |
| M77 ValidBindingHost parses with a default port | **survived** | survived: equivalent (0 diffs in 300,000) |
| M78 the deny list sees the host with a trailing dot | killed | killed |
| M79 the brain loses the gateway | killed | killed |
| M80 a required port is optional (zero port then refused) | **survived** | survived: equivalent (port 0 is then refused; 0 diffs in 300,000) |
| M81 reason text changed: host-invalid | **survived** | killed by `TestReasonsAndRolesKeepTheirWireNames` |
| M82 reason text changed: ip-literal | **survived** | killed by `TestReasonsAndRolesKeepTheirWireNames` |
| M83 reason text changed: port-not-allowed | **survived** | killed by `TestReasonsAndRolesKeepTheirWireNames` |
| M84 reason text changed: host-denied | **survived** | killed by `TestReasonsAndRolesKeepTheirWireNames` |
| M85 reason text changed: web-not-allowed | **survived** | killed by `TestReasonsAndRolesKeepTheirWireNames` |
| M86 role text changed: brain | **survived** | killed by `TestForRoleRefusesEveryOtherRoleWithNoEgress`, `TestReasonsAndRolesKeepTheirWireNames` |
| M87 role text changed: desktop | **survived** | killed by `TestReasonsAndRolesKeepTheirWireNames` |
| M88 role text changed: browser | **survived** | killed by `TestForRoleRefusesEveryOtherRoleWithNoEgress`, `TestReasonsAndRolesKeepTheirWireNames` |
| M89 every allowed web connection is intercepted | killed | killed |

## Notes for later tasks

- **Task 15:** every host that `ValidBindingHost` accepts reaches `cellca.New` unchanged and works end to end (400 of 400). Until C1 is ruled, `home.arpa` is a bindable host.
- **Tasks 10–11 (dialer), not verified:**
  - `ParseHostPort` drops the trailing dot, so names are dialled as relative names. This Mac has search domains (`tail849a6b.ts.net`, `google.com`).
  - I did not check whether macOS appends a search domain to a multi-label name after an absolute lookup fails; that needs live DNS.
  - netguard already denies the tailnet's answers (100.64.0.0/10 and ULA).
  - Optional hardening: resolve `t.Host + "."` in the dialer, so the name rules decide exactly what is looked up.
- **Tasks 11–12:** `sameHost` and `hostIs` compare with `strings.EqualFold`, which also matches U+017F with `s` and U+212A with `k`. So a non-ASCII SNI or inner `Host` can match an ASCII `t.Host`.
  - Harmless today: the dial and the leaf both use `t.Host`.
  - A byte-wise ASCII case-insensitive compare would match the policy's ASCII-only intent.
- **Task 17's count:** the policy package has 16 tests, 9 more than the brief's 7.

## Artifacts

All in `/private/tmp/claude-501/-Volumes-Husky-s-SSD-4T-Projects/8ea76523-70ba-4eef-a6ab-cd9a3032d328/scratchpad/t8-policy/`:

- **Extraction:** `brief_policy.go`, `brief_policy_test.go`, `plan_policy.go` and `plan_policy_test.go`.
- **TDD evidence:** `red.txt` and `green.txt`.
- **Resolver oracle:**
  - `mod/cmd/resolveprobe/main.go`; run it with `GODEBUG=netdns=cgo sandbox-exec -f loopback-only.sb ./resolveprobe <seed>`.
  - `resolve-seed1.txt`, `sbcheck.py`, `loopback-only.sb`, and `mod/cmd/numlist` (the pinned list under the oracle).
- **Probes:** `mod/internal/policy/probe_test.go` (deny reference, Unicode, ports, brackets, fuzz; output in `probe-out.txt`) and `mod/internal/cellca/probe_policy_test.go` (the cellca cross-check).
- **Mutation:**
  - `mutate.py` and `mutants.json` (89 mutants).
  - Results: `mutants-result.json`, `mutants-final.txt` and `mutation-table.md`.
  - Differential runs: `diff-*.txt` (300,000 inputs each).
  - Fix probes: `hardening_test.go.txt` and `f1-proposed.diff`.
  - `mut/` is the mutation module.
- **Repo checks:** `lint.txt` and `hygiene.txt`.

Task 8 commits: `56990a5`, `6040071`.

## Addendum: controller rulings and the fix

**Rulings (controller):**
- The 9 pins in `6040071` are accepted.
- C1–C4 are all fixed, in one commit, each with a pin that fails on `6040071`.

**Fix commit:** `fb12271 fix(keyd): deny bare reserved names and refuse non-ASCII hosts, non-canonical ports and bracketed names`.
- It changes `keyd/internal/policy/policy.go` (+28/−4) and adds 4 pins to `keyd/internal/policy/policy_integrity_test.go` (+113/−1; the −1 is a var line re-aligned by gofmt).
- `policy_test.go` is still byte-identical to the brief.
- The commit has no body and no attribution line, and the working tree is clean.

### What changed in `policy.go`

- **C1, bare deny entries.** `Denied` now matches `host == suffix || strings.HasSuffix(host, "."+suffix)` for every deny entry. The `localhost` special case is gone, because the bare-entry rule covers it.
- **C2, ASCII only.**
  - `ParseHostPort` refuses a host that holds any non-ASCII byte, as `host-invalid`, using `strings.ContainsFunc(host, func(r rune) bool { return r > unicode.MaxASCII })`.
  - An invalid UTF-8 byte decodes as U+FFFD, so it is caught too.
  - The check runs before lower-casing. It runs after the IP-literal check, so a bracketed IPv6 address with an unusual zone keeps `ip-literal`, as C4 requires.
- **C3, one spelling per port.**
  - Before `strconv.Atoi`, the port text must be 1–5 ASCII digits with no leading zero (`canonicalPort`).
  - **Reason chosen: `host-invalid` for every malformed spelling.** That covers `+443`, `-0`, `+0`, ` 443`, `0443`, `080`, `065535`, `0000000000443` and the rest.
  - Why: the brief already gives `host-invalid` for unusable port text (`:0`, `:99999`, a missing port), and the accepted pin `TestMalformedAndOutOfRangePortsAreRefused` asserts it. `port-not-allowed` stays the answer for a well-formed port other than 443 (CONNECT) or 80 (plain HTTP).
  - A lone `0` passes the text check and is refused by the range check, as before.
- **C4, brackets.**
  - If the input begins with `[`, the host is an IP literal or nothing.
  - The bracket check comes after the IP-literal check. So `[::1]`, `[::ffff:127.0.0.1]`, `[127.0.0.1]` and `[fe80::1%25en0]` still give `ip-literal`, and every other bracketed host gives `host-invalid`.
  - It covers both paths: with a port (`[example.test]:443`) and with the default port (`[example.test]`). `[name]:443` never comes back as `name`.

### Pins and RED

Each pin failed on the unchanged `6040071` `policy.go`, and only these four failed; the other 16 tests passed (`scratchpad/t8-policy/fix-red.txt`). With the fix, all 20 pass (`fix-green.txt`).

- **`TestABareDenyEntryIsDeniedLikeItsSubdomains` (C1).**
  - Checks every entry bare: `localhost`, `local`, `internal`, `intranet`, `private`, `corp`, `home`, `lan`, `home.arpa`, `ldot`.
  - For each: `Denied` is true; a Desktop and a Browser CONNECT on 443 and plain HTTP on 80 give `host-denied`; `ValidBindingHost` refuses it.
  - Through the parser, `home.arpa:443`, `HOME.ARPA.:443` and `home.arpa` (default port 80) give `host-denied`.
  - RED on `6040071`: nine bare entries were allowed (every one but `localhost`), `home.arpa` was accepted as a binding host, and it was allowed through the parser.
- **`TestAHostOnTheWireIsASCII` (C2).**
  - These spellings give `host-invalid` in the CONNECT, bare and `:80` forms, and are refused as binding hosts:
    - `ap` + U+0130 and U+212A + `eyd` (`.example.test`);
    - `AP` + U+0130, in upper case with a trailing dot;
    - `pr` + U+0130 + `nter.local` and U+212A + `eyd.ldot`;
    - `bücher.example`, a fullwidth full stop, and an invalid UTF-8 byte.
  - These still parse, lower-cased: `xn--bcher-kva.example`, `XN--BCHER-KVA.EXAMPLE.` and `api.xn--p1ai`. `xn--bcher-kva.example` is still a valid binding host.
  - RED: the U+0130 and U+212A spellings parsed as `api.example.test`, `keyd.example.test`, `printer.local` and `keyd.ldot`.
- **`TestAPortIsWrittenOnlyOneWay` (C3).**
  - These give `host-invalid`, with and without a default port: `+443`, `+0443`, `-0`, `+0`, `0443`, `00443`, `080`, `+80`, `065535`, `00`, `0000000000443`.
  - Ports 1, 80, 443, 8080, 10000 and 65535 parse.
  - RED: `+443`, `+0443`, `0443`, `00443`, `080`, `+80`, `065535` and `0000000000443` parsed.
- **`TestBracketsHoldAnAddressOrNothing` (C4).**
  - These give `host-invalid` with a zero `Target`: `[example.test]:443`, `[api.example.test]:443`, `[API.EXAMPLE.TEST.]:443`, `[printer.local]:443`, `[localhost]:443`, `[example.test]` (default port 80), `[example.test]:80`, `[127.1]:443`, `[0x7f.0x1]`, `[]:443` and `[]`.
  - These give `ip-literal`: `[::1]:443`, `[::ffff:127.0.0.1]:443`, `[127.0.0.1]:443`, `[fe80::1%25en0]:443`, `[2001:db8::1]:80` and `[::1]`.
  - RED: the bracketed names and `[example.test]` parsed as the names inside them.

### Verification

All commands ran in `keyd/` unless noted.

- `gofmt -l .` prints nothing.
- `go vet ./...` is clean on the host, with `GOOS=darwin` and with `GOOS=linux`, and so is `go mod tidy -diff`.
- The policy suite has 20 tests: the brief's 7, the 9 accepted pins and these 4.
  - At `-count=50` it gave 1,000 passes (50 × 20) and no failures.
  - It also passes at `-race -count=10`.
- `go test -race ./...` passes in every package: audit, cellca, events, netguard, policy, scrub, surrogate and vault.
- At the repo root, `pnpm lint` exits 0 (biome checked 53 files) and `pnpm hygiene` exits 0.
- **Escape hazard:** `policy.go` and the pin file contain no non-ASCII byte and no backslash. The new pins build `İ`, `K`, `ü`, the fullwidth full stop and the invalid byte from code points.
- **The bypass probes, re-run on the fixed code:**
  - Deny list against the whole-label reference: 0 of 263 hosts diverge (before: `home.arpa`).
  - Fuzz: 800,000 inputs, 2,475 parsed (3,863 before; the non-ASCII, bracketed and odd-port inputs are now refused), 0 bad, 0 bound-host passthroughs.
  - cellca cross-check: `home.arpa` is now refused by `ValidBindingHost`, and the other 399 hosts work end to end.
  - Resolver oracle (seed 1): 1,340 names answered locally, 0 bypasses.
- **Note:** for several minutes, the auto-mode classifier gave no verdict on any Bash call (seven in a row). Nothing ran until it recovered, and every result above comes from runs made after it recovered.

### The mutation set, re-run against the fixed `policy.go`

There are 103 mutants: the original 89 plus 14 new ones.
- **Adapted:** M26, M32 and M35 target code the fix changed. M32 is now "only `localhost` is denied bare" (the brief's old rule), and M35 is now "bare entries are not denied".
- **New:** N01–N14 remove or weaken each fix.

| Test set | Killed | Survived |
|---|---|---|
| Brief's tests alone | 48 | 55 |
| Brief's tests plus the pins | 92 | 11 |

Every removal or weakening of a fix is killed:
- **C1:** M32, M35, and N01 (bare match only for multi-label entries).
- **C2:** N02 (no ASCII check) and N03 (the ASCII check after lower-casing).
- **C3:** N05 (no canonical-port check), N06 (leading zeros allowed), N07 (a plus sign allowed) and N09 (four digits at most).
- **C4:** N11 (no bracket check), N12 (the bracket check before the IP-literal check), N13 (bracket check only when a port follows) and N14 (bracket check on the unbracketed host).

All 11 survivors are equivalent. Each gave **0 differing rows** against the fixed code over the same 300,000 inputs (`fixdiff.py`). The inputs included Latin-1 letters, an invalid byte, U+0130, U+212A, and the port spellings `:`, `:0`, `:100000`, `:065535`, `:99999`, `:+0`, `:-0`, `:0x1bb`, `:0443` and `:+443`.
- **M62, M77 and M80:** equivalent, as before.
- **Made redundant by the fixes:**
  - M24 (hex ports): any non-digit port text is now refused before parsing.
  - M63 (non-ASCII allowed in `validName`): C2 refuses non-ASCII first, so `validName`'s byte rule is now defence in depth.
  - M73, M74 and M75: the old C2, C3 and C4 probes, now implemented.
- **Unreachable by construction:**
  - N04 (Latin-1 allowed by the ASCII check): no code point at or below U+00FF lower-cases to ASCII, and `validName` refuses what is left.
  - N08 (six digits allowed): any six-digit port without a leading zero is over 65535.
  - N10 (empty port text allowed): `strconv.Atoi("")` fails.

Artifacts for this section, all in `scratchpad/t8-policy/`:
- RED and GREEN: `fix-red.txt` and `fix-green.txt`.
- Mutation: `mutants-fixed.json`, `mutants-fixed-run.txt` and `mutants-fixed-result.json`.
- Differential check: `fixdiff.py` and `fixdiff-*.txt`.
- Repo checks: `fix-verify.txt`, `fix-lint.txt` and `fix-hygiene.txt`.
