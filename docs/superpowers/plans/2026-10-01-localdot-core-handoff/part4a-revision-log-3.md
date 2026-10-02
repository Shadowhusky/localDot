# Part 4a plan — revision 3 change log (review-3 fixes under ruling P4a-C7; line numbers refer to the revised plan, 14,751 lines)

Inputs: `part4a-review-3.md`, `part4a-rulings.md` (P4a-C7), revision 2's verified tree
(`scratchpad/part4a-fix2/keyd`, which revision 2's plan text rebuilds byte for byte: 61 files; that
plan's SHA-256 `3fc8c22b…` matched `part4a-fix2/plan-final.sha256` before this pass) and the
reviewer's probes (`scratchpad/p4a-r3/work/internal/{llm,egress}/review3_*_test.go`). All work was
done in `scratchpad/part4a-fix3`: `keyd/` is the developed module, `plan-build/` the module rebuilt
from the revised text, `red13/`, `red14/`, `stage13-red/` and `stage14-red/` revision 2's code with
the new tests, `probe-before/` and `probe-after/` the probes against each tree, `mut/` two mutants,
`tools/` the scripts named below. No git repository or worktree was touched, no subagent was used,
and nothing but the plan and this log was edited.

## Tasks changed (Tasks 1 to 12 byte-identical)

Lane C is building Tasks 1–12. None of them changes: every `### Task N` section 1–12 hashes as
before (table under Verification), and the module each stage 1–12 rebuilds is identical.

| Task | What changed |
|---|---|
| 13 | `request.go`: `BodyCompletions`, the prompt-list refusal (N-C), the input clamp and floor (N-A), `several`. `request_test.go`: prompt-list cases in `TestReadRequest`, a new `TestAMalformedImageCannotMakeAHoldNegative`. Intro, Interfaces, Step 4 count (19). |
| 14 | `gateway.go`: `gatewayMeter.sent`, `watch`, `left`, `charge` (N-B). A fourth `forward.go` edit, the error handler (N-B). `gateway_test.go`: a new `TestACellThatLeavesBeforeTheAnswerIsChargedItsHold` with its `leave` helper (N-B), the shape `a prompt list` (N-C), and `generous` counting a list's elements. Intro, Step 5 count (58) and text. |
| 15 | Step 4 count only (64). |
| 17 | Step 3 count only (177). |

Outside the tasks: the header (58–59), Review Focus 9 (164–188), "Interfaces Part 4b builds on"
(14312–14313, 14318–14319, the audit table's `usage` row at 14355), the decisions' intro (14418),
P4a-R15 (14517–14567), P4a-R27's table (14638–14639) and Verification (14679–14751). Task 16 is
unchanged.

## N-A — a malformed image can no longer make a hold negative (Task 13)

- **Code** (`request.go`, 9992–9995): `req.Input = max(0, (int64(len(body))-min(data,
  int64(len(body)))+2)/3) + images`. The image-byte count is clamped to the body's length and the
  text's share floored at 0, as ruled; with the clamp in place the floor never binds, and it stays as
  the ruling's second guard. A well-formed body is priced as before: decoded base64 is never longer
  than the bytes it came from, so `TestImagesArePricedByTheProvidersRule`'s exact input formula
  still holds.
- **Cause:** `imagesIn` counts an image's data as `json.Unmarshal` returns it, which turns every
  byte of invalid UTF-8 into U+FFFD, three bytes, so the data could exceed the body.
- **Pinning test:** `TestAMalformedImageCannotMakeAHoldNegative` (`request_test.go`, 9091–9115),
  ported from `TestReview3InvalidUTF8MakesTheInputNegative` with 3 MiB of `0xff` instead of 30 (the
  fewest whole MiB whose hold goes negative on revision 2). The image's input is exactly 4,784
  tokens, Anthropic's per-image maximum since its header cannot be read, and a $4.50 request waits
  beside its hold.
- **Red on revision 2** (Task 13's revision-2 code with these tests, `BodyCompletions` ported to
  `"completions"`): input −2,092,316 tokens. With that first check made a log line, the hold is
  −$1.78 and the $4.50 request runs beside it.
- **Text:** Task 13's intro (8488–8490), P4a-R15's input bullet (14530–14532), Review Focus 9.

## N-B — a cell that leaves before the answer's headers is charged the hold (Task 14)

- **Code.** `gateway.go`: `gatewayMeter` gains `sent atomic.Bool` (11931); `watch` (11934–11938)
  wraps the request's context in an `httptrace.ClientTrace` whose `WroteHeaders` sets it, and
  `serveGateway` relays `r.WithContext(meter.watch(r.Context()))` (11814); `left` (11965–11973)
  settles the hold in full when `sent` and does nothing otherwise; `charge` (11975–11983) is the
  settle-and-announce tail `settle` already had, now shared. Task 14 gains a fourth `forward.go`
  edit (11637–11650): for `client-aborted`, the error handler calls `rt.meter.left(&l)` before
  `finish(l)`, so the audit line carries the charge (`costMicroUSD` the hold, `usage` `estimated`)
  and a charge that crosses a limit publishes `budget.exceeded` like any other.
- **What "relayed upstream" means here:** keyd has written the request's headers to the provider.
  `WroteHeaders` runs before any byte of the body goes out, so the mark is set by the time the
  provider holds the whole request. Marking at the end of the body (`WroteRequest`) would leave a
  moment, between the last byte leaving and the hook running, in which a cell that left would still
  be charged $0. A cell that leaves while its body uploads is therefore charged the hold too, the
  conservative side, as with no usage; a request keyd has not begun to send (its connection still
  opening) costs nothing.
- **Pinning test:** `TestACellThatLeavesBeforeTheAnswerIsChargedItsHold` (10949–10988, with the
  `leave` helper at 10927–10947), ported from `TestReview3ClientLeavesBeforeTheHeaders`. A provider
  reads the request and generates until keyd cancels it; the cell leaves; the line is
  `client-aborted` with the hold, $4.500063, and the task has spent exactly that. Second half: a
  provider that accepts the connection and never answers the TLS handshake; the cell leaves; nothing
  is charged.
- **Red on revision 2:** on all of revision 2's code (`red14/`) the first half fails with
  `costMicroUSD` 0, `usage` empty and the task at $0; at Task 14's own stage (revision 3's stage 13
  with Task 14's revision-2 gateway and forwarder, `stage14-red/`) it is the one egress test that
  fails.
- **Mutants** (`mut/`): (a) `left` ignoring `sent`, charging every request the cell leaves, fails
  the second half (a request never sent charged $4.500063); (b) `sent` set by `WroteRequest`
  instead passes 20 runs under the race detector. The window (b) leaves is a scheduling one no test
  can force, so the choice of `WroteHeaders` is argued above rather than pinned.
- **Not changed:** a request that Stop ends before the answer's headers (`revoked`), or that the
  provider fails before them (`upstream-error`), is still not charged. Stop ends the task, so a cell
  cannot repeat it, and the provider's failure is not the cell's to cause; review 3 named neither.
- **Text:** Task 14's intro (10427–10431) and Step 5 (12026–12027), P4a-R15's settlement bullet
  (14539–14546), "Interfaces Part 4b builds on" (14318–14319, 14355), Review Focus 9.

## N-C — a `prompt` list on completions is refused (Task 13; a shape in Task 14's test)

- **Code** (`request.go`): `BodyCompletions = "completions"` (9887–9888), the body Task 9's
  `openAIStyle` gives the `completions` op; in `ReadRequest` (9958–9960), on that API, a top-level
  `prompt` (folded like the choice fields, so `Prompt` too) whose value is a list of more than one
  element returns `&ChoiceError{Field: m.key}`; `several` (10062–10066). The gateway already
  answers a `ChoiceError` with 400 `choice-count` naming the field (`keyd: choice-count: prompt`),
  so no gateway code changes for this item.
- **The ruling taken literally:** any list of more than one element is refused, one prompt given as
  a flat list of token ids (`[1, 2, 3]`, which OpenAI reads as a single prompt) included; it can go
  as a list of one list (`[[1, 2, 3]]`) or as a string, which the plan text says. Counting prompts
  instead would need each server's rule (llama.cpp, for one, reads a list mixing numbers and
  strings as one prompt), so the literal rule is the one that cannot under-count. The brain does not
  use completions.
- **Pinning tests:** `TestReadRequest` (9067–9085): `["x","y"]`, `[[1],[2],[3]]` and `"Prompt":
  [1,2]` are refused naming the field as written; a string, a list of one and a list of one token
  list are accepted; a prompt list on chat is left alone. `TestNoRequestShapeOvershootsTheBudget`
  gains the shape `a prompt list` (11151–11153): 20 × 400 from one cell and from five, nothing
  spent. `generous` now counts a list's elements as a count of answers (11093, 11104–11106), so the
  shape's fake provider bills as the real one would.
- **Red on revision 2:** the three refusals are accepted (`BodyCompletions` ported); against all of
  revision 2's code the shape is admitted and reaches the provider, and its first call, which must
  get 400, waits for the provider until the client gives up.
- **Text:** Task 13's intro (8478–8481), its Interfaces (8531–8532), P4a-R15's first bullet
  (14520–14523), P4a-R27's table (14638–14639), "Interfaces Part 4b builds on" (14312–14313),
  Review Focus 9.

## N-D — provider-stored conversation state is a residual (P4a-R15)

- **Text only, as ruled** (14562–14567): the residual list names input the provider stores between
  requests, which the body only names and keyd cannot see at all (OpenAI's `previous_response_id`,
  Gemini's cached content and the like), and says M4 refines it once the brain's call pattern is
  known. The next sentence now reads "Part 4b's brain uses none of the others", since whether it
  continues stored conversations is not yet known.
- **Probe:** `TestReview3AStoredConversationIsBilledButNotHeld` still spends $24.00 of a $5 task on
  both trees; no code was ruled for it.

## The reviewer's probes, before and after

Run unchanged (copied into each tree) without the race detector, as review 3 ran them. Under the
race detector the 30 MB probes are far slower: `TestReview3InvalidUTF8MakesTheInputNegative` took
14 s, and `TestReview3APoisonedImageLendsTheRoom`'s 8-second wait for its upload ran out.

| Probe (item) | Revision 2 (`probe-before/`) | Revision 3 (`probe-after/`) |
|---|---|---|
| `TestReview3InvalidUTF8MakesTheInputNegative` (N-A) | FAIL: input −20,966,679 tokens, hold −$58.40; 14 × $4.50 ran beside it, the task $63.00 of $5, the day $63.00 of $20 | PASS: input 4,784 tokens, hold $4.514352; none ran beside it, $0.00 spent |
| `TestReview3APoisonedImageLendsTheRoom` (N-A) | FAIL: c1 $63.00 of $5, c2 $5.00, the day $68.00 of $20 | PASS: c1 $5.00, c2 $5.00, the day $10.00 of $20; the poisoned request 400 |
| `TestReview3APromptArrayIsACountOfAnswers` (N-C) | FAIL: two calls answered, $9.00 of $5 | PASS: the first call 400 `keyd: choice-count: prompt`, $0 |
| `TestReview3ClientLeavesBeforeTheHeaders` (N-B) | FAIL: 20 rounds, $90.00 of output asked for, $0 charged | Stops at round 3: "the provider was never reached; spent $5.0000". Rounds 1 and 2 were charged their holds, $4.500063 and $0.499923 (its cap lowered to the room left), $4.999986 of the $5 task, so the third request gets 402 `budget-task` (audit lines logged from a copy, `probe-cutlog/`). With room for its 20 rounds (limits $100 a task and a day, `probe-variants/review3_cut_roomy_test.go`, nothing else changed): PASS, $90.001260 charged; revision 2 with the same change: FAIL, $0 |
| `TestReview3AStoredConversationIsBilledButNotHeld` (N-D) | FAIL: $24.00 of $5 | FAIL, unchanged: text only, as ruled |
| `TestReview3TheRoomsEdgesUnderConcurrency` | PASS | PASS |

The same runs on `probe-final/`, the module rebuilt from the installed plan, give the same results.
So the probes for N-A and N-C pass as written. N-B's passes once it has room for its rounds: as
written it cannot pass after any fix that charges the hold, because the budget then refuses its
third request, which is the budget working. N-D's still fails, by the ruling.

## Verification

Go 1.27.1 (`/opt/homebrew/bin/go`, darwin/arm64), on `plan-build/`, the module `tools/extract.py`
(revision 1's, unchanged) rebuilt from the revised plan: its 61 files are identical to `keyd/`.

```text
$ gofmt -l .
$ go vet ./...
$ GOOS=darwin GOARCH=amd64 go vet ./... && GOOS=linux GOARCH=amd64 go vet ./...
$ go mod verify
all modules verified
$ go test -race -count=1 ./...
(13 packages ok; the plan's Verification section has the lines)
```

- **Counts** (`go test -json`, `tools/counts.py`): 177 top-level tests, 176 pass and 1 skip (the
  opt-in Keychain test), and 36 subtests; llm 19 and egress 65 (one more each), the rest as before
  (admin 7, audit 8, cellca 9, events 3, keys 9, netguard 13, policy 7, scrub 11, surrogate 8,
  vault 15 with one skipped, cmd/keyd 3). The two new subtests are the prompt-list shape from one
  cell and from five.
- **Stability** (`stability.txt`): `go test -race -count=10 ./...` passed (llm 23 s with the new
  3 MiB test, egress 63 s), and `go test -count=20 -cpu 1,4 ./internal/egress/ ./internal/admin/
  ./cmd/keyd/ ./internal/llm/` passed three times. No run failed. The new tests take 1.4 s
  (`TestAMalformedImageCannotMakeAHoldNegative`, under the race detector), 0.06 s
  (`TestACellThatLeavesBeforeTheAnswerIsChargedItsHold`) and 0.3 s per prompt-list subtest.
- **Replay, Tasks 1–17, from the plan text alone** (`tools/replay_plan.py`): every red step fails
  with the error its "see them fail" step names, and every green step passes `gofmt -l .`, `go vet
  ./...`, `go test -race` on its packages and `go test ./...` (and `go mod verify` from Task 11).
  Task 13: red `internal/llm/budget_test.go:16:55: undefined: Budget`, green llm 19 pass. Task 14:
  red `internal/egress/gateway_test.go:80:7: deps.Budget undefined (type Deps has no field or method
  Budget)`, green egress 58 pass. Then egress 64 at Task 15 and 65 at Task 17.
- **Review 3's change, red then green at its own task's stage** (`stage13-red/`, `stage13-green/`,
  `stage14-red/`, `stage14-green/`): Task 13's revision-3 tests on its revision-2 code do not build
  as written (`request_test.go:104:28: undefined: BodyCompletions`) and, ported, fail
  `TestReadRequest` (three prompt lists accepted) and `TestAMalformedImageCannotMakeAHoldNegative`
  (input −2,092,316); the revision-3 stage passes. At Task 14, revision 3's stage 13 with Task
  14's revision-2 `gateway.go` and `forward.go` fails only
  `TestACellThatLeavesBeforeTheAnswerIsChargedItsHold`; the revision-3 stage passes (58).
- **Against all of revision 2's code** (`red13/`, `red14/`): the same Task 13 failures, and in
  egress the N-B test and both `a prompt list` subtests fail while every other egress test passes
  with the new test file.
- **Tasks 1–12 byte-identical**, by SHA-256 of each `### Task N` section (heading through the line
  before the next heading, outside fences; `tools/section_hashes.py`), before (`plan-before.md`,
  SHA-256 `3fc8c22b9684b6dd0f3774cd4ed5ea78ba6d10d13ffeb4afc0eaa431873f9022`) and after:

  | Task | SHA-256, before and after |
  |---|---|
  | 1 | `de40ee0353878bb6ee0f99c0b8d46bb3a24175caf0096c70062873f39b4afaf9` |
  | 2 | `89da289144ef4386783332af391f3db374bd87e88cba577507b36f895337e44e` |
  | 3 | `49146cdf1d5de1e8c05373f49a1366671fb57e82c276138b67777e633133cdc2` |
  | 4 | `08838c2e59ceb17363a0f320706de1e3a401534a3a78953c09570f38b06f6189` |
  | 5 | `80ca67196d1fc7282aed77c5dcac6b018372ec17de829456124dced6af643789` |
  | 6 | `3d7942a478413211a7b2beb72849c534e4aaf297341e87303f1fbeacc86dd0f1` |
  | 7 | `a35ac8042ffb6c0d984e0570bc104705edfb902843fb4018bc8ccf974346e1ab` |
  | 8 | `fa207520a2736eed983ee007e9aeb642d323973f545ef95babe895ced0bf92b1` |
  | 9 | `4aea4a1c9c36d61371bcfa3f96d3196d8e925398a8789058313eb8e9ef677c03` |
  | 10 | `07cd7438df8aeb9abbab975677ded4f2f04052740370eb06b9d61dd214423ce4` |
  | 11 | `2fc51b6c154ea6e35633589a22d4d77cbcabb9b3fb4a9404febe3c6235968b1f` |
  | 12 | `55f435c7b6281e849f8c0fd9d7c9148156887093d842696eecb98c59c316b68d` |

  Task 16, "Global Constraints" and the file map hash the same too. The stage trees 1–12 that
  `extract.py` builds from the two texts are identical, and so are those tasks' parsed blocks.
- **Other checks:** `go test -race -count=1 ./...` passed from a copy at `part4a-fix3/odd path's
  dir/keyd`, a path with a space and an apostrophe like the worktree's. No line of the plan spells
  out a backslash-u escape, the hygiene patterns under Global Constraints find nothing in the
  module, and no [avatar-name]/[avatar-name]/[avatar-name] name appears in it.
- **Not run:** the opt-in login-Keychain test, the sealing check and Task 16's binary run; their
  code and text are as revision 2 ran them.

The revised plan, installed in place after checking that the file on disk was still revision 2's
(`3fc8c22b…`), has SHA-256 `0ed489f7cbaf586fc8ec3c34f73b2f36fa06e33e1e466b2c7275de97e70c16a3`
(`part4a-fix3/plan-final.sha256`); `extract.py` run on the installed file rebuilds the 61 files of
`keyd/`, and its Task 1–12 sections hash as in the table.

## Not done

- No code for N-D: the ruling makes it a residual, and M4 refines it.
- No change to Tasks 1–12, and none was needed: every fix sits in Task 13's `request.go` and Task
  14's `gateway.go`, with the one `forward.go` change made as a Task 14 edit of Task 10's file, as
  Task 14 already edits it three times.
