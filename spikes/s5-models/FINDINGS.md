# S5 findings: models through a key-swapping gateway

2026-10-01 · macOS 26.6.2, Apple M3 Ultra (96 GB) · Node 25.6.0, pnpm 10.29.3 · ai 7.0.123, @ai-sdk/anthropic
4.0.69, @ai-sdk/openai 4.0.82, @ai-sdk/google 4.0.86, @ai-sdk/openai-compatible 3.0.60, zod 4.6.5, sharp 0.35.5 ·
LM Studio 0.4.24+1 with `qwen/qwen3.8-27b` (GGUF Q4_K_M, 16,384 context, loaded alone) · blobs: `probe.mjs` `e95f076c`,
`swap-gateway.mjs` `f31b97a0`, `probe-image.mjs` `5946bd22` (the last two exactly as in the brief)

**Result: GO-WITH-CHANGES.** The AI SDK drives every route through the gateway holding only the surrogate. All four
providers accepted the swapped key, and the Gemini and LM Studio routes completed the full computer-tool round trip.
Anthropic and OpenAI stop at billing: both accounts are out of credit, so their native computer tools (coordinate
space, streaming) remain **unverified**. Changes:

- **Generic tool: declare 0–1000 for Gemini and Qwen, and convert in the gateway.** Both emit per1000 whatever the
  tool says. Gemini 3.1 Flash-Lite did in 8 of 8 calls (4 of them told "screenshot pixels"), Gemini 3.5 Flash-Lite in
  2 of 2, and Qwen3.8-27B in 7 of 8 (told per1000: 4 of 4; told pixels: per1000 3 times, real pixels once). The
  brief's Gemini case (told pixels) misses every time, and the same answers hit when read as per1000. The spec's open
  risk "Qwen's coordinate space is assumed to be 0–1000" is confirmed.
- **Generic tool schema: a length-2 number array, not `z.tuple`.** Gemini rejects zod's draft-07 tuple:
  `400 schema at properties.coordinate.items must be a boolean or an object`.
- **Streaming intent: dispatch on the completed `tool-call`, not on partial input.** On every measured route the
  coordinates arrive in one piece at the same moment as the complete call (`wireFragments: 1`). In a click the
  coordinate is the input's last field anyway. Spec step 1 ("as soon as the coordinates parse … while the rest of
  the call is still streaming") gains nothing over "when the action's call completes". `tool-input-start` comes about
  1.1 s earlier on LM Studio and can drive an "aiming" state, but it carries no coordinates.
- **keyd: an upstream failure must answer 502, not crash.** The brief's gateway dies on a failed upstream `fetch`.
- **Send screenshots as `file` parts.** The `image` content part is deprecated in ai 7.0.123.

Re-run the blocked paths once credit is added: `PROBE_CASES=anthropic,openai node probe.mjs`, and
`ANTHROPIC_CU_MODEL=claude-sonnet-5-5` for the spec's Sonnet 5.5 toolset path.

## What ran

- Image: `out/probe.png`, 1280×800. Target Gamma: box x 900–1080, y 610–674, centre (990, 642). For the Delta run
  the target is Delta: box x 560–720, y 380–436, centre (640, 408). One user message holds the brief's prompt and the
  image. `streamText` runs with `includeRawChunks: true` and `maxRetries: 0`.
- Route for every case: SDK provider → `http://127.0.0.1:4797/<provider>/…` with the surrogate → the gateway swaps
  in the real key → `api.anthropic.com`, `api.openai.com` (Responses API), `generativelanguage.googleapis.com/v1beta`
  or LM Studio on `127.0.0.1:1234`.
- **Run 1:** `node probe.mjs`, all six cases (the brief's Step 4); Anthropic and OpenAI were called once.
- **Runs 2–3:** `PROBE_CASES=google,lmstudio`.
- **Delta:** the same with `PROBE_TARGET=Delta`.
- **3.5 check:** `GEMINI_CU_MODEL=gemini-3.5-flash-lite PROBE_CASES=google`.
- Run 1 predates the `wireFragments` and `firstWireFragmentMs` output fields. Otherwise it ran the committed code.
  An earlier Gemini 3.1 run while choosing the model returned exactly Run 1's answers (`[803, 803]`, `[773, 802]`).

## Results

### Blocked

| Case | Route | Result (Run 1; same in the smoke run) |
|---|---|---|
| anthropic `claude-haiku-4-5-20251001`, `computer_20250124` | api.anthropic.com Messages | `400` "Your credit balance is too low to access the Anthropic API." (498 ms) |
| openai `gpt-6-luna`, `computer` tool | api.openai.com Responses | `429` "You have no credits remaining." (`insufficient_quota`, code `credit_balance_exhausted`; 1,493 ms) |
| google `gemini-2.5-flash-lite` (smoke run only) | generativelanguage v1beta | `404` "models/gemini-2.5-flash-lite is no longer available to new users" |
| google `gemini-3.1-flash-lite` with `z.tuple` schema | generativelanguage v1beta | `400` "schema at properties.coordinate.items must be a boolean or an object" |

### Coordinates

"As told" reads the answer in the space the tool description declared. "Other reading" reads the same answer in the
other space. Distances are from the target centre.

| Run | Case | Raw `coordinate` | As told: screen, distance | Other reading: screen, distance | Space used |
|---|---|---|---|---|---|
| 1 | gemini-3.1-flash-lite, told pixels | `[803, 803]` | (803, 803) 247 px miss | (1028, 642) 38 px hit | per1000 |
| 1 | gemini-3.1-flash-lite, told per1000 | `[773, 802]` | (989, 642) 1 px hit | (773, 802) 270 px miss | per1000 |
| 1 | qwen3.8-27b, told per1000 | `[771, 800]` | (987, 640) 4 px hit | (771, 800) 270 px miss | per1000 |
| 1 | qwen3.8-27b, told pixels | `[772, 800]` | (772, 800) 269 px miss | (988, 640) 3 px hit | per1000 |
| 2 | gemini-3.1-flash-lite, told pixels | `[802, 802]` | (802, 802) 247 px miss | (1027, 642) 37 px hit | per1000 |
| 2 | gemini-3.1-flash-lite, told per1000 | `[773, 803]` | (989, 642) 1 px hit | (773, 803) 270 px miss | per1000 |
| 2 | qwen3.8-27b, told per1000 | `[771, 800]` | (987, 640) 4 px hit | (771, 800) 270 px miss | per1000 |
| 2 | qwen3.8-27b, told pixels | `[772, 800]` | (772, 800) 269 px miss | (988, 640) 3 px hit | per1000 |
| 3 | gemini-3.1-flash-lite, told pixels | `[802, 802]` | (802, 802) 247 px miss | (1027, 642) 37 px hit | per1000 |
| 3 | gemini-3.1-flash-lite, told per1000 | `[802, 762]` | (1027, 610) 49 px miss | (802, 762) 223 px miss | per1000, near miss (y 609.6, box top 610) |
| 3 | qwen3.8-27b, told per1000 | `[771, 800]` | (987, 640) 4 px hit | (771, 800) 270 px miss | per1000 |
| 3 | qwen3.8-27b, told pixels | `[980, 642]` | (980, 642) 10 px hit | (1254, 514) 294 px miss | **pixels** |
| Delta | gemini-3.1-flash-lite, told pixels | `[500, 510]` | (500, 510) 173 px miss | (640, 408) 0 px hit | per1000 |
| Delta | gemini-3.1-flash-lite, told per1000 | `[500, 510]` | (640, 408) 0 px hit | (500, 510) 173 px miss | per1000 |
| Delta | qwen3.8-27b, told per1000 | `[499, 508]` | (639, 406) 2 px hit | (499, 508) 173 px miss | per1000 |
| Delta | qwen3.8-27b, told pixels | `[500, 508]` | (500, 508) 172 px miss | (640, 406) 2 px hit | per1000 |
| 3.5 check | gemini-3.5-flash-lite, told pixels | `[772, 801]` | (772, 801) 270 px miss | (988, 641) 2 px hit | per1000 |
| 3.5 check | gemini-3.5-flash-lite, told per1000 | `[772, 802]` | (988, 642) 2 px hit | (772, 802) 270 px miss | per1000 |

### Timing

Times are in ms from the request start, measured at the client through the gateway.

- *first chunk*: the first raw provider event.
- *tool-input-start* and *first tool-input-delta*: the SDK's stream parts.
- *fragments*: raw events that carried tool-input text.
- *coordinate on wire*: the first moment the raw events hold a complete coordinate.
- *tool-call*: the brief's `totalMs`.

| Run | Case | First chunk | tool-input-start | First tool-input-delta | Fragments | Coordinate on wire | tool-call | Tokens in / out (reasoning) |
|---|---|---|---|---|---|---|---|---|
| 1 | gemini-3.1-flash-lite, told pixels | 823 | 824 | 824 | n/a | 823 | 824 | 1222 / 27 (0) |
| 1 | gemini-3.1-flash-lite, told per1000 | 693 | 693 | 693 | n/a | 693 | 693 | 1232 / 27 (0) |
| 1 | qwen3.8-27b, told per1000 | 6194 | 9752 | 10800 | n/a | 10800 | 10800 | 1370 / 142 (92) |
| 1 | qwen3.8-27b, told pixels | 5521 | 8192 | 9242 | n/a | 9242 | 9243 | 1360 / 125 (61) |
| 2 | gemini-3.1-flash-lite, told pixels | 833 | 834 | 834 | 1 | 833 | 834 | 1222 / 27 (0) |
| 2 | gemini-3.1-flash-lite, told per1000 | 621 | 622 | 622 | 1 | 621 | 622 | 1232 / 27 (0) |
| 2 | qwen3.8-27b, told per1000 | 632 | 2193 | 3260 | 1 | 3260 | 3260 | 1370 / 88 (38) |
| 2 | qwen3.8-27b, told pixels | 180 | 2316 | 3445 | 1 | 3445 | 3445 | 1360 / 110 (60) |
| 3 | gemini-3.1-flash-lite, told pixels | 1023 | 1023 | 1023 | 1 | 1023 | 1023 | 1222 / 27 (0) |
| 3 | gemini-3.1-flash-lite, told per1000 | 1916 | 1917 | 1917 | 1 | 1916 | 1917 | 1232 / 27 (0) |
| 3 | qwen3.8-27b, told per1000 | 524 | 4541 | 5583 | 1 | 5583 | 5583 | 1370 / 160 (110) |
| 3 | qwen3.8-27b, told pixels | 175 | 1940 | 3061 | 1 | 3061 | 3062 | 1360 / 97 (47) |
| Delta | gemini-3.1-flash-lite, told pixels | 672 | 673 | 674 | 1 | 672 | 674 | 1222 / 27 (0) |
| Delta | gemini-3.1-flash-lite, told per1000 | 712 | 712 | 712 | 1 | 712 | 713 | 1232 / 27 (0) |
| Delta | qwen3.8-27b, told per1000 | 6019 | 9292 | 10409 | 1 | 10409 | 10410 | 1370 / 149 (99) |
| Delta | qwen3.8-27b, told pixels | 5396 | 7157 | 8277 | 1 | 8277 | 8277 | 1360 / 101 (51) |
| 3.5 check | gemini-3.5-flash-lite, told pixels | 821 | 822 | 822 | n/a | 822 | 822 | 1222 / 26 (0) |
| 3.5 check | gemini-3.5-flash-lite, told per1000 | 769 | 769 | 769 | n/a | 769 | 770 | 1232 / 26 (0) |

## Coordinate space per model

| Model | Tool | Space | Evidence |
|---|---|---|---|
| `gemini-3.1-flash-lite` | generic | **per1000** | Told per1000: 1, 1 and 0 px, plus one 49 px near miss. Told pixels: the answers are still per1000, 37–38 px from Gamma's centre and 0 px on Delta. |
| `gemini-3.5-flash-lite` | generic | **per1000** | 2 px under either wording |
| `qwen/qwen3.8-27b` (LM Studio) | generic | **per1000** | Told per1000: 4, 4, 4 and 2 px. Told pixels: per1000 3 of 4 times (3, 3 and 2 px) and real pixels once (10 px). |
| `claude-haiku-4-5-20251001` | `computer_20250124`, display 1280×800 | unverified | no credit |
| `gpt-6-luna` | Responses `computer` | unverified | no credit |

- **Telling Gemini "pixels" costs accuracy without changing the space.** Told per1000, its Gamma answers land 1 px
  from centre. Told pixels, they are per1000 values 37–38 px to the right.
- **Telling Qwen "pixels" makes the space ambiguous.** An answer below 1000 can't be classified, so the gateway can't
  tell which space a given call used. Declare per1000.
- The brief's ×1.28 / ×0.8 signature (pixels emitted in a per1000 case) never occurred. The reverse did: per1000
  emitted in a pixels case, which reads as (772, 800) instead of (988, 640), a ÷1.28 / ÷0.8 miss.

## When the coordinates arrive

**Measured:**

- **Gemini API.** One SSE chunk carries the whole `functionCall`. The first chunk, `tool-input-start`, the first
  `tool-input-delta`, the coordinate and `tool-call` all fall within 1 ms of each other, 0.62–1.92 s after the
  request. @ai-sdk/google 4.0.86 streams partial arguments (`streamFunctionCallArguments`) only on Vertex. On the
  Gemini API it warns and ignores the option (source).
- **LM Studio (chat completions).**
  - The tool name arrives first (`tool-input-start`). The arguments follow 1.04–1.13 s later in a single chunk, at
    the same moment as `tool-call`.
  - Before calling, Qwen reasons for 38–110 tokens.
  - **Cold** (a prompt LM Studio hasn't cached, which includes every new screenshot): first chunk 5.4–6.2 s, the
    prefill of about 1,360 input tokens including the image; tool call 8.3–10.8 s.
  - **Warm** (identical prompt and image, prefix cached; Runs 2–3): first chunk 0.17–0.63 s, tool call 3.1–5.6 s.
  - The Delta run, a new prompt, went back to cold, which confirms the cache. Expect the cold figures per agent step.

**From the SDK source** (not measured, no credit):

- **Anthropic `computer_20250124`** (Haiku 4.5): each `input_json_delta` is forwarded as a `tool-input-delta`, so the
  input streams.
- **Anthropic `computerToolset_20260801`** (5.x models):
  - The SDK buffers each member's input until `content_block_stop` and emits it as one `tool-input-delta` right
    before `tool-call`. The wire still streams `input_json_delta`, and `includeRawChunks` exposes it.
  - Each action is its own `tool_use` block, so in a multi-action turn the first action's `tool-call` arrives before
    the next action streams.
- **OpenAI `computer`** (Responses): `computer_call` items have no argument deltas. The SDK emits `tool-input-start`
  at `response.output_item.added`, then the whole input with all batched actions at `response.output_item.done`.

**Conclusion.** Parsing partial input gained 0 ms on every measured route. Where input does stream, a click's
coordinate completes a few tokens before the call ends. The brain should forward each action when its `tool-call`
completes, and may use `tool-input-start` to start an "aiming" state.

## Gateway (`swap-gateway.mjs`, as in the brief)

- **Surrogate checks** (curl through `127.0.0.1:4797`):
  - 403 with no surrogate, a wrong surrogate, the surrogate in the wrong header (Bearer on the anthropic route), or
    an unknown route.
  - 200 with the surrogate in the provider's own header: model listing works on all four routes.
- **Swap.** Every provider accepted the swapped key. Anthropic and OpenAI refused only for billing (400 credit
  balance, 429 `insufficient_quota`), never 401. The SDK clients held only the surrogate.
- **Streaming.** SSE passes through intact (Gemini, LM Studio), with `content-encoding` dropped after fetch decodes.
- **Gap: an upstream failure kills the gateway.** With `fetch` stubbed to reject, a request carrying the surrogate
  crashed the process (unhandled rejection in the async handler, exit 1). The client got an empty reply (curl exit
  52). The probe hosts the gateway, so a stopped LM Studio server would end the whole run. keyd must answer 502 and
  keep serving.
- **Key exposure.**
  - The gateway runs inside the probe process (brief design), so that process had the keys in its environment and
    only the gateway read them. In keyd they sit behind a process boundary.
  - The probe redacts key values and `sk-…` / `AIza…` patterns from any recorded error text.
  - A scan of `spikes/s5-models` (including `out/`) and the run logs for the three key values found none.

## Model choice (Ruling 8: cheapest model per provider)

Prices are models.dev list prices, per M input / output tokens.

- **Anthropic: `claude-haiku-4-5-20251001`** ($1 / $5), the cheapest model listed through the gateway. It used
  `computer_20250124` at 1280×800, and the SDK adds `anthropic-beta: computer-use-2025-01-24`.
  - Blocked by `400` credit balance. Every combination tried (Haiku 4.5, Sonnet 5 and Sonnet 5.5, each with the
    classic tool and the toolset) returned the same credit error, so which tool versions each model accepts is
    unknown.
  - @ai-sdk/anthropic 4.0.69 documents `computerToolset_20260801` for Opus 5.5, Opus 5, Sonnet 5, Fable 5, Fable 5.1
    and Opus 4.8. Sonnet 5.5 (released 2026-09-28) isn't listed yet.
- **OpenAI: `gpt-6-luna`** ($0.10 / $0.50), the cheapest model that passed the `computer` tool check.
  - Screening sent each model, cheapest first, a text-only Responses request with `tools: [{"type": "computer"}]`.
  - Rejected with "Tool 'computer' is not supported with <model>": `gpt-5-nano`, `gpt-4.1-nano`, `gpt-4o-mini`,
    `gpt-5.4-nano`, `gpt-5-mini`, `gpt-4.1-mini`.
  - Passed the tool check, then got `429` no credits: `gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.4-mini`, `gpt-5.4`,
    `gpt-5.5`, `gpt-6.1-sol`.
  - The tool check runs first: on the same empty account, the unsupported models got the tool error, not the credit
    error.
  - The generic-tool fallback (`gpt-5-nano` with a function tool) hits the same credit error. It wasn't needed.
- **Google: `gemini-3.1-flash-lite`** ($0.25 / $1.50).
  - `gemini-2.5-flash-lite` ($0.10 / $0.40) is cheaper but returns `404` for new users.
  - Cross-check: `gemini-3.5-flash-lite` ($0.30 / $2.50), the id Google's 404 recommends and the newest Flash-Lite
    listed.
- **Local: `qwen/qwen3.8-27b`**, the only model loaded in LM Studio for the runs and unloaded afterwards.

## Changes from the brief

- **Models.** Model ids and the Anthropic tool follow Ruling 8. The overrides `ANTHROPIC_CU_MODEL`, `OPENAI_CU_MODEL`
  and `GEMINI_CU_MODEL` remain. The brief's Sonnet 5.5 case is `ANTHROPIC_CU_MODEL=claude-sonnet-5-5` (toolset path).
- **Schema.** The generic tool uses `z.array(z.number()).length(2)` instead of `z.tuple`, because of Gemini's 400.
- **Screenshot.** It is sent as a `file` part. `image` is deprecated, and the provider payload is the same.
- **Added cases.** Gemini told per1000 and Qwen told pixels, so each working model is seen under both wordings.
- **Stream reading.** The loop reads to the end of the stream to collect usage, instead of breaking at the first
  `tool-call`. `totalMs` is still the first `tool-call` that has coordinates.
- **Added result fields:** `firstChunkMs`, `inputStartMs`, `wireFragments`, `firstWireFragmentMs`,
  `wireCoordinateMs`, `endMs`, `usage`, and `ifOtherSpace` (the same answer read in the other space).
- **Error handling.** `maxRetries: 0` gives one attempt per case and honest timing. `onError` is silenced because
  errors are recorded, and error text is redacted.
- **Knobs:** `PROBE_CASES` (comma-separated substrings of case names), `PROBE_TARGET` (a target label) and `PROBE_OUT`
  (the results path).

## Cost

About **$0.004** at list prices:

- `gemini-3.1-flash-lite`: 10 calls, 12,270 input / 270 output tokens, $0.0035.
- `gemini-3.5-flash-lite`: 2 calls, 2,454 / 52 tokens, $0.0009.

Every Anthropic and OpenAI request (smoke run, Run 1, screening) was refused before generation. LM Studio is local.
One Flash-Lite click with the 1280×800 image costs about 1,230 input and 27 output tokens, about $0.00035.

## Reproduce

```bash
cd spikes/s5-models && pnpm install && node probe-image.mjs
lms load qwen/qwen3.8-27b -c 16384 -y     # and nothing else
# OPENAI_API_KEY, ANTHROPIC_API_KEY and GEMINI_API_KEY in this shell's environment only
node probe.mjs                             # Run 1 → out/results.json
PROBE_CASES=google,lmstudio PROBE_OUT=out/results-run2.json node probe.mjs
PROBE_TARGET=Delta PROBE_CASES=google,lmstudio PROBE_OUT=out/results-delta.json node probe.mjs
GEMINI_CU_MODEL=gemini-3.5-flash-lite PROBE_CASES=google PROBE_OUT=out/results-gemini-3.5-flash-lite.json node probe.mjs
lms unload --all
```

## Raw: Run 1 (`out/results.json`)

```
{"case":"anthropic claude-haiku-4-5-20251001 (computer_20250124)","status":400,"error":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.","elapsedMs":498}
{"case":"openai gpt-6-luna (computer tool)","status":429,"error":"You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.","elapsedMs":1493}
{"case":"google gemini-3.1-flash-lite (generic tool, pixels)","raw":{"action":"left_click","coordinate":[803,803]},"space":"pixels","screen":{"x":803,"y":803},"offBy":247,"hit":false,"ifOtherSpace":{"space":"per1000","screen":{"x":1028,"y":642},"offBy":38,"hit":true},"firstChunkMs":823,"inputStartMs":824,"firstDeltaMs":824,"wireCoordinateMs":823,"totalMs":824,"endMs":826,"toolCalls":1,"usage":{"input":1222,"output":27,"reasoning":0},"reasoningChars":0,"text":""}
{"case":"google gemini-3.1-flash-lite (generic tool, per1000)","raw":{"action":"left_click","coordinate":[773,802]},"space":"per1000","screen":{"x":989,"y":642},"offBy":1,"hit":true,"ifOtherSpace":{"space":"pixels","screen":{"x":773,"y":802},"offBy":270,"hit":false},"firstChunkMs":693,"inputStartMs":693,"firstDeltaMs":693,"wireCoordinateMs":693,"totalMs":693,"endMs":697,"toolCalls":1,"usage":{"input":1232,"output":27,"reasoning":0},"reasoningChars":0,"text":""}
{"case":"lmstudio qwen3.8-27b (generic tool, per1000)","raw":{"action":"left_click","coordinate":[771,800]},"space":"per1000","screen":{"x":987,"y":640},"offBy":4,"hit":true,"ifOtherSpace":{"space":"pixels","screen":{"x":771,"y":800},"offBy":270,"hit":false},"firstChunkMs":6194,"inputStartMs":9752,"firstDeltaMs":10800,"wireCoordinateMs":10800,"totalMs":10800,"endMs":10801,"toolCalls":1,"usage":{"input":1370,"output":142,"reasoning":92},"reasoningChars":327,"text":""}
{"case":"lmstudio qwen3.8-27b (generic tool, pixels)","raw":{"action":"left_click","coordinate":[772,800]},"space":"pixels","screen":{"x":772,"y":800},"offBy":269,"hit":false,"ifOtherSpace":{"space":"per1000","screen":{"x":988,"y":640},"offBy":3,"hit":true},"firstChunkMs":5521,"inputStartMs":8192,"firstDeltaMs":9242,"wireCoordinateMs":9242,"totalMs":9243,"endMs":9243,"toolCalls":1,"usage":{"input":1360,"output":125,"reasoning":61},"reasoningChars":241,"text":"Click the Gamma button in the bottom right area of the screen.\n\n"}
```
