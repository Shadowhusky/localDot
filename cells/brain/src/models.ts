import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { ModelBinding, SURROGATE_PATTERN } from "@localdot/protocol";
import { gatewayBaseURL } from "@localdot/providers";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { type LanguageModel, wrapLanguageModel } from "ai";

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
    case "openai":
      return stateless(
        createOpenAI({ baseURL, apiKey, fetch }).responses(b.model),
        "openai",
        b.reasoning,
      );
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
        b.reasoning,
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

// Only Anthropic's tool results carry images (screenshots, as the computer tool expects); every
// other client gets them in a user message after the results: the OpenAI-compatible client would
// put the image's base64 into the tool message as text.
export function imagesInToolResults(b: ModelBinding): boolean {
  return b.client === "anthropic";
}
