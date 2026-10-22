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
          fetch:
            tier && providerById(b.provider ?? "")?.custom ? withServiceTier(fetch, tier) : fetch,
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
      return createMistral({ baseURL, apiKey, fetch })(b.model);
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
        createAzure({ baseURL, apiKey, fetch }).responses(b.model),
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
      })(b.model);
  }
}

// The OpenAI package sends priority only for model IDs it knows as OpenAI's own, and a custom
// endpoint names its models as it likes: one its user says takes OpenAI's tiers gets the tier
// whatever the model is called.
function withServiceTier(fetch: typeof globalThis.fetch, tier: string): typeof globalThis.fetch {
  return (input, init) => {
    const body = init?.body;
    if (typeof body !== "string" || body.includes('"service_tier"')) return fetch(input, init);
    return fetch(input, {
      ...init,
      body: JSON.stringify({ ...JSON.parse(body), service_tier: tier }),
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
