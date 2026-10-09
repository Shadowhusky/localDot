import { PROVIDERS, type ProviderSpec, providerById } from "@localdot/providers";
import type { DotState } from "../dot/engine/states.ts";
import type { PickerModel } from "../settings/choices.ts";

export type WizardStep = "welcome" | "thinks" | "key" | "model" | "permissions" | "turn-on";
export type ThinkKind = "api" | "chatgpt" | "claude-code" | "plan" | "local" | "custom";
// A plan the person signs in to in its own app, which brings its own models.
export const appKind = (kind: ThinkKind | undefined) =>
  kind === "chatgpt" || kind === "claude-code";

// The steps the progress bars count; the welcome comes before them.
export const WIZARD_STEPS = ["thinks", "key", "model", "permissions", "turn-on"] as const;
type CountedStep = (typeof WIZARD_STEPS)[number];

export interface WizardProgress {
  step: WizardStep;
  kind?: ThinkKind;
  // A registry provider's id, "chatgpt" or "claude-code".
  provider?: string;
  // The stored key the main model uses.
  key?: string;
  // Finish later: setup waits in the rail until the person continues it.
  dismissed?: boolean;
  finished?: boolean;
  // A summary row's Change: the step it comes back to once the change is made.
  back?: "turn-on";
}

export const ONBOARDING_KEY = "localdot.onboarding.v1";
export const FRESH: WizardProgress = { step: "welcome" };

const STEP_TITLES: Record<CountedStep, string> = {
  thinks: "How dot thinks",
  key: "Key",
  model: "Model",
  permissions: "Permissions",
  "turn-on": "Turn on",
};

export function stepTitle(step: CountedStep, kind: ThinkKind | undefined): string {
  if (step !== "key") return STEP_TITLES[step];
  if (appKind(kind)) return "Sign-in";
  if (kind === "local") return "Server";
  if (kind === "custom") return "Address";
  return "Key";
}

// dot listens while the person chooses where its thinking comes from, and wakes at the end.
export const STEP_DOT: Readonly<Record<WizardStep, DotState>> = {
  welcome: "idle",
  thinks: "listening",
  key: "listening",
  model: "idle",
  permissions: "idle",
  "turn-on": "waking",
};

// 1 for the first counted step; 0 for the welcome.
export function stepNumber(step: WizardStep): number {
  return step === "welcome" ? 0 : WIZARD_STEPS.indexOf(step) + 1;
}

export function nextStep(progress: WizardProgress): WizardStep {
  const { step } = progress;
  if (step === "welcome") return "thinks";
  // A change from the summary returns to it once nothing after it needs choosing again.
  if (progress.back && (step === "model" || step === "permissions")) return progress.back;
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + 1] ?? "turn-on";
}

export function previousStep(step: WizardStep): WizardStep {
  if (step === "welcome" || step === "thinks") return "welcome";
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) - 1] ?? "welcome";
}

// First run: the saved settings are in, no main model is chosen and setup was not put off or
// finished. Setup that was under way comes back where it was, even once a model is chosen.
export function wizardShown({
  known,
  configured,
  progress,
}: {
  known: boolean;
  configured: boolean;
  progress: WizardProgress;
}): boolean {
  if (!known || progress.dismissed || progress.finished) return false;
  return !configured || progress.step !== "welcome";
}

const STEPS = new Set<string>(["welcome", ...WIZARD_STEPS]);
const KINDS = new Set<string>(["api", "chatgpt", "claude-code", "plan", "local", "custom"]);
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// What a browser kept, read defensively: anything unexpected starts setup over.
export function parseProgress(raw: string | null): WizardProgress {
  if (!raw) return FRESH;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return FRESH;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return FRESH;
  const fields = value as Record<string, unknown>;
  if (typeof fields.step !== "string" || !STEPS.has(fields.step)) return FRESH;
  const progress: WizardProgress = { step: fields.step as WizardStep };
  if (typeof fields.kind === "string" && KINDS.has(fields.kind))
    progress.kind = fields.kind as ThinkKind;
  if (typeof fields.provider === "string" && ID.test(fields.provider))
    progress.provider = fields.provider;
  if (typeof fields.key === "string" && ID.test(fields.key)) progress.key = fields.key;
  if (fields.dismissed === true) progress.dismissed = true;
  if (fields.finished === true) progress.finished = true;
  if (fields.back === "turn-on") progress.back = "turn-on";
  return progress;
}

export function kindOf(provider: string | undefined): ThinkKind | undefined {
  if (!provider) return undefined;
  if (provider === "chatgpt") return "chatgpt";
  if (provider === "claude-code") return "claude-code";
  const spec = providerById(provider);
  if (!spec) return undefined;
  if (spec.local) return "local";
  if (spec.plan || spec.notOffered) return "plan";
  if (spec.custom) return "custom";
  return "api";
}

// Pay-as-you-go providers with a fixed address; Azure, whose address is the user's own, stays in
// Settings with the custom endpoints.
export const API_PROVIDERS: readonly ProviderSpec[] = PROVIDERS.filter(
  (p) => !p.local && !p.plan && !p.custom && !p.notOffered && !p.availableIn && p.id !== "azure",
);
export const FEATURED_API = ["anthropic", "openai", "google"] as const;
// Plans a general agent may use, then those whose vendors keep them to their own tools.
export const PLAN_PROVIDERS: readonly ProviderSpec[] = [
  ...PROVIDERS.filter((p) => p.plan),
  ...PROVIDERS.filter((p) => p.notOffered),
];
export const LOCAL_PROVIDERS: readonly ProviderSpec[] = PROVIDERS.filter((p) => p.local);
export const CUSTOM_PROVIDERS: readonly ProviderSpec[] = PROVIDERS.filter((p) => p.custom);

export const KEY_PAGES: Readonly<Record<string, string>> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/apikey",
  xai: "https://console.x.ai",
  mistral: "https://console.mistral.ai/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  groq: "https://console.groq.com/keys",
  openrouter: "https://openrouter.ai/keys",
};

const TIER_SCORE: Record<string, number> = { "text-only": 1, "vision-tools": 2, native: 3 };
const COMPUTER_SCORE: Record<string, number> = { "anthropic-toolset": 2, "anthropic-legacy": 1 };
// Above this output price a model is the flagship rather than the everyday choice.
const EVERYDAY_OUTPUT_USD = 15;
const byName = (a: PickerModel, b: PickerModel) =>
  b.name.localeCompare(a.name, undefined, { numeric: true });

function score(model: PickerModel): number {
  return (TIER_SCORE[model.tier] ?? 0) * 3 + (COMPUTER_SCORE[model.computer] ?? 0);
}

// The model to suggest for the work: the best at using a computer, then the strongest at an
// everyday price, then the newest name. Models that can't call tools are never suggested.
export function recommendedMain(models: readonly PickerModel[]): PickerModel | undefined {
  const usable = models.filter((model) => model.tier !== "no-tools");
  const best = Math.max(...usable.map(score));
  const top = usable.filter((model) => score(model) === best);
  const everyday = top.filter((model) => model.outputUSDPerMTok <= EVERYDAY_OUTPUT_USD);
  const pool = everyday.length ? everyday : top;
  return [...pool].sort(
    (a, b) =>
      (everyday.length
        ? b.outputUSDPerMTok - a.outputUSDPerMTok
        : a.outputUSDPerMTok - b.outputUSDPerMTok) || byName(a, b),
  )[0];
}

// The cheapest other model from the same provider for titles, summaries and quick checks,
// preferring one that can call tools.
export function recommendedFast(
  models: readonly PickerModel[],
  main: string | undefined,
): PickerModel | undefined {
  const others = models.filter((model) => model.id !== main);
  const tools = others.filter((model) => model.tier !== "no-tools");
  return [...(tools.length ? tools : others)].sort(
    (a, b) => a.outputUSDPerMTok - b.outputUSDPerMTok || byName(a, b),
  )[0];
}

export function abilityLine(model: PickerModel): string {
  if (model.tier === "native") return "Best at using a computer";
  if (model.tier === "vision-tools") return "Can use the computer";
  if (model.tier === "text-only") return "Works with files and pages, not the screen";
  return "Can't do the work: it can't use tools";
}

// "Thinks with" on the summary.
export function thinksWith(
  kind: ThinkKind | undefined,
  provider: string | undefined,
  address?: string,
): string {
  const name = provider ? providerById(provider)?.name : undefined;
  switch (kind) {
    case "chatgpt":
      return "ChatGPT plan";
    case "claude-code":
      return "Claude Code";
    case "local":
      return name ?? "Local model";
    case "plan":
      return name ?? "Coding plan";
    case "custom":
      return address ? hostOf(address) : "Your own address";
    case "api":
      return name ? `${name} API key` : "API key";
    default:
      return "Not chosen yet";
  }
}

export function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
