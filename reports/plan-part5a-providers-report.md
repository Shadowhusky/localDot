# Job plan-part5a-providers: report

**Status: DONE_WITH_CONCERNS**

- **Branch:** `claude/plan-part5a-providers`, made from `2c94cd5` with `origin/planning` merged in
  (the spec's "First-class providers" paragraph).
- **Commits:**
  - `a7b81e0`: first-class providers and their keyd presets;
  - `9cccc0e`: verification fixes;
  - `7ef037c`: the controller's rulings (Azure, stateless Responses, budget gaps);
  - this report.
- The branch was rebuilt and force-pushed so this report stays the last commit. The merge
  commit was re-authored, because the first one carried the tooling's default identity.

## What changed
**Part 5a plan** (`docs/superpowers/plans/2026-10-01-localdot-core-part5a-agent-core.md`):
- **First-class providers.** xAI, Mistral, DeepSeek, Groq and OpenRouter each get:
  - their own `ClientKind` and keyd kind;
  - an entry in Part 4b's `LLM_PROVIDERS` and the key sheet's names;
  - a registry entry under their models.dev id, with no base URL, because keyd fixes it.
- **Official packages** in `languageModel`, each pinned to the release built on the lockfile's
  provider 4.0.20 and provider-utils 5.0.52, all Apache-2.0:
  - `@ai-sdk/azure` 4.0.86, which also uses the pinned openai 4.0.82;
  - `@ai-sdk/xai` 5.0.13, `@ai-sdk/mistral` 4.0.55, `@ai-sdk/deepseek` 3.0.57, `@ai-sdk/groq` 4.0.53;
  - `@openrouter/ai-sdk-provider` 3.1.0.
- **Azure (ruling 1)** now uses `@ai-sdk/azure`: its Responses API, the `api-key` header, and
  `<route>/responses` with no api-version. P5a-R4 is narrowed to the other eight providers.
- **The eight others** (Together, Fireworks, Cerebras, Perplexity, Cohere, DeepInfra, Moonshot,
  Alibaba) stay on the OpenAI-compatible client.
- **Capabilities.** The 0–1000 grid now also follows "gemini" in the model id, wherever it is
  served. Claude through OpenRouter gets the generic tool.
- **P5a-R33, nothing stored on the provider (ruling 2).** OpenAI, Azure and xAI requests go
  through the AI SDK's `defaultSettingsMiddleware` with `store: false`.
  - Reasoning models are asked for `include: ["reasoning.encrypted_content"]`. The xAI package adds
    that itself.
  - The next turn sends the encrypted reasoning back instead of an `item_reference`.
  - The daemon's transcript keeps the encrypted reasoning, so a restarted brain still has it.
- **P5a-R32, no price, no route (ruling 3b).**
  - The daemon refuses OpenRouter routers (`openrouter/…`) outright.
  - It refuses a model at $0 both ways, or an Other model, unless `RoleChoice.price` gives a price.
  - keyd refuses such a model too (below).
- **Tests.**
  - One per bearer provider through its package and fixture: own route, bearer surrogate, keyd's
    cap field, usage counted, usage asked for where needed.
  - Four for `store: false` and encrypted multi-turn reasoning.
  - One for unpriced models and routers.
- **Interfaces Part 5b builds on:** the picker must ask for a price for unpriced models.

**Part 4a** (Tasks 13 and 14; note in `…/2026-10-01-localdot-core-handoff/part4a-providers-amendment.md`):
- **P5a-R31, five presets in keyd's table (no new route kind).** All use the bearer header and a
  fixed base URL, and list only the operation their package calls. Each key is its own route.
- **Meter:** now reads `x_groq.usage`. Groq was being charged its full hold.
- **`ReadRequest`:** refuses a `models` list, OpenRouter's fallback, which bypasses the allowlist.
- **Ruling 3a, image holds:**
  - Mistral's own image rule (`BodyMistral`): a token per 16 px patch plus row breaks. A 1280×800
    screenshot holds 4,051 tokens; OpenAI's rule held 2,460.
  - OpenRouter takes the largest rule keyd knows (`BodyOpenRouter`).
- **Ruling 3b:** a model at $0 on a route that is not local gets 403 `model-unpriced`.
- **Bug fixed on the way:** the gateway now joins the upstream path under `/`. Before, a base URL
  with no path (DeepSeek's, or Perplexity's in our own registry) got 502 on every request.

## Verified
**Go:** `origin/feat/core-part4a` at `70a534e`, plus Tasks 10–14 from the amended plan text.
- gofmt and vet are clean, and `go test -race ./...` passes (`llm` 20, `egress` 60, `keys` plus the
  presets test).
- Mutations, each run once with one change taken out; each made its test fail:

| Change taken out | Result |
|---|---|
| `x_groq.usage` read | Groq charged its hold |
| `/` path join | DeepSeek 502 |
| `models` refusal | the list reached the provider |
| Mistral image rule | 2,460 held instead of 4,051 |
| unpriced check | three models reached their providers |

**TypeScript:** `feat/core-part2` at `b02765f`, Part 3 and 4b files from their plans, and every
block of this plan.
- `pnpm install` added exactly the six packages. There is still one copy of provider,
  provider-utils and openai.
- 71 files: 564 passed, 7 skipped.
- `pnpm typecheck` passes for every package, including web and brain. `pnpm hygiene` passes, and
  Biome is clean.
- The brain bundle has 19 packages, every one with a licence. It starts and fails as specified.
- Mutations: removing OpenRouter's `strict` setting, the stateless wrapper, or the unpriced check
  each fails its tests.
- The plan text, re-extracted, matches the verified code.

## Concerns
1. **Mistral's image rule** (16 px patches, row breaks, and the 2048 px cap) comes from Mistral's
   documentation as I recalled it. It was not fetched, because third-party calls are not allowed.
   The pre-flight should check it.
2. **P5a-R32 has two costs:**
   - OpenRouter `:free` models and every Other (OpenAI-compatible) model now need a price the user
     types. Part 5b's picker must ask for it.
   - keyd now refuses any $0 model on a non-local route.
3. **The Part 4a changes touch code that is already built.** Task 9's `keys/binding.go` is edited
   inside Task 14, and the gateway path fix and the `model-unpriced` reason are new. Reviewers of
   Task 14 should see all three.
4. **Azure keys** must be bound to `https://<resource>.openai.azure.com/openai/v1`. A
   deployment-style base URL gets 404s.
5. **Untested by real calls:** xAI, DeepSeek and Groq images are still held by OpenAI's rule. No
   provider was called, so the fixtures follow each SDK's own response schemas.
