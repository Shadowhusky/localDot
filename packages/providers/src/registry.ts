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
  // A flat-rate plan whose vendor lets a general agent use it; models.dev prices its models at $0.
  plan?: true;
  // The vendor's condition on the plan, shown when it is chosen.
  rule?: string;
  // A plan whose vendor keeps it to the tools it lists: shown with this reason, never bound.
  notOffered?: string;
  // The user's own endpoint: its key names the address, and the user types the model's ID and
  // says what it can do and how it is billed.
  custom?: true;
}

const compatible = (id: string, name: string, baseURL: string): ProviderSpec => ({
  id,
  name,
  client: "openai-compatible",
  keyd: "openai-compatible",
  baseURL,
});
const notOffered = (id: string, name: string, reason: string): ProviderSpec => ({
  id,
  name,
  client: "openai-compatible",
  keyd: "openai-compatible",
  notOffered: reason,
});

// Every API-key provider the spec names, the plans their vendors let an agent use, and the local
// servers; each id is models.dev's provider id. The first-class providers use their official AI
// SDK packages and their own keyd kinds; the rest speak OpenAI's chat completions at base URLs
// pinned here, never taken from the catalog (P5a-R4), except the custom endpoints, whose keys
// name their own.
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
  compatible("togetherai", "Together", "https://api.together.xyz/v1"),
  compatible("fireworks-ai", "Fireworks", "https://api.fireworks.ai/inference/v1"),
  compatible("cerebras", "Cerebras", "https://api.cerebras.ai/v1"),
  compatible("perplexity", "Perplexity", "https://api.perplexity.ai"),
  compatible("cohere", "Cohere", "https://api.cohere.ai/compatibility/v1"),
  compatible("deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai"),
  compatible("moonshotai", "Moonshot (Kimi)", "https://api.moonshot.ai/v1"),
  compatible("moonshotai-cn", "Moonshot (China)", "https://api.moonshot.cn/v1"),
  compatible("alibaba", "Alibaba (Qwen)", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
  compatible(
    "alibaba-cn",
    "Alibaba (Qwen, China)",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ),
  compatible("zai", "Z.ai", "https://api.z.ai/api/paas/v4"),
  compatible("zhipuai", "Zhipu AI (China)", "https://open.bigmodel.cn/api/paas/v4"),
  compatible("minimax", "MiniMax", "https://api.minimax.io/v1"),
  compatible("volcengine", "Volcengine Ark", "https://ark.cn-beijing.volces.com/api/v3"),
  compatible("siliconflow", "SiliconFlow", "https://api.siliconflow.com/v1"),
  compatible("siliconflow-cn", "SiliconFlow (China)", "https://api.siliconflow.cn/v1"),
  {
    id: "openai-compatible",
    name: "Custom endpoint (OpenAI Chat Completions)",
    client: "openai-compatible",
    keyd: "openai-compatible",
    custom: true,
  },
  {
    // Responses-only gateways can reuse an existing compatible key and its bound endpoint.
    // The OpenAI client already uses stateless Responses through that keyd route.
    id: "openai-responses-compatible",
    name: "Custom endpoint (OpenAI Responses)",
    client: "openai",
    keyd: "openai-compatible",
    custom: true,
  },
  {
    id: "anthropic-compatible",
    name: "Custom endpoint (Anthropic Messages)",
    client: "anthropic-compatible",
    keyd: "anthropic-compatible",
    custom: true,
  },
  {
    ...compatible("minimax-coding-plan", "MiniMax Token Plan", "https://api.minimax.io/v1"),
    plan: true,
  },
  {
    ...compatible(
      "alibaba-token-plan",
      "Alibaba Token Plan",
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ),
    plan: true,
  },
  {
    ...compatible(
      "alibaba-coding-plan",
      "Alibaba Coding Plan",
      "https://coding-intl.dashscope.aliyuncs.com/v1",
    ),
    plan: true,
    rule: "Alibaba allows this plan only for tasks you start and watch.",
  },
  { id: "lmstudio", name: "LM Studio", client: "lmstudio", keyd: "lmstudio", local: true },
  { id: "ollama", name: "Ollama", client: "ollama", keyd: "ollama", local: true },
  notOffered(
    "zai-coding-plan",
    "GLM Coding Plan",
    "Z.ai lets this plan run only in the coding tools it lists. Use a Z.ai API key here instead.",
  ),
  notOffered(
    "kimi-code-plan-global",
    "Kimi For Coding",
    "Kimi lets this plan run only in coding tools it recognises. Use a Moonshot API key here instead.",
  ),
  notOffered(
    "volcengine-coding-plan",
    "Ark Coding Plan",
    "Volcengine lets this plan run only in the coding tools it lists. Use an Ark API key here instead.",
  ),
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
