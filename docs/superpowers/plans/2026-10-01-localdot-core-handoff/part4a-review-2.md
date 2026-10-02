# Part 4a plan review 2: keyd core, fix pass 1

Line numbers are in the revised plan (`plans/2026-10-01-localdot-core-part4a-keyd-core.md`, 13,254
lines) unless marked "spec" (`specs/2026-09-30-localdot-core-design.md`).

What I ran (Go 1.27.1, Node 25.6.0). Everything ran in copies under `scratchpad/review2/`, and
`part4a-fix/` and `part4a-verify/` were not touched:
- **Rebuild.** I rebuilt the module from the on-disk plan with the fix agent's `extract.py`. It is
  byte-identical to `part4a-fix/keyd` (58 files, plus `THIRD-PARTY.md`). The same extractor on the
  pre-fix plan reproduces `part4a-verify/keyd`, so the 3,183-line diff is the plan's real code
  change.
- **Task-by-task replay.** I replayed all 17 tasks from the plan text alone (`review2/replay.txt`).
  - Every red step fails with the error its step names.
  - Every green step passes `gofmt`, `go vet`, `-race` on the task's packages, and `go test ./...`.
  - Every stated count matches: 12, 15, 13, 8+3, 9, 11, 7, 8 (50 placements), 16, 23, 37, 16, 51,
    57, 7+3, 15 subtests, 166 in all.
- **Final tree checks.** On the final tree:
  - `go test -race ./...` and `GOOS=linux|darwin go vet ./...` are clean.
  - Stress runs passed: `llm` with `-race -count=30 -cpu 1,4`, and the gateway concurrency, Stop and
    kill-switch tests with `-race -count=10 -cpu 1,4`.
- **Red checks.** I ported the new tests for C1, C2, I1, I2, I3 and the Minors into the first
  draft's tree (`review2/old`). Each fails there, as the log says, and passes on the fix.
- **Probes.** My own probe tests against the fix are in
  `review2/new/internal/{llm,egress,keys,scrub,vault}/review2_*_test.go`.
- **Sealing.** I extracted the plan's JS sealing snippet (12839–12872), sealed two records with it
  in Node, and opened both in Go.
- **Not run.** The opt-in login-keychain test, because it writes to the user's keychain.

## 1. Finding verdicts

**C1: ADDRESSED.**
- **The fix.**
  - Values are stored in 1,536-byte chunks, one `security -i` session per item.
  - The head item records the write id and the chunk count.
  - Every Put reads the value back (`Put` 1059, `Get` 1083).
  - `run` (1138) drops the tool's output, and the admin socket answers with a fixed message
    (11972). The longest line is about 3,300 characters.
- **Pinned.**
  - The fake `security` script (758–790) splits lines at 4,095 characters like the real tool.
  - `TestKeychainKeepsLongValuesWhole` (864) and `TestKeychainErrorsNeverCarryTheValue` (888) fail on
    the first draft: `security: unknown command "5767…"`, with the value's hex in the error. Both pass
    on the fix.
- **Prose.** R3 (13043), R23 (13166) and Interfaces (12776–12779, 12801) are corrected. There is a
  cost in N6.

**C2: ADDRESSED.**
- **The fix.** `permitted`, `unambiguousPath` and `overridesMethod` (5317–5355); `Permits` matches on
  a segment boundary (4971); binding path prefixes are stricter.
- **Pinned.**
  - On the first draft, 17 new `TestInspect` cases (4772–4792) are allowed.
  - `TestHTTPRecords` (4576) fails on the first draft.
  - `TestPathAndMethodLimitsHoldOnTheWire` (7821) gets eight 200s on the first draft: "the upstream
    got the real key 8 times".
  - All pass on the fix.
- **Extra probes**, parsed with `url.ParseRequestURI` as net/http does: `%2E.`, `.%2e`, overlong
  `%c0%ae`, fullwidth dots, `%09`, `%3b`, `%23` before dot segments, `/./`, a trailing `/.`, a
  trailing `%2F`, an upper-case prefix and `_METHOD`.
  - Every one is refused.
  - `%3f..` and `%76` pass, harmlessly: the decoded path stays inside the prefix.
  - When `RawPath` is not a valid encoding, Go re-escapes `Path`, so the upstream decodes exactly
    what keyd checked.
- **Residuals.** N3 (a prefix ending in `/` now also admits the path without it), and `_method` in a
  request body (N8).

**I1: ADDRESSED.**
- **The fix.** Every needle matches each byte raw or in any of its escapes (`match` 3966, `escapes`
  4067). A replacement must be unreserved characters only (3885). Neither the plan nor the module
  contains a backslash-u sequence.
- **Pinned.**
  - `TestEscapedReflectionsAreReplaced` (3619) first asserts that `json.Marshal` still escapes. On
    the first draft, six of its seven forms pass through unchanged.
  - The streaming test (3644) also fails on the first draft.
  - Both pass on the fix.
- **Still not scrubbed (my probe), outside the reviewer's bar.** `~` written as `%7E` (Java's
  URLEncoder), `&#X3C;`, and `&#0060;` (N8).

**I2: ADDRESSED.**
- **The fix.**
  - `serveGateway` takes the generation first (10404).
  - Stop cancels the budget wait (10517).
  - `g.ctx` is checked just before the relay (10496), and the relay uses `gen: g` (10501).
  - The relay's context hangs off `g.ctx`, so a Stop after the check aborts the round trip.
- **Pinned.** `TestARequestInspectedBeforeStopNeverReachesTheProvider` (9893). On the first draft:
  "the provider was reached after Stop, with X-Api-Key "real-secret-value-for-test"". It passes on the
  fix and stays stable under stress.
- **Related, not Stop.** A secret replaced while a request waits for budget (N4).

**I3: NOT ADDRESSED.**
- **What is fixed.**
  - Holds: `Reserve` 9138, `reserveLocked` 9157, `Settle` 9244.
  - Ceilings: `Ceiling` 8991, `OutputCap` 9477.
  - An uncapped request runs alone in its task.
  - A cut stream is charged at least the byte estimate (`settle` 10587–10612; `clean` at 10344).
- **The review's probe is pinned.** These fail on the first draft and pass on the fix:
  - `TestParallelRequestsCannotOvershootTheTask` (9981): $90 of a $5 task on the first draft.
  - `…FromManyCellsCannotOvershootTheDay` (9996): $22.50 of a $10 day.
  - `TestRequestsWithoutAnOutputCapRunOneAtATime` (10016): 5 at once.
  - `TestACutStreamIsChargedAtLeastWhatItRelayed` (9862): only the reported usage was charged.
- **The defect remains.** The ceiling takes the body's output-cap fields at face value. I used the
  harness's own setup: 20 requests in parallel, each billed $4.50, against a $5 task. Each of these
  three shapes gives `statuses map[200:20]; at once 20; the task spent $90.00 of $5.00` on the fixed
  code:
  1. **A null cap.** `"max_tokens": null`, or the same for `max_completion_tokens` or
     `maxOutputTokens`.
     - `json.Unmarshal` of `null` into a `float64` does nothing and returns no error.
     - So `OutputCap` returns `(0, true)`, and the hold is the input estimate alone: 60
       micro-dollars for a 60-byte body.
     - OpenAI documents these fields as "integer or null", and Gemini's JSON mapping reads null as
       unset.
     - `TestOutputCap` already treats `-1` and `"64"` as "no cap"; null slips past that intent.
  2. **A choice count.** `"n": 128` with `max_tokens: 1`. The cap applies per choice, and OpenAI bills
     every choice. The same holds for `best_of` (completions) and `generationConfig.candidateCount`
     (Gemini). The plan never mentions these.
  3. **A cap the provider does not read.** For example, `max_output_tokens` on `chat/completions`.
     `OutputCap` takes the largest of every name it knows; a lenient `openai-compatible` server
     ignores the field and uses its own default.
- **Claims now false for these shapes.** R15 (13114), the Task 13 intro (8291), Interfaces (12926)
  and Review Focus 9 (163) all say that requests together never spend past a limit.
- **Smallest fix.** Write the change into the plan's Task 13 (`OutputCap`) and Task 14 (gateway)
  code and tests, then regenerate the module from the plan.
  - In `OutputCap`, a cap field that is not a positive integer makes the body uncapped. That covers
    null, 0, negatives and strings.
  - A choice count above 1 either multiplies the cap or makes the body uncapped.
  - Read only the field(s) the route's operation actually reads.
  - Add the three shapes to `TestOutputCap` and to the gateway's parallel tests.
- **Severity.** Important, as in review 1. Deliberate use needs code in the brain cell, but `null`
  also comes from ordinary clients that send unset options as null.
- **Uncapped requests (asked).** They can still overshoot, by one request per task:
  `TestRequestsWithoutAnOutputCapRunOneAtATime` pins $9 spent of $5.
  - The excess is that request's own cost. keyd does not bound it; only the provider's maximum
    output for the model does.
  - It is documented: R15 (13116–13118), Interfaces (12926–12929), and the obligation for Part 4b
    to always send an output cap (13011).
  - Several cells can each run one uncapped request at once, so the day can be crossed by several
    of them; R15's wording covers one task only (N8).

**Minor findings:**
- **M1: ADDRESSED.** The last label must be letters or `xn--` (4449). Tests 4165 and 4270 fail on the
  first draft.
- **M2: ADDRESSED.**
  - The fix:
    - `redact` (2925), called from `Write` (2870), names surrogates by ID.
    - `key.use` is built from the line as written.
    - `scan` reads `u.Host` (5418).
    - `servePlain` inspects before checking the host (6687).
  - Tests 2605, 6090, `TestInspect` 4791 and S4 12714/12722 all fail on the first draft.
  - The CONNECT authority is covered through `ctx.Req.URL.Host` (7337), but no test sends a
    surrogate there.
  - For the `Host` header of an intercepted request, see section 4.
- **M3: NOT ADDRESSED.**
  - The review's fix is applied: `identity` (6920) checks every value. Its probe is pinned (6183) and
    fails on the first draft.
  - The defect remains when the first `Content-Encoding` line is `gzip`. Go's transport removes one
    gzip layer and deletes every `Content-Encoding` line before `ModifyResponse` runs.
    - So a body gzipped twice, behind two `gzip` lines (or `gzip` then `br`), reaches the cell with
      no `Content-Encoding` header.
    - The cell can un-gzip what the scrubber never saw. My probe (`review2_gzip_test.go`) got 200
      and recovered the inner text.
  - R10 (13089–13091) overclaims.
  - Fix: set `DisableCompression` on the generation's transports and request gzip explicitly. Then
    decode only a lone `gzip` in keyd and refuse anything else.
  - Minor: it needs a bound host that stacks encodings over an echo.
- **M4: ADDRESSED.** `Log` keeps its size and last error (2869–2916). `Cell.swap` (6740) is the only
  caller of `ApplySwaps`, and `/v1/status` reports the state (11909). Tests 2582, 7855 and 11467
  fail on the first draft.
- **M5: ADDRESSED** as a recorded decision, R25 (13175).
- **M6: ADDRESSED.** `sealAAD` (1703); tests 1480 and 1528. My Node seal opened in Go, and was
  refused under another id.
- **M7: ADDRESSED.** It is in R3 (13043–13053) and Interfaces (12791–12796). The spec now also holds
  the risk line (spec 786–789), but R3's last sentence still says it is only proposed (N8).
- **M8: ADDRESSED.** The CA's extended key usage is server auth only (3366); test 3216 fails on the
  first draft.
- **M9: ADDRESSED.** `ModelFromJSON` (9446); test 8740 fails on the first draft.
- **M10: ADDRESSED.** `unescape` (5359); test 4792 fails on the first draft.
- **M11: ADDRESSED.** The manager refuses HTTP secrets for the brain (11260); R26. Test 10806 fails
  on the first draft.
- **M12: ADDRESSED.** R14 (13102–13109); Interfaces (12795).
- **M13: ADDRESSED.**
  - Task 10 (5513) and Task 11 (7003) split cleanly: between the two stages, only the four `cell.go`
    edits change.
  - The weak tests are replaced; each new one fails on the first draft.
  - A cosmetic doubled `---` sits at 7540–7541.
- **M14: ADDRESSED.** See 13007–13012, 12776, 12922–12932, 12987–12989 and 12808. One gap is N5.

## 2. Decision verdicts

- **R2: ADDRESSED.**
  - The AAD is the whole binding (1703), and `putSecret` opens the value with the record it has just
    validated (11944).
  - Trust rule 3 is amended.
  - My independent check passed: the plan's own JS snippet (in Node) and Go agree on an HTTP record
    with `&<>"'` in a path, and on an `openai-compatible` record with omitted fields.
- **R5: ADDRESSED.** The M1 rule; R5 (13058–13065); the spec's default-egress amendment (spec
  526–529).
- **R8/R9: ADDRESSED.** R8 (13073–13080); R9 with its residual risk (13081–13087); the spec's swap
  rules (spec 498–506).
- **R15: NOT ADDRESSED.**
  - The hold and the cut-stream charge are in place, so the ruling is met in mechanism.
  - The bound R15 states fails for the shapes in I3, and its input term over-holds screenshots (N1).
- **R20: ADDRESSED.** Its three parts:
  - I2 is fixed.
  - `Manager.Revoke` ends the task (11140). `TestRevokeIsTheKillSwitch` (10843) fails on the first
    draft with "the task outlived the kill switch".
  - Part 4b's Stop obligation is recorded (13007–13010), and R20 is rewritten (13153–13161).
  - See N5.

**No deadlock in the budget wait.**
- Every wait has an outstanding hold.
- Every hold is released by `defer hold.Release()` (10475), or settled exactly once through
  `sync.Once`.
- `Begin`, `End`, `Charge` and `Settle` each wake the waiters.
- The only lock order is the budget lock, then the settings lock.
- Stop, the client leaving and closing the cell all cancel the wait.

## 3. New breakage

### Important

**N1. The ceiling prices base64 screenshots as text, so a task is refused far below its budget.**
- **The rule.** `Ceiling` (8991) holds the body's bytes ÷ 3 at the dearer of the input and
  cache-write prices, plus the output cap at the output price.
- **The size of the error.**
  - The brain sends 1280×800 screenshots (S5), which providers bill at about 1,300 tokens each.
  - A 450 KB PNG is about 600 KB of base64, which the ceiling counts as 200,000 tokens: roughly 150
    times its real price.
- **Probe** (`review2_images_test.go`): five such screenshots (a 2.9 MB body) with `max_tokens`
  4096.
  - It holds $3.06 at the harness's prices, or $3.81 with Sonnet's cache-write price.
  - Each call really bills about $0.09.
  - The $5 task gets `402 {"needUSD":3.06,…}` at call 22, after spending only $1.98, and every call
    after that is refused even alone.
  - Any body above about 4–5 MB can never run under the default $5 task.
- **No event.** A ceiling refusal publishes no `budget.exceeded`: only a settle that crosses a limit
  does (10608). So Part 4b's "stop the task and offer to raise the budget" flow (12992–12994) never
  fires, and the brain just gets 402s. The same happens to any request with a large output cap near
  the end of a task.
- **Not documented.** R15's costs (13122–13125) name large output caps and server-side input, not
  screenshots.
- **Fix.**
  - Count each inline image or document at a fixed per-item allowance instead of by its bytes.
    That means Anthropic `source.data`, OpenAI data URLs and Gemini `inlineData`.
  - Record the residual in R15.
  - Either publish `budget.exceeded`, with `needUSD`, when a ceiling is refused, or tell Part 4b
    that a 402 is the trigger.

### Minor

- **N2. A free `count_tokens` call waits for every running stream.**
  - `messages/count_tokens` and Gemini's `countTokens` name no output cap, so they hold the whole
    task as uncapped.
  - My probe: `count_tokens` was still waiting after 1 s behind a running stream, and answered only
    when the stream ended.
  - Uncapped requests also have no first-in-first-out order, so a steady flow of capped requests
    can delay them indefinitely.
  - Fix: mark operations that produce no output with a zero output ceiling.
- **N3. `Permits` widened.**
  - `TrimSuffix(prefix, "/")` makes a prefix ending in `/` admit the bare path. `/repos/me/app/` now
    admits `/repos/me/app`, which the first draft refused (probe on both trees). With `DELETE`
    allowed, that is the repository itself.
  - Servers often ignore trailing slashes, so a trailing-slash prefix never reliably excluded the
    parent.
  - Fix: either keep "strictly below" for slash-ended prefixes, or document that a prefix always
    admits its own path.
- **N4. The budget wait widens a time-of-check gap for secret replacement.**
  - A gateway request is not inspected again after it waits.
  - My probe: the key was replaced and its surrogate revoked while a request waited. When room
    freed, the provider received the new key under the revoked surrogate.
  - If the replacement changes an `openai-compatible` or `azure` base URL, the new key goes to the
    old upstream, which was looked up at the start (10408).
  - A slow body upload already opened this gap in the first draft; the wait makes it unbounded.
  - Fix: next to the `g.ctx` check (10496), confirm that each inspected entry is still registered.
- **N5. "The same `taskId` keeps what it spent" no longer holds after Stop.**
  - Stop now ends the task, and `Begin` with an ended id starts again at $0.
  - So if Part 4b turns `budget.exceeded` into Stop and then "raise the budget" with the same
    `taskId` (12818, 12992–12994), the task gets its old spend back as fresh budget.
  - Fix: say that the budget path must not revoke, or keep spend for ended task ids.
- **N6. A Keychain write now stalls the data plane longer.**
  - A Put runs 9–19 `security` processes (the log measured about 0.3 s per Put with the real tool).
  - All of it runs under the vault lock, and `scrubberFor` takes that lock on every request
    (`Vault.Records()`), so every cell stalls while a key is stored.
  - Writes are rare. Either release the lock around the store, or note it.
- **N7. `Budget.Charge` is now only used by tests.** Production settles through `Hold`. Delete it, or
  keep it out of the Interfaces block (8316).
- **N8. Text fixes.**
  - R3 (13052–13053): the M7 line is now in the spec.
  - Interfaces (12801–12802): it says the `vault` 500 message is "always" the fixed text, but
    `DELETE /v1/secrets/{id}` still returns `err.Error()` (11988). That text holds no value now,
    but the claim is wrong.
  - R18 (13145–13147):
    - The escapes that are never matched are those of `-._~` as well as letters and digits:
      `%7E`, for example.
    - `&#X..;` and zero-padded numeric references longer than three digits are also unmatched.
  - Review Focus 3 (131) and the Task 9 intro (4484):
    - `_method` is refused only in the query.
    - Rails (`Rack::MethodOverride`), Laravel and Spring's `HiddenHttpMethodFilter` read it from
      the body, which keyd does not scan. So a methods limit that permits POST can still be turned
      into PUT, PATCH or DELETE on those servers.
    - Record this as an R8 residual.
  - R15 (13116–13118): "the only request that can cross a limit" holds per task. Across cells, the
    day can be crossed by one uncapped request per running task.
  - R10 (13089–13091): see M3.
  - Cosmetic: the doubled `---` at 7540–7541.

**Checked and holding:**
- **Secrets in errors and logs.** No new path puts secret bytes in an error or a log line: the
  Keychain, the admin socket, the audit status and the redaction all hold.
- **Locks.** No lock cycle.
- **Cross-references.**
  - All 64 test-to-task references in the plan's prose resolve to the task that adds the test.
  - Every task's Files block matches what its code blocks write. The one exception is the iron-proxy
    license, which a shell step copies.
  - Task 11's four `cell.go` edits apply cleanly.

## 4. Spec amendments

1. **Trust rule 3 (spec 149–153).**
   - It states what the plan does: the key is sealed to keyd's per-boot key, bound to its id and
     binding, and the daemon only relays it to the socket.
   - It weakens nothing beyond what R2 accepted. The limit against a compromised daemon now sits in
     the spec's risks (item 4 below).
2. **Swap rules (spec 498–506).**
   - It matches R8/R9 and ruling P4a-C2 word for word, and the residual risk for passthrough
     responses is recorded.
   - One overclaim: "blocked and alerted". A surrogate in an intercepted request's `Host` header gets
     421 `host-mismatch` with no `key.use` event (probe `review2_hosthdr_test.go`). It is blocked, but
     not alerted.
   - Fix: either scan `r.Host` in `Inspect`, or soften the spec's wording. Minor.
3. **Default egress (spec 526–529).** It matches R5. It narrows egress and weakens nothing.
4. **An unlisted fourth change.**
   - "Risks and open questions" gained the M7 line (spec 786–789).
   - It is not marked as an amendment, and the revision log says it was not applied. The spec's
     mtime (15:44:17) is after the log's (15:43:02), so it was added after the fix agent finished.
   - Its content is accurate and weakens nothing; only plan R3 now contradicts it (N8).

## 5. Out-of-scope observations

- **The opt-in login-keychain test was not re-run.** The log reports a pass with an 8,192-byte value
  and an empty test service afterwards.
- **`count_tokens` is still charged a byte estimate**, although the provider does not bill it. This
  predates the fix.
- **A failed Keychain Put leaves keyd inconsistent until restart.** keyd keeps using the old record
  and value in memory, while the Keychain head may already point at the new chunks. After a restart
  the read fails as torn, and the plan's message says to store the key again, as designed.
- **The I2 test depends on timing.** It orders "inspected, then Stop" with a 300 ms sleep. That was
  stable here, but could flake on a slow CI runner.

## 6. Verdict

**Fixes needed.** Open items:

Important:
- **I3 / R15.** The output-cap reservation can be bypassed by a `null` cap, by `n`/`best_of`/
  `candidateCount`, or by a cap field the provider does not read. Twenty requests in parallel still
  spend $90 of a $5 task.
- **N1.** The ceiling prices base64 screenshots as text. A $5 task with five screenshots in context
  is refused after spending $1.98, and the refusal publishes no `budget.exceeded`.

Minor:
- M3, with a gzip-first stack.
- N2–N8.
- The `Host`-header overclaim in the spec's swap rules (section 4, item 2).
