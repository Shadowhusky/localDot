# Model controls

Reviewed against vendor documentation on 2026-10-13. Implementation: `packages/providers/src/model-options.ts`; HTTP contract tests: `cells/brain/src/model-options.test.ts`.

## User behavior

The model button inside the desktop and phone composer opens **Model & thinking**. Choose a model, adjust its supported effort, thinking budget or answer detail, then Apply. Escape discards the draft. Reset restores provider defaults. The same controls appear in Settings for Main, Fast and Local roles. Changing models clears incompatible options. Existing tasks retain their immutable model/settings snapshot; new choices apply to a new task.

Unconfigured options are omitted from requests. “Provider default” does not guess a provider's current effort. Unknown model IDs and endpoints without a verified contract show a default-only explanation. A model catalog's `reasoning` flag alone is not evidence that a model accepts a particular parameter.

## Provider coverage and sources

| Provider / endpoint | Exposed controls and boundaries | Reference |
| --- | --- | --- |
| OpenAI; Azure deployments named for their underlying model; Custom endpoint (OpenAI Responses) | GPT-6 Astra/6.1 Sol: low–max. GPT-6 Sol/Luna and GPT-5.6 also allow off. Earlier GPT-5 and o-series use their own effort vocabulary. GPT-5/6 answer detail: concise/balanced/detailed. Unknown Azure deployment aliases remain default-only. | [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-5.6](https://developers.openai.com/api/docs/models/gpt-5.6) |
| Anthropic; Other Anthropic-compatible Claude IDs | Modern adaptive models: effort, with max/xhigh restricted by model family. Older thinking models: token budget or off. Opus 4.5 also has effort independent of its manual budget. | [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) |
| ChatGPT plan | Effort is passed to native Codex `turn/start`. Conservative known-model vocabulary; no API verbosity field is sent to the native app. | Pinned Codex app-server protocol and native driver regression tests; [Codex configuration](https://developers.openai.com/codex/config-reference/) |
| Claude Code plan | Native SDK effort for supported Claude families; stable `opus`/`sonnet` aliases expose low/medium/high. No manual API budget is injected into the native app. | Installed Claude Agent SDK `Options.effort`; [Claude Code model configuration](https://code.claude.com/docs/en/model-config) |
| Google Gemini | 3.x: model-specific thinking levels (Pro and Flash differ). 2.5: thinking budget; Pro cannot disable thinking. No simultaneous level and budget. | [Thinking](https://ai.google.dev/gemini-api/docs/thinking), [Gemini 3](https://ai.google.dev/gemini-api/docs/gemini-3) |
| DeepSeek | V4/Flash/Pro: off, low, high, max; legacy chat/reasoner: thinking toggle. Uses `thinking.type` plus `reasoning_effort` where supported. | [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) |
| xAI | Grok 4.5: low/medium/high; 4.6/4.7 add xhigh. No off switch for these models. | [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) |
| Groq | GPT-OSS low/medium/high; Qwen 3.6/3.8 27B also off. | [Reasoning](https://console.groq.com/docs/reasoning) |
| Mistral | Mistral Small 4/latest: none/high. Zai GLM 5.3: low/high/max. No inferred Magistral switch. | [Reasoning](https://docs.mistral.ai/studio/conversations/reasoning) |
| OpenRouter | Known OpenAI, Claude, Gemini and DeepSeek families mapped into `reasoning.effort` or `reasoning.max_tokens`. Unknown/router IDs don't acquire guessed controls. | [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) |
| Together | GPT-OSS effort; documented MiniMax M3, DeepSeek V4, GLM 5.2, Kimi K3 and Qwen 3.5/3.6 hybrids use `reasoning.enabled`. | [Reasoning](https://docs.together.ai/docs/inference/chat/reasoning) |
| Fireworks | GPT-OSS and MiniMax M2 effort; Qwen 3.8 full levels; DeepSeek V4/Kimi K3 none/low/high/max; GLM 5.2 none/high/max; older documented hybrids on/off. Binary toggles map to `none`/`medium`, not invented effort semantics. | [Reasoning guide](https://docs.fireworks.ai/guides/reasoning), [Chat fields](https://docs.fireworks.ai/api-reference/post-chatcompletions) |
| Cerebras | GPT-OSS low/medium/high; GLM 4.6/4.7 allow explicit off. Default omits the field. | [Reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning) |
| Cohere | Command A Reasoning through the compatibility endpoint: none/high only. Native token-budget fields are deliberately not sent to this endpoint. | [OpenAI compatibility](https://docs.cohere.com/docs/compatibility-api) |
| DeepInfra | Documented DeepSeek V4 Flash-0731/Pro-0813, GLM 5.2, Kimi K3 and Ling 3.0 Flash: none/low/medium/high. Gateway vocabulary takes precedence over model vendor vocabulary. | [Reasoning models](https://docs.deepinfra.com/chat/reasoning) |
| Moonshot global / China | Kimi K2.5/K2.6 thinking on/off via `thinking.type`. No off switch inferred for newer always-thinking models. | [Model selection](https://www.kimi.ai/help/kimi-api/api-model-selection), [Thinking models](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model) |
| Alibaba global / China / Token Plan / Coding Plan | Hybrid Qwen families: `enable_thinking` and optional `thinking_budget`; fixed thinking/instruct/coder/image variants excluded. | [Deep thinking](https://help.aliyun.com/en/model-studio/deep-thinking) |
| Z.ai / Zhipu | GLM 4.5/4.6/4.7/5/5.1/5.2 toggle. GLM 5.3 always-on models remain default-only. | [Thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode) |
| MiniMax API / Token Plan | M3.1 Flash Preview low/medium/high/xhigh/max. No off setting on this always-thinking model. Older fixed-thinking models retain defaults. | [OpenAI-compatible API](https://platform.minimax.io/docs/api-reference/text-openai-api) |
| Volcengine Ark | Documented Doubao Seed 2.0/2.1/evolving/character: off + low/medium/high. DeepSeek V4: off/low/high/max. GLM 5.2: off/high/max. Unknown deployment IDs remain default-only. | [Deep thinking](https://docs.volcengine.com/docs/ark/deep-thinking?lang=en), [Migration parameter table](https://docs.volcengine.com/docs/ark/model-deprecation-migration-guide?lang=en) |
| SiliconFlow global / China | Documented Qwen3 sizes, Hunyuan A13B, GLM vision variants and DeepSeek V3.2/Terminus: thinking toggle/budget. DeepSeek V3.1 exposes off only because its tool-calling mode requires thinking disabled. | [Chat completions](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions) |
| Ollama | GPT-OSS low/medium/high through its OpenAI-compatible endpoint; unknown local model templates remain default-only. | [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) |
| LM Studio | Default-only on the app's existing Chat Completions route: documented native `/api/v1/chat` reasoning controls and Responses controls are not interchangeable with this route. | [Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions), [API changelog](https://lmstudio.ai/docs/developer/api-changelog) |
| Perplexity | Default-only on the existing Sonar route. Sonar support ended September 27; its compatibility bridge does not establish that the new Agent API's reasoning/preset fields can be used here. | [Sonar migration](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview) |
| Custom endpoint (OpenAI Chat Completions) | Recognized OpenAI families only. GPT-6 Sol/Luna tool calls require none on Chat; Astra/6.1 Sol tool calls require the OpenAI Responses format. Other vendor model IDs retain defaults. | OpenAI references above |

Providers already marked unavailable or disallowed in the registry remain unavailable. This feature does not enable those plans or cloud integrations.

## Limits and validation

Options form a strict, bounded schema. Arbitrary request-body keys, sampling controls, URLs and credentials cannot enter requests through this setting. Unsupported values are rejected again by the daemon and brain, even if submitted outside the UI. Effort and budget are mutually exclusive; defaults remain omission. Saved budget choices must leave 1,024 tokens within the existing output cap for an answer, with a maximum budget of 15,000.

For shorter internal requests such as compaction, the selected budget is reduced to fit that request. Anthropic's SDK adds manual thinking tokens to `maxOutputTokens`, so the wrapper subtracts them first to preserve the total limit used by admission/accounting. Stateless Responses requests retain `store:false` and encrypted reasoning for tool turns. SDKs continue to handle reasoning signatures and replay.

Not included: service tiers, premium/pro modes, arbitrary temperature/top-p, provider-hosted tools, safety settings or permission controls. These differ in billing or execution behavior and are not interchangeable with effort. The UI does not represent effort as a guarantee of answer quality or expose hidden reasoning text.

## Verification scope

Automated tests exercise actual installed SDK HTTP serialization for every implemented API mapping (including both China/global endpoints and coding-plan aliases), native effort forwarding, strict rejection, defaults, reset, saved settings and token caps. Browser checks cover Chromium desktop/phone and WebKit phone, keyboard use, reload persistence, Escape/focus restoration and CSP. Vendor contract tests intercept requests at the network boundary; they are not live paid calls to every vendor. Live checks are limited to configured credentials and are recorded separately.

The mapping is intentionally conservative and versioned in source. It is not a claim that every future model ID or arbitrary gateway alias can be inferred automatically. Dynamic per-account model capability discovery can extend this table without weakening validation.
