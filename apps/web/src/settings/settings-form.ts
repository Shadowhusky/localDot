import {
  AgentModelPrice,
  AgentSettingsDocument,
  AutonomyPolicy,
  CheckIns,
  DEFAULT_AUTONOMY,
} from "@localdot/protocol";
import { isOpenRouterRouterId, providerById, routeFor } from "@localdot/providers";
import {
  type ModelRole,
  matchingKeys,
  modelAllowed,
  modelIdProblem,
  onPlan,
  type PickerKey,
  planOnly,
  providerAllowed,
  type RoleChoice,
  type SubscriptionModel,
} from "./choices.ts";
import type { ProviderIndex } from "./settings-api.ts";

export interface PriceDraft {
  input: string;
  output: string;
}
// Off by default: dot never stops for cost. On, either limit may be left empty for none.
export interface SpendingDraft {
  on: boolean;
  task: string;
  day: string;
}
export type CheckInKey = keyof CheckIns;
export type CheckInsDraft = Record<CheckInKey, { on: boolean; value: string }>;
// What a check-in starts at when the user turns it on.
export const CHECK_IN_START: Record<CheckInKey, number> = { steps: 150, failures: 5, actions: 400 };
export interface SettingsDraft {
  choices: Partial<Record<ModelRole, RoleChoice>>;
  prices: Partial<Record<ModelRole, PriceDraft>>;
  spending: SpendingDraft;
  checkIns: CheckInsDraft;
  autonomy?: AutonomyPolicy;
  // On is Auto.
  purposeCheck: boolean;
  recentActivity: boolean;
}
export const roles = ["main", "fast", "local"] as const;
const CHECK_INS = ["steps", "failures", "actions"] as const;
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
  const amount = (usd: number | undefined) => (usd === undefined ? "" : String(usd));
  return {
    choices,
    prices,
    autonomy: settings.autonomy ?? DEFAULT_AUTONOMY,
    spending: {
      on: settings.taskBudgetUSD !== undefined || settings.dayBudgetUSD !== undefined,
      task: amount(settings.taskBudgetUSD),
      day: amount(settings.dayBudgetUSD),
    },
    checkIns: Object.fromEntries(
      CHECK_INS.map((key) => {
        const value = settings.checkIns?.[key];
        return [key, { on: value !== undefined, value: String(value ?? CHECK_IN_START[key]) }];
      }),
    ) as CheckInsDraft,
    purposeCheck: settings.purposeCheck !== "off",
    recentActivity: settings.recentActivity !== "off",
  };
}
export function pickerKeys(index: ProviderIndex): PickerKey[] {
  return index.keys.map((key) => ({ ...key, kind: "llm" }));
}
export function needsPrice(choice: RoleChoice | undefined, index: ProviderIndex | null): boolean {
  if (!choice) return false;
  const provider = providerById(choice.provider);
  if (!provider || provider.local || onPlan(choice) || provider.availableIn || !choice.model)
    return false;
  if (provider.custom) return true;
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
const CHECK_IN_PROBLEMS: Record<CheckInKey, string> = {
  steps: "Check in after 5 to 10,000 steps, in whole steps.",
  failures: "Check in after 2 to 100 failed actions in a row.",
  actions: "Stop after 10 to 100,000 actions, in whole actions.",
};
// Reports the first problem in each role, and any limit or check-in problem, together.
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
  // Settings shows no limits for a plan or the ChatGPT plan, so those keep what was saved.
  const { spending } = draft;
  if (!subscription && !planOnly(draft.choices)) {
    delete document.taskBudgetUSD;
    delete document.dayBudgetUSD;
  }
  if (spending.on && !subscription && !planOnly(draft.choices)) {
    for (const [field, raw, name] of [
      ["taskBudgetUSD", spending.task, "per task"],
      ["dayBudgetUSD", spending.day, "per day"],
    ] as const) {
      if (!raw) continue;
      const usd = decimal(raw);
      if (usd !== undefined && usd > 0 && usd <= 10_000) document[field] = usd;
      else problems.push(`Enter a limit ${name} from $0.01 to $10,000, or leave it empty.`);
    }
    if (!spending.task && !spending.day)
      problems.push("Enter a limit per task, per day or both, or turn the spending limit off.");
  }
  const checkIns: CheckIns = {};
  for (const key of CHECK_INS) {
    const { on, value } = draft.checkIns[key];
    if (!on) continue;
    const parsed = CheckIns.shape[key].safeParse(/^\d+$/.test(value) ? Number(value) : Number.NaN);
    if (parsed.success && parsed.data !== undefined) checkIns[key] = parsed.data;
    else problems.push(CHECK_IN_PROBLEMS[key]);
  }
  if (Object.keys(checkIns).length) document.checkIns = checkIns;
  else delete document.checkIns;
  if (draft.purposeCheck) delete document.purposeCheck;
  else document.purposeCheck = "off";
  if (draft.recentActivity) delete document.recentActivity;
  else document.recentActivity = "off";
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
        problems: ["Check the settings and the spending limits: each is $0.01 to $10,000."],
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
  if (!provider.custom && !provider.local && !model)
    return "this model is unavailable. Refresh the catalog or choose another model.";
  if (!provider.custom && model && !modelAllowed(role, model))
    return "this model cannot call the required tools.";
  const next: RoleChoice = { provider: value.provider, model: value.model };
  const flat = onPlan(value);
  if (provider.custom) {
    const context = value.contextTokens;
    if (
      context !== undefined &&
      !(Number.isInteger(context) && context >= 4_096 && context <= 2_000_000)
    )
      return "enter a context window from 4,096 to 2,000,000 tokens, or leave it empty.";
    if (value.vision === false) next.vision = false;
    if (context !== undefined) next.contextTokens = context;
    if (flat) next.plan = true;
  }
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
  } else if (!flat) {
    if (value.price !== undefined)
      return "the catalog already prices this model. Remove its manual price by choosing the model again.";
    if (model && (model.inputUSDPerMTok > 10_000 || model.outputUSDPerMTok > 10_000))
      return "this catalog price is unsupported.";
  }
  const route = routeFor(provider, next.key) ?? "";
  const kind = flat ? "plan" : "paid";
  const [billing, owner] = accounting.get(route)?.split("\0") ?? [];
  if (billing && billing !== kind)
    return flat
      ? `this key is pay as you go for ${owner}. Use a key from this plan here.`
      : `this key is a plan for ${owner}. Use a pay-as-you-go key here.`;
  if (!billing) accounting.set(route, `${kind}\0${role}`);
  const rate = flat ? { inputUSDPerMTok: 0, outputUSDPerMTok: 0 } : (next.price ?? model);
  if (rate) {
    const id = `${route}\0${next.model}`;
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
