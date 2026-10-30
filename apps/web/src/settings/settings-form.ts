import {
  type Accessory,
  AgentModelPrice,
  AgentSettingsDocument,
  AutonomyPolicy,
  CheckIns,
  CLAUDE_CODE_MODEL,
  DEFAULT_AUTONOMY,
  DEFAULT_PERSONA,
  DEFAULT_RESEARCH_BUDGET,
  type LocalDotLink,
  type PersonaId,
  ResearchBudget,
} from "@localdot/protocol";
import {
  isOpenRouterRouterId,
  modelOptionsProblem,
  providerById,
  routeFor,
} from "@localdot/providers";
import {
  controlsOf,
  type ModelRole,
  matchingKeys,
  modelAllowed,
  modelIdProblem,
  onPlan,
  type PickerKey,
  planOnly,
  providerAllowed,
  type RoleChoice,
  roleActive,
  type SubscriptionModel,
} from "./choices.ts";
import { subscription as onSubscription } from "./chooser.ts";
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
// How far a research task reads before it writes, as typed.
export interface ResearchDraft {
  sources: string;
  minutes: string;
}
export interface SettingsDraft {
  models?: RoleChoice[];
  choices: Partial<Record<ModelRole, RoleChoice>>;
  prices: Partial<Record<ModelRole, PriceDraft>>;
  spending: SpendingDraft;
  checkIns: CheckInsDraft;
  research: ResearchDraft;
  autonomy?: AutonomyPolicy;
  // On is Auto.
  purposeCheck: boolean;
  recentActivity: boolean;
  persona: PersonaId;
  autoPersona: boolean;
  // This localDot's name, as typed, the accessory its dot wears, and the user's others.
  name: string;
  accessory?: Accessory;
  localDots: LocalDotLink[];
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
    ...(settings.models ? { models: settings.models } : {}),
    choices,
    prices,
    autonomy: settings.autonomy ?? DEFAULT_AUTONOMY,
    persona: settings.persona ?? DEFAULT_PERSONA,
    autoPersona: settings.autoPersona === true,
    name: settings.name ?? "",
    ...(settings.accessory ? { accessory: settings.accessory } : {}),
    localDots: settings.localDots ?? [],
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
    research: {
      sources: String((settings.research ?? DEFAULT_RESEARCH_BUDGET).sources),
      minutes: String((settings.research ?? DEFAULT_RESEARCH_BUDGET).minutes),
    },
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
  if (draft.models?.length) document.models = draft.models;
  if (draft.persona === DEFAULT_PERSONA) delete document.persona;
  else document.persona = draft.persona;
  if (draft.autoPersona) document.autoPersona = true;
  else delete document.autoPersona;
  const name = draft.name.trim();
  if (!name) delete document.name;
  else if (AgentSettingsDocument.shape.name.safeParse(name).success) document.name = name;
  else problems.push("Name this localDot in up to 40 letters, numbers and punctuation.");
  if (draft.accessory) document.accessory = draft.accessory;
  else delete document.accessory;
  if (draft.localDots.length) document.localDots = draft.localDots;
  else delete document.localDots;
  const subscription = onSubscription(draft.choices.main?.provider);
  const accounting = new Map<string, string>();
  for (const role of roles) {
    const value = draft.choices[role];
    if (!value) {
      delete document[role];
      continue;
    }
    // A choice that waits beside the main model is kept as it was, for when it works again.
    if (!roleActive(role, draft.choices)) {
      document[role] = { ...value };
      continue;
    }
    const checked = checkRole(role, value, draft, saved, index, subscriptionModels, accounting);
    if (typeof checked === "string") problems.push(`${ROLE_NAMES[role]}: ${checked}`);
    else document[role] = checked;
  }
  // Settings shows no limits for a plan or a plan's own app, so those keep what was saved.
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
  const whole = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : Number.NaN);
  const research = ResearchBudget.safeParse({
    sources: whole(draft.research.sources),
    minutes: whole(draft.research.minutes),
  });
  if (!research.success)
    problems.push("Research reads 3 to 100 sources for 2 to 120 minutes, in whole numbers.");
  else if (
    research.data.sources === DEFAULT_RESEARCH_BUDGET.sources &&
    research.data.minutes === DEFAULT_RESEARCH_BUDGET.minutes
  )
    delete document.research;
  else document.research = research.data;
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
  // What the choice offers: a plan account's own controls for its model, a custom endpoint's
  // speeds as its user states them, else the catalog's.
  const offered = controlsOf(
    value,
    subscriptionModels.find((m) => onSubscription(value.provider) && m.id === value.model),
    index.providers.find((p) => p.id === value.provider)?.models.find((m) => m.id === value.model)
      ?.controls,
  );
  const optionsProblem = modelOptionsProblem(
    value.provider,
    value.model,
    value.options,
    undefined,
    {
      ...offered,
      speeds: offered.speeds.length ? ["standard", ...offered.speeds] : undefined,
    },
  );
  if (optionsProblem) return optionsProblem;
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
    return {
      provider: value.provider,
      model: value.model,
      ...(value.options ? { options: value.options } : {}),
    };
  }
  if (value.provider === "claude-code") {
    if (
      role === "local" ||
      value.key !== undefined ||
      value.price !== undefined ||
      !CLAUDE_CODE_MODEL.test(value.model)
    )
      return "Claude Code works as the main or fast model, without an API key or manual price.";
    const model = subscriptionModels.find((m) => m.id === value.model);
    const unchanged = saved[role]?.provider === "claude-code" && saved[role]?.model === value.model;
    if (!model && !unchanged) return "set up Claude Code and choose one of its models.";
    return {
      provider: value.provider,
      model: value.model,
      ...(value.options ? { options: value.options } : {}),
    };
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
  const next: RoleChoice = {
    provider: value.provider,
    model: value.model,
    ...(value.options ? { options: value.options } : {}),
  };
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
    if (value.speedTiers && provider.client !== "anthropic-compatible") next.speedTiers = true;
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
// Object insertion order and absent optional properties are not user edits.
export function sameSettingsValue(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, stable(item)]),
      );
    return value;
  };
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return sameSettingsValue(a, b);
}
