# Part 4a plan — revision 1 change log (review-1 fixes under rulings P4a-C1 to P4a-C4; line numbers refer to the revised plan, 13,254 lines)

Inputs: `part4a-review-1.md`, `part4a-rulings.md`, the spec, the planner's verified tree
(`scratchpad/part4a-verify`) and the reviewer's probes (`scratchpad/review-probe/keyd`). All work was
done in `scratchpad/part4a-fix` (`keyd/` the developed module; `orig-keyd/` the first draft rebuilt
from its text; `plan-build/` the module rebuilt from the revised text; `tools/` the scripts named
below). No git repository was touched.

## Structure

- The old Task 10 is split as review M13 asked: **Task 10** (5513) is the listener, token, the
  self-test name and plain HTTP; **Task 11** (7003) is CONNECT through goproxy and SNI-checked
  passthrough, with the goproxy pin, `go.sum`, the iron-proxy license and `THIRD-PARTY.md`. Old
  Tasks 11–16 are now 12–17, and every task reference was renumbered.
  - Until Task 11 the listener answers CONNECT with 405. Task 11 adds goproxy to `cell.go` with four
    replacements (7445–7491): the import, the `connect` field, `Open`, and `ServeHTTP`.
  - `ReasonNotTLS` and `ReasonSNIMismatch` moved to `connect.go`, so Task 11's red step is a build
    failure (`connect_test.go:101:27: undefined: ReasonSNIMismatch`).
  - `msSince` moved from `connect.go` to `forward.go`, which Task 10 needs.
  - `TestKeydNeverDialsThroughAnotherProxy` moved to `connect_test.go` (7210), because it uses https.
- `(*Cell).Revoke` moved from `manager.go` (old Task 14) to `cell.go` in Task 10 (6487–6497), next
  to the generation it replaces. Task 14's I2 test needs it, and the I2 fix and its test belong in
  Task 14. A new Task 10 test pins it: `TestRevokeEndsUpstreamRequestsAndKeepsTheListener` (6222–6249).
- Every code block was regenerated from the developed module (`tools/stage.py`, `tools/revise.py`).
  The plan's text rebuilds that module byte for byte, at every task (Verification below).

## Critical and Important (P4a-C1)

### C1 — long values split by `security -i`, and the tail echoed in an error (Task 2)

- **The bug in the tool.** `security -i` runs 4,095 characters of a line as one command and the rest
  as another, and the exit status is the last command's. A probe of the real tool, with throwaway
  items, showed both: a failing command mid-session still exits 0. The `-w` prompt (value on stdin)
  was tried as well, and it silently cuts a value to 128 characters (8,192 bytes stored as 128). So
  the fix chunks the value.
- **`keychain.go`** (Task 2, from 1016):
  - Values go in 1,536-byte chunks: `chunkBytes` and `maxChunks` (1039). Each chunk is its own item,
    `<id>.<n>` = `<write id>:<hex>`, written in its own one-line `security -i` session, so the exit
    status means something. The item `<id>` = `keyd:<write id>:<count>` is written last.
  - `Put` (1059–1081) reads the value back and compares, then deletes chunks a longer value left.
  - `Get` refuses a chunk from another write as torn, never returning a mixed value. `Delete` removes
    the item and every chunk index.
  - `run` (1138–1152) never captures the tool's output. An error names only the operation, the item
    and the exit status.
  - The longest command line is about 230 characters plus 3,072 of hex.
- **Admin reply** (Task 16): `putSecret` logs a vault failure and answers 500 `vault` with the fixed
  message "the secret could not be stored" (11972), so no error text reaches the daemon.
- **Tests** (Task 2):
  - The fake `security` (754) now emulates the real tool's 4,095-character split with `fold -w 4095`.
    It names an unknown command in its error, as the real tool does, and exits with the last command's
    status. `FAKE_FAIL=add` makes it print what it was given and fail.
  - `TestKeychainKeepsLongValuesWhole` (864–886) round-trips 3,000 and 8,192 bytes, then shows a short
    value leaves only the item and one chunk.
  - `TestKeychainErrorsNeverCarryTheValue` (888–911) checks that no error carries any 8 bytes of the
    value or 16 characters of its hex (`carries`, 822–835). It covers a failing tool and a torn chunk.
  - The opt-in `TestKeychainAgainstTheLoginKeychain` (924–948) stores 26, then 8,192, then 26 bytes,
    reads each back, deletes, and checks nothing of the service is left.
  - Step 4 now expects 12 tests (1407).
- **Against the first draft** (fake tool):
  - `Put of 3000 bytes: keychain: store weather: exit status 1: security: unknown command "5767…"`.
    The error carries the value's hex tail.
  - `Put through a failing tool: … add-generic-password: cannot store 6161…`.
- **Against the first draft** (real login keychain, opt-in test): it fails with
  `security: unknown command "666e52…"` and `…: returned 1`. Both opt-in runs left nothing behind
  (`security find-generic-password -s localdot-keyd-test` exits 44).
- **Prose**: Task 2 intro (517), Interfaces (532), R3 (13043), R23 (13166), Interfaces "Running keyd"
  (12776), Review Focus 10 (174).

### C2 — path and method limits bypassed (Task 9, pinned again on the wire in Task 12)

- **`inspect.go`** (Task 9):
  - `permitted` (5317–5325) replaces the bare `Permits` call.
  - For a path-limited binding, `unambiguousPath` (5329–5340) refuses as `surrogate-policy`:
    - a raw path holding `%2e`, `%2f`, `%5c`, `%25` (double encoding) or `%00`, in any case;
    - a decoded path that is not printable ASCII (NUL, overlong UTF-8, fullwidth dots) or holds `;` or
      a backslash;
    - a decoded path that is not clean, so dot segments and doubled slashes are refused. One trailing
      slash is allowed, but not `//`.
  - For a method-limited binding, `overridesMethod` (5344–5355) refuses `X-HTTP-Method-Override`,
    `X-HTTP-Method` and `X-Method-Override`, and a `_method` query parameter, encoded or not.
- **`binding.go`** (Task 9):
  - `Permits` (4971–4982) matches a prefix on a segment boundary: `/v1` permits `/v1` and `/v1/x`,
    never `/v1-admin`.
  - Binding path prefixes must now be printable ASCII without `;`, a backslash or `%` (5119).
    Otherwise a binding the request rule refuses could never match.
- **Tests**:
  - `TestInspect` gained 21 placements, 50 in all (4772–4792): dot segments, `%2e%2e` in both cases,
    `%2f`, an encoded slash on a clean path, `%252e`, `%5c`, raw backslashes, NUL, `//`, `..;`, `;x=1`,
    a lower-case method, the override header, `_method` raw and encoded, a `/v1` prefix permitting
    `/v1` and refusing `/v1-admin`, and a trailing slash allowed.
  - `TestHTTPRecords` (4589) checks the segment boundary and refuses `;`, backslash and `%` binding
    paths.
  - Task 12's `TestPathAndMethodLimitsHoldOnTheWire` (7821–7853) sends the review's three probes and
    four more over a real intercepted tunnel, then a path inside the limit.
- **Against the first draft**:
  - `TestInspect` allowed every new path and method case (`dot segments: {Allow:true …}` and the rest).
  - `TestPathAndMethodLimitsHoldOnTheWire` got `200` for all seven URLs and the override, and
    `the upstream got the real key 8 times`.
  - `TestHTTPRecords`: `a path prefix must end at a segment`.
- **Prose**: Task 9 intro (4480), Interfaces (`Permits`, `FromRecord`), Review Focus 3 (128),
  Interfaces "Record" paragraph.

### I1 — the scrubber missed common escapes; `jsonGo` was a no-op (Task 7)

- **`scrub.go`** (from 3839):
  - The fixed percent and JSON replacers are gone. `match` (3966–3997) matches every needle — plain,
    hex, base64, base64 cores — with each byte either raw or in any of its `escapes` (4067).
  - `escapes` covers each printable byte outside `A–Z a–z 0–9 -._~`:
    - `%XX` in both cases, and `+` for a space;
    - backslash-u in both cases, and `\"`, `\\`, `\/`;
    - `&#N;`, `&#0NN;`, `&#xH;` in both cases, and `&amp; &lt; &gt; &quot; &apos;`.
  - Matching runs per byte, so mixed encoders are covered, and the streaming hold-back works for
    escaped forms too.
  - `New` refuses a replacement with any character an encoder would escape (3886). The surrogate and
    `keyd-redacted` qualify, so the raw replacement fits every form.
- **The authoring hazard**: the backslash-u spellings are built as `` `\` + "u%04X" `` and never
  written out. The plan text and the module contain no backslash-u-plus-hex sequence (`grep -P` count 0).
- **Tests** (Task 7):
  - `punct` (3534) holds `< > & + ' " / = space \`.
  - `TestEscapedReflectionsAreReplaced` (3619–3642) covers seven encoders: Go's `json.Marshal` (it
    first asserts Marshal escapes `<` and `&`, so this case can fail), .NET's form via `dotnet`
    (upper-case backslash-u for `<>&'"+` and the backtick), `html.EscapeString`, `url.QueryEscape`,
    `encodeURIComponent` and Python's `quote` via `percentEncode`, and lower-case percents.
  - `TestEscapedReflectionsStreamLikeOneShot` (3644–3659) splits a body of four escaped echoes at
    every byte and checks byte-by-byte delivery.
  - `TestNewRefusesShortSecretsAndEmptyIsANoOp` now also refuses the replacement `a/b`.
- **Against the first draft**: six of seven forms passed unchanged (`Go's json.Marshal: … -> …`
  unchanged, likewise .NET, HTML, `encodeURIComponent`, Python's `quote`, lower-case percents). Only
  `url.QueryEscape` matched. The stream test failed too.
- **Prose**: Task 7 intro (3480), Interfaces, R18 (13138), Review Focus 1.

### I2 — a gateway request inspected before Stop reached the provider after it (Task 14)

- **`gateway.go`**:
  - `serveGateway` takes `g := c.current()` first (10404).
  - It checks `g.ctx.Err()` just before the relay and refuses with 503 `revoked` (10496).
  - It relays with `gen: g` (10501).
  - The budget wait in `reserve` (10507–10531) is cancelled by Stop too, and also answers 503 `revoked`.
- **Test** (Task 14): `TestARequestInspectedBeforeStopNeverReachesTheProvider` (9893–9927), the
  reviewer's probe.
  - The body is held open on a pipe; Stop runs as `Manager.Revoke` does for the cell; then the body
    finishes.
  - It asserts the provider was not reached, and that the answer is 503 `revoked`. A 403
    `unknown-surrogate` would mean the request was inspected after Stop and the test proved nothing.
- **Against the first draft**: `the provider was reached after Stop, with X-Api-Key "real-secret-value-for-test"`.
- **Related**: R20's second change ends the task on revoke (below).

### I3 — budgets overshot by concurrency; a cut stream under-charged (Tasks 13 and 14)

- **Design.** The fix reserves each request's maximum cost rather than capping in-flight requests.
  - A cap of 4 would still let four requests spend past a limit. A reservation is exact for any
    request whose usage stays within its own bounds.
  - Waiting, rather than refusing, keeps concurrency from stopping a task early.
- **`budget.go`** (Task 13, from 9003):
  - `Reserve(ctx, cell, hold)` (9138–9154) holds the request's ceiling against the task and the day.
    - It admits a request that fits beside the running ones.
    - It waits (a change channel, woken by every settle, `Begin`, `End` and `Charge`) while running
      requests hold the room.
    - It refuses with 402 and `NeedUSD` (9029) a request that could not fit even alone, and every
      request once a limit is spent.
  - `Uncapped` (9021) holds everything left in the task, so such a request runs alone. It is the only
    way past a limit, by its own cost.
  - `Hold.Settle`/`Release` (9244–9259) release the hold and charge the task the request was held
    for, and the day. Holds carry over midnight.
- **Ceiling and caps** (Task 13):
  - `Price.Ceiling` (8991–8994) prices the body's bytes at three a token, at the dearer of the input
    and cache-write prices, plus the output cap at the output price.
  - `OutputCap` (9477–9497) reads the largest of `max_tokens`, `max_completion_tokens`,
    `max_output_tokens` and Gemini's `generationConfig.maxOutputTokens`. Any letter case and
    underscores are accepted, and duplicates are seen.
- **Gateway** (Task 14):
  - `reserve` (10507–10531) holds the ceiling, or `Uncapped` when the body names no cap and the
    model charges for output.
  - `gatewayMeter.settle` (10587–10612) settles the hold. A stream that did not end cleanly is
    charged at least `Estimate(in, out).Output` for output, marked `usage: "estimated"`.
  - The Task 14 edit to `forward.go` passes `eof && err == nil` as `clean` (10344).
  - The 402 body carries `needUSD` (10559).
- **Tests**:
  - Task 13 (8592–8728) has five budget unit tests:
    - `TestHoldsKeepRequestsSideBySideWithinTheTaskLimit`;
    - `TestParallelReservationsNeverOvershoot` (20 goroutines: $4.50 spent of $5, exactly);
    - `TestTheDayHoldsAcrossCells`;
    - `TestAnUncappedRequestRunsAloneInItsTask`;
    - `TestAWaitingRequestStopsWhenItsTaskEnds`.
  - Task 13 also adds `TestCeilingIsTheMostARequestCanCost` (8418–8426) and `TestOutputCap`
    (8770–8789).
  - Task 14's gateway tests:
    - `TestParallelRequestsCannotOvershootTheTask` (9981–9994): 20 at once, one 200, nineteen 402,
      spent ≤ $5.
    - `TestParallelRequestsFromManyCellsCannotOvershootTheDay` (9996–10014): five cells against a $10
      day, two 200, three 402.
    - `TestRequestsWithoutAnOutputCapRunOneAtATime` (10016–10030): the provider never holds two at
      once; spent ≤ limit + one request.
    - `TestACutStreamIsChargedAtLeastWhatItRelayed` (9862–9891) replaces
      `TestAMidStreamFailureEndsTheStreamAndChargesWhatWasReported`, whose old expectation was the
      defect.
- **Against the first draft**:
  - `statuses map[200:20]; the task spent $90.00 of $5.00`.
  - `statuses map[200:5]; the day spent $22.50 of $10`.
  - `5 at once; statuses map[200:5]; the task spent $22.50 of $5.00`.
  - The cut stream was charged what `message_start` reported (3015 micro-dollars, below the byte
    estimate).
- **Residual** (stated in R15): a hold can fall short when a provider bills more input than the
  body's bytes suggest (server-side tools, documents). Requests near a limit with large caps wait, or
  are refused before the limit is reached.
- **Prose**: Task 13 intro (8285) and Interfaces (8313), Task 14 intro (9557), Interfaces, R15
  (13110), Interfaces "Budgets under concurrency" (12922), 4b obligation for output caps (13011).

## Decision changes (P4a-C2)

- **R1**: accepted as written. No change.
- **R2** (13033), with review M6 (Task 3):
  - The seal's AAD is now `localdot-keyd seal v1:` followed by the JSON array
    `[id, kind, provider, baseURL, hosts, header, format, methods, paths]`. `sealAAD` (1703–1709)
    writes it without HTML escaping, and `""`/`[]` stand for what is absent.
  - `Open(s, rec Record)` and `Seal(publicKey, rec Record, plaintext)` take the record.
  - The Interfaces JS snippet builds the same array (12845). The note at 12834 says the record sealed
    for is exactly the one the daemon sends.
  - `TestOpenRefusesAnotherBindingKeyOrBytes` (1480–1525) refuses another id, other hosts, a host
    added, another header or format, and a dropped method limit.
  - `TestOpenAcceptsWhatWebCryptoSeals` (1528–1567) has two fresh Node 25.6.0 vectors: an LLM record,
    and an HTTP record with two hosts, `methods` and a path holding `&`. The second pins Go's encoder
    against `JSON.stringify`.
  - Callers changed: `putSecret` and the admin and command tests. A `record(id, fields)` helper is at
    11445.
  - Trust rule 3 is amended (below).
- **R8 and R9** (13073, 13081): the spec's "never passed through" now covers the request line and
  headers of traffic keyd terminates. R9 records the residual risk: responses on passthrough names
  are never scrubbed. Spec amendment below.
- **R5** (13058), with review M1 (Task 8):
  - `validName`'s last label must be letters or start `xn--` (4449). This refuses `0x7f.0x1` and
    `0x7f.0x0.0x0.0x1`, which macOS resolves to 127.0.0.1 (review probe), and `api.example.c0m`.
    `xn--d1acufc.xn--p1ai` is accepted.
  - Tests: `TestParseHostPortRefusesWhatPolicyCannotName` (4173), `TestParseHostPortNormalisesNames`,
    `TestValidBindingHost`.
  - Against the first draft, `ParseHostPort("0x7f.0x1:443") reason ""` and
    `0x7f.0x1 accepted as a binding host`.
  - R5 records what still works and what fails. Spec amendment below.
- **R15** (13110): changed. See I3.
- **R20** (13153): changed, in three parts.
  1. The I2 race is fixed (above).
  2. `Manager.Revoke` ends the cell's task (11134–11144), so the keyless `lmstudio`/`ollama` routes
     stop. Its audit detail reads `… surrogate(s) dropped, task ended`.
     - Test: `TestRevokeIsTheKillSwitch` begins a task and asserts it is gone after Revoke (10899).
     - Against the first draft: `the task outlived the kill switch: &{ID:t1 LimitUSD:5 SpentUSD:0}`.
  3. The Part 4b obligations say Stop must also pause or stop the cells' processes, because the
     listener stays open (research §3.10) (13007). The Task 15 intro says the same (10666).

## Minors (P4a-C3)

- **M1**: applied. See R5.
- **M2** (surrogate text in the audit log and `key.use`): applied.
  - `audit.Write` redacts surrogate-shaped text in method, host, path, SNI, route, model and detail to
    `surrogate:<ID>` (`redact`, 2925–2932), and returns the line as written.
  - `Cell.record` builds `key.use` from the written line (6573).
  - `scan` reads `u.Host` (5418). `servePlain` inspects before checking the host (6687), so a
    surrogate in a host name is refused and alerted, not taken as `host-invalid`.
  - Tests: `TestSurrogatesAreWrittenAsTheirIDs` (2605–2619);
    `TestSurrogateTextNeverReachesTheAuditOrTheEvents` (6090–6115), for a path and a host name;
    `TestInspect` "in the host name"; an S4 probe (12714); and the S4 audit check, which now scans the
    file for any surrogate shape (12724).
  - Against the first draft: the audit held `/keys/ld_key_…` and `key.use` carried it; a host-name
    surrogate got `host-invalid` with no alert.
  - Side effect: the gateway case "desktop cells have no gateway" sent the brain's surrogate, and is
    now refused as `misplaced-surrogate`. It is split into a no-surrogate case (`host-denied`) and a
    foreign-surrogate case (9774).
- **M3** (stacked encodings): applied. `identity` (6920–6929) checks every `Content-Encoding` line
  and every listed coding. `TestAnUnrequestedEncodingIsRefused` (6183–6206) covers `br`, `identity` +
  `gzip` on two lines, and `identity, gzip`. Against the first draft: `stacked: 200`. R10 (13088).
- **M4** (audit failures fail closed): applied.
  - `Log` keeps `size` and `err`. A failed write is cut back to the last good line before the next
    write, and `Err` stays set until a write succeeds (2869–2916; `file` interface 2779).
  - `Cell.swap` (6740–6751), used by `forward` and the gateway, refuses with 503 `audit-unavailable`
    while `Err` is set.
  - `/v1/status` reports `"audit":{"ok","error"?}` (11909).
  - Tests: `TestAFailedWriteIsCutOffReportedAndCleared` (2582–2603, a partial write by a failing
    file); `TestSwapsStopWhileTheAuditLogCannotBeWritten` (7855–7868); `TestStatus` (11479).
  - Against the first draft: `200 "", upstream reached 1 times`. The audit test fails to build (no
    `Err`).
  - The residual is stated in R17 (13129): the first swap after the disk fills goes out unrecorded,
    because a swap's line is written when its response ends.
- **M5** (no peer check on the admin socket): applied as the review's second option, "record the
  choice": new decision P4a-R25 (13175). A `LOCAL_PEERCRED` check would add `golang.org/x/sys` and
  admits every process of the same user anyway. Task 16's intro cites it.
- **M6**: applied. See R2.
- **M7** (record what R3 costs): applied in the plan, not in the spec.
  - R3 (13043) and the Interfaces "Not in 4a" bullet (12791) say any process of the user, the daemon
    included, can read every key with `security find-generic-password -w`. So trust rule 3 holds
    against accidental exposure, not against a compromised daemon, until M9's signed binary owns the
    items.
  - **Not applied: the line in the spec's risks.** The instructions limit spec edits to the
    amendments the rulings name (trust rule 3 for R2, R8/R9, R5), and this is not one of them.
    Proposed line for the spec's "Risks and open questions":
    > - keyd's Keychain items trust `/usr/bin/security` until M9, so any process of the user, the
    >   daemon included, can read every key with `security find-generic-password -w`; trust rule 3
    >   holds against accidental exposure, not against a compromised daemon. M9 replaces the store with
    >   a Security.framework one whose ACL names the signed keyd.
- **M8** (CA EKU): applied. The CA's `ExtKeyUsage` is `[ServerAuth]` (3366).
  `TestTheCAVouchesOnlyForServers` (3216–3229) shows forged client-auth, code-signing and
  email-protection leaves fail with `IncompatibleUsage`. Against the first draft:
  `CA extended key usage [], want server auth only`.
- **M9** (case-variant model keys): applied. `ModelFromJSON` (9446–9469) refuses a second
  case-insensitive `model` (`ErrDuplicateModel`) and a lone non-lower-case one. Test cases are in
  `TestModelFromJSON` (8758). Against the first draft: `a model named in two letter cases: <nil>` and
  `a model named in capitals was accepted`.
- **M10** (one bad escape hides the rest): applied. `unescape` (5359–5375) decodes valid `%XX` pairs
  and leaves the rest, and `scan` uses it. Test: `TestInspect` "percent-encoded after a bad escape"
  (4792). Against the first draft: `{Allow:true …}`.
- **M11** (brain cells hold HTTP secrets): applied as the review's first option. The manager refuses
  an HTTP secret for a role without the web (11261). New decision P4a-R26 (13180); Task 15 intro;
  Interfaces roles (12896). Test: `TestOpenValidates` "http on brain" (10806). Against the first
  draft: `http on brain: Open succeeded`.
- **M12** (local model servers fixed): applied as notes in R14 (13102) and the Interfaces "Not in 4a"
  bullet (12791). M4 adds configurable local routes.
- **M13** (plan quality): applied.
  - Task 10 is split (see Structure).
  - The review's weak tests are replaced:
    - the JSON case, by the escape tests that assert Go escapes;
    - the line-reading fake, by the 4,095-split fake;
    - sequential-only budget tests, by the parallel and holding tests;
    - the kill-switch test that never revoked an inspected request, by the I2 test;
    - S4's audit check of its own probes, by the file-wide surrogate scan.
  - Every review probe (C1, C2, I1–I3, M2, M3) is a test.
- **M14** (interfaces for 4b): applied in "Interfaces Part 4b builds on". It now gives:
  - Stop's full obligation (13007);
  - the Keychain layout and the real 8,192-byte limit (12776);
  - the budget's concurrency semantics, `needUSD` and output caps (12922, 13011);
  - `key.use` host, method and path as cell-controlled text (12989);
  - the status `audit` field and the `audit-unavailable` reason.
- **Applied as asked, none skipped.** M5 took the "record" option and M11 the "refuse" option, both
  offered by the review. Only M7's spec-risk line is not in the spec, for the reason above.

## Other changes found while verifying

- **A flake the first draft had.** `TestAClientDisconnectStopsTheProvider` returned while keyd was
  still settling the request. The budget's `spend.json` temporary file then landed in a folder that
  `t.TempDir` was removing (`TempDir RemoveAll cleanup: … directory not empty`).
  - Measured with `go test -count=300 -cpu 1,4 -run TestAClientDisconnectStopsTheProvider`: 9 of 600
    runs failed on the first draft's code, and 0 of 600 after the fix.
  - Fix: the test waits for the request's audit line, which keyd writes after the charge (10058).

## Spec amendments (P4a-C2)

In `specs/2026-09-30-localdot-core-design.md`, nothing else changed:

1. Trust rule 3 (lines 149–153):
   > 3. **Only keyd holds secrets.** It runs on macOS outside Docker's VM, so a container escape finds
   >    none. The daemon never sees a plaintext secret either: the key form in the UI seals the key to
   >    keyd's per-boot public key, bound to the secret's id and binding, and the daemon only relays the
   >    ciphertext to keyd's admin socket, which no browser can reach (amended 2026-10-01, Part 4a
   >    review).
2. Key layer, "Swap rules" (the bullet at line 494; the amended sentences are 498–506), R8/R9 with
   the residual risk:
   > … An unknown or misplaced surrogate in the request line or headers of traffic keyd terminates
   > (plain HTTP, intercepted hosts, the LLM gateway and the CONNECT request itself) is blocked and
   > alerted, never passed through. Request bodies are not scanned, because prompts may quote
   > surrogates, and keyd cannot see inside a passthrough tunnel; a surrogate in either leaves
   > unswapped and is worthless off the Mac. Residual risk: responses on passthrough names are never
   > scrubbed, so if a service stores a header keyd sent to a bound host and shows it under another,
   > unbound name, keyd cannot remove it (amended 2026-10-01, Part 4a review). …
3. Key layer, "Default egress" (lines 525–529), R5's narrowing:
   > … Signed-in browser → the web. Every cell reaches hosts by name only: no IP literals or addresses
   > spelled as names (`127.1`), CONNECT only to port 443 and plain HTTP only to port 80, so odd ports,
   > IP-literal URLs and `ws://` fail (amended 2026-10-01, Part 4a review).

For P4a-C4, a one-line notice the controller can give the user: "keyd's 'never passed through' now
covers the request line and headers of traffic it terminates; surrogates in request bodies or inside
passthrough tunnels leave unswapped (worthless off the Mac) — veto if you want those blocked too."

## Verification

All runs used Go 1.27.1 (`/opt/homebrew/bin/go`) on the development Mac.

- **The module rebuilt from the plan text.**
  - `tools/extract.py plan 17 plan-build` followed by `tools/compare.py plan-build keyd`:
    `differ: []`, `identical: 58`. Every Go, `go.mod` and `go.sum` file matches the developed tree.
  - `tools/verify_stages.py`: `stages checked: 17, differing: 0`, so every task's intermediate tree
    matches as well.
  - The same extractor reproduces the first draft's verified tree exactly
    (`identical: 58`, against `part4a-verify/keyd`).
- **Full suite in `plan-build`:**

```text
$ go version
go version go1.27.1 darwin/arm64
$ gofmt -l .
$ go vet ./...
$ GOOS=darwin GOARCH=amd64 go vet ./... && GOOS=linux GOARCH=amd64 go vet ./...
$ go mod verify
all modules verified
$ go test -race -count=1 ./...
ok  	github.com/shadowhusky/localdot/keyd/cmd/keyd	1.403s
ok  	github.com/shadowhusky/localdot/keyd/internal/admin	2.097s
ok  	github.com/shadowhusky/localdot/keyd/internal/audit	2.232s
ok  	github.com/shadowhusky/localdot/keyd/internal/cellca	1.650s
ok  	github.com/shadowhusky/localdot/keyd/internal/egress	4.278s
ok  	github.com/shadowhusky/localdot/keyd/internal/events	2.459s
ok  	github.com/shadowhusky/localdot/keyd/internal/keys	2.968s
ok  	github.com/shadowhusky/localdot/keyd/internal/llm	4.235s
ok  	github.com/shadowhusky/localdot/keyd/internal/netguard	3.900s
ok  	github.com/shadowhusky/localdot/keyd/internal/policy	2.698s
ok  	github.com/shadowhusky/localdot/keyd/internal/scrub	3.540s
ok  	github.com/shadowhusky/localdot/keyd/internal/surrogate	4.239s
ok  	github.com/shadowhusky/localdot/keyd/internal/vault	5.581s
```

- **Counts** (`go test -json`): 166 top-level tests (165 pass, 1 skip, the opt-in Keychain test) and
  22 subtests. By package: surrogate 8, vault 15, netguard 13, audit 8, events 3, cellca 9, scrub 11,
  policy 7, keys 8, egress 58, llm 16, admin 7, cmd/keyd 3.
- **Stability:**
  - `go test -race -count=10 ./...` passed.
  - `go test -count=20 -cpu 1,4 ./internal/egress/ ./internal/admin/ ./cmd/keyd/ ./internal/llm/`
    passed three times.
  - `go test -count=5 -race -cpu 1,4` on egress, llm, scrub and audit passed.
- **Task by task, from the plan text alone** (`tools/replay_plan.py`). Red is the previous stage plus
  the task's test files. Green is the task's stage, checked with `gofmt -l .`, `go vet ./...`,
  `go test -race` on the task's packages and `go test ./...`, plus `go mod verify` from Task 11.

| Task | Red: first error (the step's named failure) | Green, top-level tests in the task's packages |
|---|---|---|
| 1 | `surrogate_test.go:12:14: undefined: Mint` (checked by hand) | surrogate 8 |
| 2 | `vault_test.go:15:35: undefined: Store` | vault 12 (1 skipped) |
| 3 | `seal_test.go:13:12: undefined: NewOpener` | vault 15 (1 skipped) |
| 4 | `guard_test.go:13:15: undefined: Guard` | netguard 13 |
| 5 | audit `undefined: Log`, `undefined: Open`; events `undefined: Event` | audit 8, events 3 |
| 6 | `cellca_test.go:18:15: undefined: CA` | cellca 9 |
| 7 | `scrub_test.go:27:30: undefined: Scrubber` | scrub 11 |
| 8 | `policy_test.go:9:22: undefined: Target` | policy 7 |
| 9 | `inspect_test.go:14:46: undefined: Binding` | keys 8 |
| 10 | `cell_test.go:38:19: undefined: Cell` | egress 16 |
| 11 | `connect_test.go:101:27: undefined: ReasonSNIMismatch` | egress 23 |
| 12 | `mitm_test.go:39:65: unknown field CA in struct literal of type Config` | egress 37 |
| 13 | `budget_test.go:16:55: undefined: Budget` | llm 16 |
| 14 | `gateway_test.go:75:7: deps.Budget undefined (type Deps has no field or method Budget)` | egress 51 |
| 15 | `manager_test.go:26:33: undefined: Manager` | egress 57 |
| 16 | cmd `undefined: start`, `undefined: Config`; admin `undefined: Server` | admin 7, cmd/keyd 3 |
| 17 | passes at once, as the step says | egress 58 (S4: 15 subtests) |

Every green check passed at every task.

- **New tests against the first draft's code** (`orig-keyd`, rebuilt from the first draft's text, with
  the revision's test files). The failures are quoted under each finding above.
  - Failing at runtime:
    - Keychain: the fake tool and the real one.
    - keys: `TestInspect`, `TestHTTPRecords`.
    - scrub: both escape tests.
    - policy: two tests.
    - cellca: one test.
    - llm: `TestModelFromJSON`, with `TestOutputCap` removed to compile.
    - audit: `TestSurrogatesAreWrittenAsTheirIDs`, with the failing-file test removed to compile.
    - egress: 12 tests (listed under each finding).
  - Failing to build, because the API changed:
    - `vet: internal/audit/audit_test.go:174:2: undefined: file`;
    - `internal/llm/budget_test.go:34:14: b.Reserve undefined`;
    - `internal/vault/seal_test.go:17:32: cannot use weatherRecord … as string value in argument to Seal`;
    - the same for `admin_test.go` and `main_test.go`.
- **Real Keychain** (opt-in, throwaway items under service `localdot-keyd-test`, fake values only):
  - `KEYD_KEYCHAIN_TEST=1 go test -count=1 -run LoginKeychain -v ./internal/vault/` gives
    `--- PASS: TestKeychainAgainstTheLoginKeychain (1.18s)` in `plan-build`.
  - `security find-generic-password -s localdot-keyd-test; echo $?` then prints `44`.
  - The same test fails on the first draft's `keychain.go`, also leaving nothing behind.
  - Earlier manual probes of `/usr/bin/security` (the `-i` exit status, the 128-character `-w`
    prompt) used throwaway items and left nothing (`44`).
- **Sealing.** Node 25.6.0 ran the plan's own snippet, extracted from the plan text. A fresh seal for
  an HTTP record with an `&` in a path gave:
  - `fresh WebCrypto seal opened: "fake-key-from-webcrypto" <nil>`;
  - `the same blob under other hosts: vault: cannot open the sealed secret`.
  - Both vectors in `seal_test.go` came from the same function.
- **Task 16's binary run** (`-vault memory`, ports 4790–4799):
  - `keyd ready socket=/tmp/kdh-…/keyd/admin.sock boot=454bd72e5615827d`.
  - Status `{"audit":{"ok":true},"bootId":…,"limits":{"perTaskUSD":5,"perDayUSD":20},"sealKey":…}`.
  - `Opened` starts `{"cellId":"c1","port":4795,"proxyToken":"…`.
  - File modes: `srw-------` socket, `-rw-------` audit and lock, `-rw-r--r--` `ca.pem`.
  - After the kill, `audit ok: 4 lines`.
- **Odd path.** The suite passed (`go test -race -count=1 ./...`, 13 `ok`) from a copy at
  `…/part4a-fix/odd path's dir/keyd`.
- **Scans.**
  - `grep -cP '\\u[0-9a-fA-F]{4}'` over the plan and the module's Go files gives 0.
  - The repository's hygiene patterns (`scripts/check-hygiene.mjs`, read only) find nothing in the
    module. The plan's only hit is its own Global Constraint naming the forbidden names, which the
    first draft has too.
- **Rechecked from the first draft's verification.**
  - The fake providers speak HTTP/2 to keyd (`upstream saw HTTP/2.0`).
  - Without `scrubbedWriter`, `TestInformationalResponseHeadersAreScrubbed` fails
    (`early hints ["<https://cdn.example.test/app.js?k=real-secret-value-for-test>; rel=preload"]`).
