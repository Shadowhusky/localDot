# Provider capabilities

Checked on 2026-10-31 against each provider's own documentation; sources are listed per provider. Where two sources disagree, both are cited and the row says so. "Undocumented" means the provider's current docs don't say, and localDot then keeps the provider's default.

- What Settings offers per model: `packages/providers/src/model-options.ts` (`FAMILIES`, `openai`, `claude`), narrowed by live model metadata in `discovery.ts` (Anthropic's Models API and OpenRouter's per-model `reasoning` object).
- How options, cache keys and earlier reasoning reach each API: `cells/brain/src/models.ts`, `context.ts` and `loop.ts`.
- Request-shape tests, stopped at the network boundary with no live calls or keys: `cells/brain/src/model-options.test.ts` (“model option wire contracts”, “prompt caching on the wire”, “older reasoning on the wire”) and `apps/daemon/src/agent/safety/judge-model.test.ts` for one-shot fast-model calls.
- User-facing behaviour and the speed tiers: [model-options.md](model-options.md).

“Offered” below is the Reasoning effort row in Settings and the composer: `Off` is `none`, `On` is `enabled`, and Provider default sends nothing.

## Summary

| Provider (route localDot uses) | Reasoning control offered | Earlier reasoning carried back | Prompt caching | Speed |
| --- | --- | --- | --- | --- |
| Anthropic (Messages, `@ai-sdk/anthropic`) | Effort per family; Off where `thinking: disabled` is accepted; budget on older models | Signed `thinking` blocks, by the SDK; dropped on a binding refusal (`thinking-binding-controls-2026-08-01`) | Explicit `cache_control` on the system prompt and the newest message | `speed: "fast"` (Opus 5.5, 5, 4.8) |
| OpenAI (Responses, stateless) | `reasoning.effort` per family, `text.verbosity` | Encrypted reasoning items (`store: false`) | Automatic; `prompt_cache_key` = task | `service_tier` fast / ultrafast |
| Azure OpenAI (Responses) | As OpenAI, by deployment name | As OpenAI | Automatic | Not offered |
| Google Gemini (generateContent) | `thinkingLevel` (3.x, 4) or `thinkingBudget` (2.5) | Thought signatures, by the SDK | Implicit (automatic) | `serviceTier: priority` |
| xAI (Responses) | `reasoning.effort` per family | Encrypted reasoning (`include`, added by the SDK with `store: false`) | Automatic; `prompt_cache_key` = task | `service_tier: priority` |
| Mistral (Chat) | `reasoning_effort` per family | Thinking chunks, by the SDK | `prompt_cache_key` = task | — |
| DeepSeek (Chat) | `thinking.type` + `reasoning_effort` | `reasoning_content` on every assistant turn (empty for settled turns) | Automatic disk cache | — |
| Groq (Chat) | `reasoning_effort` per family | Undocumented | Automatic (GPT-OSS) | Not offered |
| OpenRouter (Chat, `@openrouter/ai-sdk-provider`) | Unified `reasoning` object; levels from each model's `reasoning.supported_efforts` | `reasoning_details`, by the SDK | Claude: explicit `cache_control` marks; others automatic | `service_tier` capped by `provider.max_price` |
| Moonshot / Kimi, global and China (Chat) | K3, K3.1 Pro: `reasoning_effort` low / high / max; K2.6 on/off | `reasoning_content` | Automatic; `prompt_cache_key` = task | Separate `-highspeed` model IDs |
| Z.ai / Zhipu (Chat) | GLM 5.3: effort; 5.2: off / high / max; older: on/off | `reasoning_content` | Automatic | `glm-5.3-flashx` model ID |
| MiniMax API and Token Plan (Chat) | M3.1 Flash: effort; M3: Off | `reasoning_content` (M3.x) | Automatic (≥512 tokens) | — |
| Alibaba Model Studio, all four endpoints (Chat) | `enable_thinking` + `reasoning_effort` or `thinking_budget`, per family | `reasoning_content` | Implicit | — |
| Volcengine Ark (Chat) | `thinking.type` + `reasoning_effort` | `reasoning_content` only (see gaps) | Implicit | — |
| Together, Fireworks, DeepInfra, SiliconFlow, Cerebras (Chat) | Each gateway's own vocabulary, per family | `reasoning_content` (`reasoning` for Cerebras) | Automatic; `prompt_cache_key` = task except SiliconFlow | — |
| Cohere (compatibility API) | Command A Reasoning: Off / High | Undocumented | Undocumented | — |
| Ollama (OpenAI compatibility) | GPT-OSS low / medium / high | `reasoning` | — | — |
| LM Studio, Perplexity, custom endpoints | See their sections | | | |

## Anthropic

`thinking: {type: adaptive | enabled | disabled | between_tools}` and `output_config: {effort: low | medium | high | xhigh | max}`. Every model takes images.

| Model | Thinking types | Effort · default | Off? | Context / max out | Offered |
| --- | --- | --- | --- | --- | --- |
| Fable 5.1, Fable 5, Opus 5.5 | adaptive only | all five · high (Opus 5.5: medium) | No | 1M / 128K | low–max |
| Sonnet 5.5 | adaptive, between_tools | all five · high | `between_tools` only (effort ≤ high) | 1M / 128K | low–max |
| Haiku 5.5, Opus 5, Sonnet 5 | adaptive, disabled | all five · high (Haiku 5.5: medium) | `disabled`, effort ≤ high | 1M / 128K | Off, low–max |
| Opus 4.8, Opus 4.7 | adaptive, disabled | all five · high | Off when `thinking` is omitted | 1M / 128K | Off, low–max |
| Opus 4.6, Sonnet 4.6 | adaptive, or enabled + budget | low, medium, high, max | Off when omitted | 1M / 128K | low, medium, high, max |
| Opus 4.5 | enabled + `budget_tokens` | low, medium, high | Off when omitted | 200K / 64K | effort or budget |
| Haiku 4.5, Sonnet 4.5 (retires 2026-11-30) | enabled + budget | none | Off when omitted | 200K / 64K | Off or budget |

- Thinking blocks carry signatures and must go back unmodified within a tool turn; on 5.1 and later they are bound to the conversation prefix. localDot keeps the SDK's response messages and retries with `block_binding.prefix_mismatch_behavior: "drop_block"` after the binding refusal.
- Caching is opt-in: block `cache_control` (up to 4) or a top-level automatic mode; minimum 512–4,096 tokens by model; 5-minute or 1-hour TTL. Changing effort or thinking invalidates the message cache.
- Forced tool choice is refused on Opus 5.5, Sonnet 5.5 and Fable 5.1 (localDot uses `auto`). Non-default `temperature`/`top_p` are refused on 4.7 and later (localDot sends none).
- The Models API reports each model's effort levels and thinking types; they replace the bundled rows (`discovery.ts`), including Off where `disabled` is listed beside `adaptive`.

Sources: [models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [thinking with tools](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode), [deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations).

## OpenAI and Azure OpenAI

Responses: `reasoning: {effort}` (`none | minimal | low | medium | high | xhigh | max`, default medium), `text.verbosity` (`low | medium | high`), `service_tier` (`default | flex | priority/fast | ultrafast`). Chat Completions uses `reasoning_effort` and `verbosity`, and has no `ultrafast`. Every model listed takes images.

| Model | Effort | Off? | Fast · Ultrafast | Context / max out |
| --- | --- | --- | --- | --- |
| GPT-6.1 Terra (2026-10-26) | none, low–max | Yes | 2× · — | 1.05M / 128K |
| GPT-6.1 Sol, GPT-6 Astra | low–max | No | 2× · 6× | 1.05M / 128K |
| GPT-6 Sol, GPT-6 Luna | none, low–max | Yes | 2× · — | 1.05M / 128K |
| GPT-5.6 (Sol, Terra, Luna) | none, low–max | Yes | 2× · — | 1.05M / 128K |
| GPT-5.5, 5.4, 5.4 mini/nano, 5.2 | none, low, medium, high, xhigh | Yes | 2× (5.5: 2.5×) · — | 1.05M or 400K / 128K |
| GPT-5.5 Pro, 5.4 Pro, 5.2 Pro | medium, high, xhigh | No | — | |
| GPT-5.3 Codex | low, medium, high, xhigh | No | 2× | 400K / 128K |
| GPT-5.1 | none, low, medium, high | Yes | 2× | 400K / 128K |
| GPT-5, mini, nano (shut down 2026-12-11) | minimal, low, medium, high | minimal | | 400K / 128K |

- Offered: exactly the effort column, verbosity on GPT-5/6 (not Codex), and the speeds in [model-options.md](model-options.md). Gateway “-pro” IDs for GPT-6 are OpenAI's pro reasoning mode and stay default-only.
- With `store: false`, reasoning items come back encrypted and every reasoning, call and output item since the last user message goes back. localDot asks for `reasoning.encrypted_content` and settles older turns (`editsOlderTurns`).
- Caching is automatic; `prompt_cache_key` routes (an accounting key from GPT-5.6). localDot sends the task's session ID.
- Chat Completions: function tools with any reasoning are refused on GPT-5.6, GPT-6 Sol and Luna unless effort is `none` (omitting it means medium, which is also refused); GPT-6 Astra and 6.1 need Responses for tools. The custom Chat Completions endpoint therefore offers only Off for those and nothing for Astra and 6.1. Whether GPT-5.4 and 5.5 refuse the same is disputed in OpenAI's community forum.
- Azure: `max` only on GPT-6/5.6 through Responses; `service_tier` is `auto | default | priority` on GlobalStandard and DataZone US only; cache TTL `30m` only.

Sources: [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create), [Chat reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [function calling](https://developers.openai.com/api/docs/guides/function-calling.md), [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md), [fast mode](https://developers.openai.com/api/docs/guides/fast-mode.md), [ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode.md), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [pricing](https://developers.openai.com/api/docs/pricing.md), [deprecations](https://developers.openai.com/api/docs/deprecations.md), [Azure reasoning (2026-10-30)](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning), [Azure priority](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/priority-processing), [Azure caching](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching).

## Google Gemini

`generationConfig.thinkingConfig.thinkingLevel` (Gemini 3 and later) or `thinkingBudget` (2.5); both together are refused. Every model takes images, video, audio and PDF.

| Model | Levels · default | Off? | Context / max out | Offered |
| --- | --- | --- | --- | --- |
| Gemini 4 Argon | low, medium, high · medium | No | 1,048,576 shared / 65,536 | low–high |
| 3.8 Flash; 3.7 Flash (deprecated, routed to 3.8) | low, medium, high · medium | No | 1,048,576 / 65,536 | low–high |
| 3.6 Flash; 3.5 Flash (routed to 3.6); 3.5 and 3.1 Flash-Lite; 3 Flash | minimal, low, medium, high | `minimal` (not guaranteed off) | 1,048,576 / 65,536 | minimal–high |
| 3.1 Pro preview | low, medium, high · high | No | 1,048,576 / 65,536 | low–high |
| 2.5 Pro | budget 128–32,768 · dynamic | No | 1,048,576 / 65,536 | budget |
| 2.5 Flash, Flash-Lite | budget (0 = off) | Yes | 1,048,576 / 65,536 | Off or budget |

- Gemini 3 and 4 require each `functionCall`'s `thoughtSignature` back in the current turn (400 without it); the SDK keeps them on the parts localDot replays.
- Implicit caching is automatic (minimum 4,096 tokens on 3.x/4, 2,048 on 2.5). Explicit `cachedContents` needs a separate create call and is not used; Gemini 4 Argon has implicit caching only.
- `serviceTier` is `standard | flex | priority`; priority overflow is served and billed at standard.
- The `-latest` aliases' targets are undocumented and stay default-only.

Sources: [thinking (2026-10-14)](https://ai.google.dev/gemini-api/docs/generate-content/thinking), [thought signatures (2026-10-13)](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures), [caching (2026-10-23)](https://ai.google.dev/gemini-api/docs/generate-content/caching), [priority inference](https://ai.google.dev/gemini-api/docs/generate-content/priority-inference), [models (2026-10-28)](https://ai.google.dev/gemini-api/docs/models), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

## xAI

Responses: `reasoning: {effort}`. Every model takes images.

| Model | Effort · default | Off? | Context | Offered |
| --- | --- | --- | --- | --- |
| Grok 4.7, 4.6 | low, medium, high, xhigh · high | No | 500K | low–xhigh |
| Grok 4.5 | low, medium, high · high (xhigh treated as high) | No | 500K | low–high |
| Grok 4.3 | none, low, medium, high · low | Yes | 1M | Off, low–high |
| Grok 4.20 0309 reasoning / non-reasoning | Effort refused | — | 1M | default |
| Grok 4.20 multi-agent | Effort sets the agent count; no client-side tools | — | 1M | not usable for tasks |
| Grok Build 0.1 | Undocumented | | 256K | default |

- xAI's model page also lists `xhigh` for Grok 4.3 while its reasoning guide and OpenRouter don't; localDot offers up to high.
- With `store: false`, encrypted reasoning needs `include: ["reasoning.encrypted_content"]` (Grok 4.7 returns it regardless); the SDK adds it.
- Caching is automatic; `prompt_cache_key` (Responses) keeps a conversation on one cache. localDot sends the task's session ID.
- `service_tier: "priority"` is billed at 2× only when the response confirms it.

Sources: [reasoning](https://docs.x.ai/docs/guides/reasoning), model pages [4.7](https://docs.x.ai/docs/models/grok-4.7), [4.6](https://docs.x.ai/docs/models/grok-4.6), [4.5](https://docs.x.ai/docs/models/grok-4.5), [4.3](https://docs.x.ai/docs/models/grok-4.3), [build](https://docs.x.ai/docs/models/grok-build-0.1), [4.20 reasoning](https://docs.x.ai/docs/models/grok-4.20-0309-reasoning), [multi-agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent), [prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits), [pricing](https://docs.x.ai/developers/pricing).

## Mistral

Chat: `reasoning_effort` (schema `none | minimal | low | medium | high | xhigh`; per-model support is narrower), `prompt_cache_key`.

| Model | Effort | Off? | Offered |
| --- | --- | --- | --- |
| Mistral Large 4 (`mistral-large-4`, `-4-0`; preview v26.10) | low, medium, high | No | low–high |
| Medium 3.5 (`mistral-medium-latest`, `-2604`; deprecated 2026-10-31) | high, none | Yes | Off, high |
| Small 4 (`mistral-small-2603`, `-latest`) | high, none | Yes | Off, high |
| Zai GLM 5.3 (`zai-glm-5-3`) | low, high, max | No | low, high, max |
| Zai GLM 5.3 Flash, DeepSeek V4.1 Flash, `mistral-large-4-0-8` | Undocumented | | default |
| Magistral, Devstral 2512, Leanstral | Retired | | default |

- With reasoning on, `content` is a list with a `thinking` chunk; Mistral asks for the whole message back. The SDK converts reasoning parts to thinking chunks.
- The `@ai-sdk/mistral` package sends `reasoning_effort` only for model IDs it lists and only `high` or `none`; localDot writes the chosen level into the body itself.
- Caching: `prompt_cache_key` is a hint, cached tokens 10% of input. localDot sends the task's session ID.

Sources: [reasoning](https://docs.mistral.ai/capabilities/reasoning/), [chat reference](https://docs.mistral.ai/api/endpoint/chat), [models](https://docs.mistral.ai/getting-started/models/models_overview/), [Large 4](https://docs.mistral.ai/models/mistral-large-4-0), [Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04), [GLM 5.3](https://docs.mistral.ai/models/zai-glm-5-3), [prompt caching](https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching).

## DeepSeek

`thinking: {type: enabled | disabled}` and `reasoning_effort: low | high | max` (default on, high). Context 1M, output up to 384K.

| Model | Offered | Vision |
| --- | --- | --- |
| `deepseek-flash` (serves V4.1 Flash 1017), `deepseek-v4-flash*` (retired IDs, routed to V4.1 Flash) | Off, low, high, max | Yes (user messages only) |
| `deepseek-v4-pro` (V4 Pro 0813) | Off, low, high, max | No |
| `deepseek-chat`, `deepseek-reasoner` | Discontinued 2026-07-24 | |

- With tools in the request, every earlier assistant turn's `reasoning_content` must go back or the request is refused. localDot sends it, empty for turns it has settled.
- Caching is automatic (`prompt_cache_hit_tokens`); no request field.

Sources: [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode), [tool calls](https://api-docs.deepseek.com/guides/tool_calls), [context caching](https://api-docs.deepseek.com/guides/kv_cache), [vision](https://api-docs.deepseek.com/guides/vision), [pricing](https://api-docs.deepseek.com/quick_start/pricing), [updates](https://api-docs.deepseek.com/updates).

## Groq and Cerebras

| Provider · model | Effort · default | Off? | Offered | Notes |
| --- | --- | --- | --- | --- |
| Groq · GPT-OSS 120B / 20B | low, medium, high | No | low–high | Automatic caching (50% off) |
| Groq · Qwen 3.8 27B | none, default, low, medium, high | Yes | Off, low–high | `default` may return no reasoning (Groq's pages disagree) |
| Groq · Qwen 3.6 27B | default, none | Yes | Off | Missing from Groq's model list |
| Cerebras · GPT-OSS 120B | low, medium, high · medium | No | low–high | |
| Cerebras · Qwen 3.8 27B | none, low, medium, high · high | Yes | Off, low–high | Images: up to 10 |
| Cerebras · Zai GLM 5.3 Flash | low, high, max · max | No | low, high, max | Listed on the reasoning page, not on shared inference |

- Groq returns reasoning in `message.reasoning` (`reasoning_format: parsed`); `raw` is refused with tools. Carry-back is undocumented.
- Cerebras reads earlier reasoning from the assistant `reasoning` field (`clear_thinking` defaults to false); localDot sends it there. Caching is automatic with no discount; `prompt_cache_key` is accepted and localDot sends it.

Sources: [Groq reasoning](https://console.groq.com/docs/reasoning), [Groq models](https://console.groq.com/docs/models), [Groq Qwen 3.8](https://console.groq.com/docs/model/qwen/qwen3.8-27b), [Groq Qwen 3.6](https://console.groq.com/docs/model/qwen/qwen3.6-27b), [Groq caching](https://console.groq.com/docs/prompt-caching), [Cerebras reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning), [Cerebras models](https://inference-docs.cerebras.ai/models/overview), [Cerebras caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching).

## Moonshot / Kimi (global and China)

| Model | Control · default | Off? | Carry-back | Vision | Context | Offered |
| --- | --- | --- | --- | --- | --- | --- |
| Kimi K3.1 Pro, K3.1 Pro highspeed, K3 | `reasoning_effort: low \| high \| max` · max; no `thinking` field | No | Whole assistant message with `reasoning_content` and `tool_calls`, unchanged | Images (base64 or `ms://`, no URLs), video | 1M | low, high, max |
| Kimi K2.7 Code (+ highspeed) | Always thinking; `thinking` only `{type: enabled, keep: all}`; no effort | No | Required (one page) or recommended (another) | Images, video | 256K | default |
| Kimi K2.6 | `thinking: {type: enabled \| disabled}` · enabled | Yes | Used only with `keep: "all"` | Images | 256K | Off / On |

- K3.x fixes `temperature` 1.0 and `top_p` 0.95 and refuses other values; localDot sends neither.
- Caching is automatic (hits 10% of a miss; K3 cache writes are billed). `prompt_cache_key` is recommended for multi-turn agents; localDot sends the task's session ID. Changing effort invalidates the prefix cache.
- `-highspeed` IDs are separate models at 2× the price; there is no `service_tier`.
- The Kimi Code plan's docs give K3.1 Pro a default of high; the platform docs say max. The plan is not offered.

Sources: [K3.1 Pro quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart), [K3 quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models), [reasoning effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort), [chat reference](https://platform.kimi.ai/docs/api/chat), [models overview](https://platform.kimi.ai/docs/api/models-overview), [context caching](https://platform.kimi.ai/docs/guide/context-caching), [K2.7 Code](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart), [K3.1 Pro pricing (2026-10-26)](https://www.kimi.ai/resources/kimi-k3-1-pro-pricing).

## Z.ai and Zhipu (GLM)

`thinking: {type: enabled | disabled, clear_thinking}` and top-level `reasoning_effort` (GLM 5.2 and later).

| Model | Control · default | Off? | Vision | Context / max out | Offered |
| --- | --- | --- | --- | --- | --- |
| GLM 5.3, 5.3 Flash, 5.3 FlashX | `reasoning_effort: low \| high \| max` · max; `disabled` refused | No | Flash, FlashX | 1M / 128K | low, high, max |
| GLM 5.2 | enabled/disabled; effort max…none (low, medium → high; xhigh → max) | Yes | No | 1M / 128K | Off, high, max |
| GLM 5.1, 5, 5 Turbo, 5V Turbo, 4.7 (Flash, FlashX), 4.6, 4.6V, 4.5 (Air, Flash), 4.5V | enabled/disabled | Yes | V models | 200K or 128K | Off / On |

- Reasoning arrives in `reasoning_content`. Interleaved thinking is on since GLM 4.5 and must go back with tool results; `clear_thinking` defaults to true on the standard API (earlier turns dropped server-side).
- `tool_choice` takes only `auto` (localDot's default). Caching is implicit only; there is no cache key.

Sources: [chat reference](https://docs.z.ai/api-reference/llm/chat-completion), [thinking](https://docs.z.ai/guides/capabilities/thinking.md), [thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode), [GLM 5.3](https://docs.z.ai/guides/llm/glm-5.3), [GLM 5.3 Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash), [cache](https://docs.z.ai/guides/capabilities/cache), [BigModel chat reference](https://docs.bigmodel.cn/api-reference/模型-api/对话补全), [BigModel model overview](https://docs.bigmodel.cn/cn/guide/start/model-overview).

## MiniMax (API and Token Plan)

| Model | Control · default | Off? | Carry-back | Vision | Offered |
| --- | --- | --- | --- | --- | --- |
| M3.1 Flash, M3.1 Flash Preview | `reasoning_effort: low…max` · max; `none` and `thinking: disabled` refused | No | Full message with `reasoning_content` | Images, video | low–max |
| M3 | `thinking: {type: adaptive \| disabled}`; effort ignored | Yes | Full message; `<think>` in `content` unless split | Images, video | Off |
| M2.7, M2.5 (+ highspeed), M2.1, M2 | Always thinks; settings ignored | No | `<think>…</think>` in `content` must be kept | Text | default |

- Caching is automatic from 512 input tokens; explicit `cache_control` only on MiniMax's Anthropic-format endpoint. `service_tier: priority` (1.5×) exists for M3, not M3.1 Flash.

Sources: [OpenAI-compatible API](https://platform.minimax.io/docs/api-reference/text-openai-api), [chat reference](https://platform.minimax.io/docs/api-reference/text-chat-openai), [M3 function calling](https://platform.minimax.io/docs/guides/text-m3-function-call), [prompt caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching), [pricing](https://platform.minimax.io/docs/pricing/overview).

## Alibaba Model Studio (international, China, Token Plan, Coding Plan)

Top-level `enable_thinking`, `thinking_budget`, `reasoning_effort` and `preserve_thinking`; effort and budget are never sent together.

| Model | Control · default | Off? | Offered |
| --- | --- | --- | --- |
| Qwen 3.8 Max, 3.8 Flash | `enable_thinking` + `reasoning_effort: low \| medium \| xhigh` or budget · on, xhigh | Yes | Off, low, medium, xhigh; budget |
| Qwen 3.8 Omni Flash | `reasoning_effort: none…max` | Yes | Off, minimal–max |
| Qwen 3.7 Max/Plus/Flash, 3.6 Plus/Flash, 3.5 Plus/Flash, Qwen Plus, Qwen Flash, Qwen3 VL Plus | `enable_thinking` + `thinking_budget` (Plus, Flash, VL default off) | Yes | Off / On; budget |
| Qwen 3.7 Max preview (thinking only), 3.6 Max preview, Coder models | — | — | default |
| Kimi K3 | `reasoning_effort: low \| high \| max` (`kimi/kimi-k3`: max only) | Disputed | low, high, max |
| Kimi K2.6, K2.5 | `enable_thinking` + budget · off | Yes | Off / On; budget |
| GLM 5.3 | `reasoning_effort: low \| high \| max`; `enable_thinking: false` refused | No | low, high, max |
| GLM 5.2, 5.1, 5 | `enable_thinking` + `reasoning_effort: high \| max` | Yes | Off, high, max |
| DeepSeek V4 Pro / Flash / V4.1 Flash | `enable_thinking` + `reasoning_effort: low \| high \| max` | Yes | Off, low, high, max |
| Kimi K2.7 Code, MiniMax M2.5 | Thinking only | No | default |

- Reasoning arrives in `reasoning_content`; Qwen 3.8 keeps it across turns by default (`preserve_thinking`). Thinking mode refuses `tool_choice: required` and a named function (localDot uses `auto`).
- Caching: implicit is automatic (hits ~20% of input). Explicit `cache_control` blocks (5-minute TTL, creation 125%) exclude implicit caching and need array content; not used.
- The Coding Plan is limited to interactive coding tools; localDot shows its rule when it is chosen.

Sources: [deep thinking (2026-10-29)](https://www.alibabacloud.com/help/en/model-studio/deep-thinking), [OpenAI-compatible chat (2026-10-23)](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions), [context cache (2026-10-27)](https://www.alibabacloud.com/help/en/model-studio/context-cache), [models (2026-10-28)](https://www.alibabacloud.com/help/en/model-studio/models), [Qwen 3.8 Max](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-8-max), [Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan).

## Volcengine Ark

`thinking: {type: enabled | disabled}` and `reasoning_effort` (`none … max`, remapped per model rather than refused).

| Model | Mapping · default | Off? | Offered |
| --- | --- | --- | --- |
| Doubao Seed 2.1 Pro/Turbo, Seed evolving, Seed 2.0 Pro/Lite/Mini/Code, Seed character | minimal = off; xhigh, max → high · high (2.0: medium) | Yes | Off, low–high |
| Doubao Seed 1.8 | minimal, low, medium, high · medium | Yes | Off, low–high |
| DeepSeek V4 Pro/Flash GA | none, minimal = off; medium → low; xhigh → high | Yes | Off, low, high, max |
| GLM 5.2 (260617) | none, minimal = off; low, medium → high; xhigh → max | Yes | Off, high, max |
| GLM 5.3 Flash (260828) | low, high, max · max | No | low, high, max |

- Seed 2.1 (and 2.0 Lite 260428) return only a summary in `reasoning_content`; the real reasoning is `encrypted_content`, which should go back unchanged. Leaving it out lowers quality but is not refused.
- Caching: implicit on Chat for Seed 2.0 and later (minimum 1,024–8,960 tokens by model); `prompt_cache_key` for Seed 2.0 and later only; explicit caching only through the Responses API with `store: true`.

Sources: [deep thinking (2026-10-28)](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh), [chat API (2026-10-28)](https://docs.volcengine.com/docs/ark/chat-api?lang=zh), [model list](https://docs.volcengine.com/docs/ark/model-list?lang=zh), [context cache (2026-10-24)](https://docs.volcengine.com/docs/ark/context-cache?lang=zh), [Seed 1.8](https://docs.volcengine.com/docs/82379/2123228).

## OpenRouter

`reasoning: {effort | max_tokens | enabled | exclude}`; `effort` is `max | xhigh | high | medium | low | minimal | none` (none disables, and is refused by models marked mandatory). The Models API gives each model `reasoning.supported_efforts` (null: every level; absent: no effort selection), `supports_max_tokens` and `mandatory`.

- Offered: each model's listed levels when its metadata carries them (`discovery.ts`), else the bundled family rows for OpenAI, Anthropic, Google, DeepSeek, xAI, Moonshot, Z.ai, Qwen, MiniMax and Mistral IDs. Claude never gets Off there (OpenRouter refuses `none` for Claude); budget-only Claude models offer the budget.
- Earlier reasoning goes back as `reasoning_details` on the assistant message with the tool calls, in the original order; the SDK does this.
- Caching: Claude needs `cache_control` breakpoints, which localDot now marks as it does on Anthropic's API; Gemini, OpenAI, xAI, DeepSeek, Moonshot and Z.ai cache automatically. Qwen through Alibaba needs `cache_control` too (not marked: OpenRouter names only Qwen3 Max and 3.6 Plus).
- `verbosity` maps to OpenAI's `text.verbosity` but to Anthropic's effort; localDot doesn't offer it here.
- `provider.require_parameters` defaults to false: an endpoint that doesn't support a parameter ignores it.

Sources: [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [parameters](https://openrouter.ai/docs/api/reference/parameters), [prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [service tiers](https://openrouter.ai/docs/guides/features/service-tiers), [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection).

## Together, Fireworks, DeepInfra and SiliconFlow

Each gateway's vocabulary takes precedence over the model vendor's.

| Gateway · model | Gateway control | Offered |
| --- | --- | --- |
| Together · Kimi K3 | `reasoning_effort: low \| high \| max` · max; `reasoning: {enabled: false}` = instant mode | Off, low, high, max |
| Together · GLM 5.3 / 5.3 Flash | `reasoning_effort: low \| medium \| high \| max`; can't disable | low–max |
| Together · DeepSeek V4 Pro 0813 | `reasoning: {enabled}`; effort high, max | Off, high, max |
| Together · GLM 5.2, MiniMax M3, Qwen 3.5/3.6, DeepSeek V4 Flash | `reasoning: {enabled}` | Off / On |
| Together · GPT-OSS | `reasoning_effort` low–high | low–high |
| Fireworks · MiniMax M3.1 Flash | always on, low to max | low–max |
| Fireworks · Kimi K3, DeepSeek V4/V4.1 | string levels (`none` disables where allowed; an integer is a token cap) | Off, low, high, max |
| Fireworks · GLM 5.3, Qwen 3.8 Max | undocumented per model | default |
| DeepInfra · GLM 5.3 | `reasoning_effort: low \| high \| max`; anything else is max | low, high, max |
| DeepInfra · DeepSeek V4 0731/0813, GLM 5.2, Kimi K3 | `reasoning_effort: none \| low \| medium \| high` | Off, low–high |
| SiliconFlow · GLM 5.3 | `reasoning_effort: low \| high \| max`; can't disable | low, high, max |
| SiliconFlow · DeepSeek V4 Pro/Flash, GLM 5.2 | `reasoning_effort: high \| max` (Chinese reference) | high, max |
| SiliconFlow · Qwen3, Hunyuan A13B, GLM V models, DeepSeek V3.x | `enable_thinking`, `thinking_budget` | Off / On; budget |

- All four take `reasoning_content` back on assistant messages (Fireworks: “must” in tool loops). Together, Fireworks and DeepInfra document `prompt_cache_key`; localDot sends the task's session ID. SiliconFlow documents no cache control.
- Fireworks' fast, spot and US router IDs are separate model IDs; DeepInfra's `service_tier` (priority +50%, flex −20%) and Fireworks' `priority` are not offered.

Sources: [Together reasoning](https://docs.together.ai/docs/inference/chat/reasoning.md), [Together Kimi K3](https://docs.together.ai/docs/kimi-k3-quickstart.md), [Together GLM 5.3](https://docs.together.ai/docs/glm-5.3-quickstart.md), [Together DeepSeek V4](https://docs.together.ai/docs/deepseek-v4-quickstart.md), [Together caching](https://docs.together.ai/docs/inference/chat/prompt-caching.md), [Together changelog](https://docs.together.ai/docs/changelog), [Fireworks chat reference](https://docs.fireworks.ai/api-reference/post-chatcompletions), [Fireworks reasoning](https://docs.fireworks.ai/guides/reasoning), [Fireworks caching](https://docs.fireworks.ai/guides/prompt-caching.md), [Fireworks MiniMax M3.1 Flash](https://fireworks.ai/models/fireworks/minimax-m3p1-flash), [DeepInfra chat reference](https://docs.deepinfra.com/api-reference/chat-completions/openai-chat-completions.md), [DeepInfra reasoning](https://docs.deepinfra.com/chat/reasoning.md), [DeepInfra GLM 5.3](https://deepinfra.com/zai-org/GLM-5.3), [DeepInfra caching](https://docs.deepinfra.com/chat/prompt-caching.md), [SiliconFlow reference (en)](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions.md), [SiliconFlow reference (zh)](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions), [SiliconFlow GLM 5.3](https://www.siliconflow.com/blog/glm-5.3-now-live-on-siliconflow), [SiliconFlow interleaved thinking](https://docs.siliconflow.com/en/userguide/guides/interleaved-thinking.md).

## Cohere, Ollama, LM Studio and Perplexity

- **Cohere** (compatibility API): `reasoning_effort` takes only `none` and `high`; Command A Reasoning offers Off / High. Which other models take it isn't stated (a gateway's docs name Command A Plus), so Command A Plus stays default. `parallel_tool_calls` and `service_tier` are unsupported; Command A Vision takes no tools. [Compatibility API](https://docs.cohere.com/docs/compatibility-api), [reasoning](https://docs.cohere.com/docs/reasoning), [models](https://docs.cohere.com/docs/models).
- **Ollama** (`/v1/chat/completions`): `reasoning_effort` per model (`/api/show` lists them); GPT-OSS low/medium/high, boolean models map any level to on and `none` to off. Reasoning comes back in `reasoning` and is read back only from `reasoning`; localDot sends it there. Images base64 only. [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [thinking](https://docs.ollama.com/capabilities/thinking).
- **LM Studio**: `reasoning_effort` arrived on `/v1/chat/completions` in 0.4.8, but the reference page still omits it and the accepted values come only from third parties; the native `/api/v1/chat` uses `reasoning: off | low | medium | high | on`. Default-only. [0.4.8](https://lmstudio.ai/changelog/lmstudio-v0.4.8), [chat completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions), [native chat](https://lmstudio.ai/docs/developer/rest/chat).
- **Perplexity**: Sonar Chat Completions support ended on 2026-09-27; requests are being moved to the Agent API. The OpenAI-format route is now the Orchestrator API (`https://api.perplexity.ai/orchestrator/v1`, `reasoning_effort` none…max). The preset still points at the old base URL; default-only. [Sonar migration](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview.md), [changelog](https://docs.perplexity.ai/docs/resources/changelog.md), [Orchestrator chat](https://docs.perplexity.ai/api-reference/gateway-chat-completions-post.md).
- **Amazon Bedrock and Google Vertex** are not offered yet (M8). Claude there takes the Messages body (`thinking`, `output_config`, `cache_control`; Converse uses `cachePoint`), and Gemini takes `thinkingLevel`/`thinkingBudget` as on the Gemini API. [Claude in Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock), [Bedrock caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), [Claude on Google Cloud](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/google-managed), [Vertex thinking](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking).

## Gaps found on 2026-10-31

| Gap | Change |
| --- | --- |
| Kimi K3 and K3.1 Pro (Moonshot, Alibaba, OpenRouter) had no reasoning control | `reasoning_effort` low / high / max |
| GLM 5.3 everywhere default-only; GLM 5.2's levels and 5V Turbo's switch missing | Effort rows per host; 5.2 Off / high / max |
| MiniMax M3.1 Flash (GA) and M3 default-only | M3.1 Flash low–max; M3 Off |
| Qwen 3.8 offered only On/Off; Alibaba's Kimi, GLM and DeepSeek models default-only | Qwen 3.8 levels; those families in Model Studio's own words |
| GPT-6.1 Terra, GPT-5.3 Codex, Grok 4.3, Gemini 4 Argon and 3.7 Flash, Mistral Large 4 and Medium 3.5 default-only | Rows added |
| Haiku 5.5, Opus 5, Sonnet 5, Opus 4.7/4.8 had no Off | Off (`thinking: disabled`), also from the Models API |
| OpenRouter mapped only four vendors and ignored each model's listed levels | Six more vendors; `reasoning.supported_efforts`, `mandatory` and `supports_max_tokens` read from its model list |
| Mistral GLM 5.3's low/max broke the request and high was silently dropped (the package lists neither) | Effort written into the body |
| The OpenAI package dropped GPT-6.1 Terra's `none` | Effort written into the body when the package leaves it out |
| GPT-5.5 Pro offered Off and low; Groq Qwen 3.6 offered levels; Mistral GLM 5.3 Flash offered undocumented levels; custom Chat endpoints offered GPT-5.6 levels that refuse tools | Narrowed to what the docs list |
| Claude through OpenRouter was never cached | `cache_control` marks, as on Anthropic's API |
| xAI, Mistral, Moonshot, Together, Fireworks, DeepInfra and Cerebras had no cache key | The task's session ID as `prompt_cache_key` |
| Ollama and Cerebras ignored earlier thinking sent as `reasoning_content` | Sent as `reasoning` |
| Fast-model one-shot calls never lowered Claude's thinking | Off or the least effort in `output_config` |

## Left as is, and why

- **Volcengine Seed 2.x `encrypted_content`**: the compatible package doesn't keep it; leaving it out lowers quality but isn't refused. Carrying it needs a response extractor and a request transform.
- **MiniMax M2.x and M3 `<think>` in content**: whether `reasoning_split` returns `reasoning_content` or `reasoning_details` for M2.x is disputed, and its default is undocumented. Unchanged until checked against a live response.
- **Explicit caching on Gemini (`cachedContents`), Alibaba (`cache_control` blocks), Ark (Responses API) and OpenAI GPT-5.6+ (`prompt_cache_options`)**: each needs a separate API, array content or excludes the automatic cache; the automatic caches already apply.
- **Custom Anthropic-format endpoints** get no cache marks, as before: other vendors' Anthropic routes are not known to accept them.
- **Perplexity's base URL**: moving the preset would break keys bound to the current address; it needs its own migration.
- **Undocumented per-model levels** (Fireworks GLM 5.3 and Qwen 3.8, Cohere Command A Plus, Grok Build, LM Studio): default-only. Together's DeepSeek V4.1 Flash keeps only its on/off switch; its 1–100 effort scale isn't offered.
- **Speed tiers outside Standard/Fast/Ultrafast** (flex, Groq `performance`, DeepInfra and Fireworks priority, MiniMax priority): unchanged from [model-options.md](model-options.md).
