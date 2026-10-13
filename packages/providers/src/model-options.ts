import { ModelOptions, type ReasoningEffort } from "@localdot/protocol";
import { providerById } from "./registry.ts";

// Reviewed against the vendor references in docs/model-options.md. A reasoning model is not
// necessarily configurable. Unknown families deliberately keep the provider default.
export type ThinkingWire =
  | "binary-effort"
  | "effort"
  | "anthropic"
  | "anthropic-budget"
  | "google-level"
  | "google-budget"
  | "deepseek"
  | "thinking"
  | "enable-thinking"
  | "together"
  | "openrouter";
export interface ModelControls {
  efforts: readonly ReasoningEffort[];
  wire?: ThinkingWire;
  budget?: boolean;
  verbosity?: boolean;
}
const basic = ["low", "medium", "high"] as const;
const full = [...basic, "xhigh", "max"] as const;
const toggle = ["none", "enabled"] as const;
const unknown: ModelControls = { efforts: [] };
const effort = (
  efforts: readonly ReasoningEffort[],
  wire: ThinkingWire = "effort",
): ModelControls => ({ efforts, wire });
function openai(model: string): ModelControls {
  if (/^gpt-6-(?:sol|luna)(?:-|$)/.test(model))
    return { ...effort(["none", ...full]), verbosity: true };
  if (/^gpt-6-astra(?:-|$)|^gpt-6\.1-sol(?:-|$)/.test(model))
    return { ...effort(full), verbosity: true };
  if (/^gpt-5\.6(?:-|$)/.test(model)) return { ...effort(["none", ...full]), verbosity: true };
  if (/^gpt-5(?:[.-]|$)/.test(model) && !/chat|search|codex/.test(model)) {
    if (/^gpt-5-pro(?:-|$)/.test(model)) return effort(["high"]);
    if (/^gpt-5\.[234]-pro/.test(model)) return effort(["medium", "high", "xhigh"]);
    if (/^gpt-5\.[7-9]/.test(model)) return unknown;
    const newer = /^gpt-5\.[2-5]/.test(model);
    return {
      ...effort(
        newer
          ? ["none", ...basic, "xhigh"]
          : /^gpt-5\.1/.test(model)
            ? ["none", ...basic]
            : ["minimal", ...basic],
      ),
      verbosity: true,
    };
  }
  if (/^(?:o1|o3|o4)(?:-|$)/.test(model) && !/pro|deep-research/.test(model)) return effort(basic);
  if (/gpt-oss-(?:20b|120b)/.test(model)) return effort(basic);
  return unknown;
}
function claude(model: string): ModelControls {
  const m = model.replaceAll(".", "-");
  if (/claude-(?:opus-4-[78]|(?:opus|sonnet|haiku|fable|mythos)-5)/.test(m))
    return effort(full, "anthropic");
  if (/claude-(?:opus|sonnet)-4-6/.test(m)) return effort([...basic, "max"], "anthropic");
  if (/claude-opus-4-5/.test(m)) return { ...effort(basic, "anthropic-budget"), budget: true };
  if (/claude-(?:3-7-sonnet|(?:sonnet|opus)-4|haiku-4-5)/.test(m))
    return { ...effort(["none"], "anthropic-budget"), budget: true };
  return unknown;
}
export function modelControls(provider: string, modelId: string): ModelControls {
  const model = modelId.toLowerCase();
  const client = providerById(provider)?.client;
  if (provider === "chatgpt") {
    // Native Codex does not accept verbosity here. Match its supported effort vocabulary.
    const c = openai(model.replace(/-codex(?:-max)?/, ""));
    return c.wire
      ? effort(c.efforts.filter((e) => e !== "enabled" && (!/^gpt-6/.test(model) || e !== "none")))
      : unknown;
  }
  if (provider === "claude-code") {
    if (/^(opus|sonnet)$/.test(model)) return effort(basic);
    if (model === "haiku") return unknown;
    const c = claude(model);
    return c.wire === "anthropic" || /opus-4[.-]5/.test(model) ? effort(c.efforts) : unknown;
  }
  if (client === "anthropic" || client === "anthropic-compatible") return claude(model);
  if (client === "openai" || client === "azure") return openai(model);
  if (client === "google") {
    if (/^gemini-2\.5-(?:pro|flash)/.test(model))
      return { ...effort(model.includes("pro") ? [] : ["none"], "google-budget"), budget: true };
    if (/^gemini-3-pro/.test(model)) return effort(["low", "high"], "google-level");
    if (/^gemini-3\.1-pro|^gemini-3\.8-(?:pro|flash)/.test(model))
      return effort(basic, "google-level");
    if (/^gemini-(?:3-flash|3\.[156]-flash)/.test(model) && !/image/.test(model))
      return effort(["minimal", ...basic], "google-level");
    return unknown;
  }
  if (provider === "deepseek") {
    if (/^deepseek-(?:flash|pro|v4)/.test(model))
      return effort(["none", "low", "high", "max"], "deepseek");
    if (/^deepseek-(?:chat|reasoner)$/.test(model)) return effort(toggle, "thinking");
  }
  if (provider === "xai") {
    if (/^grok-4\.[67]/.test(model)) return effort([...basic, "xhigh"]);
    if (/^grok-4\.5/.test(model)) return effort(basic);
    return unknown;
  }
  if (provider === "groq") {
    if (/gpt-oss/.test(model)) return effort(basic);
    if (/qwen3\.[68]-27b/.test(model)) return effort(["none", ...basic]);
    return unknown;
  }
  if (provider === "mistral") {
    if (/^zai-glm-5-3/.test(model)) return effort(["low", "high", "max"]);
    if (/^mistral-small-(?:latest|4|2603)/.test(model)) return effort(["none", "high"]);
    return unknown;
  }
  if (provider === "openrouter") {
    const bare = model.replace(/^[^/]+\//, "").replace(/:.*$/, "");
    const c = model.startsWith("openai/")
      ? openai(bare)
      : model.startsWith("anthropic/")
        ? claude(bare)
        : model.startsWith("google/")
          ? modelControls("google", bare)
          : model.startsWith("deepseek/")
            ? modelControls("deepseek", bare)
            : unknown;
    if (c.wire) return { ...c, wire: "openrouter", verbosity: false };
    return unknown;
  }
  if (provider === "fireworks-ai") {
    if (/gpt-oss|(?:minimax-)?m2(?:[.-]|$)/.test(model)) return effort(basic);
    if (/qwen3[.-]8/.test(model)) return effort(["none", ...full]);
    if (/deepseek-v4|kimi-k3/.test(model)) return effort(["none", "low", "high", "max"]);
    if (/glm-5[.-]2/.test(model)) return effort(["none", "high", "max"]);
    if (/deepseek-v3[.p-][12]|glm-(?:4[.-][567]|5[.-]1)/.test(model))
      return effort(toggle, "binary-effort");
    if (/qwen3(?:-|\.)/.test(model) && !/thinking|instruct|coder/.test(model))
      return effort(["none", ...basic]);
    return unknown;
  }
  if (provider === "deepinfra")
    return /deepseek-v4-(?:flash-0731|pro-0813)|glm-5\.2|kimi-k3|ling-3\.0-flash/.test(model)
      ? effort(["none", ...basic])
      : unknown;
  if (provider === "volcengine") {
    if (
      /^doubao-seed-(?:evolving$|2-[01]-(?:pro|lite|mini|turbo|code-preview)-|character-260628)/.test(
        model,
      )
    )
      return effort(["none", ...basic], "deepseek");
    if (/^deepseek-v4-(?:pro|flash)/.test(model))
      return effort(["none", "low", "high", "max"], "deepseek");
    if (model === "glm-5-2-260617") return effort(["none", "high", "max"], "deepseek");
    return unknown;
  }
  if (provider === "cohere")
    return /^command-a-reasoning/.test(model) ? effort(["none", "high"]) : unknown;
  if (["siliconflow", "siliconflow-cn"].includes(provider)) {
    if (/deepseek-v3\.1$/.test(model)) return effort(["none"], "enable-thinking");
    if (
      /qwen3-(?:8b|14b|32b|30b-a3b|235b-a22b)$|hunyuan-a13b-instruct|glm-(?:5v-turbo|4\.[56]v)|deepseek-v3\.(?:1-terminus|2)/.test(
        model,
      )
    )
      return { ...effort(toggle, "enable-thinking"), budget: true };
    return unknown;
  }
  if (provider === "togetherai") {
    if (/gpt-oss/.test(model)) return effort(basic);
    if (/minimax-m3|deepseek-v4|glm-5\.2|kimi-k3|qwen3\.(?:5|6)/.test(model))
      return effort(toggle, "together");
    return unknown;
  }
  if (provider === "cerebras") {
    if (/gpt-oss/.test(model)) return effort(basic);
    if (/glm-4\.[67]/.test(model)) return effort(["none"]);
    return unknown;
  }
  if (["moonshotai", "moonshotai-cn"].includes(provider))
    return /^kimi-k2\.[56]/.test(model) ? effort(toggle, "thinking") : unknown;
  if (["zai", "zhipuai"].includes(provider))
    return /^glm-(?:4\.[567]|5(?:[.-][12])?(?:$|-))/.test(model) && !/^glm-5\.3/.test(model)
      ? effort(toggle, "thinking")
      : unknown;
  if (["alibaba", "alibaba-cn", "alibaba-token-plan", "alibaba-coding-plan"].includes(provider)) {
    if (
      /^qwen(?:3(?:\.[568])?|-(?:plus|turbo))/.test(model) &&
      !/thinking|instruct|coder|image/.test(model)
    )
      return { ...effort(toggle, "enable-thinking"), budget: true };
    return unknown;
  }
  if (["minimax", "minimax-coding-plan"].includes(provider))
    return model === "minimax-m3.1-flash-preview" ? effort(full) : unknown;
  if (provider === "ollama") return /gpt-oss/.test(model) ? effort(basic) : unknown;
  if (provider === "openai-compatible") {
    // localDot always supplies tools. GPT-6 Sol/Luna chat supports them only at none;
    // Astra and 6.1 Sol need a Responses endpoint for tool use.
    if (/^gpt-6-(?:sol|luna)(?:-|$)/.test(model)) return effort(["none"]);
    if (/^gpt-6/.test(model)) return unknown;
    return openai(model);
  }
  // Perplexity and LM Studio have
  // endpoint/model-specific contracts. Add only documented combinations, never infer from
  // the catalog's reasoning boolean or send a parameter merely because the endpoint is compatible.
  return unknown;
}

export function modelOptionsProblem(
  provider: string,
  model: string,
  raw: unknown,
  outputCap = 16000,
): string | undefined {
  if (raw === undefined) return;
  const parsed = ModelOptions.safeParse(raw);
  if (!parsed.success) return "Invalid model options.";
  const o = parsed.data,
    c = modelControls(provider, model);
  if (o.reasoningEffort !== undefined && !c.efforts.includes(o.reasoningEffort))
    return "This model does not support that reasoning effort.";
  if (o.thinkingBudget !== undefined && (!c.budget || o.thinkingBudget > outputCap - 1024))
    return "Choose a thinking budget that leaves at least 1,024 tokens for the answer.";
  if (o.verbosity !== undefined && !c.verbosity)
    return "This model does not support answer detail.";
}
export function sameModelOptions(a?: ModelOptions, b?: ModelOptions): boolean {
  return (
    a?.reasoningEffort === b?.reasoningEffort &&
    a?.thinkingBudget === b?.thinkingBudget &&
    a?.verbosity === b?.verbosity
  );
}
// A closed translation table. No URLs, credentials, arbitrary body keys or sampling controls
// can enter the request through settings. SDK adapters preserve signatures between tool turns.
export function modelProviderOptions(
  provider: string,
  model: string,
  options?: ModelOptions,
): Record<string, string | number | boolean | Record<string, string | number | boolean>> {
  if (!options) return {};
  const problem = modelOptionsProblem(provider, model, options);
  if (problem) throw new Error(problem);
  const c = modelControls(provider, model),
    e = options.reasoningEffort,
    budget = options.thinkingBudget;
  const out: ReturnType<typeof modelProviderOptions> = {};
  if (options.verbosity) out.textVerbosity = options.verbosity;
  if (e === undefined && budget === undefined) return out;
  switch (c.wire) {
    case "anthropic":
      out.thinking = { type: "adaptive" };
      if (e) out.effort = e;
      break;
    case "anthropic-budget":
      if (e === "none") out.thinking = { type: "disabled" };
      else if (budget !== undefined) out.thinking = { type: "enabled", budgetTokens: budget };
      else if (e) out.effort = e;
      break;
    case "google-level":
      if (e) out.thinkingConfig = { thinkingLevel: e };
      break;
    case "google-budget":
      if (e === "none" || budget !== undefined)
        out.thinkingConfig = { thinkingBudget: e === "none" ? 0 : (budget ?? 0) };
      break;
    case "deepseek":
      out.thinking = { type: e === "none" ? "disabled" : "enabled" };
      if (e && e !== "none") out.reasoningEffort = e;
      break;
    case "thinking":
      out.thinking = { type: e === "none" ? "disabled" : "enabled" };
      break;
    case "enable-thinking":
      out.enable_thinking = e !== "none";
      if (budget !== undefined) out.thinking_budget = budget;
      break;
    case "together":
      out.reasoning = { enabled: e !== "none" };
      break;
    case "openrouter":
      out.reasoning =
        budget !== undefined
          ? { max_tokens: budget }
          : e === "enabled"
            ? { enabled: true }
            : { effort: e ?? "none" };
      break;
    case "binary-effort":
      out.reasoningEffort = e === "enabled" ? "medium" : "none";
      break;
    case "effort":
      if (e) out.reasoningEffort = e;
      break;
  }
  return out;
}
