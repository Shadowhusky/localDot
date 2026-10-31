import { ModelOptions, type ModelSpeed, type ReasoningEffort } from "@localdot/protocol";
import { providerById } from "./registry.ts";
import { speedTiers } from "./speeds.ts";

// Reviewed against the vendor references in docs/providers.md (2026-10-31). A reasoning model is
// not necessarily configurable. Unknown families deliberately keep the provider default.
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
  speeds?: readonly ModelSpeed[];
}
const basic = ["low", "medium", "high"] as const;
const full = [...basic, "xhigh", "max"] as const;
const toggle = ["none", "enabled"] as const;
// Kimi K3, GLM 5.3 and their hosts: three levels and no off switch.
const lowHighMax = ["low", "high", "max"] as const;
const unknown: ModelControls = { efforts: [] };
const effort = (
  efforts: readonly ReasoningEffort[],
  wire: ThinkingWire = "effort",
): ModelControls => ({ efforts, wire });
function openai(model: string): ModelControls {
  // A gateway's GPT-6 "pro" ID is OpenAI's pro reasoning mode, whose levels aren't published.
  if (/^gpt-6.*-pro(?:-|$)/.test(model)) return unknown;
  if (/^gpt-6-(?:sol|luna)(?:-|$)|^gpt-6\.1-terra(?:-|$)/.test(model))
    return { ...effort(["none", ...full]), verbosity: true };
  if (/^gpt-6-astra(?:-|$)|^gpt-6\.1-sol(?:-|$)/.test(model))
    return { ...effort(full), verbosity: true };
  if (/^gpt-5\.6(?:-|$)/.test(model)) return { ...effort(["none", ...full]), verbosity: true };
  if (/^gpt-5\.3-codex(?:-max)?$/.test(model)) return effort([...basic, "xhigh"]);
  if (/^gpt-5(?:[.-]|$)/.test(model) && !/chat|search|codex/.test(model)) {
    if (/^gpt-5-pro(?:-|$)/.test(model)) return effort(["high"]);
    if (/^gpt-5\.[2-5]-pro/.test(model)) return effort(["medium", "high", "xhigh"]);
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
  // Fable 5, Opus 5.5 and Sonnet 5.5 always think (Sonnet 5.5's lowest setting still notes
  // between tools); the others take thinking disabled.
  if (/claude-(?:fable-5|(?:opus|sonnet)-5-5|mythos-5)/.test(m)) return effort(full, "anthropic");
  if (/claude-(?:opus-4-[78]|(?:opus|sonnet|haiku)-5)/.test(m))
    return effort(["none", ...full], "anthropic");
  if (/claude-(?:opus|sonnet)-4-6/.test(m)) return effort([...basic, "max"], "anthropic");
  if (/claude-opus-4-5/.test(m)) return { ...effort(basic, "anthropic-budget"), budget: true };
  if (/claude-(?:3-7-sonnet|(?:sonnet|opus)-4|haiku-4-5)/.test(m))
    return { ...effort(["none"], "anthropic-budget"), budget: true };
  return unknown;
}
// Speed is a separate billing and latency choice, never an effort synonym. Compatible endpoints
// don't inherit a vendor's service tiers unless their user says they take them.
export function modelControls(
  provider: string,
  modelId: string,
  discovered?: ModelControls,
): ModelControls {
  return choiceControls({ provider, model: modelId }, discovered);
}
export function choiceControls(
  choice: { provider: string; model: string; speedTiers?: boolean },
  discovered?: ModelControls,
): ModelControls {
  if (discovered) return discovered;
  const controls = reasoningControls(choice.provider, choice.model);
  const tiers = speedTiers(choice.provider, choice.model, choice.speedTiers === true);
  return tiers.length
    ? { ...controls, speeds: ["standard", ...tiers.map((tier) => tier.speed)] }
    : controls;
}
// One model family on one API: the pattern its lower-case ID matches and what that API accepts
// for it. The first family that matches wins, so an exclusion is a family with no controls.
type Family = readonly [RegExp, ModelControls];
const family = (families: readonly Family[], model: string): ModelControls =>
  families.find(([pattern]) => pattern.test(model))?.[1] ?? unknown;
const gemini: readonly Family[] = [
  [/^gemini-2\.5-pro/, { ...effort([], "google-budget"), budget: true }],
  [/^gemini-2\.5-flash/, { ...effort(["none"], "google-budget"), budget: true }],
  [/^gemini-3-pro/, effort(["low", "high"], "google-level")],
  [/^gemini-(?:4-argon|3\.1-pro|3\.[78]-(?:pro|flash))/, effort(basic, "google-level")],
  [/image/, unknown],
  [/^gemini-(?:3-flash|3\.[156]-flash)/, effort(["minimal", ...basic], "google-level")],
];
// K3 and K3.1 always think, at `reasoning_effort`; K2.7 Code always thinks with no setting.
const kimi: readonly Family[] = [
  [/^kimi-k3/, effort(lowHighMax)],
  [/^kimi-k2\.[56]/, effort(toggle, "thinking")],
];
// GLM 5.3 always thinks; 5.2 also takes `thinking.type` and maps low and medium to high.
const glm: readonly Family[] = [
  [/^glm-5\.3/, effort(lowHighMax)],
  [/^glm-5\.2/, effort(["none", "high", "max"], "deepseek")],
  [/^glm-(?:4\.[567]|5(?:\.1)?(?:$|-)|5v-turbo)/, effort(toggle, "thinking")],
];
// Model Studio's own Qwen families and the other vendors' models it serves, each in its own words
// there: `enable_thinking`, then `reasoning_effort` or `thinking_budget`, never both.
const dashscope: readonly Family[] = [
  [/thinking|instruct|coder|image|max-preview|^kimi\/|kimi-k2\.7|minimax/, unknown],
  [/^qwen3\.8-omni/, effort(["none", "minimal", ...full])],
  [
    /^qwen3\.8-(?:max|flash)/,
    { ...effort(["none", "low", "medium", "xhigh"], "enable-thinking"), budget: true },
  ],
  [
    /^qwen(?:3(?:\.[5678])?|-(?:plus|turbo|flash))/,
    { ...effort(toggle, "enable-thinking"), budget: true },
  ],
  [/^kimi-k3/, effort(lowHighMax)],
  [/^kimi-k2\.[56]/, { ...effort(toggle, "enable-thinking"), budget: true }],
  [/^glm-5\.3/, effort(lowHighMax)],
  [/^glm-5(?:\.[12])?$/, effort(["none", "high", "max"], "enable-thinking")],
  [/^deepseek-v4/, effort(["none", "low", "high", "max"], "enable-thinking")],
];
// M3.1 Flash always thinks at `reasoning_effort`; M3's adaptive thinking can only be turned off.
const minimax: readonly Family[] = [
  [/^minimax-m3\.1-flash(?:-preview)?$/, effort(full)],
  [/^minimax-m3$/, effort(["none"], "thinking")],
];
const siliconflow: readonly Family[] = [
  [/glm-5\.3/, effort(lowHighMax)],
  [/deepseek-v4-(?:pro|flash)$|glm-5\.2$/, effort(["high", "max"])],
  [/deepseek-v3\.1$/, effort(["none"], "enable-thinking")],
  [
    /qwen3-(?:8b|14b|32b|30b-a3b|235b-a22b)$|hunyuan-a13b-instruct|glm-(?:5v-turbo|4\.[56]v)|deepseek-v3\.(?:1-terminus|2)/,
    { ...effort(toggle, "enable-thinking"), budget: true },
  ],
];
// Gateway vocabulary takes precedence over the model vendor's, and a catalog's reasoning boolean
// is never evidence of a parameter.
const FAMILIES: Readonly<Record<string, readonly Family[]>> = {
  google: gemini,
  "google-vertex": gemini,
  deepseek: [
    [/^deepseek-(?:flash|pro|v4)/, effort(["none", "low", "high", "max"], "deepseek")],
    [/^deepseek-(?:chat|reasoner)$/, effort(toggle, "thinking")],
  ],
  xai: [
    [/^grok-4\.[67]/, effort([...basic, "xhigh"])],
    [/^grok-4\.5/, effort(basic)],
    [/^grok-4\.3(?:-|$)/, effort(["none", ...basic])],
  ],
  groq: [
    [/gpt-oss/, effort(basic)],
    [/qwen3\.8-27b/, effort(["none", ...basic])],
    [/qwen3\.6-27b/, effort(["none"])],
  ],
  mistral: [
    [/^zai-glm-5-3$/, effort(["low", "high", "max"])],
    [/^mistral-large-4(?:-0)?$/, effort(basic)],
    [
      /^mistral-(?:small-(?:latest|4|2603)|medium-(?:latest|2604|3[.-]5))$/,
      effort(["none", "high"]),
    ],
  ],
  "fireworks-ai": [
    [/minimax-m3p1-flash/, effort(full)],
    [/gpt-oss|(?:minimax-)?m2(?:[.-]|$)/, effort(basic)],
    [/qwen3[.-]8/, effort(["none", ...full])],
    [/deepseek-v4|kimi-k3/, effort(["none", "low", "high", "max"])],
    [/glm-5[.-]2/, effort(["none", "high", "max"])],
    [/deepseek-v3[.p-][12]|glm-(?:4[.-][567]|5[.-]1)/, effort(toggle, "binary-effort")],
    [/thinking|instruct|coder/, unknown],
    [/qwen3(?:-|\.)/, effort(["none", ...basic])],
  ],
  deepinfra: [
    [/glm-5\.3/, effort(lowHighMax)],
    [
      /deepseek-v4-(?:flash-0731|pro-0813)|glm-5\.2|kimi-k3|ling-3\.0-flash/,
      effort(["none", ...basic]),
    ],
  ],
  volcengine: [
    [
      /^doubao-seed-(?:evolving$|2-[01]-(?:pro|lite|mini|turbo|code-preview)-|character-260628)/,
      effort(["none", ...basic], "deepseek"),
    ],
    [/^deepseek-v4-(?:pro|flash)/, effort(["none", "low", "high", "max"], "deepseek")],
    [/^glm-5-2-260617$/, effort(["none", "high", "max"], "deepseek")],
    [/^glm-5-3-flash-/, effort(lowHighMax)],
    [/^doubao-seed-1-8-/, effort(["none", ...basic], "deepseek")],
  ],
  cohere: [[/^command-a-reasoning/, effort(["none", "high"])]],
  siliconflow,
  "siliconflow-cn": siliconflow,
  togetherai: [
    [/gpt-oss/, effort(basic)],
    [/kimi-k3/, effort(["none", ...lowHighMax], "together")],
    [/deepseek-v4-pro/, effort(["none", "high", "max"], "together")],
    [/glm-5\.3/, effort(["low", "medium", "high", "max"])],
    [/minimax-m3|deepseek-v4|glm-5\.2|qwen3\.(?:5|6)/, effort(toggle, "together")],
  ],
  cerebras: [
    [/gpt-oss/, effort(basic)],
    [/^qwen-3\.8-27b$/, effort(["none", ...basic])],
    [/glm-5\.3-flash/, effort(["low", "high", "max"])],
    [/glm-4\.[67]/, effort(["none"])],
  ],
  moonshotai: kimi,
  "moonshotai-cn": kimi,
  zai: glm,
  zhipuai: glm,
  alibaba: dashscope,
  "alibaba-cn": dashscope,
  "alibaba-token-plan": dashscope,
  "alibaba-coding-plan": dashscope,
  minimax,
  "minimax-coding-plan": minimax,
  ollama: [[/gpt-oss/, effort(basic)]],
  // localDot always supplies tools. GPT-6 Sol/Luna and GPT-5.6 chat take them only at none (even
  // the default effort refuses them); Astra and 6.1 need a Responses endpoint for tool use. Other
  // IDs are read as OpenAI's own.
  "openai-compatible": [
    [/^gpt-(?:6-(?:sol|luna)|5\.6)(?:-|$)/, effort(["none"])],
    [/^gpt-6/, unknown],
  ],
};
// OpenRouter's unified `reasoning` object, for the vendors whose families it maps.
// Its model list narrows these per model (discovery.ts). It refuses `none` for Claude.
const OPENROUTER: Readonly<Record<string, (model: string) => ModelControls>> = {
  openai,
  anthropic: (model) => {
    const c = claude(model);
    return { ...c, efforts: c.efforts.filter((e) => e !== "none") };
  },
  google: (model) => family(gemini, model),
  deepseek: (model) => family(FAMILIES.deepseek ?? [], model),
  "x-ai": (model) => family(FAMILIES.xai ?? [], model),
  moonshotai: (model) => family(kimi, model),
  "z-ai": (model) => family(glm, model),
  qwen: (model) => family(dashscope, model),
  minimax: (model) => family(minimax, model),
  mistralai: (model) => family(FAMILIES.mistral ?? [], model),
};
function reasoningControls(provider: string, modelId: string): ModelControls {
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
    // Current native aliases support the full effort vocabulary; account metadata
    // narrows these controls when the installed runtime resolves an older model.
    if (/^(opus|sonnet|fable|best)$/.test(model)) return effort(full);
    if (model === "haiku") return unknown;
    const c = claude(model);
    return c.wire === "anthropic" || /opus-4[.-]5/.test(model)
      ? effort(c.efforts.filter((e) => e !== "none"))
      : unknown;
  }
  if (client === "anthropic" || client === "anthropic-compatible") return claude(model);
  if (client === "openai" || client === "azure") return openai(model);
  if (provider === "openrouter") {
    const [vendor = "", bare = ""] = model.replace(/:.*$/, "").split("/");
    const c = OPENROUTER[vendor]?.(bare) ?? unknown;
    return c.wire ? { ...c, wire: "openrouter", verbosity: false } : unknown;
  }
  const families = FAMILIES[provider];
  if (provider === "openai-compatible")
    return families?.find(([pattern]) => pattern.test(model))?.[1] ?? openai(model);
  if (families) return family(families, model);
  // Perplexity, LM Studio and the providers M8 brings have endpoint- or model-specific
  // contracts. Add only documented combinations, never infer from the catalog's reasoning
  // boolean or send a parameter merely because the endpoint is compatible.
  return unknown;
}

// An On saved while a model offered only Off and On is its default thinking, which it now takes as
// levels: every model that moved from the switch to levels thinks by default.
function savedOn(effort: ReasoningEffort | undefined, c: ModelControls): boolean {
  return (
    effort === "enabled" && !c.efforts.includes("enabled") && c.efforts.some((e) => e !== "none")
  );
}
export function modelOptionsProblem(
  provider: string,
  model: string,
  raw: unknown,
  outputCap = 16000,
  discovered?: ModelControls,
): string | undefined {
  if (raw === undefined) return;
  const parsed = ModelOptions.safeParse(raw);
  if (!parsed.success) return "Invalid model options.";
  const o = parsed.data,
    c = modelControls(provider, model, discovered);
  if (
    o.reasoningEffort !== undefined &&
    !c.efforts.includes(o.reasoningEffort) &&
    !savedOn(o.reasoningEffort, c)
  )
    return "This model does not support that reasoning effort.";
  if (o.thinkingBudget !== undefined && (!c.budget || o.thinkingBudget > outputCap - 1024))
    return "Choose a thinking budget that leaves at least 1,024 tokens for the answer.";
  if (o.speed !== undefined && !c.speeds?.includes(o.speed))
    return "Speed selection is not supported for this model and endpoint.";
  if (o.verbosity !== undefined && !c.verbosity)
    return "This model does not support answer detail.";
}
export function sameModelOptions(a?: ModelOptions, b?: ModelOptions): boolean {
  return (
    a?.reasoningEffort === b?.reasoningEffort &&
    a?.thinkingBudget === b?.thinkingBudget &&
    a?.verbosity === b?.verbosity &&
    a?.speed === b?.speed
  );
}
type Wire = string | number | boolean | { readonly [key: string]: Wire };
// Per million tokens, what a task set aside for a premium speed.
export interface SpeedCap {
  readonly inputUSDPerMTok: number;
  readonly outputUSDPerMTok: number;
}
// Each provider's own name for a speed, under its client's options. OpenAI's Ultrafast is in its
// Responses API only; an OpenAI-format custom endpoint's chat route gets the field as sent.
// OpenRouter serves a premium request from a pricier endpoint only within the cap, else standard.
function speedOptions(provider: string, speed: ModelSpeed, cap?: SpeedCap): Record<string, Wire> {
  const spec = providerById(provider);
  const tier = speed === "standard" ? "default" : speed === "fast" ? "priority" : "ultrafast";
  if (provider === "anthropic") return { speed };
  if (provider === "google") return { serviceTier: speed === "standard" ? "standard" : "priority" };
  if (provider === "xai") return { serviceTier: tier };
  if (provider === "openrouter")
    return {
      service_tier: speed === "fast" ? "fast" : tier,
      ...(cap && speed !== "standard"
        ? {
            provider: {
              max_price: { prompt: cap.inputUSDPerMTok, completion: cap.outputUSDPerMTok },
            },
          }
        : {}),
    };
  if (provider === "openai" || (spec?.custom && spec.client === "openai"))
    return { serviceTier: tier };
  if (spec?.custom && spec.client === "openai-compatible") return { service_tier: tier };
  return {};
}
// A closed translation table. No URLs, credentials, arbitrary body keys or sampling controls
// can enter the request through settings. SDK adapters preserve signatures between tool turns.
export function modelProviderOptions(
  provider: string,
  model: string,
  options?: ModelOptions,
  discovered?: ModelControls,
  cap?: SpeedCap,
): Record<string, Wire> {
  if (!options) return {};
  const problem = modelOptionsProblem(provider, model, options, 16000, discovered);
  if (problem) throw new Error(problem);
  const c = modelControls(provider, model, discovered),
    e = savedOn(options.reasoningEffort, c) ? undefined : options.reasoningEffort,
    budget = options.thinkingBudget;
  // An effort level, as opposed to switching thinking off or on.
  const level = e === "none" || e === "enabled" ? undefined : e;
  const out: Record<string, Wire> = options.speed ? speedOptions(provider, options.speed, cap) : {};
  if (options.verbosity) out.textVerbosity = options.verbosity;
  if (e === undefined && budget === undefined) return out;
  switch (c.wire) {
    case "anthropic":
      out.thinking = { type: e === "none" ? "disabled" : "adaptive" };
      if (level) out.effort = level;
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
      if (level) out.reasoningEffort = level;
      break;
    case "together":
      if (level) out.reasoningEffort = level;
      else out.reasoning = { enabled: e !== "none" };
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
