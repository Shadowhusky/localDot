# Part 4a Task 10 (cell listener), fix round 1: report

**Status: DONE_WITH_CONCERNS.** All 5 items are applied, and each is pinned by a test that fails on the base. The concerns are notes for later tasks; nothing is left open in this round.

Branch `claude/part4a-task10-fix`, base `b5e80a4` (the merge of Task 9 fix and Task 10). The per-request dial deadline (progress CARRY) was not applied.

## Commits (oldest first)

| sha | commit | item |
|---|---|---|
| `30b5e59` | fix(keyd): count a request body atomically while the transport sends it | 1 |
| `354ee5b` | fix(keyd): refuse a protocol switch to a host a secret is bound to | 2 |
| `7c5180e` | fix(keyd): find a surrogate in a header name in any case | 3 |
| `d254901` | fix(keyd): pass OPTIONS * to the listener's token check and audit | 4 |
| `d7f4f20` | fix(keyd): match keyd.ldot in ASCII letters and on port 80 only | 5 |
| `18e2a47` | test(keyd): pin that a refused upgrade closes the cell's connection and keyd.ldot: is not internal | 2, 5 (test only) |

Each fix commit holds its fix and its pins. The production files changed are `egress/forward.go`, `egress/cell.go`, `egress/internal.go`, `keys/inspect.go` and `keys/registry.go`. The pins are in `egress_integrity_test.go` and `keys_integrity_test.go`, and the brief's tests are unchanged.

## Per item

**1. Data race (Important).**
- **Change.** `counter.n` is now an `atomic.Int64` (`Add` in `Read`, `Load` in `finish`).
- **Pin.** `TestAnEarlyAnswerDoesNotRaceTheRequestBodyCount`: 20 streaming POSTs, the body running until the answer arrives. A raw upstream answers 204, or 200 `early`, as soon as it has read the head.
- **RED** (b5e80a4, `-race`): `WARNING: DATA RACE` ×6, read at `forward.go:121` (finish) against the write at `forward.go:340` (counter.Read), ending in `race detected during execution of test`. Without `-race` the pin passes on the base, because the race detector is what fails it.
- **GREEN:** passes at `-race -count=30`.

**2. Plain-HTTP upgrade to a bound host (Important).**
- **Change.** A new function, `refusesSwitch(d)`, returns true when `d.Scheme != "http"`, when `c.intercepted[d.Host]` is set, or when `boundTo(d)` is non-empty. `boundTo` returns the records `scrubberFor` scrubs; `scrubberFor` now takes that list, so the two cannot drift.
  - **Before the dial:** `forward` answers an upgrade (`isUpgrade`) that `refusesSwitch` refuses with **403 `upgrade-refused`**, an audit line, `Connection: close`, and no dial.
  - **At the 101:** `ModifyResponse` checks `refusesSwitch` again, which catches a secret bound while the request was in flight. It returns `errSwitch`, and the result is **502 `upgrade-refused`**, decision `deny`, with `Connection: close` to the cell. ReverseProxy closes the upstream connection.
  - **Lifting it:** the doc comment on `refusesSwitch` says Tasks 11 and 12 may lift the bound-host refusal once interception fills `c.intercepted` and a switched stream is scrubbed.
- **Pins:**
  - `TestAnUpgradeToABoundHostIsRefusedBeforeAnyDial` sends 18 spellings × 2 target spellings (`api.example.test`, `API.Example.TEST.:80`). Each must get 403 with `Connection: close` and no echo, with 0 dials, 0 upstream hits and 36 audit lines. The spellings:
    - `Upgrade`, `upgrade` and `UPGRADE`;
    - `keep-alive, Upgrade` and `keep-alive,Upgrade`;
    - a second `Connection` line;
    - tab or space padding;
    - `Upgrade, Upgrade`;
    - two `Upgrade` lines;
    - h2c with `HTTP2-Settings`;
    - lower-case names;
    - obs-fold in `Connection` and in `Upgrade`;
    - `Proxy-Connection`;
    - `Connection: Upgrade` alone, and `Upgrade` alone.
  - `TestA101FromAHostBoundMidRequestIsRefused`: the upstream binds the secret, then answers 101 and echoes it.
  - `TestAnUpgradeToAnUnboundHostStillWorks`: 101 is relayed, `ping` echoes both ways, and the audit line is allow/101.
- **RED** (on `30b5e59`, the item 1 commit): 34 failures. The bound host relayed `HTTP/1.1 101 Switching Protocols … echo real-secret-value-for-test`, every spelling dialled (`dialled [api.example.test.:80 …]`), and the mid-request bind leaked the echo too. The unbound-host pin passes on the base as intended, since it guards a behaviour to keep.

**3. Surrogate in a header name (Minor, fixed).**
- **Change.**
  - `scan` searches `strings.ToLower(name)` and marks those finds `folded`.
  - `Inspect` resolves a folded find through the new `Registry.lookupFolded` (lower-cased token match) to the registered token. A known surrogate is then refused `misplaced-surrogate` under its own secret and surrogate ID, as it would be in a value. An unknown one is refused `unknown-surrogate`.
  - `ApplySwaps` refuses headers that hold one.
- **Pins:**
  - `keys`: `TestASurrogateInAHeaderNameIsFoundInAnyCase` covers 4 entries × 7 names (raw, canonical, upper, lower, `X-` prefix, `-Note` suffix, glued `x`), a sibling in a name next to an allowed bearer, and 3 unknown names.
  - Listener: `TestASurrogateInAHeaderNameIsRefusedAndAlerted` sends 12 raw requests. Each must get 403 and a key.use alert naming `weather` (or `unknown`), with 0 dials and no surrogate in the audit, in any case.
- **RED** (base):
  - `keys`: 40 failures, for example `in the name "Ld_key_pffh…": {Allow:true …}` and `ApplySwaps accepted it`.
  - Listener: `ld_key_…: 200 "", want 403 "misplaced-surrogate"`, `no key.use alert`, `dialled [api.example.test.:80], upstream reached true`.

**4. `OPTIONS *`.**
- **Change.** `DisableGeneralOptionsHandler: true`.
- **Pin.** `TestOptionsStarNeedsTheToken`: without the token, 407 `proxy-auth-missing` with `Proxy-Authenticate: Basic` and an audit line (OPTIONS/407/deny); with the token, 400 `bad-request`.
- **RED** (base): `200 map[Content-Length:[0] …]`.

**5. `keyd.ldot` match.**
- **Change.** `isInternal(u)`: strip one `:80`, then require ASCII only and `EqualFold`. Any other spelling goes to `servePlain`, where policy refuses it.
- **Pin.** `TestOnlyKeydLdotOnPort80IsInternal`:
  - 200 for `keyd.ldot`, `KEYD.LDOT` and `keyd.ldot:80`;
  - 403 for U+212A `Keyd.ldot` and `KEYD.LDOT`, and for ports `:8080`, `:81`, `:443`, `:080` and `:` (empty);
  - 0 dials and exactly 3 internal audit lines.
- **RED** (base): 6 targets answered `200 {"cell":"c1","ok":true}` (both Kelvin spellings and 4 ports) and `9 internal audit lines, want 3`. The `:` case was added after mutant 5e survived.

## Verification (in `keyd/`, go1.27.1; Node 24.21, pnpm 10.29.3)
- egress (39 tests) and keys (47 tests) pass at `-race -count=10`.
- The new pins pass at `-race -count=30`, and so do the existing timing-sensitive egress tests (Revoke, auth spacing, client disconnect, mid-stream, Close, Expect).
- `gofmt -l .` prints nothing.
- `go vet ./...` is clean for linux and `GOOS=darwin`.
- `go test -race ./...` passes all packages: 245 tests pass and 4 skip.
- `go mod tidy -diff` is clean.
- At the repo root, `pnpm lint` (Biome, 53 files) and `pnpm hygiene` both exit 0.

## Mutation testing (scratch copy, 26 mutants of the changed code)
**23 killed, 2 survived (equivalent), 1 did not compile (equivalent to a killed one).**
- **Killed.**
  - Item 1: count dropped; plain non-atomic count (under `-race`).
  - Item 2:
    - bound-host clause dropped;
    - pre-dial check off; 101 check off; 101 check moved to 200;
    - 101 check using the request-time snapshot only;
    - `errSwitch` unmapped, mapped as `error`, or mapped as 403;
    - either `Connection: close` dropped;
    - `boundTo` ignoring hosts.
  - Item 3: name not lower-cased; no fold resolution; `folded` flag unset; `lookupFolded` matching exactly.
  - Item 4: `DisableGeneralOptionsHandler` false.
  - Items 5a–5e: non-ASCII allowed; `Hostname()` (any port); `:80` not stripped; exact case; any `80`/`:` suffix stripped. 5e survived until the `:` case was pinned.
- **Survived, unreachable in Task 10.** In `refusesSwitch`, dropping `d.Scheme != "http"` or `c.intercepted[d.Host]`. Only `servePlain` calls `forward`, and nothing fills `intercepted`. These belong to Tasks 11 and 12.
- **Did not compile.** `lookupFolded` that never matches. It is the same as "no fold resolution", which was killed.

## Bypass hunt (loopback, around items 2–3). Everything held.
- **Upgrade spellings.** Every case is refused before any dial: all the pinned spellings, HTTP/1.0, `Keep-Alive` plus a second `Connection`, and a target written in mixed case with a trailing dot and `:80`.
- **Malformed headers.** Go answers 400 before keyd for a space or tab before the colon, NUL in a value, a leading-space first header line, and U+212A in a name.
- **Host header.** A Host header naming the bound host while the target names an unbound one is relayed. Policy follows the request-URI, which is correct.
- **h2c.** An h2c upgrade to an unbound host is forwarded as `Connection: Upgrade` / `Upgrade: h2c`, with `HTTP2-Settings` stripped. `PRI * HTTP/2.0` reaches `ServeHTTP` and gets 407.
- **Obs-fold values.** `X-Note: a\r\n ld_…` and `X-A: 1\r\n ld_…: 1` are joined into the value and refused `misplaced-surrogate` before any dial.
- **Connection-listed headers.** A surrogate in a `Connection` value, or in a header that `Connection` lists, is refused.

## Concerns (not applied)
1. **The scrub set is fixed when a request starts.** A secret bound after a 101 has been accepted does not end that tunnel. A streamed body likewise keeps the scrubber it started with. Suggestion for Task 16: when a binding changes, revoke the affected cells' generations, or the tunnels to that host.
2. **A secret bound to another host is not scrubbed in a tunnel.** An upgrade to an unbound host relays bytes unscrubbed, so a secret bound to a different host and echoed through it is not scrubbed. Plain bodies to that host are not scrubbed for it either, so this matches the existing design (scrub per destination).
3. **The bound-host refusal is broad.** It refuses every plain-HTTP upgrade to a bound host, including legitimate websockets. Bound hosts are https providers in practice. Tasks 11 and 12 decide whether to lift it.
4. **Unknown surrogate in a header name.** It is audited under the ID of its lower-cased spelling, because net/http has already lost the case. A known one resolves to its real ID.
5. **`lookupFolded` cost.** It scans the registry linearly, but only for names that contain a token shape.
6. **`Connection: close` on the pre-dial 403.** Adding it there goes beyond the ruling, which asked for it on the 101 refusal only. It is cheap and pinned.
7. **Dial deadline.** The per-request dial deadline is still a CARRY.

## Not verified
- **macOS.** No darwin test run; checked only by `GOOS=darwin go vet`.
- **Docker suites.** None exist for keyd, so this is N/A.
- **Opt-in keychain test.** `KEYD_KEYCHAIN_TEST=1` was not run.
