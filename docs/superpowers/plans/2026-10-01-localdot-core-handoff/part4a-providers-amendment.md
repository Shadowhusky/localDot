# Part 4a amendment: first-class bearer providers and unpriced models (from Part 5a, P5a-R31, P5a-R32)

**Why.** The user's ruling of 2026-10-02 makes xAI, Mistral, DeepSeek, Groq and OpenRouter
first-class: each uses its official AI SDK package and gets its own keyd route (spec "Providers and
sign-in", "First-class providers" and "Keys"). Part 5a's plan decides how keyd gives them routes
(P5a-R31). Tasks 13 and 14 were not built when this was written, so the change goes into their plan
text. Task 9's `keys/binding.go` is built, so Task 14 edits it.

**Decision.** Five rows in keyd's preset table, not a new route kind. All five use the bearer auth
style keyd already has. Each preset has a fixed base URL, its own surrogate tag, and only the
operation its official package calls, with the cap field that package sends. A key stored for one
is its own route, with its own host, prices and audit lines. No new Go type, `Body` API or code path.

| Preset | Base URL | Tag | Operations (cap field) |
|---|---|---|---|
| `xai` | `https://api.x.ai/v1` | `xai` | `POST responses` (`max_output_tokens`), `GET models`, `models/{id}` |
| `mistral` | `https://api.mistral.ai/v1` | `mis` | `POST chat/completions` (`max_tokens`; body `mistral`: images by Mistral's rule), `GET models`, `models/{id}` |
| `deepseek` | `https://api.deepseek.com` | `dsk` | `POST chat/completions` (`max_tokens`; body `chat`), `GET models`, `models/{id}` |
| `groq` | `https://api.groq.com/openai/v1` | `grq` | as `deepseek` |
| `openrouter` | `https://openrouter.ai/api/v1` | `orr` | as `deepseek`, body `openrouter`: images by the largest rule keyd knows |

**What changed in the plan** (`2026-10-01-localdot-core-part4a-keyd-core.md`):
- **Task 13** (bookkeeping):
  - `Meter` also reads `x_groq.usage`. Groq streams report usage only there, so every Groq answer
    was charged its whole hold. New test: `TestMeterReadsTheFirstClassBearerProviders` (each
    provider's stream, and a nested `x_groq` that must not count).
  - `ReadRequest` refuses a non-null `models` list as a `ChoiceError`, and the gateway answers 400
    `choice-count`. OpenRouter's fallback models can answer with a model off the allowlist at its
    own price. `TestReadRequest` gains the cases.
  - `images.go` gains `BodyMistral` and `BodyOpenRouter` (controller's ruling: the hold must cover
    what Mistral bills). Mistral's rule follows its vision documentation: a token per 16-pixel
    patch, a break per row and an end token, unscaled, capped at a 2048-pixel square's 16,513. A
    1280×800 screenshot is 4,051 tokens; OpenAI's rule held 2,460. OpenRouter, which serves every
    vendor's models, takes the largest rule keyd knows. `TestImagesArePricedByTheProvidersRule`
    gains six cases.
  - 19 tests become 20.
- **Task 14** (gateway):
  - `keys/binding.go` gains the five presets, `chatOnlyOps`, `xaiOps` and `withListings`. New test
    file `keys/presets_test.go`, with `TestTheFirstClassBearerPresets`.
  - `TestEachFirstClassBearerProviderHasItsOwnRoute` (gateway): each provider's host and base path,
    the bearer swap, its usage charged, the operation it never calls refused, and `models` refused.
  - **A fix found on the way:** the upstream path is now `path.Join("/", base, rest)`. A base URL
    without a path (DeepSeek's, or a user's `https://api.perplexity.ai`, which Part 5a's registry
    names) gave the upstream request the relative path `chat/completions`. Go's HTTP/2 client
    refuses that, so every request on such a route got 502 `upstream-error`; an HTTP/1 server
    answers it 400.
  - **No price, no route** (P5a-R32, controller's ruling): a model priced at $0 both ways gets 403
    `model-unpriced` on any route that is not local. That covers OpenRouter's routers such as
    `openrouter/auto`, its free models, and a mistake in the prices. Local servers stay free. New
    test: `TestAnUnpricedModelNeverRunsOnAPaidRoute`. The daemon refuses the same picks first, and
    lets the user give a price.
  - `egress`: 58 tests become 60.
- **Interfaces and decisions:**
  - the route table and `PUT /v1/secrets/{id}`'s provider list gain the five;
  - the `choice-count` line names `models`;
  - P4a-R14 names the fixed-base presets.

**Why the xAI route has no chat operation.** xAI's chat completions report reasoning tokens outside
`completion_tokens`; the AI SDK's own xAI chat code (`@ai-sdk/xai` 3.x) added them back. keyd's meter
would undercharge them. xAI's package (5.x) calls only the Responses API, whose `output_tokens`
include reasoning.

**Residuals** (as P4a-R15 already allows):
- xAI, DeepSeek and Groq images are still held by OpenAI's rule.
- Mistral's rule was taken from its documentation as recalled. No third-party calls were allowed,
  so it was not fetched; the check belongs to the pre-flight.
- DeepSeek's and xAI's cached input is charged at the input price, an overcharge.

**Verified:** compiled and tested against `origin/feat/core-part4a` in a scratch copy, with Tasks
10–14 applied from the amended plan text. See `reports/plan-part5a-providers-report.md`.
