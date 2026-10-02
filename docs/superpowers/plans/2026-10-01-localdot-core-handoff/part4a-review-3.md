# Part 4a plan review 3: keyd core, fix pass 2 (scoped)

Line numbers are in the revised plan (`plans/2026-10-01-localdot-core-part4a-keyd-core.md`, 14,547
lines) unless marked otherwise.

What I ran (Go 1.27.1 at `/opt/homebrew/bin/go`). Everything ran in copies under
`scratchpad/p4a-r3/`; the repo, the worktree and the fix agent's trees were not touched.
- **Rebuild from the plan text.** `tools/extract.py` on the on-disk plan reproduces `part4a-fix2/keyd`
  byte-for-byte (61 files) and equals the fix agent's `plan-build`/`final-build`. The same extractor
  on `plan-before.md` reproduces `part4a-fix/plan-build`. So the diff between the two rebuilt trees
  (`module.diff`, 19 files, +1373/-251) is the plan's real code change this pass. The on-disk plan's
  sha256 (`3fc8c22b…`) matches the fix agent's `plan-final.sha256`.
- **Suite.** `go vet ./...`, `GOOS=linux|darwin go vet ./...`, `gofmt -l`, and `go test -race ./...`
  are clean on the rebuilt tree. Counts match the log: 174 pass + 1 skip top-level, 34 subtests;
  per package egress 64, llm 18, keys 9, admin 7, vault 15, netguard 13, scrub 11, cellca 9, audit 8,
  surrogate 8, policy 7, events 3, cmd/keyd 3.
- **Red checks.** The new/changed tests fail on revision 1 (`part4a-fix/plan-build` + the new test
  files) and pass on the fix: `TestAnUnrequestedEncodingIsRefused` (`gzip-gz/gzip-br: 200 ""`),
  `TestASurrogateInTheHostHeaderIsRefusedAndAlerted` (`421 host-mismatch`, no alert), plus the
  gateway/llm/keys/admin tests.
- **Probes.** My own adversarial tests are in `scratchpad/p4a-r3/work/internal/{llm,egress}/review3_*_test.go`.
- **Race stress.** `-race -count=5` on the concurrency/Stop/kill-switch gateway tests, and a 15-round
  `-race` concurrency+midnight-rollover stress on `Budget`, all passed.

---

## 1. Verdicts

**P4a-C5 (a) choice counts refused — ADDRESSED (with a residual).**
- `ReadRequest` (9883) refuses `n`, `best_of`, `candidateCount` other than 1/absent/null, folding case
  and underscores and coercing strings (`"2"`), at the top level and in the generation config; 400
  `choice-count` names the field (`refuseField` 11750). Pinned by `TestReadRequest` and
  `TestNoRequestShapeOvershootsTheBudget`, which pass; the shape table in the log reproduces.
- Residual (pre-existing, not closed): on the `completions` op a `prompt` **array** makes the provider
  return one answer per prompt, each under the single cap keyd sets — a `best_of`-equivalent that is
  not refused. My `TestReview3APromptArrayIsACountOfAnswers` bills $9.00 of a $5 task in two
  sequential calls. The brain's path (anthropic / chat / responses) is unaffected; `completions` is a
  listed op on openai/azure/compatible routes. See §2.

**P4a-C5 (b) gateway sets every output cap, in each provider's own field, bounded by the model max — ADDRESSED.**
- `WithCap` (9935) writes the admitted cap into the op's `Cap` field and deletes every other cap field,
  top-level and in the generation config. `Reserve`/`reserveLocked` (9503/9522) lower the cap to the
  room left under the budget lock. `SetModels` (9770) refuses a priced model with no `MaxOutput` and
  bounds prices/`MaxOutput`. `TestTheGatewayWritesTheCapInTheProvidersField`,
  `TestTheCapIsLoweredToTheRoomLeft`, `TestEachOperationNamesItsOutputCap`, `TestBudgetAndModels` pass.

**P4a-C5 (c) images priced by each provider's rule — ADDRESSED in design, but a NEW defect in the new code (see §3, N-A).**
- `imagesIn`/`dimensions` (10087/10245) read the PNG/JPEG header from the base64 and price by
  `anthropicImage`/`openAIImage`/`gpt4oMiniImage`/`geminiImage`; an unreadable or by-reference image
  takes the per-provider ceiling, never base64 length. `TestImagesArePricedByTheProvidersRule` and
  `TestScreenshotsDoNotStopATaskEarly` pass. **However** the new text-vs-image byte split underflows on
  a malformed image (N-A), which drives the hold negative. (c)'s arithmetic is unsafe until N-A is fixed.

**P4a-C5 (d) a refusal publishes `budget.exceeded` — ADDRESSED.**
- `refuseBudget` calls `announce` (11743) for a refusal exactly as a crossing does; a ceiling refusal
  (input+1 token does not fit) returns an `ExceededError` with `NeedUSD`, so it announces too.
  `TestABudgetRefusalIsAnnounced` pins it; the Interfaces Events paragraph (14198) says a task may
  publish it more than once.

**P4a-C5 (e) usage charged after completion, hold released — ADDRESSED.**
- `gatewayMeter.settle` (11777): a clean answer with usage → reported; clean without usage → the hold;
  a cut stream → `max(hold, reported-input + full-cap-output or byte-estimate)`; a failed answer → only
  what it reported; free ops nothing. `Settle` releases the remainder once (`sync.Once`).
  `TestAnAnswerWithoutUsageIsChargedItsHold`, `TestACutStreamIsChargedTheMostItCanHaveCost`,
  `TestTheGatewaySwapsTheKeyAndChargesTheTask` pass.

**M3 (stacked encodings) — ADDRESSED, bounded to one layer.**
- Transports set `DisableCompression` (both `tr` and `local`, generation.go 6451 and Task 14's edit),
  `relay` sets `Accept-Encoding: gzip` itself (forward.go 6885), `coding` (7037) accepts only no
  coding, a lone `identity` or a lone `gzip` and 502s anything else (another coding, or two on one or
  several lines), `gunzip` (7056) decodes the lone gzip streaming. keyd therefore controls the upstream
  `Accept-Encoding` and decodes at most one layer of the one coding it asked for — within the ruling's
  "at most two layers". R10 (14303) is rewritten. `TestAnUnrequestedEncodingIsRefused` passes and fails
  on revision 1.

**N2–N8 and the Host-header item — all ADDRESSED.**
- N2 free token counts: `messages/count_tokens` and `:countTokens` are `Free` (binding.go); the gateway
  skips reserve for them. `TestCountingTokensNeverWaits` passes.
- N3 `Permits` (5043): a slash-ended prefix admits only what lies strictly under it; segment rule
  otherwise. `TestHTTPRecords` passes (`/v1/` admits `/v1/`, not `/v1`).
- N4 re-inspect after the wait: `serveGateway` re-`Inspect`s after the budget wait and the `g.ctx`
  check (gateway.go 11625), before the swap/upstream. `TestASecretReplacedWhileARequestWaitsIsNotSent`
  passes.
- N5 text: PUT …/task keeps spend only while the task runs (14016); Events paragraph says pause, not
  Stop (14198); R20 (14399).
- N6 noted in R3 (14262–14265): the vault lock stalls the data plane during a key store.
- N7 `Budget.Charge` deleted; only `chargeLocked` via `Hold.Settle` remains (no `.Charge(` reference in
  the module); Interfaces no longer lists it.
- N8 text: R18 (14380) now names `-._~`/`%7E`, `&#X3C;`, padded numeric refs; the vault 500 message
  (13997) distinguishes PUT (fixed text) from DELETE (store error, no value — confirmed in admin.go);
  `_method` in a form body is an R8 residual (14293); the doubled `---` at the end of Task 11 is gone
  (0 adjacent `---` pairs, was 1).
- Host header: `innerHandler` (8364) inspects a host-mismatched request for a surrogate in `Host` and
  refuses 403 with a `key.use` alert before the 421. `TestASurrogateInTheHostHeaderIsRefusedAndAlerted`
  passes and fails on revision 1 (`421`, no alert).

**Residuals in R15 (asked: documented and bounded?).**
- Documented and bounded: text above 1 token/3 bytes; inline documents/audio/video by bytes and
  by-reference not at all; provider-side tool tokens; server-side tools and fees; dearer tiers; an
  image rule above keyd's; a server that ignores keyd's cap. All in R15 (14359–14367) and accepted in
  C6. Each needs code in the brain cell or an unusual server; bounded per request by the shortfall, and
  recorded as such.
- **Not documented:** provider-stored conversation state that the body does not carry — OpenAI's
  `previous_response_id`, Gemini cached content. My `TestReview3AStoredConversationIsBilledButNotHeld`
  bills $24 of a $5 task (20 parallel, each continuing a 400k-token stored response). Same class as the
  listed residuals (the provider bills input keyd cannot see), but absent from R15's list. Minor; see §5.

**M3 / R15 / R20 / R27 decision records:** consistent with the ruling and the code.

---

## 2. Budget attacks run, with results

Each ran against the rebuilt fix tree. "holds" = $5 task / $20 day not exceeded.

| Attack | Result |
|---|---|
| 20 parallel requests, null cap (`max_completion_tokens`/`maxOutputTokens`) | holds. `TestNoRequestShapeOvershootsTheBudget` (keyd sets the model max, lowered to room). |
| `n: 128`, `best_of: 20`, `candidateCount: 8` | holds. 20×400 `choice-count`, $0 spent. |
| A cap field the provider ignores (`max_output_tokens` on compatible chat) | holds. keyd rewrites to `max_tokens`; `TestTheGatewayWritesTheCapInTheProvidersField`. |
| Concurrency at the room's edges, 6 cells × 300 random asks, **plus clock rollover across midnight under live holds** | holds, no hang, every hold returned. `TestReview3TheRoomsEdgesUnderConcurrency` (`-race`, 15 rounds). Rollover carries holds over and never overshoots. |
| Streaming response the client cuts mid-stream | holds; charged the hold. `TestACutStreamIsChargedTheMostItCanHaveCost`. |
| Provider returns no usage | holds; charged the hold (safe over-charge). `TestAnAnswerWithoutUsageIsChargedItsHold`. |
| Many small requests | holds; each reserves/settles; FIFO-less wait acknowledged (N2 residual). |
| Image with a lying header / media_type | holds; `dimensions` reads the real PNG/JPEG header, so the declared type is irrelevant; an undecodable header takes the per-image ceiling. |
| Model missing from the price table | 403 `model-not-allowed` before reserve; provider never reached. `TestTheGatewayRefuses`. |
| Unknown provider route | 404 `route-unknown` before reserve. `TestTheGatewayRefuses`. |
| **Malformed image data (invalid UTF-8 in the base64 field)** | **FAILS — task and day overshoot to $63 of $5 / $20.** NEW this pass; see §3 N-A. `TestReview3InvalidUTF8MakesTheInputNegative` (hold −$58.40) and `TestReview3APoisonedImageLendsTheRoom` (c1 $63, day $68). |
| **`completions` with a `prompt` array** | **FAILS — $9 of $5 in two sequential calls.** Pre-existing; an unrefused `best_of`-equivalent. `TestReview3APromptArrayIsACountOfAnswers`. |
| **Responses `previous_response_id`** | **FAILS — $24 of $5.** Pre-existing R15-list gap. `TestReview3AStoredConversationIsBilledButNotHeld`. |
| **Client disconnects after relay but before the response headers** | **keyd charges $0 while the provider was handed the request (cap up to the room).** Pre-existing (identical on revision 1), repeatable, undocumented. `TestReview3ClientLeavesBeforeTheHeaders` (20 rounds, provider asked for 6M output tokens, task charged $0). |

---

## 3. New breakage

### Important

**N-A. A malformed image makes the hold negative, so a single request overshoots both budgets (NEW this pass).**
- **Mechanism.** `ReadRequest` sets `req.Input = (int64(len(body)) - data + 2)/3 + images` (plan 9927),
  where `data` is summed in `imagesIn`/`count` as `data += int64(len(b64))` (10110) — the length of the
  image's base64 **as `json.Unmarshal` returns it**. When the base64 field holds invalid UTF-8, Go's
  JSON decoder coerces each bad byte to U+FFFD (3 bytes), so `data` inflates to ~3× the wire bytes and
  exceeds `len(body)`. `req.Input` goes negative; `Ceiling` (9347) has no floor; `Ask.Fixed =
  price.Ceiling(req.Input, 0)` (11672) is negative; `reserveLocked` (9522) then admits a **negative**
  hold (`amount < 0`), which *frees* task and day room for other requests.
- **Evidence.** `TestReview3InvalidUTF8MakesTheInputNegative`: body 31 MB → `Input −20,966,679`, hold
  −$58.40; 14 honest $4.50 requests then run beside it and the task reaches $63 of $5. End-to-end,
  `TestReview3APoisonedImageLendsTheRoom`: one in-flight poisoned 30 MB image lets honest requests push
  c1 to $63/$5, c2 to $5/$5 and the day to $68/$20. Both fail on the fix tree.
- **Why new.** Before this pass `Ceiling` took `len(body)` directly, always ≥ 0; the byte-split and
  image parsing (`request.go`/`images.go`) are new this pass, so the underflow is introduced here.
- **Reachability.** A cell POSTs arbitrary bytes; `ModelFromJSON` and `members` (RawMessage) pass, and
  only `imagesIn` coerces, so the request reaches the provider. The legitimate brain sends ASCII
  base64 and is unaffected, but the budget is the control a possibly-rogue cell is bounded by, so this
  defeats it. Rated Important (same class as review 1's I3), must fix before execution.
- **Smallest fix (in the plan's Task 13).** Floor the text term: `req.Input = max(0, (int64(len(body))
  - data + 2)/3) + images` at 9927 (or clamp `Ceiling`'s inputs, or compute image data length from the
  raw body rather than the decoded string), and add an invalid-UTF8 image case to `request_test.go` /
  the gateway parallel test.

### Important (pre-existing, surfaced by the budget attacks; not a regression from this pass)

**N-B. A client that disconnects after the request is relayed but before the response headers is charged $0, while the provider holds the request.**
- `settle` runs only from the response tally in `ModifyResponse` (11485). A pre-response client abort
  takes the `ErrorHandler` path (6920) → `ReasonClientGone`, no settle, and `defer hold.Release()`
  (11619) gives the room back at $0. The upstream request is cancelled, but a provider that bills on
  completion (notably reasoning models with a long time-to-first-token) may already have generated. The
  cell can repeat this: each request fits the budget at reserve time, each is charged $0, so spend never
  rises — unbounded real spend with keyd recording $0.
- `TestReview3ClientLeavesBeforeTheHeaders`: 20 sequential rounds, the provider handed up to the full
  cap each time, task charged $0. Identical on revision 1, so pre-existing and out of this pass's
  change; flagged because scope 2 asks the budget to hold under "a streaming response the client cuts"
  and R15 does not record this case. Candidate fix: on a relayed-then-client-gone request, settle the
  hold (symmetry with the mid-stream abort, which already charges it), and/or record it in R15.

### Minor

- **N-C. `completions` prompt-array multiplier (pre-existing).** A `prompt` array yields one billed
  completion per prompt under the single cap; not refused by the C5(a) check. $9 of $5 in two calls
  (`TestReview3APromptArrayIsACountOfAnswers`). Not the brain's path. Fix: refuse a `prompt` array of
  length > 1 (or multiply the cap/hold) on `completions`, or record it as an R8/R15 residual.
- **N-D. R15 residual list omits provider-stored conversation state.** `previous_response_id` /
  Gemini cached content bill input the body does not carry ($24 of $5,
  `TestReview3AStoredConversationIsBilledButNotHeld`). Same class as the listed residuals; add a line to
  R15 (14359) naming it. Not the brain's path.

**Checked and holding (no new breakage):**
- **Deadlock / starvation / lock order.** Every wait holds no budget (the hold is created only on
  admit), every hold is released by `defer hold.Release()` or settled once (`sync.Once`), and Begin,
  End and Settle all `notifyLocked`. Stop/client-gone cancel the wait via `context.AfterFunc(g.ctx)` and
  the request context. The only lock order is budget → settings (`b.limits()` = `Settings.Limits()`
  under the budget lock); no path takes settings then budget. The 15-round `-race` rollover stress and
  the `-race -count=5` gateway stress passed. FIFO-less wait is the documented N2 residual.
- **Errors carrying key/prompt bytes.** The new paths add no secret bytes: `ChoiceError`/`refuseField`
  carry only the field name; `ExceededError` only dollar figures; the admin DELETE 500 returns the
  store error (id + exit status, no value); Keychain errors still drop the value (C1).
- **Request-body rewrite.** `WithCap` re-encodes preserving each member's raw bytes and runs only for
  capped ops; image bodies and all nine provider shapes survive
  (`TestTheGatewayWritesTheCapInTheProvidersField`); it does not touch streaming response handling.
- **One-gzip-layer / Accept-Encoding.** keyd forces `Accept-Encoding: gzip` upstream and disables
  transport compression, so providers do not send br/zstd unasked (and a stacked or unknown coding is
  502'd). Confirmed in generation.go and forward.go.

---

## 4. Byte-identity check

Tasks **1, 2, 3, 4, 5, 6 and 8 are byte-identical** to before this pass — verified two ways: the whole
`### Task N` sections hash identically (SHA-256 of each section equal before/after), and the staged
trees rebuilt from the plan text at stages 1–6 and 8 are `diff -r`-clean. Task 7 changed in prose only
(scrubber-escape and gzip intro lines; its stage-7 tree is identical). The code-bearing changes are
confined to Tasks 9, 10, 12, 13, 14, 16 (and count/intro text in 11, 15, 17), matching the revision
log. Lane C's work on Tasks 1–6 and 8 is unaffected.

---

## 5. Out-of-scope observations

- **N-B/N-C/N-D are pre-existing** (reproduce on revision 1 or predate the image/choice work); listed
  because scope 2 asks the budgets to hold under these attacks. They are the controller's call as to
  whether they belong to this pass or to Part 4b. N-B is the most material of the three.
- **Day-rollover attribution.** A request held before local midnight settles its charge onto the new
  day (holds carry over by design, R15/budget.go `rollLocked`). Never an overshoot within a day
  (verified), but a request that ran mostly on day N can be billed to day N+1. Cosmetic.
- **The opt-in login-Keychain test was not re-run** (writes to the user's Keychain); the log reports a
  pass. Unchanged this pass (Task 2 untouched).
- **`gpt-4o-mini` image rule keys off the substring `4o-mini`** in the model id (images.go 10115); a
  deployment under another name would be priced by the cheaper tile rule — already an R15 residual
  ("gpt-4o-mini under another deployment name").

---

## 6. Verdict

**Fixes needed.**

Open items:
- **Important (new this pass) — N-A.** A malformed image (invalid UTF-8 in the base64 field) drives
  `req.Input` negative (plan 9927, fed by 10110, consumed at 11672), so the hold goes negative and a
  single request overshoots the task and the day to $63 of $5. Floor the input term before it is
  priced.
- **Important (pre-existing, undocumented) — N-B.** A client that disconnects after the request is
  relayed but before the response headers is charged $0 while the provider holds the request;
  repeatable, so real spend is unbounded with keyd recording $0. Settle the hold on a
  relayed-then-client-gone request, or record it in R15.

Minor:
- N-C: `completions` `prompt` array is an unrefused answer-multiplier (pre-existing; not the brain's path).
- N-D: R15's residual list omits provider-stored conversation state (`previous_response_id`, cached content).

Everything in ruling P4a-C5 (a)–(e), M3, N2–N8 and the Host-header item is ADDRESSED and pinned by
tests; (a) and (c) carry the residual/defect noted above. Tasks 1–6 and 8 are byte-identical.
