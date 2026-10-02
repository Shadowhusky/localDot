# Part 4a plan — revision 2 change log (review-2 fixes under ruling P4a-C5; line numbers refer to the revised plan, 14,547 lines)

Inputs: `part4a-review-2.md`, `part4a-rulings.md` (P4a-C5), revision log 1, the spec (its risks now
hold the M7 line), revision 1's verified tree (`scratchpad/part4a-fix/plan-build`) and the
reviewer's probes (`scratchpad/review2/new/...`). All work was done in `scratchpad/part4a-fix2`:
`keyd/` is the developed module, `plan-build/` the module rebuilt from the revised text,
`redcheck/` revision 1's code with the new tests, `tools/` the scripts named below. No git
repository was touched, and the spec was not edited.

## Tasks changed (Tasks 1 to 4 untouched)

The controller started Tasks 1–4 from the earlier text while this pass ran. Nothing here needs them
to change, and they are byte for byte as they were; so are Tasks 5, 6 and 8.

| Task | What changed |
|---|---|
| 7 | Intro text only: the escapes that stay unmatched (N8) and gzip now decoded by keyd (M3). No code. |
| 9 | `binding.go` (each op's body API, cap field and free flag; `Permits`, N3), `binding_test.go` (a new test, an N3 assertion); intro, Interfaces, Step 4 count (9). |
| 10 | `generation.go`, `forward.go` (M3), `cell_test.go` (M3 cases); intro, Interfaces. |
| 11 | Only the doubled `---` at its end removed (N8). No code, no text. |
| 12 | `mitm.go` (a surrogate in the `Host` header), `mitm_test.go` (a new test); intro, Interfaces, Step 5 count (38). |
| 13 | `usage.go`, `budget.go`, `settings.go`, `request.go`, new `images.go`; `usage_test.go`, `budget_test.go`, `request_test.go`, new `images_test.go`; intro, Files, Interfaces, Step 4 count (18). |
| 14 | `generation.go` (its replacement), the third `forward.go` edit, `gateway.go`, `gateway_test.go`; intro, Interfaces, Step 2's error line (`gateway_test.go:80:7`), Step 5 count (57) and text. |
| 15 | Step 4 count only (63). |
| 16 | `admin_test.go` (`TestBudgetAndModels`); intro (the `vault` message, N8). `admin.go` and `main.go` unchanged. |
| 17 | Step 3 count only (175). |

Outside the tasks: the header (57), Review Focus 1, 2, 3 and 9 (106, 119, 130, 163), the file map
(211), "Interfaces Part 4b builds on", the decisions (R3, R8, R10, R15, R18, R20 changed, R27 added)
and Verification (14479).

## I3/R15 and N1 — ruling P4a-C5

The gateway no longer reads a request's cost from its body; it works it out (Task 13's `llm`, Task
14's gateway).

### (a) More than one answer is refused

- **Code.** `ReadRequest` (9883) refuses `n`, `best_of` or `candidateCount` other than 1 (absent,
  `null` and `1` pass), at the top level and in Gemini's generation config. Keys are folded as before
  (any letter case, with or without underscores), because Go servers such as Ollama match keys
  without case and protobuf's JSON reads `candidate_count`; a string such as `"2"` is refused too,
  since pydantic servers coerce it. The error is `ChoiceError{Field}` (9858). The gateway answers
  400 `choice-count` whose body is `keyd: choice-count: <field>` and whose audit `detail` is the
  field (`refuseField`, 11750; `reserve`, 11660). A body naming the generation config twice gets
  400 `bad-json`.
- **Tests.**
  - `TestReadRequest` (8999): `n` 128, `N` 2, `n` `"2"`, `n` 0, `best_of`, `candidateCount`,
    `candidate_count`.
  - `TestNoRequestShapeOvershootsTheBudget` (11014; its shapes at 10998): `n`, `best_of` and
    `candidateCount`, each 20 requests in parallel, from one cell and from five. It first checks one
    refusal's exact body.

### (b) keyd sets the output cap, in the provider's own field

- **Where each provider reads its cap.** Task 9's ops name the field (`openAIStyle`, 5080; the
  tables, 5061):
  - Anthropic `messages`: `max_tokens`.
  - OpenAI and Azure chat completions: `max_completion_tokens`.
  - OpenAI-compatible, LM Studio and Ollama chat completions: `max_tokens`.
  - Completions: `max_tokens`. Responses: `max_output_tokens`.
  - Gemini `generateContent`/`streamGenerateContent`: `generationConfig.maxOutputTokens`.
  - Embeddings carry no cap; `count_tokens` and `:countTokens` are marked free.
- **The cap.**
  - `ReadRequest` takes the smallest cap the body names in any provider's field. A whole number
    from 1 to a billion counts (0 too for Anthropic, which writes nothing then); null, 0, strings
    and fractions are no cap.
  - The gateway asks for that cap, or the model's `maxOutputTokens` when the body names none,
    bounded by the model's maximum either way.
  - `Reserve` (9503, `reserveLocked` 9522) admits with the largest cap that the room left in the
    task and the day pays for, under the budget lock. A request waits while running holds take the
    room. It is refused only when its input and one output token do not fit; `NeedUSD` is then
    what it asked to hold.
  - `WithCap` (9935) writes the admitted cap into the provider's field and removes every other cap
    field, at the top level and in the generation config. So a server that also reads another field
    (vLLM reads `max_completion_tokens` as well as `max_tokens`) still finds only keyd's cap.
- **The model's maximum.**
  - `Price.MaxOutput` (`maxOutputTokens`, 9322) is required for a model with an output price.
  - `SetModels` (9770) refuses one without it, and bounds prices ($10,000 per million tokens) and
    `MaxOutput` (100 million) so that a ceiling cannot overflow.
  - The admin API's models row (14019) and the Part 4b obligation (14218) say so.
- **Tests.**
  - `TestEachOperationNamesItsOutputCap` (4581): every route's ops.
  - `TestReadRequest` (8999): null, 0, `"64"`, -1, 64.5 and 1e12 are no cap, and the smallest cap
    wins.
  - `TestWithCap` (9058): exact output bodies, `generation_config` included.
  - `TestTheCapIsLoweredToTheRoomLeft` (8909): $15.10 asked of a $5 task is admitted at 326,666
    tokens, and at 60,000 with $1 left. It is refused with `NeedUSD` 15.1 when the input no longer
    fits; a smaller request still gets 2,000 tokens.
  - `TestTheDayHoldsAcrossCells` (8905): the day lowers a cap.
  - `TestSettings` (8797) and `TestBudgetAndModels` (12813): a priced model without a maximum is
    refused.
  - `TestTheGatewayWritesTheCapInTheProvidersField` (11072): the provider reads exactly one cap, in
    its field, with the value expected. This covers no cap, null, the older OpenAI field, a string,
    a field the server ignores, Gemini's null and Gemini's proto name.
  - `TestNoRequestShapeOvershootsTheBudget` (11014) runs the three remaining shapes: a null
    `max_completion_tokens`, a null `generationConfig.maxOutputTokens`, and `max_output_tokens` on an
    OpenAI-compatible chat route.

### (c) Inputs priced as the provider bills them, images by its rule

- **Code.** `ReadRequest` sets `Input` as (bytes of the body other than image data + 2) / 3, plus
  each image's tokens. `imagesIn` (10087) finds images only where each API carries them:
  - Anthropic: `image` blocks in a message's content and in a `tool_result`'s content.
  - OpenAI chat: `image_url` parts.
  - Responses: `input_image` parts, a `computer_call_output`'s screenshot, and a
    `function_call_output`'s `input_image` parts.
  - Gemini: a part's `inlineData`/`inline_data` and `fileData`/`file_data` of an image type, and a
    `functionResponse`'s parts.

  Anywhere else an image is the provider's text and stays in the text count. That matters for
  Gemini's `functionResponse.response`, a JSON object billed as text. `dimensions` (10245) decodes
  at most the first 256 KB of the base64 (192 KB of image) and reads the PNG or JPEG header with
  `image.DecodeConfig`.
- **Tests.**
  - `TestImagesArePricedByTheProvidersRule` (9105): 15 bodies with real PNG and JPEG encodings.
    - Anthropic: a 1280×800 screenshot is 1,334 tokens; a 2000×1500 photo in a tool result is
      3,888; an image by URL or a GIF costs 4,784.
    - OpenAI: chat and a computer-call screenshot are 2,460; the photo as `input_image` is 7,285;
      gpt-4o-mini is 36,835; an image by URL costs 73,800.
    - Gemini: the screenshot is 2,240; a 4000×600 image is 5,160; inside a function response,
      2,240; `fileData`, 2,240.
    - Base64 in plain text, and anything in a completions prompt, stay text.
  - `TestScreenshotsDoNotStopATaskEarly` (11145) uses review 2's numbers: five 1280×800 PNG
    screenshots padded to 450 KB, `max_tokens` 4096, $3/$15 prices, and a provider billing 30,000
    input and 300 output tokens ($0.0945) a call. About 70 KB of conversation text carries the input
    tokens the images do not.
    - It starts at $4.50 spent, to keep it to 3.9 s under `-race`. It runs four calls at the full
      cap and a fifth with a lowered one, and is refused at $4.9725 of $5.
    - Run from $0 as review 2 ran it, the fix makes 52 calls and is refused at call 53 with $4.914
      spent: `needUSD` 0.151884, where it was 3.131874.

### (d) A refusal publishes `budget.exceeded`

- **Code.** `refuseBudget` calls `announce` (11743), which also publishes every crossing a settle
  reports. The event is the same `events.Budget` (Task 5 unchanged). The Interfaces "Events"
  paragraph (14198) says a task may publish it more than once.
- **Test.** `TestABudgetRefusalIsAnnounced` (11177): a task of $0.00005 is refused with
  `needUSD` and publishes `budget.exceeded` for its task. The provider is never reached.

### (e) Settlement: the usage reported, else the hold

- **Code.** `gatewayMeter.settle` (11777):
  - A 2xx answer that ended cleanly and reported usage is charged that usage.
  - One that reported none is charged its hold.
  - A stream cut short is charged the most it can have cost: the reported input with the whole cap
    of output, or the byte estimate of what reached the cell if more, and never less than the hold.
  - A failed answer is charged only what it reported.

  Settling releases the rest of the hold. Free ops hold and charge nothing.
- **Tests.**
  - `TestAnAnswerWithoutUsageIsChargedItsHold` (10898): it was charged the byte estimate, 1,560
    micro-dollars; now the hold.
  - `TestACutStreamIsChargedTheMostItCanHaveCost` (10665): `max_tokens` 1000, a short delta, then
    an abort. The charge is $0.018, input 1,000 and output 1,000; revision 1 charged $0.003765 from
    the bytes relayed.
  - `TestTheGatewaySwapsTheKeyAndChargesTheTask` (unchanged) keeps the reported-usage case.

### The attack, before and after

The provider in each run is `generous` (10955; the shapes at 10998): it writes the cap it reads in
its own field, or 300,000 tokens ($4.50) when it reads none, for every answer it is asked for. There
are 20 requests in parallel, at $5 a task and $20 a day.

| Shape | Revision 1, one cell | Revision 1, five cells (day) | This revision |
|---|---|---|---|
| null `max_completion_tokens` (OpenAI) | 20 × 200, $90.00 of $5 | $18.00 per task, $90.00 of $20 | 2 × 200, 18 × 402, $4.999995; five cells: 8 × 200 (which requests run depends on scheduling), $19.99998 of $20 |
| null `generationConfig.maxOutputTokens` | $90.00 | $18.00 per task, $90.00 | as above |
| `n: 128` with `max_completion_tokens: 2000` | $76.80 | $15.36 per task, $76.80 | 20 × 400 `choice-count: n`, $0 |
| `best_of: 20` with `max_tokens: 10000` | $60.00 | $12.00 per task, $60.00 | 20 × 400, $0 |
| `candidateCount: 8` with `maxOutputTokens: 30000` | 11 × 200, $39.60 | $14.40 per task, $72.00 | 20 × 400, $0 |
| `max_output_tokens: 1` on OpenAI-compatible chat | $90.00 | $18.00 per task, $90.00 | 20 × 200 at a 1-token cap: $0.0015 from one cell, $0.0003 a task from five |

For the choice shapes, revision 1 never answered the first synchronous check (the provider held the
request until the 10 s client timeout). The figures above come from a second run without that
check.

### The per-provider rules (P4a-R27, 14429), with their sources

Read from the providers' public documentation on 2026-10-01.

| Provider (routes) | Cap field keyd writes | Answer counts refused | Image tokens (w × h from the header) | Image not sized |
|---|---|---|---|---|
| Anthropic (`anthropic`) | `max_tokens` on `messages` | none exist | ⌈w/28⌉·⌈h/28⌉, at most 4,784 | 4,784 |
| OpenAI (`openai`, `azure`) | `max_completion_tokens` (chat), `max_tokens` (completions), `max_output_tokens` (Responses) | `n`, `best_of` | the larger of ⌈2.46 × min(⌈w/32⌉·⌈h/32⌉, 30,000)⌉ and 85 + 170 per 512-px tile; gpt-4o-mini 2,833 + 5,667 per tile | 73,800 |
| OpenAI-compatible (`openai-compatible`, `lmstudio`, `ollama`) | as OpenAI, but `max_tokens` on chat | `n`, `best_of` | OpenAI's | 73,800 |
| Google (`google`) | `generationConfig.maxOutputTokens` | `generationConfig.candidateCount` | the larger of 2,240 and 258 per crop of ⌊min(w, h)/1.5⌋ px (258 within 384 × 384) | 2,240 |

- **Anthropic.**
  - The Messages API reference (`platform.claude.com/docs/en/api/messages/create`):
    - `max_tokens` is required and at least 0 ("Set to `0` to populate the prompt cache without
      generating a response").
    - Thinking "counts towards your `max_tokens` limit".
    - No parameter asks for several answers.
  - The vision guide (`…/docs/en/build-with-claude/vision`, "Resolution and token cost"):
    - "An image, therefore, costs ⌈width / 28⌉ × ⌈height / 28⌉ visual tokens."
    - Standard tier: long edge 1568 px, 1,568 tokens. High-resolution tier ("Claude 4.7 and later"):
      2576 px, 4,784 tokens.
  - "How Claude resizes and pads images" (`…/vision-coordinates`): an image is scaled to the largest
    size within both limits, and padded to multiples of 28. The un-resized count, capped at 4,784,
    therefore bounds both tiers.
- **OpenAI.**
  - The API reference (`developers.openai.com`):
    - Chat: `max_completion_tokens` is "An upper bound for the number of tokens that can be
      generated for a completion, including visible output tokens and reasoning tokens"; `max_tokens`
      is deprecated and "not compatible with o-series models"; `n` is 1–128.
    - Completions: `best_of` "Generates `best_of` completions server-side".
    - Responses: `max_output_tokens` includes reasoning tokens.
  - The images guide (`developers.openai.com/api/docs/guides/images-vision`, "Calculating costs"):
    - Patch models bill ⌈w/32⌉·⌈h/32⌉ patches times a multiplier, from 1.2 up to 2.46 (gpt-4.1-nano);
      "If this count exceeds 30,000 patches, the API rejects the request".
    - Tile models bill base and tile tokens: 85/170 (gpt-4o, gpt-4.1), 75/150 (o1, o3), 70/140
      (gpt-5, gpt-5.1), 2,833/5,667 (gpt-4o-mini). The image is first scaled "to fit in a 2048px x
      2048px square" and its shortest side to 768.
  - keyd takes the largest rule, because a request names a model, not its family. gpt-4o-mini is
    recognised by name, since its tile count is about 30 times the others'.
- **Google.**
  - The Gemini API's `GenerationConfig` (`ai.google.dev/api/generate-content`): `maxOutputTokens`
    and `candidateCount`. Protobuf's JSON mapping also accepts their field names.
  - The thinking guide (`ai.google.dev/gemini-api/docs/thinking`): "The `max_output_tokens`
    generation parameter sets the maximum number of tokens a response can generate, including
    thought tokens", and thinking is billed as output.
  - Media resolution (`…/docs/media-resolution`): a Gemini 3 image costs 280, 560, 1,120 (the
    default) or 2,240 tokens.
  - Image understanding (`…/docs/image-understanding`) and token counting (`…/docs/tokens`): "258
    tokens if both dimensions <= 384 pixels. Larger images are tiled into 768x768 pixel tiles, each
    costing 258 tokens", with a crop unit of "floor(min(width, height) / 1.5)". The worked example
    (960×540, crop 360, 6 tiles) matches `geminiImage`.
- **OpenAI-compatible servers** document no single rule: each server's model counts image tokens its
  own way. keyd applies OpenAI's rule, and a model that bills images above it is a residual in R15.

### What still is not bounded (P4a-R15, 14330)

A hold falls short when a provider bills more than these rules allow. If that happens, the request
can cross a limit by the shortfall, and several running requests each by their own:
- text that takes more than one token per three bytes;
- documents, audio and video (inline counted as bytes, by reference not at all);
- tokens a tool adds on the provider's side;
- server-side tools and their fees;
- a dearer service tier, speed or long-context price;
- an image rule above keyd's;
- a server that ignores the cap keyd writes.

R15 says Part 4b's brain uses none of these, and each needs code in the brain cell or an unusual
server. Near a limit, an answer can stop at a lowered cap. A provider that never reports usage is
charged every hold in full.

### Text changed with them

- Task 13's intro (8470), Files (8499) and Interfaces (8505).
- Task 14's intro (10346) and Interfaces (10371).
- Review Focus 9 (163).
- The Interfaces budgets paragraph (14120), the route table with each op's cap field (14105), the
  reasons (14180) and the 4b obligations (14218).
- R15 (14330) rewritten in five parts; new R27 (14429).

## M3 — fixed, bounded to one layer of one coding

- **Code.**
  - The transports set `DisableCompression` (Task 10's `generation.go`, 6451; Task 14's, 11360).
  - `relay` asks for `gzip` itself (6885).
  - `coding` (7037) accepts no coding, a lone `identity` or a lone `gzip`, and refuses everything
    else with 502 `undecodable-encoding`: another coding, or two codings on one line or on several.
  - `gunzip` (7056) decodes the lone gzip as it is read.
- **Why it is bounded.** keyd decodes at most one layer of the one coding it asked for. Go's
  transport no longer strips a layer behind keyd's back. R10 (14303) records this, and that a body
  compressed under a coding it does not name is an upstream disguising an echo, which P4a-R18 already
  leaves out.
- **Test.** `TestAnUnrequestedEncodingIsRefused` (6271) adds three stacks and a lone gzip that keyd
  decodes: `gzip` then `gzip`, `gzip` then `br`, and `gzip, gzip`, each over a double-gzipped
  body. On revision 1, `gzip-gz: 200 ""` and `gzip-br: 200 ""`. Task 12's "gzip body" case still
  passes, now decoded by keyd.
- **Text.** Task 10's intro (5611) and Interfaces, Task 7's intro (3508), Review Focus 1 (106).

## The seven new Minors (N2–N8)

- **N2 — fixed.**
  - The fix: `messages/count_tokens` and Gemini's `:countTokens` are `Free` (5061). The gateway
    neither reads their body for a hold nor reserves, so they never wait, and they are charged
    nothing (review 2's out-of-scope note about charging them is fixed with it). Embeddings hold
    their input only.
  - Test: `TestCountingTokensNeverWaits` (11199). A `count_tokens` call answers 200 while a stream
    holds $4.50, and costs 0. On revision 1 it waited 2 s and failed.
  - Not changed: Reserve still has no first-in-first-out order. The brain makes a few calls at a
    time, so a large request waiting behind a steady flow of smaller ones is unlikely. A queue in
    `Reserve` would be the fix.
- **N3 — fixed in code.**
  - The fix: `Permits` (5043) keeps "strictly under it" for a prefix ending in `/`, and the segment
    rule for one without.
  - Test: `TestHTTPRecords` (4650), where `/v1/` permits `/v1/` but not `/v1`. On revision 1: "a
    prefix ending in a slash must permit only what lies under it, not its parent".
- **N4 — fixed.**
  - The fix: after the budget wait, keyd checks the generation, then inspects the request again
    (11625). A surrogate revoked meanwhile, because its secret was replaced, is refused 403 before
    the swap. The refusal happens before `scrubberFor` and before the request leaves for the
    upstream it looked up at the start.
  - Test: `TestASecretReplacedWhileARequestWaitsIsNotSent` (11235). On revision 1: "the waiting
    request got 200; the provider saw keys [real-secret-value-for-test
    replacement-secret-value-for-test]".
- **N5 — the smallest fix: the budget path must not revoke (text).**
  - The `PUT …/task` row (14016) now says the same `taskId` keeps its spend only while the task
    runs.
  - The Events paragraph (14198) tells Part 4b to pause the agent loop on `budget.exceeded`, not to
    Stop.
  - R20 (14399) adds why.
  - Keeping ended tasks' spend would need a store that outlives the task; it was not needed for the
    interface to be true.
- **N6 — the smallest fix: noted.** R3 (14262) records it: a store runs 9–19 `security` processes
  (about 0.3 s) under the vault lock, and every request takes that lock to build its scrubber, so
  traffic pauses while a key is stored. Releasing the lock would change Task 2, which was already
  executing; the review allowed a note.
- **N7 — fixed.**
  - `Budget.Charge` is deleted, and `chargeLocked` (9568) is reached only from `Hold.Settle`; its
    no-task branch went with it. The Interfaces block no longer lists `Charge`.
  - Tests: the two budget tests that used it now settle holds through a `spend` helper (8687).
- **N8 — text fixes, each applied.**
  - R3: the M7 line is in the spec (14262); see the next section.
  - The `vault` 500 message: the Interfaces admin paragraph (13997) and Task 16's intro (12519) now
    say PUT answers the fixed text and DELETE the store's error, which names the item and never a
    value. This is the smallest fix, the claim corrected; `admin.go` is unchanged.
  - R18 (14380) and Task 7's intro (3498): the unmatched escapes now include `-._~` and its escapes
    (`%7E`), `&#X3C;` and references padded past three digits (`&#0060;`).
  - `_method` in a form body: Review Focus 3 (130), Task 9's intro (4503), and R8 as a residual
    (14293), naming Rails, Laravel and Spring.
  - R15's "only request that can cross a limit": gone with the uncapped request. R15 (14330) now
    states, per request, when a hold can fall short.
  - R10: rewritten with M3 (14303).
  - The doubled `---` at the end of Task 11: removed.
- **The `Host`-header overclaim (review 2, section 4 item 2): fixed in code.**
  - The fix: when an intercepted request's `Host` does not match the tunnel, `innerHandler` (8364)
    first inspects it for surrogates. A surrogate there is refused 403 with its reason and a
    `key.use` alert, so the spec's "blocked and alerted" holds.
  - Test: `TestASurrogateInTheHostHeaderIsRefusedAndAlerted` (8056). On revision 1: `421
    "host-mismatch", upstream reached 0 times`, and no alert.
  - Text: Task 12's intro (7694), Review Focus 2 (119).

## P4a-R3 synced with the spec's M7 line

R3 (14253) no longer says the line is only proposed. It says the spec's "Risks and open questions"
records it (review 1, M7, synced after review 2), matching the spec's wording: "not against a
compromised daemon or a malicious local process". The decisions header (14226) says the spec's
risks record R3's cost. The Interfaces "Not in 4a" bullet already cited R3.

Cross-references:
- All 74 test names that the prose ties to a task resolve to the task that defines the test, and all
  70 test names in the prose exist.
- Every task's Files block matches its code blocks. The one exception, as before, is the iron-proxy
  license that a shell step copies.

## Existing tests whose expectations changed

These follow from the ruling and are not new properties:
- `billFourFifty` became `billTheCap` (10737): it bills the `max_tokens` it receives, as a provider
  does, because keyd now lowers caps.
- `TestParallelRequestsCannotOvershootTheTask` (10787) expects 2 × 200 and 18 × 402 (the second runs
  with the $0.50 left), one at a time. `TestParallelRequestsFromManyCellsCannotOvershootTheDay`
  (10803) expects 3 × 200 against the $10 day. Revision 1 gives 1 and 2.
- `TestRequestsWithoutAnOutputCapRunOneAtATime` is removed: every cap is now bounded by the model's
  maximum, and its null-cap case is in `TestNoRequestShapeOvershootsTheBudget`.
- Renamed or replaced:
  - `TestAnUncappedRequestRunsAloneInItsTask` became `TestTheCapIsLoweredToTheRoomLeft`.
  - `TestOutputCap` became `TestReadRequest` and `TestWithCap`.
  - `TestMissingUsageIsEstimatedOnlyForSuccess` became `TestAnAnswerWithoutUsageIsChargedItsHold`.
  - `TestACutStreamIsChargedAtLeastWhatItRelayed` became
    `TestACutStreamIsChargedTheMostItCanHaveCost`.
- `TestCeilingIsTheMostARequestCanCost` (8624): `Ceiling` now takes tokens.

## Verification

All runs used Go 1.27.1 (`/opt/homebrew/bin/go`) on the development Mac. No real secret was used
anywhere, and the opt-in Keychain test was skipped.

**The module rebuilt from the plan text**

The final text is `plan-final.md` (sha256 `3fc8c22b9684b6dd…`), copied to the plan's path.
`tools/extract.py plan-final.md 17 final-build` then `tools/compare.py final-build keyd` gives
`differ: []` and `identical: 61` (60 Go, `go.mod` and `go.sum` files, plus `THIRD-PARTY.md`).
- The suite below ran in `plan-build`, which is byte-identical to `final-build`; the last edits
  touched prose only.
- Tasks 1–6 and 8 are byte-identical to the plan on disk before this pass.
- `tools/regen.py` wrote the code blocks from the developed tree. Task 10's `forward.go` is the
  final file with Task 14's three edits reversed.
- Every task's tree from the text passed `go vet ./...`.

**The full suite in `plan-build`**

```text
$ go version
go version go1.27.1 darwin/arm64
$ gofmt -l .
$ go vet ./...
$ GOOS=darwin GOARCH=amd64 go vet ./... && GOOS=linux GOARCH=amd64 go vet ./...
$ go mod verify
all modules verified
$ go test -race -count=1 ./...
ok  	github.com/shadowhusky/localdot/keyd/cmd/keyd	1.406s
ok  	github.com/shadowhusky/localdot/keyd/internal/admin	2.325s
ok  	github.com/shadowhusky/localdot/keyd/internal/audit	1.637s
ok  	github.com/shadowhusky/localdot/keyd/internal/cellca	1.887s
ok  	github.com/shadowhusky/localdot/keyd/internal/egress	9.202s
ok  	github.com/shadowhusky/localdot/keyd/internal/events	2.155s
ok  	github.com/shadowhusky/localdot/keyd/internal/keys	2.423s
ok  	github.com/shadowhusky/localdot/keyd/internal/llm	4.511s
ok  	github.com/shadowhusky/localdot/keyd/internal/netguard	4.428s
ok  	github.com/shadowhusky/localdot/keyd/internal/policy	4.017s
ok  	github.com/shadowhusky/localdot/keyd/internal/scrub	2.739s
ok  	github.com/shadowhusky/localdot/keyd/internal/surrogate	3.268s
ok  	github.com/shadowhusky/localdot/keyd/internal/vault	5.530s
```

**Counts** (`go test -json`): 175 top-level tests (174 pass, 1 skip, the opt-in Keychain test) and
34 subtests. By package: surrogate 8, vault 15, netguard 13, audit 8, events 3, cellca 9, scrub 11,
policy 7, keys 9, egress 64, llm 18, admin 7, cmd/keyd 3.

**Stability**
- `go test -race -count=10 ./...` passed (egress 63.7 s).
- `go test -count=20 -cpu 1,4 ./internal/egress/ ./internal/admin/ ./cmd/keyd/ ./internal/llm/`
  passed three times. `cmd/keyd` passes are real: 120 for 3 tests × 20 × 2.
- The new and changed gateway tests passed `-race -count=5 -cpu 1,4`.

**Task by task, from the final text alone** (`tools/replay_plan.py ../plan-final.md`)

Red is the previous stage plus the task's test files. Green is the task's stage, checked with
`gofmt -l .`, `go vet ./...`, `go test -race` on the task's packages and `go test ./...`, plus
`go mod verify` from Task 11. All 75 green checks passed.

| Task | Red: first error (the step's named failure) | Green, top-level tests in the task's packages |
|---|---|---|
| 1 | (no earlier stage; unchanged) | surrogate 8 |
| 2 | `vault_test.go:15:35: undefined: Store` | vault 12 (1 skipped) |
| 3 | `seal_test.go:13:12: undefined: NewOpener` | vault 15 (1 skipped) |
| 4 | `guard_test.go:13:15: undefined: Guard` | netguard 13 |
| 5 | audit and events build failures, as the step says | audit 8, events 3 |
| 6 | `cellca_test.go:18:15: undefined: CA` | cellca 9 |
| 7 | `scrub_test.go:27:30: undefined: Scrubber` | scrub 11 |
| 8 | `policy_test.go:9:22: undefined: Target` | policy 7 |
| 9 | `inspect_test.go:14:46: undefined: Binding` | keys 9 |
| 10 | `cell_test.go:38:19: undefined: Cell` | egress 16 |
| 11 | `connect_test.go:101:27: undefined: ReasonSNIMismatch` | egress 23 |
| 12 | `mitm_test.go:39:65: unknown field CA in struct literal of type Config` | egress 38 |
| 13 | `budget_test.go:16:55: undefined: Budget` | llm 18 |
| 14 | `gateway_test.go:80:7: deps.Budget undefined (type Deps has no field or method Budget)` | egress 57 |
| 15 | `manager_test.go:26:33: undefined: Manager` | egress 63 |
| 16 | cmd and admin build failures, as the step says | admin 7, cmd/keyd 3 |
| 17 | passes at once, as the step says | egress 64 (S4: 15 subtests) |

**New tests against revision 1's code** (`redcheck/`, made from `part4a-fix/plan-build`)

Every new or changed test fails there.
- **Run as written.**
  - keys `TestHTTPRecords`: "a prefix ending in a slash must permit only what lies under it, not
    its parent".
  - egress `TestAnUnrequestedEncodingIsRefused`: `gzip-gz: 200 ""`, `gzip-br: 200 ""`.
  - egress `TestASurrogateInTheHostHeaderIsRefusedAndAlerted`: `421 "host-mismatch"`.
  - admin `TestBudgetAndModels`: "a priced model without its maximum output: 200".
  - The other tests in those three files still pass on revision 1.
- **Gateway tests, with the smallest port.** The port drops three `MaxOutput` fields, passes `1`
  to the old `Reserve` for the $4.50 pre-spend, and adds `const ReasonChoiceCount`; it compiles
  against revision 1.
  - `TestNoRequestShapeOvershootsTheBudget`: the attack table above.
  - `TestTheGatewayWritesTheCapInTheProvidersField`: the provider read every body unchanged (for
    example `max_completion_tokens:<nil>`, or `max_output_tokens:1` with no `max_tokens`).
  - `TestScreenshotsDoNotStopATaskEarly`: "refused after 0 calls, with $4.5000 of $5.00 spent". From
    $0: "call 21 refused 402 after 20 calls, $1.8900 of $5.00 spent", `needUSD` 3.131874.
  - `TestABudgetRefusalIsAnnounced`: "the refusal published no budget.exceeded".
  - `TestCountingTokensNeverWaits`: "count_tokens waited for a running stream".
  - `TestASecretReplacedWhileARequestWaitsIsNotSent`: "the waiting request got 200; the provider saw
    keys [… replacement-secret-value-for-test]".
  - `TestACutStreamIsChargedTheMostItCanHaveCost`: "charged 3765, want 18000".
  - `TestAnAnswerWithoutUsageIsChargedItsHold`: charged 1,560, the byte estimate.
  - The two parallel tests: 1 and 2 answers, under the old expectations.
- **Failing to build, because the API is new.**
  - keys `TestEachOperationNamesItsOutputCap`: `op.Body undefined (type Op has no field or method
    Body)`.
  - llm, all four test files: `budget_test.go:31:25: undefined: Ask`, `unknown field MaxOutput in
    struct literal of type Price`, `h.Tokens undefined`, and the rest.
- **llm properties, ported to revision 1's API.**
  - `OutputCap` reads `{"max_completion_tokens":null}`, Gemini's null and `{"max_tokens":0}` as a
    cap of 0, and `64.5` as 65.
  - Five screenshots hold 3,061,908 micro-dollars.
  - $15.10 asked of $5 is refused, not lowered.
  - A priced model without a maximum is accepted.

**Other checks, repeated from revision 1**
- **Sealing.** The plan's JS function, extracted from the revised text, ran in Node 25.6.0. It sealed
  an HTTP record (two hosts, methods, `&<>"'` in a path) and an `openai-compatible` record; Go opened
  both (`opened "fake-key-from-webcrypto", <nil>`) and refused each under another id.
- **Task 16's binary run, exactly as its step.** It gave `keyd ready socket=/tmp/kdh-…/keyd/admin.sock
  boot=8cb0f51b1d9426f5`, a status with `"limits":{"perTaskUSD":5,"perDayUSD":20}` and a `sealKey`,
  and `Opened` starting `{"cellId":"c1","port":4795,"proxyToken":"…`. File modes were `srw-------`,
  `-rw-------` twice and `-rw-r--r--`, and it ended `audit ok: 4 lines`. Through the same binary,
  models without `maxOutputTokens` got `400`, and with it `200`.
- **Odd path.** The suite passed (13 `ok`) from `…/part4a-fix2/odd path's dir/keyd`.
- **Scans.** `grep -cP '\\u[0-9a-fA-F]{4}'` gives 0 for the plan and 0 for the module's Go files.
  The repository's hygiene patterns (`scripts/check-hygiene.mjs`, read only) find nothing in the
  module; the plan's only hit is its own Global Constraint naming the forbidden names, as before.
- **HTTP/2.** The fake providers see `HTTP/2.0 accept-encoding=gzip`.
  `TestInformationalResponseHeadersAreScrubbed` fails without `scrubbedWriter` (`early hints
  [... k=real-secret-value-for-test ...]`) and passes with it.
- **Timing.** The full screenshot scenario takes 34 s under `-race`: each call parses its 3 MB body
  four times, 0.64 s, against 21 ms without the race detector. That is why the plan's test starts at
  $4.50 (3.9 s).
