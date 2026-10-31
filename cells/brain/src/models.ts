import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { ModelBinding, type PremiumSpeed, SURROGATE_PATTERN } from "@localdot/protocol";
import {
  gatewayBaseURL,
  modelOptionsProblem,
  modelProviderOptions,
  providerById,
  servedSpeed,
} from "@localdot/providers";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  type JSONValue,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ProviderMetadata,
  wrapLanguageModel,
} from "ai";

// Nothing the brain sends is kept on the provider (P5a-R33): the Responses APIs of OpenAI, Azure
// and xAI store every request by default, screenshots of the user's desktop included. With
// store: false, a reasoning model's thinking travels between turns as encrypted content instead
// of an item_reference to the stored response: asked for here for OpenAI and Azure, and by the xAI
// package itself whenever store is false.
function stateless(
  model: Parameters<typeof wrapLanguageModel>[0]["model"],
  options: "openai" | "azure" | "xai",
  reasoning: boolean,
): LanguageModel {
  const store =
    options === "xai" || !reasoning
      ? { store: false }
      : { store: false, include: ["reasoning.encrypted_content"] };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          [options]: { ...params.providerOptions?.[options], ...store },
        },
      }),
    },
  });
}

// Every model is reached at keyd's gateway with keyd's stand-in for the key in the provider's own
// auth header (Part 4a's route table); keyd swaps in the real key outside the cell. The first-class
// providers use their official packages (P5a-R4), each calling only the operation its keyd preset
// lists (P5a-R31).
export function languageModel(b: ModelBinding, fetch: typeof globalThis.fetch): LanguageModel {
  const model = b.client === "anthropic" ? keepsThinking(baseModel(b, fetch)) : baseModel(b, fetch);
  if (!b.options) return model;
  const provider = b.provider ?? b.client;
  const problem = modelOptionsProblem(provider, b.model, b.options, b.maxOutputTokens, b.controls);
  if (problem) throw new Error(problem);
  const namespace = ["openai-compatible", "lmstudio", "ollama"].includes(b.client)
    ? b.route
    : b.client === "anthropic-compatible"
      ? "anthropic"
      : b.client;
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => {
        const total = Math.min(params.maxOutputTokens ?? b.maxOutputTokens, b.maxOutputTokens);
        // Compaction asks for fewer tokens than a normal turn. Keep its thinking within that
        // request's limit; Anthropic's SDK *adds* the budget to maxOutputTokens internally.
        const budget =
          b.options?.thinkingBudget === undefined
            ? undefined
            : Math.min(b.options.thinkingBudget, Math.max(1024, total - 1024));
        if (budget !== undefined && budget >= total)
          throw new Error("Output limit is too small for the selected thinking budget.");
        const options = modelProviderOptions(
          provider,
          b.model,
          {
            ...b.options,
            thinkingBudget: budget,
          },
          b.controls,
          b.maxPrice,
        );
        // Mistral's effort goes in the body (baseModel): its package refuses the levels it
        // doesn't list and drops the field for model IDs it doesn't know.
        if (b.client === "mistral") delete options.reasoningEffort;
        return {
          ...params,
          maxOutputTokens:
            namespace === "anthropic" && budget !== undefined ? total - budget : total,
          providerOptions: {
            ...params.providerOptions,
            [namespace]: { ...params.providerOptions?.[namespace], ...options },
          },
        };
      },
    },
  });
}
// Claude binds each thinking block to the conversation before it, and newer accounts refuse a
// request whose earlier turns changed since (a reminder dropped, an old screenshot pruned). Once
// refused, the request goes again with the blocks that no longer fit dropped, and so does every
// later one of the task; accounts that never refuse are left as they are.
const UNBOUND = /bound to a different conversation/i;
function keepsThinking(model: LanguageModel): LanguageModel {
  let dropping = false;
  const dropped: NonNullable<LanguageModelMiddleware["transformParams"]> = async ({ params }) => {
    const anthropic = (params.providerOptions?.anthropic ?? {}) as Record<string, JSONValue>;
    const thinking = (anthropic.thinking ?? { type: "adaptive" }) as Record<string, JSONValue>;
    return {
      ...params,
      headers: { ...params.headers, "anthropic-beta": "thinking-binding-controls-2026-08-01" },
      providerOptions: {
        ...params.providerOptions,
        anthropic: {
          ...anthropic,
          thinking: { ...thinking, blockBinding: { prefixMismatchBehavior: "drop_block" } },
        },
      },
    };
  };
  const unbound = (error: unknown) =>
    APICallError.isInstance(error) &&
    error.statusCode === 400 &&
    UNBOUND.test(`${error.responseBody ?? ""} ${error.message}`);
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params, model }) => {
        const again = async () =>
          model.doGenerate(await dropped({ type: "generate", params, model }));
        if (dropping) return again();
        try {
          return await doGenerate();
        } catch (error) {
          if (!unbound(error)) throw error;
          dropping = true;
          return again();
        }
      },
      wrapStream: async ({ doStream, params, model }) => {
        const again = async () => model.doStream(await dropped({ type: "stream", params, model }));
        if (dropping) return again();
        try {
          return await doStream();
        } catch (error) {
          if (!unbound(error)) throw error;
          dropping = true;
          return again();
        }
      },
    },
  });
}
function baseModel(b: ModelBinding, fetch: typeof globalThis.fetch): LanguageModel {
  b = ModelBinding.parse(b);
  const local = b.client === "lmstudio" || b.client === "ollama";
  if (local && b.route !== b.client) throw new Error("Local model has a different gateway route");
  if (!local && (!b.surrogate || !SURROGATE_PATTERN.test(b.surrogate)))
    throw new Error("Remote model requires a keyd surrogate");
  const baseURL = gatewayBaseURL(b.route);
  const key = local ? undefined : b.surrogate;
  const apiKey = key ?? "missing";
  // The level the settings chose, which some packages drop for model IDs they don't list.
  const level = b.options?.reasoningEffort === "enabled" ? undefined : b.options?.reasoningEffort;
  switch (b.client) {
    case "anthropic":
      return createAnthropic({ baseURL, apiKey, fetch })(b.model);
    case "anthropic-compatible":
      // Vendors' Anthropic routes take the key as a bearer token (their ANTHROPIC_AUTH_TOKEN).
      return createAnthropic({ baseURL, authToken: apiKey, fetch })(b.model);
    case "openai": {
      const speed = b.options?.speed;
      const tier = speed === "fast" ? "priority" : speed === "ultrafast" ? "ultrafast" : undefined;
      return stateless(
        createOpenAI({
          baseURL,
          apiKey,
          fetch: withFields(fetch, {
            ...(tier && providerById(b.provider ?? "")?.custom ? { service_tier: tier } : {}),
            ...(level ? { reasoning: { effort: level } } : {}),
          }),
        }).responses(b.model),
        "openai",
        b.reasoning || b.options?.reasoningEffort !== undefined,
      );
    }
    case "google":
      return createGoogleGenerativeAI({ baseURL, apiKey, fetch })(b.model);
    case "xai":
      // The package's language model is xAI's Responses API, which reports usage unasked.
      return stateless(createXai({ baseURL, apiKey, fetch })(b.model), "xai", b.reasoning);
    case "mistral":
      return createMistral({
        baseURL,
        apiKey,
        fetch: withFields(fetch, level ? { reasoning_effort: level } : {}),
      })(b.model);
    case "deepseek":
      return createDeepSeek({ baseURL, apiKey, fetch })(b.model);
    case "groq":
      return createGroq({ baseURL, apiKey, fetch })(b.model);
    case "openrouter":
      // "strict" asks for usage in the stream (stream_options.include_usage); the chat model
      // always, never the completions API the package picks for one instruct model.
      return createOpenRouter({
        baseURL,
        apiKey,
        fetch,
        compatibility: "strict",
      }).chat(b.model);
    case "azure":
      // Azure's own api-key header carries the stand-in. keyd's route ends in the resource's
      // /openai/v1, so the package sends POST <route>/responses with no api-version; the model is
      // the deployment's name.
      return stateless(
        createAzure({
          baseURL,
          apiKey,
          fetch: withFields(fetch, level ? { reasoning: { effort: level } } : {}),
        }).responses(b.model),
        "azure",
        b.reasoning || b.options?.reasoningEffort !== undefined,
      );
    case "openai-compatible":
    case "lmstudio":
    case "ollama":
      return createOpenAICompatible({
        name: b.route,
        baseURL,
        ...(key ? { apiKey: key } : {}),
        fetch,
        includeUsage: true,
        ...(REASONING_FIELD.has(b.provider ?? b.client)
          ? { transformRequestBody: asReasoning }
          : {}),
      })(b.model);
  }
}

// Ollama and Cerebras read a turn's earlier thinking from `reasoning`; the package sends it back
// as `reasoning_content`, which they ignore.
const REASONING_FIELD = new Set(["ollama", "cerebras"]);
function asReasoning(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map((message: Record<string, unknown>) => {
      if (message.role !== "assistant" || message.reasoning_content === undefined) return message;
      const { reasoning_content: reasoning, ...rest } = message;
      return { ...rest, reasoning };
    }),
  };
}

// Top-level fields a package leaves out of the body because it sends them only for the model IDs
// and values it lists: the OpenAI package's priority tier (a custom endpoint names its models as it
// likes, so one its user says takes OpenAI's tiers gets the tier whatever the model is called) and
// efforts newer than the package (GPT-6.1 Terra's none), and every Mistral effort but high and none.
function withFields(
  fetch: typeof globalThis.fetch,
  fields: Record<string, JSONValue>,
): typeof globalThis.fetch {
  if (!Object.keys(fields).length) return fetch;
  return (input, init) => {
    const body = init?.body;
    if (typeof body !== "string") return fetch(input, init);
    const sent = JSON.parse(body) as Record<string, unknown>;
    const missing = Object.entries(fields).filter(([key]) => !(key in sent));
    if (!missing.length) return fetch(input, init);
    return fetch(input, {
      ...init,
      body: JSON.stringify({ ...sent, ...Object.fromEntries(missing) }),
    });
  };
}

// The service_tier field of an OpenAI-style chat completion chunk or body.
export function rawTier(value: unknown): unknown {
  return value && typeof value === "object"
    ? (value as { service_tier?: unknown }).service_tier
    : undefined;
}
// The premium speed a provider says served a call: a tier in its response metadata, or Anthropic's
// usage speed; else Gemini's header; else the service_tier an OpenAI-style chat completion carries.
export function servedTier(
  metadata: ProviderMetadata | undefined,
  headers: Record<string, string> | undefined,
  chatTier: unknown,
): PremiumSpeed | undefined {
  for (const entry of Object.values(metadata ?? {})) {
    const usage = entry.usage as { speed?: unknown } | null | undefined;
    const report = entry.serviceTier ?? usage?.speed;
    if (typeof report === "string") return servedSpeed(report);
  }
  return servedSpeed(headers?.["x-gemini-service-tier"] ?? chatTier);
}

// Claude caches a prompt only up to the blocks marked for it, on Anthropic's API and through
// OpenRouter alike; the other APIs cache a repeated prefix on their own.
export function marksCache(b: Pick<ModelBinding, "client" | "model">): boolean {
  return (
    b.client === "anthropic" || (b.client === "openrouter" && b.model.startsWith("anthropic/"))
  );
}

// The task's key for the server that holds its cached prefix, where the API takes one: OpenAI,
// xAI and Mistral through their packages, and the compatible endpoints that document
// `prompt_cache_key`.
const CACHE_KEYS = new Set([
  "moonshotai",
  "moonshotai-cn",
  "togetherai",
  "fireworks-ai",
  "deepinfra",
  "cerebras",
]);
export function cacheKeyOptions(
  b: Pick<ModelBinding, "client" | "provider" | "route">,
  key: string,
): Record<string, Record<string, JSONValue>> | undefined {
  if (b.client === "openai" || b.client === "xai" || b.client === "mistral")
    return { [b.client]: { promptCacheKey: key } };
  if (b.client === "openai-compatible" && CACHE_KEYS.has(b.provider ?? ""))
    return { [b.route]: { prompt_cache_key: key } };
}

// Only Anthropic's tool results carry images (screenshots, as the computer tool expects); every
// other client gets them in a user message after the results: the OpenAI-compatible client would
// put the image's base64 into the tool message as text, and other vendors' Anthropic routes may
// drop images inside tool results.
export function imagesInToolResults(b: ModelBinding): boolean {
  return b.client === "anthropic";
}

// Older turns may change between these clients' calls: lightened (settleOldTurns) and summarized
// sooner. DeepSeek V4 then gets an empty reasoning_content, and the stateless Responses APIs of
// OpenAI and Azure get no item for the reasoning (no item id ties a function call to it). Claude
// binds each thinking block to the conversation before it, so a changed earlier turn invalidates
// every later block; other APIs and gateways may check the same or expect what they sent back.
export function editsOlderTurns(b: ModelBinding): boolean {
  return b.client === "deepseek" || b.client === "openai" || b.client === "azure";
}
