# localDot Core — Part 4a: keyd Core (M3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `keyd`, localDot's key layer, as a standalone Go module under `keyd/`: the vault, the
surrogate registry, one token-guarded listener per cell, selective TLS interception with a per-cell
name-constrained CA, the SNI = Host checks, the dial-time SSRF guard, the header swap (Basic auth
included), response scrubbing, the unknown-surrogate block, the egress policy, the LLM gateway,
budgets, the hash-chained audit log and the admin socket — all built and tested on the host with
`go test`, with no Docker and no TypeScript.

**Architecture:** keyd is one Go process (`cmd/keyd`) that keeps its state in `<home>/keyd` (0700)
and answers the daemon over HTTP on a 0600 Unix socket. Secret values live only in the macOS
Keychain (through `/usr/bin/security`, values on its stdin in chunks that fit its line) and in
keyd's memory; the daemon relays them sealed to keyd's per-boot ECDH key and bound to their
binding, so it never holds plaintext. For each cell keyd opens an
explicit HTTP proxy on `127.0.0.1:<4760–4789>` that requires the cell's token as Basic proxy
credentials. `goproxy` is the listener's CONNECT front door; keyd hijacks every tunnel it accepts:
hosts a cell's surrogates are bound to are terminated with the cell's own CA (an in-memory EC key
whose X.509 name constraints permit only those hosts), every other allowed host passes through
untouched after its ClientHello's SNI is checked against the CONNECT host. Every request keyd can
see — plain `http://`, the requests inside an intercepted tunnel, and the LLM gateway at
`http://llm.ldot/<route>/…` — is served by `net/http`, inspected for surrogate-shaped tokens
(each must be this cell's, bound to this destination and sit exactly in its bound header), swapped,
and relayed by `httputil.ReverseProxy` over a transport whose dials go through the guard (keyd
resolves, checks every answer, dials the checked address with `net.Dialer.Control` checking again,
and checks the connected peer) and whose upstream TLS is verified; the response is scrubbed of the
real values in every common encoding as it streams back, and one hash-chained JSON line per
decision goes to `<home>/keyd/audit.jsonl`, with `key.use` events fanned out to the daemon.

**Tech Stack:** Go 1.27.1 (`/opt/homebrew/bin/go`; `go 1.27` and `toolchain go1.27.1` in
`go.mod`); `github.com/elazarl/goproxy` v1.9.2 (BSD-3-Clause), which brings `golang.org/x/net`
v0.50.0 and `golang.org/x/text` v0.34.0 (both BSD-3-Clause) — the module's only dependencies; the
standard library for everything else (`crypto/ecdh`, `crypto/hkdf`, `crypto/x509`, `net/netip`,
`net/http/httputil`); macOS `/usr/bin/security` for the Keychain. One
function (the SNI peek) is adapted from iron-proxy v0.52.0 (Apache-2.0); its license travels with
it.

**Spec:** `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/specs/2026-09-30-localdot-core-design.md`
(the authority: "Trust rules", "Key layer (keyd)", "Providers and sign-in", "Safety and control",
"Testing", "Repository", "Milestones" M3). Research: `…/docs/superpowers/research/2026-09-30-localdot/security-key-layer.md`
§3. Decisions and evidence, read from `main`: `localdot/docs/spikes/SUMMARY.md` D4–D7 and A21–A27,
`localdot/spikes/s4-keyd/FINDINGS.md` (the keyd requirements and the probes ported in Task 17),
`localdot/spikes/s3-network/FINDINGS.md`, `localdot/spikes/s5-models/FINDINGS.md` (gateway inputs).
Carry-forward: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-09-30-localdot-core-part1-carry-forward.md`
("Part 3 (keyd) design inputs from S4" and "from S5"). Neighbours, for interfaces only: Part 2
(`LD_KEYD_PORT`, `apps/daemon/src/cells/ports.ts` `allocateKeydPort` in 4760–4789, the gate relay
`internal:3128 → host.docker.internal:<keyd port>`) and Part 3 ("Interfaces Part 4 builds on").

**This is Part 4a of the core plan.** Part 1 is on `main` at `992e82d`; Parts 2 and 3 are on their
own branches. This plan runs in parallel from `main`, in its own worktree, and builds only the Go
module and its CI job. Part 4b — written later, from "Interfaces Part 4b builds on" at the end —
wires keyd into the daemon and the cells: the admin client, the cells' proxy settings and CA
install, `desktopd`'s `/selftest` and the readiness gate, the key form, `key.use` in the event log,
Stop (revoking the cells and pausing their processes), the canary test and the S4 probes from a
real cell. This revision applies review 1 (`…/2026-10-01-localdot-core-handoff/part4a-review-1.md`)
under the controller's rulings P4a-C1 to P4a-C4, then review 2 (`part4a-review-2.md`) under ruling
P4a-C5 and review 3 (`part4a-review-3.md`) under ruling P4a-C7; the change logs are
`part4a-revision-log-1.md` to `part4a-revision-log-3.md` next to them.

## Global Constraints

- Worktree: `/Volumes/Husky's SSD 4T/Projects/localdot-keyd`, branch `feat/core-part4a`, created
  from `main` in Task 1. Never commit on `main`, and never edit, stage or check out anything in
  `/Volumes/Husky's SSD 4T/Projects/localdot` (Part 2 is working there). Quote every path (space
  and apostrophe). Go commands run from `"/Volumes/Husky's SSD 4T/Projects/localdot-keyd/keyd"`.
- Commit messages: conventional `type(scope): summary`. **Never add `Co-Authored-By` or any AI
  attribution line** (user rule; overrides any harness default).
- Shared files are touched only here, minimally, because they will be merged with other branches:
  `.github/workflows/ci.yml` (a new `keyd` job appended, Task 1), `.gitignore` (one line, Task 1),
  `README.md` (one short section, Task 17). Nothing under `apps/`, `cells/`, `packages/`,
  `spikes/` or `scripts/` changes; `scripts/check-hygiene.mjs` already scans every file git tracks,
  Go included, so it needs no change.
- Ports, all bound to `127.0.0.1` only: keyd listeners `4760–4789` (keyd refuses others unless
  `-ports` says so); spikes and e2e harnesses `4790–4799`; the daemon's `4750` and the brain's
  `4751` are not keyd's. Tests never use a fixed port: they ask for port 0.
- Secrets: never a real one, anywhere. Tests use obviously fake values (`real-secret-value-for-test`,
  `real-secret-value-for-spike`, `fake-key-from-webcrypto`) that match none of `pnpm hygiene`'s
  patterns (no `sk-…`, `AIza…`, `gh?_…`, `xox?-…`, bot tokens or PEM private-key headers). The one
  test that touches the login keychain is opt-in (`KEYD_KEYCHAIN_TEST=1`), uses the service
  `localdot-keyd-test` and deletes its fake item. No test reaches the network: upstreams are
  loopback `httptest` servers reached by name through a fake resolver, with exact guard exceptions
  for their ports.
- keyd never logs, audits or returns a secret value, and returns a surrogate only in the admin reply
  that hands it to its cell; audit lines name a surrogate by `surrogate.ID` (12 hex characters of
  its SHA-256), and write any surrogate-shaped text a request carried as `surrogate:<ID>`. No error
  carries a value or the Keychain tool's output. Everything unknown, unparsable or unverifiable is
  refused and audited (fail closed); while the audit log cannot be written, no secret is swapped.
- No [avatar-name]/[avatar-name]/[avatar-name] names or assets anywhere (`pnpm hygiene` enforces it). The GitHub
  repo stays private; nothing in this plan pushes.
- Go: module `github.com/shadowhusky/localdot/keyd`, `go 1.27` with `toolchain go1.27.1`, every
  dependency pinned to an exact version in `go.mod` and `go.sum`; packages under `internal/`, one
  command under `cmd/keyd`; small focused files; errors wrapped with `%w` where a caller inspects
  them; comments only for non-obvious rules, workarounds and provenance (the Apache-2.0 notice on
  `sni.go` is required). Before every commit: `gofmt -l .` prints nothing and `go vet ./...` is
  clean.
- Tests: run only the package a task touches (`go test ./internal/<pkg>/`); `go test -race ./...`,
  `GOOS=darwin go vet ./...` and `GOOS=linux go vet ./...` before the final review. Tests that open
  a Unix socket keep their home under `/tmp` (macOS limits socket paths to 104 bytes;
  `t.TempDir()` is too deep).

## Review Focus

The inputs most likely to leak a real secret or slip past a guard, each pinned by tests in the task
that owns the code:

1. **A real value coming back.** An upstream echoes the swapped key: in the body, split across
   writes one byte at a time, inside a gzip body, behind a second `Content-Encoding` line, or gzipped
   twice behind `gzip` then `gzip` or `br` (which Go's transport would have half-decoded), as
   base64 of `user:secret`, hex, percent-encoded by Go's, JavaScript's or Python's rules in either
   case, JSON-escaped (Go's backslash-u for `<`, `>` and `&`; .NET's for `+`, `'` and `"`),
   HTML-escaped (`&amp;`, `&#39;`), in a redirect's `Location`, a `Set-Cookie`, a trailer, or a
   `103 Early Hints` header. The cell must see the surrogate or nothing. Tests: Task 7
   (`TestEveryEncodingOfTheSecretIsReplaced`, `TestEscapedReflectionsAreReplaced`,
   `TestEscapedReflectionsStreamLikeOneShot`, `TestBase64EmbeddedAtAnyOffsetIsDestroyed`,
   `TestStreamingMatchesOneShotAtEverySplit`, `TestReadNeverReturnsPartOfTheSecret`,
   `TestAnUpstreamErrorDropsTheHeldBytes`), Task 10 (`TestAnUnrequestedEncodingIsRefused`), Task 12
   (`TestReflectionsInEveryFormAreScrubbed`, `TestInformationalResponseHeadersAreScrubbed`,
   `TestBasicAuthIsSwappedInsideTheEncoding`), Task 14 (`TestAStreamedAnswerIsMeteredAndScrubbed`).
2. **A surrogate where it is not bound.** Unknown, forged (bad checksum), revoked, another cell's,
   for another host or route, in another header, as a substring or glued to other characters, twice,
   in the URL's path, query (raw, percent-encoded, or behind an invalid escape) or host name, in an
   intercepted request's `Host` header, over plain `http://` to its own host, on the CONNECT request
   itself. Each is refused with 403 and a `key.use` deny event, the upstream is never reached, and
   the audit line and the event name it by ID. Tests: Task 1 (`TestFindSeesTokensGluedToOtherCharacters`),
   Task 5 (`TestSurrogatesAreWrittenAsTheirIDs`), Task 9 (`TestInspect`), Task 10
   (`TestSurrogatesNeverTravelOverPlainHTTP`, `TestAnUnknownSurrogateIsBlockedAndAlerted`,
   `TestSurrogateTextNeverReachesTheAuditOrTheEvents`), Task 11 (`TestASurrogateOnTheConnectItselfIsRefused`),
   Task 12 (`TestMisplacedAndUnknownSurrogatesNeverReachTheUpstream`,
   `TestASurrogateInTheHostHeaderIsRefusedAndAlerted`), Task 17 (`TestS4Probes`).
3. **A binding's path or method limit, sidestepped.** A secret limited to `GET` and `/v1/` sent to
   `/v1/../admin`, `/v1/%2e%2e/admin` or `/v1/%2E%2E/admin`, `/v1%2f..%2fadmin`, `/v1//admin`,
   `/v1/..;/admin`, through backslashes, `%252e` or a NUL, to `/v1-admin` under a `/v1` prefix, to
   `/v1` itself under `/v1/`, or with `X-HTTP-Method-Override` or `_method` in the query. Servers read
   these as other paths or methods; keyd refuses them as `surrogate-policy`, and the upstream never
   sees the real value. A `_method` in a form body is not seen (P4a-R8). Tests: Task 9
   (`TestInspect`, `TestHTTPRecords`), Task 12 (`TestPathAndMethodLimitsHoldOnTheWire`).
4. **A name that resolves where it must not go.** DNS rebinding between two lookups, a mixed
   public/private answer, loopback by name, the Mac's own (rotating, temporary) IPv6 addresses, a
   LAN neighbour inside a directly connected prefix, Docker Desktop's 192.168.65.254, metadata
   addresses, IPv4-mapped, NAT64 and 6to4 forms, `0.0.0.0` and `::`, and a redirect to any of them.
   Tests: Task 4 (all), Task 10 (`TestPlainHTTPPolicy`, `TestRedirectsAreReturnedAndEachHopIsCheckedAgain`),
   Task 11 (`TestAPassthroughToAPrivateAddressIsRefusedAtDial`), Task 12
   (`TestABoundHostResolvingToAPrivateAddressIsRefused`), Task 17 (`TestS4Probes`).
5. **An IP literal anywhere.** `CONNECT 127.0.0.1:443`, `[::1]:443`, `[::ffff:127.0.0.1]:443`,
   `169.254.169.254:443`, `http://[::ffff:127.0.0.1]/`, and the decimal, short and hex forms
   (`2130706433`, `127.1`, `0x7f.0x1`) that some resolvers, macOS's among them, turn into loopback.
   Refused by name policy before any dial: a name must end in letters or `xn--`. Tests: Task 8
   (`TestParseHostPortRefusesWhatPolicyCannotName`, `TestValidBindingHost`), Task 10
   (`TestPlainHTTPPolicy`), Task 11 (`TestConnectPolicy`).
6. **A TLS conversation that does not match its CONNECT.** An SNI that names another host or none,
   plain HTTP inside a tunnel, and inside an intercepted tunnel a `Host`, an absolute URL or a port
   other than the tunnel's. Refused and audited; no upstream is reached. Tests: Task 11
   (`TestSNIMustMatchTheConnectHost`, `TestATunnelMustCarryTLS`), Task 12
   (`TestTheInnerHostMustMatchTheTunnel`, `TestAnInterceptedHandshakeChecksSNIAndRecordsAborts`).
7. **A request without the cell's token.** Any container on the Mac with egress reaches
   `127.0.0.1` listeners through `host.docker.internal`: no token, a wrong or truncated one, a CONNECT
   without one, and a flood of them. 407 every time, and at most one audit line a second. Tests:
   Task 10 (`TestRequestsWithoutTheTokenAreRefused`, `TestAuthFailuresAreAuditedAtMostOncePerSecond`).
8. **The real value leaving any way but verified TLS to its host.** An upstream whose certificate
   does not verify, plain HTTP, and `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` set in keyd's
   environment. Tests: Task 12 (`TestTheSecretOnlyLeavesOverVerifiedTLS`), Task 10
   (`TestSurrogatesNeverTravelOverPlainHTTP`), Task 11 (`TestKeydNeverDialsThroughAnotherProxy`).
9. **Gateway abuse with a valid surrogate.** An unlisted operation or dot segments in the path, an
   unlisted model, the model named twice or in another letter case, no running task, a spent budget,
   an oversized body, more than one answer (`n`, `best_of`, `candidateCount`, or a `prompt` list on
   the completions API): refused before the provider is reached. An output cap that is missing,
   null, zero, a string, a fraction, too large, or in a field the provider does not read: keyd
   writes its own cap in the provider's field. Twenty requests at once against a $5 task, or from
   five cells against a $20 day, in each of those shapes: together they never spend past either
   limit. Five screenshots in context: priced by the provider's image rule, not as base64 text, so
   the task runs to its last dollar; an image whose data is invalid UTF-8 still holds its output.
   A refusal publishes `budget.exceeded`. A secret replaced while a request waits, and Stop while
   its body uploads: the provider never sees the request. A provider failing mid-stream ends the
   cell's stream with an error and is charged the most it can have cost, a cell that hangs up stops
   the provider, and one that hangs up before the answer's headers is charged its hold. Tests:
   Task 9 (`TestEachOperationNamesItsOutputCap`), Task 13 (`TestModelFromJSON`, `TestReadRequest`,
   `TestWithCap`, `TestImagesArePricedByTheProvidersRule`, `TestAMalformedImageCannotMakeAHoldNegative`,
   `TestMeterReadsEachProvidersUsage`, `TestHoldsKeepRequestsSideBySideWithinTheTaskLimit`,
   `TestParallelReservationsNeverOvershoot`, `TestTheDayHoldsAcrossCells`,
   `TestTheCapIsLoweredToTheRoomLeft`), Task 14 (`TestTheGatewayRefuses`, `TestBudgetsRefuseOnceReached`,
   `TestParallelRequestsCannotOvershootTheTask`, `TestParallelRequestsFromManyCellsCannotOvershootTheDay`,
   `TestNoRequestShapeOvershootsTheBudget`, `TestTheGatewayWritesTheCapInTheProvidersField`,
   `TestScreenshotsDoNotStopATaskEarly`, `TestABudgetRefusalIsAnnounced`, `TestCountingTokensNeverWaits`,
   `TestASecretReplacedWhileARequestWaitsIsNotSent`, `TestARequestInspectedBeforeStopNeverReachesTheProvider`,
   `TestACutStreamIsChargedTheMostItCanHaveCost`, `TestAnAnswerWithoutUsageIsChargedItsHold`,
   `TestAClientDisconnectStopsTheProvider`, `TestACellThatLeavesBeforeTheAnswerIsChargedItsHold`),
   Task 15 (`TestRevokeIsTheKillSwitch`).
10. **The vault or the audit log failing.** A value too long for one `security -i` line (the tool
    runs the rest as a command and prints it back), a tool that echoes what it was given, a value
    torn by a crash between two writes; an audit write that fails part-way. A value reads back whole
    or as an error, never as a fragment, and no error carries a byte of it; a failed audit write is
    cut off, `/v1/status` says so, and no secret is swapped until the log works again. Tests: Task 2
    (`TestKeychainKeepsLongValuesWhole`, `TestKeychainErrorsNeverCarryTheValue`, and the opt-in
    `TestKeychainAgainstTheLoginKeychain` with an 8,192-byte value), Task 5
    (`TestAFailedWriteIsCutOffReportedAndCleared`), Task 12 (`TestSwapsStopWhileTheAuditLogCannotBeWritten`),
    Task 16 (`TestStatus`).

## File map

Created in this part (paths relative to the worktree root):

```
keyd/go.mod, keyd/go.sum, keyd/THIRD-PARTY.md, keyd/third_party/iron-proxy/LICENSE
keyd/cmd/keyd/{main.go,main_test.go}
keyd/internal/surrogate/{surrogate.go,surrogate_test.go}
keyd/internal/vault/{store.go,keychain.go,vault.go,seal.go,vault_test.go,keychain_test.go,seal_test.go}
keyd/internal/netguard/{guard.go,dialer.go,guard_test.go,dialer_test.go}
keyd/internal/audit/{audit.go,audit_test.go}
keyd/internal/events/{events.go,events_test.go}
keyd/internal/cellca/{cellca.go,cellca_test.go}
keyd/internal/scrub/{scrub.go,scrub_test.go}
keyd/internal/policy/{policy.go,policy_test.go}
keyd/internal/keys/{binding.go,registry.go,inspect.go,binding_test.go,inspect_test.go}
keyd/internal/llm/{usage.go,budget.go,settings.go,request.go,images.go,usage_test.go,budget_test.go,request_test.go,images_test.go}
keyd/internal/egress/{deps.go,generation.go,cell.go,internal.go,sni.go,connect.go,forward.go,mitm.go,gateway.go,manager.go}
keyd/internal/egress/{harness_test.go,cell_test.go,connect_test.go,mitm_test.go,gateway_test.go,manager_test.go,s4_probes_test.go}
keyd/internal/admin/{admin.go,admin_test.go}
.github/workflows/ci.yml, .gitignore, README.md   (modified)
```

| Package | Job |
|---|---|
| `surrogate` | the token format: mint, validate, find in text, name by ID |
| `vault` | secret records, the Keychain and in-memory stores, the metadata index, sealed intake |
| `netguard` | the deny set (static ranges, the Mac's own addresses and networks) and the guarded dialer |
| `audit`, `events` | the hash-chained decision log and the event fan-out to the daemon |
| `cellca` | the per-cell name-constrained CA and its leaves |
| `scrub` | removing real values from headers and streamed bodies |
| `policy` | egress by role, port and name; host-name validation |
| `keys` | bindings (with the LLM presets), the surrogate registry, request inspection and the swap |
| `llm` | usage metering, prices, budgets, the model allowlist, what a request can cost and its output cap |
| `egress` | the per-cell listener: front door, passthrough, interception, forwarding, gateway, kill switch, the cell manager |
| `admin` | the control API on the Unix socket |
| `cmd/keyd` | flags, the state folder, the lock, wiring, signals, `verify-audit` |

---
### Task 1: The worktree, the Go module, the surrogate format and the CI job

A surrogate is the only thing a cell holds in place of a key, so its format comes first:
`ld_<tag>_<22 base62 characters>_<6 base62 characters>`, 131 random bits and a CRC32 checksum, the
shape the spec and the research (§3.4) give. `Find` must see a token wherever it sits in a header or
URL, even glued to other characters, because a surrogate made part of a longer word is still a
misplaced one (Review Focus 2).

**Files:**
- Create: `keyd/go.mod`, `keyd/internal/surrogate/surrogate.go`
- Modify: `.github/workflows/ci.yml` (append the `keyd` job), `.gitignore` (one line)
- Test: `keyd/internal/surrogate/surrogate_test.go`

**Interfaces:**
- Produces: package `github.com/shadowhusky/localdot/keyd/internal/surrogate` with
  `Mint(tag string) (string, error)` (tag `^[a-z0-9]{2,12}$`), `Valid(s string) bool` (exact shape
  and checksum), `Find(s string) []string` (every token-shaped substring, checksum or not, in
  order), `ID(token string) string` (12 lowercase hex characters of SHA-256).

- [ ] **Step 1: Create the worktree and the module**

```bash
git -C "/Volumes/Husky's SSD 4T/Projects/localdot" worktree add -b feat/core-part4a "/Volumes/Husky's SSD 4T/Projects/localdot-keyd" main
cd "/Volumes/Husky's SSD 4T/Projects/localdot-keyd" && git branch --show-current && go version
```
Expected: `feat/core-part4a` and `go version go1.27.1 darwin/arm64`.

`keyd/go.mod`:
```text
module github.com/shadowhusky/localdot/keyd

go 1.27

toolchain go1.27.1
```

- [ ] **Step 2: Write the failing tests**

`keyd/internal/surrogate/surrogate_test.go`:
```go
package surrogate

import (
	"regexp"
	"strings"
	"testing"
)

var shape = regexp.MustCompile(`^ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$`)

func TestMintShapeAndChecksum(t *testing.T) {
	tok, err := Mint("ant")
	if err != nil {
		t.Fatal(err)
	}
	if !shape.MatchString(tok) {
		t.Fatalf("token %q does not have the surrogate shape", tok)
	}
	if !strings.HasPrefix(tok, "ld_ant_") {
		t.Fatalf("token %q lacks its tag", tok)
	}
	if !Valid(tok) {
		t.Fatalf("minted token %q is not valid", tok)
	}
}

func TestMintRejectsBadTags(t *testing.T) {
	for _, tag := range []string{"", "a", "ANT", "an_t", "abcdefghijklm", "an-t"} {
		if _, err := Mint(tag); err == nil {
			t.Errorf("Mint(%q) succeeded, want an error", tag)
		}
	}
}

func TestMintIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 2000 {
		tok, err := Mint("key")
		if err != nil {
			t.Fatal(err)
		}
		if seen[tok] {
			t.Fatalf("duplicate token %q", tok)
		}
		seen[tok] = true
	}
}

func TestValidRejectsTampering(t *testing.T) {
	tok, _ := Mint("oai")
	body := []byte(tok)
	i := len("ld_oai_") + 3
	if body[i] == 'a' {
		body[i] = 'b'
	} else {
		body[i] = 'a'
	}
	if Valid(string(body)) {
		t.Fatalf("tampered token %q still validates", body)
	}
	for _, s := range []string{"", "ld_oai_short_abcdef", tok + "x", " " + tok} {
		if Valid(s) {
			t.Errorf("Valid(%q) = true", s)
		}
	}
}

func TestFindLocatesTokensInText(t *testing.T) {
	a, _ := Mint("ant")
	b, _ := Mint("key")
	text := "Bearer " + a + ", x-key=" + b + "&q=1 \"" + a + "\""
	got := Find(text)
	want := []string{a, b, a}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("Find = %v, want %v", got, want)
	}
}

func TestFindReportsShapeEvenWithBadChecksum(t *testing.T) {
	forged := "ld_key_" + strings.Repeat("A", 22) + "_AAAAAA"
	if Valid(forged) {
		t.Fatal("forged token validates")
	}
	if got := Find("token=" + forged); len(got) != 1 || got[0] != forged {
		t.Fatalf("Find = %v, want the forged token", got)
	}
}

func TestFindSeesTokensGluedToOtherCharacters(t *testing.T) {
	tok, _ := Mint("ant")
	for _, s := range []string{"x" + tok, tok + "x", tok + "_x", "0" + tok, "Bearer " + tok + "x y"} {
		if got := Find(s); len(got) != 1 || got[0] != tok {
			t.Errorf("Find(%q) = %v, want the token", s, got)
		}
	}
	if got := Find("old_value_x ld_ant_short_abcdef"); len(got) != 0 {
		t.Errorf("Find found %v in text without a token", got)
	}
}

func TestIDIsStableAndHidesTheToken(t *testing.T) {
	tok, _ := Mint("gem")
	id := ID(tok)
	if id != ID(tok) {
		t.Fatal("ID is not stable")
	}
	if len(id) != 12 || strings.Contains(tok, id) {
		t.Fatalf("ID(%q) = %q, want 12 hex chars not taken from the token", tok, id)
	}
	other, _ := Mint("gem")
	if ID(other) == id {
		t.Fatal("two tokens share an ID")
	}
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd "/Volumes/Husky's SSD 4T/Projects/localdot-keyd/keyd" && go test ./internal/surrogate/`
Expected: FAIL — `[build failed]`, starting `internal/surrogate/surrogate_test.go:12:14: undefined: Mint`.

- [ ] **Step 4: Implement the format**

`keyd/internal/surrogate/surrogate.go`:
```go
// Package surrogate mints and recognises keyd's surrogate tokens,
// ld_<tag>_<22 base62 random characters>_<6 base62 checksum characters>.
package surrogate

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash/crc32"
	"regexp"
)

const (
	alphabet    = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	randomLen   = 22
	checksumLen = 6
)

var (
	tagPattern   = regexp.MustCompile(`^[a-z0-9]{2,12}$`)
	tokenPattern = regexp.MustCompile(`ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}`)
	exactPattern = regexp.MustCompile(`^ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$`)
)

// Mint returns a fresh token carrying 131 bits of randomness.
func Mint(tag string) (string, error) {
	if !tagPattern.MatchString(tag) {
		return "", fmt.Errorf("surrogate tag %q: want 2-12 lowercase letters or digits", tag)
	}
	random := make([]byte, 0, randomLen)
	var buf [32]byte
	for len(random) < randomLen {
		if _, err := rand.Read(buf[:]); err != nil {
			return "", err
		}
		for _, b := range buf {
			// 248 = 4 * 62: rejecting the rest keeps every character equally likely.
			if b < 248 && len(random) < randomLen {
				random = append(random, alphabet[b%62])
			}
		}
	}
	body := "ld_" + tag + "_" + string(random)
	return body + "_" + checksum(body), nil
}

// Valid reports whether s is exactly one token with a correct checksum.
func Valid(s string) bool {
	if !exactPattern.MatchString(s) {
		return false
	}
	cut := len(s) - checksumLen - 1
	return checksum(s[:cut]) == s[cut+1:]
}

// Find returns every token-shaped string in s, checksum or not, in order, even when it is glued
// to other characters: a surrogate made part of a longer word is still a misplaced surrogate.
func Find(s string) []string {
	return tokenPattern.FindAllString(s, -1)
}

// ID names a token in logs without revealing it.
func ID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:6])
}

func checksum(body string) string {
	n := crc32.ChecksumIEEE([]byte(body))
	out := make([]byte, checksumLen)
	for i := checksumLen - 1; i >= 0; i-- {
		out[i] = alphabet[n%62]
		n /= 62
	}
	return string(out)
}
```

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/surrogate/`
Expected: `ok  github.com/shadowhusky/localdot/keyd/internal/surrogate` (8 tests).

- [ ] **Step 6: The CI job and the ignore line**

Append to `.github/workflows/ci.yml`, after the `check` job (same indentation as `check:`):
```yaml
  keyd:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: keyd
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: keyd/go.mod
          cache: false
      - run: test -z "$(gofmt -l .)"
      - run: go vet ./...
      - run: GOOS=darwin go vet ./...
      - run: go test -race ./...
```
keyd's tests use fakes for everything macOS-specific (the opt-in Keychain test skips elsewhere),
so they run on the Linux runner; `GOOS=darwin go vet` type-checks the macOS build. The job needs no
dependency cache: the module has three small dependencies.

Append to `.gitignore`:
```
keyd/bin/
```

- [ ] **Step 7: Format, vet, commit**

```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot-keyd/keyd" && test -z "$(gofmt -l .)" && go vet ./...
cd .. && git add keyd/go.mod keyd/internal/surrogate .github/workflows/ci.yml .gitignore
git commit -m "feat(keyd): Go module, surrogate token format and the CI job"
```

---
### Task 2: The vault — secret records, the Keychain and in-memory stores

The spec puts real secrets in "macOS Keychain items owned by keyd" and nowhere else. The vault
keeps each value in a `Store` — the login keychain in production, memory in tests — and the
secret's metadata (kind, provider, the hosts and header it is bound to) in an index file that never
holds a value. The Keychain store drives `/usr/bin/security`: values travel hex-encoded on its
stdin (`security -i`), never on its command line, where any process could read them (P4a-R3).
`security -i` runs only the first 4,095 characters of a line as one command and the rest as another,
which it prints in its error (review 1, C1). So a value goes in chunks of 1,536 bytes, one item
each (`<id>.0`, `<id>.1`, …), and the item `<id>` names their count and the write that made them,
so a read never mixes two writes; every write is read back, and an error names only the operation,
the item and the exit status, never what the tool printed. A fake `security` script that splits long
lines as the real one does pins that, and one opt-in test stores an 8,192-byte value in the real
login keychain.

**Files:**
- Create: `keyd/internal/vault/store.go`, `keyd/internal/vault/keychain.go`, `keyd/internal/vault/vault.go`
- Test: `keyd/internal/vault/vault_test.go`, `keyd/internal/vault/keychain_test.go`

**Interfaces:**
- Produces: `Store interface { Put(id string, value []byte) error; Get(id string) ([]byte, error); Delete(id string) error }`,
  `ErrNotFound`, `NewMemory() *Memory`, `NewKeychain(service string) *Keychain` (fields `Service`,
  `Path`; items `<id>` = `keyd:<write id>:<chunks>` and `<id>.<n>` = `<write id>:<hex>`, every
  write read back, errors without the tool's output); `Kind` (`KindLLM = "llm"`, `KindHTTP = "http"`);
  `Record{ID, Kind, Provider, BaseURL, Hosts, Header, Format, Methods, Paths, CreatedAt, UpdatedAt}`
  (JSON `id kind provider baseURL hosts header format methods paths createdAt updatedAt`);
  `ValidID(id string) bool` (`^[a-z0-9][a-z0-9_-]{0,63}$`, not `lmstudio` or `ollama`);
  `ValidValue(value []byte) error` (8–8192 bytes of printable ASCII, no leading or trailing
  space); `Open(store Store, indexPath string) (*Vault, error)` (empty path: index in memory);
  `(*Vault).Put(rec Record, value []byte) error`, `Delete(id) error`, `Record(id) (Record, bool)`,
  `Records() []Record` (sorted by id), `Value(id) ([]byte, error)` (reads the store once, then
  caches).

- [ ] **Step 1: Write the failing tests**

`keyd/internal/vault/vault_test.go`:
```go
package vault

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var fakeValue = []byte("real-secret-value-for-test")

func openTemp(t *testing.T, store Store) (*Vault, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "secrets.json")
	v, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	return v, path
}

func httpRecord(id string) Record {
	return Record{ID: id, Kind: KindHTTP, Hosts: []string{"api.example.test"}, Header: "X-Api-Key", Format: "raw"}
}

func TestPutStoresValueAndIndexWithoutTheValue(t *testing.T) {
	store := NewMemory()
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	got, err := v.Value("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value = %q, %v", got, err)
	}
	stored, _ := store.Get("weather")
	if !bytes.Equal(stored, fakeValue) {
		t.Fatalf("store holds %q", stored)
	}
	index, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(index, fakeValue) {
		t.Fatal("the index file contains the secret value")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("index mode %v, want 0600", info.Mode().Perm())
	}
	rec, ok := v.Record("weather")
	if !ok || rec.CreatedAt.IsZero() || rec.Hosts[0] != "api.example.test" {
		t.Fatalf("Record = %+v, %v", rec, ok)
	}
}

func TestOpenReloadsTheIndex(t *testing.T) {
	store := NewMemory()
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	again, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	if recs := again.Records(); len(recs) != 1 || recs[0].ID != "weather" {
		t.Fatalf("Records = %+v", recs)
	}
	got, err := again.Value("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value after reopen = %q, %v", got, err)
	}
}

func TestPutRejectsBadIDsAndValues(t *testing.T) {
	v, _ := openTemp(t, NewMemory())
	for _, id := range []string{"", "Weather", "-x", "a b", strings.Repeat("a", 65), "lmstudio", "ollama"} {
		if err := v.Put(httpRecord(id), fakeValue); err == nil {
			t.Errorf("Put id %q succeeded", id)
		}
	}
	bad := [][]byte{
		nil,
		[]byte("short"),
		[]byte("has\nnewline-value"),
		[]byte(" leading-space-value"),
		[]byte("trailing-space-value "),
		[]byte("non-ascii-värde-value"),
		bytes.Repeat([]byte("a"), 8193),
	}
	for _, value := range bad {
		if err := v.Put(httpRecord("weather"), value); err == nil {
			t.Errorf("Put value %q succeeded", value)
		}
	}
	if _, ok := v.Record("weather"); ok {
		t.Fatal("a rejected Put left a record")
	}
}

func TestDeleteRemovesValueAndRecord(t *testing.T) {
	store := NewMemory()
	v, _ := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	if err := v.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Value("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Value after delete: %v", err)
	}
	if _, err := store.Get("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("store after delete: %v", err)
	}
	if err := v.Delete("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Delete: %v", err)
	}
}

func TestValueReadsTheStoreOnceThenCaches(t *testing.T) {
	store := &countingStore{Store: NewMemory()}
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	again, _ := Open(store, path)
	for range 3 {
		if _, err := again.Value("weather"); err != nil {
			t.Fatal(err)
		}
	}
	if store.gets != 1 {
		t.Fatalf("store read %d times, want 1", store.gets)
	}
}

func TestPutKeepsCreatedAtOnUpdate(t *testing.T) {
	v, _ := openTemp(t, NewMemory())
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	first, _ := v.Record("weather")
	time.Sleep(2 * time.Millisecond)
	if err := v.Put(httpRecord("weather"), []byte("second-fake-value-for-test")); err != nil {
		t.Fatal(err)
	}
	second, _ := v.Record("weather")
	if !second.CreatedAt.Equal(first.CreatedAt) || !second.UpdatedAt.After(first.UpdatedAt) {
		t.Fatalf("times: first %+v second %+v", first, second)
	}
	got, _ := v.Value("weather")
	if string(got) != "second-fake-value-for-test" {
		t.Fatalf("Value = %q", got)
	}
}

func TestAnEmptyIndexPathKeepsEverythingInMemory(t *testing.T) {
	v, err := Open(NewMemory(), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	if got, err := v.Value("weather"); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value = %q, %v", got, err)
	}
	if err := v.Delete("weather"); err != nil {
		t.Fatal(err)
	}
}

type countingStore struct {
	Store
	gets int
}

func (c *countingStore) Get(id string) ([]byte, error) {
	c.gets++
	return c.Store.Get(id)
}
```

`keyd/internal/vault/keychain_test.go`:
```go
package vault

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeSecurity mimics the /usr/bin/security calls Keychain makes, keeping items as files. Like the
// real tool, security -i runs the first 4,095 characters of a line as one command and the rest as
// another, names an unknown command in its error, and exits with the last command's status.
// FAKE_FAIL=add makes every add fail after printing what it was given.
const fakeSecurity = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/argv.log"
store="$FAKE_DIR/store"
mkdir -p "$store"
run() {
  cmd=$1
  shift
  svc= acct= pw=
  while [ $# -gt 0 ]; do
    case "$1" in
      -s) svc=$2; shift 2 ;;
      -a) acct=$2; shift 2 ;;
      -w) if [ $# -ge 2 ]; then pw=$2; shift 2; else shift; fi ;;
      -l) shift 2 ;;
      *) shift ;;
    esac
  done
  item="$store/$svc.$acct"
  case "$cmd" in
    add-generic-password)
      if [ "$FAKE_FAIL" = add ]; then echo "add-generic-password: cannot store $pw" >&2; return 1; fi
      printf '%s' "$pw" > "$item" ;;
    find-generic-password) [ -f "$item" ] || return 44; cat "$item"; echo ;;
    delete-generic-password) [ -f "$item" ] || return 44; rm "$item" ;;
    *) echo "security: unknown command \"$cmd\"" >&2; return 1 ;;
  esac
}
if [ "$1" = "-i" ]; then
  fold -w 4095 | {
    status=0
    while IFS= read -r piece; do
      run $piece
      status=$?
    done
    exit $status
  }
  exit $?
fi
run "$@"
`

func fakeKeychain(t *testing.T) (*Keychain, string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "security")
	if err := os.WriteFile(bin, []byte(fakeSecurity), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_DIR", dir)
	return &Keychain{Service: "localdot-keyd-test", Path: bin}, dir
}

// longValue is a fake printable value of n bytes.
func longValue(n int) []byte {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.+/="
	rng := rand.New(rand.NewPCG(7, uint64(n)))
	out := make([]byte, n)
	for i := range out {
		out[i] = chars[rng.IntN(len(chars))]
	}
	return out
}

// carries reports whether text holds any 8 bytes of value or any 16 characters of its hex.
func carries(text string, value []byte) bool {
	h := hex.EncodeToString(value)
	for i := 0; i+8 <= len(value); i++ {
		if strings.Contains(text, string(value[i:i+8])) {
			return true
		}
	}
	for i := 0; i+16 <= len(h); i++ {
		if strings.Contains(text, h[i:i+16]) {
			return true
		}
	}
	return false
}

func TestKeychainRoundTripThroughTheSecurityTool(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("weather", fakeValue); err != nil {
		t.Fatal(err)
	}
	got, err := k.Get("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if err := k.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
	if err := k.Delete("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete twice: %v", err)
	}
	argv, err := os.ReadFile(filepath.Join(dir, "argv.log"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(argv, fakeValue) || bytes.Contains(argv, []byte(hex.EncodeToString(fakeValue))) {
		t.Fatalf("the secret reached the command line: %s", argv)
	}
}

func TestKeychainKeepsLongValuesWhole(t *testing.T) {
	k, dir := fakeKeychain(t)
	for _, n := range []int{3000, maxValueLen} {
		value := longValue(n)
		if err := k.Put("weather", value); err != nil {
			t.Fatalf("Put of %d bytes: %v", n, err)
		}
		if got, err := k.Get("weather"); err != nil || !bytes.Equal(got, value) {
			t.Fatalf("Get after %d bytes: %d bytes back, %v", n, len(got), err)
		}
	}
	if err := k.Put("weather", fakeValue); err != nil {
		t.Fatal(err)
	}
	items, _ := os.ReadDir(filepath.Join(dir, "store"))
	if len(items) != 2 {
		t.Fatalf("%d items after a short value replaced a long one, want the item and one chunk", len(items))
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if carries(string(argv), longValue(maxValueLen)) {
		t.Fatalf("the secret reached the command line: %s", argv)
	}
}

func TestKeychainErrorsNeverCarryTheValue(t *testing.T) {
	k, dir := fakeKeychain(t)
	value := longValue(maxValueLen)
	t.Setenv("FAKE_FAIL", "add")
	if err := k.Put("weather", value); err == nil || carries(err.Error(), value) {
		t.Fatalf("Put through a failing tool: %v", err)
	}
	t.Setenv("FAKE_FAIL", "")
	if err := k.Put("weather", value); err != nil {
		t.Fatal(err)
	}
	// A chunk from another write: what a crash between two chunk writes leaves.
	chunk := filepath.Join(dir, "store", "localdot-keyd-test.weather.1")
	data, err := os.ReadFile(chunk)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(chunk, append([]byte(strings.Repeat("0", 16)), data[16:]...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather"); err == nil || carries(err.Error(), value) {
		t.Fatalf("Get of a torn value: %v", err)
	}
}

func TestKeychainReportsToolFailures(t *testing.T) {
	k := &Keychain{Service: "localdot-keyd-test", Path: filepath.Join(t.TempDir(), "missing")}
	if err := k.Put("weather", fakeValue); err == nil {
		t.Fatal("Put through a missing tool succeeded")
	}
	if _, err := k.Get("weather"); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Get through a missing tool: %v", err)
	}
}

// Opt-in: writes and deletes fake items in the login keychain, the longest value included.
func TestKeychainAgainstTheLoginKeychain(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("KEYD_KEYCHAIN_TEST") != "1" {
		t.Skip("set KEYD_KEYCHAIN_TEST=1 on macOS to use the login keychain")
	}
	k := NewKeychain("localdot-keyd-test")
	id := fmt.Sprintf("probe-%d", time.Now().UnixNano())
	t.Cleanup(func() { _ = k.Delete(id) })
	for _, value := range [][]byte{fakeValue, longValue(maxValueLen), []byte("second-fake-value-for-test")} {
		if err := k.Put(id, value); err != nil {
			t.Fatalf("Put of %d bytes: %v", len(value), err)
		}
		if got, err := k.Get(id); err != nil || !bytes.Equal(got, value) {
			t.Fatalf("Get after %d bytes: %d bytes back, %v", len(value), len(got), err)
		}
	}
	if err := k.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
	if exec.Command(k.Path, "find-generic-password", "-s", k.Service).Run() == nil {
		t.Fatal("an item of the test service outlived Delete")
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/vault/`
Expected: FAIL — `[build failed]`, starting `internal/vault/vault_test.go:15:35: undefined: Store`.

- [ ] **Step 3: Implement the stores and the vault**

`keyd/internal/vault/store.go`:
```go
package vault

import (
	"errors"
	"slices"
	"sync"
)

// ErrNotFound means the store has no value for the id.
var ErrNotFound = errors.New("vault: secret not found")

// Store keeps secret values by id; the Keychain in production, Memory in tests.
type Store interface {
	Put(id string, value []byte) error
	Get(id string) ([]byte, error)
	Delete(id string) error
}

// Memory is a Store that lives only as long as the process.
type Memory struct {
	mu     sync.Mutex
	values map[string][]byte
}

func NewMemory() *Memory {
	return &Memory{values: map[string][]byte{}}
}

func (m *Memory) Put(id string, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[id] = slices.Clone(value)
	return nil
}

func (m *Memory) Get(id string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[id]
	if !ok {
		return nil, ErrNotFound
	}
	return slices.Clone(v), nil
}

func (m *Memory) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.values[id]; !ok {
		return ErrNotFound
	}
	delete(m.values, id)
	return nil
}
```

`keyd/internal/vault/keychain.go`:
```go
package vault

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

// errSecItemNotFound is the exit status /usr/bin/security uses for a missing item.
const errSecItemNotFound = 44

// security -i runs the first 4,095 characters of a line as one command and the rest as another,
// so a value is stored in chunks that fit one line: 1,536 bytes are 3,072 hex characters, after
// at most about 230 of command.
const (
	chunkBytes = 1536
	maxChunks  = (maxValueLen + chunkBytes - 1) / chunkBytes
)

// Keychain stores values as generic passwords in the login keychain through /usr/bin/security.
// Values travel hex-encoded on the tool's stdin, never on its command line. A value is split into
// chunk items <id>.0, <id>.1, …; the item <id> names their count and the write that made them, so
// a read never mixes two writes. The tool's output never leaves keyd: it can echo a value, so an
// error names only the operation, the item and the exit status.
type Keychain struct {
	Service string
	Path    string
}

func NewKeychain(service string) *Keychain {
	return &Keychain{Service: service, Path: "/usr/bin/security"}
}

// Put writes the chunks, then the item that names them, then reads the value back: a write the
// tool split, cut short or refused is an error, never a stored fragment.
func (k *Keychain) Put(id string, value []byte) error {
	gen, err := newWriteID()
	if err != nil {
		return err
	}
	n := (len(value) + chunkBytes - 1) / chunkBytes
	for i := range n {
		part := value[i*chunkBytes : min(len(value), (i+1)*chunkBytes)]
		if err := k.add(chunkAccount(id, i), gen+":"+hex.EncodeToString(part)); err != nil {
			return err
		}
	}
	if err := k.add(id, fmt.Sprintf("keyd:%s:%d", gen, n)); err != nil {
		return err
	}
	if got, err := k.Get(id); err != nil || !bytes.Equal(got, value) {
		return fmt.Errorf("keychain: store %s: the value did not read back intact", id)
	}
	for i := n; i < maxChunks; i++ {
		k.remove(chunkAccount(id, i))
	}
	return nil
}

func (k *Keychain) Get(id string) ([]byte, error) {
	head, err := k.find(id)
	if err != nil {
		return nil, err
	}
	gen, count, ok := parseHead(head)
	if !ok {
		return nil, fmt.Errorf("keychain: item %s is not keyd's", id)
	}
	value := make([]byte, 0, count*chunkBytes)
	for i := range count {
		data, err := k.find(chunkAccount(id, i))
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		g, encoded, _ := strings.Cut(data, ":")
		part, derr := hex.DecodeString(encoded)
		if err != nil || g != gen || derr != nil {
			return nil, fmt.Errorf("keychain: item %s was torn by an interrupted write; store it again", id)
		}
		value = append(value, part...)
	}
	return value, nil
}

// Delete removes the item and every chunk it may have had.
func (k *Keychain) Delete(id string) error {
	err := k.remove(id)
	for i := range maxChunks {
		if cerr := k.remove(chunkAccount(id, i)); cerr != nil && !errors.Is(cerr, ErrNotFound) && err == nil {
			err = cerr
		}
	}
	return err
}

// add writes one item in a security -i session of one line, so the exit status is that line's.
func (k *Keychain) add(account, data string) error {
	line := fmt.Sprintf("add-generic-password -U -s %s -a %s -l localDot-%s -w %s\n", k.Service, account, account, data)
	return k.run("store", account, strings.NewReader(line), nil, "-i")
}

func (k *Keychain) find(account string) (string, error) {
	var out bytes.Buffer
	if err := k.run("read", account, nil, &out, "find-generic-password", "-s", k.Service, "-a", account, "-w"); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

func (k *Keychain) remove(account string) error {
	return k.run("delete", account, nil, nil, "delete-generic-password", "-s", k.Service, "-a", account)
}

// run reports only how the tool ended; what it printed is dropped.
func (k *Keychain) run(op, account string, stdin io.Reader, stdout io.Writer, args ...string) error {
	cmd := exec.Command(k.Path, args...)
	cmd.Stdin, cmd.Stdout = stdin, stdout
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &exit) && exit.ExitCode() == errSecItemNotFound:
		return ErrNotFound
	case errors.As(err, &exit):
		return fmt.Errorf("keychain: %s %s: security exited with status %d", op, account, exit.ExitCode())
	}
	return fmt.Errorf("keychain: %s %s: %w", op, account, err)
}

func chunkAccount(id string, i int) string {
	return id + "." + strconv.Itoa(i)
}

func parseHead(head string) (gen string, count int, ok bool) {
	parts := strings.Split(head, ":")
	if len(parts) != 3 || parts[0] != "keyd" {
		return "", 0, false
	}
	count, err := strconv.Atoi(parts[2])
	if err != nil || count < 1 || count > maxChunks {
		return "", 0, false
	}
	return parts[1], count, true
}

func newWriteID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
```

`keyd/internal/vault/vault.go`:
```go
// Package vault keeps keyd's secrets: values in a Store, metadata in an index file that never
// holds a value.
package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"sync"
	"time"
)

type Kind string

const (
	KindLLM  Kind = "llm"
	KindHTTP Kind = "http"
)

// Record describes a secret and where it may be used. keys.FromRecord validates the binding
// fields; the vault checks only the id, the kind and the value.
type Record struct {
	ID        string    `json:"id"`
	Kind      Kind      `json:"kind"`
	Provider  string    `json:"provider,omitempty"`
	BaseURL   string    `json:"baseURL,omitempty"`
	Hosts     []string  `json:"hosts,omitempty"`
	Header    string    `json:"header,omitempty"`
	Format    string    `json:"format,omitempty"`
	Methods   []string  `json:"methods,omitempty"`
	Paths     []string  `json:"paths,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

const (
	minValueLen = 8
	maxValueLen = 8192
)

var (
	idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	// The LLM gateway's local routes share the gateway's namespace with secret ids.
	reservedIDs = []string{"lmstudio", "ollama"}
)

// ValidID reports whether id can name a secret.
func ValidID(id string) bool {
	return idPattern.MatchString(id) && !slices.Contains(reservedIDs, id)
}

// ValidValue rejects values that could break a header or match too much when scrubbed.
func ValidValue(value []byte) error {
	if len(value) < minValueLen || len(value) > maxValueLen {
		return fmt.Errorf("secret value must be %d-%d bytes", minValueLen, maxValueLen)
	}
	for _, b := range value {
		if b < 0x20 || b > 0x7e {
			return errors.New("secret value must be printable ASCII")
		}
	}
	if value[0] == ' ' || value[len(value)-1] == ' ' {
		return errors.New("secret value must not start or end with a space")
	}
	return nil
}

type indexFile struct {
	V       int      `json:"v"`
	Secrets []Record `json:"secrets"`
}

// Vault is safe for concurrent use.
type Vault struct {
	store   Store
	path    string
	now     func() time.Time
	mu      sync.Mutex
	records map[string]Record
	cache   map[string][]byte
}

// Open loads the index at path; a missing file is an empty vault. An empty path keeps the index
// in memory only, for a vault whose values are in memory too.
func Open(store Store, path string) (*Vault, error) {
	v := &Vault{store: store, path: path, now: time.Now, records: map[string]Record{}, cache: map[string][]byte{}}
	if path == "" {
		return v, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return nil, err
	}
	var idx indexFile
	if err := json.Unmarshal(data, &idx); err != nil {
		return nil, fmt.Errorf("vault index %s: %w", path, err)
	}
	for _, r := range idx.Secrets {
		v.records[r.ID] = r
	}
	return v, nil
}

func (v *Vault) Put(rec Record, value []byte) error {
	if !ValidID(rec.ID) {
		return fmt.Errorf("secret id %q: want 1-64 of a-z 0-9 _ - starting with a letter or digit, not a reserved name", rec.ID)
	}
	if rec.Kind != KindLLM && rec.Kind != KindHTTP {
		return fmt.Errorf("secret kind %q: want llm or http", rec.Kind)
	}
	if err := ValidValue(value); err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now().UTC()
	rec.CreatedAt, rec.UpdatedAt = now, now
	if old, ok := v.records[rec.ID]; ok {
		rec.CreatedAt = old.CreatedAt
	}
	if err := v.store.Put(rec.ID, value); err != nil {
		return err
	}
	v.records[rec.ID] = rec
	v.cache[rec.ID] = slices.Clone(value)
	return v.saveLocked()
}

func (v *Vault) Delete(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.records[id]; !ok {
		return ErrNotFound
	}
	if err := v.store.Delete(id); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	delete(v.records, id)
	delete(v.cache, id)
	return v.saveLocked()
}

func (v *Vault) Record(id string) (Record, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	r, ok := v.records[id]
	return r, ok
}

func (v *Vault) Records() []Record {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]Record, 0, len(v.records))
	for _, r := range v.records {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Value returns the secret, reading the store only on the first use.
func (v *Vault) Value(id string) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.records[id]; !ok {
		return nil, ErrNotFound
	}
	if cached, ok := v.cache[id]; ok {
		return slices.Clone(cached), nil
	}
	value, err := v.store.Get(id)
	if err != nil {
		return nil, err
	}
	v.cache[id] = slices.Clone(value)
	return value, nil
}

func (v *Vault) saveLocked() error {
	if v.path == "" {
		return nil
	}
	idx := indexFile{V: 1, Secrets: make([]Record, 0, len(v.records))}
	for _, r := range v.records {
		idx.Secrets = append(idx.Secrets, r)
	}
	sort.Slice(idx.Secrets, func(i, j int) bool { return idx.Secrets[i].ID < idx.Secrets[j].ID })
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(v.path, data)
}

func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".secrets-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
```

- [ ] **Step 4: Run the tests, then the opt-in Keychain test once**

Run: `go test ./internal/vault/`
Expected: `ok` (12 tests, `TestKeychainAgainstTheLoginKeychain` skipped).
Run: `KEYD_KEYCHAIN_TEST=1 go test -run LoginKeychain -v ./internal/vault/`
Expected: `--- PASS: TestKeychainAgainstTheLoginKeychain` (it stores 26 bytes, then 8,192, then 26
again, reading each back, and deletes the item and its chunks). If macOS asks to allow `security` to use
the login keychain, choose Always Allow. Then
`security find-generic-password -s localdot-keyd-test; echo $?` prints `44`: nothing was left behind.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/vault
git commit -m "feat(keyd): vault with Keychain and in-memory stores"
```

---
### Task 3: Sealed intake — the daemon relays a key it cannot read

Trust rule 3, as amended after review 1: the daemon never sees a plaintext secret, because the key
form in the UI seals the key to keyd and the daemon only relays the ciphertext. keyd's only doors
are its 0600 admin socket and the per-cell listeners, and a browser can reach neither, so the UI
seals the key to keyd's per-boot key (P4a-R2): ECDH P-256 with an ephemeral key, HKDF-SHA256 over
the shared secret, AES-256-GCM with the secret's whole binding in the AAD — id, kind, provider, base
URL, hosts, header, format, methods and paths, as a JSON array — so a value captured within one
boot cannot be replayed under another binding (review 1, M6). Every step is in WebCrypto. The daemon
relays ciphertext. keyd's key pair is made per process and never written anywhere. The test
includes two blobs sealed by Node 25's WebCrypto with the exact snippet in "Interfaces Part 4b
builds on", one with lists and an `&` in a path, so the two implementations, and their two JSON
encoders, are pinned to each other.

**Files:**
- Create: `keyd/internal/vault/seal.go`
- Test: `keyd/internal/vault/seal_test.go`

**Interfaces:**
- Consumes: `fakeValue` from `vault_test.go` (Task 2).
- Produces: `Sealed{V int; EPK, Nonce, CT string}` (JSON `v epk nonce ct`, base64url without
  padding), `NewOpener() (*Opener, error)`, `(*Opener).PublicKey() string` (uncompressed P-256
  point, base64url), `(*Opener).Open(s Sealed, rec Record) ([]byte, error)`,
  `Seal(publicKey string, rec Record, plaintext []byte) (Sealed, error)`; the AAD is
  `localdot-keyd seal v1:` followed by the JSON array `[id, kind, provider, baseURL, hosts, header,
  format, methods, paths]`, `""` and `[]` for what is absent, without HTML escaping.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/vault/seal_test.go`:
```go
package vault

import (
	"crypto/ecdh"
	"encoding/hex"
	"slices"
	"testing"
)

var weatherRecord = Record{ID: "weather", Kind: KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}

func TestSealOpenRoundTrip(t *testing.T) {
	o, err := NewOpener()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Seal(o.PublicKey(), weatherRecord, fakeValue)
	if err != nil {
		t.Fatal(err)
	}
	got, err := o.Open(s, weatherRecord)
	if err != nil || string(got) != string(fakeValue) {
		t.Fatalf("Open = %q, %v", got, err)
	}
}

func TestOpenRefusesAnotherBindingKeyOrBytes(t *testing.T) {
	o, _ := NewOpener()
	other, _ := NewOpener()
	good, _ := Seal(o.PublicKey(), weatherRecord, fakeValue)
	changed := func(edit func(*Sealed)) Sealed {
		s := good
		edit(&s)
		return s
	}
	rebound := func(edit func(*Record)) Record {
		r := weatherRecord
		r.Hosts = slices.Clone(r.Hosts)
		edit(&r)
		return r
	}
	ct, _ := b64.DecodeString(good.CT)
	ct[0] ^= 1
	flipped := b64.EncodeToString(ct)
	cases := []struct {
		name   string
		sealed Sealed
		opener *Opener
		rec    Record
	}{
		{"other secret id", good, o, rebound(func(r *Record) { r.ID = "openai" })},
		{"other hosts", good, o, rebound(func(r *Record) { r.Hosts = []string{"evil.example.test"} })},
		{"a host added", good, o, rebound(func(r *Record) { r.Hosts = append(r.Hosts, "evil.example.test") })},
		{"other header", good, o, rebound(func(r *Record) { r.Header = "X-Api-Key" })},
		{"other format", good, o, rebound(func(r *Record) { r.Format = "raw" })},
		{"other recipient", good, other, weatherRecord},
		{"tampered ciphertext", changed(func(s *Sealed) { s.CT = flipped }), o, weatherRecord},
		{"bad version", changed(func(s *Sealed) { s.V = 2 }), o, weatherRecord},
		{"short nonce", changed(func(s *Sealed) { s.Nonce = "AAAA" }), o, weatherRecord},
		{"bad point", changed(func(s *Sealed) { s.EPK = "BAAA" }), o, weatherRecord},
		{"not base64", changed(func(s *Sealed) { s.CT = "***" }), o, weatherRecord},
	}
	for _, c := range cases {
		if _, err := c.opener.Open(c.sealed, c.rec); err == nil {
			t.Errorf("%s: Open succeeded", c.name)
		}
	}
	limited, _ := Seal(o.PublicKey(), rebound(func(r *Record) { r.Methods = []string{"GET"} }), fakeValue)
	if _, err := o.Open(limited, weatherRecord); err == nil {
		t.Error("a value sealed with a method limit opened without it")
	}
}

// Sealed with Node 25's WebCrypto (the snippet in the plan's interface notes) to the fixed key below.
func TestOpenAcceptsWhatWebCryptoSeals(t *testing.T) {
	scalar, _ := hex.DecodeString("6b1f3c2a9d8e7f60514233241506f7e8d9cabbac9d8e7f6051423324150617f8")
	priv, err := ecdh.P256().NewPrivateKey(scalar)
	if err != nil {
		t.Fatal(err)
	}
	o := &Opener{priv: priv}
	if o.PublicKey() != "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM" {
		t.Fatalf("PublicKey = %s", o.PublicKey())
	}
	cases := []struct {
		rec    Record
		sealed Sealed
	}{
		{
			Record{ID: "anthropic", Kind: KindLLM, Provider: "anthropic"},
			Sealed{
				V:     1,
				EPK:   "BDRBSHmompILZT4JXnwFw_aLRlQBykzXvyaBUZKuUZHkfbY1Hi_0x2xLVFEhKRT3RBSwEKdH7ofgaQaMkb1E_-4",
				Nonce: "RcWTiYUMWlwdbPpo",
				CT:    "eSbQx0PjBEKB5huMwBy6TF0BeOiziJjeNgrtcGcDXzKjeAqbRAcR",
			},
		},
		{
			Record{ID: "weather", Kind: KindHTTP, Hosts: []string{"api.example.test", "b.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}, Paths: []string{"/v1/a&b/"}},
			Sealed{
				V:     1,
				EPK:   "BCghCEuuHBof4xoiFZ9-spP370ghtOh8IKmtP_zyqo34vqD9IbiojExBy3YylZssk48g6qJiST45EKz289oeRzY",
				Nonce: "FgtfN8Eg8teW7BSf",
				CT:    "G_0PaqZmmO-YCxm4CHC4lqox8u2JRzw7GckBNM6B3LCBKr0Ywfqk",
			},
		},
	}
	for _, c := range cases {
		got, err := o.Open(c.sealed, c.rec)
		if err != nil || string(got) != "fake-key-from-webcrypto" {
			t.Errorf("%s: Open = %q, %v", c.rec.ID, got, err)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/vault/`
Expected: FAIL — `[build failed]`, starting `internal/vault/seal_test.go:13:12: undefined: NewOpener`.

- [ ] **Step 3: Implement sealing**

`keyd/internal/vault/seal.go`:
```go
package vault

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// The seal scheme lets the UI encrypt a key to keyd so that the daemon relaying it never holds
// the plaintext: ECDH P-256 with an ephemeral sender key, HKDF-SHA256 over the shared secret
// (salt = sender public key || keyd public key), AES-256-GCM with the secret's binding in the AAD.
// WebCrypto can produce it with ECDH deriveBits, HKDF deriveKey and AES-GCM encrypt.
const sealInfo = "localdot-keyd seal v1"

var errSealed = errors.New("vault: cannot open the sealed secret")

// Sealed is the JSON a client posts; every field is base64url without padding.
type Sealed struct {
	V     int    `json:"v"`
	EPK   string `json:"epk"`
	Nonce string `json:"nonce"`
	CT    string `json:"ct"`
}

// Opener holds keyd's seal key pair, generated per process and never written anywhere.
type Opener struct {
	priv *ecdh.PrivateKey
}

func NewOpener() (*Opener, error) {
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Opener{priv: priv}, nil
}

// PublicKey is keyd's public key as an uncompressed P-256 point in base64url.
func (o *Opener) PublicKey() string {
	return b64.EncodeToString(o.priv.PublicKey().Bytes())
}

// Open decrypts a value sealed for rec: a blob sealed for another id or binding does not open.
func (o *Opener) Open(s Sealed, rec Record) ([]byte, error) {
	if s.V != 1 {
		return nil, fmt.Errorf("vault: sealed version %d, want 1", s.V)
	}
	epkBytes, err1 := b64.DecodeString(s.EPK)
	nonce, err2 := b64.DecodeString(s.Nonce)
	ct, err3 := b64.DecodeString(s.CT)
	if err := errors.Join(err1, err2, err3); err != nil || len(nonce) != 12 {
		return nil, errSealed
	}
	epk, err := ecdh.P256().NewPublicKey(epkBytes)
	if err != nil {
		return nil, errSealed
	}
	aead, err := sealAEAD(o.priv, epk, epkBytes, o.priv.PublicKey().Bytes())
	if err != nil {
		return nil, errSealed
	}
	plain, err := aead.Open(nil, nonce, ct, sealAAD(rec))
	if err != nil {
		return nil, errSealed
	}
	return plain, nil
}

// Seal encrypts plaintext for rec to the holder of publicKey, as the UI does.
func Seal(publicKey string, rec Record, plaintext []byte) (Sealed, error) {
	recipientBytes, err := b64.DecodeString(publicKey)
	if err != nil {
		return Sealed{}, err
	}
	recipient, err := ecdh.P256().NewPublicKey(recipientBytes)
	if err != nil {
		return Sealed{}, err
	}
	eph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return Sealed{}, err
	}
	aead, err := sealAEAD(eph, recipient, eph.PublicKey().Bytes(), recipientBytes)
	if err != nil {
		return Sealed{}, err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return Sealed{}, err
	}
	ct := aead.Seal(nil, nonce, plaintext, sealAAD(rec))
	return Sealed{V: 1, EPK: b64.EncodeToString(eph.PublicKey().Bytes()), Nonce: b64.EncodeToString(nonce), CT: b64.EncodeToString(ct)}, nil
}

var b64 = base64.RawURLEncoding

func sealAEAD(priv *ecdh.PrivateKey, peer *ecdh.PublicKey, senderPub, recipientPub []byte) (cipher.AEAD, error) {
	shared, err := priv.ECDH(peer)
	if err != nil {
		return nil, err
	}
	salt := append(append([]byte{}, senderPub...), recipientPub...)
	key, err := hkdf.Key(sha256.New, shared, salt, sealInfo, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// sealAAD binds a sealed value to its record: the id and every field that says where the secret
// may go, as the JSON array [id, kind, provider, baseURL, hosts, header, format, methods, paths]
// with "" and [] for what is absent, which JSON.stringify writes byte for byte the same.
func sealAAD(rec Record) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode([]any{rec.ID, rec.Kind, rec.Provider, rec.BaseURL, list(rec.Hosts), rec.Header, rec.Format, list(rec.Methods), list(rec.Paths)})
	return append([]byte(sealInfo+":"), bytes.TrimSuffix(buf.Bytes(), []byte("\n"))...)
}

func list(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/vault/`
Expected: `ok` (15 tests, one skipped).

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/vault
git commit -m "feat(keyd): sealed secret intake"
```

---
### Task 4: The SSRF guard — resolve, check, dial the checked address, check again

S4 showed why a static list is not enough: `0.0.0.0` and `::` reach loopback-only listeners, and
the Mac's own global and temporary IPv6 addresses passed iron-proxy's guard (S4 "keyd requirement:
the SSRF deny set"). The guard denies the static ranges, every address of every interface on the
Mac and the networks they sit in, and reads the interfaces at every check, so a rotated temporary
address is never stale (~31 µs per read on the development Mac, P4a-R7). It looks through
IPv4-mapped, NAT64 and 6to4 forms to the IPv4 address they carry. The dialer resolves the name
itself, refuses the name if any answer is denied (a public-plus-private answer is a rebinding
shape), dials only checked addresses with `net.Dialer.Control` checking again at connect time, and
checks the connected peer once more. An exception list (exact address and port) exists for tests
only; production passes none. This is the dial-time check the spec adapts from iron-proxy, rebuilt
around a live deny set.

**Files:**
- Create: `keyd/internal/netguard/guard.go`, `keyd/internal/netguard/dialer.go`
- Test: `keyd/internal/netguard/guard_test.go`, `keyd/internal/netguard/dialer_test.go`

**Interfaces:**
- Produces: `New(own func() ([]netip.Prefix, error), allow ...netip.AddrPort) *Guard`,
  `(*Guard).Check(netip.AddrPort) error`, `(*Guard).Control(network, address string, c syscall.RawConn) error`,
  `InterfacePrefixes() ([]netip.Prefix, error)`, `DeniedError{Target, Rule string}` (the rule names
  the range, such as `loopback 127.0.0.0/8`, `docker desktop 192.168.65.0/24`, `own address …`,
  `connected network …`); `Resolver interface { LookupNetIP(ctx, network, host string) ([]netip.Addr, error) }`
  (`*net.Resolver` satisfies it), `ResolveError{Host string; Err error}`,
  `Dialer{Guard *Guard; Resolver Resolver; Timeout time.Duration}` with
  `DialContext(ctx, network, address string) (net.Conn, error)`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/netguard/guard_test.go`:
```go
package netguard

import (
	"errors"
	"net"
	"net/netip"
	"strings"
	"testing"
)

func noOwn() ([]netip.Prefix, error) { return nil, nil }

func check(g *Guard, addr string) error {
	return g.Check(netip.AddrPortFrom(netip.MustParseAddr(addr), 443))
}

func TestStaticDenySet(t *testing.T) {
	g := New(noOwn)
	denied := map[string]string{
		"127.0.0.1":                            "loopback",
		"127.255.255.254":                      "loopback",
		"0.0.0.0":                              "this network",
		"0.1.2.3":                              "this network",
		"10.1.2.3":                             "private",
		"172.16.0.1":                           "private",
		"172.31.255.255":                       "private",
		"192.168.1.10":                         "private",
		"192.168.65.254":                       "docker desktop",
		"100.64.0.1":                           "shared address space",
		"169.254.169.254":                      "link-local",
		"224.0.0.1":                            "multicast",
		"255.255.255.255":                      "reserved",
		"198.18.0.1":                           "benchmarking",
		"192.0.2.1":                            "documentation",
		"::1":                                  "loopback",
		"::":                                   "unspecified",
		"::ffff:127.0.0.1":                     "loopback",
		"::ffff:10.0.0.1":                      "private",
		"::127.0.0.1":                          "ipv4-compatible",
		"64:ff9b::7f00:1":                      "loopback",
		"64:ff9b::a9fe:a9fe":                   "link-local",
		"2002:7f00:1::1":                       "loopback",
		"2001:0:4136:e378:8000:63bf:3fff:fdd2": "teredo",
		"fe80::1":                              "link-local",
		"fe80::1%en0":                          "link-local",
		"fd00::1":                              "unique local",
		"fc00::1":                              "unique local",
		"ff02::1":                              "multicast",
		"2001:db8::1":                          "documentation",
	}
	for addr, rule := range denied {
		err := check(g, addr)
		var d *DeniedError
		if !errors.As(err, &d) {
			t.Errorf("%s: err = %v, want DeniedError", addr, err)
			continue
		}
		if !strings.Contains(d.Rule, rule) {
			t.Errorf("%s: rule %q, want it to name %q", addr, d.Rule, rule)
		}
	}
}

func TestPublicAddressesPass(t *testing.T) {
	g := New(noOwn)
	for _, addr := range []string{"8.8.8.8", "1.1.1.1", "93.184.215.14", "2606:4700:4700::1111", "64:ff9b::808:808", "2002:808:808::1", "::ffff:8.8.8.8"} {
		if err := check(g, addr); err != nil {
			t.Errorf("%s: %v", addr, err)
		}
	}
}

func TestOwnAddressesAndConnectedNetworksAreDenied(t *testing.T) {
	own := []netip.Prefix{
		netip.MustParsePrefix("81.2.69.160/24"),
		netip.MustParsePrefix("2a01:4b00:1234:5678::abcd/64"),
	}
	g := New(func() ([]netip.Prefix, error) { return own, nil })
	for _, addr := range []string{"81.2.69.160", "81.2.69.7", "2a01:4b00:1234:5678::abcd", "2a01:4b00:1234:5678::1", "::ffff:81.2.69.7"} {
		if err := check(g, addr); err == nil {
			t.Errorf("%s passed, want it denied as the Mac's own network", addr)
		}
	}
	for _, addr := range []string{"81.2.70.1", "2a01:4b00:1234:5679::1"} {
		if err := check(g, addr); err != nil {
			t.Errorf("%s: %v", addr, err)
		}
	}
}

func TestOwnAddressesAreReadOnEveryCheck(t *testing.T) {
	current := netip.MustParsePrefix("2a01:4b00:1:2::aaaa/128")
	g := New(func() ([]netip.Prefix, error) { return []netip.Prefix{current}, nil })
	if err := check(g, "2a01:4b00:1:2::bbbb"); err != nil {
		t.Fatalf("before rotation: %v", err)
	}
	current = netip.MustParsePrefix("2a01:4b00:1:2::bbbb/128")
	if err := check(g, "2a01:4b00:1:2::bbbb"); err == nil {
		t.Fatal("a rotated temporary address passed the guard")
	}
}

func TestUnreadableOwnAddressesFailClosed(t *testing.T) {
	g := New(func() ([]netip.Prefix, error) { return nil, errors.New("sysctl failed") })
	if err := check(g, "8.8.8.8"); err == nil {
		t.Fatal("check passed without the Mac's own addresses")
	}
}

func TestAllowExceptionIsExactAddressAndPort(t *testing.T) {
	ap := netip.MustParseAddrPort("127.0.0.1:4799")
	g := New(noOwn, ap)
	if err := g.Check(ap); err != nil {
		t.Fatalf("exception: %v", err)
	}
	if err := g.Check(netip.MustParseAddrPort("127.0.0.1:4798")); err == nil {
		t.Fatal("another port on the excepted address passed")
	}
}

func TestControlRefusesBeforeConnecting(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		if c, err := ln.Accept(); err == nil {
			c.Close()
			accepted <- struct{}{}
		}
	}()
	d := net.Dialer{Control: New(noOwn).Control}
	if c, err := d.Dial("tcp4", ln.Addr().String()); err == nil {
		c.Close()
		t.Fatal("dial to loopback succeeded through Control")
	}
	select {
	case <-accepted:
		t.Fatal("the listener saw a connection")
	default:
	}
	if err := New(noOwn).Control("tcp", "not-an-address", nil); err == nil {
		t.Fatal("Control accepted an unparsable address")
	}
}

func TestInterfacePrefixesIncludeLoopback(t *testing.T) {
	prefixes, err := InterfacePrefixes()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range prefixes {
		if p.Contains(netip.MustParseAddr("127.0.0.1")) {
			return
		}
	}
	t.Fatalf("InterfacePrefixes() = %v, want the loopback network", prefixes)
}
```

`keyd/internal/netguard/dialer_test.go`:
```go
package netguard

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"testing"
	"time"
)

type fakeResolver struct {
	answers map[string][][]netip.Addr
	calls   map[string]int
}

func (f *fakeResolver) LookupNetIP(_ context.Context, _ string, host string) ([]netip.Addr, error) {
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	seq, ok := f.answers[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	i := min(f.calls[host], len(seq)-1)
	f.calls[host]++
	return seq[i], nil
}

func addrs(s ...string) []netip.Addr {
	out := make([]netip.Addr, len(s))
	for i, a := range s {
		out[i] = netip.MustParseAddr(a)
	}
	return out
}

func listen(t *testing.T) (net.Listener, netip.AddrPort, chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	seen := make(chan struct{}, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			seen <- struct{}{}
			c.Close()
		}
	}()
	return ln, netip.MustParseAddrPort(ln.Addr().String()), seen
}

func noConnection(t *testing.T, seen chan struct{}) {
	t.Helper()
	select {
	case <-seen:
		t.Fatal("the listener saw a connection")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestDialerRefusesANameThatResolvesToLoopback(t *testing.T) {
	_, ap, seen := listen(t)
	r := &fakeResolver{answers: map[string][][]netip.Addr{"rebind.example.test": {addrs("127.0.0.1")}}}
	d := &Dialer{Guard: New(noOwn), Resolver: r}
	_, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("rebind.example.test", strconv.Itoa(int(ap.Port()))))
	var denied *DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("err = %v, want DeniedError", err)
	}
	noConnection(t, seen)
}

func TestDialerRefusesAMixOfPublicAndPrivateAnswers(t *testing.T) {
	_, ap, seen := listen(t)
	r := &fakeResolver{answers: map[string][][]netip.Addr{"mixed.example.test": {addrs("8.8.8.8", "127.0.0.1")}}}
	d := &Dialer{Guard: New(noOwn), Resolver: r}
	_, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("mixed.example.test", strconv.Itoa(int(ap.Port()))))
	if !errors.As(err, new(*DeniedError)) {
		t.Fatalf("err = %v, want DeniedError", err)
	}
	noConnection(t, seen)
}

func TestDialerRefusesIPLiterals(t *testing.T) {
	_, ap, seen := listen(t)
	d := &Dialer{Guard: New(noOwn), Resolver: &fakeResolver{}}
	for _, addr := range []string{ap.String(), "[::ffff:127.0.0.1]:" + strconv.Itoa(int(ap.Port())), "0.0.0.0:" + strconv.Itoa(int(ap.Port()))} {
		if _, err := d.DialContext(context.Background(), "tcp", addr); !errors.As(err, new(*DeniedError)) {
			t.Errorf("%s: err = %v, want DeniedError", addr, err)
		}
	}
	noConnection(t, seen)
}

func TestDialerConnectsToAnAllowedAddressAndPinsIt(t *testing.T) {
	_, ap, seen := listen(t)
	r := &fakeResolver{answers: map[string][][]netip.Addr{"api.example.test": {addrs("127.0.0.1"), addrs("10.0.0.1")}}}
	d := &Dialer{Guard: New(noOwn, ap), Resolver: r}
	c, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("api.example.test", strconv.Itoa(int(ap.Port()))))
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	<-seen
	// The second lookup rebinds to a private address and must be refused.
	if _, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("api.example.test", strconv.Itoa(int(ap.Port())))); !errors.As(err, new(*DeniedError)) {
		t.Fatalf("rebound dial: %v", err)
	}
}

func TestDialerReportsResolveFailures(t *testing.T) {
	d := &Dialer{Guard: New(noOwn), Resolver: &fakeResolver{answers: map[string][][]netip.Addr{"empty.example.test": {nil}}}}
	for _, host := range []string{"missing.example.test", "empty.example.test"} {
		_, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort(host, "443"))
		var re *ResolveError
		if !errors.As(err, &re) {
			t.Errorf("%s: err = %v, want ResolveError", host, err)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/netguard/`
Expected: FAIL — `[build failed]`, starting `internal/netguard/guard_test.go:13:15: undefined: Guard`.

- [ ] **Step 3: Implement the guard and the dialer**

`keyd/internal/netguard/guard.go`:
```go
// Package netguard keeps keyd's upstream connections off the Mac, its networks and every
// non-public address: names are resolved by keyd, every answer is checked, the checked address is
// dialled, net.Dialer.Control checks it again at connect time and the connected peer once more.
package netguard

import (
	"fmt"
	"net"
	"net/netip"
	"syscall"
)

type rule struct {
	prefix netip.Prefix
	name   string
}

func r(cidr, name string) rule { return rule{netip.MustParsePrefix(cidr), name + " " + cidr} }

// Order matters only for the name reported: specific ranges come before the ones containing them.
var static = []rule{
	r("0.0.0.0/8", "this network"),
	r("10.0.0.0/8", "private"),
	r("100.64.0.0/10", "shared address space"),
	r("127.0.0.0/8", "loopback"),
	r("169.254.0.0/16", "link-local"),
	r("172.16.0.0/12", "private"),
	r("192.0.0.0/24", "protocol assignments"),
	r("192.0.2.0/24", "documentation"),
	r("192.168.65.0/24", "docker desktop"),
	r("192.168.0.0/16", "private"),
	r("198.18.0.0/15", "benchmarking"),
	r("198.51.100.0/24", "documentation"),
	r("203.0.113.0/24", "documentation"),
	r("224.0.0.0/4", "multicast"),
	r("240.0.0.0/4", "reserved"),
	r("168.63.129.16/32", "cloud metadata"),
	r("::/128", "unspecified"),
	r("::1/128", "loopback"),
	r("::/96", "ipv4-compatible"),
	r("64:ff9b:1::/48", "local nat64"),
	r("100::/64", "discard"),
	r("2001::/32", "teredo"),
	r("2001:db8::/32", "documentation"),
	r("fc00::/7", "unique local"),
	r("fe80::/10", "link-local"),
	r("fec0::/10", "site-local"),
	r("ff00::/8", "multicast"),
}

var (
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour = netip.MustParsePrefix("2002::/16")
)

// DeniedError is returned for every refused address.
type DeniedError struct {
	Target string
	Rule   string
}

func (e *DeniedError) Error() string {
	return fmt.Sprintf("netguard: %s denied (%s)", e.Target, e.Rule)
}

// Guard decides whether an address may be dialled. own returns the Mac's interface addresses
// with their prefix lengths; it is called on every check, so rotating addresses are never stale.
type Guard struct {
	own   func() ([]netip.Prefix, error)
	allow map[netip.AddrPort]bool
}

// New builds a guard. allow lists exact address:port exceptions; production passes none.
func New(own func() ([]netip.Prefix, error), allow ...netip.AddrPort) *Guard {
	g := &Guard{own: own, allow: map[netip.AddrPort]bool{}}
	for _, ap := range allow {
		g.allow[normalize(ap)] = true
	}
	return g
}

func (g *Guard) Check(ap netip.AddrPort) error {
	ap = normalize(ap)
	if g.allow[ap] {
		return nil
	}
	addr := ap.Addr()
	own, err := g.own()
	if err != nil {
		return &DeniedError{Target: addr.String(), Rule: "own addresses unavailable: " + err.Error()}
	}
	for _, a := range embedded(addr) {
		for _, s := range static {
			if s.prefix.Contains(a) {
				return &DeniedError{Target: addr.String(), Rule: s.name}
			}
		}
		for _, p := range own {
			if p.Addr() == a {
				return &DeniedError{Target: addr.String(), Rule: "own address " + p.String()}
			}
			if p.Masked().Contains(a) {
				return &DeniedError{Target: addr.String(), Rule: "connected network " + p.Masked().String()}
			}
		}
	}
	return nil
}

// Control is a net.Dialer.Control hook: Go calls it with the literal ip:port about to be connected.
func (g *Guard) Control(_, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return &DeniedError{Target: address, Rule: "unparsable dial address"}
	}
	return g.Check(ap)
}

// InterfacePrefixes returns every address of every interface with its network's prefix length.
func InterfacePrefixes() ([]netip.Prefix, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	out := make([]netip.Prefix, 0, len(addrs))
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(ipnet.IP)
		if !ok {
			continue
		}
		ones, bits := ipnet.Mask.Size()
		ip = ip.Unmap()
		if ip.Is4() && bits == 128 {
			ones -= 96
		}
		if bits == 0 {
			ones = ip.BitLen()
		}
		if p := netip.PrefixFrom(ip, ones); p.IsValid() {
			out = append(out, p)
		}
	}
	return out, nil
}

func normalize(ap netip.AddrPort) netip.AddrPort {
	return netip.AddrPortFrom(ap.Addr().WithZone("").Unmap(), ap.Port())
}

// embedded adds the IPv4 address that a NAT64 or 6to4 address carries.
func embedded(a netip.Addr) []netip.Addr {
	out := []netip.Addr{a}
	if !a.Is6() {
		return out
	}
	b := a.As16()
	switch {
	case nat64.Contains(a):
		out = append(out, netip.AddrFrom4([4]byte(b[12:16])))
	case sixToFour.Contains(a):
		out = append(out, netip.AddrFrom4([4]byte(b[2:6])))
	}
	return out
}
```

`keyd/internal/netguard/dialer.go`:
```go
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"time"
)

// Resolver is satisfied by *net.Resolver.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

type ResolveError struct {
	Host string
	Err  error
}

func (e *ResolveError) Error() string { return fmt.Sprintf("netguard: resolve %s: %v", e.Host, e.Err) }
func (e *ResolveError) Unwrap() error { return e.Err }

// Dialer resolves, checks every answer, then dials only checked addresses, IPv4 first.
type Dialer struct {
	Guard    *Guard
	Resolver Resolver
	Timeout  time.Duration
}

func (d *Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return nil, fmt.Errorf("netguard: bad port in %q", address)
	}
	ips, err := d.resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	targets := make([]netip.AddrPort, 0, len(ips))
	for _, ip := range ips {
		ap := netip.AddrPortFrom(ip.Unmap(), uint16(port))
		// One denied answer refuses the name: a mix of public and private answers is a rebinding shape.
		if err := d.Guard.Check(ap); err != nil {
			return nil, err
		}
		targets = append(targets, ap)
	}
	slices.SortStableFunc(targets, func(a, b netip.AddrPort) int {
		return rank(a) - rank(b)
	})
	timeout := d.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	nd := net.Dialer{Timeout: timeout, Control: d.Guard.Control}
	var errs []error
	for _, ap := range targets {
		c, err := nd.DialContext(ctx, network, ap.String())
		if err != nil {
			errs = append(errs, err)
			if ctx.Err() != nil {
				break
			}
			continue
		}
		peer, perr := netip.ParseAddrPort(c.RemoteAddr().String())
		if perr != nil {
			c.Close()
			return nil, &DeniedError{Target: c.RemoteAddr().String(), Rule: "unparsable peer address"}
		}
		if err := d.Guard.Check(peer); err != nil {
			c.Close()
			return nil, err
		}
		return c, nil
	}
	return nil, errors.Join(errs...)
}

func (d *Dialer) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{ip}, nil
	}
	ips, err := d.Resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, &ResolveError{Host: host, Err: err}
	}
	if len(ips) == 0 {
		return nil, &ResolveError{Host: host, Err: errors.New("no addresses")}
	}
	return ips, nil
}

func rank(ap netip.AddrPort) int {
	if ap.Addr().Is4() {
		return 0
	}
	return 1
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/netguard/`
Expected: `ok` (13 tests). No test leaves the Mac: denied dials never connect, and the one allowed
dial goes to a loopback listener through an exact exception.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/netguard
git commit -m "feat(keyd): dial-time SSRF guard"
```

---
### Task 5: The audit log and the event hub

"One hash-chained JSON line per decision — time, cell, surrogate id (never the value), host,
method, path, status, bytes, decision — under `~/.localdot/keyd/`." Each line carries the SHA-256
of the line before it, so an edit, a deletion or a reordering breaks the chain; a partial last line
left by a crash is cut off and the repair is itself a line. The format extends the shape keyd adapts
from iron-proxy (one record per decision, secrets named, never valued) with the cell, the listener,
the hash chain and the surrogate's ID (P4a-R17). `Write` turns surrogate-shaped text in the fields
a request controls (method, host, path, SNI, route, model, detail) into `surrogate:<ID>`, so neither
the log nor the `key.use` events made from its lines hold one (review 1, M2). A write that fails is
kept as `Err` until a write succeeds again, and the bytes a partial write left are cut off before
the next line, so the chain stays intact; keyd swaps no secret while `Err` is set (review 1, M4).
The hub fans events out to admin-socket subscribers without ever blocking the data plane; a
subscriber that falls behind is told how many it missed.

**Files:**
- Create: `keyd/internal/audit/audit.go`, `keyd/internal/events/events.go`
- Test: `keyd/internal/audit/audit_test.go`, `keyd/internal/events/events_test.go`

**Interfaces:**
- Produces (audit): kinds `KindConnect = "connect"`, `KindRequest = "request"`, `KindAdmin = "admin"`,
  `KindKeyd = "keyd"`; decisions `Allow`, `Deny`, `Error`; `Line` (fields and JSON names in
  "Interfaces Part 4b builds on"); `Open(path string) (*Log, error)`, `(*Log).Write(Line) (Line, error)`
  (fills `V`, `Seq`, `Time`, `Prev`, writes surrogates as their IDs, and returns the line as
  written, also on failure), `(*Log).Err() error`, `(*Log).OnWrite(func(Line))`,
  `(*Log).Close() error`, `Verify(r io.Reader) (int, error)`.
- Produces (events): `TypeKeyUse = "key.use"`, `TypeBudget = "budget.exceeded"`, `TypeDropped = "events.dropped"`;
  `Event{Type, Cell string; Time time.Time; Data any}`; `KeyUse{SecretID, Host, Method, Path, Decision}`
  (JSON `secretId host method path decision`, the data of @localdot/protocol's `key.use`);
  `Budget{Scope, TaskID string; LimitUSD, SpentUSD float64}`; `Dropped{Count int}`;
  `NewHub() *Hub`, `(*Hub).Subscribe(buf int) (<-chan Event, func())`, `(*Hub).Publish(Event)`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/audit/audit_test.go`:
```go
package audit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

func openLog(t *testing.T) (*Log, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return l, path
}

func lines(t *testing.T, path string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
}

func TestWriteChainsEachLineToThePrevious(t *testing.T) {
	l, path := openLog(t)
	for _, host := range []string{"a.example.test", "b.example.test", "c.example.test"} {
		if _, err := l.Write(Line{Kind: KindRequest, Cell: "c1", Host: host, Decision: Allow}); err != nil {
			t.Fatal(err)
		}
	}
	got := lines(t, path)
	if len(got) != 3 {
		t.Fatalf("%d lines, want 3", len(got))
	}
	prev := strings.Repeat("0", 64)
	for i, raw := range got {
		var line Line
		if err := json.Unmarshal(raw, &line); err != nil {
			t.Fatal(err)
		}
		if line.Seq != uint64(i+1) || line.Prev != prev || line.V != 1 {
			t.Fatalf("line %d: seq %d prev %s v %d", i+1, line.Seq, line.Prev, line.V)
		}
		if _, err := time.Parse(time.RFC3339Nano, line.Time); err != nil {
			t.Fatalf("line %d time %q: %v", i+1, line.Time, err)
		}
		sum := sha256.Sum256(raw)
		prev = hex.EncodeToString(sum[:])
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, want 0600", info.Mode().Perm())
	}
}

func TestVerifyAcceptsAnIntactLogAndCatchesEdits(t *testing.T) {
	l, path := openLog(t)
	for i := range 4 {
		if _, err := l.Write(Line{Kind: KindRequest, Host: "h.example.test", Status: 200 + i, Decision: Allow}); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 4 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
	all := lines(t, path)
	edited := bytes.Replace(data, []byte(`"status":201`), []byte(`"status":403`), 1)
	dropped := bytes.Join(append(append([][]byte{}, all[:1]...), all[2:]...), []byte("\n"))
	swapped := bytes.Join([][]byte{all[0], all[2], all[1], all[3]}, []byte("\n"))
	for name, bad := range map[string][]byte{"edited": edited, "dropped": dropped, "reordered": swapped} {
		if _, err := Verify(bytes.NewReader(bad)); err == nil {
			t.Errorf("%s log verified", name)
		}
	}
}

func TestOpenResumesTheChain(t *testing.T) {
	l, path := openLog(t)
	if _, err := l.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"}); err != nil {
		t.Fatal(err)
	}
	l.Close()
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	line, err := again.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"})
	if err != nil {
		t.Fatal(err)
	}
	if line.Seq != 2 {
		t.Fatalf("seq %d after reopen, want 2", line.Seq)
	}
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 2 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
}

func TestOpenDropsAPartialLastLineAndSaysSo(t *testing.T) {
	l, path := openLog(t)
	if _, err := l.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"}); err != nil {
		t.Fatal(err)
	}
	l.Close()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"v":1,"seq":2,"tim`)
	f.Close()
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	again.Close()
	got := lines(t, path)
	if len(got) != 2 || !bytes.Contains(got[1], []byte(`"reason":"audit-repair"`)) || !bytes.Contains(got[1], []byte(`"bytesIn":19`)) {
		t.Fatalf("after repair: %s", bytes.Join(got, []byte("\n")))
	}
	data, _ := os.ReadFile(path)
	if _, err := Verify(bytes.NewReader(data)); err != nil {
		t.Fatalf("Verify after repair: %v", err)
	}
}

func TestConcurrentWritesKeepTheChain(t *testing.T) {
	l, path := openLog(t)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			for range 25 {
				if _, err := l.Write(Line{Kind: KindRequest, Decision: Allow}); err != nil {
					t.Error(err)
				}
			}
		})
	}
	wg.Wait()
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 500 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
}

func TestWriteCallsTheHookWithTheWrittenLine(t *testing.T) {
	l, _ := openLog(t)
	var got []Line
	l.OnWrite(func(line Line) { got = append(got, line) })
	if _, err := l.Write(Line{Kind: KindRequest, SecretID: "weather", Decision: Deny, Reason: "misplaced-surrogate"}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Seq != 1 || got[0].SecretID != "weather" {
		t.Fatalf("hook saw %+v", got)
	}
}

// failingFile writes the first keep bytes it is given, then fails, as a full disk does.
type failingFile struct {
	file
	keep int
}

func (f *failingFile) Write(p []byte) (int, error) {
	n, _ := f.file.Write(p[:min(len(p), f.keep)])
	return n, errors.New("no space left on device")
}

func TestAFailedWriteIsCutOffReportedAndCleared(t *testing.T) {
	l, path := openLog(t)
	if _, err := l.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"}); err != nil {
		t.Fatal(err)
	}
	healthy := l.f
	l.f = &failingFile{file: healthy, keep: 10}
	if _, err := l.Write(Line{Kind: KindRequest, Decision: Allow}); err == nil || l.Err() == nil {
		t.Fatalf("a failed write: err %v, Err %v", err, l.Err())
	}
	l.f = healthy
	if _, err := l.Write(Line{Kind: KindRequest, Decision: Deny}); err != nil {
		t.Fatal(err)
	}
	if err := l.Err(); err != nil {
		t.Fatalf("Err after a good write: %v", err)
	}
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 2 {
		t.Fatalf("Verify = %d, %v: the failed write's bytes were left in the chain", n, err)
	}
}

func TestSurrogatesAreWrittenAsTheirIDs(t *testing.T) {
	l, path := openLog(t)
	tok, _ := surrogate.Mint("key")
	var hooked Line
	l.OnWrite(func(line Line) { hooked = line })
	line, err := l.Write(Line{Kind: KindRequest, Method: "GET", Host: tok + ".example.test", Path: "/keys/" + tok, Detail: "lookup " + tok, Decision: Deny})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	named := "surrogate:" + surrogate.ID(tok)
	if strings.Contains(string(data), tok) || strings.Contains(hooked.Path+hooked.Host+hooked.Detail, tok) || line.Path != "/keys/"+named || line.Host != named+".example.test" {
		t.Fatalf("written %s; returned %+v", data, line)
	}
}
```

`keyd/internal/events/events_test.go`:
```go
package events

import (
	"testing"
	"time"
)

func receive(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	select {
	case e, ok := <-ch:
		if !ok {
			t.Fatal("channel closed")
		}
		return e
	case <-time.After(time.Second):
		t.Fatal("no event")
	}
	return Event{}
}

func TestPublishReachesEverySubscriber(t *testing.T) {
	h := NewHub()
	a, cancelA := h.Subscribe(4)
	b, cancelB := h.Subscribe(4)
	defer cancelA()
	defer cancelB()
	h.Publish(Event{Type: TypeKeyUse, Cell: "c1", Data: KeyUse{SecretID: "anthropic", Host: "api.anthropic.com", Method: "POST", Path: "/v1/messages", Decision: "allow"}})
	for _, ch := range []<-chan Event{a, b} {
		e := receive(t, ch)
		if e.Type != TypeKeyUse || e.Cell != "c1" || e.Time.IsZero() {
			t.Fatalf("event %+v", e)
		}
	}
}

func TestCancelClosesTheChannel(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe(1)
	cancel()
	cancel()
	if _, ok := <-ch; ok {
		t.Fatal("channel still open")
	}
	h.Publish(Event{Type: TypeKeyUse})
}

func TestASlowSubscriberDropsAndIsToldHowMany(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe(1)
	defer cancel()
	done := make(chan struct{})
	go func() {
		for range 5 {
			h.Publish(Event{Type: TypeKeyUse})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a full subscriber")
	}
	first := receive(t, ch)
	if first.Type != TypeKeyUse {
		t.Fatalf("first event %+v", first)
	}
	h.Publish(Event{Type: TypeKeyUse})
	next := receive(t, ch)
	if next.Type != TypeDropped || next.Data.(Dropped).Count != 4 {
		t.Fatalf("next event %+v, want a dropped notice for 4", next)
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/audit/ ./internal/events/`
Expected: FAIL — both packages `[build failed]`: `undefined: Log` and `undefined: Open` in audit,
`undefined: Event` in events.

- [ ] **Step 3: Implement the log and the hub**

`keyd/internal/audit/audit.go`:
```go
// Package audit writes keyd's decision log: one JSON line per decision, each line carrying the
// SHA-256 of the line before it, so an edit, a deletion or a reordering breaks the chain.
package audit

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

const (
	KindConnect = "connect"
	KindRequest = "request"
	KindAdmin   = "admin"
	KindKeyd    = "keyd"

	Allow = "allow"
	Deny  = "deny"
	Error = "error"
)

const (
	maxDetail  = 512
	tailWindow = 64 * 1024
)

var genesis = strings.Repeat("0", 64)

// Line never carries a secret value or a surrogate; SurrogateID names a surrogate instead, and
// Write turns surrogate-shaped text in the fields a request controls into surrogate:<ID>.
type Line struct {
	V            int     `json:"v"`
	Seq          uint64  `json:"seq"`
	Time         string  `json:"time"`
	Kind         string  `json:"kind"`
	Cell         string  `json:"cell,omitempty"`
	Port         int     `json:"port,omitempty"`
	Mode         string  `json:"mode,omitempty"`
	Method       string  `json:"method,omitempty"`
	Host         string  `json:"host,omitempty"`
	Path         string  `json:"path,omitempty"`
	SNI          string  `json:"sni,omitempty"`
	Route        string  `json:"route,omitempty"`
	Model        string  `json:"model,omitempty"`
	Status       int     `json:"status,omitempty"`
	BytesIn      int64   `json:"bytesIn,omitempty"`
	BytesOut     int64   `json:"bytesOut,omitempty"`
	DurationMs   float64 `json:"durationMs,omitempty"`
	Decision     string  `json:"decision"`
	Reason       string  `json:"reason,omitempty"`
	SecretID     string  `json:"secretId,omitempty"`
	SurrogateID  string  `json:"surrogateId,omitempty"`
	Swapped      bool    `json:"swapped,omitempty"`
	CostMicroUSD int64   `json:"costMicroUSD,omitempty"`
	Usage        string  `json:"usage,omitempty"`
	Detail       string  `json:"detail,omitempty"`
	Prev         string  `json:"prev"`
}

// file is what Log needs of *os.File; tests put a failing one in its place.
type file interface {
	io.Writer
	io.ReaderAt
	Stat() (os.FileInfo, error)
	Truncate(size int64) error
	Close() error
}

type Log struct {
	mu   sync.Mutex
	f    file
	size int64
	seq  uint64
	prev string
	err  error
	now  func() time.Time
	hook func(Line)
}

// Open appends to path, resuming the chain from its last line. A partial last line, left by a
// crash mid-write, is cut off and the repair is itself recorded.
func Open(path string) (*Log, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return nil, err
	}
	l := &Log{f: f, prev: genesis, now: time.Now}
	partial, err := l.resume()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("audit %s: %w", path, err)
	}
	if partial > 0 {
		if _, err := l.Write(Line{Kind: KindKeyd, Decision: Error, Reason: "audit-repair", BytesIn: partial, Detail: "dropped a partial last line"}); err != nil {
			f.Close()
			return nil, err
		}
	}
	return l, nil
}

func (l *Log) resume() (int64, error) {
	info, err := l.f.Stat()
	if err != nil {
		return 0, err
	}
	size := info.Size()
	start := max(0, size-tailWindow)
	tail := make([]byte, size-start)
	if _, err := l.f.ReadAt(tail, start); err != nil && err != io.EOF {
		return 0, err
	}
	end := bytes.LastIndexByte(tail, '\n') + 1
	partial := int64(len(tail) - end)
	l.size = start + int64(end)
	if partial > 0 {
		if err := l.f.Truncate(l.size); err != nil {
			return 0, err
		}
	}
	if end == 0 {
		if start > 0 {
			return 0, fmt.Errorf("no line end in the last %d bytes", tailWindow)
		}
		return partial, nil
	}
	last := tail[bytes.LastIndexByte(tail[:end-1], '\n')+1 : end-1]
	var line Line
	if err := json.Unmarshal(last, &line); err != nil {
		return 0, fmt.Errorf("last line: %w", err)
	}
	sum := sha256.Sum256(last)
	l.seq, l.prev = line.Seq, hex.EncodeToString(sum[:])
	return partial, nil
}

// OnWrite registers a function called after each line is written.
func (l *Log) OnWrite(fn func(Line)) {
	l.mu.Lock()
	l.hook = fn
	l.mu.Unlock()
}

// Write appends the line and returns it as written, also when it fails. A failed write is kept as
// Err until a later write succeeds, and the bytes it left are cut off first, so a partial line
// never sits inside the chain.
func (l *Log) Write(line Line) (Line, error) {
	line = redact(line)
	l.mu.Lock()
	line.V, line.Seq, line.Prev = 1, l.seq+1, l.prev
	line.Time = l.now().UTC().Format(time.RFC3339Nano)
	if len(line.Detail) > maxDetail {
		line.Detail = line.Detail[:maxDetail]
	}
	raw, err := json.Marshal(line)
	if err == nil {
		err = l.append(raw)
	}
	l.err = err
	if err != nil {
		l.mu.Unlock()
		return line, err
	}
	sum := sha256.Sum256(raw)
	l.seq, l.prev = line.Seq, hex.EncodeToString(sum[:])
	hook := l.hook
	l.mu.Unlock()
	if hook != nil {
		hook(line)
	}
	return line, nil
}

func (l *Log) append(raw []byte) error {
	if l.err != nil {
		if err := l.f.Truncate(l.size); err != nil {
			return err
		}
	}
	n, err := l.f.Write(append(raw, '\n'))
	if err != nil {
		return err
	}
	l.size += int64(n)
	return nil
}

// Err is the last write's error, or nil once a write has succeeded again. keyd swaps no secret
// while it is set: a use of the secret would go unrecorded.
func (l *Log) Err() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.err
}

func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}

// redact writes each surrogate-shaped token in the fields a request controls as surrogate:<ID>.
func redact(l Line) Line {
	for _, field := range []*string{&l.Method, &l.Host, &l.Path, &l.SNI, &l.Route, &l.Model, &l.Detail} {
		for _, tok := range surrogate.Find(*field) {
			*field = strings.ReplaceAll(*field, tok, "surrogate:"+surrogate.ID(tok))
		}
	}
	return l
}

// Verify checks the chain and the sequence numbers and returns how many lines are intact.
func Verify(r io.Reader) (int, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	prev, seq, n := genesis, uint64(0), 0
	for sc.Scan() {
		raw := sc.Bytes()
		var line struct {
			Seq  uint64 `json:"seq"`
			Prev string `json:"prev"`
		}
		if err := json.Unmarshal(raw, &line); err != nil {
			return n, fmt.Errorf("audit line %d: %w", n+1, err)
		}
		if line.Prev != prev {
			return n, fmt.Errorf("audit line %d: chain broken", n+1)
		}
		if line.Seq != seq+1 {
			return n, fmt.Errorf("audit line %d: seq %d after %d", n+1, line.Seq, seq)
		}
		sum := sha256.Sum256(raw)
		prev, seq, n = hex.EncodeToString(sum[:]), line.Seq, n+1
	}
	return n, sc.Err()
}
```

`keyd/internal/events/events.go`:
```go
// Package events fans keyd's notices out to admin-socket subscribers, best effort: the audit log
// is the durable record, and a subscriber that falls behind is told how many events it missed.
package events

import (
	"sync"
	"time"
)

const (
	TypeKeyUse  = "key.use"
	TypeBudget  = "budget.exceeded"
	TypeDropped = "events.dropped"
)

type Event struct {
	Type string    `json:"type"`
	Cell string    `json:"cell,omitempty"`
	Time time.Time `json:"time"`
	Data any       `json:"data,omitempty"`
}

// KeyUse is the data of @localdot/protocol's key.use event.
type KeyUse struct {
	SecretID string `json:"secretId"`
	Host     string `json:"host"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	Decision string `json:"decision"`
}

type Budget struct {
	Scope    string  `json:"scope"`
	TaskID   string  `json:"taskId,omitempty"`
	LimitUSD float64 `json:"limitUSD"`
	SpentUSD float64 `json:"spentUSD"`
}

type Dropped struct {
	Count int `json:"count"`
}

type subscriber struct {
	ch      chan Event
	dropped int
}

type Hub struct {
	mu   sync.Mutex
	subs map[*subscriber]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: map[*subscriber]struct{}{}}
}

// Subscribe returns a channel with room for buf events and a cancel that closes it.
func (h *Hub) Subscribe(buf int) (<-chan Event, func()) {
	s := &subscriber{ch: make(chan Event, buf)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	return s.ch, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, s)
			close(s.ch)
			h.mu.Unlock()
		})
	}
}

// Publish never blocks.
func (h *Hub) Publish(e Event) {
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		if s.dropped > 0 {
			select {
			case s.ch <- Event{Type: TypeDropped, Time: e.Time, Data: Dropped{Count: s.dropped}}:
				s.dropped = 0
			default:
				s.dropped++
				continue
			}
		}
		select {
		case s.ch <- e:
		default:
			s.dropped++
		}
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/audit/ ./internal/events/`
Expected: `ok` for both (8 and 3 tests).

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/audit internal/events
git commit -m "feat(keyd): hash-chained audit log and event hub"
```

---
### Task 6: The per-cell CA — name-constrained, in memory only

Selective interception needs a CA the cell trusts that can vouch only for the hosts keyd
intercepts for that cell. S4 proved Chromium enforces such constraints ("Not permitted by name
constraints"). The CA is an EC P-256 key that never leaves keyd's memory, with critical name
constraints permitting exactly the cell's bound hosts (or the reserved name `invalid` when it has
none), every IP range excluded, a path length of zero and server authentication as its only
extended key usage, so a stolen key could not sign a client, mail or code-signing certificate
either (review 1, M8). `Leaf` refuses any host outside that set
even though the X.509 subtree rule would allow its subdomains; keyd is stricter than the
constraint. The tests forge leaves with the CA's own key, as a thief would, and show that Go's
verifier rejects them.

**Files:**
- Create: `keyd/internal/cellca/cellca.go`
- Test: `keyd/internal/cellca/cellca_test.go`

**Interfaces:**
- Produces: `New(cellID string, hosts []string) (*CA, error)`, `(*CA).Certificate() *x509.Certificate`,
  `(*CA).CertPEM() []byte` (one `CERTIFICATE` block), `(*CA).Hosts() []string` (sorted),
  `(*CA).Leaf(host string) (*tls.Certificate, error)` (cached; renewed a day before it expires;
  `ErrNotPermitted` for any other host). Lifetimes: CA 397 days, leaves 30 days, both starting an
  hour back for clock skew. The CA's `ExtKeyUsage` is `[ServerAuth]`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/cellca/cellca_test.go`:
```go
package cellca

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"testing"
	"time"
)

func pool(ca *CA) *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(ca.Certificate())
	return p
}

func verify(ca *CA, leaf *x509.Certificate, host string) error {
	_, err := leaf.Verify(x509.VerifyOptions{DNSName: host, Roots: pool(ca), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	return err
}

func notAuthorized(err error) bool {
	var inv x509.CertificateInvalidError
	return errors.As(err, &inv) && inv.Reason == x509.CANotAuthorizedForThisName
}

// forge signs a leaf with the CA's own key, as a stolen key would; it is a server certificate
// unless usages say otherwise.
func forge(t *testing.T, ca *CA, dns []string, ips []net.IP, usages ...x509.ExtKeyUsage) *x509.Certificate {
	t.Helper()
	if len(usages) == 0 {
		usages = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(99),
		Subject:      pkix.Name{CommonName: "forged"},
		DNSNames:     dns,
		IPAddresses:  ips,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  usages,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return cert
}

func TestNewIsAConstrainedCA(t *testing.T) {
	ca, err := New("cell-1", []string{"api.example.test", "postman-echo.com"})
	if err != nil {
		t.Fatal(err)
	}
	c := ca.Certificate()
	if !c.IsCA || !c.MaxPathLenZero || c.MaxPathLen != 0 || !c.PermittedDNSDomainsCritical {
		t.Fatalf("CA flags: IsCA %v MaxPathLenZero %v critical %v", c.IsCA, c.MaxPathLenZero, c.PermittedDNSDomainsCritical)
	}
	if len(c.PermittedDNSDomains) != 2 || c.PermittedDNSDomains[0] != "api.example.test" {
		t.Fatalf("permitted %v", c.PermittedDNSDomains)
	}
	if len(c.ExcludedIPRanges) != 2 {
		t.Fatalf("excluded IP ranges %v, want all of IPv4 and IPv6", c.ExcludedIPRanges)
	}
	if _, ok := c.PublicKey.(*ecdsa.PublicKey); !ok {
		t.Fatalf("CA key %T, want ECDSA P-256", c.PublicKey)
	}
}

func TestLeafVerifiesForAPermittedHost(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	cert, err := ca.Leaf("api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	if err := verify(ca, cert.Leaf, "api.example.test"); err != nil {
		t.Fatal(err)
	}
	if cert.Leaf.NotAfter.After(ca.Certificate().NotAfter) {
		t.Fatal("leaf outlives its CA")
	}
}

func TestLeafRefusesHostsOutsideTheConstraints(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	for _, host := range []string{"example.com", "evil.test", "x.api.example.test", ""} {
		if _, err := ca.Leaf(host); !errors.Is(err, ErrNotPermitted) {
			t.Errorf("Leaf(%q) err = %v, want ErrNotPermitted", host, err)
		}
	}
}

func TestVerifiersRejectForgedLeavesOutsideTheConstraints(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	if err := verify(ca, forge(t, ca, []string{"bank.example"}, nil), "bank.example"); !notAuthorized(err) {
		t.Fatalf("forged leaf for an unlisted name: %v", err)
	}
	if err := verify(ca, forge(t, ca, nil, []net.IP{net.ParseIP("93.184.215.14")}), "93.184.215.14"); !notAuthorized(err) {
		t.Fatalf("forged leaf for an IP address: %v", err)
	}
}

func TestTheCAVouchesOnlyForServers(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	if eku := ca.Certificate().ExtKeyUsage; len(eku) != 1 || eku[0] != x509.ExtKeyUsageServerAuth {
		t.Fatalf("CA extended key usage %v, want server auth only", eku)
	}
	for _, usage := range []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageCodeSigning, x509.ExtKeyUsageEmailProtection} {
		leaf := forge(t, ca, []string{"api.example.test"}, nil, usage)
		_, err := leaf.Verify(x509.VerifyOptions{DNSName: "api.example.test", Roots: pool(ca), KeyUsages: []x509.ExtKeyUsage{usage}})
		var inv x509.CertificateInvalidError
		if !errors.As(err, &inv) || inv.Reason != x509.IncompatibleUsage {
			t.Errorf("a forged leaf for usage %v: %v", usage, err)
		}
	}
}

func TestACellWithoutHostsCanVouchForNothingReal(t *testing.T) {
	ca, err := New("cell-2", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := ca.Certificate().PermittedDNSDomains; len(got) != 1 || got[0] != "invalid" {
		t.Fatalf("permitted %v, want [invalid]", got)
	}
	if err := verify(ca, forge(t, ca, []string{"example.com"}, nil), "example.com"); !notAuthorized(err) {
		t.Fatalf("a host-less CA and example.com: %v", err)
	}
}

func TestLeavesAreCachedAndRenewed(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	now := time.Now()
	ca.now = func() time.Time { return now }
	a, _ := ca.Leaf("api.example.test")
	b, _ := ca.Leaf("api.example.test")
	if a != b {
		t.Fatal("second Leaf minted a new certificate")
	}
	now = a.Leaf.NotAfter.Add(-12 * time.Hour)
	c, _ := ca.Leaf("api.example.test")
	if c == a {
		t.Fatal("a leaf about to expire was reused")
	}
}

func TestCellsDoNotShareKeys(t *testing.T) {
	a, _ := New("cell-a", []string{"api.example.test"})
	b, _ := New("cell-b", []string{"api.example.test"})
	leaf, _ := a.Leaf("api.example.test")
	if err := verify(b, leaf.Leaf, "api.example.test"); err == nil {
		t.Fatal("cell b's CA accepted cell a's leaf")
	}
}

func TestCertPEMHoldsOnlyTheCertificate(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	pemBytes := ca.CertPEM()
	block, rest := pem.Decode(pemBytes)
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		t.Fatalf("CertPEM is not exactly one certificate: %s", pemBytes)
	}
	if bytes.Contains(pemBytes, []byte("PRIVATE")) {
		t.Fatal("CertPEM mentions a private key")
	}
	parsed, _ := x509.ParseCertificate(block.Bytes)
	if !parsed.Equal(ca.Certificate()) {
		t.Fatal("CertPEM is not the CA certificate")
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/cellca/`
Expected: FAIL — `[build failed]`, starting `internal/cellca/cellca_test.go:18:15: undefined: CA`.

- [ ] **Step 3: Implement the CA**

`keyd/internal/cellca/cellca.go`:
```go
// Package cellca is a cell's own certificate authority: an EC P-256 key that exists only in
// keyd's memory and an X.509 name constraint that limits it to the hosts keyd intercepts for that
// cell, so even a stolen key could not impersonate any other site, nor sign anything but a server
// certificate.
package cellca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"slices"
	"sync"
	"time"
)

var ErrNotPermitted = errors.New("cellca: not one of this cell's intercepted hosts")

const (
	caLifetime   = 397 * 24 * time.Hour
	leafLifetime = 30 * 24 * time.Hour
	renewBefore  = 24 * time.Hour
)

type CA struct {
	cert    *x509.Certificate
	certPEM []byte
	key     *ecdsa.PrivateKey
	leafKey *ecdsa.PrivateKey
	hosts   map[string]bool
	now     func() time.Time
	mu      sync.Mutex
	leaves  map[string]*tls.Certificate
}

// New makes a CA permitted to vouch only for hosts. With no hosts it is constrained to the
// reserved name "invalid", so it can vouch for nothing real.
func New(cellID string, hosts []string) (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	permitted := slices.Clone(hosts)
	if len(permitted) == 0 {
		permitted = []string{"invalid"}
	}
	unit := cellID
	if len(unit) > 64 {
		unit = unit[:64]
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:                serial(),
		Subject:                     pkix.Name{CommonName: "localDot cell CA", Organization: []string{"localDot"}, OrganizationalUnit: []string{unit}},
		NotBefore:                   now.Add(-time.Hour),
		NotAfter:                    now.Add(caLifetime),
		IsCA:                        true,
		BasicConstraintsValid:       true,
		MaxPathLen:                  0,
		MaxPathLenZero:              true,
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:                 []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         permitted,
		ExcludedIPRanges: []*net.IPNet{
			{IP: net.IP{0, 0, 0, 0}, Mask: net.CIDRMask(0, 32)},
			{IP: net.IPv6zero, Mask: net.CIDRMask(0, 128)},
		},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, h := range hosts {
		allowed[h] = true
	}
	return &CA{
		cert:    cert,
		certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		key:     key,
		leafKey: leafKey,
		hosts:   allowed,
		now:     time.Now,
		leaves:  map[string]*tls.Certificate{},
	}, nil
}

func (ca *CA) Certificate() *x509.Certificate { return ca.cert }

// CertPEM is the public certificate the cell installs as a trust anchor.
func (ca *CA) CertPEM() []byte { return slices.Clone(ca.certPEM) }

// Hosts are the exact hosts this CA serves leaves for, sorted.
func (ca *CA) Hosts() []string {
	out := make([]string, 0, len(ca.hosts))
	for h := range ca.hosts {
		out = append(out, h)
	}
	slices.Sort(out)
	return out
}

// Leaf returns a server certificate for host, minting or renewing it as needed.
func (ca *CA) Leaf(host string) (*tls.Certificate, error) {
	if !ca.hosts[host] {
		return nil, ErrNotPermitted
	}
	ca.mu.Lock()
	defer ca.mu.Unlock()
	now := ca.now()
	if c, ok := ca.leaves[host]; ok && now.Before(c.Leaf.NotAfter.Add(-renewBefore)) {
		return c, nil
	}
	notAfter := now.Add(leafLifetime)
	if notAfter.After(ca.cert.NotAfter) {
		notAfter = ca.cert.NotAfter
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: host},
		DNSNames:              []string{host},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &ca.leafKey.PublicKey, ca.key)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	c := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: ca.leafKey, Leaf: leaf}
	ca.leaves[host] = c
	return c, nil
}

func serial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		panic(err)
	}
	return n
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/cellca/`
Expected: `ok` (9 tests). The forged-leaf tests fail verification with
`x509: a root or intermediate certificate is not authorized to sign for this name`.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/cellca
git commit -m "feat(keyd): per-cell name-constrained CA"
```

---
### Task 7: The scrubber — real values never flow back into a cell

S4: "postman-echo reflected `real-secret-value-for-spike` into the cell." The spec: "The real
secret is scrubbed from responses in plain, base64, URL-encoded and hex forms." The scrubber
replaces each form of each secret with the same form of the cell's surrogate (or the marker
`keyd-redacted` when the cell holds none, P4a-R18): the plain value, lower and upper hex, and
padded and unpadded standard and URL-safe base64. Each of these forms also matches with any of its
bytes escaped the way an encoder may escape it, byte by byte: percent-encoded in either case (or `+`
for a space), JSON's backslash-u in either case or its short escapes, HTML's named and numeric
references. That covers Go's `json.Marshal` (which escapes `<`, `>` and `&`), .NET's encoder (which
also escapes `+`, `'` and `"`), JavaScript's `encodeURIComponent`, Python's `quote`, PHP's `\/` and
`html.EscapeString`, and any mix of them; a replacement must be made of characters no encoder
escapes, so it fits whichever form it replaces. Escapes of the bytes those encoders leave alone
(letters, digits and `-._~`, so `%7E` from Java's `URLEncoder`), `&#X3C;` with a capital X and
numeric references padded past three digits are not matched (P4a-R18). The backslash-u forms are
built in code rather than written out, because a tool that handled the first draft of this plan
turned every one it saw into the character it stood for, which left the Go escape rule a no-op that
its test could not catch (review 1, I1). Inside a longer base64 value the secret's characters
depend on its byte offset mod 3, so the characters set by the secret's bits alone are matched at all
three offsets and overwritten; that is what destroys a reflected `Basic base64(user:secret)`. As a
stream, it holds back only a tail that could still grow into a match, so an SSE event is never
delayed (a chunk that cannot start a secret passes at once), and an upstream error drops the held
tail rather than release half a secret. Compressed bodies are handled one level up (Task 10): keyd
asks for gzip only and decodes a lone gzip itself, and any other coding, or a second one, is refused
(P4a-R10).

**Files:**
- Create: `keyd/internal/scrub/scrub.go`
- Test: `keyd/internal/scrub/scrub_test.go`

**Interfaces:**
- Produces: `Pair{Secret, Replacement []byte}`, `New(pairs ...Pair) (*Scrubber, error)` (refuses a
  secret shorter than 8 bytes, and a replacement with a character outside A–Z a–z 0–9 `-._~`),
  `(*Scrubber).Bytes([]byte) []byte`, `(*Scrubber).Header(http.Header)`
  (in place), `(*Scrubber).Reader(io.ReadCloser) io.ReadCloser`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/scrub/scrub_test.go`:
```go
package scrub

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

const (
	secret    = "real-secret-value+for/test="
	surrogate = "ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA"
	// punct holds the characters URL, JSON and HTML encoders escape differently.
	punct = `real<secret>&value+'q"/= \x`
)

func scrubber(t *testing.T) *Scrubber {
	t.Helper()
	s, err := New(Pair{Secret: []byte(secret), Replacement: []byte(surrogate)})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func b64(enc *base64.Encoding, s string) string { return enc.EncodeToString([]byte(s)) }

func assertClean(t *testing.T, name string, out []byte) {
	t.Helper()
	for _, form := range []string{secret, hex.EncodeToString([]byte(secret)), url.QueryEscape(secret)} {
		if bytes.Contains(out, []byte(form)) {
			t.Fatalf("%s: output still holds %q: %s", name, form, out)
		}
	}
}

func TestEveryEncodingOfTheSecretIsReplaced(t *testing.T) {
	s := scrubber(t)
	cases := map[string][2]string{
		"plain":         {"key=" + secret + ";", "key=" + surrogate + ";"},
		"hex":           {hex.EncodeToString([]byte(secret)), hex.EncodeToString([]byte(surrogate))},
		"HEX":           {strings.ToUpper(hex.EncodeToString([]byte(secret))), strings.ToUpper(hex.EncodeToString([]byte(surrogate)))},
		"query escape":  {"?k=" + url.QueryEscape(secret), "?k=" + url.QueryEscape(surrogate)},
		"path escape":   {"/" + url.PathEscape(secret), "/" + url.PathEscape(surrogate)},
		"lower percent": {strings.NewReplacer("%2B", "%2b", "%2F", "%2f", "%3D", "%3d").Replace(url.QueryEscape(secret)), surrogate},
		"base64 std":    {b64(base64.StdEncoding, secret), b64(base64.StdEncoding, surrogate)},
		"base64 url":    {b64(base64.URLEncoding, secret), b64(base64.URLEncoding, surrogate)},
		"base64 raw":    {b64(base64.RawStdEncoding, secret), b64(base64.RawStdEncoding, surrogate)},
		"json":          {mustJSON(secret), mustJSON(surrogate)},
	}
	for name, c := range cases {
		got := string(s.Bytes([]byte(c[0])))
		if got != c[1] {
			t.Errorf("%s: %q -> %q, want %q", name, c[0], got, c[1])
		}
	}
}

func mustJSON(v string) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// dotnet escapes as .NET's System.Text.Json does by default: the HTML-sensitive characters, + and
// the backtick as upper-case backslash-u, a backslash as two.
func dotnet(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case strings.IndexByte("<>&'\"+`", c) >= 0:
			fmt.Fprintf(&b, `\`+"u%04X", c)
		case c == '\\':
			b.WriteString(`\\`)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// percentEncode escapes every byte but letters, digits and keep, as JavaScript's encodeURIComponent
// (keep -_.!~*'()) and Python's quote (keep _.-~/) do.
func percentEncode(s, keep string, lower bool) string {
	f := "%%%02X"
	if lower {
		f = "%%%02x"
	}
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, f, c)
	}
	return b.String()
}

func TestEscapedReflectionsAreReplaced(t *testing.T) {
	s, err := New(Pair{Secret: []byte(punct), Replacement: []byte(surrogate)})
	if err != nil {
		t.Fatal(err)
	}
	goJSON := mustJSON(punct)
	if !strings.Contains(goJSON, `\`+"u003c") || !strings.Contains(goJSON, `\`+"u0026") {
		t.Fatalf("json.Marshal(%q) = %s: Go escapes < and & no more, so this test checks nothing", punct, goJSON)
	}
	cases := map[string][2]string{
		"Go's json.Marshal":   {goJSON, mustJSON(surrogate)},
		".NET's JSON":         {`"` + dotnet(punct) + `"`, `"` + surrogate + `"`},
		"html.EscapeString":   {"<p>" + html.EscapeString(punct) + "</p>", "<p>" + surrogate + "</p>"},
		"url.QueryEscape":     {"?k=" + url.QueryEscape(punct), "?k=" + surrogate},
		"encodeURIComponent":  {"?k=" + percentEncode(punct, "-_.!~*'()", false), "?k=" + surrogate},
		"Python's quote":      {"/" + percentEncode(punct, "_.-~/", false), "/" + surrogate},
		"lower-case percents": {percentEncode(punct, "", true), surrogate},
	}
	for name, c := range cases {
		if got := string(s.Bytes([]byte(c[0]))); got != c[1] {
			t.Errorf("%s: %q -> %q, want %q", name, c[0], got, c[1])
		}
	}
}

func TestEscapedReflectionsStreamLikeOneShot(t *testing.T) {
	s, _ := New(Pair{Secret: []byte(punct), Replacement: []byte(surrogate)})
	body := "a " + mustJSON(punct) + " b " + html.EscapeString(punct) + " c " + dotnet(punct) + " d " + url.QueryEscape(punct) + "\n"
	want := "a " + mustJSON(surrogate) + " b " + surrogate + " c " + surrogate + " d " + surrogate + "\n"
	if got := string(s.Bytes([]byte(body))); got != want {
		t.Fatalf("one shot: %q, want %q", got, want)
	}
	for split := 1; split < len(body); split++ {
		if got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: []string{body[:split], body[split:]}}))); got != want {
			t.Fatalf("split at %d: %q, want %q", split, got, want)
		}
	}
	if got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: strings.Split(body, "")}))); got != want {
		t.Fatalf("byte by byte: %q, want %q", got, want)
	}
}

func TestBase64EmbeddedAtAnyOffsetIsDestroyed(t *testing.T) {
	s := scrubber(t)
	for _, prefix := range []string{"", "u", "us", "user:", "ab:", "x:"} {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding} {
			blob := enc.EncodeToString([]byte(prefix + secret + "&tail"))
			out := s.Bytes([]byte("Basic " + blob))
			decoded, _ := enc.DecodeString(strings.TrimPrefix(string(out), "Basic "))
			if bytes.Contains(decoded, []byte(secret)) || bytes.Contains(out, []byte(blob)) {
				t.Errorf("prefix %q: the secret survives in %s", prefix, out)
			}
		}
	}
}

func TestStreamingMatchesOneShotAtEverySplit(t *testing.T) {
	s := scrubber(t)
	body := "{\"echo\":\"" + secret + "\",\"b64\":\"" + b64(base64.StdEncoding, "user:"+secret) + "\",\"hex\":\"" + hex.EncodeToString([]byte(secret)) + "\"}\n"
	want := string(s.Bytes([]byte(body)))
	assertClean(t, "one shot", []byte(want))
	for split := 1; split < len(body); split++ {
		got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: []string{body[:split], body[split:]}})))
		if got != want {
			t.Fatalf("split at %d: %q, want %q", split, got, want)
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		var parts []string
		for rest := body; rest != ""; {
			n := min(len(rest), 1+rng.IntN(7))
			parts = append(parts, rest[:n])
			rest = rest[n:]
		}
		if got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: parts}))); got != want {
			t.Fatalf("parts %q: %q, want %q", parts, got, want)
		}
	}
}

func TestReadNeverReturnsPartOfTheSecret(t *testing.T) {
	s := scrubber(t)
	body := "aaaa" + secret + "bbbb" + secret
	r := s.Reader(io.NopCloser(&chunked{parts: strings.Split(body, "")}))
	var all []byte
	buf := make([]byte, 3)
	for {
		n, err := r.Read(buf)
		all = append(all, buf[:n]...)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	assertClean(t, "byte by byte", all)
}

func TestAChunkThatCannotStartTheSecretIsNotHeldBack(t *testing.T) {
	s := scrubber(t)
	pr, pw := io.Pipe()
	r := s.Reader(pr)
	go pw.Write([]byte("data: {\"delta\":\"hi\"}\n\n"))
	got := make(chan string, 1)
	go func() {
		buf := make([]byte, 64)
		n, _ := r.Read(buf)
		got <- string(buf[:n])
	}()
	select {
	case g := <-got:
		if g != "data: {\"delta\":\"hi\"}\n\n" {
			t.Fatalf("read %q", g)
		}
	case <-time.After(time.Second):
		t.Fatal("an SSE event was held back waiting for more data")
	}
	pw.Close()
}

func TestAnUpstreamErrorDropsTheHeldBytes(t *testing.T) {
	s := scrubber(t)
	boom := errors.New("upstream reset")
	r := s.Reader(io.NopCloser(&chunked{parts: []string{"ok " + secret[:10]}, err: boom}))
	data, err := io.ReadAll(r)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the upstream error", err)
	}
	if string(data) != "ok " {
		t.Fatalf("data = %q, want only the bytes that cannot be part of the secret", data)
	}
}

func TestHeaderValuesAreScrubbed(t *testing.T) {
	s := scrubber(t)
	h := http.Header{
		"Location":   {"https://cdn.example.test/file?key=" + url.QueryEscape(secret)},
		"Set-Cookie": {"k=" + secret + "; Path=/"},
		"X-Echo":     {secret},
	}
	s.Header(h)
	for k, vs := range h {
		for _, v := range vs {
			assertClean(t, k, []byte(v))
		}
	}
	if h.Get("X-Echo") != surrogate {
		t.Fatalf("X-Echo = %q", h.Get("X-Echo"))
	}
}

func TestNewRefusesShortSecretsAndEmptyIsANoOp(t *testing.T) {
	if _, err := New(Pair{Secret: []byte("short"), Replacement: []byte(surrogate)}); err == nil {
		t.Fatal("New accepted a 5-byte secret")
	}
	if _, err := New(Pair{Secret: []byte(secret), Replacement: []byte("a/b")}); err == nil {
		t.Fatal("New accepted a replacement an encoder would change")
	}
	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Bytes([]byte(secret)); string(got) != secret {
		t.Fatalf("empty scrubber changed %q", got)
	}
}

func TestCloseClosesTheSource(t *testing.T) {
	src := &closeRecorder{Reader: strings.NewReader("x")}
	if err := scrubber(t).Reader(src).Close(); err != nil || !src.closed {
		t.Fatalf("Close err %v closed %v", err, src.closed)
	}
}

type chunked struct {
	parts []string
	err   error
}

func (c *chunked) Read(p []byte) (int, error) {
	if len(c.parts) == 0 {
		if c.err != nil {
			return 0, c.err
		}
		return 0, io.EOF
	}
	n := copy(p, c.parts[0])
	c.parts[0] = c.parts[0][n:]
	if c.parts[0] == "" {
		c.parts = c.parts[1:]
	}
	return n, nil
}

type closeRecorder struct {
	io.Reader
	closed bool
}

func (c *closeRecorder) Close() error { c.closed = true; return nil }

func readAll(t *testing.T, r io.Reader) string {
	t.Helper()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/scrub/`
Expected: FAIL — `[build failed]`, starting `internal/scrub/scrub_test.go:27:30: undefined: Scrubber`.

- [ ] **Step 3: Implement the scrubber**

`keyd/internal/scrub/scrub.go`:
```go
// Package scrub removes real secrets from what keyd sends back into a cell: the plain value and its
// hex and base64 forms, in headers and in streamed bodies, where a value may arrive split across
// reads. Each form also matches with any of its bytes escaped as URL, JSON or HTML encoders escape
// them, byte by byte, so an echo from any encoder, or a mix of them, is caught.
package scrub

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
)

const (
	minSecret = 8
	minCore   = 8
)

// Pair is a secret and what replaces it: the cell's surrogate, or a marker when it has none.
type Pair struct {
	Secret      []byte
	Replacement []byte
}

type needle struct {
	find, repl []byte
}

type Scrubber struct {
	needles []needle
	first   [256]bool
}

func New(pairs ...Pair) (*Scrubber, error) {
	s := &Scrubber{}
	seen := map[string]bool{}
	for _, p := range pairs {
		if len(p.Secret) < minSecret {
			return nil, fmt.Errorf("scrub: a secret shorter than %d bytes would match too much", minSecret)
		}
		if slices.ContainsFunc(p.Replacement, func(b byte) bool { return !unreserved(b) }) {
			return nil, errors.New("scrub: a replacement must be letters, digits and -._~, which no encoder escapes")
		}
		for _, n := range forms(p.Secret, p.Replacement) {
			if len(n.find) == 0 || seen[string(n.find)] {
				continue
			}
			seen[string(n.find)] = true
			s.needles = append(s.needles, n)
			s.first[n.find[0]] = true
			for _, alt := range escapes[n.find[0]] {
				s.first[alt[0]] = true
			}
		}
	}
	return s, nil
}

// Bytes scrubs a complete value.
func (s *Scrubber) Bytes(b []byte) []byte {
	out, _ := s.scan(b, true)
	return out
}

// Header scrubs every value in place.
func (s *Scrubber) Header(h http.Header) {
	for _, vs := range h {
		for i, v := range vs {
			vs[i] = string(s.Bytes([]byte(v)))
		}
	}
}

// Reader scrubs a stream. It holds back only a tail that could still grow into a match, so a
// chunk that cannot start a secret is passed on at once. An error other than EOF drops the held
// tail rather than release part of a secret.
func (s *Scrubber) Reader(src io.ReadCloser) io.ReadCloser {
	return &reader{src: src, s: s, buf: make([]byte, 32*1024)}
}

// scan replaces every complete match in data. Unless final, it stops before a position where a
// match could still complete with more data, and reports how much it consumed.
func (s *Scrubber) scan(data []byte, final bool) ([]byte, int) {
	if len(s.needles) == 0 {
		return append([]byte(nil), data...), len(data)
	}
	out := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		if !s.first[data[i]] {
			j := i + 1
			for j < len(data) && !s.first[data[j]] {
				j++
			}
			out = append(out, data[i:j]...)
			i = j
			continue
		}
		best, repl := 0, []byte(nil)
		for _, n := range s.needles {
			end, more := match(n.find, data[i:])
			if more && !final {
				return out, i
			}
			if end > best {
				best, repl = end, n.repl
			}
		}
		if best > 0 {
			out = append(out, repl...)
			i += best
			continue
		}
		out = append(out, data[i])
		i++
	}
	return out, i
}

// match returns the length of the longest start of data that spells find, each byte as itself or
// as one of its escapes (0 when none does), and whether data ran out where a spelling could go on.
func match(find, data []byte) (int, bool) {
	at := []int{0}
	more := false
	for _, b := range find {
		var next []int
		for _, p := range at {
			rest := data[p:]
			if len(rest) == 0 {
				more = true
				continue
			}
			if rest[0] == b {
				next = appendNew(next, p+1)
			}
			for _, alt := range escapes[b] {
				switch {
				case len(rest) >= len(alt):
					if string(rest[:len(alt)]) == alt {
						next = appendNew(next, p+len(alt))
					}
				case string(rest) == alt[:len(rest)]:
					more = true
				}
			}
		}
		if len(next) == 0 {
			return 0, more
		}
		at = next
	}
	return slices.Max(at), more
}

func appendNew(s []int, v int) []int {
	if slices.Contains(s, v) {
		return s
	}
	return append(s, v)
}

type reader struct {
	src     io.ReadCloser
	s       *Scrubber
	buf     []byte
	pending []byte
	out     []byte
	err     error
}

func (r *reader) Read(p []byte) (int, error) {
	for len(r.out) == 0 {
		if r.err != nil {
			if r.err == io.EOF && len(r.pending) > 0 {
				r.out, _ = r.s.scan(r.pending, true)
				r.pending = nil
				break
			}
			r.pending = nil
			return 0, r.err
		}
		n, err := r.src.Read(r.buf)
		r.err = err
		r.pending = append(r.pending, r.buf[:n]...)
		out, consumed := r.s.scan(r.pending, false)
		r.pending = append([]byte(nil), r.pending[consumed:]...)
		r.out = out
	}
	n := copy(p, r.out)
	r.out = r.out[n:]
	return n, nil
}

func (r *reader) Close() error { return r.src.Close() }

func forms(secret, repl []byte) []needle {
	var out []needle
	add := func(find, rep string) { out = append(out, needle{[]byte(find), []byte(rep)}) }
	add(string(secret), string(repl))
	add(hex.EncodeToString(secret), hex.EncodeToString(repl))
	add(strings.ToUpper(hex.EncodeToString(secret)), strings.ToUpper(hex.EncodeToString(repl)))
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.RawURLEncoding} {
		add(enc.EncodeToString(secret), enc.EncodeToString(repl))
	}
	// Inside a longer base64 value the secret's characters depend on its byte offset mod 3; the
	// characters set by the secret's bits alone are the same wherever it sits.
	for _, enc := range []*base64.Encoding{base64.RawStdEncoding, base64.RawURLEncoding} {
		for k := range 3 {
			e := enc.EncodeToString(append(make([]byte, k), secret...))
			core := e[(4*k+2)/3 : 4*(k+len(secret))/3]
			if len(core) >= minCore {
				add(core, strings.Repeat("A", len(core)))
			}
		}
	}
	return out
}

// escapes lists, for each printable byte outside A-Z a-z 0-9 and -._~, the spellings encoders give
// it: percent-encoding in either case (and + for a space), JSON's backslash-u in either case and
// its short escapes, and HTML's named and numeric references. The backslash-u spellings are built
// here rather than written out, so nothing that handles this file can unescape them.
var escapes = func() (t [256][]string) {
	named := map[byte][]string{
		' ': {"+"}, '"': {`\"`, "&quot;"}, '&': {"&amp;"}, '\'': {"&apos;"}, '/': {`\/`},
		'<': {"&lt;"}, '>': {"&gt;"}, '\\': {`\\`},
	}
	for b := byte(0x20); b < 0x7f; b++ {
		if unreserved(b) {
			continue
		}
		alts := slices.Clone(named[b])
		for _, f := range []string{"%%%02X", "%%%02x", `\` + "u%04X", `\` + "u%04x", "&#%d;", "&#%03d;", "&#x%X;", "&#x%x;"} {
			alts = append(alts, fmt.Sprintf(f, b))
		}
		slices.Sort(alts)
		t[b] = slices.Compact(alts)
	}
	return t
}()

func unreserved(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '-' || b == '.' || b == '_' || b == '~'
}
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/scrub/`
Expected: `ok` (11 tests; the split tests feed every two-chunk split, and the plain one 200 random
chunkings too). `TestEscapedReflectionsAreReplaced` first checks that `json.Marshal` still escapes
`<` and `&`, so the Go case can fail.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/scrub
git commit -m "feat(keyd): streaming response scrubber"
```

---
### Task 8: Egress policy — by role, by port, by name

"Default egress: brain → the LLM gateway only. Desktop → the web and package registries, minus a
deny list and the SSRF set. Signed-in browser → the web." Policy works on names; the guard (Task 4)
works on addresses. IP literals are refused outright, because a literal skips the name rules and
carries no SNI to check (P4a-R5), and so is any name whose last label is not a top-level domain's
shape — letters, or an IDN's `xn--` form — which is how `127.1` and `0x7f.0x1` (which macOS's
resolver turns into 127.0.0.1) pass for names (review 1, M1). CONNECT goes only to port 443 and
plain HTTP only to port 80. A host one of the cell's surrogates is bound to is always reachable for
that cell, over CONNECT, and is intercepted. The deny list matches whole labels: local and reserved
names that no cell may reach by name.

**Files:**
- Create: `keyd/internal/policy/policy.go`
- Test: `keyd/internal/policy/policy_test.go`

**Interfaces:**
- Produces: reasons `ReasonHostInvalid = "host-invalid"`, `ReasonIPLiteral = "ip-literal"`,
  `ReasonPort = "port-not-allowed"`, `ReasonHostDenied = "host-denied"`, `ReasonNoWeb = "web-not-allowed"`;
  `Role` (`Brain`, `Desktop`, `Browser`), `Policy{Role; Web, Gateway bool}`, `ForRole(Role) (Policy, error)`;
  `Target{Host string; Port int}`, `Decision{Allow, MITM bool; Reason string}`;
  `ParseHostPort(hostport string, defaultPort int) (Target, string)` (0 makes the port required;
  lower-cases, drops one trailing dot); `(Policy).Connect(t Target, intercepted map[string]bool) Decision`;
  `(Policy).PlainHTTP(t Target) Decision`; `Denied(host string) bool`;
  `ValidBindingHost(host string) error`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/policy/policy_test.go`:
```go
package policy

import (
	"strings"
	"testing"
)

func TestParseHostPortNormalisesNames(t *testing.T) {
	cases := map[string]Target{
		"API.Example.TEST:443":      {Host: "api.example.test", Port: 443},
		"api.example.test.:443":     {Host: "api.example.test", Port: 443},
		"xn--bcher-kva.example:443": {Host: "xn--bcher-kva.example", Port: 443},
		"xn--d1acufc.xn--p1ai:443":  {Host: "xn--d1acufc.xn--p1ai", Port: 443},
	}
	for in, want := range cases {
		got, reason := ParseHostPort(in, 0)
		if reason != "" || got != want {
			t.Errorf("ParseHostPort(%q) = %+v, %q; want %+v", in, got, reason, want)
		}
	}
	if got, reason := ParseHostPort("example.test", 80); reason != "" || got.Port != 80 {
		t.Errorf("default port: %+v %q", got, reason)
	}
	if _, reason := ParseHostPort("[::ffff:127.0.0.1]", 80); reason != ReasonIPLiteral {
		t.Errorf("bracketed literal without a port: %q", reason)
	}
}

func TestParseHostPortRefusesWhatPolicyCannotName(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:443":                          ReasonIPLiteral,
		"[::1]:443":                              ReasonIPLiteral,
		"[::ffff:127.0.0.1]:443":                 ReasonIPLiteral,
		"0.0.0.0:443":                            ReasonIPLiteral,
		"[::]:443":                               ReasonIPLiteral,
		"2130706433:443":                         ReasonHostInvalid,
		"0x7f.0x1:443":                           ReasonHostInvalid,
		"0x7f.0x0.0x0.0x1:443":                   ReasonHostInvalid,
		"api.example.c0m:443":                    ReasonHostInvalid,
		"localhost:443":                          ReasonHostInvalid,
		"metadata:80":                            ReasonHostInvalid,
		"bad_host.example:443":                   ReasonHostInvalid,
		"user@example.test:443":                  ReasonHostInvalid,
		"-x.example.test:443":                    ReasonHostInvalid,
		"a..b.example:443":                       ReasonHostInvalid,
		"example.test:0":                         ReasonHostInvalid,
		"example.test:99999":                     ReasonHostInvalid,
		"example.test":                           ReasonHostInvalid,
		strings.Repeat("a", 64) + ".example:443": ReasonHostInvalid,
		"bücher.example:443":                     ReasonHostInvalid,
	}
	for in, want := range cases {
		if _, reason := ParseHostPort(in, 0); reason != want {
			t.Errorf("ParseHostPort(%q) reason %q, want %q", in, reason, want)
		}
	}
}

func TestDenyList(t *testing.T) {
	for _, h := range []string{"foo.localhost", "printer.local", "metadata.google.internal", "nas.home.arpa", "router.lan", "llm.ldot", "keyd.ldot"} {
		if !Denied(h) {
			t.Errorf("%s is not denied", h)
		}
	}
	for _, h := range []string{"example.com", "api.example.test", "localhost.example.com", "local.example.com", "notldot.example"} {
		if Denied(h) {
			t.Errorf("%s is denied", h)
		}
	}
}

func TestRoles(t *testing.T) {
	cases := map[Role]Policy{
		Brain:   {Role: Brain, Gateway: true},
		Desktop: {Role: Desktop, Web: true},
		Browser: {Role: Browser, Web: true},
	}
	for role, want := range cases {
		got, err := ForRole(role)
		if err != nil || got != want {
			t.Errorf("ForRole(%s) = %+v, %v", role, got, err)
		}
	}
	if _, err := ForRole("root"); err == nil {
		t.Fatal("unknown role accepted")
	}
}

func TestConnectDecisions(t *testing.T) {
	desktop, _ := ForRole(Desktop)
	brain, _ := ForRole(Brain)
	bound := map[string]bool{"api.example.test": true}
	cases := []struct {
		name   string
		p      Policy
		target Target
		want   Decision
	}{
		{"desktop passthrough", desktop, Target{"example.com", 443}, Decision{Allow: true}},
		{"desktop bound host is intercepted", desktop, Target{"api.example.test", 443}, Decision{Allow: true, MITM: true}},
		{"brain bound host is intercepted", brain, Target{"api.example.test", 443}, Decision{Allow: true, MITM: true}},
		{"brain has no web", brain, Target{"example.com", 443}, Decision{Reason: ReasonNoWeb}},
		{"tls on 443 only", desktop, Target{"example.com", 8443}, Decision{Reason: ReasonPort}},
		{"deny list", desktop, Target{"printer.local", 443}, Decision{Reason: ReasonHostDenied}},
	}
	for _, c := range cases {
		if got := c.p.Connect(c.target, bound); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestPlainHTTPDecisions(t *testing.T) {
	desktop, _ := ForRole(Desktop)
	brain, _ := ForRole(Brain)
	cases := []struct {
		name   string
		p      Policy
		target Target
		want   Decision
	}{
		{"desktop web", desktop, Target{"ports.ubuntu.com", 80}, Decision{Allow: true}},
		{"http on 80 only", desktop, Target{"example.com", 8080}, Decision{Reason: ReasonPort}},
		{"deny list", desktop, Target{"nas.home.arpa", 80}, Decision{Reason: ReasonHostDenied}},
		{"brain has no web", brain, Target{"example.com", 80}, Decision{Reason: ReasonNoWeb}},
	}
	for _, c := range cases {
		if got := c.p.PlainHTTP(c.target); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestValidBindingHost(t *testing.T) {
	for _, h := range []string{"api.example.test", "postman-echo.com"} {
		if err := ValidBindingHost(h); err != nil {
			t.Errorf("%s: %v", h, err)
		}
	}
	for _, h := range []string{"API.example.test", "127.0.0.1", "0x7f.0x1", "localhost", "printer.local", "api.example.test.", "*.example.test"} {
		if err := ValidBindingHost(h); err == nil {
			t.Errorf("%s accepted as a binding host", h)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/policy/`
Expected: FAIL — `[build failed]`, starting `internal/policy/policy_test.go:9:22: undefined: Target`.

- [ ] **Step 3: Implement the policy**

`keyd/internal/policy/policy.go`:
```go
// Package policy decides where a cell may connect: by role, by port, by name. It works on names
// only; addresses are netguard's job, and IP literals are refused so no request skips the names.
package policy

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

const (
	ReasonHostInvalid = "host-invalid"
	ReasonIPLiteral   = "ip-literal"
	ReasonPort        = "port-not-allowed"
	ReasonHostDenied  = "host-denied"
	ReasonNoWeb       = "web-not-allowed"
)

type Role string

const (
	Brain   Role = "brain"
	Desktop Role = "desktop"
	Browser Role = "browser"
)

// Policy is a cell's egress: Web is the general web, Gateway the LLM gateway.
type Policy struct {
	Role    Role
	Web     bool
	Gateway bool
}

func ForRole(r Role) (Policy, error) {
	switch r {
	case Brain:
		return Policy{Role: r, Gateway: true}, nil
	case Desktop, Browser:
		return Policy{Role: r, Web: true}, nil
	}
	return Policy{}, fmt.Errorf("policy: unknown role %q", r)
}

type Target struct {
	Host string
	Port int
}

type Decision struct {
	Allow  bool
	MITM   bool
	Reason string
}

// Connect decides a CONNECT. intercepted holds the hosts keyd terminates for this cell.
func (p Policy) Connect(t Target, intercepted map[string]bool) Decision {
	if t.Port != 443 {
		return Decision{Reason: ReasonPort}
	}
	if intercepted[t.Host] {
		return Decision{Allow: true, MITM: true}
	}
	return p.web(t)
}

// PlainHTTP decides an absolute-form http:// request. keyd never swaps on one.
func (p Policy) PlainHTTP(t Target) Decision {
	if t.Port != 80 {
		return Decision{Reason: ReasonPort}
	}
	return p.web(t)
}

func (p Policy) web(t Target) Decision {
	if !p.Web {
		return Decision{Reason: ReasonNoWeb}
	}
	if Denied(t.Host) {
		return Decision{Reason: ReasonHostDenied}
	}
	return Decision{Allow: true}
}

// ParseHostPort validates and normalises host:port. defaultPort 0 makes the port required.
// It returns a reason when the target cannot be used.
func ParseHostPort(hostport string, defaultPort int) (Target, string) {
	host, portText, err := net.SplitHostPort(hostport)
	if err != nil {
		if defaultPort == 0 {
			return Target{}, ReasonHostInvalid
		}
		host, portText = hostport, strconv.Itoa(defaultPort)
		if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
			host = host[1 : len(host)-1]
		}
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return Target{}, ReasonHostInvalid
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return Target{}, ReasonIPLiteral
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if !validName(host) {
		return Target{}, ReasonHostInvalid
	}
	return Target{Host: host, Port: port}, ""
}

// Denied reports whether host is a local or reserved name that no cell may reach by name.
func Denied(host string) bool {
	if host == "localhost" {
		return true
	}
	for _, suffix := range deniedSuffixes {
		if strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}

var deniedSuffixes = []string{"localhost", "local", "internal", "intranet", "private", "corp", "home", "lan", "home.arpa", "ldot"}

// ValidBindingHost accepts only a normalised public name: a secret is bound to exact hosts.
func ValidBindingHost(host string) error {
	t, reason := ParseHostPort(net.JoinHostPort(host, "443"), 0)
	if reason != "" || t.Host != host || Denied(host) {
		return fmt.Errorf("policy: %q is not a public, lowercase host name", host)
	}
	return nil
}

func validName(host string) bool {
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if len(l) == 0 || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return false
		}
		for _, c := range []byte(l) {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	// A name ends in a top-level domain: letters, or an IDN's xn-- form. Addresses spelled as names
	// (127.1, 0x7f.0x1) never do.
	tld := labels[len(labels)-1]
	return strings.HasPrefix(tld, "xn--") || !strings.ContainsFunc(tld, func(r rune) bool { return r < 'a' || r > 'z' })
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/policy/`
Expected: `ok` (7 tests).

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/policy
git commit -m "feat(keyd): egress policy by role, port and name"
```

---
### Task 9: The surrogate registry — bindings, inspection and the header swap

This is the authd half of Muse's split: what each secret is bound to, the surrogates minted for each
cell, and the rule that decides whether a request may carry them. A binding comes from the vault
record the user's key form wrote, never from the cell: an HTTP secret names its exact hosts (https
on 443), one header and a format (`bearer`, `raw`, `basic-user`, `basic-password`), optionally
methods and path prefixes; an LLM secret names a provider, and the preset gives the base URL, the
auth header and the operations (P4a-R14). Each operation also says what the gateway's budget needs
(P4a-R27): the API its JSON follows, which says where it carries images, and the field the provider
reads its output cap from (`max_tokens` for Anthropic's messages and OpenAI-compatible servers' chat
completions, `max_completion_tokens` for OpenAI's and Azure's, `max_output_tokens` for Responses,
`generationConfig.maxOutputTokens` for Gemini), or none for embeddings and token counts, which are
free. Inspection finds every surrogate-shaped token in the
request line and the headers — Basic credentials decoded — and refuses the request unless each one
is this cell's, bound to this destination, appears exactly once and sits exactly in its bound header
in its bound format (spec, "Swap rules"; S4: iron-proxy passed unknown and misplaced surrogates
through). The URL's host is part of the request line, and a query with one invalid escape is still
decoded escape by escape, so neither hides a surrogate (review 1, M2 and M10). A binding's method
and path limits hold only on a path every server reads the same way: for a path-limited binding
the decoded path must be clean (one trailing slash allowed), printable ASCII and free of `;` and
backslashes, the raw path must hold no encoded dot, slash, backslash, percent sign or NUL in any
case, and a prefix ends at a segment (`/v1/` permits only what lies under it, not `/v1`; review 2,
N3); a method-limited binding also refuses the override headers and a `_method` query parameter (a
`_method` in a form body, which Rails, Laravel and Spring also read, is not seen: P4a-R8). Anything
else is refused as `surrogate-policy`, since real servers read `/v1/../admin`, `/v1/%2e%2e/admin` and
`/v1%2f..%2fadmin` as `/admin` (review 1, C2). Only then does
`ApplySwaps` put the real values in, Basic auth re-encoded. The cases of sandbox-runtime's
credential-mask tests are ported into `TestInspect`; where srt passes a sentinel through unchanged,
keyd refuses (P4a-R8).

**Files:**
- Create: `keyd/internal/keys/binding.go`, `keyd/internal/keys/registry.go`, `keyd/internal/keys/inspect.go`
- Test: `keyd/internal/keys/binding_test.go`, `keyd/internal/keys/inspect_test.go`

**Interfaces:**
- Consumes: `surrogate.Mint`, `surrogate.Find`, `surrogate.ID` (Task 1); `vault.Record`,
  `vault.ValidValue`, `vault.KindLLM`, `vault.KindHTTP` (Task 2); `policy.ValidBindingHost` (Task 8).
- Produces: `Format` (`Bearer`, `Raw`, `BasicUser`, `BasicPassword`); `Op{Method string; Path *regexp.Regexp; Model bool; Body, Cap string; Free bool}`
  (`Body` is `anthropic`, `chat`, `completions`, `responses`, `embeddings` or `gemini`; `Cap` a
  top-level field or `generationConfig.maxOutputTokens`)
  with `ModelFrom(path) string`; `Binding{SecretID, Tag string; Hosts []string; Route string; Upstream *url.URL; Local bool; Ops []Op; Header string; Format Format; Methods, Paths []string}`
  with `Op(method, path) (Op, bool)` and `Permits(method, path) bool` (on a decoded, clean path; a
  prefix ends at a segment, and one ending in `/` permits only what lies under it);
  `FromRecord(vault.Record) (Binding, error)` (path prefixes clean,
  absolute, printable ASCII, without `;`, backslash or `%`);
  `LocalRoutes() map[string]Binding` (`lmstudio` → `http://127.0.0.1:1234/v1`, `ollama` →
  `http://127.0.0.1:11434/v1`); `ValidValueFor(Binding, []byte) error`;
  `Entry{Token, ID, Cell string; Binding Binding}`; `NewRegistry() *Registry`, `Mint(cell, Binding) (Entry, error)`,
  `Lookup(token) (Entry, bool)`, `ForCell(cell) []Entry`, `RevokeCell(cell) int`, `RevokeSecret(secretID) int`;
  reasons `ReasonUnknownSurrogate`, `ReasonMisplacedSurrogate`, `ReasonSurrogatePolicy`;
  `Dest{Cell, Scheme, Host, Route string}` (Scheme `https` for an intercepted host, `http` for a
  plain request, `gateway` for an LLM route, `connect` for the CONNECT line);
  `Verdict{Allow bool; Reason string; Swaps []Entry; SecretID, SurrogateID string}`;
  `(*Registry).Inspect(d Dest, method string, u *url.URL, h http.Header) Verdict`;
  `ApplySwaps(h http.Header, swaps []Entry, value func(secretID string) ([]byte, error)) error`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/keys/binding_test.go`:
```go
package keys

import (
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func TestLLMPresets(t *testing.T) {
	b, err := FromRecord(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"})
	if err != nil {
		t.Fatal(err)
	}
	if b.Route != "anthropic" || b.Upstream.String() != "https://api.anthropic.com/v1" || b.Header != "X-Api-Key" || b.Format != Raw || b.Tag != "ant" {
		t.Fatalf("anthropic binding %+v", b)
	}
	if op, ok := b.Op("POST", "messages"); !ok || op.Model {
		t.Fatalf("POST messages: %+v %v", op, ok)
	}
	if _, ok := b.Op("POST", "files"); ok {
		t.Fatal("POST files is allowed")
	}
	g, err := FromRecord(vault.Record{ID: "gemini", Kind: vault.KindLLM, Provider: "google"})
	if err != nil {
		t.Fatal(err)
	}
	op, ok := g.Op("POST", "models/gemini-3.6-flash:streamGenerateContent")
	if !ok || !op.Model || op.ModelFrom("models/gemini-3.6-flash:streamGenerateContent") != "gemini-3.6-flash" {
		t.Fatalf("gemini op %+v %v", op, ok)
	}
	c, err := FromRecord(vault.Record{ID: "groq", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://api.groq.com/openai/v1/"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Upstream.String() != "https://api.groq.com/openai/v1" || c.Header != "Authorization" || c.Format != Bearer {
		t.Fatalf("openai-compatible binding %+v", c)
	}
}

func TestEachOperationNamesItsOutputCap(t *testing.T) {
	cases := []struct {
		provider, baseURL, method, path string
		body, cap                       string
		free                            bool
	}{
		{"anthropic", "", "POST", "messages", "anthropic", "max_tokens", false},
		{"anthropic", "", "POST", "messages/count_tokens", "anthropic", "", true},
		{"openai", "", "POST", "chat/completions", "chat", "max_completion_tokens", false},
		{"openai", "", "POST", "completions", "completions", "max_tokens", false},
		{"openai", "", "POST", "responses", "responses", "max_output_tokens", false},
		{"openai", "", "POST", "embeddings", "embeddings", "", false},
		{"azure", "https://res.openai.azure.com/openai/v1", "POST", "chat/completions", "chat", "max_completion_tokens", false},
		{"openai-compatible", "https://llm.example.test/v1", "POST", "chat/completions", "chat", "max_tokens", false},
		{"openai-compatible", "https://llm.example.test/v1", "POST", "responses", "responses", "max_output_tokens", false},
		{"google", "", "POST", "models/gemini-3.6-flash:streamGenerateContent", "gemini", "generationConfig.maxOutputTokens", false},
		{"google", "", "POST", "models/gemini-3.6-flash:generateContent", "gemini", "generationConfig.maxOutputTokens", false},
		{"google", "", "POST", "models/gemini-3.6-flash:countTokens", "gemini", "", true},
		{"google", "", "POST", "models/gemini-embedding-2:batchEmbedContents", "embeddings", "", false},
		{"google", "", "GET", "models", "", "", false},
	}
	for _, c := range cases {
		b, err := FromRecord(vault.Record{ID: "r", Kind: vault.KindLLM, Provider: c.provider, BaseURL: c.baseURL})
		if err != nil {
			t.Fatal(err)
		}
		op, ok := b.Op(c.method, c.path)
		if !ok || op.Body != c.body || op.Cap != c.cap || op.Free != c.free {
			t.Errorf("%s %s %s: %+v %v", c.provider, c.method, c.path, op, ok)
		}
	}
	for name, b := range LocalRoutes() {
		if op, ok := b.Op("POST", "chat/completions"); !ok || op.Cap != "max_tokens" {
			t.Errorf("local route %s: %+v %v", name, op, ok)
		}
	}
}

func TestLLMRecordsAreValidated(t *testing.T) {
	bad := []vault.Record{
		{ID: "x", Kind: vault.KindLLM, Provider: "nope"},
		{ID: "x", Kind: vault.KindLLM, Provider: "anthropic", BaseURL: "https://evil.example.test"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "http://api.example.test/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://127.0.0.1/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://api.example.test/v1?x=1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://u:p@api.example.test/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "azure", BaseURL: "https://res.openai.azure.com/openai/../v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "anthropic", Hosts: []string{"api.anthropic.com"}},
	}
	for _, rec := range bad {
		if _, err := FromRecord(rec); err == nil {
			t.Errorf("FromRecord(%+v) succeeded", rec)
		}
	}
}

func TestHTTPRecords(t *testing.T) {
	b, err := FromRecord(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "x-api-key", Format: "raw", Methods: []string{"GET"}, Paths: []string{"/v1/"}})
	if err != nil {
		t.Fatal(err)
	}
	if b.Header != "X-Api-Key" || b.Tag != "key" || b.Route != "" {
		t.Fatalf("binding %+v", b)
	}
	if !b.Permits("GET", "/v1/forecast") || b.Permits("POST", "/v1/forecast") || b.Permits("GET", "/admin") {
		t.Fatal("Permits does not follow the methods and paths")
	}
	if !b.Permits("GET", "/v1/") || b.Permits("GET", "/v1") {
		t.Fatal("a prefix ending in a slash must permit only what lies under it, not its parent")
	}
	pre, _ := FromRecord(vault.Record{ID: "p", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1"}})
	if !pre.Permits("GET", "/v1") || !pre.Permits("GET", "/v1/x") || pre.Permits("GET", "/v1-admin") {
		t.Fatal("a path prefix must end at a segment")
	}
	open, _ := FromRecord(vault.Record{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"})
	if !open.Permits("DELETE", "/anything") {
		t.Fatal("a binding without methods or paths should permit everything")
	}
	bad := []vault.Record{
		{ID: "w", Kind: vault.KindHTTP, Header: "Authorization", Format: "bearer"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"localhost"}, Header: "Authorization", Format: "bearer"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"printer.local"}, Header: "Authorization", Format: "bearer"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"*.example.test"}, Header: "Authorization", Format: "bearer"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Host", Format: "raw"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Cookie", Format: "raw"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Proxy-Authorization", Format: "raw"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Bad Header", Format: "raw"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "X-Key", Format: "basic-password"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "query"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"get"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"v1"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1/../admin"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1;x/"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{`/v1\x/`}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1%2f/"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Provider: "openai"},
	}
	for _, rec := range bad {
		if _, err := FromRecord(rec); err == nil {
			t.Errorf("FromRecord(%+v) succeeded", rec)
		}
	}
}

func TestLocalRoutesAreReservedIDs(t *testing.T) {
	for name, b := range LocalRoutes() {
		if vault.ValidID(name) {
			t.Errorf("local route %s is a valid secret id", name)
		}
		if !b.Local || b.Upstream.Hostname() != "127.0.0.1" || b.Header != "" {
			t.Errorf("local route %s: %+v", name, b)
		}
	}
}

func TestValidValueFor(t *testing.T) {
	user, _ := FromRecord(vault.Record{ID: "s", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "basic-user"})
	if err := ValidValueFor(user, []byte("user:with-colon")); err == nil {
		t.Fatal("a basic-auth user with a colon was accepted")
	}
	if err := ValidValueFor(user, []byte("plain-user-value")); err != nil {
		t.Fatal(err)
	}
}
```

`keyd/internal/keys/inspect_test.go`:
```go
package keys

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func binding(t *testing.T, rec vault.Record) Binding {
	t.Helper()
	b, err := FromRecord(rec)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mint(t *testing.T, r *Registry, cell string, b Binding) string {
	t.Helper()
	e, err := r.Mint(cell, b)
	if err != nil {
		t.Fatal(err)
	}
	return e.Token
}

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

type req struct {
	dest   Dest
	method string
	url    string
	header http.Header
}

func (q req) inspect(r *Registry) Verdict {
	u, _ := url.Parse(q.url)
	method := q.method
	if method == "" {
		method = "GET"
	}
	return r.Inspect(q.dest, method, u, q.header)
}

// Includes the cases of sandbox-runtime's credential-mask tests (per-host gating, anti-laundering,
// arbitrary header names, mixed surrogates); where srt passes a sentinel through, keyd refuses.
func TestInspect(t *testing.T) {
	r := NewRegistry()
	bearer := binding(t, vault.Record{ID: "api", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"})
	rawB := binding(t, vault.Record{ID: "dd-api", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Dd-Api-Key", Format: "raw"})
	rawC := binding(t, vault.Record{ID: "dd-app", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Dd-Application-Key", Format: "raw"})
	pass := binding(t, vault.Record{ID: "git", Kind: vault.KindHTTP, Hosts: []string{"git.example.test"}, Header: "Authorization", Format: "basic-password"})
	user := binding(t, vault.Record{ID: "pay", Kind: vault.KindHTTP, Hosts: []string{"pay.example.test"}, Header: "Authorization", Format: "basic-user"})
	limited := binding(t, vault.Record{ID: "ro", Kind: vault.KindHTTP, Hosts: []string{"ro.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}, Paths: []string{"/v1/"}})
	prefixed := binding(t, vault.Record{ID: "pre", Kind: vault.KindHTTP, Hosts: []string{"pre.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1"}})
	llm := binding(t, vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"})

	tok := mint(t, r, "c1", bearer)
	tokB := mint(t, r, "c1", rawB)
	tokC := mint(t, r, "c1", rawC)
	tokPass := mint(t, r, "c1", pass)
	tokUser := mint(t, r, "c1", user)
	tokRO := mint(t, r, "c1", limited)
	tokPre := mint(t, r, "c1", prefixed)
	tokLLM := mint(t, r, "c1", llm)
	foreign := mint(t, r, "c2", bearer)
	revoked := mint(t, r, "c3", bearer)
	r.RevokeCell("c3")
	unknown, _ := surrogate.Mint("key")
	forged := "ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA"

	https := func(host string) Dest { return Dest{Cell: "c1", Scheme: "https", Host: host} }
	gateway := func(route string) Dest { return Dest{Cell: "c1", Scheme: "gateway", Route: route} }
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i < len(kv); i += 2 {
			out.Add(kv[i], kv[i+1])
		}
		return out
	}
	// ro is a GET to ro.example.test, whose secret is limited to GET and /v1/, with its surrogate.
	ro := func(rawURL string, kv ...string) req {
		return req{dest: https("ro.example.test"), url: rawURL, header: h(append([]string{"Authorization", "Bearer " + tokRO}, kv...)...)}
	}

	cases := []struct {
		name   string
		q      req
		reason string
		swaps  int
	}{
		{"bearer on its host", req{dest: https("api.example.test"), url: "/v1/x", header: h("Authorization", "Bearer "+tok)}, "", 1},
		{"bearer scheme in any case", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "bearer "+tok)}, "", 1},
		{"no surrogate at all", req{dest: https("api.example.test"), url: "/", header: h("Accept", "*/*")}, "", 0},
		{"two surrogates, two headers", req{dest: https("api.example.test"), url: "/", header: h("Dd-Api-Key", tokB, "Dd-Application-Key", tokC)}, "", 2},
		{"mixed: one surrogate bound elsewhere", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+tok, "X-Git", tokPass)}, ReasonMisplacedSurrogate, 0},
		{"basic password", req{dest: https("git.example.test"), url: "/", header: h("Authorization", basic("x-access-token", tokPass))}, "", 1},
		{"basic user", req{dest: https("pay.example.test"), url: "/", header: h("Authorization", basic(tokUser, ""))}, "", 1},
		{"gateway route", req{dest: gateway("anthropic"), method: "POST", url: "/anthropic/messages", header: h("X-Api-Key", tokLLM)}, "", 1},
		{"unknown surrogate", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+unknown)}, ReasonUnknownSurrogate, 0},
		{"forged checksum", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+forged)}, ReasonUnknownSurrogate, 0},
		{"revoked surrogate", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+revoked)}, ReasonUnknownSurrogate, 0},
		{"another cell's surrogate", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+foreign)}, ReasonMisplacedSurrogate, 0},
		{"wrong host", req{dest: https("other.example.test"), url: "/", header: h("Authorization", "Bearer "+tok)}, ReasonMisplacedSurrogate, 0},
		{"plain http to the bound host", req{dest: Dest{Cell: "c1", Scheme: "http", Host: "api.example.test"}, url: "/", header: h("Authorization", "Bearer "+tok)}, ReasonMisplacedSurrogate, 0},
		{"wrong header", req{dest: https("api.example.test"), url: "/", header: h("X-Api-Key", tok)}, ReasonMisplacedSurrogate, 0},
		{"substring of the header", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+tok+" extra")}, ReasonMisplacedSurrogate, 0},
		{"double space", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer  "+tok)}, ReasonMisplacedSurrogate, 0},
		{"other scheme", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Token "+tok)}, ReasonMisplacedSurrogate, 0},
		{"two header values", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+tok, "Authorization", "Bearer x")}, ReasonMisplacedSurrogate, 0},
		{"in the query", req{dest: https("api.example.test"), url: "/?key=" + tok}, ReasonMisplacedSurrogate, 0},
		{"percent-encoded in the query", req{dest: https("api.example.test"), url: "/?key=ld%5F" + tok[3:]}, ReasonMisplacedSurrogate, 0},
		{"in the path", req{dest: https("api.example.test"), url: "/keys/" + tok}, ReasonMisplacedSurrogate, 0},
		{"header and query", req{dest: https("api.example.test"), url: "/?k=" + tok, header: h("Authorization", "Bearer "+tok)}, ReasonMisplacedSurrogate, 0},
		{"basic with the surrogate twice", req{dest: https("git.example.test"), url: "/", header: h("Authorization", basic(tokPass, tokPass))}, ReasonMisplacedSurrogate, 0},
		{"llm surrogate to another route", req{dest: gateway("openai"), method: "POST", url: "/openai/responses", header: h("X-Api-Key", tokLLM)}, ReasonMisplacedSurrogate, 0},
		{"llm surrogate over https", req{dest: https("api.anthropic.com"), url: "/", header: h("X-Api-Key", tokLLM)}, ReasonMisplacedSurrogate, 0},
		{"http surrogate on the gateway", req{dest: gateway("anthropic"), method: "POST", url: "/anthropic/messages", header: h("Authorization", "Bearer "+tok)}, ReasonMisplacedSurrogate, 0},
		{"method outside the binding", req{dest: https("ro.example.test"), method: "POST", url: "/v1/x", header: h("Authorization", "Bearer "+tokRO)}, ReasonSurrogatePolicy, 0},
		{"path outside the binding", req{dest: https("ro.example.test"), url: "/admin", header: h("Authorization", "Bearer "+tokRO)}, ReasonSurrogatePolicy, 0},
		{"a limited path with a trailing slash", ro("/v1/forecast/"), "", 1},
		{"dot segments", ro("/v1/../admin"), ReasonSurrogatePolicy, 0},
		{"encoded dot segments", ro("/v1/%2e%2e/admin"), ReasonSurrogatePolicy, 0},
		{"encoded dot segments in capitals", ro("/v1/%2E%2E/admin"), ReasonSurrogatePolicy, 0},
		{"encoded slashes", ro("/v1%2f..%2fadmin"), ReasonSurrogatePolicy, 0},
		{"an encoded slash in a clean path", ro("/v1%2Fadmin"), ReasonSurrogatePolicy, 0},
		{"double-encoded dots", ro("/v1/%252e%252e/admin"), ReasonSurrogatePolicy, 0},
		{"encoded backslashes", ro("/v1/%5c..%5cadmin"), ReasonSurrogatePolicy, 0},
		{"backslashes", ro(`/v1/x\..\..\admin`), ReasonSurrogatePolicy, 0},
		{"a NUL", ro("/v1/x%00/../admin"), ReasonSurrogatePolicy, 0},
		{"doubled slashes", ro("/v1//admin"), ReasonSurrogatePolicy, 0},
		{"a ; parameter hiding dot segments", ro("/v1/..;/admin"), ReasonSurrogatePolicy, 0},
		{"a ; parameter", ro("/v1;x=1/forecast"), ReasonSurrogatePolicy, 0},
		{"the method in lower case", req{dest: https("ro.example.test"), method: "get", url: "/v1/x", header: h("Authorization", "Bearer "+tokRO)}, ReasonSurrogatePolicy, 0},
		{"a method override header", ro("/v1/x", "X-HTTP-Method-Override", "DELETE"), ReasonSurrogatePolicy, 0},
		{"a _method parameter", ro("/v1/x?_method=DELETE"), ReasonSurrogatePolicy, 0},
		{"an encoded _method parameter", ro("/v1/x?a=1&%5Fmethod=DELETE"), ReasonSurrogatePolicy, 0},
		{"a prefix permits its own path", req{dest: https("pre.example.test"), url: "/v1", header: h("Authorization", "Bearer "+tokPre)}, "", 1},
		{"a prefix ends at a segment", req{dest: https("pre.example.test"), url: "/v1-admin", header: h("Authorization", "Bearer "+tokPre)}, ReasonSurrogatePolicy, 0},
		{"in the host name", req{dest: https("api.example.test"), url: "https://" + unknown + ".example.test/"}, ReasonUnknownSurrogate, 0},
		{"percent-encoded after a bad escape", req{dest: https("api.example.test"), url: "/?a=%zz&k=ld%5F" + tok[3:]}, ReasonMisplacedSurrogate, 0},
	}
	for _, c := range cases {
		v := c.q.inspect(r)
		if c.reason == "" {
			if !v.Allow || len(v.Swaps) != c.swaps {
				t.Errorf("%s: %+v, want allow with %d swaps", c.name, v, c.swaps)
			}
			continue
		}
		if v.Allow || v.Reason != c.reason || v.SurrogateID == "" {
			t.Errorf("%s: %+v, want deny %s with a surrogate id", c.name, v, c.reason)
		}
	}
}

func TestApplySwaps(t *testing.T) {
	r := NewRegistry()
	values := map[string]string{"api": "real-bearer-value", "dd-api": "real-raw-value", "git": "real-password-value", "pay": "real-user-value"}
	value := func(id string) ([]byte, error) { return []byte(values[id]), nil }
	recs := []vault.Record{
		{ID: "api", Kind: vault.KindHTTP, Hosts: []string{"a.example.test"}, Header: "Authorization", Format: "bearer"},
		{ID: "dd-api", Kind: vault.KindHTTP, Hosts: []string{"a.example.test"}, Header: "Dd-Api-Key", Format: "raw"},
		{ID: "git", Kind: vault.KindHTTP, Hosts: []string{"g.example.test"}, Header: "Authorization", Format: "basic-password"},
		{ID: "pay", Kind: vault.KindHTTP, Hosts: []string{"p.example.test"}, Header: "Authorization", Format: "basic-user"},
	}
	var toks []string
	for _, rec := range recs {
		toks = append(toks, mint(t, r, "c1", binding(t, rec)))
	}
	cases := []struct {
		host, header, value, want string
	}{
		{"a.example.test", "Authorization", "Bearer " + toks[0], "Bearer real-bearer-value"},
		{"a.example.test", "Dd-Api-Key", toks[1], "real-raw-value"},
		{"g.example.test", "Authorization", basic("bot", toks[2]), basic("bot", "real-password-value")},
		{"p.example.test", "Authorization", basic(toks[3], ""), basic("real-user-value", "")},
	}
	for _, c := range cases {
		h := http.Header{c.header: {c.value}}
		u, _ := url.Parse("/")
		v := r.Inspect(Dest{Cell: "c1", Scheme: "https", Host: c.host}, "GET", u, h)
		if !v.Allow {
			t.Fatalf("%s: %+v", c.header, v)
		}
		if err := ApplySwaps(h, v.Swaps, value); err != nil {
			t.Fatal(err)
		}
		if got := h.Get(c.header); got != c.want {
			t.Errorf("%s: %q, want %q", c.host, got, c.want)
		}
	}
	boom := errors.New("keychain locked")
	h := http.Header{"Authorization": {"Bearer " + toks[0]}}
	u, _ := url.Parse("/")
	v := r.Inspect(Dest{Cell: "c1", Scheme: "https", Host: "a.example.test"}, "GET", u, h)
	if err := ApplySwaps(h, v.Swaps, func(string) ([]byte, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func TestRegistry(t *testing.T) {
	r := NewRegistry()
	b := binding(t, vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"})
	e, err := r.Mint("c1", b)
	if err != nil {
		t.Fatal(err)
	}
	if !surrogate.Valid(e.Token) || e.ID != surrogate.ID(e.Token) || e.Cell != "c1" {
		t.Fatalf("entry %+v", e)
	}
	if got, ok := r.Lookup(e.Token); !ok || got.Binding.SecretID != "anthropic" {
		t.Fatalf("Lookup = %+v, %v", got, ok)
	}
	if n := len(r.ForCell("c1")); n != 1 {
		t.Fatalf("ForCell = %d", n)
	}
	if n := r.RevokeCell("c1"); n != 1 {
		t.Fatalf("RevokeCell = %d", n)
	}
	if _, ok := r.Lookup(e.Token); ok {
		t.Fatal("revoked token still resolves")
	}
	a, _ := r.Mint("c1", b)
	other, _ := r.Mint("c2", b)
	weather := binding(t, vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"})
	keep, _ := r.Mint("c1", weather)
	if n := r.RevokeSecret("anthropic"); n != 2 {
		t.Fatalf("RevokeSecret = %d, want 2", n)
	}
	for _, tok := range []string{a.Token, other.Token} {
		if _, ok := r.Lookup(tok); ok {
			t.Fatal("a surrogate of the revoked secret still resolves")
		}
	}
	if _, ok := r.Lookup(keep.Token); !ok {
		t.Fatal("RevokeSecret dropped another secret's surrogate")
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/keys/`
Expected: FAIL — `[build failed]`, starting `internal/keys/inspect_test.go:14:46: undefined: Binding`.

- [ ] **Step 3: Implement bindings, the registry and inspection**

`keyd/internal/keys/binding.go`:
```go
// Package keys is keyd's surrogate registry: what each secret is bound to, the surrogates minted
// for each cell, and the inspection that decides whether a request may carry them.
package keys

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

type Format string

const (
	Bearer        Format = "bearer"
	Raw           Format = "raw"
	BasicUser     Format = "basic-user"
	BasicPassword Format = "basic-password"
)

// Op is one gateway operation: a method and a path under the route's base URL, without a
// leading slash. Model marks ops whose first capture group names the model. Body names the API
// whose JSON the op takes, which says where a request carries images; Cap is the field the
// provider reads the output cap from, empty when the op writes no output; Free marks ops the
// provider does not bill.
type Op struct {
	Method string
	Path   *regexp.Regexp
	Model  bool
	Body   string
	Cap    string
	Free   bool
}

func (o Op) ModelFrom(p string) string {
	if m := o.Path.FindStringSubmatch(p); len(m) > 1 {
		return m[1]
	}
	return ""
}

// Binding is where a secret may go. HTTP secrets name exact hosts reached over https on 443;
// LLM secrets name a gateway route.
type Binding struct {
	SecretID string
	Tag      string
	Hosts    []string
	Route    string
	Upstream *url.URL
	Local    bool
	Ops      []Op
	Header   string
	Format   Format
	Methods  []string
	Paths    []string
}

func (b Binding) Op(method, p string) (Op, bool) {
	for _, o := range b.Ops {
		if o.Method == method && o.Path.MatchString(p) {
			return o, true
		}
	}
	return Op{}, false
}

// Permits applies an HTTP binding's optional method and path limits to a decoded, clean path. A
// prefix ends at a segment: /v1 permits /v1 and /v1/x, never /v1-admin; /v1/ permits only what
// lies under it.
func (b Binding) Permits(method, p string) bool {
	if len(b.Methods) > 0 && !slices.Contains(b.Methods, method) {
		return false
	}
	if len(b.Paths) == 0 {
		return true
	}
	return slices.ContainsFunc(b.Paths, func(prefix string) bool {
		if strings.HasSuffix(prefix, "/") {
			return strings.HasPrefix(p, prefix)
		}
		return p == prefix || strings.HasPrefix(p, prefix+"/")
	})
}

var (
	// OpenAI's chat completions take max_completion_tokens, the one cap its reasoning models
	// accept; servers that copy OpenAI's API read max_tokens.
	openAIOps     = openAIStyle("max_completion_tokens")
	compatibleOps = openAIStyle("max_tokens")
	anthropicOps  = []Op{
		{Method: "POST", Path: regexp.MustCompile(`^messages$`), Body: "anthropic", Cap: "max_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^messages/count_tokens$`), Body: "anthropic", Free: true},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`)},
	}
	googleOps = []Op{
		{Method: "POST", Path: regexp.MustCompile(googleModel + `(?:generateContent|streamGenerateContent)$`), Model: true, Body: "gemini", Cap: "generationConfig.maxOutputTokens"},
		{Method: "POST", Path: regexp.MustCompile(googleModel + `countTokens$`), Model: true, Body: "gemini", Free: true},
		{Method: "POST", Path: regexp.MustCompile(googleModel + `(?:embedContent|batchEmbedContents)$`), Model: true, Body: "embeddings"},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`)},
	}
)

const googleModel = `^models/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*):`

func openAIStyle(chatCap string) []Op {
	return []Op{
		{Method: "POST", Path: regexp.MustCompile(`^chat/completions$`), Body: "chat", Cap: chatCap},
		{Method: "POST", Path: regexp.MustCompile(`^completions$`), Body: "completions", Cap: "max_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^responses$`), Body: "responses", Cap: "max_output_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^embeddings$`), Body: "embeddings"},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*(/[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*)?$`)},
	}
}

type preset struct {
	base   string
	header string
	format Format
	tag    string
	ops    []Op
}

// A preset without a base takes the record's BaseURL.
var presets = map[string]preset{
	"anthropic":         {"https://api.anthropic.com/v1", "X-Api-Key", Raw, "ant", anthropicOps},
	"openai":            {"https://api.openai.com/v1", "Authorization", Bearer, "oai", openAIOps},
	"google":            {"https://generativelanguage.googleapis.com/v1beta", "X-Goog-Api-Key", Raw, "gem", googleOps},
	"openai-compatible": {"", "Authorization", Bearer, "llm", compatibleOps},
	"azure":             {"", "Api-Key", Raw, "azr", openAIOps},
}

// LocalRoutes are the gateway's routes to model servers on the Mac's loopback. They carry no
// secret, and their names are reserved secret ids.
func LocalRoutes() map[string]Binding {
	route := func(name, base string) Binding {
		u, _ := url.Parse(base)
		return Binding{Route: name, Upstream: u, Local: true, Ops: compatibleOps}
	}
	return map[string]Binding{
		"lmstudio": route("lmstudio", "http://127.0.0.1:1234/v1"),
		"ollama":   route("ollama", "http://127.0.0.1:11434/v1"),
	}
}

var (
	headerToken = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
	forbidden   = []string{"Host", "Content-Length", "Content-Type", "Transfer-Encoding", "Connection", "Keep-Alive", "Te", "Trailer", "Upgrade", "Cookie", "Set-Cookie", "Proxy-Authorization", "Proxy-Authenticate", "Proxy-Connection"}
	methods     = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
)

func FromRecord(rec vault.Record) (Binding, error) {
	switch rec.Kind {
	case vault.KindLLM:
		return llmBinding(rec)
	case vault.KindHTTP:
		return httpBinding(rec)
	}
	return Binding{}, fmt.Errorf("keys: unknown kind %q", rec.Kind)
}

func llmBinding(rec vault.Record) (Binding, error) {
	p, ok := presets[rec.Provider]
	if !ok {
		return Binding{}, fmt.Errorf("keys: unknown provider %q", rec.Provider)
	}
	if len(rec.Hosts) > 0 || rec.Header != "" || rec.Format != "" || len(rec.Methods) > 0 || len(rec.Paths) > 0 {
		return Binding{}, errors.New("keys: an llm secret takes only a provider and, for some providers, a base URL")
	}
	base := p.base
	switch {
	case p.base == "" && rec.BaseURL == "":
		return Binding{}, fmt.Errorf("keys: provider %s needs a base URL", rec.Provider)
	case p.base != "" && rec.BaseURL != "":
		return Binding{}, fmt.Errorf("keys: provider %s has a fixed base URL", rec.Provider)
	case p.base == "":
		base = strings.TrimSuffix(rec.BaseURL, "/")
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" {
		return Binding{}, fmt.Errorf("keys: base URL %q must be https://host/path without a port, user, query or fragment", base)
	}
	if err := policy.ValidBindingHost(u.Hostname()); err != nil {
		return Binding{}, err
	}
	if u.Path != "" && path.Clean(u.Path) != u.Path {
		return Binding{}, fmt.Errorf("keys: base URL path %q is not clean", u.Path)
	}
	return Binding{SecretID: rec.ID, Tag: p.tag, Route: rec.ID, Upstream: u, Ops: p.ops, Header: p.header, Format: p.format}, nil
}

func httpBinding(rec vault.Record) (Binding, error) {
	if rec.Provider != "" || rec.BaseURL != "" {
		return Binding{}, errors.New("keys: an http secret takes hosts, a header and a format")
	}
	if len(rec.Hosts) == 0 || len(rec.Hosts) > 16 {
		return Binding{}, errors.New("keys: an http secret needs 1-16 hosts")
	}
	for _, h := range rec.Hosts {
		if err := policy.ValidBindingHost(h); err != nil {
			return Binding{}, err
		}
	}
	if !headerToken.MatchString(rec.Header) {
		return Binding{}, fmt.Errorf("keys: header %q is not a header name", rec.Header)
	}
	header := http.CanonicalHeaderKey(rec.Header)
	if slices.Contains(forbidden, header) {
		return Binding{}, fmt.Errorf("keys: a surrogate cannot travel in %s", header)
	}
	format := Format(rec.Format)
	switch format {
	case Bearer, Raw:
	case BasicUser, BasicPassword:
		if header != "Authorization" {
			return Binding{}, errors.New("keys: basic-auth formats live in Authorization")
		}
	default:
		return Binding{}, fmt.Errorf("keys: format %q: want bearer, raw, basic-user or basic-password", rec.Format)
	}
	for _, m := range rec.Methods {
		if !slices.Contains(methods, m) {
			return Binding{}, fmt.Errorf("keys: method %q", m)
		}
	}
	for _, p := range rec.Paths {
		clean := path.Clean(p)
		if !strings.HasPrefix(p, "/") || clean != strings.TrimSuffix(p, "/") && clean != p || !printable(p) || strings.ContainsAny(p, `;\%`) {
			return Binding{}, fmt.Errorf("keys: path prefix %q must be a clean absolute path of printable ASCII without ; \\ or %%", p)
		}
	}
	return Binding{
		SecretID: rec.ID,
		Tag:      "key",
		Hosts:    slices.Clone(rec.Hosts),
		Header:   header,
		Format:   format,
		Methods:  slices.Clone(rec.Methods),
		Paths:    slices.Clone(rec.Paths),
	}, nil
}

func printable(s string) bool {
	return !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r > 0x7e })
}

// ValidValueFor adds the binding's own limits to vault.ValidValue.
func ValidValueFor(b Binding, value []byte) error {
	if err := vault.ValidValue(value); err != nil {
		return err
	}
	if b.Format == BasicUser && strings.Contains(string(value), ":") {
		return errors.New("keys: a basic-auth user cannot contain a colon")
	}
	return nil
}
```

`keyd/internal/keys/registry.go`:
```go
package keys

import (
	"sync"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

// Entry is one minted surrogate. Token is the surrogate itself and never leaves keyd except in
// the admin reply that hands it to the cell; ID names it everywhere else.
type Entry struct {
	Token   string
	ID      string
	Cell    string
	Binding Binding
}

type Registry struct {
	mu      sync.RWMutex
	byToken map[string]Entry
}

func NewRegistry() *Registry {
	return &Registry{byToken: map[string]Entry{}}
}

func (r *Registry) Mint(cell string, b Binding) (Entry, error) {
	token, err := surrogate.Mint(b.Tag)
	if err != nil {
		return Entry{}, err
	}
	e := Entry{Token: token, ID: surrogate.ID(token), Cell: cell, Binding: b}
	r.mu.Lock()
	r.byToken[token] = e
	r.mu.Unlock()
	return e, nil
}

func (r *Registry) Lookup(token string) (Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.byToken[token]
	return e, ok
}

func (r *Registry) ForCell(cell string) []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []Entry
	for _, e := range r.byToken {
		if e.Cell == cell {
			out = append(out, e)
		}
	}
	return out
}

// RevokeSecret drops every surrogate of the secret, in every cell: a replaced or deleted secret
// must not keep surrogates minted under its old binding.
func (r *Registry) RevokeSecret(secretID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for token, e := range r.byToken {
		if e.Binding.SecretID == secretID {
			delete(r.byToken, token)
			n++
		}
	}
	return n
}

// RevokeCell drops every surrogate of the cell and returns how many there were.
func (r *Registry) RevokeCell(cell string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for token, e := range r.byToken {
		if e.Cell == cell {
			delete(r.byToken, token)
			n++
		}
	}
	return n
}
```

`keyd/internal/keys/inspect.go`:
```go
package keys

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

const (
	ReasonUnknownSurrogate   = "unknown-surrogate"
	ReasonMisplacedSurrogate = "misplaced-surrogate"
	ReasonSurrogatePolicy    = "surrogate-policy"
)

// Dest is where a request goes: Scheme "https" for a host keyd terminates, "http" for a plain
// request, "gateway" for an LLM route.
type Dest struct {
	Cell   string
	Scheme string
	Host   string
	Route  string
}

type Verdict struct {
	Allow       bool
	Reason      string
	Swaps       []Entry
	SecretID    string
	SurrogateID string
}

type occurrence struct {
	token  string
	header string
	basic  bool
}

// Inspect finds every surrogate-shaped token in the request line, its host included, and the
// headers. Each must be a surrogate of this cell, bound to this destination, appear exactly once,
// and sit exactly in its bound header in its bound format; otherwise the request is refused.
func (r *Registry) Inspect(d Dest, method string, u *url.URL, h http.Header) Verdict {
	occ := scan(u, h)
	var v Verdict
	for _, token := range order(occ) {
		e, ok := r.Lookup(token)
		if !ok {
			return Verdict{Reason: ReasonUnknownSurrogate, SurrogateID: surrogate.ID(token)}
		}
		deny := func(reason string) Verdict {
			return Verdict{Reason: reason, SecretID: e.Binding.SecretID, SurrogateID: e.ID}
		}
		if e.Cell != d.Cell || !bound(e.Binding, d) || !placed(e, occ, h) {
			return deny(ReasonMisplacedSurrogate)
		}
		if e.Binding.Route == "" && !permitted(e.Binding, method, u, h) {
			return deny(ReasonSurrogatePolicy)
		}
		v.Swaps = append(v.Swaps, e)
		if v.SurrogateID == "" {
			v.SecretID, v.SurrogateID = e.Binding.SecretID, e.ID
		}
	}
	v.Allow = true
	return v
}

// permitted applies an HTTP binding's method and path limits. A limited binding matches only a path
// every server reads the same way: decoded, clean (one trailing slash allowed), printable ASCII,
// without ; or a backslash, and with no encoded dot, slash, backslash, percent or NUL in the raw
// path. A method limit also refuses the headers and the _method parameter that make a server treat
// a request as another method.
func permitted(b Binding, method string, u *url.URL, h http.Header) bool {
	if len(b.Paths) > 0 && !unambiguousPath(u) {
		return false
	}
	if len(b.Methods) > 0 && overridesMethod(u, h) {
		return false
	}
	return b.Permits(method, u.Path)
}

var ambiguousEscapes = []string{"%2e", "%2f", "%5c", "%25", "%00"}

func unambiguousPath(u *url.URL) bool {
	raw := strings.ToLower(u.EscapedPath())
	if slices.ContainsFunc(ambiguousEscapes, func(e string) bool { return strings.Contains(raw, e) }) {
		return false
	}
	p := u.Path
	if !strings.HasPrefix(p, "/") || !printable(p) || strings.ContainsAny(p, `;\`) {
		return false
	}
	clean := path.Clean(p)
	return p == clean || clean != "/" && p == clean+"/"
}

var overrideHeaders = []string{"X-Http-Method-Override", "X-Http-Method", "X-Method-Override"}

func overridesMethod(u *url.URL, h http.Header) bool {
	if slices.ContainsFunc(overrideHeaders, func(name string) bool { return len(h.Values(name)) > 0 }) {
		return true
	}
	for _, pair := range strings.FieldsFunc(u.RawQuery, func(r rune) bool { return r == '&' || r == ';' }) {
		key, _, _ := strings.Cut(pair, "=")
		if strings.EqualFold(unescape(key), "_method") {
			return true
		}
	}
	return false
}

// unescape decodes every valid %XX and leaves anything else as it is, so one bad escape cannot
// hide the rest of a query.
func unescape(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func bound(b Binding, d Dest) bool {
	if b.Route != "" {
		return d.Scheme == "gateway" && d.Route == b.Route
	}
	return d.Scheme == "https" && slices.Contains(b.Hosts, d.Host)
}

func placed(e Entry, occ []occurrence, h http.Header) bool {
	var mine []occurrence
	for _, o := range occ {
		if o.token == e.Token {
			mine = append(mine, o)
		}
	}
	b := e.Binding
	if len(mine) != 1 || mine[0].header != b.Header || len(h.Values(b.Header)) != 1 {
		return false
	}
	value := h.Get(b.Header)
	switch b.Format {
	case Raw:
		return !mine[0].basic && value == e.Token
	case Bearer:
		scheme, rest, ok := strings.Cut(value, " ")
		return !mine[0].basic && ok && strings.EqualFold(scheme, "Bearer") && rest == e.Token
	case BasicUser, BasicPassword:
		user, pass, ok := decodeBasic(value)
		if !ok || !mine[0].basic {
			return false
		}
		if b.Format == BasicUser {
			return user == e.Token
		}
		return pass == e.Token
	}
	return false
}

func scan(u *url.URL, h http.Header) []occurrence {
	var out []occurrence
	inURL := map[string]bool{}
	for _, part := range []string{u.Host, u.EscapedPath(), u.Path, u.RawQuery, unescape(u.RawQuery)} {
		for _, t := range surrogate.Find(part) {
			if !inURL[t] {
				inURL[t] = true
				out = append(out, occurrence{token: t})
			}
		}
	}
	names := make([]string, 0, len(h))
	for name := range h {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		canonical := http.CanonicalHeaderKey(name)
		for _, t := range surrogate.Find(name) {
			out = append(out, occurrence{token: t, header: "name:" + name})
		}
		for _, value := range h[name] {
			for _, t := range surrogate.Find(value) {
				out = append(out, occurrence{token: t, header: canonical})
			}
			if user, pass, ok := decodeBasic(value); ok {
				for _, t := range surrogate.Find(user + "\n" + pass) {
					out = append(out, occurrence{token: t, header: canonical, basic: true})
				}
			}
		}
	}
	return out
}

func order(occ []occurrence) []string {
	var tokens []string
	for _, o := range occ {
		if !slices.Contains(tokens, o.token) {
			tokens = append(tokens, o.token)
		}
	}
	return tokens
}

func decodeBasic(value string) (user, pass string, ok bool) {
	scheme, encoded, found := strings.Cut(value, " ")
	if !found || !strings.EqualFold(scheme, "Basic") {
		return "", "", false
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", false
	}
	return strings.Cut(string(raw), ":")
}

// ApplySwaps rewrites each bound header with the real value, keeping its format.
func ApplySwaps(h http.Header, swaps []Entry, value func(secretID string) ([]byte, error)) error {
	for _, e := range swaps {
		real, err := value(e.Binding.SecretID)
		if err != nil {
			return err
		}
		b := e.Binding
		switch b.Format {
		case Raw:
			h.Set(b.Header, string(real))
		case Bearer:
			h.Set(b.Header, "Bearer "+string(real))
		case BasicUser, BasicPassword:
			user, pass, _ := decodeBasic(h.Get(b.Header))
			if b.Format == BasicUser {
				user = string(real)
			} else {
				pass = string(real)
			}
			h.Set(b.Header, "Basic "+base64.StdEncoding.EncodeToString([]byte(user+":"+pass)))
		}
	}
	return nil
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/keys/`
Expected: `ok` (9 tests; `TestInspect` covers 50 placements).

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/keys
git commit -m "feat(keyd): surrogate registry, bindings and header swap"
```

---
### Task 10: The cell listener — token, the self-test name and plain HTTP

Each cell gets its own explicit HTTP proxy on `127.0.0.1:<port>`. Any container with egress can
reach it through `host.docker.internal` (S4, Part 2's Task 9 re-review), so every request and every
CONNECT must carry the cell's token as Basic proxy credentials; refusals are 407, audited at most
once a second (P4a-R12, P4a-R13). This task serves plain `http://` requests and the cell's self-test
name `http://keyd.ldot/health` with `net/http`; CONNECT is Task 11's, and until then the listener
answers it 405. A plain request is inspected for surrogates before its host is checked, so one in
the host name is alerted like one anywhere else (a plain request never carries a surrogate: S4
caught iron-proxy swapping into cleartext). `forward` checks a request and swaps what it may carry
through `swap`, the one place real values go in, which refuses while the audit log cannot be written
(P4a-R17); `relay` sends it with `httputil.ReverseProxy` over the generation's transport — guarded
dials, verified TLS, no other proxy, no redirect followed — scrubbing the response and writing the
audit line when the body ends. `relay` asks for gzip itself and decodes a lone gzip itself; the
transport decodes nothing, because Go's transport removes one gzip layer and then every
`Content-Encoding` line, so a body gzipped twice would have reached the cell unscrubbed with no
coding named (review 2, M3). Any other coding, or a second one, on any line, is refused. `record`
makes the `key.use` event from the line as written, in which any surrogate-shaped text is already
its ID. An upstream failure answers 502 and keyd keeps serving; a failure mid-stream aborts the
cell's connection so the stream ends with an error; a cell that hangs up cancels the upstream
request. The generation (context, transport, tracked tunnels) is what `(*Cell).Revoke` replaces:
Task 15's kill switch is built on it.

**Files:**
- Create: `keyd/internal/egress/deps.go`, `keyd/internal/egress/generation.go`, `keyd/internal/egress/cell.go`,
  `keyd/internal/egress/internal.go`, `keyd/internal/egress/forward.go`
- Test: `keyd/internal/egress/harness_test.go`, `keyd/internal/egress/cell_test.go`

**Interfaces:**
- Consumes: Tasks 1–9: `keys.Registry` (`Inspect`, `ForCell`), `keys.ApplySwaps`, `keys.FromRecord`,
  `vault.Vault` (`Value`, `Records`, `Record`), `audit.Log` (`Write`, `Err`), `events.Hub`,
  `netguard.Dialer`, `netguard.DeniedError`, `netguard.ResolveError`, `scrub.New`,
  `policy.ParseHostPort`, `policy.Policy` (`PlainHTTP`), `surrogate.Mint` and `surrogate.ID` (tests).
- Produces: `Dialer` interface (`DialContext`); `Config{CellID string; Policy policy.Policy; Port int; Token string}`
  (Task 12 adds `CA`); `Deps{Registry, Vault, Audit, Events, Dialer, RootCAs}` (Task 14 adds the
  gateway's); `Open(Config, Deps) (*Cell, error)` (token ≥ 32 characters; `ErrPortInUse`);
  `(*Cell).ID()`, `Port()`, `Close()`, `Revoke()`, `ServeHTTP`; the `Reason…` constants in `cell.go`
  (`ReasonNoAudit` = `audit-unavailable` among them); the reserved name `keyd.ldot`; the
  `X-Keyd-Reason` header on every refusal keyd answers itself. Internal: `route{dest, target, line, gen}`,
  `(*Cell).forward`, `(*Cell).swap`, `(*Cell).relay`, `(*Cell).scrubberFor`, `generation` (`ctx`,
  `tr`, `track`, `stop`), `(*Cell).record` (audit line plus `key.use` event), `dialOutcome`, `coding`,
  `gunzip`, `msSince`. Test helpers for later tasks: the harness (`newWorld`, `world.tlsUpstream`,
  `world.plainUpstream`, `world.name`, `world.publish`, `world.cell`, `world.secret`, `world.mint`,
  `world.client`, `world.lines`, `world.waitLine`, `reasonIs`, `dialListener`, `rawConnect`,
  `basicAuth`), `get`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/egress/harness_test.go` — a fake internet: TLS upstreams (HTTP/2, like providers)
and plain ones on loopback, named through a fake resolver, with exact guard exceptions for their
ports and a dialer that maps `:443` and `:80` to them through the real guard:
```go
package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const testToken = "test-proxy-token-0123456789abcdefghijklmnopq"

// world is a fake internet: TLS and plain upstreams on loopback, reachable by name through a fake
// resolver, with exact guard exceptions for their ports and a dialer that maps :443 and :80 to them.
type world struct {
	t         *testing.T
	caKey     *ecdsa.PrivateKey
	caCert    *x509.Certificate
	mu        sync.Mutex
	names     map[string][]netip.Addr
	ports     map[string]string
	allow     []netip.AddrPort
	own       []netip.Prefix
	vault     *vault.Vault
	registry  *keys.Registry
	audit     *audit.Log
	auditPath string
	events    *events.Hub
}

func newWorld(t *testing.T) *world {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "upstream test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	cert, _ := x509.ParseCertificate(der)
	dir := t.TempDir()
	v, err := vault.Open(vault.NewMemory(), filepath.Join(dir, "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	auditPath := filepath.Join(dir, "audit.jsonl")
	log, err := audit.Open(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	return &world{
		t: t, caKey: key, caCert: cert,
		names: map[string][]netip.Addr{}, ports: map[string]string{},
		vault: v, registry: keys.NewRegistry(), audit: log, auditPath: auditPath, events: events.NewHub(),
	}
}

func (w *world) leaf(host string) tls.Certificate {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: host},
		DNSNames: []string{host}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, w.caCert, &key.PublicKey, w.caKey)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func (w *world) roots() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(w.caCert)
	return p
}

// tlsUpstream serves host over TLS, with HTTP/2 as providers do, and a certificate from the
// upstream CA.
func (w *world) tlsUpstream(host string, h http.Handler) *httptest.Server {
	srv := httptest.NewUnstartedServer(h)
	srv.EnableHTTP2 = true
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{w.leaf(host)}}
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	w.t.Cleanup(srv.Close)
	w.publish(host, "443", srv.Listener.Addr().String(), true)
	return srv
}

func (w *world) plainUpstream(host string, h http.Handler) *httptest.Server {
	srv := httptest.NewServer(h)
	w.t.Cleanup(srv.Close)
	w.publish(host, "80", srv.Listener.Addr().String(), true)
	return srv
}

// name points host at addrs with no guard exception, for names that must be refused.
func (w *world) name(host string, addrs ...string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, a := range addrs {
		w.names[host] = append(w.names[host], netip.MustParseAddr(a))
	}
}

func (w *world) publish(host, port, addr string, except bool) {
	ap := netip.MustParseAddrPort(addr)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.names[host] = []netip.Addr{ap.Addr()}
	w.ports[net.JoinHostPort(host, port)] = net.JoinHostPort(host, strconv.Itoa(int(ap.Port())))
	if except {
		w.allow = append(w.allow, ap)
	}
}

func (w *world) LookupNetIP(_ context.Context, _ string, host string) ([]netip.Addr, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if a, ok := w.names[host]; ok {
		return a, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

// portMap sends name:443 and name:80 to the port the fake upstream listens on, through the real guard.
type portMap struct{ w *world }

func (p portMap) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	p.w.mu.Lock()
	if mapped, ok := p.w.ports[address]; ok {
		address = mapped
	}
	allow := append([]netip.AddrPort(nil), p.w.allow...)
	own := append([]netip.Prefix(nil), p.w.own...)
	p.w.mu.Unlock()
	d := &netguard.Dialer{Guard: netguard.New(func() ([]netip.Prefix, error) { return own, nil }, allow...), Resolver: p.w}
	return d.DialContext(ctx, network, address)
}

func (w *world) deps() Deps {
	return Deps{Registry: w.registry, Vault: w.vault, Audit: w.audit, Events: w.events, Dialer: portMap{w}, RootCAs: w.roots()}
}

func (w *world) cell(id string, role policy.Role) *Cell {
	w.t.Helper()
	p, err := policy.ForRole(role)
	if err != nil {
		w.t.Fatal(err)
	}
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken}, w.deps())
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { c.Close() })
	return c
}

func (w *world) secret(rec vault.Record, value string) {
	w.t.Helper()
	if err := w.vault.Put(rec, []byte(value)); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) mint(cell, secretID string) string {
	w.t.Helper()
	rec, _ := w.vault.Record(secretID)
	b, err := keys.FromRecord(rec)
	if err != nil {
		w.t.Fatal(err)
	}
	e, err := w.registry.Mint(cell, b)
	if err != nil {
		w.t.Fatal(err)
	}
	return e.Token
}

func proxyURL(c *Cell, token string) *url.URL {
	return &url.URL{Scheme: "http", User: url.UserPassword("cell", token), Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port()))}
}

// client goes through the cell's listener and trusts the upstream CA plus extra roots.
func (w *world) client(c *Cell, extra ...*x509.Certificate) *http.Client {
	roots := w.roots()
	for _, cert := range extra {
		roots.AddCert(cert)
	}
	return &http.Client{
		Transport:     &http.Transport{Proxy: http.ProxyURL(proxyURL(c, testToken)), TLSClientConfig: &tls.Config{RootCAs: roots}, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       10 * time.Second,
	}
}

func (w *world) lines() []audit.Line {
	w.t.Helper()
	data, err := os.ReadFile(w.auditPath)
	if err != nil {
		w.t.Fatal(err)
	}
	var out []audit.Line
	for _, raw := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		if len(raw) == 0 {
			continue
		}
		var l audit.Line
		if err := json.Unmarshal(raw, &l); err != nil {
			w.t.Fatal(err)
		}
		out = append(out, l)
	}
	return out
}

// waitLine waits for an audit line that satisfies match; decisions on streams are written when they end.
func (w *world) waitLine(match func(audit.Line) bool) audit.Line {
	w.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, l := range w.lines() {
			if match(l) {
				return l
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	w.t.Fatalf("no audit line matched; have %+v", w.lines())
	return audit.Line{}
}

func reasonIs(reason string) func(audit.Line) bool {
	return func(l audit.Line) bool { return l.Reason == reason }
}

func dialListener(c *Cell) (net.Conn, error) {
	return net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port())))
}

// rawConnect opens a CONNECT tunnel by hand and returns the connection after the reply.
func rawConnect(t *testing.T, c *Cell, authority string) (net.Conn, *http.Response) {
	t.Helper()
	conn, err := dialListener(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	req := "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\nProxy-Authorization: Basic " +
		basicAuth("cell", testToken) + "\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode == http.StatusOK && br.Buffered() > 0 {
		t.Fatal("bytes after the CONNECT reply")
	}
	return conn, resp
}

func basicAuth(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}
```

`keyd/internal/egress/cell_test.go`:
```go
package egress

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func get(t *testing.T, client *http.Client, rawURL string) (*http.Response, string) {
	t.Helper()
	resp, err := client.Get(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func withToken(c *Cell, token string) *http.Client {
	tr := &http.Transport{DisableKeepAlives: true}
	if token != "" {
		tr.Proxy = http.ProxyURL(proxyURL(c, token))
	} else {
		tr.Proxy = http.ProxyURL(&url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port()))})
	}
	return &http.Client{Transport: tr, Timeout: 5 * time.Second}
}

func TestRequestsWithoutTheTokenAreRefused(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c1", policy.Desktop)
	// Refusals are audited at most once a second, so the one this test looks for goes first.
	for _, tc := range []struct{ token, reason string }{
		{"", ReasonAuthMissing},
		{"wrong-token-0123456789abcdefghijklmnopqrs", ReasonAuthInvalid},
		{testToken[:len(testToken)-1], ReasonAuthInvalid},
	} {
		resp, _ := get(t, withToken(c, tc.token), "http://keyd.ldot/health")
		if resp.StatusCode != http.StatusProxyAuthRequired || !strings.HasPrefix(resp.Header.Get("Proxy-Authenticate"), "Basic") || resp.Header.Get("X-Keyd-Reason") != tc.reason {
			t.Errorf("token %q: %d %v", tc.token, resp.StatusCode, resp.Header)
		}
	}
	conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port())))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
	line, _ := io.ReadAll(io.LimitReader(conn, 12))
	if string(line) != "HTTP/1.1 407" {
		t.Fatalf("CONNECT without a token: %q", line)
	}
	l := w.waitLine(reasonIs(ReasonAuthMissing))
	if l.Decision != audit.Deny || l.Cell != "c1" || l.Port != c.Port() || l.Status != http.StatusProxyAuthRequired {
		t.Fatalf("audit %+v", l)
	}
}

func TestAuthFailuresAreAuditedAtMostOncePerSecond(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c1", policy.Desktop)
	for range 20 {
		get(t, withToken(c, ""), "http://keyd.ldot/health")
	}
	n := 0
	for _, l := range w.lines() {
		if l.Reason == ReasonAuthMissing {
			n++
		}
	}
	// One a second: 20 quick refusals span at most a second boundary or two on a slow machine.
	if n < 1 || n > 3 {
		t.Fatalf("%d audit lines for 20 refused requests, want 1 to 3", n)
	}
}

func TestHealthNamesTheCell(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c-health", policy.Brain)
	resp, body := get(t, w.client(c), "http://keyd.ldot/health")
	var got struct {
		OK   bool   `json:"ok"`
		Cell string `json:"cell"`
	}
	json.Unmarshal([]byte(body), &got)
	if resp.StatusCode != 200 || !got.OK || got.Cell != "c-health" {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if resp, _ := get(t, w.client(c), "http://keyd.ldot/other"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown internal path: %d", resp.StatusCode)
	}
}

func TestPlainHTTPReachesTheWebWithoutProxyHeaders(t *testing.T) {
	w := newWorld(t)
	seen := make(chan *http.Request, 1)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		io.WriteString(rw, "plain-ok")
	}))
	c := w.cell("c1", policy.Desktop)
	resp, body := get(t, w.client(c), "http://ports.example.test/dists/x?arch=arm64")
	if resp.StatusCode != 200 || body != "plain-ok" {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	r := <-seen
	if r.Host != "ports.example.test" || r.URL.RequestURI() != "/dists/x?arch=arm64" || r.Header.Get("Proxy-Authorization") != "" {
		t.Fatalf("upstream saw host %q uri %q headers %v", r.Host, r.URL.RequestURI(), r.Header)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "http" && l.Decision == audit.Allow })
	if l.Host != "ports.example.test" || l.Path != "/dists/x" || l.Status != 200 || l.BytesOut != 8 {
		t.Fatalf("audit %+v", l)
	}
}

func TestPlainHTTPPolicy(t *testing.T) {
	w := newWorld(t)
	w.name("rebind.example.test", "127.0.0.1")
	desktop := w.cell("c1", policy.Desktop)
	brain := w.cell("c2", policy.Brain)
	cases := []struct {
		name   string
		cell   *Cell
		url    string
		status int
		reason string
	}{
		{"brain has no web", brain, "http://example.test/", 403, policy.ReasonNoWeb},
		{"deny list", desktop, "http://printer.local/", 403, policy.ReasonHostDenied},
		{"port 80 only", desktop, "http://example.test:8080/", 403, policy.ReasonPort},
		{"ip literal", desktop, "http://127.0.0.1:1234/v1/models", 403, policy.ReasonIPLiteral},
		{"mapped ip literal", desktop, "http://[::ffff:127.0.0.1]/", 403, policy.ReasonIPLiteral},
		{"single-label name", desktop, "http://localhost:1234/v1/models", 403, policy.ReasonHostInvalid},
		{"name resolving to loopback", desktop, "http://rebind.example.test/", 403, ReasonAddress},
		{"unresolvable", desktop, "http://nowhere.example.test/", 502, ReasonResolve},
	}
	for _, c := range cases {
		resp, _ := get(t, w.client(c.cell), c.url)
		if resp.StatusCode != c.status || resp.Header.Get("X-Keyd-Reason") != c.reason {
			t.Errorf("%s: %d %q, want %d %q", c.name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), c.status, c.reason)
		}
	}
}

func TestTraceAndNonProxyRequestsAreRefused(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("echo.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	c := w.cell("c1", policy.Desktop)
	req, _ := http.NewRequest("TRACE", "http://echo.example.test/", nil)
	resp, err := w.client(c).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("TRACE: %d", resp.StatusCode)
	}
	conn, _ := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port())))
	defer conn.Close()
	io.WriteString(conn, "GET /path HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic "+basicAuth("cell", testToken)+"\r\n\r\n")
	line, _ := io.ReadAll(io.LimitReader(conn, 12))
	if string(line) != "HTTP/1.1 400" {
		t.Fatalf("origin-form request: %q", line)
	}
}

func TestSurrogatesNeverTravelOverPlainHTTP(t *testing.T) {
	w := newWorld(t)
	var reached atomic.Bool
	w.plainUpstream("api.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Store(true) }))
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, "real-secret-value-for-test")
	c := w.cell("c1", policy.Desktop)
	tok := w.mint("c1", "weather")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	req, _ := http.NewRequest("GET", "http://api.example.test/v1", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := w.client(c).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != "misplaced-surrogate" || reached.Load() {
		t.Fatalf("%d %q reached=%v", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), reached.Load())
	}
	select {
	case e := <-sub:
		ku := e.Data.(events.KeyUse)
		if e.Type != events.TypeKeyUse || ku.SecretID != "weather" || ku.Decision != "deny" || ku.Host != "api.example.test" {
			t.Fatalf("event %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no key.use alert")
	}
}

func TestAnUnknownSurrogateIsBlockedAndAlerted(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("upstream reached") }))
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	resp, _ := get(t, w.client(c), "http://ports.example.test/?k=ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA")
	if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != "unknown-surrogate" {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	e := <-sub
	if ku := e.Data.(events.KeyUse); ku.SecretID != "unknown" || ku.Decision != "deny" {
		t.Fatalf("event %+v", e)
	}
}

func TestSurrogateTextNeverReachesTheAuditOrTheEvents(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("upstream reached") }))
	c := w.cell("c1", policy.Desktop)
	tok, _ := surrogate.Mint("key")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	for _, u := range []string{"http://ports.example.test/keys/" + tok, "http://" + tok + ".example.test/"} {
		resp, _ := get(t, w.client(c), u)
		if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != "unknown-surrogate" {
			t.Errorf("%s: %d %q", u, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
		select {
		case e := <-sub:
			if ku := e.Data.(events.KeyUse); strings.Contains(ku.Host+ku.Path, tok) {
				t.Errorf("key.use carries the surrogate: %+v", ku)
			}
		case <-time.After(time.Second):
			t.Errorf("%s: no key.use alert", u)
		}
	}
	logged, _ := os.ReadFile(w.auditPath)
	if strings.Contains(string(logged), tok) || !strings.Contains(string(logged), "surrogate:"+surrogate.ID(tok)) {
		t.Fatalf("audit: %s", logged)
	}
}

func TestUpstreamFailuresAnswer502AndKeydKeepsServing(t *testing.T) {
	w := newWorld(t)
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	w.publish("down.example.test", "80", addr, true)
	w.plainUpstream("up.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "up") }))
	c := w.cell("c1", policy.Desktop)
	if resp, _ := get(t, w.client(c), "http://down.example.test/"); resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonUpstream {
		t.Fatalf("down upstream: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	if resp, body := get(t, w.client(c), "http://up.example.test/"); resp.StatusCode != 200 || body != "up" {
		t.Fatalf("after a failure: %d %q", resp.StatusCode, body)
	}
}

func TestAMidStreamUpstreamErrorEndsTheClientStream(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("stream.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: one\n\n")
		rw.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}))
	c := w.cell("c1", policy.Desktop)
	resp, err := w.client(c).Get("http://stream.example.test/")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err == nil || !strings.Contains(string(body), "data: one") {
		t.Fatalf("body %q err %v, want the first event and then an error", body, err)
	}
	w.waitLine(reasonIs(ReasonAborted))
}

func TestAClientDisconnectAbortsTheUpstreamRequest(t *testing.T) {
	w := newWorld(t)
	aborted := make(chan struct{})
	w.plainUpstream("slow.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: start\n\n")
		rw.(http.Flusher).Flush()
		<-r.Context().Done()
		close(aborted)
	}))
	c := w.cell("c1", policy.Desktop)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://slow.example.test/", nil)
	resp, err := w.client(c).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	resp.Body.Read(buf)
	cancel()
	resp.Body.Close()
	select {
	case <-aborted:
	case <-time.After(3 * time.Second):
		t.Fatal("the upstream request kept running after the client left")
	}
	w.waitLine(reasonIs(ReasonClientGone))
}

func TestAnUnrequestedEncodingIsRefused(t *testing.T) {
	w := newWorld(t)
	gz := func(b []byte) []byte {
		var out bytes.Buffer
		zw := gzip.NewWriter(&out)
		zw.Write(b)
		zw.Close()
		return out.Bytes()
	}
	zipped := gz([]byte("hidden from the scrubber"))
	twice := gz(zipped)
	codings := map[string]struct {
		values []string
		body   []byte
	}{
		"br":       {[]string{"br"}, zipped},
		"stacked":  {[]string{"identity", "gzip"}, zipped},
		"listed":   {[]string{"identity, gzip"}, zipped},
		"gzip-gz":  {[]string{"gzip", "gzip"}, twice},
		"gzip-br":  {[]string{"gzip", "br"}, twice},
		"gzip-two": {[]string{"gzip, gzip"}, twice},
		"lone":     {[]string{"gzip"}, zipped},
	}
	for name, coded := range codings {
		w.plainUpstream(name+".example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
			rw.Header()["Content-Encoding"] = coded.values
			rw.Write(coded.body)
		}))
	}
	c := w.cell("c1", policy.Desktop)
	for name := range codings {
		resp, body := get(t, w.client(c), "http://"+name+".example.test/")
		if name == "lone" {
			if resp.StatusCode != 200 || body != "hidden from the scrubber" || resp.Header.Get("Content-Encoding") != "" {
				t.Errorf("a lone gzip, which keyd decodes: %d %q %q", resp.StatusCode, body, resp.Header.Get("Content-Encoding"))
			}
			continue
		}
		if resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonEncoding {
			t.Errorf("%s: %d %q", name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
	}
}

func TestRedirectsAreReturnedAndEachHopIsCheckedAgain(t *testing.T) {
	w := newWorld(t)
	w.name("internal-hop.example.test", "10.0.0.5")
	w.plainUpstream("redirect.example.test", http.RedirectHandler("http://internal-hop.example.test/admin", http.StatusFound))
	c := w.cell("c1", policy.Desktop)
	resp, _ := get(t, w.client(c), "http://redirect.example.test/")
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "http://internal-hop.example.test/admin" {
		t.Fatalf("redirect: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp, _ := get(t, w.client(c), resp.Header.Get("Location")); resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonAddress {
		t.Fatalf("second hop: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestRevokeEndsUpstreamRequestsAndKeepsTheListener(t *testing.T) {
	w := newWorld(t)
	upstreamDone := make(chan struct{})
	w.plainUpstream("stream.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		io.WriteString(rw, "data: start\n\n")
		rw.(http.Flusher).Flush()
		<-r.Context().Done()
		close(upstreamDone)
	}))
	c := w.cell("c1", policy.Desktop)
	resp, err := w.client(c).Get("http://stream.example.test/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Read(make([]byte, 16))
	c.Revoke()
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatal("the stream survived Revoke")
	}
	select {
	case <-upstreamDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the upstream request survived Revoke")
	}
	if resp, _ := get(t, w.client(c), "http://keyd.ldot/health"); resp.StatusCode != 200 {
		t.Fatalf("the listener stopped: %d", resp.StatusCode)
	}
}

func TestOpenRefusesAShortTokenAndABusyPort(t *testing.T) {
	w := newWorld(t)
	p, _ := policy.ForRole(policy.Desktop)
	if _, err := Open(Config{CellID: "c1", Policy: p, Token: "short"}, w.deps()); err == nil {
		t.Fatal("a short token was accepted")
	}
	c := w.cell("c1", policy.Desktop)
	if _, err := Open(Config{CellID: "c2", Policy: p, Token: testToken, Port: c.Port()}, w.deps()); err == nil || !errors.Is(err, ErrPortInUse) {
		t.Fatalf("busy port: %v", err)
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/egress/`
Expected: FAIL — `[build failed]`, starting `internal/egress/cell_test.go:38:19: undefined: Cell`.

- [ ] **Step 3: Implement the listener**

`keyd/internal/egress/deps.go`:
```go
package egress

import (
	"context"
	"crypto/x509"
	"net"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Dialer is satisfied by *netguard.Dialer.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

type Config struct {
	CellID string
	Policy policy.Policy
	// Port 0 picks a free port; tests use it.
	Port  int
	Token string
}

type Deps struct {
	Registry *keys.Registry
	Vault    *vault.Vault
	Audit    *audit.Log
	Events   *events.Hub
	Dialer   Dialer
	// RootCAs verifies upstream TLS; nil means the system roots.
	RootCAs *x509.CertPool
}
```

`keyd/internal/egress/generation.go`:
```go
package egress

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"sync"
	"time"
)

// generation is what the kill switch replaces: the context every upstream request and tunnel
// hangs off, the transport whose pooled connections it closes, and the tunnels it tracks.
type generation struct {
	ctx    context.Context
	cancel context.CancelFunc
	tr     *http.Transport
	mu     sync.Mutex
	conns  map[net.Conn]struct{}
}

func newGeneration(d Deps) *generation {
	ctx, cancel := context.WithCancel(context.Background())
	tr := &http.Transport{
		DialContext:           d.Dialer.DialContext,
		TLSClientConfig:       &tls.Config{RootCAs: d.RootCAs, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   8,
		ExpectContinueTimeout: time.Second,
		// relay asks for gzip itself and decodes it, so it sees every coding a body has.
		DisableCompression: true,
	}
	return &generation{ctx: ctx, cancel: cancel, tr: tr, conns: map[net.Conn]struct{}{}}
}

// track registers a connection for the kill switch; one opened after the switch is closed at once.
func (g *generation) track(conn net.Conn) func() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ctx.Err() != nil {
		conn.Close()
		return func() {}
	}
	g.conns[conn] = struct{}{}
	return func() {
		g.mu.Lock()
		delete(g.conns, conn)
		g.mu.Unlock()
	}
}

func (g *generation) stop() {
	g.cancel()
	g.mu.Lock()
	for conn := range g.conns {
		conn.Close()
	}
	g.conns = map[net.Conn]struct{}{}
	g.mu.Unlock()
	g.tr.CloseIdleConnections()
}
```

`keyd/internal/egress/cell.go`:
```go
// Package egress is a cell's door to the outside: one explicit HTTP proxy per cell on 127.0.0.1,
// guarded by the cell's proxy token. It refuses what policy refuses, terminates TLS only for the
// hosts the cell's surrogates are bound to, swaps surrogates there and scrubs what comes back,
// and passes every other allowed host through after checking its SNI.
package egress

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
)

const (
	ReasonAuthMissing  = "proxy-auth-missing"
	ReasonAuthInvalid  = "proxy-auth-invalid"
	ReasonBadRequest   = "bad-request"
	ReasonMethod       = "method-not-allowed"
	ReasonNotFound     = "not-found"
	ReasonHandshake    = "tls-handshake-failed"
	ReasonHostMismatch = "host-mismatch"
	ReasonUpgrade      = "upgrade-refused"
	ReasonAddress      = "address-denied"
	ReasonResolve      = "resolve-failed"
	ReasonUpstream     = "upstream-error"
	ReasonUpstreamTLS  = "upstream-tls"
	ReasonAborted      = "upstream-aborted"
	ReasonClientGone   = "client-aborted"
	ReasonRevoked      = "revoked"
	ReasonEncoding     = "undecodable-encoding"
	ReasonSecret       = "secret-unavailable"
	ReasonNoAudit      = "audit-unavailable"
)

const (
	internalHost = "keyd.ldot"
	minTokenLen  = 32
)

var ErrPortInUse = errors.New("egress: listener port in use")

type Cell struct {
	cfg         Config
	deps        Deps
	ln          net.Listener
	srv         *http.Server
	intercepted map[string]bool
	authLog     rateLog
	mu          sync.Mutex
	gen         *generation
	closed      bool
}

func Open(cfg Config, deps Deps) (*Cell, error) {
	if len(cfg.Token) < minTokenLen {
		return nil, fmt.Errorf("egress: proxy token must be at least %d characters", minTokenLen)
	}
	ln, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)))
	if errors.Is(err, syscall.EADDRINUSE) {
		return nil, fmt.Errorf("%w: %d", ErrPortInUse, cfg.Port)
	}
	if err != nil {
		return nil, err
	}
	c := &Cell{cfg: cfg, deps: deps, ln: ln, gen: newGeneration(deps), intercepted: map[string]bool{}}
	c.srv = &http.Server{
		Handler:           c,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	go c.srv.Serve(ln)
	return c, nil
}

func (c *Cell) ID() string { return c.cfg.CellID }

func (c *Cell) Port() int { return c.ln.Addr().(*net.TCPAddr).Port }

// Close stops the listener and closes every connection the cell has, upstream ones included.
func (c *Cell) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	g := c.gen
	c.mu.Unlock()
	err := c.srv.Close()
	g.stop()
	return err
}

// Revoke is the kill switch for one cell: every upstream connection and tunnel closes, in-flight
// requests fail, and the cell starts a fresh generation.
func (c *Cell) Revoke() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	old := c.gen
	c.gen = newGeneration(c.deps)
	c.mu.Unlock()
	old.stop()
}

func (c *Cell) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if reason := c.authorize(r.Header.Values("Proxy-Authorization")); reason != "" {
		c.refuseAuth(w, r, reason)
		return
	}
	r.Header.Del("Proxy-Authorization")
	line := audit.Line{Kind: audit.KindRequest, Method: r.Method, Host: r.URL.Hostname(), Path: r.URL.Path}
	switch {
	case r.Method == http.MethodConnect:
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
	case !r.URL.IsAbs() || r.URL.Scheme != "http":
		c.deny(w, line, http.StatusBadRequest, ReasonBadRequest)
	case strings.EqualFold(r.URL.Hostname(), internalHost):
		c.serveInternal(w, r)
	default:
		c.servePlain(w, r)
	}
}

// authorize accepts only Basic credentials whose password is the cell's token.
func (c *Cell) authorize(values []string) string {
	if len(values) == 0 {
		return ReasonAuthMissing
	}
	scheme, encoded, ok := strings.Cut(values[0], " ")
	if len(values) > 1 || !ok || !strings.EqualFold(scheme, "Basic") {
		return ReasonAuthInvalid
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return ReasonAuthInvalid
	}
	_, pass, ok := strings.Cut(string(raw), ":")
	if !ok || subtle.ConstantTimeCompare([]byte(pass), []byte(c.cfg.Token)) != 1 {
		return ReasonAuthInvalid
	}
	return ""
}

// refuseAuth answers 407. Any container with egress can reach the listener, so refusals are
// audited at most once a second, with the number left out.
func (c *Cell) refuseAuth(w http.ResponseWriter, r *http.Request, reason string) {
	if ok, suppressed := c.authLog.allow(time.Now()); ok {
		l := audit.Line{Kind: audit.KindRequest, Method: r.Method, Host: r.URL.Hostname(), Decision: audit.Deny, Reason: reason, Status: http.StatusProxyAuthRequired}
		if r.Method == http.MethodConnect {
			l.Kind, l.Host = audit.KindConnect, r.Host
		}
		if suppressed > 0 {
			l.Detail = fmt.Sprintf("%d earlier refusals not logged", suppressed)
		}
		c.record(l)
	}
	w.Header().Set("Proxy-Authenticate", `Basic realm="localdot-keyd"`)
	w.Header().Set("X-Keyd-Reason", reason)
	http.Error(w, "keyd: proxy authentication required", http.StatusProxyAuthRequired)
}

func (c *Cell) deny(w http.ResponseWriter, l audit.Line, status int, reason string) {
	l.Decision, l.Reason, l.Status = audit.Deny, reason, status
	c.record(l)
	w.Header().Set("X-Keyd-Reason", reason)
	http.Error(w, "keyd: "+reason, status)
}

var alerts = map[string]bool{
	keys.ReasonUnknownSurrogate:   true,
	keys.ReasonMisplacedSurrogate: true,
	keys.ReasonSurrogatePolicy:    true,
}

// record writes the audit line and, for every use or misuse of a surrogate, a key.use event made
// from the line as written, so the event carries no surrogate either.
func (c *Cell) record(l audit.Line) {
	l.Cell, l.Port = c.cfg.CellID, c.Port()
	l, err := c.deps.Audit.Write(l)
	if err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
	if l.SecretID == "" && !alerts[l.Reason] {
		return
	}
	secret, decision := l.SecretID, "deny"
	if secret == "" {
		secret = "unknown"
	}
	if l.Swapped {
		decision = "allow"
	}
	c.deps.Events.Publish(events.Event{Type: events.TypeKeyUse, Cell: c.cfg.CellID, Data: events.KeyUse{
		SecretID: secret, Host: l.Host, Method: l.Method, Path: l.Path, Decision: decision,
	}})
}

func (c *Cell) current() *generation {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen
}

type rateLog struct {
	mu         sync.Mutex
	last       time.Time
	suppressed int
}

func (r *rateLog) allow(now time.Time) (bool, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Sub(r.last) < time.Second {
		r.suppressed++
		return false, 0
	}
	n := r.suppressed
	r.last, r.suppressed = now, 0
	return true, n
}
```

`keyd/internal/egress/internal.go`:
```go
package egress

import (
	"encoding/json"
	"net/http"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
)

// serveInternal answers keyd.ldot, the name a cell's boot self-test uses to prove its proxy path
// and token without reaching the internet.
func (c *Cell) serveInternal(w http.ResponseWriter, r *http.Request) {
	line := audit.Line{Kind: audit.KindRequest, Mode: "internal", Method: r.Method, Host: internalHost, Path: r.URL.Path}
	if r.URL.Path != "/health" {
		c.deny(w, line, http.StatusNotFound, ReasonNotFound)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
		return
	}
	line.Decision, line.Status = audit.Allow, http.StatusOK
	c.record(line)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "cell": c.cfg.CellID})
}
```

`keyd/internal/egress/forward.go`:
```go
package egress

import (
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/scrub"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const redacted = "keyd-redacted"

var errEncoding = errors.New("egress: upstream used a content encoding keyd cannot scrub")

// route is one request keyd forwards: where it goes and the audit line it will close.
type route struct {
	dest   keys.Dest
	target *url.URL
	line   audit.Line
	gen    *generation
}

func (c *Cell) servePlain(w http.ResponseWriter, r *http.Request) {
	line := audit.Line{Kind: audit.KindRequest, Mode: "http", Method: r.Method, Host: r.URL.Hostname(), Path: r.URL.Path}
	// A plain request never carries a surrogate. Looking before the host is checked catches one in
	// the host name too, which would otherwise be refused as an invalid name without an alert.
	if v := c.deps.Registry.Inspect(keys.Dest{Cell: c.cfg.CellID, Scheme: "http"}, r.Method, r.URL, r.Header); !v.Allow {
		line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	t, reason := policy.ParseHostPort(r.URL.Host, 80)
	if reason != "" {
		c.deny(w, line, http.StatusForbidden, reason)
		return
	}
	line.Host = t.Host
	if d := c.cfg.Policy.PlainHTTP(t); !d.Allow {
		c.deny(w, line, http.StatusForbidden, d.Reason)
		return
	}
	target := &url.URL{Scheme: "http", Host: t.Host, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
	c.forward(w, r, route{dest: keys.Dest{Cell: c.cfg.CellID, Scheme: "http", Host: t.Host}, target: target, line: line, gen: c.current()})
}

// forward checks a request bound for a host and swaps the surrogates it may carry, then relays it.
func (c *Cell) forward(w http.ResponseWriter, r *http.Request, rt route) {
	line := rt.line
	if r.Method == "TRACE" || r.Method == "TRACK" {
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
		return
	}
	if isUpgrade(r) && (rt.dest.Scheme != "http" || c.intercepted[rt.dest.Host]) {
		c.deny(w, line, http.StatusForbidden, ReasonUpgrade)
		return
	}
	v := c.deps.Registry.Inspect(rt.dest, r.Method, r.URL, r.Header)
	line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
	if !v.Allow {
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	if status, reason := c.swap(r.Header, v.Swaps); reason != "" {
		c.deny(w, line, status, reason)
		return
	}
	line.Swapped = len(v.Swaps) > 0
	scrubber, err := c.scrubberFor(rt.dest)
	if err != nil {
		c.deny(w, line, http.StatusBadGateway, ReasonSecret)
		return
	}
	c.relay(w, r, rt, scrubber, line)
}

// swap puts the real values in. While the audit log cannot be written it refuses: the use of a
// secret is never left unrecorded.
func (c *Cell) swap(h http.Header, swaps []keys.Entry) (int, string) {
	if len(swaps) == 0 {
		return 0, ""
	}
	if c.deps.Audit.Err() != nil {
		return http.StatusServiceUnavailable, ReasonNoAudit
	}
	if err := keys.ApplySwaps(h, swaps, c.deps.Vault.Value); err != nil {
		return http.StatusBadGateway, ReasonSecret
	}
	return 0, ""
}

// relay sends the request with the generation's transport: verified upstream TLS, guarded dials,
// no other proxy, no redirects followed. The response is scrubbed on its way back, and the audit
// line is written once the body has been relayed or the attempt has failed.
func (c *Cell) relay(w http.ResponseWriter, r *http.Request, rt route, scrubber *scrub.Scrubber, line audit.Line) {
	start := time.Now()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer context.AfterFunc(rt.gen.ctx, cancel)()
	in := &counter{ReadCloser: r.Body}
	r.Body = in
	var once sync.Once
	finish := func(l audit.Line) {
		once.Do(func() {
			l.BytesIn, l.DurationMs = in.n, msSince(start)
			c.record(l)
		})
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			target := *rt.target
			pr.Out.URL = &target
			pr.Out.Host = ""
			pr.Out.Header.Set("Accept-Encoding", "gzip")
		},
		Transport:     rt.gen.tr,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ModifyResponse: func(resp *http.Response) error {
			l := line
			l.Decision, l.Status = audit.Allow, resp.StatusCode
			if !bodyAllowed(r.Method, resp.StatusCode) {
				scrubber.Header(resp.Header)
				finish(l)
				return nil
			}
			gzipped, ok := coding(resp.Header.Values("Content-Encoding"))
			if !ok {
				return errEncoding
			}
			if gzipped {
				resp.Header.Del("Content-Encoding")
				resp.Body = &gunzip{body: resp.Body}
			}
			scrubber.Header(resp.Header)
			resp.Header.Del("Content-Length")
			resp.ContentLength = -1
			resp.Body = &tally{
				ReadCloser: scrubber.Reader(resp.Body),
				atEOF:      func() { scrubber.Header(resp.Trailer) },
				done: func(n int64, eof bool, err error) {
					l.BytesOut = n
					c.streamOutcome(&l, eof, err, r.Context(), rt.gen)
					finish(l)
				},
			}
			return nil
		},
		ErrorHandler: func(rw http.ResponseWriter, _ *http.Request, err error) {
			status, decision, reason := c.failure(err, r.Context(), rt.gen)
			l := line
			l.Decision, l.Reason, l.Status, l.Detail = decision, reason, status, err.Error()
			finish(l)
			if reason == ReasonClientGone {
				return
			}
			rw.Header().Set("X-Keyd-Reason", reason)
			http.Error(rw, "keyd: "+reason, status)
		},
	}
	proxy.ServeHTTP(scrubbedWriter{ResponseWriter: w, s: scrubber}, r.WithContext(ctx))
}

// scrubbedWriter scrubs the headers of informational responses, which ReverseProxy relays as they
// arrive, before ModifyResponse sees anything.
type scrubbedWriter struct {
	http.ResponseWriter
	s *scrub.Scrubber
}

func (w scrubbedWriter) WriteHeader(code int) {
	if code < 200 {
		w.s.Header(w.ResponseWriter.Header())
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w scrubbedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// scrubberFor collects every secret bound to the destination; each is replaced by this cell's
// surrogate for it, or by a marker when the cell holds none.
func (c *Cell) scrubberFor(d keys.Dest) (*scrub.Scrubber, error) {
	mine := map[string]string{}
	for _, e := range c.deps.Registry.ForCell(c.cfg.CellID) {
		mine[e.Binding.SecretID] = e.Token
	}
	var pairs []scrub.Pair
	for _, rec := range c.deps.Vault.Records() {
		b, err := keys.FromRecord(rec)
		if err != nil {
			continue
		}
		hit := (rec.Kind == vault.KindHTTP && slices.Contains(b.Hosts, d.Host)) || (d.Scheme == "gateway" && b.Route == d.Route)
		if !hit {
			continue
		}
		value, err := c.deps.Vault.Value(rec.ID)
		if err != nil {
			return nil, err
		}
		repl := mine[rec.ID]
		if repl == "" {
			repl = redacted
		}
		pairs = append(pairs, scrub.Pair{Secret: value, Replacement: []byte(repl)})
	}
	return scrub.New(pairs...)
}

func (c *Cell) streamOutcome(l *audit.Line, eof bool, err error, reqCtx context.Context, g *generation) {
	switch {
	case eof && err == nil:
		return
	case g.ctx.Err() != nil:
		l.Decision, l.Reason = audit.Error, ReasonRevoked
	case reqCtx.Err() != nil:
		l.Decision, l.Reason = audit.Error, ReasonClientGone
	default:
		l.Decision, l.Reason = audit.Error, ReasonAborted
		if err != nil {
			l.Detail = err.Error()
		}
	}
}

// failure maps an error from before the response into a status, a decision and a reason.
func (c *Cell) failure(err error, reqCtx context.Context, g *generation) (int, string, string) {
	if errors.Is(err, errEncoding) {
		return http.StatusBadGateway, audit.Error, ReasonEncoding
	}
	if decision, reason := dialOutcome(err); reason != ReasonUpstream {
		status := http.StatusBadGateway
		if reason == ReasonAddress {
			status = http.StatusForbidden
		}
		return status, decision, reason
	}
	switch {
	case g.ctx.Err() != nil:
		return http.StatusServiceUnavailable, audit.Error, ReasonRevoked
	case reqCtx.Err() != nil:
		return 0, audit.Error, ReasonClientGone
	}
	return http.StatusBadGateway, audit.Error, ReasonUpstream
}

func dialOutcome(err error) (string, string) {
	var denied *netguard.DeniedError
	var resolve *netguard.ResolveError
	var cert *tls.CertificateVerificationError
	switch {
	case errors.As(err, &denied):
		return audit.Deny, ReasonAddress
	case errors.As(err, &resolve):
		return audit.Error, ReasonResolve
	case errors.As(err, &cert):
		return audit.Error, ReasonUpstreamTLS
	}
	return audit.Error, ReasonUpstream
}

// coding reads a response's Content-Encoding lines. Nothing, or a lone identity, leaves the body
// as it is; a lone gzip, which keyd asked for, is decoded so the scrubber reads the text. Any
// other coding, or more than one on any number of lines, is refused: a client would decode what
// keyd let by.
func coding(values []string) (gzipped, ok bool) {
	var codings []string
	for _, v := range values {
		for _, c := range strings.Split(v, ",") {
			if c = strings.TrimSpace(c); c != "" {
				codings = append(codings, strings.ToLower(c))
			}
		}
	}
	switch {
	case len(codings) == 0 || len(codings) == 1 && codings[0] == "identity":
		return false, true
	case len(codings) == 1 && codings[0] == "gzip":
		return true, true
	}
	return false, false
}

// gunzip decodes a gzip body as it is read, so a stream's first bytes do not wait.
type gunzip struct {
	body io.ReadCloser
	zr   *gzip.Reader
	err  error
}

func (g *gunzip) Read(p []byte) (int, error) {
	if g.zr == nil && g.err == nil {
		g.zr, g.err = gzip.NewReader(g.body)
	}
	if g.err != nil {
		return 0, g.err
	}
	return g.zr.Read(p)
}

func (g *gunzip) Close() error { return g.body.Close() }

func isUpgrade(r *http.Request) bool {
	return r.Header.Get("Upgrade") != "" || slices.ContainsFunc(r.Header.Values("Connection"), func(v string) bool {
		return strings.Contains(strings.ToLower(v), "upgrade")
	})
}

func bodyAllowed(method string, status int) bool {
	return method != http.MethodHead && status >= 200 && status != http.StatusNoContent && status != http.StatusNotModified
}

func msSince(t time.Time) float64 {
	return float64(time.Since(t).Microseconds()) / 1000
}

type counter struct {
	io.ReadCloser
	n int64
}

func (c *counter) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	c.n += int64(n)
	return n, err
}

// tally counts what reaches the client and reports once, on Close, how the stream ended.
type tally struct {
	io.ReadCloser
	n     int64
	eof   bool
	err   error
	atEOF func()
	done  func(n int64, eof bool, err error)
	once  sync.Once
}

func (t *tally) Read(p []byte) (int, error) {
	n, err := t.ReadCloser.Read(p)
	t.n += int64(n)
	switch {
	case err == io.EOF:
		if !t.eof {
			t.eof = true
			t.atEOF()
		}
	case err != nil:
		t.err = err
	}
	return n, err
}

func (t *tally) Close() error {
	err := t.ReadCloser.Close()
	t.once.Do(func() { t.done(t.n, t.eof, t.err) })
	return err
}
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/egress/`
Expected: `ok` (16 tests). The module has no dependency yet; `go.mod` is still Task 1's.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/egress
git commit -m "feat(keyd): per-cell listener with token auth and plain HTTP"
```

---
### Task 11: CONNECT — goproxy's front door and SNI-checked passthrough

`goproxy` (D5, A26) is the listener's CONNECT front door, configured so its own dialing and its
default transport — which skips TLS verification and honours `HTTPS_PROXY` — are never used: keyd
decides every CONNECT and hijacks every tunnel it accepts (P4a-R1). The CONNECT request is
inspected for surrogates first, its authority included. In this task every allowed host passes
through: keyd answers 200, reads the ClientHello with `crypto/tls` (the SNI peek adapted from
iron-proxy, with its Apache-2.0 license), requires its SNI to equal the CONNECT host, dials through
the guard and splices; the tunnel is tracked by the generation, so `Revoke` closes it.

**Files:**
- Create: `keyd/internal/egress/sni.go`, `keyd/internal/egress/connect.go`, `keyd/THIRD-PARTY.md`,
  `keyd/third_party/iron-proxy/LICENSE`
- Modify: `keyd/go.mod`, add `keyd/go.sum`; `keyd/internal/egress/cell.go` (the import, `Cell`,
  `Open`, `ServeHTTP`)
- Test: `keyd/internal/egress/connect_test.go`

**Interfaces:**
- Consumes: Task 10's `Cell`, `record`, `current`, `dialOutcome`, `msSince` and harness
  (`rawConnect`, `dialListener`, `world.tlsUpstream`, `world.name`, `get`); `policy.Policy.Connect`;
  `keys.Registry.Inspect` with `Dest{Scheme: "connect"}`.
- Produces: `(*Cell).newConnectProxy`, `handleConnect`, `hijack`, `refuseConnect`, `passthrough`;
  `sameHost`, `splice`, `peekSNI`; `ReasonNotTLS`, `ReasonSNIMismatch`; audit `mode`
  `"passthrough"` (one `connect` line per tunnel, written when it ends).

- [ ] **Step 1: Add goproxy, pinned**

```bash
go get github.com/elazarl/goproxy@v1.9.2
```
`go get` writes the requirement; `go mod tidy` (Step 6) settles `go.mod` at:
```text
module github.com/shadowhusky/localdot/keyd

go 1.27

toolchain go1.27.1

require github.com/elazarl/goproxy v1.9.2

require (
	golang.org/x/net v0.50.0 // indirect
	golang.org/x/text v0.34.0 // indirect
)
```
and `go.sum` at (goproxy's own test dependencies appear for the module graph only; none is compiled):
```text
github.com/coder/websocket v1.8.14 h1:9L0p0iKiNOibykf283eHkKUHHrpG7f65OE3BhhO7v9g=
github.com/coder/websocket v1.8.14/go.mod h1:NX3SzP+inril6yawo5CQXx8+fk145lPDC6pumgx0mVg=
github.com/davecgh/go-spew v1.1.1 h1:vj9j/u1bqnvCEfJOwUhtlOARqs3+rkHYY13jYWTU97c=
github.com/davecgh/go-spew v1.1.1/go.mod h1:J7Y8YcW2NihsgmVo/mv3lAwl/skON4iLHjSsI+c5H38=
github.com/elazarl/goproxy v1.9.2 h1:+vXRRSWrznMtBrAb559qfqC+Cny1Q3rR0l51Yu/3WUw=
github.com/elazarl/goproxy v1.9.2/go.mod h1:THdE5ix2clxX9lZzcICPpZ67d6CdrPZxdOYsNgU5e30=
github.com/pmezard/go-difflib v1.0.0 h1:4DBwDE0NGyQoBHbLQYPwSUPoCMWR5BEzIk/f1lZbAQM=
github.com/pmezard/go-difflib v1.0.0/go.mod h1:iKH77koFhYxTK1pcRnkKkqfTogsbg7gZNVY4sRDYZ/4=
github.com/stretchr/testify v1.11.1 h1:7s2iGBzp5EwR7/aIZr8ao5+dra3wiQyKjjFuvgVKu7U=
github.com/stretchr/testify v1.11.1/go.mod h1:wZwfW3scLgRK+23gO65QZefKpKQRnfz6sD981Nm4B6U=
golang.org/x/net v0.50.0 h1:ucWh9eiCGyDR3vtzso0WMQinm2Dnt8cFMuQa9K33J60=
golang.org/x/net v0.50.0/go.mod h1:UgoSli3F/pBgdJBHCTc+tp3gmrU4XswgGRgtnwWTfyM=
golang.org/x/text v0.34.0 h1:oL/Qq0Kdaqxa1KbNeMKwQq0reLCCaFtqu2eNuSeNHbk=
golang.org/x/text v0.34.0/go.mod h1:homfLqTYRFyVYemLBFl5GgL/DWEiH5wcsQ5gSh1yziA=
gopkg.in/yaml.v3 v3.0.1 h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=
gopkg.in/yaml.v3 v3.0.1/go.mod h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM=
```

- [ ] **Step 2: Write the failing tests**

`keyd/internal/egress/connect_test.go`:
```go
package egress

import (
	"crypto/tls"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

func TestPassthroughKeepsTheUpstreamCertificate(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "tls-ok") }))
	c := w.cell("c1", policy.Desktop)
	resp, err := w.client(c).Get("https://www.example.test/page")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "tls-ok" || resp.TLS.PeerCertificates[0].Issuer.CommonName != "upstream test CA" {
		t.Fatalf("body %q issuer %q", body, resp.TLS.PeerCertificates[0].Issuer.CommonName)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "passthrough" && l.Decision == audit.Allow })
	if l.Host != "www.example.test" || l.SNI != "www.example.test" || l.BytesIn == 0 || l.BytesOut == 0 {
		t.Fatalf("audit %+v", l)
	}
}

func TestConnectPolicy(t *testing.T) {
	w := newWorld(t)
	desktop := w.cell("c1", policy.Desktop)
	brain := w.cell("c2", policy.Brain)
	cases := []struct {
		name      string
		cell      *Cell
		authority string
		reason    string
	}{
		{"ip literal", desktop, "127.0.0.1:443", policy.ReasonIPLiteral},
		{"ipv6 literal", desktop, "[::1]:443", policy.ReasonIPLiteral},
		{"mapped literal", desktop, "[::ffff:127.0.0.1]:443", policy.ReasonIPLiteral},
		{"metadata literal", desktop, "169.254.169.254:443", policy.ReasonIPLiteral},
		{"tls on 443 only", desktop, "www.example.test:8443", policy.ReasonPort},
		{"port required", desktop, "www.example.test", policy.ReasonHostInvalid},
		{"deny list", desktop, "nas.home.arpa:443", policy.ReasonHostDenied},
		{"the gateway is plain http only", desktop, "llm.ldot:443", policy.ReasonHostDenied},
		{"brain has no web", brain, "www.example.test:443", policy.ReasonNoWeb},
	}
	for _, c := range cases {
		_, resp := rawConnect(t, c.cell, c.authority)
		if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != c.reason {
			t.Errorf("%s: %d %q, want 403 %q", c.name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), c.reason)
		}
	}
}

func TestASurrogateOnTheConnectItselfIsRefused(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c1", policy.Desktop)
	conn, err := dialListener(c)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "CONNECT www.example.test:443 HTTP/1.1\r\nHost: www.example.test:443\r\nProxy-Authorization: Basic "+
		basicAuth("cell", testToken)+"\r\nAuthorization: Bearer ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA\r\n\r\n")
	line, _ := io.ReadAll(io.LimitReader(conn, 12))
	if string(line) != "HTTP/1.1 403" {
		t.Fatalf("got %q", line)
	}
	w.waitLine(func(l audit.Line) bool { return l.Kind == audit.KindConnect && l.Reason == "unknown-surrogate" })
}

func TestSNIMustMatchTheConnectHost(t *testing.T) {
	w := newWorld(t)
	reached := make(chan struct{}, 1)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached <- struct{}{} }))
	c := w.cell("c1", policy.Desktop)
	for _, sni := range []string{"other.example.test", ""} {
		conn, resp := rawConnect(t, c, "www.example.test:443")
		if resp.StatusCode != 200 {
			t.Fatalf("CONNECT: %d", resp.StatusCode)
		}
		cfg := &tls.Config{ServerName: sni, InsecureSkipVerify: true}
		tc := tls.Client(conn, cfg)
		tc.SetDeadline(time.Now().Add(3 * time.Second))
		if err := tc.Handshake(); err == nil {
			t.Fatalf("SNI %q: handshake succeeded", sni)
		}
	}
	select {
	case <-reached:
		t.Fatal("the upstream was reached")
	default:
	}
	l := w.waitLine(reasonIs(ReasonSNIMismatch))
	if l.Host != "www.example.test" || l.Decision != audit.Deny {
		t.Fatalf("audit %+v", l)
	}
}

func TestATunnelMustCarryTLS(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	c := w.cell("c1", policy.Desktop)
	conn, _ := rawConnect(t, c, "www.example.test:443")
	io.WriteString(conn, "GET / HTTP/1.1\r\nHost: api.example.test\r\n\r\n")
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if n, _ := conn.Read(make([]byte, 1)); n != 0 {
		t.Fatal("plain HTTP inside a tunnel got an answer")
	}
	w.waitLine(reasonIs(ReasonNotTLS))
}

func TestAPassthroughToAPrivateAddressIsRefusedAtDial(t *testing.T) {
	w := newWorld(t)
	w.name("rebind.example.test", "192.168.65.254")
	c := w.cell("c1", policy.Desktop)
	conn, resp := rawConnect(t, c, "rebind.example.test:443")
	if resp.StatusCode != 200 {
		t.Fatalf("CONNECT: %d", resp.StatusCode)
	}
	tc := tls.Client(conn, &tls.Config{ServerName: "rebind.example.test", InsecureSkipVerify: true})
	tc.SetDeadline(time.Now().Add(3 * time.Second))
	if err := tc.Handshake(); err == nil {
		t.Fatal("handshake through a denied address")
	}
	l := w.waitLine(reasonIs(ReasonAddress))
	if l.Decision != audit.Deny || !strings.Contains(l.Detail, "docker desktop") {
		t.Fatalf("audit %+v", l)
	}
}

func TestKeydNeverDialsThroughAnotherProxy(t *testing.T) {
	for _, name := range []string{"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy"} {
		t.Setenv(name, "http://127.0.0.1:9")
	}
	w := newWorld(t)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "direct") }))
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "direct") }))
	c := w.cell("c1", policy.Desktop)
	for _, u := range []string{"http://ports.example.test/", "https://www.example.test/"} {
		if resp, body := get(t, w.client(c), u); resp.StatusCode != 200 || body != "direct" {
			t.Fatalf("%s: %d %q", u, resp.StatusCode, body)
		}
	}
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `go test ./internal/egress/`
Expected: FAIL — `[build failed]`, starting `internal/egress/connect_test.go:101:27: undefined: ReasonSNIMismatch`.

- [ ] **Step 4: Implement CONNECT**

`keyd/internal/egress/sni.go`:
```go
// Adapted from iron-proxy v0.52.0 internal/proxy/snipeek.go, Copyright the iron-proxy authors,
// Apache-2.0 (third_party/iron-proxy/LICENSE). Changed: renamed, the error reports whether a
// ClientHello was seen at all, and the size cap comes from the caller's package.
package egress

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

const maxClientHello = 16 * 1024

var errHelloSeen = errors.New("client hello read")

// peekSNI drives crypto/tls just far enough to parse the ClientHello, returning its server name
// and the bytes read, which the caller replays upstream. Nothing is written to the client.
func peekSNI(conn net.Conn, timeout time.Duration) (string, []byte, error) {
	deadline := time.Now().Add(timeout)
	if err := conn.SetReadDeadline(deadline); err != nil {
		return "", nil, err
	}
	defer conn.SetReadDeadline(time.Time{})
	rec := &recordingConn{Conn: conn}
	var name string
	seen := false
	cfg := &tls.Config{GetConfigForClient: func(h *tls.ClientHelloInfo) (*tls.Config, error) {
		name, seen = h.ServerName, true
		return nil, errHelloSeen
	}}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	err := tls.Server(rec, cfg).HandshakeContext(ctx)
	if !seen {
		return "", nil, fmt.Errorf("no TLS client hello: %w", err)
	}
	return name, rec.buf.Bytes(), nil
}

type recordingConn struct {
	net.Conn
	buf bytes.Buffer
}

func (c *recordingConn) Read(p []byte) (int, error) {
	if c.buf.Len() >= maxClientHello {
		return 0, io.ErrShortBuffer
	}
	n, err := c.Conn.Read(p)
	c.buf.Write(p[:n])
	return n, err
}

func (c *recordingConn) Write(p []byte) (int, error) { return len(p), nil }
```

`keyd/internal/egress/connect.go`:
```go
package egress

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/elazarl/goproxy"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

const (
	ReasonNotTLS      = "not-tls"
	ReasonSNIMismatch = "sni-mismatch"
)

var errNoDial = errors.New("egress: goproxy must not dial; every CONNECT is hijacked or refused")

// newConnectProxy configures goproxy to hand every CONNECT to keyd. Its own dialing and transport,
// which skip TLS verification and honour HTTPS_PROXY, are disabled.
func (c *Cell) newConnectProxy() *goproxy.ProxyHttpServer {
	p := goproxy.NewProxyHttpServer()
	p.Logger = log.New(io.Discard, "", 0)
	p.ConnectDial = nil
	p.ConnectDialWithReq = nil
	p.Tr = &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) { return nil, errNoDial }}
	p.OnRequest().HandleConnectFunc(c.handleConnect)
	return p
}

func (c *Cell) handleConnect(hostport string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
	line := audit.Line{Kind: audit.KindConnect, Method: http.MethodConnect, Host: hostport}
	if v := c.deps.Registry.Inspect(keys.Dest{Cell: c.cfg.CellID, Scheme: "connect"}, http.MethodConnect, ctx.Req.URL, ctx.Req.Header); !v.Allow {
		line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
		return c.refuseConnect(ctx, line, v.Reason)
	}
	t, reason := policy.ParseHostPort(hostport, 0)
	if reason != "" {
		return c.refuseConnect(ctx, line, reason)
	}
	line.Host = t.Host
	d := c.cfg.Policy.Connect(t, c.intercepted)
	if !d.Allow {
		return c.refuseConnect(ctx, line, d.Reason)
	}
	return c.hijack(func(client net.Conn) { c.passthrough(client, t, line) }), hostport
}

func (c *Cell) hijack(fn func(client net.Conn)) *goproxy.ConnectAction {
	return &goproxy.ConnectAction{Action: goproxy.ConnectHijack, Hijack: func(_ *http.Request, client net.Conn, _ *goproxy.ProxyCtx) {
		fn(client)
	}}
}

func (c *Cell) refuseConnect(ctx *goproxy.ProxyCtx, line audit.Line, reason string) (*goproxy.ConnectAction, string) {
	line.Decision, line.Reason, line.Status = audit.Deny, reason, http.StatusForbidden
	c.record(line)
	resp := goproxy.NewResponse(ctx.Req, goproxy.ContentTypeText, http.StatusForbidden, "keyd: "+reason+"\n")
	resp.Header.Set("X-Keyd-Reason", reason)
	ctx.Resp = resp
	return goproxy.RejectConnect, ""
}

// passthrough relays an allowed host's TLS untouched once its ClientHello names that host.
func (c *Cell) passthrough(client net.Conn, t policy.Target, line audit.Line) {
	defer client.Close()
	start := time.Now()
	g := c.current()
	defer g.track(client)()
	line.Mode = "passthrough"
	finish := func(decision, reason string, err error) {
		line.Decision, line.Reason = decision, reason
		if err != nil {
			line.Detail = err.Error()
		}
		line.DurationMs = msSince(start)
		c.record(line)
	}
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		finish(audit.Error, ReasonClientGone, err)
		return
	}
	sni, hello, err := peekSNI(client, 10*time.Second)
	if err != nil {
		finish(audit.Deny, ReasonNotTLS, err)
		return
	}
	line.SNI = sni
	if !sameHost(sni, t.Host) {
		finish(audit.Deny, ReasonSNIMismatch, nil)
		return
	}
	up, err := c.deps.Dialer.DialContext(g.ctx, "tcp", net.JoinHostPort(t.Host, "443"))
	if err != nil {
		decision, reason := dialOutcome(err)
		finish(decision, reason, err)
		return
	}
	defer up.Close()
	defer g.track(up)()
	if _, err := up.Write(hello); err != nil {
		finish(audit.Error, ReasonUpstream, err)
		return
	}
	in, out := splice(client, up)
	line.BytesIn, line.BytesOut = in+int64(len(hello)), out
	line.Status = http.StatusOK
	if g.ctx.Err() != nil {
		finish(audit.Error, ReasonRevoked, nil)
		return
	}
	finish(audit.Allow, "", nil)
}

func sameHost(sni, host string) bool {
	return sni != "" && strings.EqualFold(strings.TrimSuffix(sni, "."), host)
}

// splice copies both ways until either side ends, then closes both.
func splice(client, up net.Conn) (in, out int64) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		in, _ = io.Copy(up, client)
		up.Close()
		client.Close()
	}()
	go func() {
		defer wg.Done()
		out, _ = io.Copy(client, up)
		client.Close()
		up.Close()
	}()
	wg.Wait()
	return in, out
}
```

In `keyd/internal/egress/cell.go`, replace:
```go
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
```
with:
```go
	"time"

	"github.com/elazarl/goproxy"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
```

In `keyd/internal/egress/cell.go`, replace:
```go
	srv         *http.Server
	intercepted map[string]bool
```
with:
```go
	srv         *http.Server
	connect     *goproxy.ProxyHttpServer
	intercepted map[string]bool
```

In `keyd/internal/egress/cell.go`, replace:
```go
	c := &Cell{cfg: cfg, deps: deps, ln: ln, gen: newGeneration(deps), intercepted: map[string]bool{}}
	c.srv = &http.Server{
```
with:
```go
	c := &Cell{cfg: cfg, deps: deps, ln: ln, gen: newGeneration(deps), intercepted: map[string]bool{}}
	c.connect = c.newConnectProxy()
	c.srv = &http.Server{
```

In `keyd/internal/egress/cell.go`, replace:
```go
	case r.Method == http.MethodConnect:
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
```
with:
```go
	case r.Method == http.MethodConnect:
		c.connect.ServeHTTP(w, r)
```

- [ ] **Step 5: The adapted code's license**

```bash
dir=$(go mod download -json github.com/ironsh/iron-proxy@v0.52.0 | sed -n 's/.*"Dir": "\(.*\)",/\1/p')
mkdir -p third_party/iron-proxy && cp "$dir/LICENSE" third_party/iron-proxy/LICENSE && chmod 644 third_party/iron-proxy/LICENSE
shasum -a 256 third_party/iron-proxy/LICENSE
```
Expected: `f1a78af3197c0b00175f19f18a65f537c957ff87c180997cf6a038f8aa6f0906` (the Apache-2.0 text
from the v0.52.0 module, verified by Go's checksum database). `go mod download` of a module outside
the build does not touch `go.mod`.

`keyd/THIRD-PARTY.md`:
```markdown
# keyd third-party code

| Module | Version | License | Used for |
|---|---|---|---|
| `github.com/elazarl/goproxy` | v1.9.2 | BSD-3-Clause | the per-cell listener's CONNECT handling |
| `golang.org/x/net` | v0.50.0 | BSD-3-Clause | HTTP/2, through goproxy |
| `golang.org/x/text` | v0.34.0 | BSD-3-Clause | through `golang.org/x/net` |

`internal/egress/sni.go` is adapted from iron-proxy v0.52.0 (`internal/proxy/snipeek.go`,
Apache-2.0); the license is in `third_party/iron-proxy/LICENSE`. keyd's dial-time address check,
its Basic-auth-aware swap and the shape of its audit lines follow iron-proxy's design without its
code.
```

- [ ] **Step 6: Run the tests**

```bash
go mod tidy && go mod verify
go test -race ./internal/egress/
```
Expected: `all modules verified`; `ok` (23 tests). `git diff go.mod` shows exactly the file in
Step 1.

- [ ] **Step 7: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add go.mod go.sum internal/egress THIRD-PARTY.md third_party
git commit -m "feat(keyd): CONNECT through goproxy with SNI-checked passthrough"
```

---
### Task 12: Selective interception — terminate only the bound hosts, swap, scrub

"For hosts that need a swap or HTTP-level policy, keyd terminates TLS with a per-cell,
name-constrained CA that exists only in memory (Chromium enforces its constraints); other allowed
hosts pass through untouched with an SNI = CONNECT-host check. Policy follows the inner request, not
the CONNECT." iron-proxy could do only all or nothing (S4, D7). A cell's `Config` now takes its CA,
and the CA's hosts are the hosts it intercepts. For those, keyd answers 200, terminates TLS with a
leaf from the CA — its `GetCertificate` refuses a ClientHello whose SNI is not the CONNECT host —
and serves the requests inside the tunnel with its own `net/http` server, whose request contexts
hang off the generation, so the kill switch reaches them. Each inner request must name the tunnel's
host and port in its `Host` and in any absolute URL (421 otherwise, or 403 with a `key.use` alert
when the `Host` it names holds a surrogate, which net/http keeps out of the request's headers;
review 2); it is then inspected, swapped and relayed by Task 10's `forward` to that host only, over
verified TLS, and its response scrubbed.
A handshake the client aborts (it does not trust the cell CA) and an SNI mismatch are audited
decisions (A25). Upgrades are refused on intercepted hosts: a WebSocket frame cannot be scrubbed
(P4a-R11). Informational (1xx) response headers are scrubbed too (`scrubbedWriter`, Task 10). The
tests also pin, on the wire, two rules other tasks own: Task 9's path and method limits (the
review's probes reached the upstream with the real key) and Task 10's refusal to swap while the
audit log is failing.

**Files:**
- Create: `keyd/internal/egress/mitm.go`
- Modify: `keyd/internal/egress/deps.go` (replace), `keyd/internal/egress/cell.go` (`Open`),
  `keyd/internal/egress/connect.go` (`handleConnect`)
- Test: `keyd/internal/egress/mitm_test.go`

**Interfaces:**
- Consumes: `cellca.New`, `(*CA).Leaf`, `(*CA).Hosts`, `(*CA).Certificate` (Task 6); the Task 10
  harness (`newWorld`, `world.tlsUpstream`, `world.client`, `world.mint`, `world.secret`,
  `world.waitLine`, `rawConnect`, `reasonIs`); `forward`, `route`, `msSince` (Task 10); `sameHost`
  (Task 11); `keys.Registry.Inspect` (Task 9).
- Produces: `Config.CA *cellca.CA` (nil: nothing intercepted); `(*Cell).mitm`; reasons used:
  `ReasonSNIMismatch`, `ReasonHandshake`, `ReasonHostMismatch`, `ReasonUpgrade`,
  `ReasonUpstreamTLS`; audit `mode` `"mitm"` (one `connect` line per tunnel, one `request` line per
  inner request). Test helpers for later tasks: `(*world).interceptingCell(id, role, hosts...) (*Cell, *x509.Certificate)`,
  `do(t, client, method, url, header)`, `echo`, `bearerSecret`, `realValue`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/egress/mitm_test.go`:
```go
package egress

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/cellca"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const realValue = "real-secret-value-for-test"

func (w *world) interceptingCell(id string, role policy.Role, hosts ...string) (*Cell, *x509.Certificate) {
	w.t.Helper()
	ca, err := cellca.New(id, hosts)
	if err != nil {
		w.t.Fatal(err)
	}
	p, _ := policy.ForRole(role)
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken, CA: ca}, w.deps())
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { c.Close() })
	return c, ca.Certificate()
}

// echo answers with the request's Authorization header in the body and a header, and counts hits.
func echo(hits *atomic.Int32, seen chan<- string) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		auth := r.Header.Get("Authorization")
		if seen != nil {
			seen <- auth
		}
		rw.Header().Set("X-Echo-Auth", auth)
		json.NewEncoder(rw).Encode(map[string]string{"authorization": auth})
	})
}

func bearerSecret(w *world, id, host string) {
	w.secret(vault.Record{ID: id, Kind: vault.KindHTTP, Hosts: []string{host}, Header: "Authorization", Format: "bearer"}, realValue)
}

func do(t *testing.T, client *http.Client, method, rawURL string, header http.Header) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, rawURL, nil)
	for k, vs := range header {
		req.Header[k] = vs
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func TestASurrogateIsSwappedOnItsHostAndTheEchoIsScrubbed(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	seen := make(chan string, 1)
	w.tlsUpstream("api.example.test", echo(&hits, seen))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()

	resp, body := do(t, w.client(c, caCert), "GET", "https://api.example.test/v1/forecast?city=x", http.Header{"Authorization": {"Bearer " + tok}})
	if got := <-seen; got != "Bearer "+realValue {
		t.Fatalf("upstream saw %q", got)
	}
	if resp.StatusCode != 200 || strings.Contains(body, realValue) || !strings.Contains(body, tok) || resp.Header.Get("X-Echo-Auth") != "Bearer "+tok {
		t.Fatalf("client saw %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if issuer := resp.TLS.PeerCertificates[0].Issuer.CommonName; issuer != "localDot cell CA" {
		t.Fatalf("leaf issued by %q", issuer)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "mitm" && l.Kind == audit.KindRequest })
	if !l.Swapped || l.SecretID != "weather" || l.SurrogateID != surrogate.ID(tok) || l.Decision != audit.Allow || l.Path != "/v1/forecast" {
		t.Fatalf("audit %+v", l)
	}
	e := <-sub
	if ku := e.Data.(events.KeyUse); ku.SecretID != "weather" || ku.Decision != "allow" || ku.Host != "api.example.test" {
		t.Fatalf("event %+v", e)
	}
}

func TestReflectionsInEveryFormAreScrubbed(t *testing.T) {
	forms := map[string]http.HandlerFunc{
		"plain body": func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "token="+realValue) },
		"encoded body": func(rw http.ResponseWriter, _ *http.Request) {
			io.WriteString(rw, base64.StdEncoding.EncodeToString([]byte("user:"+realValue))+" "+hex.EncodeToString([]byte(realValue))+" "+url.QueryEscape(realValue))
		},
		"split across writes": func(rw http.ResponseWriter, _ *http.Request) {
			for i := range len(realValue) {
				io.WriteString(rw, realValue[i:i+1])
				rw.(http.Flusher).Flush()
			}
		},
		"gzip body": func(rw http.ResponseWriter, r *http.Request) {
			if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				http.Error(rw, "gzip was not requested", 500)
				return
			}
			rw.Header().Set("Content-Encoding", "gzip")
			zw := gzip.NewWriter(rw)
			for range 200 {
				io.WriteString(zw, "padding "+realValue+" ")
			}
			zw.Close()
		},
		"redirect location": func(rw http.ResponseWriter, r *http.Request) {
			http.Redirect(rw, r, "https://cdn.example.test/f?key="+url.QueryEscape(realValue), http.StatusFound)
		},
		"set-cookie": func(rw http.ResponseWriter, _ *http.Request) {
			rw.Header().Set("Set-Cookie", "k="+realValue+"; Path=/")
		},
		"trailer": func(rw http.ResponseWriter, _ *http.Request) {
			rw.Header().Set("Trailer", "X-Echo")
			io.WriteString(rw, "body")
			rw.Header().Set("X-Echo", realValue)
		},
	}
	for name, handler := range forms {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			w.tlsUpstream("api.example.test", handler)
			bearerSecret(w, "weather", "api.example.test")
			c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
			tok := w.mint("c1", "weather")
			resp, body := do(t, w.client(c, caCert), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
			everything := body + resp.Header.Get("Location") + resp.Header.Get("Set-Cookie") + resp.Trailer.Get("X-Echo")
			for _, form := range []string{realValue, hex.EncodeToString([]byte(realValue)), url.QueryEscape(realValue), base64.StdEncoding.EncodeToString([]byte("user:" + realValue))} {
				if strings.Contains(everything, form) {
					t.Fatalf("the client saw %q in %q", form, everything)
				}
			}
			if name == "gzip body" && (!strings.Contains(body, "padding "+tok) || resp.Header.Get("Content-Encoding") != "") {
				t.Fatalf("gzip: %d bytes, encoding %q", len(body), resp.Header.Get("Content-Encoding"))
			}
		})
	}
}

func TestInformationalResponseHeadersAreScrubbed(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("api.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Link", "<https://cdn.example.test/app.js?k="+realValue+">; rel=preload")
		rw.WriteHeader(http.StatusEarlyHints)
		rw.Header().Del("Link")
		io.WriteString(rw, "ok")
	}))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	var hints []string
	trace := &httptrace.ClientTrace{Got1xxResponse: func(code int, h textproto.MIMEHeader) error {
		hints = append(hints, h.Get("Link"))
		return nil
	}}
	req, _ := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), "GET", "https://api.example.test/", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := w.client(c, caCert).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(hints) != 1 || strings.Contains(hints[0], realValue) || !strings.Contains(hints[0], tok) {
		t.Fatalf("early hints %q", hints)
	}
}

func TestBrowsingABoundHostWithoutTheSurrogateIsUntouched(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	seen := make(chan string, 1)
	w.tlsUpstream("api.example.test", echo(&hits, seen))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/docs", nil)
	if resp.StatusCode != 200 || <-seen != "" {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestMisplacedAndUnknownSurrogatesNeverReachTheUpstream(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	foreign := w.mint("c2", "weather")
	unknown, _ := surrogate.Mint("key")
	cases := []struct {
		name   string
		url    string
		header http.Header
		reason string
	}{
		{"unknown surrogate", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + unknown}}, "unknown-surrogate"},
		{"another cell's surrogate", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + foreign}}, "misplaced-surrogate"},
		{"wrong header", "https://api.example.test/", http.Header{"X-Api-Key": {tok}}, "misplaced-surrogate"},
		{"substring", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok + "x y"}}, "misplaced-surrogate"},
		{"in the query", "https://api.example.test/?key=" + tok, nil, "misplaced-surrogate"},
	}
	for _, cs := range cases {
		resp, _ := do(t, w.client(c, caCert), "GET", cs.url, cs.header)
		if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != cs.reason {
			t.Errorf("%s: %d %q", cs.name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the upstream was reached %d times", n)
	}
}

func TestPathAndMethodLimitsHoldOnTheWire(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	w.secret(vault.Record{ID: "ro", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}, Paths: []string{"/v1/"}}, realValue)
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "ro")
	bearer := http.Header{"Authorization": {"Bearer " + tok}}
	// Real servers read each of these paths as /admin, or as a method other than GET.
	for _, u := range []string{
		"https://api.example.test/v1/../admin",
		"https://api.example.test/v1/%2e%2e/admin",
		"https://api.example.test/v1%2f..%2fadmin",
		"https://api.example.test/v1/%2E%2E/admin",
		"https://api.example.test/v1//admin",
		"https://api.example.test/v1/..;/admin",
		"https://api.example.test/v1/x?_method=DELETE",
	} {
		if resp, _ := do(t, w.client(c, caCert), "GET", u, bearer); resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != "surrogate-policy" {
			t.Errorf("%s: %d %q", u, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
	}
	override := http.Header{"Authorization": {"Bearer " + tok}, "X-Http-Method-Override": {"DELETE"}}
	if resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/v1/x", override); resp.StatusCode != 403 {
		t.Errorf("method override: %d", resp.StatusCode)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the upstream got the real key %d times", n)
	}
	if resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/v1/forecast", bearer); resp.StatusCode != 200 || hits.Load() != 1 {
		t.Fatalf("a path inside the limit: %d", resp.StatusCode)
	}
}

func TestSwapsStopWhileTheAuditLogCannotBeWritten(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	w.audit.Close()
	do(t, w.client(c, caCert), "GET", "http://keyd.ldot/health", nil)
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != "audit-unavailable" || hits.Load() != 0 {
		t.Fatalf("%d %q, upstream reached %d times", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
}

func dialIntercepted(t *testing.T, w *world, c *Cell, caCert *x509.Certificate, sni string) (*tls.Conn, error) {
	t.Helper()
	conn, resp := rawConnect(t, c, "api.example.test:443")
	if resp.StatusCode != 200 {
		t.Fatalf("CONNECT: %d", resp.StatusCode)
	}
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	tc := tls.Client(conn, &tls.Config{ServerName: sni, RootCAs: roots})
	tc.SetDeadline(time.Now().Add(3 * time.Second))
	return tc, tc.Handshake()
}

func TestTheInnerHostMustMatchTheTunnel(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	w.tlsUpstream("evil.example.test", echo(&hits, nil))
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	for _, request := range []string{
		"GET / HTTP/1.1\r\nHost: evil.example.test\r\n\r\n",
		"GET https://evil.example.test/ HTTP/1.1\r\nHost: api.example.test\r\n\r\n",
		"GET / HTTP/1.1\r\nHost: api.example.test:8443\r\n\r\n",
	} {
		tc, err := dialIntercepted(t, w, c, caCert, "api.example.test")
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(tc, request)
		resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusMisdirectedRequest || resp.Header.Get("X-Keyd-Reason") != ReasonHostMismatch {
			t.Errorf("%q: %d", request, resp.StatusCode)
		}
	}
	if hits.Load() != 0 {
		t.Fatal("an upstream was reached")
	}
}

func TestASurrogateInTheHostHeaderIsRefusedAndAlerted(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	tc, err := dialIntercepted(t, w, c, caCert, "api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(tc, "GET / HTTP/1.1\r\nHost: "+tok+".api.example.test\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != "misplaced-surrogate" || hits.Load() != 0 {
		t.Fatalf("%d %q, upstream reached %d times", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
	select {
	case e := <-sub:
		if ku, ok := e.Data.(events.KeyUse); !ok || ku.SecretID != "weather" || ku.Decision != "deny" || strings.Contains(ku.Host+ku.Path, tok) {
			t.Fatalf("event %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no key.use alert")
	}
}

func TestAnInterceptedHandshakeChecksSNIAndRecordsAborts(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("api.example.test", echo(new(atomic.Int32), nil))
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	if _, err := dialIntercepted(t, w, c, caCert, "evil.example.test"); err == nil {
		t.Fatal("handshake with a mismatched SNI succeeded")
	}
	l := w.waitLine(reasonIs(ReasonSNIMismatch))
	if l.Mode != "mitm" || l.SNI != "evil.example.test" {
		t.Fatalf("audit %+v", l)
	}
	// A client that does not trust the cell CA aborts the handshake; keyd records it.
	if _, err := w.client(c).Get("https://api.example.test/"); err == nil {
		t.Fatal("a client without the cell CA completed the handshake")
	}
	w.waitLine(func(l audit.Line) bool {
		return l.Reason == ReasonHandshake && strings.Contains(l.Detail, "certificate")
	})
}

func TestTheSecretOnlyLeavesOverVerifiedTLS(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	ca, _ := cellca.New("c1", []string{"api.example.test"})
	p, _ := policy.ForRole(policy.Desktop)
	deps := w.deps()
	deps.RootCAs = x509.NewCertPool()
	c, err := Open(Config{CellID: "c1", Policy: p, Token: testToken, CA: ca}, deps)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	tok := w.mint("c1", "weather")
	resp, _ := do(t, w.client(c, ca.Certificate()), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
	if resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonUpstreamTLS || hits.Load() != 0 {
		t.Fatalf("%d %q hits %d", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
}

func TestABoundHostResolvingToAPrivateAddressIsRefused(t *testing.T) {
	w := newWorld(t)
	w.name("api.example.test", "127.0.0.1")
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
	if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonAddress {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestUpgradesAreRefusedOnInterceptedHosts(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/ws", http.Header{"Connection": {"Upgrade"}, "Upgrade": {"websocket"}})
	if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonUpgrade || hits.Load() != 0 {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestBasicAuthIsSwappedInsideTheEncoding(t *testing.T) {
	w := newWorld(t)
	seen := make(chan string, 1)
	w.tlsUpstream("git.example.test", echo(new(atomic.Int32), seen))
	w.secret(vault.Record{ID: "git", Kind: vault.KindHTTP, Hosts: []string{"git.example.test"}, Header: "Authorization", Format: "basic-password"}, realValue)
	c, caCert := w.interceptingCell("c1", policy.Desktop, "git.example.test")
	tok := w.mint("c1", "git")
	header := http.Header{"Authorization": {"Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+tok))}}
	resp, body := do(t, w.client(c, caCert), "GET", "https://git.example.test/repo.git/info/refs", header)
	if got := <-seen; got != "Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+realValue)) {
		t.Fatalf("upstream saw %q", got)
	}
	decoded, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(resp.Header.Get("X-Echo-Auth"), "Basic "))
	if resp.StatusCode != 200 || strings.Contains(string(decoded), realValue) || strings.Contains(body, base64.StdEncoding.EncodeToString([]byte("x-access-token:"+realValue))) {
		t.Fatalf("the reflected basic credential still carries the secret: %q / %q", decoded, body)
	}
}

func TestAnUnscrubbableEncodingIsRefused(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("api.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Encoding", "br")
		rw.Write([]byte{0x1b, 0x00})
	}))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
	if resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonEncoding {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/egress/`
Expected: FAIL — `[build failed]`: `internal/egress/mitm_test.go:39:65: unknown field CA in struct literal of type Config`.

- [ ] **Step 3: Give the cell its CA**

Replace `keyd/internal/egress/deps.go` with:
```go
package egress

import (
	"context"
	"crypto/x509"
	"net"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/cellca"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Dialer is satisfied by *netguard.Dialer.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

type Config struct {
	CellID string
	Policy policy.Policy
	// Port 0 picks a free port; tests use it.
	Port  int
	Token string
	// CA terminates TLS for its hosts; without one nothing is intercepted.
	CA *cellca.CA
}

type Deps struct {
	Registry *keys.Registry
	Vault    *vault.Vault
	Audit    *audit.Log
	Events   *events.Hub
	Dialer   Dialer
	// RootCAs verifies upstream TLS; nil means the system roots.
	RootCAs *x509.CertPool
}
```

In `keyd/internal/egress/cell.go`, replace:
```go
	c := &Cell{cfg: cfg, deps: deps, ln: ln, gen: newGeneration(deps), intercepted: map[string]bool{}}
	c.connect = c.newConnectProxy()
```
with:
```go
	c := &Cell{cfg: cfg, deps: deps, ln: ln, gen: newGeneration(deps), intercepted: map[string]bool{}}
	if cfg.CA != nil {
		for _, h := range cfg.CA.Hosts() {
			c.intercepted[h] = true
		}
	}
	c.connect = c.newConnectProxy()
```

In `keyd/internal/egress/connect.go`, replace:
```go
	if !d.Allow {
		return c.refuseConnect(ctx, line, d.Reason)
	}
	return c.hijack(func(client net.Conn) { c.passthrough(client, t, line) }), hostport
```
with:
```go
	if !d.Allow {
		return c.refuseConnect(ctx, line, d.Reason)
	}
	if d.MITM {
		return c.hijack(func(client net.Conn) { c.mitm(client, t, line) }), hostport
	}
	return c.hijack(func(client net.Conn) { c.passthrough(client, t, line) }), hostport
```

- [ ] **Step 4: Terminate, check, serve**

`keyd/internal/egress/mitm.go`:
```go
package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

var errSNI = errors.New("egress: client hello names another host")

// mitm terminates TLS for an intercepted host with a leaf from the cell's CA, then serves the
// requests inside the tunnel with net/http, each one checked against the host the CONNECT and
// the SNI named. Upstream, the request goes to that host only, never to the Host a request names.
func (c *Cell) mitm(client net.Conn, t policy.Target, line audit.Line) {
	defer client.Close()
	start := time.Now()
	g := c.current()
	defer g.track(client)()
	line.Mode = "mitm"
	record := func(decision, reason string, err error) {
		line.Decision, line.Reason, line.DurationMs = decision, reason, msSince(start)
		if err != nil {
			line.Detail = err.Error()
		}
		c.record(line)
	}
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		record(audit.Error, ReasonClientGone, err)
		return
	}
	client.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(client)
	if first, err := br.Peek(1); err != nil || first[0] != 0x16 {
		record(audit.Deny, ReasonNotTLS, err)
		return
	}
	mismatch := false
	tc := tls.Server(&bufferedConn{Conn: client, r: br}, &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
			line.SNI = h.ServerName
			if !sameHost(h.ServerName, t.Host) {
				mismatch = true
				return nil, errSNI
			}
			return c.cfg.CA.Leaf(t.Host)
		},
	})
	ctx, cancel := context.WithTimeout(g.ctx, 10*time.Second)
	err := tc.HandshakeContext(ctx)
	cancel()
	client.SetReadDeadline(time.Time{})
	switch {
	case mismatch:
		record(audit.Deny, ReasonSNIMismatch, nil)
		return
	case err != nil:
		record(audit.Deny, ReasonHandshake, err)
		return
	}
	line.Status = http.StatusOK
	record(audit.Allow, "", nil)
	srv := &http.Server{
		Handler:           c.innerHandler(t.Host, g),
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          log.New(io.Discard, "", 0),
		BaseContext:       func(net.Listener) context.Context { return g.ctx },
	}
	srv.Serve(newOneConnListener(tc))
}

func (c *Cell) innerHandler(host string, g *generation) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		line := audit.Line{Kind: audit.KindRequest, Mode: "mitm", Method: r.Method, Host: host, Path: r.URL.Path}
		dest := keys.Dest{Cell: c.cfg.CellID, Scheme: "https", Host: host}
		if !hostIs(r.Host, host) || (r.URL.IsAbs() && (r.URL.Scheme != "https" || !hostIs(r.URL.Host, host))) {
			// A surrogate in the Host header is refused and alerted like one anywhere else.
			u := *r.URL
			u.Host = r.Host
			if v := c.deps.Registry.Inspect(dest, r.Method, &u, r.Header); !v.Allow {
				line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
				c.deny(w, line, http.StatusForbidden, v.Reason)
				return
			}
			c.deny(w, line, http.StatusMisdirectedRequest, ReasonHostMismatch)
			return
		}
		target := &url.URL{Scheme: "https", Host: host, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
		c.forward(w, r, route{dest: dest, target: target, line: line, gen: g})
	})
}

func hostIs(authority, host string) bool {
	h, port, err := net.SplitHostPort(authority)
	if err != nil {
		h, port = authority, "443"
	}
	return port == "443" && strings.EqualFold(strings.TrimSuffix(h, "."), host)
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.r.Read(p) }

// oneConnListener hands http.Server one connection and ends Serve when that connection closes.
type oneConnListener struct {
	conn     net.Conn
	mu       sync.Mutex
	accepted bool
	done     chan struct{}
	once     sync.Once
}

func newOneConnListener(conn net.Conn) *oneConnListener {
	l := &oneConnListener{done: make(chan struct{})}
	l.conn = &closeHook{Conn: conn, onClose: func() { l.Close() }}
	return l
}

func (l *oneConnListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if !l.accepted {
		l.accepted = true
		l.mu.Unlock()
		return l.conn, nil
	}
	l.mu.Unlock()
	<-l.done
	return nil, net.ErrClosed
}

func (l *oneConnListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *oneConnListener) Addr() net.Addr { return l.conn.LocalAddr() }

type closeHook struct {
	net.Conn
	onClose func()
	once    sync.Once
}

func (c *closeHook) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.onClose)
	return err
}
```

- [ ] **Step 5: Run the tests**

Run: `go test -race ./internal/egress/`
Expected: `ok` (38 tests). In `TestAnInterceptedHandshakeChecksSNIAndRecordsAborts`, a client
without the cell CA fails with `x509: certificate signed by unknown authority` and keyd's audit line
reads `"reason":"tls-handshake-failed"` with the client's alert in `detail`.

- [ ] **Step 6: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/egress
git commit -m "feat(keyd): selective TLS interception with surrogate swap and scrubbing"
```

---
### Task 13: LLM bookkeeping — usage, prices, budgets, the model allowlist

The gateway "enforces a model allowlist and budgets (defaults $5 per task and $20 per day,
editable)", and "Budget reached | keyd refuses; the task stops; the UI offers to raise the budget."
This task is the arithmetic, with no network: a meter that reads each provider's usage from a
streamed or whole body — only where providers put it (`usage`, `message.usage`, `response.usage`,
Groq's `x_groq.usage`, `usageMetadata`), so a tool call's arguments can never pose as usage; a price per model in dollars
per million tokens (which is micro-dollars per token), cache tokens at the input price when they
have none of their own; a byte estimate, about three bytes a token, of what a stream relayed; budgets
per task (by cell) and per day (local midnight, persisted so a restart does not reset the day); and
the settings file that holds the limits and, per gateway route, the models the user picked with
their prices and each one's maximum output (P4a-R15). Budgets hold what a running request can cost
(review 1, I3), and keyd works that out itself, never trusting the body (review 2, I3 and N1;
ruling P4a-C5):
- `ReadRequest` refuses a request for more than one answer — `n`, `best_of` or `candidateCount`
  other than 1, at the top level or in Gemini's generation config, in any letter case, with or
  without underscores, as Go and protobuf servers read them; and on the completions API a `prompt`
  list of more than one element, which the provider answers prompt by prompt (review 3, N-C; one
  prompt's token ids go as a list of one list); and a `models` list, OpenRouter's fallback models,
  which can answer with a model off the allowlist at its own price (Part 5a's amendment,
  P5a-R31) — with a `ChoiceError` that names the field. It
  takes the smallest output cap the body names in any of the providers' fields; only a whole number
  from 1 to a billion counts (0 too for Anthropic, which then writes nothing), so null, 0, strings
  and fractions are no cap. It prices the input as the provider bills it: text at three bytes a
  token, and each image where the provider's API carries one by that provider's image-token rule
  (`images.go`, P4a-R27), from the dimensions in its PNG or JPEG header, or at the provider's
  documented per-image maximum when keyd cannot read them (an image by URL or file id, or in another
  format). A 450 KB screenshot was 200,000 tokens of base64 text; it is now 1,334 tokens on Claude.
  The text is the body less the images' data, which counts for at most the body's length, so the
  text is never below nothing: invalid UTF-8 in an image's data decodes to three bytes for each
  byte sent, which once made the input, and so the request's hold, negative (review 3, N-A).
- `Reserve` holds an `Ask` — the input's cost, the output price and the cap asked for (the body's,
  or the model's maximum) — against the task and the day, and admits the request with the largest
  cap the room left in both allows, up to the cap asked for. A request that does not fit beside the
  holds of running requests waits for them; one whose input and a single output token do not fit in
  the room left is refused with `NeedUSD`, what it asked to hold. `WithCap` then writes the admitted
  cap into the provider's own field and removes every other cap field, so the provider reads keyd's
  cap whichever field it prefers.
- `Settle` releases the hold and charges what the request cost. `Charge` is gone; every charge
  settles a hold (review 2, N7).

Twenty concurrent requests therefore spend what the room allows, whatever their bodies say. A model
with an output price must state its `maxOutputTokens`, which bounds every cap. `ModelFromJSON`
refuses a body that names its model twice, in any letter case, or in capitals: keyd and the provider
might read different ones (Go servers such as Ollama read the last case-insensitive match; review 1,
M9).

**Files:**
- Create: `keyd/internal/llm/usage.go`, `keyd/internal/llm/budget.go`, `keyd/internal/llm/settings.go`, `keyd/internal/llm/request.go`, `keyd/internal/llm/images.go`
- Test: `keyd/internal/llm/usage_test.go`, `keyd/internal/llm/budget_test.go`, `keyd/internal/llm/request_test.go`, `keyd/internal/llm/images_test.go`

**Interfaces:**
- Produces: `Usage{Input, Output, CacheWrite, CacheRead int64; Reported bool}`,
  `NewMeter(contentType string) *Meter` (an `io.Writer`) with `Usage() Usage`;
  `Price{Model string; Input, Output, CacheRead, CacheWrite float64; MaxOutput int64}` (JSON `id inputUSDPerMTok outputUSDPerMTok cacheReadUSDPerMTok cacheWriteUSDPerMTok maxOutputTokens`)
  with `Cost(Usage) int64` (micro-USD, rounded up) and `Ceiling(input, output int64) int64` (input
  tokens at the dearer of the input and cache-write prices, output tokens at the output price);
  `Estimate(requestBytes, responseBytes int64) Usage`;
  `Limits{PerTaskUSD, PerDayUSD float64}`, `DefaultLimits`; `OpenSettings(path) (*Settings, error)`
  with `Limits()`, `SetLimits(Limits) error`, `Models(route) []Price`, `SetModels(route, []Price) error`
  (prices $0–$10,000 per million tokens; `MaxOutput` 1–100,000,000, required with an output price),
  `Price(route, model) (Price, bool)`; `OpenBudget(path string, limits func() Limits, now func() time.Time) (*Budget, error)`
  with `Begin(cell, taskID string, budgetUSD float64)`, `End(cell)`, `Task(cell) (TaskInfo, bool)`,
  `Check(cell) error` (`ErrNoTask`, `*ExceededError{Scope, TaskID, LimitUSD, SpentUSD, NeedUSD}`),
  `Ask{Fixed int64; PerToken float64; Tokens int64}`, `Reserve(ctx, cell string, ask Ask) (*Hold, error)`
  (admits with the largest cap up to `Tokens` that the room left pays for; waits while running
  requests hold the room; refuses with `NeedUSD` a request whose input and one token do not fit),
  `(*Hold).Tokens() int64` (the admitted cap), `(*Hold).Amount() int64`,
  `(*Hold).Settle(cost int64) ([]ExceededError, error)` and `(*Hold).Release()` (only the first of
  them counts), `Day() (string, float64)`;
  `ModelFromJSON([]byte) (string, error)`, `ErrDuplicateModel`; `BodyAnthropic`, `BodyChat`,
  `BodyResponses`, `BodyGemini` (the APIs that carry images, as `keys.Op.Body` names them) and
  `BodyCompletions` (whose `prompt` may be a list);
  `ReadRequest(api, model string, body []byte) (Request, error)` with `Request{Input, Cap int64; HasCap bool}`
  and `*ChoiceError{Field string}`; `WithCap(capField string, body []byte, tokens int64) ([]byte, error)`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/llm/usage_test.go`:
```go
package llm

import (
	"io"
	"strings"
	"testing"
)

func meter(t *testing.T, contentType string, body string, chunk int) Usage {
	t.Helper()
	m := NewMeter(contentType)
	for len(body) > 0 {
		n := min(chunk, len(body))
		if _, err := io.WriteString(m, body[:n]); err != nil {
			t.Fatal(err)
		}
		body = body[n:]
	}
	return m.Usage()
}

func TestMeterReadsEachProvidersUsage(t *testing.T) {
	cases := []struct {
		name        string
		contentType string
		body        string
		want        Usage
	}{
		{
			"anthropic json", "application/json",
			`{"id":"msg_1","content":[{"type":"tool_use","input":{"usage":{"output_tokens":0}}}],"usage":{"input_tokens":1200,"output_tokens":80,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000}}`,
			Usage{Input: 1200, Output: 80, CacheWrite: 300, CacheRead: 4000, Reported: true},
		},
		{
			"anthropic sse", "text/event-stream",
			"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1370,\"output_tokens\":1}}}\n\n" +
				"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n" +
				"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":142}}\n\n",
			Usage{Input: 1370, Output: 142, Reported: true},
		},
		{
			"openai chat sse", "text/event-stream; charset=utf-8",
			"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}],\"usage\":null}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":7}}\n\ndata: [DONE]\n\n",
			Usage{Input: 50, Output: 7, Reported: true},
		},
		{
			"openai responses sse", "text/event-stream",
			"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"usage\":null}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":900,\"output_tokens\":33}}}\n\n",
			Usage{Input: 900, Output: 33, Reported: true},
		},
		{
			"gemini sse", "text/event-stream",
			"data: {\"usageMetadata\":{\"promptTokenCount\":1222,\"candidatesTokenCount\":10}}\r\n\r\ndata: {\"usageMetadata\":{\"promptTokenCount\":1222,\"candidatesTokenCount\":27,\"thoughtsTokenCount\":40}}\r\n\r\n",
			Usage{Input: 1222, Output: 67, Reported: true},
		},
		{
			"gemini json array", "application/json",
			`[{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}},{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}]`,
			Usage{Input: 10, Output: 5, Reported: true},
		},
		{"no usage", "application/json", `{"data":[{"id":"m"}]}`, Usage{}},
		{"not json", "text/plain", "upstream error", Usage{}},
	}
	for _, c := range cases {
		for _, chunk := range []int{1, 7, 1 << 20} {
			if got := meter(t, c.contentType, c.body, chunk); got != c.want {
				t.Errorf("%s (chunks of %d): %+v, want %+v", c.name, chunk, got, c.want)
			}
		}
	}
}

func TestMeterSurvivesOversizedInput(t *testing.T) {
	big := "data: {\"pad\":\"" + strings.Repeat("x", 2<<20) + "\"}\n\ndata: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n"
	if got := meter(t, "text/event-stream", big, 64<<10); got != (Usage{Input: 3, Output: 4, Reported: true}) {
		t.Fatalf("after an oversized line: %+v", got)
	}
	if got := meter(t, "application/json", strings.Repeat(" ", maxJSONBody+1)+`{"usage":{"prompt_tokens":1}}`, 1<<20); got.Reported {
		t.Fatalf("a body over the cap was parsed: %+v", got)
	}
}

// The first-class bearer providers of Part 5a's amendment (P5a-R31) stream their usage in their
// own places: xAI's Responses API in response.completed, Mistral, DeepSeek and OpenRouter in the
// last chunk's usage, Groq only in the last chunk's x_groq. The numbers are the brain's fixtures'
// (cells/brain/src/testing/provider-streams.ts).
func TestMeterReadsTheFirstClassBearerProviders(t *testing.T) {
	last := func(extra string) string {
		return "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\n" +
			"data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]," + extra + "}\n\n" +
			"data: [DONE]\n\n"
	}
	const usage = `{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}`
	streams := map[string]string{
		"xai": "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\",\"output\":[]}}\n\n" +
			"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"ok\"}\n\n" +
			"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1200,\"output_tokens\":80,\"total_tokens\":1280,\"output_tokens_details\":{\"reasoning_tokens\":30}}}}\n\n",
		"mistral":    last(`"usage":` + usage),
		"deepseek":   last(`"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280,"prompt_cache_hit_tokens":1000,"prompt_cache_miss_tokens":200}`),
		"groq":       last(`"x_groq":{"id":"req_1","usage":` + usage + `}`),
		"openrouter": last(`"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280,"cost":0.0042}`),
	}
	want := Usage{Input: 1200, Output: 80, Reported: true}
	for name, body := range streams {
		for _, chunk := range []int{1, 7, 1 << 20} {
			if got := meter(t, "text/event-stream", body, chunk); got != want {
				t.Errorf("%s (chunks of %d): %+v, want %+v", name, chunk, got, want)
			}
		}
	}
	// Only a chunk's own x_groq counts, never one inside the answer.
	nested := "data: {\"choices\":[{\"delta\":{\"x_groq\":{\"usage\":{\"prompt_tokens\":1}}}}]}\n\n"
	if got := meter(t, "text/event-stream", nested, 1<<20); got.Reported {
		t.Fatalf("a nested x_groq was read as usage: %+v", got)
	}
}

func TestCostRoundsUpAndChargesCacheTokens(t *testing.T) {
	p := Price{Model: "claude-sonnet-5-5", Input: 3, Output: 15, CacheRead: 0.3}
	u := Usage{Input: 1000, Output: 100, CacheWrite: 10, CacheRead: 1000}
	// 1000*3 + 100*15 + 10*3 (cache write falls back to the input price) + 1000*0.3 micro-USD
	if got := p.Cost(u); got != 4830 {
		t.Fatalf("Cost = %d, want 4830", got)
	}
	if got := (Price{Input: 0.1}).Cost(Usage{Input: 1}); got != 1 {
		t.Fatalf("a fraction of a micro-dollar rounds to %d, want 1", got)
	}
}

func TestCeilingIsTheMostARequestCanCost(t *testing.T) {
	// 1,000 input tokens at the cache-write price, plus 500 output tokens.
	if got := (Price{Input: 3, Output: 15, CacheWrite: 3.75}).Ceiling(1000, 500); got != 1000*3.75+500*15 {
		t.Fatalf("Ceiling = %d", got)
	}
	if got := (Price{Input: 3}).Ceiling(1000, 0); got != 3000 {
		t.Fatalf("Ceiling without output = %d", got)
	}
}

func TestEstimateIsConservative(t *testing.T) {
	if got := Estimate(3000, 301); got != (Usage{Input: 1000, Output: 101}) {
		t.Fatalf("Estimate = %+v", got)
	}
}
```

`keyd/internal/llm/budget_test.go`:
```go
package llm

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func openBudget(t *testing.T, path string, c *clock) *Budget {
	t.Helper()
	return openBudgetWith(t, path, c, Limits{PerTaskUSD: 5, PerDayUSD: 20})
}

func openBudgetWith(t *testing.T, path string, c *clock, l Limits) *Budget {
	t.Helper()
	b, err := OpenBudget(path, func() Limits { return l }, c.now)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fixed asks for a request that costs exactly micro micro-dollars.
func fixed(micro int64) Ask { return Ask{Fixed: micro} }

// waits reports whether a reservation is still waiting after a moment.
func waits(b *Budget, cell string, ask Ask) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	h, err := b.Reserve(ctx, cell, ask)
	if h != nil {
		h.Release()
	}
	return errors.Is(err, context.DeadlineExceeded)
}

// spend charges the cell's task as a request does whose provider bills cost above its hold.
func spend(t *testing.T, b *Budget, cell string, cost int64) []ExceededError {
	t.Helper()
	h, err := b.Reserve(context.Background(), cell, fixed(1))
	if err != nil {
		t.Fatal(err)
	}
	crossed, err := h.Settle(cost)
	if err != nil {
		t.Fatal(err)
	}
	return crossed
}

func TestATaskIsRequired(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	if err := b.Check("c1"); !errors.Is(err, ErrNoTask) {
		t.Fatalf("Check without a task: %v", err)
	}
	b.Begin("c1", "t1", 0)
	if err := b.Check("c1"); err != nil {
		t.Fatal(err)
	}
	b.End("c1")
	if err := b.Check("c1"); !errors.Is(err, ErrNoTask) {
		t.Fatalf("Check after End: %v", err)
	}
}

func TestTheTaskLimitStopsTheTaskAndReportsTheCrossing(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	if crossed := spend(t, b, "c1", 4_900_000); len(crossed) != 0 {
		t.Fatalf("crossed early: %+v", crossed)
	}
	crossed := spend(t, b, "c1", 200_000)
	if len(crossed) != 1 || crossed[0].Scope != "task" || crossed[0].TaskID != "t1" || crossed[0].SpentUSD != 5.1 {
		t.Fatalf("crossing: %+v", crossed)
	}
	var exceeded *ExceededError
	if err := b.Check("c1"); !errors.As(err, &exceeded) || exceeded.Scope != "task" || exceeded.LimitUSD != 5 {
		t.Fatalf("Check after the limit: %v", err)
	}
	b.Begin("c1", "t1", 10)
	if err := b.Check("c1"); err != nil {
		t.Fatalf("raising the same task's budget: %v", err)
	}
	if info, _ := b.Task("c1"); info.SpentUSD != 5.1 || info.LimitUSD != 10 {
		t.Fatalf("raised task %+v", info)
	}
	b.Begin("c1", "t2", 0)
	if info, _ := b.Task("c1"); info.SpentUSD != 0 || info.ID != "t2" {
		t.Fatalf("a new task starts at zero: %+v", info)
	}
}

func TestTheDayLimitSpansTasksAndCellsAndResetsAtMidnight(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 23, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	for i, cell := range []string{"c1", "c2", "c3", "c4", "c5"} {
		b.Begin(cell, "t", 0)
		crossed := spend(t, b, cell, 4_000_000)
		if i == 4 && (len(crossed) != 1 || crossed[0].Scope != "day") {
			t.Fatalf("day crossing: %+v", crossed)
		}
	}
	b.Begin("c6", "t", 0)
	var exceeded *ExceededError
	if err := b.Check("c6"); !errors.As(err, &exceeded) || exceeded.Scope != "day" {
		t.Fatalf("Check over the day limit: %v", err)
	}
	reopened := openBudget(t, path, c)
	reopened.Begin("c7", "t", 0)
	if err := reopened.Check("c7"); !errors.As(err, &exceeded) {
		t.Fatalf("the day's spend was not restored: %v", err)
	}
	c.t = c.t.Add(2 * time.Hour)
	if err := b.Check("c6"); err != nil {
		t.Fatalf("after midnight: %v", err)
	}
	if date, spent := b.Day(); date != "2026-10-02" || spent != 0 {
		t.Fatalf("Day = %s %v", date, spent)
	}
}

func TestSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s, err := OpenSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Limits() != DefaultLimits || DefaultLimits != (Limits{PerTaskUSD: 5, PerDayUSD: 20}) {
		t.Fatalf("defaults %+v", s.Limits())
	}
	for _, bad := range []Limits{{0, 20}, {5, -1}, {30, 20}} {
		if err := s.SetLimits(bad); err == nil {
			t.Errorf("SetLimits(%+v) accepted", bad)
		}
	}
	if err := s.SetLimits(Limits{PerTaskUSD: 2, PerDayUSD: 8}); err != nil {
		t.Fatal(err)
	}
	models := []Price{{Model: "claude-sonnet-5-5", Input: 3, Output: 15, MaxOutput: 64_000}}
	if err := s.SetModels("anthropic", models); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]Price{
		{{Model: "", Input: 1}}, {{Model: "m", Input: -1}}, {{Model: "a b", Input: 1}},
		{{Model: "m", Input: 1, Output: 2}}, {{Model: "m", Output: 1, MaxOutput: -1}}, {{Model: "m", Output: 20_000, MaxOutput: 8}},
	} {
		if err := s.SetModels("anthropic", bad); err == nil {
			t.Errorf("SetModels(%+v) accepted", bad)
		}
	}
	again, err := OpenSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if again.Limits() != (Limits{PerTaskUSD: 2, PerDayUSD: 8}) {
		t.Fatalf("limits after reopen %+v", again.Limits())
	}
	if p, ok := again.Price("anthropic", "claude-sonnet-5-5"); !ok || p.Output != 15 || p.MaxOutput != 64_000 {
		t.Fatalf("price after reopen %+v %v", p, ok)
	}
	if _, ok := again.Price("anthropic", "claude-opus-5-5"); ok {
		t.Fatal("an unlisted model has a price")
	}
}

func TestHoldsKeepRequestsSideBySideWithinTheTaskLimit(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	var holds []*Hold
	for range 3 {
		h, err := b.Reserve(context.Background(), "c1", fixed(1_500_000))
		if err != nil {
			t.Fatal(err)
		}
		holds = append(holds, h)
	}
	if !waits(b, "c1", fixed(1_500_000)) {
		t.Fatal("a fourth request of up to $1.50 did not wait beside three")
	}
	admitted := make(chan error, 1)
	go func() {
		h, err := b.Reserve(context.Background(), "c1", fixed(1_500_000))
		if h != nil {
			h.Release()
		}
		admitted <- err
	}()
	holds[0].Settle(200_000)
	if err := <-admitted; err != nil {
		t.Fatalf("the waiting request after a settle: %v", err)
	}
	holds[1].Settle(1_500_000)
	holds[2].Settle(1_500_000)
	var exceeded *ExceededError
	if _, err := b.Reserve(context.Background(), "c1", fixed(1_900_000)); !errors.As(err, &exceeded) || exceeded.Scope != "task" || exceeded.NeedUSD != 1.9 {
		t.Fatalf("a request that could cross the limit alone: %v", err)
	}
	if h, err := b.Reserve(context.Background(), "c1", fixed(1_800_000)); err != nil {
		t.Fatalf("a request that just fits: %v", err)
	} else {
		h.Release()
	}
	if info, _ := b.Task("c1"); info.SpentUSD != 3.2 {
		t.Fatalf("spent %v, want 3.2", info.SpentUSD)
	}
}

func TestParallelReservationsNeverOvershoot(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			h, err := b.Reserve(context.Background(), "c1", fixed(1_500_000))
			if err != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
			h.Settle(1_500_000)
		})
	}
	wg.Wait()
	if info, _ := b.Task("c1"); info.SpentUSD != 4.5 {
		t.Fatalf("20 parallel requests of $1.50 spent %v of a $5 task, want 4.5", info.SpentUSD)
	}
}

func TestTheDayHoldsAcrossCells(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudgetWith(t, filepath.Join(t.TempDir(), "spend.json"), c, Limits{PerTaskUSD: 5, PerDayUSD: 6})
	b.Begin("c1", "t1", 0)
	b.Begin("c2", "t2", 0)
	h, err := b.Reserve(context.Background(), "c1", fixed(4_000_000))
	if err != nil {
		t.Fatal(err)
	}
	if !waits(b, "c2", fixed(4_000_000)) {
		t.Fatal("another cell's request did not wait for the day's room")
	}
	h.Settle(4_000_000)
	var exceeded *ExceededError
	if _, err := b.Reserve(context.Background(), "c2", fixed(4_000_000)); !errors.As(err, &exceeded) || exceeded.Scope != "day" || exceeded.NeedUSD != 4 {
		t.Fatalf("a request the day cannot cover: %v", err)
	}
	if h, err := b.Reserve(context.Background(), "c2", fixed(1_500_000)); err != nil {
		t.Fatalf("a request the day can cover: %v", err)
	} else {
		h.Release()
	}
	if h, err := b.Reserve(context.Background(), "c2", Ask{PerToken: 1, Tokens: 4_000_000}); err != nil || h.Tokens() != 2_000_000 {
		t.Fatalf("a cap the day lowers to its $2 left: %v %v", h, err)
	}
}

func TestTheCapIsLoweredToTheRoomLeft(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	ask := Ask{Fixed: 100_000, PerToken: 15, Tokens: 1_000_000} // up to $15.10
	h, err := b.Reserve(context.Background(), "c1", ask)
	if err != nil || h.Tokens() != 326_666 || h.Amount() != 100_000+326_666*15 {
		t.Fatalf("admitted with %v: %v", h, err)
	}
	if !waits(b, "c1", Ask{Fixed: 100_000, PerToken: 15, Tokens: 1_000}) {
		t.Fatal("a request ran beside one that holds what is left of the task")
	}
	h.Settle(4_000_000)
	if h, err = b.Reserve(context.Background(), "c1", ask); err != nil || h.Tokens() != 60_000 {
		t.Fatalf("with $1 left: %v %v", h, err)
	}
	h.Settle(950_000)
	var exceeded *ExceededError
	if _, err := b.Reserve(context.Background(), "c1", ask); !errors.As(err, &exceeded) || exceeded.Scope != "task" || exceeded.NeedUSD != 15.1 {
		t.Fatalf("with $0.05 left, less than the input: %v", err)
	}
	if h, err := b.Reserve(context.Background(), "c1", Ask{Fixed: 20_000, PerToken: 15, Tokens: 64_000}); err != nil || h.Tokens() != 2_000 {
		t.Fatalf("a smaller request with $0.05 left: %v %v", h, err)
	}
}

func TestAWaitingRequestStopsWhenItsTaskEnds(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	h, _ := b.Reserve(context.Background(), "c1", fixed(4_000_000))
	defer h.Release()
	result := make(chan error, 1)
	go func() {
		_, err := b.Reserve(context.Background(), "c1", fixed(4_000_000))
		result <- err
	}()
	time.Sleep(20 * time.Millisecond)
	b.End("c1")
	select {
	case err := <-result:
		if !errors.Is(err, ErrNoTask) {
			t.Fatalf("err = %v, want ErrNoTask", err)
		}
	case <-time.After(time.Second):
		t.Fatal("the waiting request did not stop when its task ended")
	}
}
```

`keyd/internal/llm/request_test.go`:
```go
package llm

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestModelFromJSON(t *testing.T) {
	cases := map[string]string{
		`{"model":"claude-sonnet-5-5","messages":[]}`:             "claude-sonnet-5-5",
		`{"messages":[{"model":"nested"}],"model":"gpt-6.1-sol"}`: "gpt-6.1-sol",
		`{"input":"x"}`: "",
		` {"stream":true , "model" : "qwen/qwen3.8-27b" }`: "qwen/qwen3.8-27b",
	}
	for body, want := range cases {
		got, err := ModelFromJSON([]byte(body))
		if err != nil || got != want {
			t.Errorf("%s: %q, %v", body, got, err)
		}
	}
	if _, err := ModelFromJSON([]byte(`{"model":"cheap","model":"expensive"}`)); !errors.Is(err, ErrDuplicateModel) {
		t.Errorf("duplicate model: %v", err)
	}
	// Go's encoding/json, which Ollama and other Go servers use, reads the last case-insensitive match.
	if _, err := ModelFromJSON([]byte(`{"model":"cheap","Model":"expensive"}`)); !errors.Is(err, ErrDuplicateModel) {
		t.Errorf("a model named in two letter cases: %v", err)
	}
	if _, err := ModelFromJSON([]byte(`{"MODEL":"expensive"}`)); err == nil {
		t.Error("a model named in capitals was accepted")
	}
	for _, body := range []string{`{"model":5}`, `[1,2]`, `not json`, `{"model":"x"`} {
		if _, err := ModelFromJSON([]byte(body)); err == nil {
			t.Errorf("%s: accepted", body)
		}
	}
}

func TestReadRequest(t *testing.T) {
	caps := []struct {
		api, body string
		cap       int64
		has       bool
	}{
		{BodyAnthropic, `{"model":"m","max_tokens":64}`, 64, true},
		{BodyAnthropic, `{"model":"m","max_tokens":0}`, 0, true},
		{BodyChat, `{"max_completion_tokens":100,"max_tokens":50}`, 50, true},
		{BodyChat, `{"max_tokens":10,"MAX_TOKENS":100000}`, 10, true},
		{BodyChat, `{"max_output_tokens":2048}`, 2048, true},
		{BodyGemini, `{"generationConfig":{"maxOutputTokens":512}}`, 512, true},
		{BodyGemini, `{"generation_config":{"max_output_tokens":256}}`, 256, true},
		{BodyChat, `{"max_completion_tokens":null}`, 0, false},
		{BodyGemini, `{"generationConfig":{"maxOutputTokens":null}}`, 0, false},
		{BodyGemini, `{"generationConfig":{"maxOutputTokens":0}}`, 0, false},
		{BodyChat, `{"max_tokens":0}`, 0, false},
		{BodyChat, `{"max_tokens":"64"}`, 0, false},
		{BodyChat, `{"max_tokens":-1}`, 0, false},
		{BodyChat, `{"max_tokens":64.5}`, 0, false},
		{BodyChat, `{"max_tokens":1e12}`, 0, false},
		{BodyGemini, `{"generationConfig":null}`, 0, false},
		{BodyChat, `{"messages":[]}`, 0, false},
	}
	for _, c := range caps {
		req, err := ReadRequest(c.api, "m", []byte(c.body))
		if err != nil || req.Cap != c.cap || req.HasCap != c.has {
			t.Errorf("%s %s: %+v %v; want cap %d, %v", c.api, c.body, req, err, c.cap, c.has)
		}
	}
	for body, field := range map[string]string{
		`{"model":"m","n":128}`:                       "n",
		`{"model":"m","N":2}`:                         "N",
		`{"model":"m","n":"2"}`:                       "n",
		`{"model":"m","n":0}`:                         "n",
		`{"model":"m","best_of":20}`:                  "best_of",
		`{"generationConfig":{"candidateCount":8}}`:   "candidateCount",
		`{"generation_config":{"candidate_count":2}}`: "candidate_count",
	} {
		var many *ChoiceError
		if _, err := ReadRequest(BodyGemini, "m", []byte(body)); !errors.As(err, &many) || many.Field != field {
			t.Errorf("%s: %v, want a refusal naming %s", body, err, field)
		}
	}
	for _, body := range []string{`{"model":"m","n":1,"best_of":null}`, `{"generationConfig":{"candidateCount":1}}`} {
		if _, err := ReadRequest(BodyGemini, "m", []byte(body)); err != nil {
			t.Errorf("%s: %v", body, err)
		}
	}
	for _, body := range []string{`{"generationConfig":{},"generation_config":{}}`, `not json`, `[1]`} {
		if _, err := ReadRequest(BodyGemini, "m", []byte(body)); err == nil {
			t.Errorf("%s: accepted", body)
		}
	}
	// The completions API answers each prompt of a list, every answer under the one cap.
	for body, field := range map[string]string{
		`{"model":"m","prompt":["x","y"],"max_tokens":1500}`: "prompt",
		`{"model":"m","prompt":[[1],[2],[3]]}`:               "prompt",
		`{"model":"m","Prompt":[1,2]}`:                       "Prompt",
	} {
		var many *ChoiceError
		if _, err := ReadRequest(BodyCompletions, "m", []byte(body)); !errors.As(err, &many) || many.Field != field {
			t.Errorf("%s: %v, want a refusal naming %s", body, err, field)
		}
	}
	for _, body := range []string{`{"model":"m","prompt":"x"}`, `{"model":"m","prompt":["x"]}`, `{"model":"m","prompt":[[1,2,3]]}`} {
		if _, err := ReadRequest(BodyCompletions, "m", []byte(body)); err != nil {
			t.Errorf("%s: %v", body, err)
		}
	}
	if _, err := ReadRequest(BodyChat, "m", []byte(`{"model":"m","prompt":["x","y"]}`)); err != nil {
		t.Errorf("a prompt list outside completions: %v", err)
	}
	// OpenRouter's fallback models can answer in place of the allowlisted one, at their own price
	// (P5a-R31).
	for body, field := range map[string]string{
		`{"model":"m","models":["m","pricier"],"messages":[]}`: "models",
		`{"model":"m","Models":["pricier"]}`:                   "Models",
		`{"model":"m","models":[]}`:                            "models",
	} {
		var many *ChoiceError
		if _, err := ReadRequest(BodyChat, "m", []byte(body)); !errors.As(err, &many) || many.Field != field {
			t.Errorf("%s: %v, want a refusal naming %s", body, err, field)
		}
	}
	if _, err := ReadRequest(BodyChat, "m", []byte(`{"model":"m","models":null}`)); err != nil {
		t.Errorf("a null models list: %v", err)
	}
	if req, _ := ReadRequest(BodyChat, "m", []byte(`{"messages":"`+strings.Repeat("x", 2985)+`"}`)); req.Input != 1000 {
		t.Errorf("3,000 bytes of text: %d tokens, want 1,000", req.Input)
	}
}

// Invalid UTF-8 in an image's base64 decodes to U+FFFD, three bytes for each byte of the body, so
// the image can seem longer than the body it came in. The request still holds at least its output,
// and lends no room to the requests beside it.
func TestAMalformedImageCannotMakeAHoldNegative(t *testing.T) {
	var b bytes.Buffer
	b.WriteString(`{"model":"m","max_tokens":300000,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"`)
	b.Write(bytes.Repeat([]byte{0xff}, 3<<20))
	b.WriteString(`"}}]}]}`)
	req, err := ReadRequest(BodyAnthropic, "m", b.Bytes())
	if err != nil || req.Input != anthropicMaxImage {
		t.Fatalf("input %d tokens, %v; want %d, an image keyd cannot size", req.Input, err, anthropicMaxImage)
	}
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	budget := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	budget.Begin("c1", "t1", 0)
	price := Price{Input: 3, Output: 15, MaxOutput: 300_000}
	h, err := budget.Reserve(context.Background(), "c1", Ask{Fixed: price.Ceiling(req.Input, 0), PerToken: price.Output, Tokens: req.Cap})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Release()
	if !waits(budget, "c1", Ask{Fixed: 60, PerToken: 15, Tokens: 300_000}) {
		t.Fatalf("a $4.50 request ran beside one holding $%.2f", float64(h.Amount())/1e6)
	}
}

func TestWithCap(t *testing.T) {
	cases := []struct{ field, body, want string }{
		{"max_tokens", `{"model":"m","max_tokens":null,"max_output_tokens":1,"messages":[]}`, `{"model":"m","messages":[],"max_tokens":4096}`},
		{"max_completion_tokens", `{"model":"m", "MAX_TOKENS":9,"n":1}`, `{"model":"m","n":1,"max_completion_tokens":4096}`},
		{"generationConfig.maxOutputTokens", `{"contents":[]}`, `{"contents":[],"generationConfig":{"maxOutputTokens":4096}}`},
		{"generationConfig.maxOutputTokens", `{"contents":[],"generation_config":{"max_output_tokens":9,"temperature":1}}`, `{"contents":[],"generation_config":{"temperature":1,"maxOutputTokens":4096}}`},
		{"generationConfig.maxOutputTokens", `{"generationConfig":null,"max_tokens":3}`, `{"generationConfig":{"maxOutputTokens":4096}}`},
		{"max_tokens", `{"model":"m","messages":[{"role":"user","content":"a <b> & c"}]}`, `{"model":"m","messages":[{"role":"user","content":"a <b> & c"}],"max_tokens":4096}`},
	}
	for _, c := range cases {
		got, err := WithCap(c.field, []byte(c.body), 4096)
		if err != nil || string(got) != c.want {
			t.Errorf("%s in %s:\n got %s %v\nwant %s", c.field, c.body, got, err, c.want)
		}
	}
}
```

`keyd/internal/llm/images_test.go`:
```go
package llm

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"testing"
)

// picture is a blank image of the size, as base64 of a PNG or a JPEG.
func picture(t *testing.T, format string, w, h int) string {
	t.Helper()
	var b bytes.Buffer
	img := image.NewGray(image.Rect(0, 0, w, h))
	encode := png.Encode
	if format == "jpeg" {
		encode = func(w io.Writer, img image.Image) error { return jpeg.Encode(w, img, nil) }
	}
	if err := encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

func TestImagesArePricedByTheProvidersRule(t *testing.T) {
	shot := picture(t, "png", 1280, 800)
	photo := picture(t, "jpeg", 2000, 1500)
	wide := picture(t, "png", 4000, 600)
	gif := base64.StdEncoding.EncodeToString([]byte("GIF89a\x00\x05\x20\x03"))
	cases := []struct {
		name, api, model, body string
		data                   string
		tokens                 int64
	}{
		// ⌈1280/28⌉·⌈800/28⌉ = 46·29 patches; ⌈2000/28⌉·⌈1500/28⌉ = 72·54.
		{"anthropic screenshot", BodyAnthropic, "m", `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + shot + `"}}]}]}`, shot, 1_334},
		{"anthropic tool result", BodyAnthropic, "m", `{"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"` + photo + `"}}]}]}]}`, photo, 3_888},
		{"anthropic by url", BodyAnthropic, "m", `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://example.test/a.png"}}]}]}`, "", 4_784},
		{"anthropic gif", BodyAnthropic, "m", `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/gif","data":"` + gif + `"}}]}]}`, gif, 4_784},
		// 40·25 patches × 2.46 = 2,460, more than 85 + 170·6 tiles = 1,105; a photo's 63·47 × 2.46.
		{"openai chat", BodyChat, "gpt-6.1-sol", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + shot + `","detail":"high"}}]}]}`, shot, 2_460},
		{"openai screenshot", BodyResponses, "gpt-6.1-sol", `{"input":[{"type":"computer_call_output","call_id":"c","output":{"type":"computer_screenshot","image_url":"data:image/png;base64,` + shot + `"}}]}`, shot, 2_460},
		{"openai input image", BodyResponses, "gpt-6.1-sol", `{"input":[{"role":"user","content":[{"type":"input_image","image_url":"data:image/jpeg;base64,` + photo + `"}]}]}`, photo, 7_285},
		{"gpt-4o-mini", BodyChat, "gpt-4o-mini", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + shot + `"}}]}]}`, shot, 2_833 + 5_667*6},
		{"openai by url", BodyChat, "gpt-6.1-sol", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.test/a.png"}}]}]}`, "", 73_800},
		// Gemini 3's most, 2,240, is more than 6 crops of 533 pixels; a wide image is 20 crops of 400.
		{"gemini", BodyGemini, "m", `{"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":"image/png","data":"` + shot + `"}}]}]}`, shot, 2_240},
		{"gemini wide", BodyGemini, "m", `{"contents":[{"parts":[{"inline_data":{"mime_type":"image/png","data":"` + wide + `"}}]}]}`, wide, 20 * 258},
		{"gemini function response", BodyGemini, "m", `{"contents":[{"parts":[{"functionResponse":{"name":"f","parts":[{"inlineData":{"mimeType":"image/png","data":"` + shot + `"}}]}}]}]}`, shot, 2_240},
		{"gemini file", BodyGemini, "m", `{"contents":[{"parts":[{"fileData":{"mimeType":"image/png","fileUri":"https://example.test/a.png"}}]}]}`, "", 2_240},
		{"an image as text", BodyChat, "m", `{"messages":[{"role":"user","content":"` + shot + `"}]}`, "", 0},
		{"no images in completions", "completions", "m", `{"prompt":"data:image/png;base64,` + shot + `"}`, "", 0},
	}
	for _, c := range cases {
		data, tokens := imagesIn(c.api, c.model, []byte(c.body))
		if data != int64(len(c.data)) || tokens != c.tokens {
			t.Errorf("%s: %d bytes of image data, %d tokens; want %d, %d", c.name, data, tokens, len(c.data), c.tokens)
		}
		req, err := ReadRequest(c.api, c.model, []byte(c.body))
		if want := (int64(len(c.body)-len(c.data))+2)/3 + c.tokens; err != nil || req.Input != want {
			t.Errorf("%s: input %d tokens, %v; want %d", c.name, req.Input, err, want)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/llm/`
Expected: FAIL — `[build failed]`, starting `internal/llm/budget_test.go:16:55: undefined: Budget`.

- [ ] **Step 3: Implement the bookkeeping**

`keyd/internal/llm/usage.go`:
```go
// Package llm holds the LLM gateway's bookkeeping: the token usage each provider reports, what it
// costs, the per-task and per-day budgets, and the model allowlist with its prices.
package llm

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
)

const (
	maxSSELine  = 1 << 20
	maxJSONBody = 16 << 20
)

type Usage struct {
	Input      int64
	Output     int64
	CacheWrite int64
	CacheRead  int64
	Reported   bool
}

// Meter watches a response body go by and keeps the last usage the provider reported. It reads
// usage only where providers put it, so a tool call's arguments can never pose as usage.
type Meter struct {
	sse   bool
	buf   []byte
	over  bool
	usage Usage
}

func NewMeter(contentType string) *Meter {
	return &Meter{sse: strings.HasPrefix(strings.ToLower(contentType), "text/event-stream")}
}

func (m *Meter) Write(p []byte) (int, error) {
	if !m.sse {
		if !m.over && len(m.buf)+len(p) <= maxJSONBody {
			m.buf = append(m.buf, p...)
		} else {
			m.over, m.buf = true, nil
		}
		return len(p), nil
	}
	for rest := p; len(rest) > 0; {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			m.appendLine(rest)
			break
		}
		m.appendLine(rest[:i])
		if !m.over {
			m.line(m.buf)
		}
		m.buf, m.over = m.buf[:0], false
		rest = rest[i+1:]
	}
	return len(p), nil
}

func (m *Meter) appendLine(b []byte) {
	if m.over || len(m.buf)+len(b) > maxSSELine {
		m.over, m.buf = true, m.buf[:0]
		return
	}
	m.buf = append(m.buf, b...)
}

func (m *Meter) line(l []byte) {
	payload, ok := bytes.CutPrefix(bytes.TrimRight(l, "\r"), []byte("data:"))
	if !ok {
		return
	}
	m.parse(bytes.TrimSpace(payload))
}

// Usage returns what was reported; Reported is false when the provider reported nothing.
func (m *Meter) Usage() Usage {
	if !m.sse && !m.over && len(m.buf) > 0 {
		m.parse(m.buf)
		m.buf = nil
	}
	if m.sse && !m.over && len(m.buf) > 0 {
		m.line(m.buf)
		m.buf = m.buf[:0]
	}
	return m.usage
}

func (m *Meter) parse(data []byte) {
	var v any
	if json.Unmarshal(data, &v) != nil {
		return
	}
	values := []any{v}
	if arr, ok := v.([]any); ok {
		values = arr
	}
	for _, item := range values {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		m.take(obj["usage"])
		m.take(field(obj, "message", "usage"))
		m.take(field(obj, "response", "usage"))
		// Groq's streams report usage only here, in the last chunk (P5a-R31).
		m.take(field(obj, "x_groq", "usage"))
		if u, ok := obj["usageMetadata"].(map[string]any); ok {
			m.set(&m.usage.Input, u["promptTokenCount"])
			cand, okC := number(u["candidatesTokenCount"])
			thoughts, okT := number(u["thoughtsTokenCount"])
			if okC || okT {
				m.usage.Output, m.usage.Reported = cand+thoughts, true
			}
		}
	}
}

func (m *Meter) take(v any) {
	u, ok := v.(map[string]any)
	if !ok {
		return
	}
	m.set(&m.usage.Input, first(u["input_tokens"], u["prompt_tokens"]))
	m.set(&m.usage.Output, first(u["output_tokens"], u["completion_tokens"]))
	m.set(&m.usage.CacheWrite, u["cache_creation_input_tokens"])
	m.set(&m.usage.CacheRead, u["cache_read_input_tokens"])
}

func (m *Meter) set(dst *int64, v any) {
	if n, ok := number(v); ok {
		*dst, m.usage.Reported = n, true
	}
}

func field(obj map[string]any, keys ...string) any {
	var cur any = obj
	for _, k := range keys {
		next, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = next[k]
	}
	return cur
}

func first(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

func number(v any) (int64, bool) {
	f, ok := v.(float64)
	if !ok || f < 0 || f > 1e12 {
		return 0, false
	}
	return int64(f), true
}

// Price is a model's list price in US dollars per million tokens, which is micro-dollars per
// token, and the most output tokens one request to it may ask for.
type Price struct {
	Model      string  `json:"id"`
	Input      float64 `json:"inputUSDPerMTok"`
	Output     float64 `json:"outputUSDPerMTok"`
	CacheRead  float64 `json:"cacheReadUSDPerMTok,omitempty"`
	CacheWrite float64 `json:"cacheWriteUSDPerMTok,omitempty"`
	MaxOutput  int64   `json:"maxOutputTokens,omitempty"`
}

// Cost in micro-dollars, rounded up. Cache tokens without their own price cost the input price.
func (p Price) Cost(u Usage) int64 {
	orInput := func(v float64) float64 {
		if v == 0 {
			return p.Input
		}
		return v
	}
	total := float64(u.Input)*p.Input + float64(u.Output)*p.Output +
		float64(u.CacheWrite)*orInput(p.CacheWrite) + float64(u.CacheRead)*orInput(p.CacheRead)
	return int64(math.Ceil(total))
}

// Ceiling is the most input and output tokens can cost: the input at the dearer of the input and
// cache-write prices, the output at the output price.
func (p Price) Ceiling(input, output int64) int64 {
	return int64(math.Ceil(float64(input)*max(p.Input, p.CacheWrite) + float64(output)*p.Output))
}

// Estimate stands in when a provider reports no usage: about three bytes a token, rounded up,
// which overcharges rather than under.
func Estimate(requestBytes, responseBytes int64) Usage {
	return Usage{Input: (requestBytes + 2) / 3, Output: (responseBytes + 2) / 3}
}
```

`keyd/internal/llm/budget.go`:
```go
package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var ErrNoTask = errors.New("llm: the cell has no task running")

// Ask is the most a request can cost: Fixed micro-dollars for its input, plus PerToken
// micro-dollars for each output token up to Tokens, its output cap.
type Ask struct {
	Fixed    int64
	PerToken float64
	Tokens   int64
}

func (a Ask) cost(tokens int64) int64 {
	return a.Fixed + int64(math.Ceil(float64(tokens)*a.PerToken))
}

type ExceededError struct {
	Scope    string  `json:"scope"`
	TaskID   string  `json:"taskId,omitempty"`
	LimitUSD float64 `json:"limitUSD"`
	SpentUSD float64 `json:"spentUSD"`
	// NeedUSD is what the refused request asked to hold, when that is what did not fit.
	NeedUSD float64 `json:"needUSD,omitempty"`
}

func (e *ExceededError) Error() string {
	if e.NeedUSD > 0 {
		return fmt.Sprintf("llm: %s budget of $%.2f has no room for a request of up to $%.2f ($%.2f spent)", e.Scope, e.LimitUSD, e.NeedUSD, e.SpentUSD)
	}
	return fmt.Sprintf("llm: %s budget of $%.2f reached ($%.2f spent)", e.Scope, e.LimitUSD, e.SpentUSD)
}

type TaskInfo struct {
	ID       string  `json:"id"`
	LimitUSD float64 `json:"limitUSD"`
	SpentUSD float64 `json:"spentUSD"`
}

type task struct {
	id    string
	limit int64
	spent int64
	held  int64
}

type spendFile struct {
	Date     string `json:"date"`
	MicroUSD int64  `json:"microUSD"`
}

// Budget enforces the per-task and per-day limits. Every request holds the most it can cost
// against its task and the day while it runs, so requests running side by side can never spend
// more together than either limit; only a provider billing more than a request's hold can.
type Budget struct {
	mu      sync.Mutex
	path    string
	limits  func() Limits
	now     func() time.Time
	day     spendFile
	dayHeld int64
	tasks   map[string]*task
	changed chan struct{}
}

func OpenBudget(path string, limits func() Limits, now func() time.Time) (*Budget, error) {
	b := &Budget{path: path, limits: limits, now: now, tasks: map[string]*task{}, changed: make(chan struct{})}
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(data, &b.day); err != nil {
			return nil, fmt.Errorf("budget %s: %w", path, err)
		}
	}
	b.rollLocked()
	return b, nil
}

// Begin starts a task for the cell. The same task id keeps what it spent, so the UI can raise
// the budget of a stopped task. budgetUSD 0 takes the per-task default.
func (b *Budget) Begin(cell, taskID string, budgetUSD float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	defer b.notifyLocked()
	if budgetUSD <= 0 {
		budgetUSD = b.limits().PerTaskUSD
	}
	limit := micros(budgetUSD)
	if t, ok := b.tasks[cell]; ok && t.id == taskID {
		t.limit = limit
		return
	}
	b.tasks[cell] = &task{id: taskID, limit: limit}
}

func (b *Budget) End(cell string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.tasks, cell)
	b.notifyLocked()
}

func (b *Budget) Task(cell string) (TaskInfo, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t, ok := b.tasks[cell]
	if !ok {
		return TaskInfo{}, false
	}
	return TaskInfo{ID: t.id, LimitUSD: usd(t.limit), SpentUSD: usd(t.spent)}, true
}

// Check refuses a cell with no task or a spent limit, before a request's body is read.
func (b *Budget) Check(cell string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollLocked()
	t, ok := b.tasks[cell]
	if !ok {
		return ErrNoTask
	}
	return b.spentLocked(t)
}

// Reserve admits a request and holds the most it can cost against the cell's task and the day
// until the Hold is settled or released. The hold's output cap is ask.Tokens, lowered to what the
// room left in the task and the day can pay for. A request that does not fit beside the holds of
// running requests waits for them; one whose input and a single output token do not fit in the
// room left is refused, as is every request once a limit is spent.
func (b *Budget) Reserve(ctx context.Context, cell string, ask Ask) (*Hold, error) {
	for {
		b.mu.Lock()
		b.rollLocked()
		h, err := b.reserveLocked(cell, ask)
		wait := b.changed
		b.mu.Unlock()
		if h != nil || err != nil {
			return h, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wait:
		}
	}
}

// reserveLocked returns a hold, a refusal, or neither when the request has to wait.
func (b *Budget) reserveLocked(cell string, ask Ask) (*Hold, error) {
	t, ok := b.tasks[cell]
	if !ok {
		return nil, ErrNoTask
	}
	if err := b.spentLocked(t); err != nil {
		return nil, err
	}
	dayLimit := micros(b.limits().PerDayUSD)
	taskRoom, dayRoom := t.limit-t.spent, dayLimit-b.day.MicroUSD
	room := min(taskRoom, dayRoom)
	if least := ask.cost(min(ask.Tokens, 1)); least > room {
		need := usd(ask.cost(ask.Tokens))
		if least > taskRoom {
			return nil, &ExceededError{Scope: "task", TaskID: t.id, LimitUSD: usd(t.limit), SpentUSD: usd(t.spent), NeedUSD: need}
		}
		return nil, &ExceededError{Scope: "day", LimitUSD: usd(dayLimit), SpentUSD: usd(b.day.MicroUSD), NeedUSD: need}
	}
	tokens := ask.Tokens
	if ask.cost(tokens) > room {
		tokens = int64(min(float64(room-ask.Fixed)/ask.PerToken, float64(tokens)))
		for ask.cost(tokens) > room {
			tokens--
		}
	}
	amount := ask.cost(tokens)
	if t.spent+t.held+amount > t.limit || b.day.MicroUSD+b.dayHeld+amount > dayLimit {
		return nil, nil
	}
	t.held += amount
	b.dayHeld += amount
	return &Hold{b: b, t: t, amount: amount, tokens: tokens}, nil
}

func (b *Budget) spentLocked(t *task) error {
	if t.spent >= t.limit {
		return &ExceededError{Scope: "task", TaskID: t.id, LimitUSD: usd(t.limit), SpentUSD: usd(t.spent)}
	}
	if limit := micros(b.limits().PerDayUSD); b.day.MicroUSD >= limit {
		return &ExceededError{Scope: "day", LimitUSD: usd(limit), SpentUSD: usd(b.day.MicroUSD)}
	}
	return nil
}

// chargeLocked adds the cost to the task and to the day, persists the day, and returns every
// limit this charge crossed.
func (b *Budget) chargeLocked(t *task, cost int64) ([]ExceededError, error) {
	if cost == 0 {
		return nil, nil
	}
	var crossed []ExceededError
	if t.spent < t.limit && t.spent+cost >= t.limit {
		crossed = append(crossed, ExceededError{Scope: "task", TaskID: t.id, LimitUSD: usd(t.limit), SpentUSD: usd(t.spent + cost)})
	}
	t.spent += cost
	limit := micros(b.limits().PerDayUSD)
	before := b.day.MicroUSD
	b.day.MicroUSD += cost
	if before < limit && b.day.MicroUSD >= limit {
		crossed = append(crossed, ExceededError{Scope: "day", LimitUSD: usd(limit), SpentUSD: usd(b.day.MicroUSD)})
	}
	return crossed, b.saveLocked()
}

func (b *Budget) Day() (string, float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollLocked()
	return b.day.Date, usd(b.day.MicroUSD)
}

// Hold is one running request's reservation.
type Hold struct {
	b      *Budget
	t      *task
	amount int64
	tokens int64
	once   sync.Once
}

// Tokens is the output cap the request was admitted with.
func (h *Hold) Tokens() int64 { return h.tokens }

// Amount is what the hold keeps from the task and the day, in micro-dollars.
func (h *Hold) Amount() int64 { return h.amount }

// Settle releases the hold and charges what the request cost to the task it was held for and to
// the day, returning every limit the charge crossed. Only the first Settle or Release counts.
func (h *Hold) Settle(cost int64) (crossed []ExceededError, err error) {
	h.once.Do(func() {
		b := h.b
		b.mu.Lock()
		defer b.mu.Unlock()
		b.rollLocked()
		h.t.held -= h.amount
		b.dayHeld -= h.amount
		crossed, err = b.chargeLocked(h.t, cost)
		b.notifyLocked()
	})
	return crossed, err
}

// Release gives the hold back without a charge, for a request that never reached the provider.
func (h *Hold) Release() {
	h.Settle(0)
}

// notifyLocked wakes every request waiting in Reserve to look again.
func (b *Budget) notifyLocked() {
	close(b.changed)
	b.changed = make(chan struct{})
}

// rollLocked starts a new day at local midnight; holds of requests still running carry over.
func (b *Budget) rollLocked() {
	if today := b.now().Format("2006-01-02"); b.day.Date != today {
		b.day = spendFile{Date: today}
	}
}

func (b *Budget) saveLocked() error {
	data, err := json.Marshal(b.day)
	if err != nil {
		return err
	}
	return writeAtomic(b.path, data)
}

func micros(dollars float64) int64 { return int64(dollars*1e6 + 0.5) }

func usd(m int64) float64 { return float64(m) / 1e6 }

func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
```

`keyd/internal/llm/settings.go`:
```go
package llm

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"sync"
)

type Limits struct {
	PerTaskUSD float64 `json:"perTaskUSD"`
	PerDayUSD  float64 `json:"perDayUSD"`
}

// DefaultLimits are the spec's: $5 per task and $20 per day.
var DefaultLimits = Limits{PerTaskUSD: 5, PerDayUSD: 20}

var modelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`)

// Bounds that keep every ceiling well inside an int64 of micro-dollars.
const (
	maxPrice     = 10_000
	maxOutputCap = 100_000_000
)

type settingsFile struct {
	V      int                `json:"v"`
	Limits Limits             `json:"limits"`
	Models map[string][]Price `json:"models"`
}

// Settings holds the editable budget limits and, per gateway route, the models the user picked
// with their prices. A route with no models refuses every request.
type Settings struct {
	mu   sync.Mutex
	path string
	data settingsFile
}

func OpenSettings(path string) (*Settings, error) {
	s := &Settings{path: path, data: settingsFile{V: 1, Limits: DefaultLimits, Models: map[string][]Price{}}}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, err
	}
	if err := json.Unmarshal(raw, &s.data); err != nil {
		return nil, fmt.Errorf("settings %s: %w", path, err)
	}
	if s.data.Models == nil {
		s.data.Models = map[string][]Price{}
	}
	return s, nil
}

func (s *Settings) Limits() Limits {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Limits
}

func (s *Settings) SetLimits(l Limits) error {
	if l.PerTaskUSD <= 0 || l.PerDayUSD <= 0 || l.PerTaskUSD > l.PerDayUSD || l.PerDayUSD > 10_000 {
		return errors.New("llm: limits must be positive, per task no more than per day, per day at most $10,000")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Limits = l
	return s.saveLocked()
}

func (s *Settings) Models(route string) []Price {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.data.Models[route])
}

func (s *Settings) SetModels(route string, models []Price) error {
	if len(models) > 64 {
		return errors.New("llm: at most 64 models per route")
	}
	for _, m := range models {
		if !modelID.MatchString(m.Model) {
			return fmt.Errorf("llm: model id %q", m.Model)
		}
		if min(m.Input, m.Output, m.CacheRead, m.CacheWrite) < 0 || max(m.Input, m.Output, m.CacheRead, m.CacheWrite) > maxPrice {
			return fmt.Errorf("llm: model %s: prices must be $0 to $%d per million tokens", m.Model, maxPrice)
		}
		// The gateway bounds every request's output cap by the model's maximum.
		if m.MaxOutput < 0 || m.MaxOutput > maxOutputCap || m.Output > 0 && m.MaxOutput == 0 {
			return fmt.Errorf("llm: model %s: maxOutputTokens must be 1 to %d when output has a price", m.Model, maxOutputCap)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Models[route] = slices.Clone(models)
	return s.saveLocked()
}

func (s *Settings) Price(route, model string) (Price, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.data.Models[route] {
		if p.Model == model {
			return p, true
		}
	}
	return Price{}, false
}

func (s *Settings) saveLocked() error {
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.path, raw)
}
```

`keyd/internal/llm/request.go`:
```go
package llm

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
)

var (
	ErrDuplicateModel = errors.New("llm: the request names its model twice")
	errNotObject      = errors.New("llm: the request body is not a JSON object")
	errTwoConfigs     = errors.New("llm: the request names its generation config twice")
)

// The APIs whose bodies carry images, as keys.Op names them.
const (
	BodyAnthropic = "anthropic"
	BodyChat      = "chat"
	BodyResponses = "responses"
	BodyGemini    = "gemini"
)

// BodyCompletions is OpenAI's completions API, whose prompt may be a list of prompts.
const BodyCompletions = "completions"

// ModelFromJSON returns the top-level "model" of a request body, or "" when there is none. A body
// naming its model twice, in any letter case, is refused, and so is one naming it in capitals:
// keyd and the provider might read different ones.
func ModelFromJSON(body []byte) (string, error) {
	var model string
	seen := false
	err := fields(body, func(key string, raw json.RawMessage) error {
		if !strings.EqualFold(key, "model") {
			return nil
		}
		if seen {
			return ErrDuplicateModel
		}
		seen = true
		if key != "model" {
			return errors.New(`llm: the request names its model as "` + key + `"`)
		}
		if err := json.Unmarshal(raw, &model); err != nil {
			return errors.New("llm: model is not a string")
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return model, nil
}

// ChoiceError refuses a request for more than one answer, which the provider bills in full for
// each answer under a single output cap, or for a choice of models (OpenRouter's `models`
// fallbacks), which can answer with a model off the allowlist at its own price.
type ChoiceError struct{ Field string }

func (e *ChoiceError) Error() string {
	return "llm: " + e.Field + " asks for more than one answer or model"
}

// Request is what a gateway request's body can cost before keyd sets its output cap.
type Request struct {
	// Input is the most input tokens the provider bills for the body: its text at three bytes a
	// token and each image by the provider's rule.
	Input int64
	// Cap is the smallest output cap the body names, when HasCap.
	Cap    int64
	HasCap bool
}

// capFields and choiceFields are folded as fold folds a key: every provider's output caps and
// answer counts, in the letter cases and spellings Go and protobuf servers also read.
var (
	capFields    = []string{"maxtokens", "maxcompletiontokens", "maxoutputtokens"}
	choiceFields = []string{"n", "bestof", "candidatecount"}
)

// ReadRequest reads the body of a request to a model through api (an op's Body). It refuses a
// count of answers other than one, at the top level and in Gemini's generation config; a prompt
// list of more than one element on the completions API, which answers each prompt under the one
// cap; a list of models to fall back on; and a body naming the generation config twice. A cap is a whole number from 1 to a
// billion, or 0 for Anthropic, which then writes nothing; null, strings and fractions are no cap.
func ReadRequest(api, model string, body []byte) (Request, error) {
	top, err := members(body)
	if err != nil {
		return Request{}, err
	}
	var req Request
	look := func(ms []member) error {
		for _, m := range ms {
			k := fold(m.key)
			if slices.Contains(choiceFields, k) && !oneOrNull(m.raw) {
				return &ChoiceError{Field: m.key}
			}
			if api == BodyCompletions && k == "prompt" && several(m.raw) {
				return &ChoiceError{Field: m.key}
			}
			if k == "models" && !isNull(m.raw) {
				return &ChoiceError{Field: m.key}
			}
			if !slices.Contains(capFields, k) {
				continue
			}
			if n, ok := capValue(m.raw, api == BodyAnthropic); ok && (!req.HasCap || n < req.Cap) {
				req.Cap, req.HasCap = n, true
			}
		}
		return nil
	}
	if err := look(top); err != nil {
		return Request{}, err
	}
	configs := 0
	for _, m := range top {
		if fold(m.key) != "generationconfig" {
			continue
		}
		if configs++; configs > 1 {
			return Request{}, errTwoConfigs
		}
		if isNull(m.raw) {
			continue
		}
		inner, err := members(m.raw)
		if err != nil {
			return Request{}, err
		}
		if err := look(inner); err != nil {
			return Request{}, err
		}
	}
	// Invalid UTF-8 in an image's data decodes to three bytes for each byte of the body, so the
	// data counts at most the body's length, and the text's share is never below nothing.
	data, images := imagesIn(api, model, body)
	req.Input = max(0, (int64(len(body))-min(data, int64(len(body)))+2)/3) + images
	return req, nil
}

// WithCap returns the body with tokens as its output cap in capField, the provider's own field,
// and every other output cap removed, at the top level and in Gemini's generation config, so the
// provider reads keyd's cap whichever field it prefers. capField is a top-level field, or
// "generationConfig.maxOutputTokens".
func WithCap(capField string, body []byte, tokens int64) ([]byte, error) {
	limit := json.RawMessage(strconv.FormatInt(tokens, 10))
	parent, field, nested := strings.Cut(capField, ".")
	if !nested {
		field = parent
	}
	ms, err := members(body)
	if err != nil {
		return nil, err
	}
	out := make([]member, 0, len(ms)+1)
	placed := false
	for _, m := range ms {
		k := fold(m.key)
		if slices.Contains(capFields, k) {
			continue
		}
		if k == "generationconfig" {
			var inner []member
			if !isNull(m.raw) {
				if inner, err = members(m.raw); err != nil {
					return nil, err
				}
			}
			inner = slices.DeleteFunc(inner, func(m member) bool { return slices.Contains(capFields, fold(m.key)) })
			if nested && !placed {
				inner, placed = append(inner, member{field, limit}), true
			}
			m.raw = encode(inner)
		}
		out = append(out, m)
	}
	switch {
	case !nested:
		out = append(out, member{field, limit})
	case !placed:
		out = append(out, member{parent, encode([]member{{field, limit}})})
	}
	return encode(out), nil
}

func capValue(raw json.RawMessage, zeroOK bool) (int64, bool) {
	s := string(bytes.TrimSpace(raw))
	if s == "" || len(s) > 10 || strings.Trim(s, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil && n <= 1e9 && (n >= 1 || zeroOK && n == 0)
}

func oneOrNull(raw json.RawMessage) bool {
	s := string(bytes.TrimSpace(raw))
	return s == "1" || s == "null"
}

func isNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

// several reports whether raw is a list of more than one element.
func several(raw json.RawMessage) bool {
	var list []json.RawMessage
	return json.Unmarshal(raw, &list) == nil && len(list) > 1
}

func fold(key string) string {
	return strings.ToLower(strings.ReplaceAll(key, "_", ""))
}

type member struct {
	key string
	raw json.RawMessage
}

func members(body []byte) ([]member, error) {
	var out []member
	err := fields(body, func(key string, raw json.RawMessage) error {
		out = append(out, member{key, raw})
		return nil
	})
	return out, err
}

// encode writes the members back as an object, each value byte for byte as it came.
func encode(ms []member) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	b.WriteByte('{')
	for i, m := range ms {
		if i > 0 {
			b.WriteByte(',')
		}
		enc.Encode(m.key)
		b.Truncate(b.Len() - 1)
		b.WriteByte(':')
		b.Write(m.raw)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// fields calls fn with each key of a JSON object and its raw value, in order, duplicates
// included.
func fields(body []byte, fn func(key string, raw json.RawMessage) error) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return errNotObject
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		key, _ := tok.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		if err := fn(key, raw); err != nil {
			return err
		}
	}
	_, err := dec.Token()
	return err
}
```

`keyd/internal/llm/images.go`:
```go
package llm

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"strings"
)

// The most one image can cost each provider, in tokens, by its documented rule (P4a-R27). An
// image keyd cannot size, given by URL or file id or in a format other than PNG and JPEG, costs
// that much.
const (
	anthropicMaxImage = 4_784
	openAIMaxImage    = 73_800
	geminiMaxImage    = 2_240
	// A header is read from at most this much base64: 192 KB, past every PNG header and nearly
	// every JPEG's metadata.
	maxImageHead = 1 << 18
)

// imagesIn finds the images in a body where api carries them, and returns how many bytes of the
// body their base64 fills and how many tokens the provider bills for them. Images anywhere else
// are the provider's text, and stay in the body's text.
func imagesIn(api, model string, body []byte) (data, tokens int64) {
	var rule func(w, h int) int64
	var unread int64
	switch api {
	case BodyAnthropic:
		rule, unread = anthropicImage, anthropicMaxImage
	case BodyGemini:
		rule, unread = geminiImage, geminiMaxImage
	case BodyChat, BodyResponses:
		rule, unread = openAIImage, openAIMaxImage
		if strings.Contains(model, "4o-mini") {
			rule = gpt4oMiniImage
		}
	default:
		return 0, 0
	}
	var doc map[string]any
	if json.Unmarshal(body, &doc) != nil {
		return 0, 0
	}
	count := func(b64 string, inline bool) {
		w, h, ok := 0, 0, false
		if inline {
			data += int64(len(b64))
			w, h, ok = dimensions(b64)
		}
		if ok {
			tokens += rule(w, h)
		} else {
			tokens += unread
		}
	}
	switch api {
	case BodyAnthropic:
		anthropicImages(doc, count)
	case BodyChat:
		chatImages(doc, count)
	case BodyResponses:
		responsesImages(doc, count)
	case BodyGemini:
		geminiImages(doc, count)
	}
	return data, tokens
}

// Anthropic: image blocks in a message's content, and in a tool result's.
func anthropicImages(doc map[string]any, count func(string, bool)) {
	block := func(b map[string]any) {
		src := object(b["source"])
		data, ok := src["data"].(string)
		count(data, ok && src["type"] == "base64")
	}
	for _, m := range list(doc["messages"]) {
		for _, c := range list(object(m)["content"]) {
			switch b := object(c); b["type"] {
			case "image":
				block(b)
			case "tool_result":
				for _, inner := range list(b["content"]) {
					if ib := object(inner); ib["type"] == "image" {
						block(ib)
					}
				}
			}
		}
	}
}

// OpenAI's chat completions: image_url parts of a message's content.
func chatImages(doc map[string]any, count func(string, bool)) {
	for _, m := range list(doc["messages"]) {
		for _, c := range list(object(m)["content"]) {
			p := object(c)
			if p["type"] != "image_url" {
				continue
			}
			u, _ := object(p["image_url"])["url"].(string)
			if s, ok := p["image_url"].(string); ok {
				u = s
			}
			count(dataURL(u))
		}
	}
}

// OpenAI's Responses: input_image parts of an item's content and of a function call's output, and
// a computer call's screenshot.
func responsesImages(doc map[string]any, count func(string, bool)) {
	image := func(p map[string]any) {
		u, _ := p["image_url"].(string)
		count(dataURL(u))
	}
	for _, item := range list(doc["input"]) {
		it := object(item)
		for _, c := range list(it["content"]) {
			if p := object(c); p["type"] == "input_image" {
				image(p)
			}
		}
		switch it["type"] {
		case "computer_call_output":
			image(object(it["output"]))
		case "function_call_output":
			for _, c := range list(it["output"]) {
				if p := object(c); p["type"] == "input_image" {
					image(p)
				}
			}
		}
	}
}

// Gemini: a part's inline or file data of an image type, and a function response's parts.
func geminiImages(doc map[string]any, count func(string, bool)) {
	var parts func(ps []any)
	parts = func(ps []any) {
		for _, p := range ps {
			part := object(p)
			for _, key := range []string{"inlineData", "inline_data"} {
				if d := object(part[key]); isImage(d) {
					data, ok := d["data"].(string)
					count(data, ok)
				}
			}
			for _, key := range []string{"fileData", "file_data"} {
				if isImage(object(part[key])) {
					count("", false)
				}
			}
			for _, key := range []string{"functionResponse", "function_response"} {
				parts(list(object(part[key])["parts"]))
			}
		}
	}
	for _, c := range list(doc["contents"]) {
		parts(list(object(c)["parts"]))
	}
}

func isImage(d map[string]any) bool {
	mime, _ := d["mimeType"].(string)
	if mime == "" {
		mime, _ = d["mime_type"].(string)
	}
	return strings.HasPrefix(strings.ToLower(mime), "image/")
}

// dataURL returns the base64 of a data: URL, and false for any other URL.
func dataURL(u string) (string, bool) {
	rest, ok := strings.CutPrefix(u, "data:")
	meta, b64, found := strings.Cut(rest, ",")
	if !ok || !found || !strings.HasSuffix(strings.ToLower(meta), ";base64") {
		return "", false
	}
	return b64, true
}

// dimensions reads an image's size from the PNG or JPEG header at the start of its base64.
func dimensions(b64 string) (int, int, bool) {
	head := strings.TrimRight(b64[:min(len(b64), maxImageHead)], "=")
	enc := base64.RawStdEncoding
	if strings.ContainsAny(head, "-_") {
		enc = base64.RawURLEncoding
	}
	raw, _ := enc.DecodeString(head) // what decodes before an error still holds the header
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 {
		return 0, 0, false
	}
	return cfg.Width, cfg.Height, true
}

// Anthropic: a token per 28-pixel patch; an image past the model's budget, 1,568 patches or 4,784
// on high-resolution models, is first scaled down to fit it.
func anthropicImage(w, h int) int64 {
	return min(ceilDiv(w, 28)*ceilDiv(h, 28), anthropicMaxImage)
}

// OpenAI bills by one of two rules, model by model; keyd takes the larger. Patches: 32-pixel
// patches, at most 30,000 (the API refuses more), times the largest multiplier, 2.46. Tiles: 85
// tokens and 170 per 512-pixel tile, once the image fits 2048 pixels square with its short side
// at most 768.
func openAIImage(w, h int) int64 {
	patches := min(ceilDiv(w, 32)*ceilDiv(h, 32), 30_000)
	return max((patches*246+99)/100, 85+170*openAITiles(w, h))
}

// gpt-4o-mini bills 2,833 tokens and 5,667 per tile.
func gpt4oMiniImage(w, h int) int64 {
	return 2_833 + 5_667*openAITiles(w, h)
}

func openAITiles(w, h int) int64 {
	fw, fh := float64(w), float64(h)
	if s := 2048 / max(fw, fh); s < 1 {
		fw, fh = fw*s, fh*s
	}
	if s := 768 / min(fw, fh); s < 1 {
		fw, fh = fw*s, fh*s
	}
	return int64(math.Ceil(fw/512) * math.Ceil(fh/512))
}

// Gemini 3 bills an image at most 2,240 tokens, at its ultra-high media resolution. Earlier
// models bill 258 tokens for an image within 384 pixels both ways, else 258 per crop of
// ⌊min(w, h)/1.5⌋ pixels square.
func geminiImage(w, h int) int64 {
	tiles := int64(1)
	if w > 384 || h > 384 {
		unit := max(min(w, h)*2/3, 1)
		tiles = ceilDiv(w, unit) * ceilDiv(h, unit)
	}
	return max(geminiMaxImage, 258*tiles)
}

func ceilDiv(a, b int) int64 {
	return int64((a + b - 1) / b)
}

func object(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/llm/`
Expected: `ok` (20 tests). Without the meter's `x_groq.usage`, `TestMeterReadsTheFirstClassBearerProviders`
fails for Groq (nothing reported), and without the `models` check `TestReadRequest` fails for each
list.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/llm
git commit -m "feat(keyd): LLM usage metering, prices and budgets"
```

---
### Task 14: The LLM gateway

"The brain's providers use base URLs that point at keyd (`http://llm.ldot/<provider>`), so no TLS
interception is needed there. keyd attaches the real key in that provider's auth style, enforces a
model allowlist and budgets …, and fronts LM Studio and Ollama so no cell ever reaches them
directly. An upstream failure gets a 502 and keyd keeps serving; a mid-stream upstream error ends
the client's stream cleanly; and when the client disconnects, keyd aborts the upstream request so
the provider stops generating and billing." (A24; S5's spike gateway crashed on a failed fetch.)
A request to `http://llm.ldot/<route>/<path>` from a cell whose role has the gateway (the brain)
must name an operation the route lists (no dot segments), carry the route's surrogate exactly in
the provider's header, come from a cell with a running task and budget left, and name an
allowlisted model (in the JSON body, or in the path for Gemini). The cell's own credentials and
cookies are dropped, the real key goes in, and the body is relayed — scrubbed and metered — to the
route's base URL: the provider over verified TLS, or a model server on the Mac's loopback through a
dialer pinned to exactly that address. Before the swap the request holds the most it can cost
against the task and the day, waiting while running requests hold the room, and keyd works that
out itself (review 2, I3 and N1; ruling P4a-C5): a body asking for more than one answer gets 400
`choice-count` naming the field; the input is priced by the provider's rules, images included
(Task 13's `ReadRequest`); the output cap is the smallest the body names, else the model's maximum,
lowered to what the room left pays for (`Reserve`), and written into the provider's own field with
every other cap removed (`WithCap`, in the field the route's operation names, Task 9). Token counts
are free and hold nothing. When the answer ends the hold is settled and the rest released: a
complete answer is charged the usage it reports, one that reports none is charged its hold, and so
is a request the cell leaves before the answer's headers once keyd has begun to send it, since the
provider may be generating it (review 3, N-B), a stream cut short the most it can have cost (its
whole cap, or the bytes that reached the cell if more), and a failed answer only what it reported.
A refusal for budget gets 402 with a JSON error the AI SDK
does not retry, and publishes the same `budget.exceeded` that a charge crossing a limit does. The
generation is taken before anything else and checked again before the request goes, so a request
inspected before Stop, whose body was still uploading, is refused rather than sent with the real key
(review 1, I2); and the request is inspected again after its wait, so a surrogate revoked meanwhile,
its secret replaced, is refused rather than swapped for the new value (review 2, N4). Routes for
local servers carry no secret; a desktop or browser cell does not reach the gateway at all
(`llm.ldot` is on its deny list).

Part 5a's amendment (P5a-R31, `…/2026-10-01-localdot-core-handoff/part4a-providers-amendment.md`):
the spec's first-class providers xAI, Mistral, DeepSeek, Groq and OpenRouter get their own presets
in `keys/binding.go`, beside Anthropic's, OpenAI's, Google's and Azure's. They share the bearer auth
style; each has a fixed base URL, its own surrogate tag, and only the operation its official AI SDK
package calls, with the cap field that package sends (xAI: `responses`, `max_output_tokens`; the
others: `chat/completions`, `max_tokens`), plus the model listings. A key stored for one is its own
route, with its own host, prices and audit lines, like every other preset. The upstream path is
joined under `/`, so a base URL without a path (DeepSeek's `https://api.deepseek.com`, or a user's
`https://api.perplexity.ai`) still sends an absolute path.

**Files:**
- Create: `keyd/internal/egress/gateway.go`
- Modify: `keyd/internal/egress/deps.go` (replace), `keyd/internal/egress/generation.go` (replace),
  `keyd/internal/egress/cell.go` (`ServeHTTP`, `alerts`), `keyd/internal/egress/forward.go` (`route`, `relay`),
  `keyd/internal/keys/binding.go` (the five first-class bearer presets)
- Test: `keyd/internal/egress/gateway_test.go`, `keyd/internal/keys/presets_test.go`

**Interfaces:**
- Consumes: `llm.Budget` (`Check`, `Reserve`), `llm.Ask`, `llm.Hold` (`Settle`, `Release`, `Tokens`,
  `Amount`), `llm.Settings` (`Price`), `llm.Price` (`Ceiling`, `Cost`, `MaxOutput`), `llm.ReadRequest`,
  `llm.ChoiceError`, `llm.WithCap`, `llm.NewMeter`, `llm.Estimate`, `llm.ModelFromJSON`,
  `llm.ExceededError` (Task 13); `keys.LocalRoutes`, `keys.Binding.Op`, `Op.ModelFrom`, `Op.Body`,
  `Op.Cap`, `Op.Free` (Task 9); `relay`, `swap`, `scrubberFor`, `isUpgrade`, `current`,
  `(*Cell).Revoke` (Task 10).
- Produces: the LLM presets `xai`, `mistral`, `deepseek`, `groq` and `openrouter` (an `llm`
  secret's `provider`; fixed base URLs; `Authorization: Bearer`; tags `xai`, `mis`, `dsk`, `grq`,
  `orr`); `Deps.Budget`, `Deps.Settings`, `Deps.Local map[string]keys.Binding`, `Deps.LocalDialer Dialer`;
  `Pinned` (`map[string]bool` of `host:port`) with `DialContext`, `PinnedFor(map[string]keys.Binding) Pinned`;
  the reserved name `llm.ldot`; reasons `ReasonRouteUnknown`, `ReasonOpNotAllowed`,
  `ReasonSurrogateMissing`, `ReasonNoTask`, `ReasonBudgetTask`, `ReasonBudgetDay`,
  `ReasonBodyTooLarge`, `ReasonBadJSON`, `ReasonModelMissing`, `ReasonModelNotAllowed`,
  `ReasonChoiceCount` (400 whose body names the field); audit `mode` `"gateway"` with `route`,
  `model`, `costMicroUSD`, `usage` (`reported`, or `estimated` when the charge is the hold or a cut
  stream's most), `host` and `path` of the provider; `budget.exceeded` events for a crossing and for
  every budget refusal; the 402 body's `needUSD` when what a request asked to hold did not fit.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/egress/gateway_test.go`:
```go
package egress

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

type gatewayWorld struct {
	*world
	budget   *llm.Budget
	settings *llm.Settings
	local    map[string]keys.Binding
	cell     *Cell
	tok      string
}

// newGateway makes a brain cell holding a surrogate for an "anthropic" secret whose fake
// api.anthropic.com runs upstream, and an "lmstudio" route to localUpstream when given.
func newGateway(t *testing.T, upstream http.Handler, localUpstream http.Handler) *gatewayWorld {
	t.Helper()
	w := newWorld(t)
	dir := t.TempDir()
	settings, err := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	budget, err := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	g := &gatewayWorld{world: w, budget: budget, settings: settings, local: map[string]keys.Binding{}}
	if upstream != nil {
		w.tlsUpstream("api.anthropic.com", upstream)
	}
	if localUpstream != nil {
		srv := httptest.NewServer(localUpstream)
		t.Cleanup(srv.Close)
		u, _ := url.Parse(srv.URL + "/v1")
		b := keys.LocalRoutes()["lmstudio"]
		b.Upstream = u
		g.local["lmstudio"] = b
	}
	w.secret(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, realValue)
	g.cell = g.open("c1", policy.Brain)
	g.tok = w.mint("c1", "anthropic")
	settings.SetModels("anthropic", []llm.Price{{Model: "claude-sonnet-5-5", Input: 3, Output: 15, MaxOutput: 300_000}})
	settings.SetModels("lmstudio", []llm.Price{{Model: "qwen/qwen3.8-27b"}})
	budget.Begin("c1", "task-1", 0)
	return g
}

func (g *gatewayWorld) open(id string, role policy.Role) *Cell {
	g.t.Helper()
	deps := g.deps()
	deps.Budget, deps.Settings, deps.Local, deps.LocalDialer = g.budget, g.settings, g.local, PinnedFor(g.local)
	p, _ := policy.ForRole(role)
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken}, deps)
	if err != nil {
		g.t.Fatal(err)
	}
	g.t.Cleanup(func() { c.Close() })
	return c
}

func (g *gatewayWorld) post(t *testing.T, rawURL string, header http.Header, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", rawURL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, vs := range header {
		req.Header[k] = vs
	}
	resp, err := g.client(g.cell).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp, string(out)
}

func (g *gatewayWorld) key() http.Header { return http.Header{"X-Api-Key": {g.tok}} }

const sonnet = `{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[]}`

func TestTheGatewaySwapsTheKeyAndChargesTheTask(t *testing.T) {
	seen := make(chan *http.Request, 1)
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000,"output_tokens":100}}`)
	}), nil)
	sub, cancel := g.events.Subscribe(8)
	defer cancel()
	header := g.key()
	header.Set("Authorization", "Bearer something-the-cell-found")
	header.Set("Cookie", "session=x")
	resp, body := g.post(t, "http://llm.ldot/anthropic/messages", header, sonnet)
	if resp.StatusCode != 200 || !strings.Contains(body, `"text":"ok"`) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	r := <-seen
	if r.URL.Path != "/v1/messages" || r.Header.Get("X-Api-Key") != realValue || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
		t.Fatalf("upstream saw %s %v", r.URL.Path, r.Header)
	}
	l := g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Decision == audit.Allow })
	if l.Route != "anthropic" || l.Model != "claude-sonnet-5-5" || l.CostMicroUSD != 4500 || l.Usage != "reported" ||
		l.Host != "api.anthropic.com" || l.Path != "/v1/messages" || !l.Swapped || l.SecretID != "anthropic" {
		t.Fatalf("audit %+v", l)
	}
	if info, _ := g.budget.Task("c1"); info.SpentUSD != 0.0045 {
		t.Fatalf("task spent %v", info.SpentUSD)
	}
	e := <-sub
	if ku := e.Data.(events.KeyUse); ku.SecretID != "anthropic" || ku.Host != "api.anthropic.com" || ku.Decision != "allow" {
		t.Fatalf("event %+v", e)
	}
}

func TestAStreamedAnswerIsMeteredAndScrubbed(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2000,\"output_tokens\":1}}}\n\n")
		rw.(http.Flusher).Flush()
		io.WriteString(rw, "event: content_block_delta\ndata: {\"delta\":{\"text\":\"your key is "+realValue+"\"}}\n\n")
		io.WriteString(rw, "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":200}}\n\n")
	}), nil)
	resp, body := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	if resp.StatusCode != 200 || strings.Contains(body, realValue) || !strings.Contains(body, "your key is "+g.tok) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	l := g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Decision == audit.Allow })
	if l.CostMicroUSD != 2000*3+200*15 {
		t.Fatalf("cost %d", l.CostMicroUSD)
	}
}

func TestTheGatewayRefuses(t *testing.T) {
	var hits atomic.Int32
	g := newGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }), nil)
	desktop := g.open("c2", policy.Desktop)
	noTask := g.open("c3", policy.Brain)
	tokNoTask := g.mint("c3", "anthropic")
	cases := []struct {
		name   string
		cell   *Cell
		url    string
		header http.Header
		body   string
		status int
		reason string
	}{
		{"unknown route", g.cell, "http://llm.ldot/mistral/chat/completions", g.key(), sonnet, 404, ReasonRouteUnknown},
		{"operation not listed", g.cell, "http://llm.ldot/anthropic/files", g.key(), sonnet, 403, ReasonOpNotAllowed},
		{"dot segments", g.cell, "http://llm.ldot/anthropic/messages/../messages", g.key(), sonnet, 403, ReasonOpNotAllowed},
		{"no surrogate", g.cell, "http://llm.ldot/anthropic/messages", nil, sonnet, 403, ReasonSurrogateMissing},
		{"surrogate in the wrong header", g.cell, "http://llm.ldot/anthropic/messages", http.Header{"Authorization": {"Bearer " + g.tok}}, sonnet, 403, "misplaced-surrogate"},
		{"no task", noTask, "http://llm.ldot/anthropic/messages", http.Header{"X-Api-Key": {tokNoTask}}, sonnet, 403, ReasonNoTask},
		{"model not allowed", g.cell, "http://llm.ldot/anthropic/messages", g.key(), `{"model":"claude-opus-5-5"}`, 403, ReasonModelNotAllowed},
		{"model named twice", g.cell, "http://llm.ldot/anthropic/messages", g.key(), `{"model":"claude-sonnet-5-5","model":"claude-opus-5-5"}`, 400, ReasonBadJSON},
		{"no model", g.cell, "http://llm.ldot/anthropic/messages", g.key(), `{"messages":[]}`, 400, ReasonModelMissing},
		{"desktop cells have no gateway", desktop, "http://llm.ldot/anthropic/messages", nil, sonnet, 403, policy.ReasonHostDenied},
		{"a desktop cell with the brain's surrogate", desktop, "http://llm.ldot/anthropic/messages", g.key(), sonnet, 403, "misplaced-surrogate"},
		{"upgrade", g.cell, "http://llm.ldot/anthropic/messages", http.Header{"X-Api-Key": {g.tok}, "Connection": {"Upgrade"}, "Upgrade": {"websocket"}}, sonnet, 403, ReasonUpgrade},
	}
	for _, c := range cases {
		req, _ := http.NewRequest("POST", c.url, strings.NewReader(c.body))
		for k, vs := range c.header {
			req.Header[k] = vs
		}
		resp, err := g.client(c.cell).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != c.status || resp.Header.Get("X-Keyd-Reason") != c.reason {
			t.Errorf("%s: %d %q, want %d %q", c.name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), c.status, c.reason)
		}
	}
	big := `{"model":"claude-sonnet-5-5","pad":"` + strings.Repeat("x", maxGatewayBody) + `"}`
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), big); resp.StatusCode != 413 {
		t.Errorf("oversized body: %d", resp.StatusCode)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the provider was reached %d times", n)
	}
}

func TestBudgetsRefuseOnceReached(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":1000000,"output_tokens":200000}}`)
	}), nil)
	sub, cancel := g.events.Subscribe(16)
	defer cancel()
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 200 {
		t.Fatalf("first request: %d", resp.StatusCode)
	}
	resp, body := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	var refusal struct {
		Error struct {
			Type     string  `json:"type"`
			Scope    string  `json:"scope"`
			LimitUSD float64 `json:"limitUSD"`
			SpentUSD float64 `json:"spentUSD"`
		} `json:"error"`
	}
	json.Unmarshal([]byte(body), &refusal)
	if resp.StatusCode != http.StatusPaymentRequired || resp.Header.Get("X-Keyd-Reason") != ReasonBudgetTask ||
		refusal.Error.Type != "budget_exceeded" || refusal.Error.LimitUSD != 5 || refusal.Error.SpentUSD != 6 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	found := false
	for !found {
		select {
		case e := <-sub:
			if b, ok := e.Data.(events.Budget); ok && e.Type == events.TypeBudget && b.Scope == "task" && b.TaskID == "task-1" {
				found = true
			}
		case <-time.After(time.Second):
			t.Fatal("no budget.exceeded event")
		}
	}
	g.budget.Begin("c1", "task-1", 50)
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 200 {
		t.Fatalf("after raising the budget: %d", resp.StatusCode)
	}
	if err := g.settings.SetLimits(llm.Limits{PerTaskUSD: 10, PerDayUSD: 10}); err != nil {
		t.Fatal(err)
	}
	g.budget.Begin("c1", "task-2", 0)
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 402 || resp.Header.Get("X-Keyd-Reason") != ReasonBudgetDay {
		t.Fatalf("over the day: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestAnUpstreamFailureAnswers502(t *testing.T) {
	g := newGateway(t, nil, nil)
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	g.publish("api.anthropic.com", "443", addr, true)
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonUpstream {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	if info, _ := g.budget.Task("c1"); info.SpentUSD != 0 {
		t.Fatalf("a failed request was charged %v", info.SpentUSD)
	}
}

func TestACutStreamIsChargedTheMostItCanHaveCost(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":1}}}\n\n")
		io.WriteString(rw, "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n")
		rw.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}), nil)
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", strings.NewReader(`{"model":"claude-sonnet-5-5","max_tokens":1000,"messages":[]}`))
	req.Header = g.key()
	resp, err := g.client(g.cell).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(resp.Body)
	resp.Body.Close()
	if err == nil {
		t.Fatal("the stream ended cleanly after the provider failed")
	}
	l := g.waitLine(reasonIs(ReasonAborted))
	// The provider may have written up to the cap before it failed, past the few bytes relayed.
	price := llm.Price{Input: 3, Output: 15}
	want := price.Cost(llm.Usage{Input: 1000, Output: 1000})
	if l.CostMicroUSD != want || llm.Estimate(0, l.BytesOut).Output >= 1000 || l.Usage != "estimated" {
		t.Fatalf("audit %+v: charged %d, want %d (reported alone: %d)", l, l.CostMicroUSD, want, price.Cost(llm.Usage{Input: 1000, Output: 1}))
	}
	if info, _ := g.budget.Task("c1"); info.SpentUSD != float64(want)/1e6 {
		t.Fatalf("task spent %v", info.SpentUSD)
	}
}

func TestARequestInspectedBeforeStopNeverReachesTheProvider(t *testing.T) {
	reached := make(chan string, 1)
	g := newGateway(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		reached <- r.Header.Get("X-Api-Key")
	}), nil)
	body, upload := io.Pipe()
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", body)
	req.Header = g.key()
	answered := make(chan *http.Response, 1)
	go func() {
		resp, err := g.client(g.cell).Do(req)
		if err != nil {
			resp = &http.Response{StatusCode: 0, Header: http.Header{}, Body: http.NoBody}
		}
		answered <- resp
	}()
	io.WriteString(upload, `{"model":"claude-sonnet-5-5",`)
	time.Sleep(300 * time.Millisecond)
	// Stop, as Manager.Revoke does it for this cell, while keyd reads the body.
	g.registry.RevokeCell("c1")
	g.cell.Revoke()
	io.WriteString(upload, `"max_tokens":8,"messages":[]}`)
	upload.Close()
	resp := <-answered
	resp.Body.Close()
	select {
	case key := <-reached:
		t.Fatalf("the provider was reached after Stop, with X-Api-Key %q", key)
	default:
	}
	// 503 revoked, not 403 unknown-surrogate: keyd inspected the request before Stop.
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != ReasonRevoked {
		t.Fatalf("%d %q, want 503 %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), ReasonRevoked)
	}
}

// fourFifty may produce 300,000 tokens, $4.50 at the test price.
const fourFifty = `{"model":"claude-sonnet-5-5","max_tokens":300000,"messages":[]}`

// billTheCap answers each request, once release is closed, with as much output as its max_tokens
// allows, keeping in most the largest number of requests it held at once.
func billTheCap(release <-chan struct{}, running, most *atomic.Int32) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		n := running.Add(1)
		defer running.Add(-1)
		for m := most.Load(); n > m && !most.CompareAndSwap(m, n); m = most.Load() {
		}
		var body struct {
			MaxTokens int64 `json:"max_tokens"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		<-release
		rw.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(rw, `{"usage":{"input_tokens":20,"output_tokens":%d}}`, body.MaxTokens)
	})
}

// send posts body to the anthropic route from c with surrogate tok and returns the status; it is
// safe off the test's goroutine.
func (g *gatewayWorld) send(c *Cell, tok, body string) int {
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", tok)
	resp, err := g.client(c).Do(req)
	if err != nil {
		return 0
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

// inParallel starts every send at once, lets the provider answer after a moment and counts the
// statuses.
func inParallel(release chan struct{}, sends []func() int) map[int]int {
	statuses := make(chan int, len(sends))
	var wg sync.WaitGroup
	for _, send := range sends {
		wg.Go(func() { statuses <- send() })
	}
	time.Sleep(300 * time.Millisecond)
	close(release)
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for s := range statuses {
		counts[s]++
	}
	return counts
}

func TestParallelRequestsCannotOvershootTheTask(t *testing.T) {
	release := make(chan struct{})
	var running, most atomic.Int32
	g := newGateway(t, billTheCap(release, &running, &most), nil)
	sends := make([]func() int, 20)
	for i := range sends {
		sends[i] = func() int { return g.send(g.cell, g.tok, fourFifty) }
	}
	counts := inParallel(release, sends)
	info, _ := g.budget.Task("c1")
	// The second runs with the room the first left, its cap lowered to fit.
	if info.SpentUSD > info.LimitUSD || most.Load() != 1 || counts[200] != 2 || counts[402] != 18 {
		t.Fatalf("%d at once; statuses %v; the task spent $%.6f of $%.2f", most.Load(), counts, info.SpentUSD, info.LimitUSD)
	}
}

func TestParallelRequestsFromManyCellsCannotOvershootTheDay(t *testing.T) {
	release := make(chan struct{})
	var running, most atomic.Int32
	g := newGateway(t, billTheCap(release, &running, &most), nil)
	if err := g.settings.SetLimits(llm.Limits{PerTaskUSD: 5, PerDayUSD: 10}); err != nil {
		t.Fatal(err)
	}
	sends := []func() int{func() int { return g.send(g.cell, g.tok, fourFifty) }}
	for _, id := range []string{"c2", "c3", "c4", "c5"} {
		c := g.open(id, policy.Brain)
		tok := g.mint(id, "anthropic")
		g.budget.Begin(id, "task-"+id, 0)
		sends = append(sends, func() int { return g.send(c, tok, fourFifty) })
	}
	counts := inParallel(release, sends)
	if _, day := g.budget.Day(); day > 10 || counts[200] != 3 || counts[402] != 2 {
		t.Fatalf("statuses %v; the day spent $%.6f of $10", counts, day)
	}
}

func TestAClientDisconnectStopsTheProvider(t *testing.T) {
	aborted := make(chan struct{})
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: {}\n\n")
		rw.(http.Flusher).Flush()
		<-r.Context().Done()
		close(aborted)
	}), nil)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://llm.ldot/anthropic/messages", strings.NewReader(sonnet))
	req.Header = g.key()
	resp, err := g.client(g.cell).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Read(make([]byte, 16))
	cancel()
	resp.Body.Close()
	select {
	case <-aborted:
	case <-time.After(3 * time.Second):
		t.Fatal("the provider kept generating after the client left")
	}
	// keyd charges the request before it writes the line, so the test ends after the charge.
	g.waitLine(reasonIs(ReasonClientGone))
}

// leave sends body from the cell and hangs up once arrived says keyd has passed it on.
func (g *gatewayWorld) leave(t *testing.T, body string, arrived <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://llm.ldot/anthropic/messages", strings.NewReader(body))
	req.Header = g.key()
	gone := make(chan struct{})
	go func() {
		defer close(gone)
		if resp, err := g.client(g.cell).Do(req); err == nil {
			resp.Body.Close()
		}
	}()
	select {
	case <-arrived:
	case <-time.After(3 * time.Second):
		t.Fatal("keyd never passed the request on")
	}
	cancel()
	<-gone
}

func TestACellThatLeavesBeforeTheAnswerIsChargedItsHold(t *testing.T) {
	// A whole answer's headers come when it is generated; the provider bills the tokens it made
	// before keyd cancels it.
	reached := make(chan struct{}, 1)
	g := newGateway(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		reached <- struct{}{}
		<-r.Context().Done()
	}), nil)
	g.leave(t, fourFifty, reached)
	l := g.waitLine(reasonIs(ReasonClientGone))
	hold := llm.Price{Input: 3, Output: 15}.Ceiling(llm.Estimate(int64(len(fourFifty)), 0).Input, 300_000)
	if info, _ := g.budget.Task("c1"); l.CostMicroUSD != hold || l.Usage != "estimated" || info.SpentUSD != float64(hold)/1e6 {
		t.Fatalf("audit %+v, task spent $%.6f; want the hold, %d", l, info.SpentUSD, hold)
	}

	// A request keyd has not begun to send, its connection still opening, costs nothing.
	g = newGateway(t, nil, nil)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done, dialed := make(chan struct{}), make(chan struct{}, 1)
	t.Cleanup(func() { close(done); ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		dialed <- struct{}{} // and never answers the TLS handshake
		<-done
	}()
	g.publish("api.anthropic.com", "443", ln.Addr().String(), true)
	g.leave(t, fourFifty, dialed)
	l = g.waitLine(reasonIs(ReasonClientGone))
	if info, _ := g.budget.Task("c1"); l.CostMicroUSD != 0 || info.SpentUSD != 0 {
		t.Fatalf("audit %+v, task spent $%.6f; want nothing", l, info.SpentUSD)
	}
}

func TestLocalRoutesReachOnlyTheirServer(t *testing.T) {
	seen := make(chan *http.Request, 1)
	g := newGateway(t, nil, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"prompt_tokens":10,"completion_tokens":5}}`)
	}))
	resp, _ := g.post(t, "http://llm.ldot/lmstudio/chat/completions", http.Header{"Authorization": {"Bearer lm-studio"}}, `{"model":"qwen/qwen3.8-27b"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("%d", resp.StatusCode)
	}
	if r := <-seen; r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "" {
		t.Fatalf("local server saw %s %v", r.URL.Path, r.Header)
	}
	l := g.waitLine(func(l audit.Line) bool { return l.Route == "lmstudio" && l.Decision == audit.Allow })
	if l.CostMicroUSD != 0 || l.SecretID != "" {
		t.Fatalf("audit %+v", l)
	}
	if _, err := PinnedFor(g.local).DialContext(context.Background(), "tcp", "127.0.0.1:1"); !errors.As(err, new(*netguard.DeniedError)) {
		t.Fatalf("pinned dialer reached another address: %v", err)
	}
}

func TestGeminiNamesItsModelInThePath(t *testing.T) {
	seen := make(chan *http.Request, 1)
	g := newGateway(t, nil, nil)
	g.tlsUpstream("generativelanguage.googleapis.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: {\"usageMetadata\":{\"promptTokenCount\":100,\"candidatesTokenCount\":10}}\n\n")
	}))
	g.secret(vault.Record{ID: "gemini", Kind: vault.KindLLM, Provider: "google"}, realValue)
	tok := g.mint("c1", "gemini")
	g.settings.SetModels("gemini", []llm.Price{{Model: "gemini-3.6-flash", Input: 0.5, Output: 3, MaxOutput: 65_536}})
	resp, _ := g.post(t, "http://llm.ldot/gemini/models/gemini-3.6-flash:streamGenerateContent?alt=sse", http.Header{"X-Goog-Api-Key": {tok}}, `{"contents":[]}`)
	if resp.StatusCode != 200 {
		t.Fatalf("%d", resp.StatusCode)
	}
	r := <-seen
	if r.URL.Path != "/v1beta/models/gemini-3.6-flash:streamGenerateContent" || r.URL.RawQuery != "alt=sse" || r.Header.Get("X-Goog-Api-Key") != realValue {
		t.Fatalf("upstream saw %s?%s %v", r.URL.Path, r.URL.RawQuery, r.Header)
	}
	if resp, _ := g.post(t, "http://llm.ldot/gemini/models/gemini-3.6-pro:generateContent", http.Header{"X-Goog-Api-Key": {tok}}, `{}`); resp.StatusCode != 403 {
		t.Fatalf("unlisted gemini model: %d", resp.StatusCode)
	}
}

func TestAnAnswerWithoutUsageIsChargedItsHold(t *testing.T) {
	status := atomic.Int32{}
	status.Store(200)
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.WriteHeader(int(status.Load()))
		io.WriteString(rw, strings.Repeat("x", 300))
	}), nil)
	g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	l := g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Status == 200 })
	want := llm.Price{Input: 3, Output: 15}.Ceiling(llm.Estimate(int64(len(sonnet)), 0).Input, 64)
	if l.Usage != "estimated" || l.CostMicroUSD != want {
		t.Fatalf("audit %+v, want the hold, %d", l, want)
	}
	status.Store(400)
	g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	l = g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Status == 400 })
	if l.CostMicroUSD != 0 || l.Usage != "" {
		t.Fatalf("a failed answer was charged: %+v", l)
	}
}

// llmRoute adds an LLM secret for provider at a fake upstream host, mints its surrogate for each
// cell, and allows model at the test price with a 300,000-token maximum output.
func (g *gatewayWorld) llmRoute(id, provider, baseURL, host, model string, upstream http.Handler, cells ...string) map[string]string {
	g.t.Helper()
	g.tlsUpstream(host, upstream)
	g.secret(vault.Record{ID: id, Kind: vault.KindLLM, Provider: provider, BaseURL: baseURL}, realValue)
	if err := g.settings.SetModels(id, []llm.Price{{Model: model, Input: 3, Output: 15, MaxOutput: 300_000}}); err != nil {
		g.t.Fatal(err)
	}
	toks := map[string]string{}
	for _, c := range cells {
		toks[c] = g.mint(c, id)
	}
	return toks
}

// call posts body to rawURL from c and returns the status and the body; it is safe off the
// test's goroutine.
func (g *gatewayWorld) call(c *Cell, rawURL string, header http.Header, body string) (int, string) {
	req, _ := http.NewRequest("POST", rawURL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, vs := range header {
		req.Header[k] = vs
	}
	resp, err := g.client(c).Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

// generous answers, once release is closed, like a provider that writes all it may: the cap it
// reads in its own field (a dotted path), or 300,000 tokens ($4.50 at the test price) when that is
// absent or null, times each count of answers it reads (a list counts its elements).
func generous(capField string, counts []string, release <-chan struct{}) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		read := func(path string) (float64, bool) {
			var v any = body
			for _, k := range strings.Split(path, ".") {
				m, _ := v.(map[string]any)
				v = m[k]
			}
			if list, ok := v.([]any); ok {
				return float64(len(list)), true
			}
			n, ok := v.(float64)
			return n, ok
		}
		out, ok := read(capField)
		if !ok {
			out = 300_000
		}
		for _, field := range counts {
			if n, ok := read(field); ok {
				out *= n
			}
		}
		<-release
		rw.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, ":generateContent") {
			fmt.Fprintf(rw, `{"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":%d}}`, int64(out))
			return
		}
		fmt.Fprintf(rw, `{"usage":{"prompt_tokens":20,"completion_tokens":%d}}`, int64(out))
	})
}

// shape is a request that hides what it can cost from a gateway that trusts its body. With
// refused set keyd answers 400 naming that field; with fills, keyd sets the cap, and the provider
// writes all the room allows.
type shape struct {
	name, route, provider, baseURL, host, path, header, body string
	capField                                                 string
	counts                                                   []string
	refused                                                  string
	fills                                                    bool
}

var shapes = []shape{
	{"a null cap", "openai", "openai", "", "api.openai.com", "chat/completions", "Authorization",
		`{"model":"m","max_completion_tokens":null,"messages":[]}`, "max_completion_tokens", []string{"n"}, "", true},
	{"a null cap in Gemini's config", "gemini", "google", "", "generativelanguage.googleapis.com", "models/m:generateContent", "X-Goog-Api-Key",
		`{"contents":[],"generationConfig":{"maxOutputTokens":null}}`, "generationConfig.maxOutputTokens", []string{"generationConfig.candidateCount"}, "", true},
	{"n", "openai", "openai", "", "api.openai.com", "chat/completions", "Authorization",
		`{"model":"m","max_completion_tokens":2000,"n":128,"messages":[]}`, "max_completion_tokens", []string{"n"}, "n", false},
	{"best_of", "openai", "openai", "", "api.openai.com", "completions", "Authorization",
		`{"model":"m","prompt":"x","max_tokens":10000,"best_of":20}`, "max_tokens", []string{"best_of"}, "best_of", false},
	{"candidateCount", "gemini", "google", "", "generativelanguage.googleapis.com", "models/m:generateContent", "X-Goog-Api-Key",
		`{"contents":[],"generationConfig":{"maxOutputTokens":30000,"candidateCount":8}}`, "generationConfig.maxOutputTokens", []string{"generationConfig.candidateCount"}, "candidateCount", false},
	// The completions API answers each prompt of a list under the one cap.
	{"a prompt list", "openai", "openai", "", "api.openai.com", "completions", "Authorization",
		`{"model":"m","prompt":["x","y","z"],"max_tokens":10000}`, "max_tokens", []string{"prompt"}, "prompt", false},
	// The cell's one-token cap, in a field the server ignores, becomes keyd's cap in max_tokens.
	{"a cap the server ignores", "compat", "openai-compatible", "https://llm.example.test/v1", "llm.example.test", "chat/completions", "Authorization",
		`{"model":"m","max_output_tokens":1,"messages":[]}`, "max_tokens", []string{"n"}, "", false},
}

func TestNoRequestShapeOvershootsTheBudget(t *testing.T) {
	for _, s := range shapes {
		for _, cells := range []int{1, 5} {
			t.Run(fmt.Sprintf("%s from %d cells", s.name, cells), func(t *testing.T) {
				t.Parallel()
				release := make(chan struct{})
				g := newGateway(t, nil, nil)
				ids, cs := []string{"c1"}, []*Cell{g.cell}
				for i := 2; i <= cells; i++ {
					id := fmt.Sprintf("c%d", i)
					cs = append(cs, g.open(id, policy.Brain))
					g.budget.Begin(id, "task-"+id, 0)
					ids = append(ids, id)
				}
				toks := g.llmRoute(s.route, s.provider, s.baseURL, s.host, "m", generous(s.capField, s.counts, release), ids...)
				header := func(id string) http.Header {
					if s.header == "Authorization" {
						return http.Header{"Authorization": {"Bearer " + toks[id]}}
					}
					return http.Header{s.header: {toks[id]}}
				}
				target := "http://llm.ldot/" + s.route + "/" + s.path
				if s.refused != "" {
					if status, body := g.call(g.cell, target, header("c1"), s.body); status != 400 || body != "keyd: "+ReasonChoiceCount+": "+s.refused+"\n" {
						t.Fatalf("%d %q", status, body)
					}
				}
				sends := make([]func() int, 20)
				for i := range sends {
					c, id := cs[i%cells], ids[i%cells]
					sends[i] = func() int {
						status, _ := g.call(c, target, header(id), s.body)
						return status
					}
				}
				counts := inParallel(release, sends)
				for _, id := range ids {
					if info, _ := g.budget.Task(id); info.SpentUSD > info.LimitUSD {
						t.Errorf("statuses %v; %s spent $%.2f of $%.2f", counts, id, info.SpentUSD, info.LimitUSD)
					}
				}
				if _, day := g.budget.Day(); day > 20 {
					t.Errorf("statuses %v; the day spent $%.6f of $20", counts, day)
				}
				_, day := g.budget.Day()
				switch {
				case s.refused != "" && counts[400] != 20:
					t.Errorf("statuses %v, want 20 refusals naming %s", counts, s.refused)
				case s.fills && (counts[200] == 0 || day < min(4.99*float64(cells), 19.99)):
					t.Errorf("statuses %v; the day spent $%.2f, not all the room allowed", counts, day)
				case s.refused == "" && !s.fills && counts[200] != 20:
					t.Errorf("statuses %v, want 20 answers capped as the cell asked", counts)
				}
			})
		}
	}
}

func TestTheGatewayWritesTheCapInTheProvidersField(t *testing.T) {
	seen := make(chan map[string]any, 1)
	record := http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		seen <- body
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"prompt_tokens":10,"completion_tokens":10}}`)
	})
	g := newGateway(t, record, nil)
	toks := map[string]http.Header{"anthropic": g.key()}
	for _, r := range []struct{ id, provider, baseURL, host, header string }{
		{"openai", "openai", "", "api.openai.com", "Authorization"},
		{"compat", "openai-compatible", "https://llm.example.test/v1", "llm.example.test", "Authorization"},
		{"gemini", "google", "", "generativelanguage.googleapis.com", "X-Goog-Api-Key"},
	} {
		tok := g.llmRoute(r.id, r.provider, r.baseURL, r.host, "m", record, "c1")["c1"]
		toks[r.id] = http.Header{r.header: {tok}}
		if r.header == "Authorization" {
			toks[r.id] = http.Header{r.header: {"Bearer " + tok}}
		}
	}
	cases := []struct {
		name, route, path, body, field string
		want                           float64
	}{
		{"anthropic, no cap", "anthropic", "messages", `{"model":"claude-sonnet-5-5","messages":[]}`, "max_tokens", 300_000},
		{"anthropic, null and another field", "anthropic", "messages", `{"model":"claude-sonnet-5-5","max_tokens":null,"max_output_tokens":64,"messages":[]}`, "max_tokens", 64},
		{"openai chat, null", "openai", "chat/completions", `{"model":"m","max_completion_tokens":null,"messages":[]}`, "max_completion_tokens", 300_000},
		{"openai chat, the older field", "openai", "chat/completions", `{"model":"m","max_tokens":512,"messages":[]}`, "max_completion_tokens", 512},
		{"openai responses, no cap", "openai", "responses", `{"model":"m","input":"hi"}`, "max_output_tokens", 300_000},
		{"openai completions, a string", "openai", "completions", `{"model":"m","prompt":"hi","max_tokens":"64"}`, "max_tokens", 300_000},
		{"openai-compatible, a field it ignores", "compat", "chat/completions", `{"model":"m","max_output_tokens":1,"messages":[]}`, "max_tokens", 1},
		{"gemini, null", "gemini", "models/m:generateContent", `{"contents":[],"generationConfig":{"maxOutputTokens":null,"temperature":1}}`, "generationConfig.maxOutputTokens", 300_000},
		{"gemini, the proto name", "gemini", "models/m:streamGenerateContent", `{"contents":[],"generation_config":{"max_output_tokens":2048}}`, "generation_config.maxOutputTokens", 2048},
	}
	for _, c := range cases {
		if status, body := g.call(g.cell, "http://llm.ldot/"+c.route+"/"+c.path, toks[c.route], c.body); status != 200 {
			t.Fatalf("%s: %d %s", c.name, status, body)
		}
		got := <-seen
		camel, _ := got["generationConfig"].(map[string]any)
		snake, _ := got["generation_config"].(map[string]any)
		caps := 0
		for _, object := range []map[string]any{got, camel, snake} {
			for k := range object {
				if f := strings.ToLower(strings.ReplaceAll(k, "_", "")); f == "maxtokens" || f == "maxcompletiontokens" || f == "maxoutputtokens" {
					caps++
				}
			}
		}
		value := got[c.field]
		if parent, field, nested := strings.Cut(c.field, "."); nested {
			config, _ := got[parent].(map[string]any)
			value = config[field]
		}
		if caps != 1 || value != c.want {
			t.Errorf("%s: the provider read %v in %s, with %d caps in all: %v", c.name, value, c.field, caps, got)
		}
	}
}

// chatBody asks a chat-completions route for a streamed answer of at most 64 tokens.
const chatBody = `{"model":"m","max_tokens":64,"messages":[],"stream":true}`

// Part 5a's first-class bearer providers (P5a-R31): each preset sends the surrogate's real key as a
// bearer token to its own fixed host and base path, lists only the operation its official package
// calls, and has its usage, in its own dialect, charged to the task. DeepSeek's base URL has no
// path, so the upstream path is joined under "/".
func TestEachFirstClassBearerProviderHasItsOwnRoute(t *testing.T) {
	chat := func(last string) string {
		return "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n" +
			"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]," + last + "}\n\ndata: [DONE]\n\n"
	}
	const usage = `{"prompt_tokens":1200,"completion_tokens":80}`
	cases := []struct {
		provider, host, op, upstreamPath, other, body, stream string
	}{
		{"xai", "api.x.ai", "responses", "/v1/responses", "chat/completions",
			`{"model":"m","input":"hi","max_output_tokens":64,"stream":true}`,
			"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1200,\"output_tokens\":80}}}\n\n"},
		{"mistral", "api.mistral.ai", "chat/completions", "/v1/chat/completions", "responses", chatBody, chat(`"usage":` + usage)},
		{"deepseek", "api.deepseek.com", "chat/completions", "/chat/completions", "responses", chatBody, chat(`"usage":` + usage)},
		{"groq", "api.groq.com", "chat/completions", "/openai/v1/chat/completions", "responses", chatBody, chat(`"x_groq":{"id":"req_1","usage":` + usage + `}`)},
		{"openrouter", "openrouter.ai", "chat/completions", "/api/v1/chat/completions", "completions", chatBody, chat(`"usage":` + usage)},
	}
	for _, c := range cases {
		t.Run(c.provider, func(t *testing.T) {
			seen := make(chan *http.Request, 4)
			g := newGateway(t, nil, nil)
			tok := g.llmRoute(c.provider, c.provider, "", c.host, "m", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
				seen <- r.Clone(context.Background())
				rw.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(rw, c.stream)
			}), "c1")["c1"]
			bearer := http.Header{"Authorization": {"Bearer " + tok}}
			resp, body := g.post(t, "http://llm.ldot/"+c.provider+"/"+c.op, bearer, c.body)
			if resp.StatusCode != 200 || !strings.Contains(body, "1200") {
				t.Fatalf("%d %s", resp.StatusCode, body)
			}
			r := <-seen
			if r.URL.Path != c.upstreamPath || r.Header.Get("Authorization") != "Bearer "+realValue {
				t.Fatalf("upstream saw %s %v", r.URL.Path, r.Header)
			}
			l := g.waitLine(func(l audit.Line) bool {
				return l.Mode == "gateway" && l.Decision == audit.Allow && l.Route == c.provider
			})
			if l.Host != c.host || l.Path != c.upstreamPath || l.SecretID != c.provider || !l.Swapped ||
				l.Usage != "reported" || l.CostMicroUSD != 1200*3+80*15 {
				t.Fatalf("audit %+v", l)
			}
			if info, _ := g.budget.Task("c1"); info.SpentUSD != 0.0048 {
				t.Fatalf("task spent %v", info.SpentUSD)
			}
			if resp, _ := g.post(t, "http://llm.ldot/"+c.provider+"/"+c.other, bearer, chatBody); resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonOpNotAllowed {
				t.Errorf("%s, which the package never calls: %d %q", c.other, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
			}
			// OpenRouter's fallback list could answer with a model off the allowlist.
			fallback := `{"model":"m","models":["m","pricier"],"messages":[]}`
			if status, body := g.call(g.cell, "http://llm.ldot/"+c.provider+"/"+c.op, bearer, fallback); status != 400 || body != "keyd: "+ReasonChoiceCount+": models\n" {
				t.Errorf("a models list: %d %q", status, body)
			}
			select {
			case r := <-seen:
				t.Fatalf("a refused request reached the provider at %s", r.URL.Path)
			default:
			}
		})
	}
}

// screenshot is a 1280x800 PNG padded to 450 KB, the size review 2 measured, in base64.
func screenshot(t *testing.T) string {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewGray(image.Rect(0, 0, 1280, 800))); err != nil {
		t.Fatal(err)
	}
	b.Write(make([]byte, 450_000-b.Len()))
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

func TestScreenshotsDoNotStopATaskEarly(t *testing.T) {
	// Review 2's numbers: five 1280x800 screenshots of 450 KB with max_tokens 4096, billed at the test
	// price as 30,000 input tokens and 300 output tokens, $0.0945 a call; the conversation's text
	// carries the input tokens the images do not. The task has spent $4.50 already, so a ceiling
	// that counts the base64 as text, $3.13, is refused at once.
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":30000,"output_tokens":300}}`)
	}), nil)
	earlier, _ := g.budget.Reserve(context.Background(), "c1", llm.Ask{Fixed: 1})
	earlier.Settle(4_500_000)
	shot := `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + screenshot(t) + `"}}`
	history := strings.Repeat("an earlier turn of the conversation, as text. ", 1_520)
	body := `{"model":"claude-sonnet-5-5","max_tokens":4096,"messages":[{"role":"user","content":"` + history +
		`"},{"role":"user","content":[` + strings.Repeat(shot+",", 4) + shot + `]}]}`
	calls := 0
	for {
		resp, out := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), body)
		if resp.StatusCode != 200 {
			if resp.StatusCode != http.StatusPaymentRequired {
				t.Fatalf("call %d: %d %s", calls+1, resp.StatusCode, out)
			}
			break
		}
		calls++
	}
	// Refused only when what is left cannot pay for the request's input, about $0.09.
	if info, _ := g.budget.Task("c1"); info.SpentUSD < info.LimitUSD-0.1 || info.SpentUSD > info.LimitUSD {
		t.Fatalf("refused after %d calls, with $%.4f of $%.2f spent", calls, info.SpentUSD, info.LimitUSD)
	}
}

func TestABudgetRefusalIsAnnounced(t *testing.T) {
	var hits atomic.Int32
	g := newGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }), nil)
	g.budget.Begin("c1", "task-1", 0.00005) // less than the request's input costs
	sub, cancel := g.events.Subscribe(8)
	defer cancel()
	resp, body := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	if resp.StatusCode != http.StatusPaymentRequired || !strings.Contains(body, `"needUSD"`) || hits.Load() != 0 {
		t.Fatalf("%d %s, provider reached %d times", resp.StatusCode, body, hits.Load())
	}
	for {
		select {
		case e := <-sub:
			if b, ok := e.Data.(events.Budget); ok && e.Type == events.TypeBudget && b.Scope == "task" && b.TaskID == "task-1" && b.LimitUSD == 0.00005 {
				return
			}
		case <-time.After(time.Second):
			t.Fatal("the refusal published no budget.exceeded")
		}
	}
}

func TestCountingTokensNeverWaits(t *testing.T) {
	release, started := make(chan struct{}), make(chan struct{})
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/count_tokens") {
			io.WriteString(rw, `{"input_tokens":10}`)
			return
		}
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n")
		rw.(http.Flusher).Flush()
		close(started)
		<-release
	}), nil)
	streamed := make(chan int, 1)
	go func() { streamed <- g.send(g.cell, g.tok, fourFifty) }() // holds $4.50 of the $5 task
	<-started
	counted := make(chan int, 1)
	go func() {
		status, _ := g.call(g.cell, "http://llm.ldot/anthropic/messages/count_tokens", g.key(), `{"model":"claude-sonnet-5-5","messages":[]}`)
		counted <- status
	}()
	select {
	case status := <-counted:
		if status != 200 {
			t.Fatalf("count_tokens: %d", status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("count_tokens waited for a running stream")
	}
	close(release)
	<-streamed
	if l := g.waitLine(func(l audit.Line) bool { return strings.HasSuffix(l.Path, "/count_tokens") }); l.CostMicroUSD != 0 {
		t.Fatalf("counting was charged: %+v", l)
	}
}

func TestASecretReplacedWhileARequestWaitsIsNotSent(t *testing.T) {
	release, started := make(chan struct{}), make(chan struct{}, 2)
	var mu sync.Mutex
	var sent []string
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sent = append(sent, r.Header.Get("X-Api-Key"))
		mu.Unlock()
		started <- struct{}{}
		<-release
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":20,"output_tokens":10}}`)
	}), nil)
	first := make(chan int, 1)
	go func() { first <- g.send(g.cell, g.tok, fourFifty) }() // holds $4.50 of the $5 task
	<-started
	waiting := make(chan int, 1)
	go func() {
		waiting <- g.send(g.cell, g.tok, `{"model":"claude-sonnet-5-5","max_tokens":100000,"messages":[]}`) // $1.50: waits
	}()
	time.Sleep(200 * time.Millisecond)
	// The user replaces the key, as PUT /v1/secrets/anthropic does: store it, then revoke its surrogates.
	g.vault.Put(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, []byte("replacement-secret-value-for-test"))
	g.registry.RevokeSecret("anthropic")
	close(release)
	<-first
	status := <-waiting
	mu.Lock()
	defer mu.Unlock()
	if status != http.StatusForbidden || len(sent) != 1 {
		t.Fatalf("the waiting request got %d; the provider saw keys %q", status, sent)
	}
}
```

`keyd/internal/keys/presets_test.go`:
```go
package keys

import (
	"net/http"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Part 5a's first-class bearer providers (P5a-R31): a fixed base URL, the surrogate as a bearer
// token, their own tag, and only the operation their official AI SDK package calls, with the cap
// field it sends.
func TestTheFirstClassBearerPresets(t *testing.T) {
	r := NewRegistry()
	for _, c := range []struct {
		provider, upstream, tag, op, body, cap string
	}{
		{"xai", "https://api.x.ai/v1", "xai", "responses", "responses", "max_output_tokens"},
		{"mistral", "https://api.mistral.ai/v1", "mis", "chat/completions", "chat", "max_tokens"},
		{"deepseek", "https://api.deepseek.com", "dsk", "chat/completions", "chat", "max_tokens"},
		{"groq", "https://api.groq.com/openai/v1", "grq", "chat/completions", "chat", "max_tokens"},
		{"openrouter", "https://openrouter.ai/api/v1", "orr", "chat/completions", "chat", "max_tokens"},
	} {
		b, err := FromRecord(vault.Record{ID: "my-" + c.provider, Kind: vault.KindLLM, Provider: c.provider})
		if err != nil {
			t.Fatalf("%s: %v", c.provider, err)
		}
		if b.Route != "my-"+c.provider || b.SecretID != "my-"+c.provider || b.Upstream.String() != c.upstream ||
			b.Header != "Authorization" || b.Format != Bearer || b.Tag != c.tag || b.Local {
			t.Errorf("%s binding %+v", c.provider, b)
		}
		if op, ok := b.Op("POST", c.op); !ok || op.Body != c.body || op.Cap != c.cap || op.Free || op.Model {
			t.Errorf("%s POST %s: %+v %v", c.provider, c.op, op, ok)
		}
		for _, p := range []string{"models", "models/some-model", "models/vendor/some-model"} {
			if _, ok := b.Op("GET", p); !ok {
				t.Errorf("%s GET %s refused", c.provider, p)
			}
		}
		for _, other := range []string{"chat/completions", "responses", "completions", "embeddings", "messages"} {
			if _, ok := b.Op("POST", other); ok && other != c.op {
				t.Errorf("%s lists POST %s, which its package never calls", c.provider, other)
			}
		}
		if _, err := FromRecord(vault.Record{ID: "x", Kind: vault.KindLLM, Provider: c.provider, BaseURL: "https://llm.example.test/v1"}); err == nil {
			t.Errorf("%s took a base URL; its preset fixes it", c.provider)
		}
		e, err := r.Mint("c1", b)
		if err != nil {
			t.Fatal(err)
		}
		d := Dest{Cell: "c1", Scheme: "gateway", Route: b.Route}
		wantAllow(t, c.provider+" as a bearer token", at(t, r, d, "POST", "/x", hdr("Authorization", "Bearer "+e.Token)), 1)
		wantDeny(t, c.provider+" in X-Api-Key", at(t, r, d, "POST", "/x", hdr("X-Api-Key", e.Token)), ReasonMisplacedSurrogate)
		wantDeny(t, c.provider+" in the query", at(t, r, d, "POST", "/x?key="+e.Token, http.Header{}), ReasonMisplacedSurrogate)
	}
	tags := map[string]string{}
	for name, p := range presets {
		if other, dup := tags[p.tag]; dup {
			t.Errorf("presets %s and %s share the tag %s", name, other, p.tag)
		}
		tags[p.tag] = name
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/egress/ ./internal/keys/`
Expected: FAIL — `[build failed]`: `internal/egress/gateway_test.go:80:7: deps.Budget undefined (type Deps has no field or method Budget)`;
and in `keys`, `TestTheFirstClassBearerPresets` fails for each provider with `keys: unknown provider "xai"` (and the others).

- [ ] **Step 3: The first-class bearer presets, the gateway's dependencies and its transport**

In `keyd/internal/keys/binding.go`, replace:
```go
// A preset without a base takes the record's BaseURL.
var presets = map[string]preset{
	"anthropic":         {"https://api.anthropic.com/v1", "X-Api-Key", Raw, "ant", anthropicOps},
	"openai":            {"https://api.openai.com/v1", "Authorization", Bearer, "oai", openAIOps},
	"google":            {"https://generativelanguage.googleapis.com/v1beta", "X-Goog-Api-Key", Raw, "gem", googleOps},
	"openai-compatible": {"", "Authorization", Bearer, "llm", compatibleOps},
	"azure":             {"", "Api-Key", Raw, "azr", openAIOps},
}
```
with:
```go
// A preset without a base takes the record's BaseURL. The first-class bearer providers (Part 5a,
// P5a-R31) have fixed bases and list only the operation their official AI SDK package calls.
var presets = map[string]preset{
	"anthropic":         {"https://api.anthropic.com/v1", "X-Api-Key", Raw, "ant", anthropicOps},
	"openai":            {"https://api.openai.com/v1", "Authorization", Bearer, "oai", openAIOps},
	"google":            {"https://generativelanguage.googleapis.com/v1beta", "X-Goog-Api-Key", Raw, "gem", googleOps},
	"xai":               {"https://api.x.ai/v1", "Authorization", Bearer, "xai", xaiOps},
	"mistral":           {"https://api.mistral.ai/v1", "Authorization", Bearer, "mis", chatOnlyOps},
	"deepseek":          {"https://api.deepseek.com", "Authorization", Bearer, "dsk", chatOnlyOps},
	"groq":              {"https://api.groq.com/openai/v1", "Authorization", Bearer, "grq", chatOnlyOps},
	"openrouter":        {"https://openrouter.ai/api/v1", "Authorization", Bearer, "orr", chatOnlyOps},
	"openai-compatible": {"", "Authorization", Bearer, "llm", compatibleOps},
	"azure":             {"", "Api-Key", Raw, "azr", openAIOps},
}

// The first-class bearer providers' operations: the one their package calls, with the cap field it
// sends, and the model listings as openAIStyle writes them. xAI's package speaks only its Responses
// API; xAI's chat completions report reasoning tokens outside completion_tokens, which the meter
// would undercharge, so the xAI route has no chat operation.
var (
	chatOnlyOps = withListings(Op{Method: "POST", Path: regexp.MustCompile(`^chat/completions$`), Body: "chat", Cap: "max_tokens"})
	xaiOps      = withListings(Op{Method: "POST", Path: regexp.MustCompile(`^responses$`), Body: "responses", Cap: "max_output_tokens"})
)

func withListings(op Op) []Op {
	return append([]Op{op}, slices.DeleteFunc(openAIStyle(""), func(o Op) bool { return o.Method != "GET" })...)
}
```

Replace `keyd/internal/egress/deps.go` with:
```go
package egress

import (
	"context"
	"crypto/x509"
	"net"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/cellca"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Dialer is satisfied by *netguard.Dialer.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

type Config struct {
	CellID string
	Policy policy.Policy
	// Port 0 picks a free port; tests use it.
	Port  int
	Token string
	// CA terminates TLS for its hosts; without one nothing is intercepted.
	CA *cellca.CA
}

type Deps struct {
	Registry *keys.Registry
	Vault    *vault.Vault
	Audit    *audit.Log
	Events   *events.Hub
	Dialer   Dialer
	// RootCAs verifies upstream TLS; nil means the system roots.
	RootCAs  *x509.CertPool
	Budget   *llm.Budget
	Settings *llm.Settings
	// Local are the gateway's routes to model servers on the Mac; LocalDialer reaches only them.
	Local       map[string]keys.Binding
	LocalDialer Dialer
}
```

Replace `keyd/internal/egress/generation.go` with:
```go
package egress

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"sync"
	"time"
)

// generation is what the kill switch replaces: the context every upstream request and tunnel
// hangs off, the transports whose pooled connections it closes, and the tunnels it tracks.
type generation struct {
	ctx    context.Context
	cancel context.CancelFunc
	tr     *http.Transport
	local  *http.Transport
	mu     sync.Mutex
	conns  map[net.Conn]struct{}
}

func newGeneration(d Deps) *generation {
	ctx, cancel := context.WithCancel(context.Background())
	tr := &http.Transport{
		DialContext:           d.Dialer.DialContext,
		TLSClientConfig:       &tls.Config{RootCAs: d.RootCAs, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   8,
		ExpectContinueTimeout: time.Second,
		// relay asks for gzip itself and decodes it, so it sees every coding a body has.
		DisableCompression: true,
	}
	localDial := func(context.Context, string, string) (net.Conn, error) { return nil, errNoLocal }
	if d.LocalDialer != nil {
		localDial = d.LocalDialer.DialContext
	}
	local := &http.Transport{DialContext: localDial, IdleConnTimeout: 90 * time.Second, DisableCompression: true}
	return &generation{ctx: ctx, cancel: cancel, tr: tr, local: local, conns: map[net.Conn]struct{}{}}
}

// track registers a connection for the kill switch; one opened after the switch is closed at once.
func (g *generation) track(conn net.Conn) func() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ctx.Err() != nil {
		conn.Close()
		return func() {}
	}
	g.conns[conn] = struct{}{}
	return func() {
		g.mu.Lock()
		delete(g.conns, conn)
		g.mu.Unlock()
	}
}

func (g *generation) stop() {
	g.cancel()
	g.mu.Lock()
	for conn := range g.conns {
		conn.Close()
	}
	g.conns = map[net.Conn]struct{}{}
	g.mu.Unlock()
	g.tr.CloseIdleConnections()
	g.local.CloseIdleConnections()
}
```

In `keyd/internal/egress/cell.go`, replace:
```go
	case strings.EqualFold(r.URL.Hostname(), internalHost):
		c.serveInternal(w, r)
	default:
```
with:
```go
	case strings.EqualFold(r.URL.Hostname(), internalHost):
		c.serveInternal(w, r)
	case strings.EqualFold(r.URL.Hostname(), gatewayHost) && c.cfg.Policy.Gateway:
		c.serveGateway(w, r)
	default:
```

In `keyd/internal/egress/cell.go`, replace:
```go
	keys.ReasonSurrogatePolicy:    true,
}
```
with:
```go
	keys.ReasonSurrogatePolicy:    true,
	ReasonSurrogateMissing:        true,
}
```

In `keyd/internal/egress/forward.go`, replace:
```go
// route is one request keyd forwards: where it goes and the audit line it will close.
type route struct {
	dest   keys.Dest
	target *url.URL
	line   audit.Line
	gen    *generation
}
```
with:
```go
// route is one request keyd forwards: where it goes and the audit line it will close. Gateway
// routes to local model servers use the local transport and meter what they relay.
type route struct {
	dest   keys.Dest
	target *url.URL
	line   audit.Line
	gen    *generation
	local  bool
	meter  *gatewayMeter
}
```

In `keyd/internal/egress/forward.go`, replace:
```go
		Transport:     rt.gen.tr,
```
with:
```go
		Transport:     transportFor(rt),
```

In `keyd/internal/egress/forward.go`, replace:
```go
			resp.Body = &tally{
				ReadCloser: scrubber.Reader(resp.Body),
				atEOF:      func() { scrubber.Header(resp.Trailer) },
				done: func(n int64, eof bool, err error) {
					l.BytesOut = n
					c.streamOutcome(&l, eof, err, r.Context(), rt.gen)
					finish(l)
				},
			}
```
with:
```go
			body := scrubber.Reader(resp.Body)
			if rt.meter != nil {
				body = &teeCloser{Reader: io.TeeReader(body, rt.meter.start(resp)), Closer: body}
			}
			resp.Body = &tally{
				ReadCloser: body,
				atEOF:      func() { scrubber.Header(resp.Trailer) },
				done: func(n int64, eof bool, err error) {
					l.BytesOut = n
					c.streamOutcome(&l, eof, err, r.Context(), rt.gen)
					if rt.meter != nil {
						rt.meter.settle(&l, n, eof && err == nil)
					}
					finish(l)
				},
			}
```

In `keyd/internal/egress/forward.go`, replace:
```go
			l.Decision, l.Reason, l.Status, l.Detail = decision, reason, status, err.Error()
			finish(l)
```
with:
```go
			l.Decision, l.Reason, l.Status, l.Detail = decision, reason, status, err.Error()
			if rt.meter != nil && reason == ReasonClientGone {
				rt.meter.left(&l)
			}
			finish(l)
```

- [ ] **Step 4: Implement the gateway**

`keyd/internal/egress/gateway.go`:
```go
package egress

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"path"
	"slices"
	"strings"
	"sync/atomic"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const (
	gatewayHost    = "llm.ldot"
	maxGatewayBody = 32 << 20

	ReasonRouteUnknown     = "route-unknown"
	ReasonOpNotAllowed     = "op-not-allowed"
	ReasonSurrogateMissing = "surrogate-missing"
	ReasonNoTask           = "no-task"
	ReasonBudgetTask       = "budget-task"
	ReasonBudgetDay        = "budget-day"
	ReasonBodyTooLarge     = "body-too-large"
	ReasonBadJSON          = "bad-json"
	ReasonModelMissing     = "model-missing"
	ReasonModelNotAllowed  = "model-not-allowed"
	ReasonChoiceCount      = "choice-count"
)

var errNoLocal = errors.New("egress: no local model servers are configured")

// The cell's own credentials for a provider are dropped; only the route's swapped key goes up.
var authHeaders = []string{"Authorization", "X-Api-Key", "X-Goog-Api-Key", "Api-Key", "Cookie"}

// serveGateway is the LLM gateway at http://llm.ldot/<route>/<path>: the route's real key in the
// provider's auth style, only the operations the route lists, only allowlisted models, a running
// task with room for what the request can cost, and the cost of every answer charged to it. The
// generation is taken first, so a Stop that lands while the body uploads refuses the request, and
// the request is inspected again once it may go, so a surrogate revoked meanwhile is refused.
func (c *Cell) serveGateway(w http.ResponseWriter, r *http.Request) {
	g := c.current()
	line := audit.Line{Kind: audit.KindRequest, Mode: "gateway", Method: r.Method, Host: gatewayHost, Path: r.URL.Path}
	name, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	line.Route = name
	b, ok := c.gatewayRoute(name)
	if !ok {
		c.deny(w, line, http.StatusNotFound, ReasonRouteUnknown)
		return
	}
	// Joined under "/": a base URL may have no path (DeepSeek's, or a user's https://host).
	line.Host, line.Path = b.Upstream.Hostname(), path.Join("/", b.Upstream.Path, rest)
	op, ok := b.Op(r.Method, rest)
	if !ok || path.Clean(rest) != rest {
		c.deny(w, line, http.StatusForbidden, ReasonOpNotAllowed)
		return
	}
	if isUpgrade(r) {
		c.deny(w, line, http.StatusForbidden, ReasonUpgrade)
		return
	}
	dest := keys.Dest{Cell: c.cfg.CellID, Scheme: "gateway", Route: name}
	v := c.deps.Registry.Inspect(dest, r.Method, r.URL, r.Header)
	line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
	if !v.Allow {
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	if !b.Local && !slices.ContainsFunc(v.Swaps, func(e keys.Entry) bool { return e.Binding.Route == name }) {
		line.SecretID = b.SecretID
		c.deny(w, line, http.StatusForbidden, ReasonSurrogateMissing)
		return
	}
	if err := c.deps.Budget.Check(c.cfg.CellID); err != nil {
		c.refuseBudget(w, line, err)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxGatewayBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.deny(w, line, http.StatusRequestEntityTooLarge, ReasonBodyTooLarge)
		} else {
			c.deny(w, line, http.StatusBadRequest, ReasonBadRequest)
		}
		return
	}
	model := ""
	switch {
	case op.Model:
		model = op.ModelFrom(rest)
	case r.Method == http.MethodPost:
		if model, err = llm.ModelFromJSON(body); err != nil {
			c.deny(w, line, http.StatusBadRequest, ReasonBadJSON)
			return
		}
		if model == "" {
			c.deny(w, line, http.StatusBadRequest, ReasonModelMissing)
			return
		}
	}
	line.Model = model
	var price llm.Price
	if model != "" {
		if price, ok = c.deps.Settings.Price(name, model); !ok {
			c.deny(w, line, http.StatusForbidden, ReasonModelNotAllowed)
			return
		}
	}
	var hold *llm.Hold
	if model != "" && !op.Free {
		if hold, body, ok = c.reserve(w, r, g, line, op, price, model, body); !ok {
			return
		}
		defer hold.Release()
	}
	if g.ctx.Err() != nil {
		c.deny(w, line, http.StatusServiceUnavailable, ReasonRevoked)
		return
	}
	if v = c.deps.Registry.Inspect(dest, r.Method, r.URL, r.Header); !v.Allow {
		line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	for _, h := range authHeaders {
		if h != b.Header {
			r.Header.Del(h)
		}
	}
	if status, reason := c.swap(r.Header, v.Swaps); reason != "" {
		c.deny(w, line, status, reason)
		return
	}
	line.Swapped = len(v.Swaps) > 0
	scrubber, err := c.scrubberFor(dest)
	if err != nil {
		c.deny(w, line, http.StatusBadGateway, ReasonSecret)
		return
	}
	r.Body, r.ContentLength = io.NopCloser(bytes.NewReader(body)), int64(len(body))
	target := *b.Upstream
	target.Path, target.RawQuery = path.Join("/", b.Upstream.Path, rest), r.URL.RawQuery
	if g.ctx.Err() != nil {
		c.deny(w, line, http.StatusServiceUnavailable, ReasonRevoked)
		return
	}
	meter := &gatewayMeter{c: c, price: price, hold: hold}
	c.relay(w, r.WithContext(meter.watch(r.Context())), route{dest: dest, target: &target, line: line, gen: g, local: b.Local, meter: meter}, scrubber, line)
}

// reserve holds the most the request can cost against its task and the day, waiting while
// requests already running hold the room, and returns the body with the output cap it was
// admitted with in the provider's own field. The cap is the smallest the body names, else the
// model's maximum, lowered to what the room left can pay for; more than one answer is refused.
func (c *Cell) reserve(w http.ResponseWriter, r *http.Request, g *generation, line audit.Line, op keys.Op, price llm.Price, model string, body []byte) (*llm.Hold, []byte, bool) {
	req, err := llm.ReadRequest(op.Body, model, body)
	var many *llm.ChoiceError
	switch {
	case errors.As(err, &many):
		c.refuseField(w, line, ReasonChoiceCount, many.Field)
		return nil, nil, false
	case err != nil:
		c.deny(w, line, http.StatusBadRequest, ReasonBadJSON)
		return nil, nil, false
	}
	capped := op.Cap != "" && price.Output > 0
	ask := llm.Ask{Fixed: price.Ceiling(req.Input, 0), PerToken: price.Output}
	if capped {
		ask.Tokens = price.MaxOutput
		if req.HasCap {
			ask.Tokens = min(req.Cap, price.MaxOutput)
		}
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer context.AfterFunc(g.ctx, cancel)()
	hold, err := c.deps.Budget.Reserve(ctx, c.cfg.CellID, ask)
	switch {
	case err == nil:
	case g.ctx.Err() != nil:
		c.deny(w, line, http.StatusServiceUnavailable, ReasonRevoked)
		return nil, nil, false
	case r.Context().Err() != nil:
		line.Decision, line.Reason = audit.Error, ReasonClientGone
		c.record(line)
		return nil, nil, false
	default:
		c.refuseBudget(w, line, err)
		return nil, nil, false
	}
	if capped {
		if body, err = llm.WithCap(op.Cap, body, hold.Tokens()); err != nil {
			hold.Release()
			c.deny(w, line, http.StatusBadRequest, ReasonBadJSON)
			return nil, nil, false
		}
	}
	return hold, body, true
}

func (c *Cell) gatewayRoute(name string) (keys.Binding, bool) {
	if b, ok := c.deps.Local[name]; ok {
		return b, true
	}
	rec, ok := c.deps.Vault.Record(name)
	if !ok || rec.Kind != vault.KindLLM {
		return keys.Binding{}, false
	}
	b, err := keys.FromRecord(rec)
	return b, err == nil
}

func (c *Cell) refuseBudget(w http.ResponseWriter, line audit.Line, err error) {
	var exceeded *llm.ExceededError
	if !errors.As(err, &exceeded) {
		c.deny(w, line, http.StatusForbidden, ReasonNoTask)
		return
	}
	reason := ReasonBudgetTask
	if exceeded.Scope == "day" {
		reason = ReasonBudgetDay
	}
	line.Decision, line.Reason, line.Status = audit.Deny, reason, http.StatusPaymentRequired
	c.record(line)
	c.announce(*exceeded)
	refusal := map[string]any{"type": "budget_exceeded", "scope": exceeded.Scope, "limitUSD": exceeded.LimitUSD, "spentUSD": exceeded.SpentUSD}
	if exceeded.NeedUSD > 0 {
		refusal["needUSD"] = exceeded.NeedUSD
	}
	w.Header().Set("X-Keyd-Reason", reason)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPaymentRequired)
	json.NewEncoder(w).Encode(map[string]any{"error": refusal})
}

// announce publishes budget.exceeded for a refusal or a crossing alike, so the daemon can stop
// the task and offer to raise its budget.
func (c *Cell) announce(e llm.ExceededError) {
	c.deps.Events.Publish(events.Event{Type: events.TypeBudget, Cell: c.cfg.CellID, Data: events.Budget{
		Scope: e.Scope, TaskID: e.TaskID, LimitUSD: e.LimitUSD, SpentUSD: e.SpentUSD,
	}})
}

// refuseField answers 400 naming the field of the body keyd refuses.
func (c *Cell) refuseField(w http.ResponseWriter, line audit.Line, reason, field string) {
	line.Decision, line.Reason, line.Status, line.Detail = audit.Deny, reason, http.StatusBadRequest, field
	c.record(line)
	w.Header().Set("X-Keyd-Reason", reason)
	http.Error(w, "keyd: "+reason+": "+field, http.StatusBadRequest)
}

// gatewayMeter reads the provider's usage from the relayed body and, when the response ends,
// settles the request's hold with what it cost and releases the rest: the usage the provider
// reported for a complete answer; the hold for a successful answer that reported none, and for a
// request the cell left before the answer's headers once keyd had begun to send it; for a stream
// cut short, the most it can have cost (its full output cap, or the bytes that reached the cell if
// more, beside what it reported), because the provider bills what it generated; for a failed
// answer, only what it reported.
type gatewayMeter struct {
	c     *Cell
	price llm.Price
	hold  *llm.Hold
	m     *llm.Meter
	ok    bool
	sent  atomic.Bool
}

// watch marks the request sent once keyd has written its headers to the provider. That comes
// before the body, so the mark is always set by the time the provider holds the whole request.
func (g *gatewayMeter) watch(ctx context.Context) context.Context {
	return httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteHeaders: func() { g.sent.Store(true) }})
}

func (g *gatewayMeter) start(resp *http.Response) io.Writer {
	g.m = llm.NewMeter(resp.Header.Get("Content-Type"))
	g.ok = resp.StatusCode >= 200 && resp.StatusCode < 300
	return g.m
}

func (g *gatewayMeter) settle(l *audit.Line, out int64, clean bool) {
	if g.m == nil || g.hold == nil {
		return
	}
	u := g.m.Usage()
	switch {
	case !g.ok && !u.Reported:
		return
	case !g.ok, clean && u.Reported:
		l.CostMicroUSD, l.Usage = g.price.Cost(u), "reported"
	case clean:
		l.CostMicroUSD, l.Usage = g.hold.Amount(), "estimated"
	default:
		u.Output = max(u.Output, g.hold.Tokens(), llm.Estimate(0, out).Output)
		l.CostMicroUSD, l.Usage = max(g.hold.Amount(), g.price.Cost(u)), "estimated"
	}
	g.charge(l)
}

// left settles a request the cell left before the answer's headers. Once sent, the provider may
// be generating, and billing, up to its cap, so it costs the hold; before that, nothing.
func (g *gatewayMeter) left(l *audit.Line) {
	if g.hold == nil || !g.sent.Load() {
		return
	}
	l.CostMicroUSD, l.Usage = g.hold.Amount(), "estimated"
	g.charge(l)
}

func (g *gatewayMeter) charge(l *audit.Line) {
	crossed, err := g.hold.Settle(l.CostMicroUSD)
	if err != nil {
		log.Printf("keyd: saving the day's spend failed: %v", err)
	}
	for _, e := range crossed {
		g.c.announce(e)
	}
}

func transportFor(rt route) http.RoundTripper {
	if rt.local {
		return rt.gen.local
	}
	return rt.gen.tr
}

type teeCloser struct {
	io.Reader
	io.Closer
}

// Pinned dials only the listed host:port addresses. The gateway reaches model servers on the
// Mac's loopback through it, which the guard refuses everyone else.
type Pinned map[string]bool

func PinnedFor(routes map[string]keys.Binding) Pinned {
	p := Pinned{}
	for _, b := range routes {
		p[b.Upstream.Host] = true
	}
	return p
}

func (p Pinned) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if !p[address] {
		return nil, &netguard.DeniedError{Target: address, Rule: "not a local model server"}
	}
	var d net.Dialer
	return d.DialContext(ctx, network, address)
}
```

- [ ] **Step 5: Run the tests**

Run: `go test -race ./internal/egress/ ./internal/keys/`
Expected: `ok` for both (59 top-level tests in `egress`; `keys` gains `TestTheFirstClassBearerPresets`).
Without the joined `/`, `TestEachFirstClassBearerProviderHasItsOwnRoute/deepseek` fails: the
request goes out with the relative path `chat/completions`. Against the gateway of the first draft, the parallel tests spent $90 of
a $5 task and $22.50 of a $10 day, and the Stop test's provider received the real key. Against the
gateway of review 1's revision, each shape of `TestNoRequestShapeOvershootsTheBudget` spent past both
limits, the screenshots were refused at once with $0.50 left, a refusal published no event,
`count_tokens` waited for the stream, and the waiting request reached the provider with the new key.
Against review 2's, a prompt list reached the provider, and a cell that left before the answer's
headers was charged nothing.

- [ ] **Step 6: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/egress internal/keys
git commit -m "feat(keyd): LLM gateway, with the first-class bearer providers' presets"
```

---
### Task 15: The cell manager and the kill switch

The manager is what the admin socket drives: open a cell (a role, a port in 4760–4789, the secrets
it gets), list, mint, revoke, close, and begin or end a task. Opening a cell checks every secret's
binding against the role (an LLM secret only for a role with the gateway, an HTTP secret only for
a role with the web, so a brain reaches nothing but the gateway, as the spec's default egress says;
review 1, M11), makes the cell's CA from
the hosts of its HTTP secrets, mints a 32-byte proxy token and one surrogate per secret, starts the
listener, and writes the CA's public PEM to `<home>/keyd/cells/<cell>/ca.pem` for the daemon to copy
into the cell. "Kill switch: on Stop, drop the cell's surrogates and close its upstream
connections": `Revoke` drops the surrogates, ends the cell's task (so the keyless local routes stop
too) and replaces the cell's generation (Task 10's `(*Cell).Revoke`), which cancels every in-flight
upstream request and closes every tunnel; the listener and the CA stay, so the daemon can mint fresh
surrogates and begin a task for the next one (P4a-R20, changed after review 1). Because the listener
stays, Part 4b's Stop also pauses or stops the cell's processes. A surrogate for a host the cell's
CA does not cover needs the cell opened again. Closing a cell takes everything with it.

**Files:**
- Create: `keyd/internal/egress/manager.go`
- Test: `keyd/internal/egress/manager_test.go`

**Interfaces:**
- Consumes: `Open`, `Config`, `Deps`, `(*Cell).Close`, `(*Cell).Revoke` (Tasks 10–14); `cellca.New`;
  `keys.FromRecord`, `(*Registry).Mint`, `ForCell`, `RevokeCell`; `llm.Budget` (`Begin`, `End`, `Task`).
- Produces: `PortRange{Min, Max int}`, `DefaultPorts` (4760–4789); `ManagerDeps{Deps; Ports PortRange; CellsDir string}`;
  `NewManager(ManagerDeps) *Manager`; `OpenRequest{CellID, Role string; Port int; Secrets []string}`
  (JSON `cellId role port secrets`); `Opened{CellID string; Port int; ProxyToken, CACertPEM, CAPath string; Surrogates map[string]string}`
  (JSON `cellId port proxyToken caCertPem caPath surrogates`); `CellInfo{CellID, Role string; Port int; Intercepts []string; Surrogates []SurrogateInfo; Task *llm.TaskInfo}`;
  `SurrogateInfo{SecretID, SurrogateID string}`; `(*Manager).Open`, `Close`, `Revoke (int, error)`,
  `Mint (map[string]string, error)`, `BeginTask(cell, taskID, budgetUSD)`, `EndTask(cell)`,
  `Cell(id) (CellInfo, bool)`, `Cells() []CellInfo`, `CloseAll()`;
  errors `ErrUnknownCell`, `ErrCellExists`, `*RequestError` (a malformed request); admin audit
  lines with reasons `cell-open`, `cell-close`, `cell-revoke`, `cell-mint`, `task-begin`, `task-end`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/egress/manager_test.go`:
```go
package egress

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func newManager(t *testing.T) (*Manager, *world) {
	t.Helper()
	w := newWorld(t)
	dir := t.TempDir()
	settings, _ := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	budget, _ := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	deps := w.deps()
	deps.Budget, deps.Settings = budget, settings
	m := NewManager(ManagerDeps{Deps: deps, Ports: PortRange{}, CellsDir: filepath.Join(dir, "cells")})
	t.Cleanup(m.CloseAll)
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, realValue)
	w.secret(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, realValue)
	return m, w
}

// cellClient talks to an opened cell's listener with its token, trusting its CA and the upstreams'.
func cellClient(w *world, o Opened) *http.Client {
	block, _ := pem.Decode([]byte(o.CACertPEM))
	ca, _ := x509.ParseCertificate(block.Bytes)
	roots := w.roots()
	roots.AddCert(ca)
	proxy := &url.URL{Scheme: "http", User: url.UserPassword("cell", o.ProxyToken), Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(o.Port))}
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(proxy), TLSClientConfig: &tls.Config{RootCAs: roots}, DisableKeepAlives: true},
		Timeout:   10 * time.Second,
	}
}

func rawConnectWith(t *testing.T, o Opened, authority string) (net.Conn, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(o.Port)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	io.WriteString(conn, "CONNECT "+authority+" HTTP/1.1\r\nHost: "+authority+"\r\nProxy-Authorization: Basic "+basicAuth("cell", o.ProxyToken)+"\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn, resp
}

func TestOpenHandsTheCellEverythingItHolds(t *testing.T) {
	m, w := newManager(t)
	o, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(o.ProxyToken) < 43 || o.Port == 0 || !surrogate.Valid(o.Surrogates["weather"]) {
		t.Fatalf("opened %+v", o)
	}
	block, _ := pem.Decode([]byte(o.CACertPEM))
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil || len(ca.PermittedDNSDomains) != 1 || ca.PermittedDNSDomains[0] != "api.example.test" {
		t.Fatalf("CA %v %v", ca, err)
	}
	onDisk, err := os.ReadFile(o.CAPath)
	if err != nil || string(onDisk) != o.CACertPEM || filepath.Base(o.CAPath) != "ca.pem" {
		t.Fatalf("CA file %s: %v", o.CAPath, err)
	}
	resp, err := cellClient(w, o).Get("http://keyd.ldot/health")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("health through the new listener: %v %v", resp, err)
	}
	resp.Body.Close()
	w.waitLine(func(l audit.Line) bool { return l.Kind == audit.KindAdmin && l.Reason == "cell-open" && l.Cell == "c1" })
}

func TestOpenValidates(t *testing.T) {
	m, _ := newManager(t)
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop"}); err != nil {
		t.Fatal(err)
	}
	cases := map[string]OpenRequest{
		"bad id":         {CellID: "../c", Role: "desktop"},
		"unknown role":   {CellID: "c2", Role: "root"},
		"port outside":   {CellID: "c2", Role: "desktop", Port: 4790},
		"unknown secret": {CellID: "c2", Role: "desktop", Secrets: []string{"nope"}},
		"secret twice":   {CellID: "c2", Role: "desktop", Secrets: []string{"weather", "weather"}},
		"llm off brain":  {CellID: "c2", Role: "desktop", Secrets: []string{"anthropic"}},
		"http on brain":  {CellID: "c2", Role: "brain", Secrets: []string{"weather"}},
		"already open":   {CellID: "c1", Role: "desktop"},
	}
	for name, req := range cases {
		if _, err := m.Open(req); err == nil {
			t.Errorf("%s: Open succeeded", name)
		}
	}
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop"}); !errors.Is(err, ErrCellExists) {
		t.Fatalf("reopen: %v", err)
	}
}

func TestCloseRemovesTheListenerSurrogatesAndCA(t *testing.T) {
	m, w := newManager(t)
	o, _ := m.Open(OpenRequest{CellID: "c1", Role: "brain", Secrets: []string{"anthropic"}})
	m.BeginTask("c1", "t1", 0)
	if err := m.Close("c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := cellClient(w, o).Get("http://keyd.ldot/health"); err == nil {
		t.Fatal("the listener still answers")
	}
	if len(w.registry.ForCell("c1")) != 0 {
		t.Fatal("surrogates outlived the cell")
	}
	if _, err := os.Stat(filepath.Dir(o.CAPath)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("CA folder left behind: %v", err)
	}
	if _, ok := m.Cell("c1"); ok {
		t.Fatal("the cell is still listed")
	}
	if err := m.Close("c1"); !errors.Is(err, ErrUnknownCell) {
		t.Fatalf("second Close: %v", err)
	}
}

func TestRevokeIsTheKillSwitch(t *testing.T) {
	m, w := newManager(t)
	streaming := make(chan struct{})
	upstreamDone := make(chan struct{})
	w.plainUpstream("stream.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		io.WriteString(rw, "data: start\n\n")
		rw.(http.Flusher).Flush()
		close(streaming)
		<-r.Context().Done()
		close(upstreamDone)
	}))
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "ok") }))
	o, _ := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	m.BeginTask("c1", "t1", 0)
	client := cellClient(w, o)

	resp, err := client.Get("http://stream.example.test/")
	if err != nil {
		t.Fatal(err)
	}
	<-streaming
	tunnel, connected := rawConnectWith(t, o, "www.example.test:443")
	if connected.StatusCode != 200 {
		t.Fatalf("tunnel: %d", connected.StatusCode)
	}

	n, err := m.Revoke("c1")
	if err != nil || n != 1 {
		t.Fatalf("Revoke = %d, %v", n, err)
	}
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatal("the stream survived the kill switch")
	}
	select {
	case <-upstreamDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the upstream request survived the kill switch")
	}
	tunnel.SetReadDeadline(time.Now().Add(3 * time.Second))
	if n, _ := tunnel.Read(make([]byte, 1)); n != 0 {
		t.Fatal("the tunnel survived the kill switch")
	}
	req, _ := http.NewRequest("GET", "https://api.example.test/", nil)
	req.Header.Set("Authorization", "Bearer "+o.Surrogates["weather"])
	resp2, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 403 || resp2.Header.Get("X-Keyd-Reason") != "unknown-surrogate" {
		t.Fatalf("old surrogate after the kill switch: %d %q", resp2.StatusCode, resp2.Header.Get("X-Keyd-Reason"))
	}
	if resp3, err := client.Get("http://keyd.ldot/health"); err != nil || resp3.StatusCode != 200 {
		t.Fatalf("the listener stopped: %v", err)
	}
	if info, _ := m.Cell("c1"); info.Task != nil {
		t.Fatalf("the task outlived the kill switch: %+v", info.Task)
	}
	fresh, err := m.Mint("c1", []string{"weather"})
	if err != nil || !surrogate.Valid(fresh["weather"]) || fresh["weather"] == o.Surrogates["weather"] {
		t.Fatalf("Mint after revoke: %v %v", fresh, err)
	}
	w.waitLine(func(l audit.Line) bool { return l.Reason == "cell-revoke" && strings.Contains(l.Detail, "1 surrogate") })
}

func TestMintStaysInsideTheCellCA(t *testing.T) {
	m, w := newManager(t)
	w.secret(vault.Record{ID: "maps", Kind: vault.KindHTTP, Hosts: []string{"maps.example.test"}, Header: "X-Api-Key", Format: "raw"}, realValue)
	m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	if _, err := m.Mint("c1", []string{"maps"}); err == nil {
		t.Fatal("minted a surrogate for a host the cell CA cannot vouch for")
	}
	if _, err := m.Mint("nope", []string{"weather"}); !errors.Is(err, ErrUnknownCell) {
		t.Fatalf("unknown cell: %v", err)
	}
}

func TestTasksAndListing(t *testing.T) {
	m, _ := newManager(t)
	m.Open(OpenRequest{CellID: "c1", Role: "brain", Secrets: []string{"anthropic"}})
	if err := m.BeginTask("nope", "t", 0); !errors.Is(err, ErrUnknownCell) {
		t.Fatalf("BeginTask on an unknown cell: %v", err)
	}
	if err := m.BeginTask("c1", "t1", 2.5); err != nil {
		t.Fatal(err)
	}
	info, ok := m.Cell("c1")
	if !ok || info.Role != "brain" || info.Task == nil || info.Task.ID != "t1" || info.Task.LimitUSD != 2.5 || len(info.Surrogates) != 1 || info.Surrogates[0].SecretID != "anthropic" {
		t.Fatalf("info %+v", info)
	}
	if strings.Contains(info.Surrogates[0].SurrogateID, "ld_") {
		t.Fatal("the listing exposes a surrogate")
	}
	m.EndTask("c1")
	if info, _ := m.Cell("c1"); info.Task != nil {
		t.Fatalf("task after EndTask: %+v", info.Task)
	}
	if len(m.Cells()) != 1 {
		t.Fatalf("Cells = %+v", m.Cells())
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/egress/`
Expected: FAIL — `[build failed]`, starting `internal/egress/manager_test.go:26:33: undefined: Manager`.

- [ ] **Step 3: Implement the manager**

`keyd/internal/egress/manager.go`:
```go
package egress

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/cellca"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

var (
	ErrUnknownCell = errors.New("egress: no such cell")
	ErrCellExists  = errors.New("egress: the cell is already open")
	cellIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
)

// RequestError is a request the manager refuses as malformed.
type RequestError struct{ msg string }

func (e *RequestError) Error() string { return e.msg }

func badRequest(format string, args ...any) error {
	return &RequestError{msg: fmt.Sprintf(format, args...)}
}

// PortRange bounds the listener ports the daemon may ask for. The zero range allows only port 0,
// a free port, which tests use.
type PortRange struct{ Min, Max int }

var DefaultPorts = PortRange{Min: 4760, Max: 4789}

type ManagerDeps struct {
	Deps
	Ports PortRange
	// CellsDir holds <cell>/ca.pem, the public half of each cell's CA.
	CellsDir string
}

type OpenRequest struct {
	CellID  string   `json:"cellId"`
	Role    string   `json:"role"`
	Port    int      `json:"port"`
	Secrets []string `json:"secrets"`
}

// Opened is everything a cell holds: its listener, its proxy token, the public half of its CA
// and one surrogate per secret.
type Opened struct {
	CellID     string            `json:"cellId"`
	Port       int               `json:"port"`
	ProxyToken string            `json:"proxyToken"`
	CACertPEM  string            `json:"caCertPem"`
	CAPath     string            `json:"caPath"`
	Surrogates map[string]string `json:"surrogates"`
}

type SurrogateInfo struct {
	SecretID    string `json:"secretId"`
	SurrogateID string `json:"surrogateId"`
}

type CellInfo struct {
	CellID     string          `json:"cellId"`
	Role       string          `json:"role"`
	Port       int             `json:"port"`
	Intercepts []string        `json:"intercepts"`
	Surrogates []SurrogateInfo `json:"surrogates"`
	Task       *llm.TaskInfo   `json:"task,omitempty"`
}

type managed struct {
	cell   *Cell
	policy policy.Policy
	ca     *cellca.CA
	caDir  string
}

// Manager opens, lists, revokes and closes cells.
type Manager struct {
	d     ManagerDeps
	mu    sync.Mutex
	cells map[string]*managed
}

func NewManager(d ManagerDeps) *Manager {
	return &Manager{d: d, cells: map[string]*managed{}}
}

func (m *Manager) Open(req OpenRequest) (Opened, error) {
	if !cellIDPattern.MatchString(req.CellID) {
		return Opened{}, badRequest("cell id %q: want 1-64 of A-Z a-z 0-9 _ - starting with a letter or digit", req.CellID)
	}
	p, err := policy.ForRole(policy.Role(req.Role))
	if err != nil {
		return Opened{}, badRequest("%v", err)
	}
	if req.Port < m.d.Ports.Min || req.Port > m.d.Ports.Max {
		return Opened{}, badRequest("port %d is outside %d-%d", req.Port, m.d.Ports.Min, m.d.Ports.Max)
	}
	bindings, err := m.bindings(p, req.Secrets)
	if err != nil {
		return Opened{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.cells[req.CellID]; ok {
		return Opened{}, ErrCellExists
	}
	var hosts []string
	for _, b := range bindings {
		hosts = append(hosts, b.Hosts...)
	}
	slices.Sort(hosts)
	ca, err := cellca.New(req.CellID, slices.Compact(hosts))
	if err != nil {
		return Opened{}, err
	}
	token, err := newToken()
	if err != nil {
		return Opened{}, err
	}
	cell, err := Open(Config{CellID: req.CellID, Policy: p, Port: req.Port, Token: token, CA: ca}, m.d.Deps)
	if err != nil {
		return Opened{}, err
	}
	mc := &managed{cell: cell, policy: p, ca: ca, caDir: filepath.Join(m.d.CellsDir, req.CellID)}
	caPath := filepath.Join(mc.caDir, "ca.pem")
	surrogates, err := m.mint(mc, bindings)
	if err == nil {
		err = writeCA(mc.caDir, caPath, ca.CertPEM())
	}
	if err != nil {
		m.d.Registry.RevokeCell(req.CellID)
		cell.Close()
		os.RemoveAll(mc.caDir)
		return Opened{}, err
	}
	m.cells[req.CellID] = mc
	m.admin(req.CellID, cell.Port(), "cell-open", fmt.Sprintf("role %s, secrets %s", req.Role, strings.Join(req.Secrets, ",")))
	return Opened{
		CellID: req.CellID, Port: cell.Port(), ProxyToken: token,
		CACertPEM: string(ca.CertPEM()), CAPath: caPath, Surrogates: surrogates,
	}, nil
}

// Close drops the cell's surrogates, task, listener, connections and CA.
func (m *Manager) Close(cellID string) error {
	m.mu.Lock()
	mc, ok := m.cells[cellID]
	delete(m.cells, cellID)
	m.mu.Unlock()
	if !ok {
		return ErrUnknownCell
	}
	m.d.Registry.RevokeCell(cellID)
	m.d.Budget.End(cellID)
	port := mc.cell.Port()
	err := mc.cell.Close()
	os.RemoveAll(mc.caDir)
	m.admin(cellID, port, "cell-close", "")
	return err
}

// Revoke is the kill switch: the cell's surrogates are dropped, its task ends (the keyless local
// routes stop too) and every upstream connection and tunnel it has is closed. Its listener and CA
// stay, so its processes keep their web egress: the daemon's Stop pauses them as well.
func (m *Manager) Revoke(cellID string) (int, error) {
	mc, ok := m.get(cellID)
	if !ok {
		return 0, ErrUnknownCell
	}
	n := m.d.Registry.RevokeCell(cellID)
	m.d.Budget.End(cellID)
	mc.cell.Revoke()
	m.admin(cellID, mc.cell.Port(), "cell-revoke", fmt.Sprintf("%d surrogate(s) dropped, task ended", n))
	return n, nil
}

// Mint gives a running cell new surrogates. A secret bound to a host the cell's CA does not
// cover needs the cell to be opened again.
func (m *Manager) Mint(cellID string, secrets []string) (map[string]string, error) {
	mc, ok := m.get(cellID)
	if !ok {
		return nil, ErrUnknownCell
	}
	bindings, err := m.bindings(mc.policy, secrets)
	if err != nil {
		return nil, err
	}
	covered := mc.ca.Hosts()
	for _, b := range bindings {
		for _, h := range b.Hosts {
			if !slices.Contains(covered, h) {
				return nil, badRequest("secret %s is bound to %s, which this cell's CA does not cover; open the cell again", b.SecretID, h)
			}
		}
	}
	out, err := m.mint(mc, bindings)
	if err == nil {
		m.admin(cellID, mc.cell.Port(), "cell-mint", strings.Join(secrets, ","))
	}
	return out, err
}

func (m *Manager) BeginTask(cellID, taskID string, budgetUSD float64) error {
	mc, ok := m.get(cellID)
	if !ok {
		return ErrUnknownCell
	}
	if taskID == "" || len(taskID) > 128 {
		return badRequest("task id must be 1-128 characters")
	}
	if budgetUSD < 0 {
		return badRequest("budget must not be negative")
	}
	m.d.Budget.Begin(cellID, taskID, budgetUSD)
	m.admin(cellID, mc.cell.Port(), "task-begin", taskID)
	return nil
}

func (m *Manager) EndTask(cellID string) error {
	mc, ok := m.get(cellID)
	if !ok {
		return ErrUnknownCell
	}
	m.d.Budget.End(cellID)
	m.admin(cellID, mc.cell.Port(), "task-end", "")
	return nil
}

func (m *Manager) Cell(cellID string) (CellInfo, bool) {
	mc, ok := m.get(cellID)
	if !ok {
		return CellInfo{}, false
	}
	info := CellInfo{CellID: cellID, Role: string(mc.policy.Role), Port: mc.cell.Port(), Intercepts: mc.ca.Hosts(), Surrogates: []SurrogateInfo{}}
	for _, e := range m.d.Registry.ForCell(cellID) {
		info.Surrogates = append(info.Surrogates, SurrogateInfo{SecretID: e.Binding.SecretID, SurrogateID: e.ID})
	}
	slices.SortFunc(info.Surrogates, func(a, b SurrogateInfo) int { return strings.Compare(a.SecretID, b.SecretID) })
	if t, ok := m.d.Budget.Task(cellID); ok {
		info.Task = &t
	}
	return info, true
}

func (m *Manager) Cells() []CellInfo {
	m.mu.Lock()
	ids := make([]string, 0, len(m.cells))
	for id := range m.cells {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	slices.Sort(ids)
	out := make([]CellInfo, 0, len(ids))
	for _, id := range ids {
		if info, ok := m.Cell(id); ok {
			out = append(out, info)
		}
	}
	return out
}

func (m *Manager) CloseAll() {
	for _, info := range m.Cells() {
		m.Close(info.CellID)
	}
}

func (m *Manager) get(cellID string) (*managed, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mc, ok := m.cells[cellID]
	return mc, ok
}

func (m *Manager) bindings(p policy.Policy, secrets []string) ([]keys.Binding, error) {
	if len(secrets) > 32 {
		return nil, badRequest("at most 32 secrets per cell")
	}
	var out []keys.Binding
	for i, id := range secrets {
		if slices.Contains(secrets[:i], id) {
			return nil, badRequest("secret %s is listed twice", id)
		}
		rec, ok := m.d.Vault.Record(id)
		if !ok {
			return nil, badRequest("no secret %s", id)
		}
		if rec.Kind == vault.KindLLM && !p.Gateway {
			return nil, badRequest("a %s cell cannot use the LLM gateway, so it cannot hold %s", p.Role, id)
		}
		if rec.Kind == vault.KindHTTP && !p.Web {
			return nil, badRequest("a %s cell reaches only the LLM gateway, so it cannot hold %s", p.Role, id)
		}
		b, err := keys.FromRecord(rec)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

func (m *Manager) mint(mc *managed, bindings []keys.Binding) (map[string]string, error) {
	out := map[string]string{}
	for _, b := range bindings {
		e, err := m.d.Registry.Mint(mc.cell.ID(), b)
		if err != nil {
			return nil, err
		}
		out[b.SecretID] = e.Token
	}
	return out, nil
}

func (m *Manager) admin(cellID string, port int, reason, detail string) {
	if _, err := m.d.Audit.Write(audit.Line{Kind: audit.KindAdmin, Cell: cellID, Port: port, Decision: audit.Allow, Reason: reason, Detail: detail}); err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func writeCA(dir, path string, pemBytes []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, pemBytes, 0o644)
}
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/egress/`
Expected: `ok` (64 tests). `TestRevokeIsTheKillSwitch` shows the stream, the upstream request and
the tunnel all ending within three seconds of `Revoke`, the old surrogate refused as unknown, the
task ended, the listener still answering and a fresh surrogate minted.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/egress
git commit -m "feat(keyd): cell manager and kill switch"
```

---
### Task 16: The admin socket and the `keyd` command

"keyd's admin API is a 0600 Unix socket." It is HTTP/1.1 on `<home>/keyd/admin.sock`, created with
a umask that leaves it `0600` inside the `0700` state folder, for the daemon only (P4a-R25): status
(with the boot id, the seal key and whether the audit log is writing), sealed secrets in and out (a
value must be sealed for exactly the record it arrives with; replacing or deleting a secret revokes
its surrogates in every cell, P4a-R4; a failure to store one is logged and answered with a fixed
message, never the error's text, review 1 C1, and a failed delete answers the store's error, which
names the item and never a value), cells, tasks, the budget, each route's models with their prices
and maximum outputs, and an NDJSON event stream. Bodies are strict JSON (unknown fields refused: S4
found iron-proxy silently ignoring a misspelt `requir`). The `keyd` command makes the state folder
private, takes an exclusive `flock` on `<home>/keyd/keyd.lock` (one keyd per home), clears the CA
files a previous process left, wires the parts, prints one ready line to stderr, and on SIGINT,
SIGTERM or SIGHUP closes every cell, records the stop and removes the socket. `keyd verify-audit
[path]` checks the chain. With `-vault memory` nothing secret touches disk or the Keychain
(P4a-R22): that is how tests and Part 4b run it.

**Files:**
- Create: `keyd/internal/admin/admin.go`, `keyd/cmd/keyd/main.go`
- Test: `keyd/internal/admin/admin_test.go`, `keyd/cmd/keyd/main_test.go`

**Interfaces:**
- Consumes: everything above: `egress.Manager` and its types and errors (`ErrUnknownCell`,
  `ErrCellExists`, `ErrPortInUse`, `*RequestError`), `vault.Vault`/`Opener`/`Seal`/`Sealed`,
  `keys.Registry.RevokeSecret`, `keys.FromRecord`, `keys.ValidValueFor`, `keys.LocalRoutes`,
  `llm.Settings`, `llm.Budget`, `audit.Log`, `events.Hub`, `netguard.New`,
  `netguard.InterfacePrefixes`, `netguard.Dialer`, `egress.PinnedFor`.
- Produces: `admin.Server{Manager, Vault, Registry, Opener, Settings, Budget, Audit, Events, BootID, Version}`
  with `Handler() http.Handler`; `admin.Listen(path) (net.Listener, error)`; the endpoints in
  "Interfaces Part 4b builds on"; `cmd/keyd`: flags `-home`, `-vault keychain|memory`,
  `-ports MIN-MAX`, the subcommand `verify-audit`; in-package `Config{Home, Vault string; Ports egress.PortRange}`,
  `start(Config) (*Daemon, error)`, `(*Daemon).Close()`, `run(args, stderr) int`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/admin/admin_test.go`:
```go
package admin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const fakeKey = "real-secret-value-for-test"

type fixture struct {
	srv      *httptest.Server
	s        *Server
	registry *keys.Registry
	auditLog string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	v, _ := vault.Open(vault.NewMemory(), filepath.Join(dir, "secrets.json"))
	log, _ := audit.Open(filepath.Join(dir, "audit.jsonl"))
	t.Cleanup(func() { log.Close() })
	settings, _ := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	budget, _ := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	opener, _ := vault.NewOpener()
	hub := events.NewHub()
	registry := keys.NewRegistry()
	guard := netguard.New(netguard.InterfacePrefixes)
	m := egress.NewManager(egress.ManagerDeps{
		Deps: egress.Deps{
			Registry: registry, Vault: v, Audit: log, Events: hub,
			Dialer: &netguard.Dialer{Guard: guard, Resolver: &noResolver{}}, Budget: budget, Settings: settings,
		},
		CellsDir: filepath.Join(dir, "cells"),
	})
	t.Cleanup(m.CloseAll)
	s := &Server{Manager: m, Vault: v, Registry: registry, Opener: opener, Settings: settings, Budget: budget, Audit: log, Events: hub, BootID: "boot-1", Version: "test"}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &fixture{srv: srv, s: s, registry: registry, auditLog: filepath.Join(dir, "audit.jsonl")}
}

type noResolver struct{}

func (noResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return nil, errors.New("no DNS in these tests")
}

func (f *fixture) call(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, f.srv.URL+path, r)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// record is the vault record a PUT of fields would make, which the value is sealed for.
func record(id string, fields map[string]any) vault.Record {
	raw, _ := json.Marshal(fields)
	var rec vault.Record
	json.Unmarshal(raw, &rec)
	rec.ID = id
	return rec
}

func (f *fixture) sealedPut(t *testing.T, id string, fields map[string]any, value string) (int, map[string]any) {
	t.Helper()
	sealed, err := vault.Seal(f.s.Opener.PublicKey(), record(id, fields), []byte(value))
	if err != nil {
		t.Fatal(err)
	}
	fields["sealed"] = sealed
	return f.call(t, "PUT", "/v1/secrets/"+id, fields)
}

func weather() map[string]any {
	return map[string]any{"kind": "http", "hosts": []string{"api.example.test"}, "header": "Authorization", "format": "bearer"}
}

func TestStatus(t *testing.T) {
	f := newFixture(t)
	code, body := f.call(t, "GET", "/v1/status", nil)
	if code != 200 || body["bootId"] != "boot-1" || body["sealKey"] != f.s.Opener.PublicKey() || body["version"] != "test" {
		t.Fatalf("%d %v", code, body)
	}
	if state, _ := body["audit"].(map[string]any); state["ok"] != true {
		t.Fatalf("audit %v", body["audit"])
	}
	f.s.Audit.Close()
	f.s.Audit.Write(audit.Line{Kind: audit.KindKeyd, Decision: audit.Allow})
	if _, body := f.call(t, "GET", "/v1/status", nil); body["audit"].(map[string]any)["ok"] != false {
		t.Fatalf("audit after a failed write %v", body["audit"])
	}
}

func TestSecretsArriveSealedAndNeverLeave(t *testing.T) {
	f := newFixture(t)
	code, body := f.sealedPut(t, "weather", weather(), fakeKey)
	if code != 200 || body["id"] != "weather" || body["hosts"] == nil {
		t.Fatalf("put: %d %v", code, body)
	}
	if got, _ := f.s.Vault.Value("weather"); string(got) != fakeKey {
		t.Fatalf("vault holds %q", got)
	}
	resp, _ := http.Get(f.srv.URL + "/v1/secrets")
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(raw), `"weather"`) || strings.Contains(string(raw), fakeKey) {
		t.Fatalf("listing: %s", raw)
	}
	logged, _ := os.ReadFile(f.auditLog)
	if !strings.Contains(string(logged), `"reason":"secret-put"`) || strings.Contains(string(logged), fakeKey) {
		t.Fatalf("audit: %s", logged)
	}
}

func TestSecretPutRefusals(t *testing.T) {
	f := newFixture(t)
	wrongID, _ := vault.Seal(f.s.Opener.PublicKey(), record("other", weather()), []byte(fakeKey))
	evil := weather()
	evil["hosts"] = []string{"evil.example.test"}
	otherHosts, _ := vault.Seal(f.s.Opener.PublicKey(), record("weather", evil), []byte(fakeKey))
	cases := map[string]struct {
		id     string
		fields map[string]any
	}{
		"sealed for another id":   {"weather", map[string]any{"kind": "http", "hosts": []string{"api.example.test"}, "header": "Authorization", "format": "bearer", "sealed": wrongID}},
		"sealed for another host": {"weather", map[string]any{"kind": "http", "hosts": []string{"api.example.test"}, "header": "Authorization", "format": "bearer", "sealed": otherHosts}},
		"bad binding":             {"weather", map[string]any{"kind": "http", "hosts": []string{"localhost"}, "header": "Authorization", "format": "bearer"}},
		"unknown field":           {"weather", map[string]any{"kind": "http", "hosts": []string{"api.example.test"}, "header": "Authorization", "format": "bearer", "requir": true}},
		"bad id":                  {"Weather", weather()},
		"short value":             {"weather", weather()},
	}
	for name, c := range cases {
		value := fakeKey
		if name == "short value" {
			value = "short"
		}
		var code int
		if _, sealed := c.fields["sealed"]; sealed {
			code, _ = f.call(t, "PUT", "/v1/secrets/"+c.id, c.fields)
		} else {
			code, _ = f.sealedPut(t, c.id, c.fields, value)
		}
		if code != 400 {
			t.Errorf("%s: %d, want 400", name, code)
		}
	}
	if len(f.s.Vault.Records()) != 0 {
		t.Fatal("a refused put stored a secret")
	}
}

func TestReplacingOrDeletingASecretRevokesItsSurrogates(t *testing.T) {
	f := newFixture(t)
	f.sealedPut(t, "weather", weather(), fakeKey)
	code, opened := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "c1", "role": "desktop", "secrets": []string{"weather"}})
	if code != 201 {
		t.Fatalf("open: %d %v", code, opened)
	}
	tok := opened["surrogates"].(map[string]any)["weather"].(string)
	f.sealedPut(t, "weather", weather(), "rotated-secret-value-for-test")
	if _, ok := f.registry.Lookup(tok); ok {
		t.Fatal("a surrogate survived its secret being replaced")
	}
	code, minted := f.call(t, "POST", "/v1/cells/c1/surrogates", map[string]any{"secrets": []string{"weather"}})
	if code != 200 {
		t.Fatalf("mint: %d %v", code, minted)
	}
	if code, _ := f.call(t, "DELETE", "/v1/secrets/weather", nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if len(f.registry.ForCell("c1")) != 0 {
		t.Fatal("surrogates survived their secret being deleted")
	}
	if code, _ := f.call(t, "DELETE", "/v1/secrets/weather", nil); code != 404 {
		t.Fatalf("second delete: %d", code)
	}
}

func TestCellLifecycle(t *testing.T) {
	f := newFixture(t)
	f.sealedPut(t, "weather", weather(), fakeKey)
	code, opened := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "c1", "role": "desktop", "secrets": []string{"weather"}})
	if code != 201 || opened["proxyToken"] == "" || !strings.Contains(opened["caCertPem"].(string), "BEGIN CERTIFICATE") {
		t.Fatalf("open: %d %v", code, opened)
	}
	if code, _ := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "c1", "role": "desktop"}); code != 409 {
		t.Fatalf("reopen: %d", code)
	}
	if code, _ := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "c2", "role": "root"}); code != 400 {
		t.Fatalf("bad role: %d", code)
	}
	if code, _ := f.call(t, "PUT", "/v1/cells/c1/task", map[string]any{"taskId": "t1", "budgetUSD": 2}); code != 204 {
		t.Fatalf("task: %d", code)
	}
	code, info := f.call(t, "GET", "/v1/cells/c1", nil)
	if code != 200 || info["task"].(map[string]any)["limitUSD"] != 2.0 || info["role"] != "desktop" {
		t.Fatalf("get: %d %v", code, info)
	}
	if code, body := f.call(t, "POST", "/v1/cells/c1/revoke", nil); code != 200 || body["revoked"] != 1.0 {
		t.Fatalf("revoke: %d %v", code, body)
	}
	if code, _ := f.call(t, "DELETE", "/v1/cells/c1/task", nil); code != 204 {
		t.Fatalf("end task: %d", code)
	}
	if code, _ := f.call(t, "DELETE", "/v1/cells/c1", nil); code != 204 {
		t.Fatalf("close: %d", code)
	}
	for _, path := range []string{"/v1/cells/c1"} {
		if code, _ := f.call(t, "GET", path, nil); code != 404 {
			t.Fatalf("%s after close: %d", path, code)
		}
	}
	if code, _ := f.call(t, "POST", "/v1/cells/c1/revoke", nil); code != 404 {
		t.Fatalf("revoke after close: %d", code)
	}
}

func TestBudgetAndModels(t *testing.T) {
	f := newFixture(t)
	code, body := f.call(t, "GET", "/v1/budget", nil)
	if code != 200 || body["perTaskUSD"] != 5.0 || body["perDayUSD"] != 20.0 {
		t.Fatalf("budget: %d %v", code, body)
	}
	if code, _ := f.call(t, "PUT", "/v1/budget", map[string]any{"perTaskUSD": 50, "perDayUSD": 20}); code != 400 {
		t.Fatalf("task over day: %d", code)
	}
	if code, _ := f.call(t, "PUT", "/v1/budget", map[string]any{"perTaskUSD": 2, "perDayUSD": 10}); code != 200 {
		t.Fatalf("set budget: %d", code)
	}
	models := []map[string]any{{"id": "claude-sonnet-5-5", "inputUSDPerMTok": 3, "outputUSDPerMTok": 15}}
	if code, _ := f.call(t, "PUT", "/v1/llm/routes/anthropic/models", map[string]any{"models": models}); code != 400 {
		t.Fatalf("a priced model without its maximum output: %d", code)
	}
	models[0]["maxOutputTokens"] = 64000
	if code, _ := f.call(t, "PUT", "/v1/llm/routes/anthropic/models", map[string]any{"models": models}); code != 200 {
		t.Fatalf("set models: %d", code)
	}
	code, body = f.call(t, "GET", "/v1/llm/routes/anthropic/models", nil)
	if code != 200 || len(body["models"].([]any)) != 1 || body["models"].([]any)[0].(map[string]any)["maxOutputTokens"] != 64000.0 {
		t.Fatalf("models: %d %v", code, body)
	}
	if code, _ := f.call(t, "PUT", "/v1/llm/routes/Bad Route/models", map[string]any{"models": models}); code != 400 && code != 404 {
		t.Fatalf("bad route: %d", code)
	}
}

func TestEventsStreamAsJSONLines(t *testing.T) {
	f := newFixture(t)
	resp, err := http.Get(f.srv.URL + "/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		f.s.Events.Publish(events.Event{Type: events.TypeKeyUse, Cell: "c1", Data: events.KeyUse{SecretID: "anthropic", Host: "api.anthropic.com", Method: "POST", Path: "/v1/messages", Decision: "allow"}})
	}()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var e struct {
		Type string `json:"type"`
		Cell string `json:"cell"`
		Data struct {
			SecretID string `json:"secretId"`
			Decision string `json:"decision"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(line), &e); err != nil || e.Type != "key.use" || e.Cell != "c1" || e.Data.SecretID != "anthropic" {
		t.Fatalf("event line %q: %v", line, err)
	}
}
```

`keyd/cmd/keyd/main_test.go`:
```go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// shortHome keeps the admin socket path under the 104-byte limit macOS puts on Unix sockets.
func shortHome(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "keyd-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func socketClient(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}}}
}

func adminCall(t *testing.T, c *http.Client, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, "http://keyd"+path, r)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestStartServesTheAdminSocketAndCleansUp(t *testing.T) {
	home := shortHome(t)
	d, err := start(Config{Home: home, Vault: "memory", Ports: egress.PortRange{}})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "keyd")
	for path, want := range map[string]os.FileMode{dir: 0o700, d.Socket: 0o600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s: %v %v, want %v", path, info.Mode().Perm(), err, want)
		}
	}
	if _, err := start(Config{Home: home, Vault: "memory"}); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("a second keyd on the same home: %v", err)
	}

	admin := socketClient(d.Socket)
	code, status := adminCall(t, admin, "GET", "/v1/status", nil)
	if code != 200 || status["bootId"] != d.BootID {
		t.Fatalf("status: %d %v", code, status)
	}
	sealed, _ := vault.Seal(status["sealKey"].(string), vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, []byte("real-secret-value-for-test"))
	if code, body := adminCall(t, admin, "PUT", "/v1/secrets/anthropic", map[string]any{"kind": "llm", "provider": "anthropic", "sealed": sealed}); code != 200 {
		t.Fatalf("put: %d %v", code, body)
	}
	code, opened := adminCall(t, admin, "POST", "/v1/cells", map[string]any{"cellId": "c1", "role": "brain", "secrets": []string{"anthropic"}})
	if code != 201 {
		t.Fatalf("open: %d %v", code, opened)
	}
	port := int(opened["port"].(float64))
	proxy := &url.URL{Scheme: "http", User: url.UserPassword("cell", opened["proxyToken"].(string)), Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))}
	cell := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxy)}}
	resp, err := cell.Get("http://keyd.ldot/health")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("health: %v %v", resp, err)
	}
	resp.Body.Close()

	d.Close()
	if _, err := os.Stat(d.Socket); !os.IsNotExist(err) {
		t.Fatalf("socket left behind: %v", err)
	}
	if _, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port))); err == nil {
		t.Fatal("the cell listener outlived keyd")
	}
	f, _ := os.Open(filepath.Join(dir, "audit.jsonl"))
	defer f.Close()
	n, err := audit.Verify(f)
	if err != nil || n < 4 {
		t.Fatalf("audit chain: %d lines, %v", n, err)
	}
	again, err := start(Config{Home: home, Vault: "memory"})
	if err != nil {
		t.Fatalf("restart after a clean stop: %v", err)
	}
	if again.BootID == d.BootID {
		t.Fatal("a restart kept the boot id")
	}
	again.Close()
}

func TestVerifyAuditCommand(t *testing.T) {
	home := shortHome(t)
	d, err := start(Config{Home: home, Vault: "memory"})
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	path := filepath.Join(home, "keyd", "audit.jsonl")
	var out bytes.Buffer
	if code := run([]string{"verify-audit", path}, &out); code != 0 || !strings.Contains(out.String(), "audit ok") {
		t.Fatalf("verify: %d %s", code, out.String())
	}
	data, _ := os.ReadFile(path)
	os.WriteFile(path, bytes.Replace(data, []byte(`"reason":"start"`), []byte(`"reason":"stArt"`), 1), 0o600)
	out.Reset()
	if code := run([]string{"verify-audit", path}, &out); code != 1 {
		t.Fatalf("a tampered log verified: %d %s", code, out.String())
	}
}

func TestBadFlagsExitWithUsage(t *testing.T) {
	var out bytes.Buffer
	for _, args := range [][]string{{"-ports", "4789-4760"}, {"-vault", "plaintext"}, {"-nope"}} {
		out.Reset()
		if code := run(args, &out); code != 2 {
			t.Errorf("%v: exit %d, want 2", args, code)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/admin/ ./cmd/keyd/`
Expected: FAIL — both `[build failed]`: `undefined: Server` in admin, `undefined: start` and
`undefined: Config` in cmd/keyd.

- [ ] **Step 3: Implement the admin API**

`keyd/internal/admin/admin.go`:
```go
// Package admin is keyd's control API: HTTP on a 0600 Unix socket, for the localDot daemon only.
// Secrets arrive sealed to keyd's per-boot key, so the daemon relays them without reading them.
package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"syscall"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const maxBody = 1 << 20

var routeName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

type Server struct {
	Manager  *egress.Manager
	Vault    *vault.Vault
	Registry *keys.Registry
	Opener   *vault.Opener
	Settings *llm.Settings
	Budget   *llm.Budget
	Audit    *audit.Log
	Events   *events.Hub
	BootID   string
	Version  string
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", s.status)
	mux.HandleFunc("GET /v1/secrets", s.listSecrets)
	mux.HandleFunc("PUT /v1/secrets/{id}", s.putSecret)
	mux.HandleFunc("DELETE /v1/secrets/{id}", s.deleteSecret)
	mux.HandleFunc("GET /v1/cells", s.listCells)
	mux.HandleFunc("POST /v1/cells", s.openCell)
	mux.HandleFunc("GET /v1/cells/{id}", s.getCell)
	mux.HandleFunc("DELETE /v1/cells/{id}", s.closeCell)
	mux.HandleFunc("POST /v1/cells/{id}/revoke", s.revoke)
	mux.HandleFunc("POST /v1/cells/{id}/surrogates", s.mint)
	mux.HandleFunc("PUT /v1/cells/{id}/task", s.beginTask)
	mux.HandleFunc("DELETE /v1/cells/{id}/task", s.endTask)
	mux.HandleFunc("GET /v1/budget", s.getBudget)
	mux.HandleFunc("PUT /v1/budget", s.setBudget)
	mux.HandleFunc("GET /v1/llm/routes/{route}/models", s.getModels)
	mux.HandleFunc("PUT /v1/llm/routes/{route}/models", s.setModels)
	mux.HandleFunc("GET /v1/events", s.events)
	return mux
}

// Listen opens the admin socket readable and writable by this user only, replacing a stale one.
// The caller holds keyd's lock, so no other keyd is using it.
func Listen(path string) (net.Listener, error) {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	old := syscall.Umask(0o177)
	ln, err := net.Listen("unix", path)
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func (s *Server) status(w http.ResponseWriter, _ *http.Request) {
	date, spent := s.Budget.Day()
	auditState := map[string]any{"ok": true}
	if err := s.Audit.Err(); err != nil {
		auditState = map[string]any{"ok": false, "error": err.Error()}
	}
	reply(w, http.StatusOK, map[string]any{
		"bootId":  s.BootID,
		"version": s.Version,
		"sealKey": s.Opener.PublicKey(),
		"cells":   len(s.Manager.Cells()),
		"secrets": len(s.Vault.Records()),
		"limits":  s.Settings.Limits(),
		"day":     map[string]any{"date": date, "spentUSD": spent},
		"audit":   auditState,
	})
}

func (s *Server) listSecrets(w http.ResponseWriter, _ *http.Request) {
	reply(w, http.StatusOK, map[string]any{"secrets": s.Vault.Records()})
}

type putSecretBody struct {
	Kind     vault.Kind   `json:"kind"`
	Provider string       `json:"provider,omitempty"`
	BaseURL  string       `json:"baseURL,omitempty"`
	Hosts    []string     `json:"hosts,omitempty"`
	Header   string       `json:"header,omitempty"`
	Format   string       `json:"format,omitempty"`
	Methods  []string     `json:"methods,omitempty"`
	Paths    []string     `json:"paths,omitempty"`
	Sealed   vault.Sealed `json:"sealed"`
}

// putSecret stores a secret sealed for exactly this record, binding included. Replacing a secret
// revokes the surrogates minted for it. A vault failure is logged, never returned: the error text
// is not the daemon's to see.
func (s *Server) putSecret(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body putSecretBody
	if !decode(w, r, &body) {
		return
	}
	rec := vault.Record{ID: id, Kind: body.Kind, Provider: body.Provider, BaseURL: body.BaseURL, Hosts: body.Hosts,
		Header: body.Header, Format: body.Format, Methods: body.Methods, Paths: body.Paths}
	if !vault.ValidID(id) {
		fail(w, http.StatusBadRequest, "bad-request", fmt.Sprintf("secret id %q is not allowed", id))
		return
	}
	b, err := keys.FromRecord(rec)
	if err != nil {
		fail(w, http.StatusBadRequest, "bad-binding", err.Error())
		return
	}
	value, err := s.Opener.Open(body.Sealed, rec)
	if err != nil {
		fail(w, http.StatusBadRequest, "bad-seal", err.Error())
		return
	}
	if err := keys.ValidValueFor(b, value); err != nil {
		fail(w, http.StatusBadRequest, "bad-value", err.Error())
		return
	}
	if err := s.Vault.Put(rec, value); err != nil {
		log.Printf("keyd: storing secret %s failed: %v", id, err)
		fail(w, http.StatusInternalServerError, "vault", "the secret could not be stored")
		return
	}
	revoked := s.Registry.RevokeSecret(id)
	s.admin("secret-put", id, fmt.Sprintf("%d surrogate(s) revoked", revoked))
	stored, _ := s.Vault.Record(id)
	reply(w, http.StatusOK, stored)
}

func (s *Server) deleteSecret(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.Vault.Delete(id); err != nil {
		if errors.Is(err, vault.ErrNotFound) {
			fail(w, http.StatusNotFound, "not-found", "no such secret")
			return
		}
		fail(w, http.StatusInternalServerError, "vault", err.Error())
		return
	}
	revoked := s.Registry.RevokeSecret(id)
	s.admin("secret-delete", id, fmt.Sprintf("%d surrogate(s) revoked", revoked))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listCells(w http.ResponseWriter, _ *http.Request) {
	reply(w, http.StatusOK, map[string]any{"cells": s.Manager.Cells()})
}

func (s *Server) openCell(w http.ResponseWriter, r *http.Request) {
	var req egress.OpenRequest
	if !decode(w, r, &req) {
		return
	}
	opened, err := s.Manager.Open(req)
	if err != nil {
		managerFailure(w, err)
		return
	}
	reply(w, http.StatusCreated, opened)
}

func (s *Server) getCell(w http.ResponseWriter, r *http.Request) {
	info, ok := s.Manager.Cell(r.PathValue("id"))
	if !ok {
		managerFailure(w, egress.ErrUnknownCell)
		return
	}
	reply(w, http.StatusOK, info)
}

func (s *Server) closeCell(w http.ResponseWriter, r *http.Request) {
	if err := s.Manager.Close(r.PathValue("id")); err != nil {
		managerFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) revoke(w http.ResponseWriter, r *http.Request) {
	n, err := s.Manager.Revoke(r.PathValue("id"))
	if err != nil {
		managerFailure(w, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"revoked": n})
}

func (s *Server) mint(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Secrets []string `json:"secrets"`
	}
	if !decode(w, r, &body) {
		return
	}
	out, err := s.Manager.Mint(r.PathValue("id"), body.Secrets)
	if err != nil {
		managerFailure(w, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"surrogates": out})
}

func (s *Server) beginTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskID    string  `json:"taskId"`
		BudgetUSD float64 `json:"budgetUSD"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.Manager.BeginTask(r.PathValue("id"), body.TaskID, body.BudgetUSD); err != nil {
		managerFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) endTask(w http.ResponseWriter, r *http.Request) {
	if err := s.Manager.EndTask(r.PathValue("id")); err != nil {
		managerFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getBudget(w http.ResponseWriter, _ *http.Request) {
	l := s.Settings.Limits()
	date, spent := s.Budget.Day()
	reply(w, http.StatusOK, map[string]any{"perTaskUSD": l.PerTaskUSD, "perDayUSD": l.PerDayUSD, "day": map[string]any{"date": date, "spentUSD": spent}})
}

func (s *Server) setBudget(w http.ResponseWriter, r *http.Request) {
	var l llm.Limits
	if !decode(w, r, &l) {
		return
	}
	if err := s.Settings.SetLimits(l); err != nil {
		fail(w, http.StatusBadRequest, "bad-request", err.Error())
		return
	}
	s.admin("budget-set", "", fmt.Sprintf("$%.2f per task, $%.2f per day", l.PerTaskUSD, l.PerDayUSD))
	s.getBudget(w, r)
}

func (s *Server) getModels(w http.ResponseWriter, r *http.Request) {
	route := r.PathValue("route")
	reply(w, http.StatusOK, map[string]any{"route": route, "models": s.Settings.Models(route)})
}

func (s *Server) setModels(w http.ResponseWriter, r *http.Request) {
	route := r.PathValue("route")
	if !routeName.MatchString(route) {
		fail(w, http.StatusBadRequest, "bad-request", "route names are lowercase ids")
		return
	}
	var body struct {
		Models []llm.Price `json:"models"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.Settings.SetModels(route, body.Models); err != nil {
		fail(w, http.StatusBadRequest, "bad-request", err.Error())
		return
	}
	s.admin("models-set", route, fmt.Sprintf("%d model(s)", len(body.Models)))
	s.getModels(w, r)
}

// events streams every event as one JSON line until the client goes away.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	ch, cancel := s.Events.Subscribe(256)
	defer cancel()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	flush := http.NewResponseController(w).Flush
	flush()
	enc := json.NewEncoder(w)
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok || enc.Encode(e) != nil || flush() != nil {
				return
			}
		}
	}
}

func (s *Server) admin(reason, secretID, detail string) {
	if _, err := s.Audit.Write(audit.Line{Kind: audit.KindAdmin, Decision: audit.Allow, Reason: reason, SecretID: secretID, Detail: detail}); err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		fail(w, http.StatusBadRequest, "bad-request", err.Error())
		return false
	}
	return true
}

func managerFailure(w http.ResponseWriter, err error) {
	var bad *egress.RequestError
	switch {
	case errors.Is(err, egress.ErrUnknownCell):
		fail(w, http.StatusNotFound, "not-found", err.Error())
	case errors.Is(err, egress.ErrCellExists), errors.Is(err, egress.ErrPortInUse):
		fail(w, http.StatusConflict, "conflict", err.Error())
	case errors.As(err, &bad):
		fail(w, http.StatusBadRequest, "bad-request", err.Error())
	default:
		fail(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, message string) {
	reply(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
```

- [ ] **Step 4: Implement the command**

`keyd/cmd/keyd/main.go`:
```go
// Command keyd is localDot's key layer: the only process that holds real secrets. It runs as a
// LaunchAgent, keeps its state in <home>/keyd, and answers the daemon on <home>/keyd/admin.sock.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/admin"
	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const (
	version         = "0.1.0"
	keychainService = "localdot-keyd"
)

type Config struct {
	Home  string
	Vault string
	Ports egress.PortRange
}

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

func run(args []string, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "verify-audit" {
		return verifyAudit(args[1:], stderr)
	}
	fs := flag.NewFlagSet("keyd", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := fs.String("home", defaultHome(), "localDot home; keyd keeps its state in <home>/keyd")
	store := fs.String("vault", "keychain", "where secret values live: keychain, or memory for tests")
	ports := fs.String("ports", "4760-4789", "the listener ports the daemon may ask for")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	portRange, err := parsePorts(*ports)
	if err != nil || (*store != "keychain" && *store != "memory") {
		fmt.Fprintln(stderr, "keyd: -ports wants MIN-MAX and -vault wants keychain or memory")
		return 2
	}
	d, err := start(Config{Home: *home, Vault: *store, Ports: portRange})
	if err != nil {
		fmt.Fprintf(stderr, "keyd: %v\n", err)
		return 1
	}
	fmt.Fprintf(stderr, "keyd ready socket=%s boot=%s\n", d.Socket, d.BootID)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	<-ctx.Done()
	d.Close()
	return 0
}

type Daemon struct {
	BootID  string
	Socket  string
	lock    *os.File
	log     *audit.Log
	manager *egress.Manager
	server  *http.Server
}

func start(cfg Config) (*Daemon, error) {
	dir := filepath.Join(cfg.Home, "keyd")
	if err := privateDir(dir); err != nil {
		return nil, err
	}
	lock, err := lockDir(dir)
	if err != nil {
		return nil, err
	}
	d := &Daemon{BootID: bootID(), Socket: filepath.Join(dir, "admin.sock"), lock: lock}
	if err := d.init(dir, cfg); err != nil {
		d.Close()
		return nil, err
	}
	return d, nil
}

func (d *Daemon) init(dir string, cfg Config) error {
	var err error
	if d.log, err = audit.Open(filepath.Join(dir, "audit.jsonl")); err != nil {
		return err
	}
	var store vault.Store = vault.NewKeychain(keychainService)
	index := filepath.Join(dir, "secrets.json")
	if cfg.Vault == "memory" {
		store, index = vault.NewMemory(), ""
	}
	v, err := vault.Open(store, index)
	if err != nil {
		return err
	}
	opener, err := vault.NewOpener()
	if err != nil {
		return err
	}
	settings, err := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	if err != nil {
		return err
	}
	budget, err := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	if err != nil {
		return err
	}
	// CA files left by an earlier process name CAs that died with it.
	cells := filepath.Join(dir, "cells")
	if err := os.RemoveAll(cells); err != nil {
		return err
	}
	hub := events.NewHub()
	registry := keys.NewRegistry()
	local := keys.LocalRoutes()
	guard := netguard.New(netguard.InterfacePrefixes)
	d.manager = egress.NewManager(egress.ManagerDeps{
		Deps: egress.Deps{
			Registry: registry, Vault: v, Audit: d.log, Events: hub,
			Dialer: &netguard.Dialer{Guard: guard, Resolver: net.DefaultResolver},
			Budget: budget, Settings: settings, Local: local, LocalDialer: egress.PinnedFor(local),
		},
		Ports:    cfg.Ports,
		CellsDir: cells,
	})
	ln, err := admin.Listen(d.Socket)
	if err != nil {
		return err
	}
	api := &admin.Server{Manager: d.manager, Vault: v, Registry: registry, Opener: opener, Settings: settings,
		Budget: budget, Audit: d.log, Events: hub, BootID: d.BootID, Version: version}
	d.server = &http.Server{Handler: api.Handler(), ReadHeaderTimeout: 10 * time.Second, ErrorLog: log.New(io.Discard, "", 0)}
	go d.server.Serve(ln)
	_, err = d.log.Write(audit.Line{Kind: audit.KindKeyd, Decision: audit.Allow, Reason: "start", Detail: "boot " + d.BootID + ", version " + version})
	return err
}

// Close stops serving, closes every cell, records the stop and releases the lock.
func (d *Daemon) Close() {
	if d.server != nil {
		d.server.Close()
	}
	if d.manager != nil {
		d.manager.CloseAll()
	}
	if d.log != nil {
		d.log.Write(audit.Line{Kind: audit.KindKeyd, Decision: audit.Allow, Reason: "stop", Detail: "boot " + d.BootID})
		d.log.Close()
	}
	os.Remove(d.Socket)
	d.lock.Close()
}

// privateDir makes dir if needed and insists that it is this user's and closed to others.
func privateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return fmt.Errorf("%s belongs to another user", dir)
	}
	return os.Chmod(dir, 0o700)
}

// lockDir holds an exclusive flock on <dir>/keyd.lock for the life of the process.
func lockDir(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, "keyd.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("keyd is already running for %s", filepath.Dir(dir))
		}
		return nil, err
	}
	if err := f.Truncate(0); err != nil {
		f.Close()
		return nil, err
	}
	fmt.Fprintf(f, "%d\n", os.Getpid())
	return f, nil
}

func verifyAudit(args []string, out io.Writer) int {
	path := filepath.Join(defaultHome(), "keyd", "audit.jsonl")
	if len(args) > 0 {
		path = args[0]
	}
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(out, "keyd: %v\n", err)
		return 1
	}
	defer f.Close()
	n, err := audit.Verify(f)
	if err != nil {
		fmt.Fprintf(out, "keyd: audit broken after %d intact lines: %v\n", n, err)
		return 1
	}
	fmt.Fprintf(out, "audit ok: %d lines\n", n)
	return 0
}

func defaultHome() string {
	if h := os.Getenv("LOCALDOT_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".localdot")
}

func parsePorts(s string) (egress.PortRange, error) {
	loText, hiText, ok := strings.Cut(s, "-")
	lo, err1 := strconv.Atoi(loText)
	hi, err2 := strconv.Atoi(hiText)
	if !ok || err1 != nil || err2 != nil || lo < 1 || hi > 65535 || lo > hi {
		return egress.PortRange{}, fmt.Errorf("bad port range %q", s)
	}
	return egress.PortRange{Min: lo, Max: hi}, nil
}

func bootID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
```

- [ ] **Step 5: Run the tests**

Run: `go test -race ./internal/admin/ ./cmd/keyd/`
Expected: `ok` for both (7 and 3 tests).

- [ ] **Step 6: Run the binary once by hand**

```bash
go build -o bin/keyd ./cmd/keyd
H=$(mktemp -d /tmp/kdh-XXXXXX)
bin/keyd -home "$H" -vault memory -ports 4790-4799 2> "$H/stderr.log" & pid=$!
sleep 1 && cat "$H/stderr.log"
curl -s --unix-socket "$H/keyd/admin.sock" http://keyd/v1/status; echo
curl -s --unix-socket "$H/keyd/admin.sock" -X POST -d '{"cellId":"c1","role":"brain","port":4795}' http://keyd/v1/cells | head -c 120; echo
ls -l "$H/keyd" "$H/keyd/cells/c1"
kill $pid; sleep 0.5; bin/keyd verify-audit "$H/keyd/audit.jsonl"; rm -rf "$H"
```
Expected: `keyd ready socket=/tmp/kdh-…/keyd/admin.sock boot=<16 hex>`; a status object with
`"limits":{"perTaskUSD":5,"perDayUSD":20}` and a `sealKey`; an `Opened` object starting
`{"cellId":"c1","port":4795,"proxyToken":"…`; `admin.sock` as `srw-------`, `audit.jsonl` and
`keyd.lock` as `-rw-------`, `cells/c1/ca.pem` as `-rw-r--r--`; after the kill,
`audit ok: 4 lines` (start, cell-open, cell-close, stop).

- [ ] **Step 7: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/admin cmd
git commit -m "feat(keyd): admin API on a Unix socket and the keyd command"
```

---
### Task 17: S4's probes in process, the full suite and the README

S4's `run.sh` probed iron-proxy from a cell through its gate. Each probe becomes a subtest that
states what iron-proxy did and pins what keyd does instead, against keyd's real listener, guard,
interception and scrubber (the Docker topology is Part 4b's: it runs the same probes from a real
cell, and `chromium.sh` against Chromium). Two rows keep iron-proxy's outcome on purpose: a bound
host can be browsed without a surrogate (P4a-R8), and a surrogate sent to a host keyd passes through
leaves unseen and unswapped (P4a-R9). The last probe reads the audit file itself and finds no
surrogate-shaped text in it, after a probe that put one in a path and in a host name.

**Files:**
- Test: `keyd/internal/egress/s4_probes_test.go`
- Modify: `README.md` (one section)

**Interfaces:**
- Consumes: the Task 10 harness and the Task 12 helpers (`interceptingCell`, `do`).

- [ ] **Step 1: Write the probes**

`keyd/internal/egress/s4_probes_test.go`:
```go
package egress

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// The probes of spikes/s4-keyd/run.sh, in process: S4 ran them against iron-proxy 0.52 in Docker;
// each case here states what iron-proxy did and pins what keyd does instead. Part 4b runs the
// same probes from a real cell through its gate.

const spikeValue = "real-secret-value-for-spike"

type s4 struct {
	*world
	desktop *Cell
	brain   *Cell
	caCert  *x509.Certificate
	tok     string
	hits    map[string]*atomic.Int32
	seen    chan string
}

func newS4(t *testing.T) *s4 {
	w := newWorld(t)
	s := &s4{world: w, hits: map[string]*atomic.Int32{}, seen: make(chan string, 16)}
	for _, host := range []string{"postman-echo.com", "www.postman-echo.com", "example.com"} {
		hits := new(atomic.Int32)
		s.hits[host] = hits
		w.tlsUpstream(host, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			hits.Add(1)
			s.seen <- r.Header.Get("Authorization")
			json.NewEncoder(rw).Encode(map[string]any{"headers": map[string]string{"authorization": r.Header.Get("Authorization"), "x-api-key": r.Header.Get("X-Api-Key")}})
		}))
	}
	w.plainUpstream("postman-echo.com", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { s.hits["postman-echo.com"].Add(1) }))
	w.own = []netip.Prefix{netip.MustParsePrefix("81.2.69.160/24"), netip.MustParsePrefix("2a01:4b00:1234:5678::abcd/64"), netip.MustParsePrefix("fd12:3456:789a::1/64")}
	w.name("docker-host.example.test", "192.168.65.254")
	w.name("metadata.example.test", "169.254.169.254")
	w.name("loopback.example.test", "127.0.0.1")
	w.name("loopback6.example.test", "::1")
	w.name("zero.example.test", "0.0.0.0")
	w.name("unspecified6.example.test", "::")
	w.name("lan.example.test", "81.2.69.7")
	w.name("ula-own.example.test", "fd12:3456:789a::1")
	w.name("gua-stable.example.test", "2a01:4b00:1234:5678::abcd")
	w.name("gua-temporary.example.test", "2a01:4b00:1234:5678:9999:8888:7777:6666")
	w.secret(vault.Record{ID: "spike", Kind: vault.KindHTTP, Hosts: []string{"postman-echo.com"}, Header: "Authorization", Format: "raw"}, spikeValue)
	s.desktop, s.caCert = w.interceptingCell("desktop", policy.Desktop, "postman-echo.com")
	s.brain = w.cell("brain", policy.Brain)
	s.tok = w.mint("desktop", "spike")
	return s
}

func (s *s4) get(t *testing.T, c *Cell, rawURL string, header http.Header) (*http.Response, string) {
	return do(t, s.client(c, s.caCert), "GET", rawURL, header)
}

func (s *s4) reason(t *testing.T, c *Cell, rawURL string, header http.Header) string {
	t.Helper()
	resp, _ := s.get(t, c, rawURL, header)
	return resp.Header.Get("X-Keyd-Reason")
}

func TestS4Probes(t *testing.T) {
	s := newS4(t)
	auth := func(v string) http.Header { return http.Header{"Authorization": {v}} }

	t.Run("surrogate swapped for bound host; the reflection is scrubbed", func(t *testing.T) {
		// iron-proxy: swapped, and postman-echo reflected real-secret-value-for-spike into the cell.
		resp, body := s.get(t, s.desktop, "https://postman-echo.com/headers", auth(s.tok))
		if got := <-s.seen; got != spikeValue {
			t.Fatalf("upstream saw %q", got)
		}
		if resp.StatusCode != 200 || strings.Contains(body, spikeValue) || !strings.Contains(body, s.tok) {
			t.Fatalf("%d %s", resp.StatusCode, body)
		}
	})
	t.Run("request without a surrogate to the bound host passes untouched", func(t *testing.T) {
		// iron-proxy require: true refused it (403), so Chromium could not browse a bound host.
		resp, _ := s.get(t, s.desktop, "https://postman-echo.com/get", nil)
		if got := <-s.seen; resp.StatusCode != 200 || got != "" {
			t.Fatalf("%d %q", resp.StatusCode, got)
		}
	})
	t.Run("unknown surrogate is blocked", func(t *testing.T) {
		before := s.hits["postman-echo.com"].Load()
		if r := s.reason(t, s.desktop, "https://postman-echo.com/headers", auth("ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA")); r != "unknown-surrogate" {
			t.Fatalf("reason %q", r)
		}
		if s.hits["postman-echo.com"].Load() != before {
			t.Fatal("the upstream was reached")
		}
	})
	t.Run("unlisted hosts: the brain has no web, the desktop's deny list", func(t *testing.T) {
		if r := s.reason(t, s.brain, "http://www.wikipedia.org/", nil); r != policy.ReasonNoWeb {
			t.Fatalf("brain: %q", r)
		}
		if _, resp := rawConnect(t, s.desktop, "printer.local:443"); resp.Header.Get("X-Keyd-Reason") != policy.ReasonHostDenied {
			t.Fatalf("desktop: %q", resp.Header.Get("X-Keyd-Reason"))
		}
	})
	t.Run("private, metadata, loopback and unspecified literals are refused by name policy", func(t *testing.T) {
		for _, u := range []string{"http://192.168.65.254/", "http://169.254.169.254/", "http://127.0.0.1:1234/v1/models", "http://127.0.0.1:4799/", "http://0.0.0.0:4799/", "http://[::]:4799/", "http://[::ffff:127.0.0.1]/"} {
			if r := s.reason(t, s.desktop, u, nil); r != policy.ReasonIPLiteral {
				t.Errorf("%s: %q", u, r)
			}
		}
		if r := s.reason(t, s.desktop, "http://localhost:1234/v1/models", nil); r != policy.ReasonHostInvalid {
			t.Errorf("localhost: %q", r)
		}
	})
	t.Run("names resolving to the Mac, its networks and every private range are refused at dial", func(t *testing.T) {
		for host, rule := range map[string]string{
			"docker-host.example.test":   "docker desktop",
			"metadata.example.test":      "link-local",
			"loopback.example.test":      "loopback",
			"loopback6.example.test":     "loopback",
			"zero.example.test":          "this network",
			"unspecified6.example.test":  "unspecified",
			"lan.example.test":           "connected network",
			"ula-own.example.test":       "unique local",
			"gua-stable.example.test":    "own address",
			"gua-temporary.example.test": "connected network",
		} {
			before := len(s.lines())
			if r := s.reason(t, s.desktop, "http://"+host+"/", nil); r != ReasonAddress {
				t.Errorf("%s: %q", host, r)
				continue
			}
			if l := s.lines()[before]; !strings.Contains(l.Detail, rule) {
				t.Errorf("%s: detail %q, want %q", host, l.Detail, rule)
			}
		}
	})
	t.Run("a surrogate in a header it is not bound to is blocked", func(t *testing.T) {
		// iron-proxy passed X-Api-Key: <surrogate> upstream unswapped.
		h := auth(s.tok)
		h.Set("X-Api-Key", s.tok)
		if r := s.reason(t, s.desktop, "https://postman-echo.com/headers", h); r != "misplaced-surrogate" {
			t.Fatalf("reason %q", r)
		}
	})
	t.Run("a surrogate sent to an unbound subdomain stays in its tunnel, unswapped", func(t *testing.T) {
		// keyd does not terminate hosts no surrogate is bound to, so it cannot see this request;
		// the surrogate leaves as it is, worthless, and the real value never does.
		resp, _ := s.get(t, s.desktop, "https://www.postman-echo.com/headers", auth(s.tok))
		if got := <-s.seen; resp.StatusCode != 200 || got != s.tok {
			t.Fatalf("%d %q", resp.StatusCode, got)
		}
		if issuer := resp.TLS.PeerCertificates[0].Issuer.CommonName; issuer != "upstream test CA" {
			t.Fatalf("www.postman-echo.com was terminated (issuer %q)", issuer)
		}
	})
	t.Run("plain http to the bound host never carries the real value", func(t *testing.T) {
		// iron-proxy swapped it and sent the real value in cleartext.
		before := s.hits["postman-echo.com"].Load()
		if r := s.reason(t, s.desktop, "http://postman-echo.com/headers", auth(s.tok)); r != "misplaced-surrogate" {
			t.Fatalf("reason %q", r)
		}
		if s.hits["postman-echo.com"].Load() != before {
			t.Fatal("the plain upstream was reached")
		}
	})
	t.Run("example.com passes through with its own certificate", func(t *testing.T) {
		// iron-proxy terminated it with the cell CA, and curl and Chromium rejected the leaf.
		resp, _ := s.get(t, s.desktop, "https://example.com/", nil)
		<-s.seen
		if resp.StatusCode != 200 || resp.TLS.PeerCertificates[0].Issuer.CommonName != "upstream test CA" {
			t.Fatalf("%d", resp.StatusCode)
		}
	})
	t.Run("every audit line names its cell and listener", func(t *testing.T) {
		// iron-proxy logged remote_addr 127.0.0.1 for every request.
		for _, l := range s.lines() {
			if l.Cell == "" || l.Port == 0 {
				t.Fatalf("anonymous audit line %+v", l)
			}
		}
	})
	t.Run("plain http inside CONNECT and a Host that differs from the tunnel are refused", func(t *testing.T) {
		// iron-proxy delivered CONNECT example.com:80 + Host: postman-echo.com to postman-echo.com.
		if _, resp := rawConnect(t, s.desktop, "example.com:80"); resp.Header.Get("X-Keyd-Reason") != policy.ReasonPort {
			t.Fatalf("CONNECT :80: %q", resp.Header.Get("X-Keyd-Reason"))
		}
		conn, _ := rawConnect(t, s.desktop, "postman-echo.com:443")
		roots := x509.NewCertPool()
		roots.AddCert(s.caCert)
		tc := tls.Client(conn, &tls.Config{ServerName: "postman-echo.com", RootCAs: roots})
		tc.SetDeadline(time.Now().Add(3 * time.Second))
		io.WriteString(tc, "GET /headers HTTP/1.1\r\nHost: www.postman-echo.com\r\nAuthorization: "+s.tok+"\r\n\r\n")
		line := make([]byte, 12)
		io.ReadFull(tc, line)
		if string(line) != "HTTP/1.1 421" {
			t.Fatalf("Host != SNI: %q", line)
		}
	})
	t.Run("every method is inspected", func(t *testing.T) {
		// iron-proxy's require skipped PROPFIND.
		resp, _ := do(t, s.client(s.desktop, s.caCert), "PROPFIND", "https://postman-echo.com/headers", auth("ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA"))
		if resp.Header.Get("X-Keyd-Reason") != "unknown-surrogate" {
			t.Fatalf("PROPFIND: %d", resp.StatusCode)
		}
	})
	t.Run("a surrogate in a URL's path or host name is refused, and alerted", func(t *testing.T) {
		// A surrogate is bound to a header, never to a URL: wherever keyd sees one there, it refuses.
		for _, u := range []string{"https://postman-echo.com/keys/" + s.tok, "http://" + s.tok + ".example.test/"} {
			if r := s.reason(t, s.desktop, u, nil); r != "misplaced-surrogate" {
				t.Errorf("%s: %q", u, r)
			}
		}
	})
	t.Run("the audit never holds the real value or a surrogate", func(t *testing.T) {
		data, _ := os.ReadFile(s.auditPath)
		if strings.Contains(string(data), spikeValue) || len(surrogate.Find(string(data))) > 0 {
			t.Fatalf("the audit log leaks: %s", data)
		}
	})
}
```

- [ ] **Step 2: Run them**

Run: `go test -run TestS4Probes -v ./internal/egress/`
Expected: PASS — 15 subtests. They pin behaviour Tasks 10–15 built, so they pass at once; a
failure here is a regression in those tasks, not in this file.

- [ ] **Step 3: The full suite, both platforms**

```bash
test -z "$(gofmt -l .)" && go vet ./... && GOOS=darwin GOARCH=amd64 go vet ./... && GOOS=linux go vet ./...
go test -race ./...
go mod verify
```
Expected: no output from gofmt or vet; 13 packages `ok` (177 tests, one skipped: the opt-in
Keychain test); `all modules verified`.

- [ ] **Step 4: README and commit**

Add to `README.md`, after "Development":
```markdown
## keyd

`keyd/` is the key layer (Go 1.27): the only process that holds real secrets. From `keyd/`,
`go test ./...` runs its suites; `KEYD_KEYCHAIN_TEST=1 go test ./internal/vault -run LoginKeychain`
also writes and deletes one fake item in the login keychain. `go build -o bin/keyd ./cmd/keyd`
builds it; `bin/keyd -home /tmp/ld -vault memory -ports 4790-4799` runs a throwaway instance whose
admin API is HTTP on the Unix socket `/tmp/ld/keyd/admin.sock`, and `bin/keyd verify-audit
/tmp/ld/keyd/audit.jsonl` checks the audit log's hash chain.
```

```bash
cd .. && git add keyd/internal/egress/s4_probes_test.go README.md
git commit -m "test(keyd): S4 probes in process, README"
```

---
## Interfaces Part 4b builds on

Exact shapes as they exist at the end of this plan. Part 4b wires these into the daemon and the
cells; nothing here needs Docker.

**Running keyd (production and Part 4b's tests)**
- Build: `cd keyd && go build -o bin/keyd ./cmd/keyd` (`keyd/bin/` is git-ignored). Part 4b's
  harness builds once per run into its own temp folder.
- Flags: `-home DIR` (default `$LOCALDOT_HOME`, else `~/.localdot`; keyd's state is `<home>/keyd`,
  forced to 0700), `-vault keychain|memory` (default `keychain`, service `localdot-keyd`: per secret
  id one generic password `<id>` naming its chunks and the write that made them, and chunks `<id>.0`,
  `<id>.1`, … holding the value hex-encoded, 1,536 bytes each, so any value up to 8,192 bytes is
  stored whole; `memory` keeps values and their index in memory only — every test uses it),
  `-ports MIN-MAX` (default `4760-4789`; e2e harnesses pass `4790-4799`).
- Readiness: exactly one stderr line `keyd ready socket=<home>/keyd/admin.sock boot=<16 hex>`; the
  socket does not exist before it. Use a short home (`/tmp/…`): macOS caps socket paths at 104 bytes.
  A second keyd on the same home exits 1 with `keyd: keyd is already running for <home>`
  (`flock` on `<home>/keyd/keyd.lock`, which holds the pid). SIGINT, SIGTERM or SIGHUP: every cell
  closes, the audit log gets `stop`, the socket is removed, exit 0.
- `keyd verify-audit [path]` (default `<home>/keyd/audit.jsonl`): `audit ok: N lines`, exit 0; or
  `keyd: audit broken after N intact lines: …`, exit 1.
- A keyd restart loses every cell's surrogates, CA and listener (all in memory). `GET /v1/status`
  returns a new `bootId`; the daemon must reopen its cells (which, for running cells, means new
  surrogates and a new CA inside them). The day's spend survives (`<home>/keyd/spend.json`).
- Not in 4a: the LaunchAgent plist and a signed binary (M9). Until then the Keychain items trust
  `/usr/bin/security`, so any process of the user, the daemon included, can read them with
  `security find-generic-password -w`: trust rule 3 holds against accidental exposure (the daemon's
  logs, stored requests and memory never hold a plaintext key), not against a compromised daemon
  (P4a-R3). The local model routes are fixed to `127.0.0.1:1234` and `:11434`; vLLM or a gateway
  elsewhere on the Mac or the LAN is M4's (P4a-R14).

**Admin API** — HTTP/1.1 over the Unix socket `<home>/keyd/admin.sock` (mode 0600, folder 0700).
Any `Host`. Request bodies are JSON, at most 1 MiB, unknown fields refused. Errors are
`{"error":{"code":"…","message":"…"}}` with 400 (`bad-request`, `bad-binding`, `bad-seal`,
`bad-value`), 404 (`not-found`), 409 (`conflict`), 500 (`internal`; `vault`, whose message on
`PUT /v1/secrets/{id}` is always "the secret could not be stored", the cause going to keyd's stderr,
and on `DELETE` is the store's error, which names the operation, the item and the tool's exit status
and never a value). From Node:
`http.request({ socketPath, method, path, headers: { "content-type": "application/json" } })`, or
undici's `new Agent({ connect: { socketPath } })` with `fetch`.

| Request | Body | Reply |
|---|---|---|
| `GET /v1/status` | — | 200 `{"bootId","version","sealKey","cells":n,"secrets":n,"limits":{"perTaskUSD","perDayUSD"},"day":{"date","spentUSD"},"audit":{"ok","error"?}}`; `audit.ok` false means the last audit write failed and keyd swaps no secret until one succeeds |
| `GET /v1/secrets` | — | 200 `{"secrets":[Record…]}` |
| `PUT /v1/secrets/{id}` | LLM: `{"kind":"llm","provider":"anthropic"\|"openai"\|"google"\|"xai"\|"mistral"\|"deepseek"\|"groq"\|"openrouter"\|"openai-compatible"\|"azure","baseURL"?,"sealed":Sealed}` (`baseURL` only for `openai-compatible` and `azure`); HTTP: `{"kind":"http","hosts":[…],"header":"…","format":"bearer"\|"raw"\|"basic-user"\|"basic-password","methods"?:[…],"paths"?:[…],"sealed":Sealed}` | 200 `Record`; revokes the secret's surrogates in every cell; 400 `bad-seal` unless `sealed` was sealed for exactly this id and binding |
| `DELETE /v1/secrets/{id}` | — | 204 \| 404; revokes the secret's surrogates |
| `GET /v1/cells` | — | 200 `{"cells":[CellInfo…]}` |
| `POST /v1/cells` | `{"cellId","role":"brain"\|"desktop"\|"browser","port","secrets":[ids]}` | 201 `Opened` \| 400 \| 409 (open already, or the port is busy) |
| `GET /v1/cells/{id}` | — | 200 `CellInfo` \| 404 |
| `DELETE /v1/cells/{id}` | — | 204: listener, connections, surrogates, task and CA file gone |
| `POST /v1/cells/{id}/revoke` | — | 200 `{"revoked":n}` — the kill switch |
| `POST /v1/cells/{id}/surrogates` | `{"secrets":[ids]}` | 200 `{"surrogates":{"<secretId>":"<surrogate>"}}` \| 400 when a secret's hosts are outside the cell's CA |
| `PUT /v1/cells/{id}/task` | `{"taskId","budgetUSD"?}` | 204; while the task runs, the same `taskId` keeps what it spent (raising a budget), another starts at 0; `DELETE …/task` and the kill switch end the task, and a `taskId` begun again after that starts at 0; `budgetUSD` 0 or absent means the per-task default |
| `DELETE /v1/cells/{id}/task` | — | 204 |
| `GET /v1/budget`, `PUT /v1/budget` | PUT: `{"perTaskUSD","perDayUSD"}` | 200 `{"perTaskUSD","perDayUSD","day":{"date","spentUSD"}}`; 400 unless 0 < per task ≤ per day ≤ 10000 |
| `GET /v1/llm/routes/{route}/models`, `PUT …` | PUT: `{"models":[{"id","inputUSDPerMTok","outputUSDPerMTok","cacheReadUSDPerMTok"?,"cacheWriteUSDPerMTok"?,"maxOutputTokens"?}]}` | 200 `{"route","models":[…]}`; a route with no models refuses every request; prices $0–$10,000 per million tokens; `maxOutputTokens` (models.dev's `limit.output`, 1–100,000,000) is required when `outputUSDPerMTok` is above 0, and bounds every output cap keyd writes |
| `GET /v1/events` | — | 200 `application/x-ndjson`, one `Event` per line until the client closes |

`Record` = `{"id","kind","provider"?,"baseURL"?,"hosts"?,"header"?,"format"?,"methods"?,"paths"?,"createdAt","updatedAt"}`
(never a value). Secret ids: `^[a-z0-9][a-z0-9_-]{0,63}$`, not `lmstudio` or `ollama`; values 8–8192
bytes of printable ASCII, no leading or trailing space; HTTP hosts are exact lower-case public names
(1–16); path prefixes are clean absolute paths of printable ASCII without `;`, backslash or `%`,
and a prefix ends at a segment; basic formats live in `Authorization`. `Opened` = `{"cellId","port","proxyToken","caCertPem","caPath","surrogates":{"<secretId>":"<surrogate>"}}`.
`CellInfo` = `{"cellId","role","port","intercepts":[hosts],"surrogates":[{"secretId","surrogateId"}],"task"?:{"id","limitUSD","spentUSD"}}`.
Cell ids: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (Part 2's ULIDs fit). LLM secrets go only to a role with
the gateway (`brain`), HTTP secrets only to a role with the web (`desktop`, `browser`).

**Sealing a key in the UI** — `sealKey` from `/v1/status` (the daemon passes it to the UI), then
the daemon relays the result in `PUT /v1/secrets/{id}` as `sealed`. The record the UI seals for is
exactly the one the daemon sends with it (its id and every binding field; the value aside): a value
sealed for one binding does not open under another, so a captured blob cannot be replayed with
other hosts, header or base URL. This function, run in Node 25.6.0, sealed the vectors in
`seal_test.go`; its WebCrypto calls are the browser's:
```js
const INFO = "localdot-keyd seal v1";
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));

// The record exactly as the daemon will send it in PUT /v1/secrets/{id}, minus the value.
const binding = (r) =>
  JSON.stringify([r.id, r.kind, r.provider ?? "", r.baseURL ?? "", r.hosts ?? [], r.header ?? "", r.format ?? "", r.methods ?? [], r.paths ?? []]);

export async function sealSecret(publicKey, record, value) {
  const { subtle } = globalThis.crypto;
  const keydRaw = fromB64u(publicKey);
  const keyd = await subtle.importKey("raw", keydRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephRaw = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const shared = await subtle.deriveBits({ name: "ECDH", public: keyd }, eph.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array([...ephRaw, ...keydRaw]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`${INFO}:${binding(record)}`) },
    key,
    new TextEncoder().encode(value),
  );
  return { v: 1, epk: b64u(ephRaw), nonce: b64u(nonce), ct: b64u(new Uint8Array(ct)) };
}
```
In a browser, replace the two `Buffer` helpers with base64url encoding over `Uint8Array`. The seal
key changes with every keyd boot: on `400 bad-seal`, fetch `/v1/status` again and reseal.

**Listener and token model**
- One explicit HTTP/1.1 proxy per cell on `127.0.0.1:<port>`; Part 2's gate relays
  `internal:3128 → host.docker.internal:<port>` (`TCP4`, which reaches keyd's IPv4 bind).
- Every request and every CONNECT carries `Proxy-Authorization: Basic base64(<any user>:<proxyToken>)`;
  anything else gets `407` with `Proxy-Authenticate: Basic realm="localdot-keyd"`. Clients that take
  a proxy URL send it from `http://cell:<proxyToken>@<gate address>:3128` (curl, Node's
  `NODE_USE_ENV_PROXY`, Python, apt, git). Chromium ignores credentials in `--proxy-server`: Part 4b
  answers its 407 challenge (an extension's `webRequest.onAuthRequired`, or a forwarder in the cell
  that adds the header) — keyd's side is fixed. The token is 43 base64url characters (32 bytes).
- CONNECT: only `host:443` with a DNS name. Hosts the cell's HTTP secrets are bound to (its CA's
  `intercepts`) are terminated; every other allowed host passes through after an SNI check. Plain
  HTTP: absolute-form `http://` to port 80 only. No IP literals, no single-label names, nothing on
  the deny list (`localhost` and `*.localhost`, `*.local`, `*.internal`, `*.intranet`, `*.private`,
  `*.corp`, `*.home`, `*.lan`, `*.home.arpa`, `*.ldot`).
- Reserved names: `http://keyd.ldot/health` answers `{"ok":true,"cell":"<cellId>"}` — the cell's
  boot self-test proves its gate, its proxy settings and its token without the internet.
  `http://llm.ldot/<route>/<path>` is the gateway, for the brain only.
- Every refusal keyd answers itself carries `X-Keyd-Reason: <reason>` (the reasons below), so a
  self-test can say which check failed; a refusal after a CONNECT's 200 (an SNI mismatch, no TLS)
  closes the connection instead.
- Roles: `brain` (the gateway only: it holds no HTTP secret, so it has no bound hosts), `desktop`
  and `browser` (the web, minus the deny list, plus their bound hosts; no gateway).

**What a cell gets from `Opened`** — the proxy token; `caCertPem`, the public CA to install as a
trust anchor (system store and `update-ca-certificates`, Chromium's NSS database with
`certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n ldot -i …` — `libnss3-tools` is not in the image
yet, S4 — and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` for runtimes with their own
stores); one surrogate per secret (the environment variable names are Part 4b's); and for the brain
the gateway base URLs. A route's base already ends in the provider's version path, so a provider
SDK's `baseURL` becomes `http://llm.ldot/<route>`:

| Route | keyd sends to | Auth header (the surrogate goes there) | Operations (the output-cap field keyd writes) |
|---|---|---|---|
| `anthropic` preset | `https://api.anthropic.com/v1` | `X-Api-Key` | `POST messages` (`max_tokens`), `POST messages/count_tokens` (free), `GET models`, `GET models/{id}` |
| `openai` preset | `https://api.openai.com/v1` | `Authorization: Bearer` | `POST chat/completions` (`max_completion_tokens`), `completions` (`max_tokens`), `responses` (`max_output_tokens`), `embeddings`; `GET models`, `models/{id}` |
| `google` preset | `https://generativelanguage.googleapis.com/v1beta` | `X-Goog-Api-Key` | `POST models/{model}:generateContent`, `:streamGenerateContent` (`generationConfig.maxOutputTokens`), `:countTokens` (free), `:embedContent`, `:batchEmbedContents`; `GET models`, `models/{id}` |
| `xai` preset (Part 5a) | `https://api.x.ai/v1` | `Authorization: Bearer` | `POST responses` (`max_output_tokens`); `GET models`, `models/{id}` |
| `mistral` preset (Part 5a) | `https://api.mistral.ai/v1` | `Authorization: Bearer` | `POST chat/completions` (`max_tokens`); `GET models`, `models/{id}` |
| `deepseek` preset (Part 5a) | `https://api.deepseek.com` | `Authorization: Bearer` | as `mistral` |
| `groq` preset (Part 5a) | `https://api.groq.com/openai/v1` | `Authorization: Bearer` | as `mistral`; usage read from `x_groq.usage` |
| `openrouter` preset (Part 5a) | `https://openrouter.ai/api/v1` | `Authorization: Bearer` | as `mistral`; a `models` list is refused (`choice-count`) |
| `openai-compatible` | the secret's `baseURL` (https) | `Authorization: Bearer` | as `openai`, but chat completions get `max_tokens` |
| `azure` | the secret's `baseURL` (https) | `Api-Key` | as `openai` |
| `lmstudio` (built in, no secret) | `http://127.0.0.1:1234/v1` | none (dropped) | as `openai-compatible` |
| `ollama` (built in, no secret) | `http://127.0.0.1:11434/v1` | none (dropped) | as `openai-compatible` |

A secret's route name is its id, so a user with one key per provider names it after the preset.
Before a model can be used, the daemon sets the route's models, prices and maximum outputs (from
the models.dev catalog) with `PUT /v1/llm/routes/{route}/models`, and begins a task for the cell with
`PUT /v1/cells/{id}/task`. Streaming OpenAI-compatible providers should be asked for usage
(`stream_options.include_usage`, the AI SDK's `includeUsage`); otherwise keyd charges the request's
hold. Budgets under concurrency (P4a-R15, P4a-R27): keyd works out what each request can cost and
holds it against the task and the day while the request runs — its input as the provider bills it
(text at three bytes a token, images by the provider's image-token rule) plus its output cap at the
output price. The cap is the smallest the body names in any provider's cap field, else the model's
`maxOutputTokens`, lowered to what the room left pays for; keyd writes it into the provider's own
field (the route table's operations name it) and removes every other cap, so the brain's own cap
(the AI SDK's `maxOutputTokens`) is kept when it is the smaller. A body asking for more than one
answer (`n`, `best_of`, `candidateCount`, or a `prompt` list on `completions`), or a `models`
list to fall back on, gets 400 `choice-count`. A request that does not fit beside
the running ones waits for them; one whose input and a single output token do not fit in what is
left gets 402; requests together never spend past a limit, but for what a provider bills beyond
keyd's rules (P4a-R15). Screenshots should be PNG or JPEG, whose sizes keyd reads; an image in
another format or by URL holds the provider's per-image maximum. A complete answer is charged the
usage it reports, one that reports none its hold, a request the cell leaves before the answer's
headers its hold too once keyd has begun to send it, a stream cut short the most it can have cost.
Gateway refusals: 402 `{"error":{"type":"budget_exceeded","scope":"task"|"day","limitUSD","spentUSD","needUSD"?}}`
(the AI SDK does not retry 402; `needUSD` is what the refused request asked to hold; every 402 also
publishes `budget.exceeded`), 400 `choice-count` whose body names the field, 403/400/404/413 with
`X-Keyd-Reason`, 503 `revoked` for a request that Stop overtook.

**CA files** — `<home>/keyd/cells/<cellId>/ca.pem` (0644 inside 0700 folders), the same PEM as
`caCertPem`, for `docker cp`; removed when the cell closes, and the whole `cells/` folder is cleared
when keyd starts (those CAs died with their process). The CA: EC P-256, critical name constraints
permitting exactly the cell's `intercepts` (or `invalid` when there are none), every IPv4 and IPv6
range excluded, path length 0, server authentication its only extended key usage, valid 397 days;
leaves EC P-256, 30 days, renewed a day before expiry. No private key is ever written anywhere.

**Audit log** — `<home>/keyd/audit.jsonl` (0600), one JSON object per line, appended, never
rotated (yet). A line's `prev` is the lowercase hex SHA-256 of the previous line's exact bytes
(without its newline); the first line's is 64 zeros; `seq` counts from 1. A write that fails is cut
back off before the next line, so the chain never holds a partial line. Fields, omitted when
empty unless marked:

| Field | Meaning |
|---|---|
| `v` (always) | 1 |
| `seq` (always), `time` (always) | position; UTC RFC 3339 with nanoseconds |
| `kind` (always) | `connect` (a CONNECT and its tunnel), `request` (an HTTP request keyd saw), `admin`, `keyd` |
| `cell`, `port` | the cell and its listener |
| `mode` | `http`, `passthrough`, `mitm`, `gateway`, `internal` |
| `method`, `host`, `path` | the request; the path never has its query; for the gateway, the provider's host and path. These, `sni`, `route`, `model` and `detail` come from the cell's request, so any surrogate-shaped text in them is written as `surrogate:<id>` |
| `sni` | the ClientHello's server name |
| `route`, `model` | gateway only |
| `status` | the status keyd answered (omitted for a tunnel refused after its 200) |
| `bytesIn`, `bytesOut` | body bytes from and to the cell (tunnels: bytes each way) |
| `durationMs` | |
| `decision` (always) | `allow`, `deny`, `error` |
| `reason` | why, from the list below; for `admin` and `keyd` lines, what happened |
| `secretId`, `surrogateId` | the secret involved and the surrogate's ID (12 hex), never the value or the surrogate |
| `swapped` | a real value went upstream |
| `costMicroUSD`, `usage` | gateway charges; `usage` is `reported`, or `estimated` when any of the charge came from the byte estimate (no usage reported, a stream cut short, or a cell that left before the answer's headers) |
| `detail` | an error's text, at most 512 bytes; never a secret |
| `prev` (always) | the chain |

Reasons — auth: `proxy-auth-missing`, `proxy-auth-invalid`; requests: `bad-request`,
`method-not-allowed`, `not-found`; policy: `host-invalid`, `ip-literal`, `port-not-allowed`,
`host-denied`, `web-not-allowed`; TLS: `not-tls`, `sni-mismatch`, `tls-handshake-failed`,
`host-mismatch`, `upgrade-refused`; surrogates: `unknown-surrogate`, `misplaced-surrogate`,
`surrogate-policy`, `surrogate-missing`, `secret-unavailable`, `audit-unavailable`; addresses: `address-denied`,
`resolve-failed`; upstream: `upstream-error`, `upstream-tls`, `upstream-aborted`, `client-aborted`,
`undecodable-encoding`, `revoked`; gateway: `route-unknown`, `op-not-allowed`, `no-task`,
`budget-task`, `budget-day`, `body-too-large`, `bad-json`, `model-missing`, `model-not-allowed`,
`choice-count` (its `detail` is the field); admin: `secret-put`, `secret-delete`, `cell-open`,
`cell-close`, `cell-revoke`, `cell-mint`, `task-begin`, `task-end`, `budget-set`, `models-set`;
keyd: `start`, `stop`, `audit-repair`.

**Events** (`GET /v1/events`, one per line):
```json
{"type":"key.use","cell":"c1","time":"2026-10-01T12:00:00.123Z","data":{"secretId":"anthropic","host":"api.anthropic.com","method":"POST","path":"/v1/messages","decision":"allow"}}
{"type":"budget.exceeded","cell":"c1","time":"…","data":{"scope":"task","taskId":"t1","limitUSD":5,"spentUSD":5.1}}
{"type":"events.dropped","time":"…","data":{"count":4}}
```
`key.use`'s `data` is exactly `@localdot/protocol`'s `KeyUse` (`secretId`, `host`, `method`,
`path`, `decision`); keyd emits `allow` (a real value went upstream) and `deny` (a surrogate refused
anywhere; `secretId` is `"unknown"` when the surrogate is not keyd's), never `ask`. `host`, `method`
and `path` are text the cell's request chose: keyd writes a surrogate in them as `surrogate:<id>`,
and the timeline must show them as plain text, never markup or a link. One `key.use`
follows every audit line a cell's listener writes that names a secret or refuses a surrogate.
Part 4b appends it to the cell's live session with
`EventLog.append(sessionId, { type: "key.use", agent: "keyd", data })` and turns
`budget.exceeded` — published when a charge crosses a limit and on every budget refusal, so one task
may publish it more than once — into pausing the task's agent loop and offering to raise the budget
(`PUT /v1/cells/{id}/task` with the same `taskId` and a higher `budgetUSD`). That pause is not Stop:
the kill switch ends the task in keyd, and the same `taskId` begun again would start at $0 (review 2,
N5). The stream is best effort; the audit log is the record.

**Part 4b obligations (not implemented here)**
- The daemon's admin client, its reaction to a changed `bootId`, and opening a cell with keyd before
  its containers start (the port from Part 2's `allocateKeydPort`), closing it on removal.
- The cell's proxy environment (`HTTP(S)_PROXY` with the token, `NO_PROXY` empty), the CA install
  above, the surrogates' variable names and the brain's base URLs; Chromium's proxy credentials.
- `desktopd`'s `GET /selftest` (direct internet and DNS fail, `http://keyd.ldot/health` through the
  proxy answers the cell's id, `host.docker.internal:1234` fails) and the readiness gate.
- The key form: seal in the UI, relay through a daemon route, show `Record`s.
- `key.use` and `budget.exceeded` into the event log; `GET /v1/status`'s `audit.ok` in the UI's
  health (keyd swaps no secret while it is false).
- Stop: `POST /v1/cells/{id}/revoke` for every cell of the task, which drops the cell's surrogates,
  ends its task and closes its upstream connections and tunnels; and, because the listener stays
  open, pausing or stopping the cells' processes too (research §3.10), or a process the agent left
  running keeps its web egress. Then new surrogates and `PUT …/task` for the next task.
- Each priced model's `maxOutputTokens` in `PUT /v1/llm/routes/{route}/models` (models.dev's
  `limit.output`): keyd refuses a priced model without it, and bounds every cap by it (P4a-R15).
  Brain calls should still send their own output cap, which keyd keeps when it is the smaller, and
  never ask for more than one answer; screenshots go as PNG or JPEG (P4a-R27).
- The canary test, and S4's `run.sh` and `chromium.sh` from a real cell through its gate, against
  the expectations Task 17 pins.

---
## Decisions taken by this plan (P4a-R1 to P4a-R27)

Review 1 changed R2, R3, R5, R8, R9, R10, R14, R15, R17, R18, R20 and R23 and added R25 and R26; each
says so. The spec's trust rule 3, swap rules and default egress were amended with them (2026-10-01,
Part 4a review), and its risks record R3's cost. Review 2 changed R3, R8, R10, R15, R18 and R20 and
added R27 (ruling P4a-C5). Review 3 changed R15 and R27's table (ruling P4a-C7).

- **P4a-R1 The data plane's split.** `goproxy` v1.9.2 is each listener's CONNECT front door: it
  parses the proxy protocol, calls keyd's decision and hands keyd the hijacked connection. Every
  request keyd inspects — plain HTTP, the requests inside an intercepted tunnel, the gateway — is
  parsed by `net/http` and forwarded by `httputil.ReverseProxy`. Why: goproxy's MITM loop reads
  requests with its own `http1parser` (a second parser in front of the swap invites smuggling),
  closes the connection with no response when the upstream fails, cannot report a handshake the
  client aborts (A25), and its plain-HTTP path ends a truncated upstream body as if it were
  complete; its defaults also skip upstream TLS verification and honour `HTTPS_PROXY`, so keyd
  disables its dialing and transport. Cost if wrong: if goproxy should carry more of the path,
  `forward`/`relay` in `forward.go` is the one seam to move.
- **P4a-R2 Keys arrive sealed, through the daemon.** The spec's "the key form in the UI posts
  straight to keyd" has no door to post to: keyd's only listeners are the 0600 socket and the
  per-cell ports, and a new loopback port would be reachable from any container on the Mac. So the
  UI seals the key to keyd's per-boot ECDH P-256 key (HKDF-SHA256, AES-256-GCM) and the daemon
  relays ciphertext; it never holds the plaintext. The AAD is the secret's whole binding (id, kind,
  provider, base URL, hosts, header, format, methods, paths), so a blob captured within one boot
  cannot be replayed under another binding (review 1, M6). Neither this nor a direct post protects
  against a compromised daemon, which serves the UI's code. The spec's trust rule 3 now says this
  (amended 2026-10-01). Cost if wrong: if a literal post is required, add an intake listener that
  calls the same `Opener.Open` and `Vault.Put`.
- **P4a-R3 The Keychain through `/usr/bin/security`.** Values go hex-encoded on the tool's stdin
  (`security -i`), never on its command line; no cgo. `security -i` runs 4,095 characters of a line
  as one command and the rest as another, which it prints, so values go in 1,536-byte chunks, one
  item each, named by the item `<id>`; every write is read back, and no error carries the tool's
  output (changed after review 1, C1; the `-w` prompt was tried too and cuts a value at 128
  characters). Items trust `/usr/bin/security`, so rebuilding keyd never prompts. Cost: any process
  of the same user, the daemon included, can read every key with `security find-generic-password -w`
  (the research's A6), so trust rule 3 holds against accidental exposure, not against a compromised
  daemon or a malicious local process, until M9: a Security.framework store whose ACL names a
  signed keyd replaces `vault.Keychain` behind `vault.Store`. The spec's "Risks and open questions"
  records this (review 1, M7; synced after review 2). A store runs 9 to 19 `security` processes
  (about 0.3 s measured) under the vault's lock, which every request takes to build its scrubber,
  so the cells' traffic pauses while the user stores a key; keys are stored rarely (review 2, N6).
- **P4a-R4 Bindings are the user's, fixed when the key is added.** A secret's hosts, header and
  format (or its provider and base URL) are stored with it in `secrets.json` (0600, no values) and
  never come from a cell or a mint request. Replacing or deleting a secret revokes its surrogates in
  every cell. Cost if wrong: a binding change forces the daemon to mint again.
- **P4a-R5 Names only.** IP literals, single-label names and names whose last label is not letters
  or an IDN's `xn--` form (`127.1`, `0x7f.0x1`, which macOS's resolver turns into 127.0.0.1; review 1,
  M1) are refused for every cell; CONNECT goes only to port 443 and plain HTTP only to 80. Why: the
  policy, the deny list and the SNI check are about names, and a literal carries no SNI. Web
  research, package registries, apt over 80, git over https and wss to passthrough hosts all work;
  odd ports, IP-literal URLs and `ws://` do not. The spec's default egress records this narrowing
  (amended 2026-10-01). Cost if wrong: tools that call raw addresses or other ports fail; an explicit
  allow rule can be added later.
- **P4a-R6 One denied answer refuses the name; IPv4 first.** A name whose answers mix public and
  private addresses is refused whole (a rebinding shape). The dialer tries IPv4 answers before IPv6,
  one at a time, without Happy Eyeballs. Cost if wrong: slower fallback where IPv4 is broken.
- **P4a-R7 The Mac's own addresses are read at every check.** `net.InterfaceAddrs` costs about
  31 µs on the development Mac (25 addresses) and runs three times per dial, so nothing watches for
  changes and nothing can be stale. Every interface address is denied, and so is the network it is
  in. Cost if wrong: a syscall per check; a cache with a routing-socket watcher would replace it.
- **P4a-R8 Swaps only in the bound header; bodies are not scanned.** A surrogate must sit exactly in
  its bound header in its bound format. Request bodies are not scanned, because swaps never happen
  there (so nothing can be laundered through one) and LLM prompts may quote surrogate strings, which
  would brick a session if refused. A bound host without a surrogate in the request is browsed
  normally (S4: iron-proxy's `require` refused it, so Chromium could not load the site). The spec's
  "never passed through" now covers the request line and headers of traffic keyd terminates
  (amended 2026-10-01). Cost if wrong: a surrogate pasted into a body leaves without an alert; it is
  worthless off the Mac. And a method limit holds only against the method overrides keyd can see,
  the headers and a `_method` query parameter: Rails (`Rack::MethodOverride`), Laravel and Spring's
  `HiddenHttpMethodFilter` also read `_method` from a form body, so on such a server a binding that
  permits POST can be turned into PUT, PATCH or DELETE (review 2, N8).
- **P4a-R9 Selective interception limits what keyd sees.** Only hosts bound to the cell's
  surrogates are terminated (the CA can vouch for nothing else). A surrogate sent inside a
  passthrough tunnel leaves unseen and unswapped (S4's "exact host" probe keeps its outcome). The
  spec records this with R8's amendment, and the residual risk with it: responses on passthrough
  names are never scrubbed, so a service that stores a header keyd sent to a bound host and shows it
  under another, unbound name puts the real value where keyd cannot remove it. Cost if wrong: no
  alert for that case; seeing it would need an unconstrained CA, which the spec rules out.
- **P4a-R10 Compression: one gzip only (changed after review 2, M3).** keyd replaces the cell's
  `Accept-Encoding` with `gzip` and decodes a lone `gzip` itself, so the scrubber sees plaintext and
  the cell gets identity; its transports decode nothing. Go's transport, which used to decode, removes
  one gzip layer only when the first `Content-Encoding` line is `gzip`, and then deletes every line,
  so `identity` then `gzip` passed a gzipped body through (review 1) and `gzip` then `gzip` or `br`
  reached the cell with no coding named (review 2). Anything but no coding, a lone `identity` or a
  lone `gzip` — another coding, or two codings on one line or several — is refused with 502. That
  bounds the fix at one layer of the one coding keyd asked for. A body compressed under a coding it
  does not name is the upstream disguising an echo, which no scrubber follows (P4a-R18). Cost if
  wrong: a server that sends brotli unasked, or stacks codings, fails closed.
- **P4a-R11 No upgrades where keyd intercepts.** WebSocket and other upgrades are refused on
  intercepted hosts and on the gateway; frames cannot be scrubbed. Cost if wrong: a WebSocket API on
  a bound host (OpenAI Realtime, for example) needs frame-aware scrubbing first.
- **P4a-R12 The proxy token is a Basic password.** Any user name, the cell's 32-byte base64url token
  as the password, compared in constant time. Why: every client that takes proxy credentials in a
  URL sends Basic. Cost if wrong: Chromium needs a 407 answerer in the cell (Part 4b).
- **P4a-R13 Auth refusals are rate-limited in the audit.** At most one line a second per cell, the
  next one counting the rest: any container on the Mac can knock. Cost if wrong: a flood's exact
  count is approximate.
- **P4a-R14 Gateway routes.** A route's name is its secret's id. `anthropic`, `openai` and `google`
  have fixed base URLs, and so do Part 5a's first-class bearer presets `xai`, `mistral`,
  `deepseek`, `groq` and `openrouter`, which list only the operation their official package calls
  (P5a-R31); `openai-compatible` and `azure` take an https base URL from the user;
  `lmstudio` and `ollama` are built in, carry no secret and reach `127.0.0.1:1234` and `:11434`
  through a dialer pinned to those two addresses. Each preset lists its operations; the daemon sets
  each route's models and prices, and a route without them refuses everything. The guard refuses
  every other model server on the Mac or the LAN (vLLM, a self-hosted gateway), though the spec's
  Providers section names them: M4 adds configurable local routes (review 1, M12). Cost if wrong: a
  provider path not listed needs one line in `keys/binding.go`.
- **P4a-R15 Budgets (changed after reviews 1, 2 and 3; rulings P4a-C5 and P4a-C7).** A gateway request needs a
  running task, and keyd works out the most it can cost without trusting its body:
  - A body asking for more than one answer (`n`, `best_of` or `candidateCount` other than 1, in any
    spelling a Go or protobuf server reads, or on the completions API a `prompt` list of more than
    one element; review 3, N-C) gets 400 `choice-count` naming the field: the agent never needs
    one, and the provider bills every answer under the one cap. One prompt's token ids go as a list
    of one list.
  - The output cap is the smallest the body names in any provider's cap field (a whole number; null,
    0, a string or a fraction is none), else the model's `maxOutputTokens`, lowered to what the room
    left in the task and the day pays for. keyd writes it into the provider's own field (P4a-R27) and
    removes every other cap field, so the provider reads keyd's cap whichever field it prefers.
  - The input is priced as the provider bills it: text at three bytes a token, each image by the
    provider's image-token rule from its PNG or JPEG header, or at the provider's per-image maximum
    when keyd cannot read it (P4a-R27); never base64 as text. The text's share is never below
    nothing, however long an image's data decodes (invalid UTF-8 decodes three bytes for each one
    sent, which once made a hold negative; review 3, N-A).
  - The request holds its input and its cap at the output price against the task and the day until
    it ends. One that does not fit beside the holds of running requests waits for them; one whose
    input and a single output token do not fit in the room left, or that comes after a limit is
    spent, gets 402 with `needUSD`, what it asked to hold. Every such refusal publishes
    `budget.exceeded`, as a charge that crosses a limit does.
  - When the answer ends, the hold is released and the cost charged: the usage a complete answer
    reports; the hold, for a successful answer that reports none, and for a request the cell leaves
    before the answer's headers once keyd has begun to send it, since the provider may be generating
    it (review 3, N-B; a request is begun once keyd has written its headers, before its body, and
    one not yet begun costs nothing); for a stream cut short, the most it can have cost (the
    reported input with the whole cap of output, or the byte estimate of what reached the cell if
    that is more, and at least the hold), because the provider bills what it generated; for a
    failed answer, only what it reported. Token counts are free and hold nothing. Cache tokens
    without a price cost the input price. The AI SDK does not retry 402.

  So requests running together never spend past either limit while their providers bill by the rules
  keyd prices with (review 1: twenty requests had spent $90 of a $5 task; review 2: so had twenty with
  a null cap, `n: 128` or a cap in a field the server ignores, and five screenshots were refused after
  $1.98 of $5; review 3: an image of invalid UTF-8 had held −$58.40 while $63 of a $5 task ran
  beside it, a prompt list had spent $9 of $5 in two calls, and a cell that left before the
  answer's headers had been charged nothing twenty times). Cost if wrong: near a limit a request
  runs with a lowered cap, so its answer can stop short, and a request waits while others hold the
  room. A hold falls short, and its request can
  cross a limit by the shortfall (so can several running requests, each by its own), when a provider
  bills more than these rules: text that takes more than one token per three bytes (base64 or random
  text, some scripts); documents, audio and video, which keyd counts as their bytes inline and not
  at all by reference; tokens a tool adds on the provider's side (Anthropic's tool and computer-use
  prompts); server-side tools and their fees; a service tier, speed or long-context price above the
  listed one; an image rule above keyd's (some OpenAI-compatible servers' models, or gpt-4o-mini
  under another deployment name); a server that ignores the cap keyd writes; input the provider
  stores between requests, which the body only names and keyd cannot see at all (OpenAI's
  `previous_response_id`, Gemini's cached content and the like; review 3, N-D). Part 4b's brain
  uses none of the others, and each needs code in the brain cell or an unusual server; whether the
  brain continues stored conversations is known at M4, which refines that last residual. A
  provider that never reports usage is charged every hold in full, which can stop a task early.
- **P4a-R16 Restarts.** Surrogates, CAs and listeners live in memory and die with keyd; the boot id
  changes and the daemon reopens its cells. The day's spend is persisted; a task's is not. Cost if
  wrong: a keyd crash restarts the cells.
- **P4a-R17 The audit format.** UTC times; `prev` chains raw line bytes; a partial last line is cut
  and recorded; no fsync (crash-safe, not power-loss-safe, like the daemon's event log); no
  rotation; `detail` capped at 512 bytes; paths without queries. Surrogate-shaped text in a field a
  request controls is written as `surrogate:<ID>` (review 1, M2). A failed write is cut back off
  before the next line and kept as `Err`; while it is set keyd swaps no secret (503
  `audit-unavailable`) and `/v1/status` says so; the next successful write, a refusal's included,
  clears it (review 1, M4). A swap's own line is written when its response ends, so the first swap
  after the disk fills goes out unrecorded. Tampering with the last line is detectable only against
  an outside copy. Cost if wrong: rotation and anchoring come with M9's `doctor`.
- **P4a-R18 Scrubbing (changed after reviews 1 and 2).** A real value becomes the cell's surrogate in
  the same encoding (or `keyd-redacted` when the cell holds none); inside longer base64 values its
  characters are overwritten with `A`. Every form matches with any of its bytes escaped as URL
  (percent, either case, `+` for a space), JSON (backslash-u in either case, short escapes) or HTML
  (named and numeric references) encoders escape them, byte by byte, so Go's, .NET's, JavaScript's,
  Python's and PHP's encoders are covered, mixed or not; a replacement is made of characters no
  encoder escapes. Secrets shorter than 8 bytes are refused so the scrubber cannot match common
  text. Truncated or masked reflections (a provider printing the last four characters), escapes of
  the bytes those encoders leave alone (letters, digits and `-._~`: `%7E` from Java's `URLEncoder`
  or Python before 3.7), `&#X3C;` with a capital X, numeric references padded past three digits
  (`&#0060;`), and a double encoding (a backslash-u escape, percent-encoded) are not scrubbed (review
  2, N8). 1xx headers and trailers are.
- **P4a-R19 The module.** `github.com/shadowhusky/localdot/keyd` (the repo has no remote yet);
  `go 1.27` with `toolchain go1.27.1`; CI on `ubuntu-latest` with `GOOS=darwin go vet`, because the
  tests fake everything macOS-specific and macOS runners cost ten times as much on a private repo.
  Cost if wrong: a module path change is one `sed`; macOS-only failures would surface on the
  developer's Mac first.
- **P4a-R20 The kill switch keeps the listener and ends the task (changed after review 1).**
  `revoke` drops the cell's surrogates, ends its task (the keyless `lmstudio` and `ollama` routes
  stop with it; a user Stop is not the raise-the-budget path, since a `taskId` begun again after it
  starts at $0, review 2, N5) and replaces its generation: every
  upstream request and tunnel ends, and a gateway request inspected before the switch, whose body
  was still uploading, is refused rather than relayed (review 1, I2). The listener and CA stay, so the
  next task gets fresh surrogates with `POST …/surrogates` and a task with `PUT …/task`, and no CA is
  reinstalled in a running cell. Because the listener stays, Part 4b's Stop must also pause or stop
  the cells' processes (research §3.10). A secret bound to a host outside the cell's CA needs the
  cell reopened. Cost if wrong: a process the daemon fails to pause keeps its web egress.
- **P4a-R21 keyd enforces the port range.** 4760–4789 unless `-ports` says otherwise; tests in
  process use the zero range, which allows only port 0.
- **P4a-R22 `-vault memory` keeps the index in memory too**, so a test keyd leaves no secret
  metadata behind and a restart starts clean.
- **P4a-R23 Values are strict.** 8–8192 bytes of printable ASCII without surrounding spaces (all of
  it stored and read back whole, R3);
  basic-user values without a colon; HTTP secrets bound to 1–16 hosts, in a header that is not a
  framing, hop-by-hop or cookie header. Cost if wrong: a secret with other bytes is refused at the
  form.
- **P4a-R24 Provenance.** `internal/egress/sni.go` is adapted from iron-proxy v0.52.0 and keeps its
  Apache-2.0 notice and license file; the dial-time check, the Basic-auth-aware swap and the audit
  shape follow iron-proxy's design without its code. The substitution cases of Anthropic's
  sandbox-runtime are ported as test cases, with keyd refusing where srt passes a sentinel through.
- **P4a-R25 The admin socket trusts its file mode (review 1, M5).** The socket is 0600 inside the
  0700 state folder, whose owner keyd checks at start; keyd does not also check the peer's uid with
  `LOCAL_PEERCRED`. Why: no other user can traverse the folder, a uid check admits every process of
  the same user anyway, and reading it would add `golang.org/x/sys` as a dependency. Cost if wrong:
  a check in `admin.Listen`'s accept path.
- **P4a-R26 A brain cell holds no HTTP secret (review 1, M11).** The manager refuses an HTTP secret
  for a role without the web, so the brain reaches only the gateway, as the spec's default egress
  says; before, a bound host was intercepted for any role. Cost if wrong: a brain that needs an HTTP
  API gets it through a tool that runs in the desktop cell.
- **P4a-R27 What each provider bills, and where it reads the cap (review 2, I3 and N1; ruling
  P4a-C5).** keyd encodes these rules, read from each provider's public documentation on 2026-10-01;
  `keys/binding.go` names each operation's cap field, `llm/images.go` holds the image rules. An image
  is sized from its PNG or JPEG header (w × h); one keyd cannot size, by URL or file id or in another
  format, costs the last column.

  | Provider (routes) | Cap field keyd writes | Answers above 1 refused | Image tokens | Image not sized |
  |---|---|---|---|---|
  | Anthropic (`anthropic`) | `max_tokens` on `messages` | none exist | ⌈w/28⌉·⌈h/28⌉, at most 4,784 | 4,784 |
  | OpenAI (`openai`, `azure`) | `max_completion_tokens` on chat completions, `max_tokens` on completions, `max_output_tokens` on Responses | `n`, `best_of`, a `prompt` list on completions | the larger of ⌈2.46 × min(⌈w/32⌉·⌈h/32⌉, 30,000)⌉ and 85 + 170 per 512-pixel tile; gpt-4o-mini 2,833 + 5,667 per tile | 73,800 |
  | OpenAI-compatible (`openai-compatible`, `lmstudio`, `ollama`) | as OpenAI, but `max_tokens` on chat completions | `n`, `best_of`, a `prompt` list on completions | OpenAI's | 73,800 |
  | Google (`google`) | `generationConfig.maxOutputTokens` | `generationConfig.candidateCount` | the larger of 2,240 and 258 per crop of ⌊min(w, h)/1.5⌋ pixels (258 within 384 × 384) | 2,240 |

  Sources and what they say:
  - Anthropic. The Messages API reference (platform.claude.com/docs/en/api/messages/create):
    `max_tokens` is required, at least 0 ("Set to `0` to populate the prompt cache without generating
    a response"), and extended thinking "counts towards your `max_tokens` limit"; no parameter asks
    for several answers. The vision guide (…/build-with-claude/vision, "Resolution and token cost")
    and its resize rule (…/vision-coordinates, "How Claude resizes and pads images"): an image costs
    "⌈width / 28⌉ × ⌈height / 28⌉ visual tokens", a larger one is scaled down to fit the model's
    budget, 1,568 tokens on the standard tier and 4,784 on the high-resolution tier (Claude 4.7 and
    later), and padding to 28 pixels adds none.
  - OpenAI. The API reference for chat completions (developers.openai.com): `max_completion_tokens`
    bounds "visible output tokens and reasoning tokens"; `max_tokens` is deprecated and "not
    compatible with o-series models"; `n` is 1 to 128. Completions: `best_of` "Generates `best_of`
    completions server-side". Responses: `max_output_tokens` includes reasoning tokens. The images
    guide (…/api/docs/guides/images-vision, "Calculating costs"): patch models bill ⌈w/32⌉·⌈h/32⌉
    patches times a multiplier from 1.2 to 2.46 (gpt-4.1-nano), and "If this count exceeds 30,000
    patches, the API rejects the request"; tile models bill base and tile tokens (85 and 170 for
    gpt-4o and gpt-4.1, 75 and 150 for o1 and o3, 70 and 140 for gpt-5 and gpt-5.1, 2,833 and 5,667
    for gpt-4o-mini) after scaling "to fit in a 2048px x 2048px square" and the shortest side to
    768 pixels. The rule differs model by model, so keyd takes the largest; `detail` only lowers it.
    Servers that copy OpenAI's API read `max_tokens` (vLLM, LM Studio, Ollama), and their models
    tokenize images their own way: keyd applies OpenAI's rule (a residual in P4a-R15).
  - Google. The Gemini API's `GenerationConfig` (ai.google.dev/api/generate-content):
    `maxOutputTokens` and `candidateCount`, which protobuf's JSON mapping also accepts by their field
    names, `generation_config`, `max_output_tokens` and `candidate_count`; keyd counts 0 and null as
    no cap there. The thinking guide:
    "`max_output_tokens` … sets the maximum number of tokens a response can generate, including
    thought tokens", billed as output. Media resolution (…/gemini-api/docs/media-resolution): a
    Gemini 3 image costs 280, 560, 1,120 (the default) or 2,240 tokens. Image understanding
    (…/docs/image-understanding): "258 tokens if both dimensions <= 384 pixels. Larger images are
    tiled into 768x768 pixel tiles, each costing 258 tokens", counted with a crop unit of
    "floor(min(width, height) / 1.5)".

  Token counts (`messages/count_tokens`, `:countTokens`) are free, and embeddings write no output.
  Cost if wrong: a provider changes a rule, or a model bills images above these bounds; the two files
  change with the providers' documentation.

---
## Verification

Run on 2026-10-01 for revision 3 (review 3's fixes under ruling P4a-C7), against a module made only
from this plan's code blocks, in `/private/tmp/claude-501/-Volumes-Husky-s-SSD-4T-Projects/8ea76523-70ba-4eef-a6ab-cd9a3032d328/scratchpad/part4a-fix3/plan-build`.
A script (`…/part4a-fix3/tools/extract.py`, revision 1's, unchanged) rebuilt every file from this
document's text, applying the replacements of Tasks 11, 12 and 14 in order; each of the 60 Go,
`go.mod` and `go.sum` files matched, byte for byte, the tree the fixes were developed and tested in
(`…/part4a-fix3/keyd`), and every task's intermediate tree passed `go vet ./...`. Tasks 1 to 12 are
byte for byte as revision 2 left them (each `### Task` section hashes the same).

```text
$ go version
go version go1.27.1 darwin/arm64
$ gofmt -l .
$ go vet ./...
$ GOOS=darwin GOARCH=amd64 go vet ./... && GOOS=linux GOARCH=amd64 go vet ./...
$ go mod verify
all modules verified
$ go test -race -count=1 ./...
ok  	github.com/shadowhusky/localdot/keyd/cmd/keyd	1.274s
ok  	github.com/shadowhusky/localdot/keyd/internal/admin	2.917s
ok  	github.com/shadowhusky/localdot/keyd/internal/audit	1.910s
ok  	github.com/shadowhusky/localdot/keyd/internal/cellca	1.430s
ok  	github.com/shadowhusky/localdot/keyd/internal/egress	8.690s
ok  	github.com/shadowhusky/localdot/keyd/internal/events	1.557s
ok  	github.com/shadowhusky/localdot/keyd/internal/keys	2.359s
ok  	github.com/shadowhusky/localdot/keyd/internal/llm	3.851s
ok  	github.com/shadowhusky/localdot/keyd/internal/netguard	2.179s
ok  	github.com/shadowhusky/localdot/keyd/internal/policy	2.914s
ok  	github.com/shadowhusky/localdot/keyd/internal/scrub	3.274s
ok  	github.com/shadowhusky/localdot/keyd/internal/surrogate	3.074s
ok  	github.com/shadowhusky/localdot/keyd/internal/vault	4.603s
```

- 177 top-level tests (176 pass; `TestKeychainAgainstTheLoginKeychain` skips without
  `KEYD_KEYCHAIN_TEST=1`) and 36 subtests. Stability: `go test -race -count=10 ./...` passed, and
  `go test -count=20 -cpu 1,4 ./internal/egress/ ./internal/admin/ ./cmd/keyd/ ./internal/llm/`
  passed three times. `TestScreenshotsDoNotStopATaskEarly` starts from $4.50 spent because each
  call parses a 3 MB body four times, 0.64 s under the race detector; run from $0, as review 2 ran it,
  it takes 52 calls and 34 s. `TestAMalformedImageCannotMakeAHoldNegative` parses a 3 MiB body:
  1.4 s under the race detector.
- Task by task: a script (`…/part4a-fix3/tools/replay_plan.py`) rebuilt each task's tree in order
  from this document's text alone. Before its implementation, every task's new tests failed to
  compile with the error its "see them fail" step names (Task 17's probes pass at once, as it says);
  after it, every task's tree passed `gofmt -l .` (no output), `go vet ./...`, `go test -race` on the
  task's packages and `go test ./...`, and from Task 11 on `go mod verify`.
- The tests added for review 3 fail against revision 2's code at their own task's stage. With
  Task 13's revision-2 code, `TestReadRequest` accepts the three prompt lists (as written it does
  not build, since `BodyCompletions` is new; ported to the literal `"completions"`, it runs) and
  `TestAMalformedImageCannotMakeAHoldNegative` reads the image as −2,092,316 input tokens, a hold of
  −$1.78 beside which a $4.50 request runs. With Task 14's revision-2 gateway and forwarder,
  `TestACellThatLeavesBeforeTheAnswerIsChargedItsHold` is charged $0. Against all of revision 2's
  code the `a prompt list` shape of `TestNoRequestShapeOvershootsTheBudget` reaches the provider.
  Revision 2's runs against revision 1 are in its log.
- Review 3's own probes (`…/p4a-r3/work/internal/{llm,egress}/review3_*_test.go`), run unchanged
  and, as review 3 ran them, without the race detector: `TestReview3InvalidUTF8MakesTheInputNegative`
  (now 4,784 input tokens, a $4.51 hold, nothing run or spent beside it),
  `TestReview3APoisonedImageLendsTheRoom` (each task $5.00 of $5, the day $10 of $20),
  `TestReview3APromptArrayIsACountOfAnswers` (400 `choice-count: prompt`, $0) and
  `TestReview3TheRoomsEdgesUnderConcurrency` pass. `TestReview3ClientLeavesBeforeTheHeaders` now
  stops at its third round, refused for budget, because its first two rounds were charged their
  holds, the whole $5 task; given room for its 20 rounds (its limits raised to $100, nothing else
  changed) it passes, charged $90.00 (revision 2: $0). `TestReview3AStoredConversationIsBilledButNotHeld`
  still spends $24 of $5: stored conversation state is a residual (P4a-R15), as ruled.
- Not run again: the opt-in login-keychain test (Tasks 1 to 4 are unchanged, and revision 1 ran it);
  the sealing check and Task 16's binary run, whose code and text are as revision 2 ran them.
- The suite passed from a copy at a path with a space and an apostrophe, like the worktree's.
- No line of this document spells out a backslash-u escape (the hazard behind review 1's I1), and the
  hygiene patterns under Global Constraints find nothing in the module.
- In the tests keyd reaches its fake providers over HTTP/2 with `Accept-Encoding: gzip` it set
  itself, and `TestInformationalResponseHeadersAreScrubbed` fails without `scrubbedWriter` (both
  rechecked by revision 2; this revision does not touch them): a real gap that
  `httputil.ReverseProxy`'s 1xx relay opened, closed in Task 10.
