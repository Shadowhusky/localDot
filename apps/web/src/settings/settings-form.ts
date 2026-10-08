import {
  AgentModelPrice,
  AgentSettingsDocument,
  AutonomyPolicy,
  DEFAULT_AUTONOMY,
} from "@localdot/protocol";
import { isOpenRouterRouterId, providerById, routeFor } from "@localdot/providers";
import {
  type ModelRole,
  matchingKeys,
  modelAllowed,
  modelIdProblem,
  type PickerKey,
  providerAllowed,
  type RoleChoice,
  type SubscriptionModel,
} from "./choices.ts";
import type { ProviderIndex } from "./settings-api.ts";

export interface PriceDraft {
  input: string;
  output: string;
}
export interface SettingsDraft {
  choices: Partial<Record<ModelRole, RoleChoice>>;
  prices: Partial<Record<ModelRole, PriceDraft>>;
  budget: string;
  defaultBudget: boolean;
  autonomy?: AutonomyPolicy;
}
export const roles = ["main", "fast", "local"] as const;
export function formOf(settings: AgentSettingsDocument): SettingsDraft {
  const choices: SettingsDraft["choices"] = {},
    prices: SettingsDraft["prices"] = {};
  for (const role of roles) {
    const choice = settings[role];
    if (!choice) continue;
    choices[role] = { ...choice, ...(choice.price ? { price: { ...choice.price } } : {}) };
    if (choice.price)
      prices[role] = {
        input: String(choice.price.inputUSDPerMTok),
        output: String(choice.price.outputUSDPerMTok),
      };
  }
  return {
    choices,
    prices,
    autonomy: settings.autonomy ?? DEFAULT_AUTONOMY,
    budget: settings.taskBudgetUSD === undefined ? "" : String(settings.taskBudgetUSD),
    defaultBudget: settings.taskBudgetUSD === undefined,
  };
}
export function pickerKeys(index: ProviderIndex): PickerKey[] {
  return index.keys.map((key) => ({ ...key, kind: "llm" }));
}
export function needsPrice(choice: RoleChoice | undefined, index: ProviderIndex | null): boolean {
  if (!choice) return false;
  const provider = providerById(choice.provider);
  if (!provider || provider.local || provider.availableIn || !choice.model) return false;
  if (provider.id === "openai-compatible") return true;
  const model = index?.providers
    .find((p) => p.id === provider.id)
    ?.models.find((m) => m.id === choice.model);
  return !!model && model.inputUSDPerMTok === 0 && model.outputUSDPerMTok === 0;
}
// A decimal must have actual digits. Empty strings, hex, whitespace and special numbers cannot
// become an accounting rate by JavaScript coercion. Conversion never clips or fills a side.
export function decimal(raw: string): number | undefined {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
export function priceOf(raw: PriceDraft | undefined): RoleChoice["price"] {
  if (!raw) return undefined;
  const parsed = AgentModelPrice.safeParse({
    inputUSDPerMTok: decimal(raw.input),
    outputUSDPerMTok: decimal(raw.output),
  });
  return parsed.success ? parsed.data : undefined;
}
export type FormResult =
  | { ok: true; document: AgentSettingsDocument }
  | { ok: false; problems: string[] };
const ROLE_NAMES: Record<ModelRole, string> = { main: "Main", fast: "Fast", local: "Local" };
// Reports the first problem in each role, and any budget problem, together.
export function validateForm(
  draft: SettingsDraft,
  saved: AgentSettingsDocument,
  index: ProviderIndex | null,
  subscriptionModels: readonly SubscriptionModel[] = [],
): FormResult {
  if (!index)
    return { ok: false, problems: ["Load current model and key metadata before saving."] };
  const problems: string[] = [];
  if (!draft.choices.main) problems.push("Choose a main provider and model.");
  const document: AgentSettingsDocument = { ...saved };
  const subscription = draft.choices.main?.provider === "chatgpt";
  const accounting = new Map<string, string>();
  for (const role of roles) {
    const value = draft.choices[role];
    if (!value) {
      delete document[role];
      continue;
    }
    if (subscription && role !== "main") {
      document[role] = { ...value };
      continue;
    }
    const checked = checkRole(role, value, draft, saved, index, subscriptionModels, accounting);
    if (typeof checked === "string") problems.push(`${ROLE_NAMES[role]}: ${checked}`);
    else document[role] = checked;
  }
  if (draft.defaultBudget) {
    if (!subscription && index.defaultTaskBudgetUSD === null)
      problems.push("The default task budget is unavailable. Enter an explicit ceiling.");
    delete document.taskBudgetUSD;
  } else {
    const budget = decimal(draft.budget);
    if (budget === undefined) problems.push("Enter an explicit task ceiling in USD.");
    else document.taskBudgetUSD = budget;
  }
  if (problems.length) return { ok: false, problems };
  if (
    draft.autonomy !== undefined &&
    (saved.autonomy !== undefined ||
      JSON.stringify(draft.autonomy) !== JSON.stringify(DEFAULT_AUTONOMY))
  )
    document.autonomy = AutonomyPolicy.parse(draft.autonomy);
  const checked = AgentSettingsDocument.safeParse(document);
  return checked.success
    ? { ok: true, document: checked.data }
    : {
        ok: false,
        problems: [
          "Check the settings and task ceiling. The ceiling must be positive, within 10000 USD and at least one accounting microdollar.",
        ],
      };
}
function checkRole(
  role: ModelRole,
  value: RoleChoice,
  draft: SettingsDraft,
  saved: AgentSettingsDocument,
  index: ProviderIndex,
  subscriptionModels: readonly SubscriptionModel[],
  accounting: Map<string, string>,
): RoleChoice | string {
  if (providerById(value.provider)?.notOffered) return "choose a provider that is available here.";
  if (modelIdProblem(value.model)) return "choose a valid model ID.";
  if (value.provider === "chatgpt") {
    if (
      role !== "main" ||
      value.key !== undefined ||
      value.price !== undefined ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.model)
    )
      return "the ChatGPT plan is available for main only, without an API key or manual price.";
    const model = subscriptionModels.find((m) => m.id === value.model);
    const unchanged = saved.main?.provider === "chatgpt" && saved.main.model === value.model;
    if (!model && !unchanged)
      return "set up the ChatGPT plan and choose one of its available account models.";
    return { provider: value.provider, model: value.model };
  }
  const provider = providerById(value.provider);
  if (!provider || !providerAllowed(role, provider))
    return "choose a supported provider for this role.";
  if (isOpenRouterRouterId(provider.id, value.model))
    return "choose a specific model rather than a router ID.";
  const model = index.providers
    .find((p) => p.id === provider.id)
    ?.models.find((m) => m.id === value.model);
  if (provider.id !== "openai-compatible" && !provider.local && !model)
    return "this model is unavailable. Refresh the catalog or choose another model.";
  if (provider.id !== "openai-compatible" && model && !modelAllowed(role, model))
    return "this model cannot call the required tools.";
  const next: RoleChoice = { provider: value.provider, model: value.model };
  if (provider.local) {
    if (value.key !== undefined || value.price !== undefined)
      return "local servers use no stored key or manual price.";
    return next;
  }
  if (index.keyLayer !== "online") return "reconnect the key layer before saving.";
  if (!value.key || !matchingKeys(provider, pickerKeys(index)).some((key) => key.id === value.key))
    return "choose a stored key bound to this provider and endpoint.";
  next.key = value.key;
  if (needsPrice(value, index)) {
    const price = priceOf(draft.prices[role]);
    if (!price)
      return "enter both input and output prices, from 0 to 10000 USD per million tokens, with at least one positive.";
    next.price = price;
  } else {
    if (value.price !== undefined)
      return "the catalog already prices this model. Remove its manual price by choosing the model again.";
    if (model && (model.inputUSDPerMTok > 10_000 || model.outputUSDPerMTok > 10_000))
      return "this catalog price is unsupported.";
  }
  const rate = next.price ?? model;
  if (rate) {
    const id = `${routeFor(provider, next.key)}\0${next.model}`;
    const pair = JSON.stringify([rate.inputUSDPerMTok, rate.outputUSDPerMTok]);
    if (accounting.has(id) && accounting.get(id) !== pair)
      return "one task cannot use conflicting prices for the same route and model.";
    accounting.set(id, pair);
  }
  return next;
}
export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
