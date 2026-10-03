import type { ClientKind, LLM_PROVIDERS } from "@localdot/protocol";

// keyd's provider kinds (Part 4a's route table, with Part 5a's five first-class presets) plus its
// two built-in local routes.
export type KeydKind = (typeof LLM_PROVIDERS)[number];
export type LocalRoute = "lmstudio" | "ollama";

// The first-class providers that keyd reaches with a bearer token at a base URL it fixes: each has
// its official AI SDK package, its own client kind and its own keyd kind (P5a-R4, P5a-R31).
export const FIRST_CLASS_BEARER = ["xai", "mistral", "deepseek", "groq", "openrouter"] as const;

export interface ProviderSpec {
  // models.dev's provider id, so the catalog's models attach to it.
  id: string;
  name: string;
  client: ClientKind;
  // How the key is stored in keyd: an `llm` secret of this kind, or a built-in local route.
  keyd: KeydKind | LocalRoute;
  // The upstream an openai-compatible key is bound to (keyd's `baseURL`); the user gives Azure's,
  // and keyd's presets fix the first-class providers'.
  baseURL?: string;
  local?: boolean;
  // Spec "Providers and sign-in": Bedrock and Vertex need keyd's signing, which is M8's.
  availableIn?: "m8";
}

// Every API-key provider the spec names, and the local servers; each id is models.dev's provider
// id. The first-class providers use their official AI SDK packages and their own keyd kinds; the
// other eight speak OpenAI's chat completions at their documented base URLs (P5a-R4).
export const PROVIDERS: readonly ProviderSpec[] = [
  { id: "anthropic", name: "Anthropic", client: "anthropic", keyd: "anthropic" },
  { id: "openai", name: "OpenAI", client: "openai", keyd: "openai" },
  { id: "google", name: "Google Gemini", client: "google", keyd: "google" },
  { id: "azure", name: "Azure OpenAI", client: "azure", keyd: "azure" },
  { id: "xai", name: "xAI", client: "xai", keyd: "xai" },
  { id: "mistral", name: "Mistral", client: "mistral", keyd: "mistral" },
  { id: "deepseek", name: "DeepSeek", client: "deepseek", keyd: "deepseek" },
  { id: "groq", name: "Groq", client: "groq", keyd: "groq" },
  { id: "openrouter", name: "OpenRouter", client: "openrouter", keyd: "openrouter" },
  {
    id: "togetherai",
    name: "Together",
    client: "openai-compatible",
    keyd: "openai-compatible",
    baseURL: "https://api.together.xyz/v1",
  },
  {
    id: "fireworks-ai",
    name: "Fireworks",
    client: "openai-compatible",
    keyd: "openai-compatible",
    baseURL: "https://api.fireworks.ai/inference/v1",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    client: "openai-compatible",
    keyd: "openai-compatible",
    baseURL: "https://api.cerebras.ai/v1",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    client: "openai-compatible",
    keyd: "openai-compatible",
    baseURL: "https://api.perplexity.ai",
  },
  {
    id: "cohere",
    name: "Cohere",
    client: "openai-compatible",
    keyd: "openai-compatible",
    baseURL: "https://api.cohere.ai/compatibility/v1",
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    client: "openai-compatible",
    keyd: "openai-compatible",
    baseURL: "https://api.deepinfra.com/v1/openai",
  },
  {
    id: "moonshotai",
    name: "Moonshot (Kimi)",
    client: "openai-compatible",
    keyd: "openai-compatible",
    baseURL: "https://api.moonshot.ai/v1",
  },
  {
    id: "alibaba",
    name: "Alibaba (Qwen)",
    client: "openai-compatible",
    keyd: "openai-compatible",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "openai-compatible",
    name: "Other (OpenAI-compatible)",
    client: "openai-compatible",
    keyd: "openai-compatible",
  },
  { id: "lmstudio", name: "LM Studio", client: "lmstudio", keyd: "lmstudio", local: true },
  { id: "ollama", name: "Ollama", client: "ollama", keyd: "ollama", local: true },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    client: "openai-compatible",
    keyd: "openai-compatible",
    availableIn: "m8",
  },
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    client: "google",
    keyd: "google",
    availableIn: "m8",
  },
];

export function providerById(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// A router chooses a different priced model later, so it cannot reserve a known model hold.
export function isOpenRouterRouterId(providerId: string, modelId: string): boolean {
  return providerId === "openrouter" && /^openrouter\//i.test(modelId);
}

// The keyd route a model is called through: a local server's built-in route, else the id of the
// `llm` key the user stored for that provider (keyd: "a secret's route name is its id").
export function routeFor(provider: ProviderSpec, keyId?: string): string | undefined {
  if (provider.keyd === "lmstudio" || provider.keyd === "ollama") return provider.keyd;
  return keyId;
}

// keyd's gateway for the brain (Part 4a): the route's base already ends in the provider's version
// path, so an SDK's baseURL is this, and the brain reaches it through its keyd listener.
export function gatewayBaseURL(route: string): string {
  return `http://llm.ldot/${route}`;
}
