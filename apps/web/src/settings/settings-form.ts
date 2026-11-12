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
import { t } from "../i18n/index.ts";
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
  // A task a plan's limit paused continues by itself once the plan resets.
  autoContinue: boolean;
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
    autoContinue: settings.autoContinue !== "off",
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
// A role's problem, led by the role it is in.
const roleProblem = (role: ModelRole, text: string) =>
  role === "main" ? t`Main: ${text}` : role === "fast" ? t`Fast: ${text}` : t`Local: ${text}`;
// The role whose route a key's other use was found on, as a key-billing problem names it.
const roleWord = (role: string | undefined) =>
  role === "main"
    ? t`main`
    : role === "fast"
      ? t`fast`
      : role === "local"
        ? t`local`
        : String(role);
const CHECK_IN_PROBLEMS: Record<CheckInKey, string> = {
  steps: t`Check in after 5 to 10,000 steps, in whole steps.`,
  failures: t`Check in after 2 to 100 failed actions in a row.`,
  actions: t`Stop after 10 to 100,000 actions, in whole actions.`,
};
const MAIN_PROBLEM = t`Choose a main provider and model.`;
export const NAME_PROBLEM = t`Name this localDot in up to 40 letters, numbers and punctuation.`;
const RESEARCH_PROBLEM = t`Research reads 3 to 100 sources for 2 to 120 minutes, in whole numbers.`;
const LIMIT_PROBLEMS = {
  task: t`Enter a limit per task from $0.01 to $10,000, or leave it empty.`,
  day: t`Enter a limit per day from $0.01 to $10,000, or leave it empty.`,
  none: t`Enter a limit per task, per day or both, or turn the spending limit off.`,
};
const RANGE_PROBLEM = t`Check the settings and the spending limits: each is $0.01 to $10,000.`;
const PRICE_PROBLEM = t`enter both input and output prices, from 0 to 10000 USD per million tokens, with at least one positive.`;
const CONTEXT_PROBLEM = t`enter a context window from 4,096 to 2,000,000 tokens, or leave it empty.`;
const STORED_KEY_PROBLEM = t`choose a stored key bound to this provider and endpoint.`;
const KEY_LAYER_PROBLEM = t`reconnect the key layer before saving.`;
const billingProblem = (flat: boolean, owner: string | undefined) =>
  flat
    ? t`this key is pay as you go for ${roleWord(owner)}. Use a key from this plan here.`
    : t`this key is a plan for ${roleWord(owner)}. Use a pay-as-you-go key here.`;
export interface SettingsIssue {
  section: "models" | "autonomy" | "spending" | "dot";
  // A role's card, a check-in, or the limit that says what is wrong; none when no one field does.
  field?: ModelRole | CheckInKey | "research" | "task" | "day" | "name";
  text: string;
}
// Where a problem validateForm reports is put right.
export function issueOf(problem: string): SettingsIssue {
  if (problem === MAIN_PROBLEM) return { section: "models", field: "main", text: problem };
  const role = roleOf(problem);
  if (role) return { section: "models", field: role, text: withoutRole(problem) };
  for (const key of CHECK_INS)
    if (problem === CHECK_IN_PROBLEMS[key])
      return { section: "autonomy", field: key, text: problem };
  if (problem === RESEARCH_PROBLEM)
    return { section: "autonomy", field: "research", text: problem };
  if (problem === LIMIT_PROBLEMS.day) return { section: "spending", field: "day", text: problem };
  if (problem === LIMIT_PROBLEMS.task || problem === LIMIT_PROBLEMS.none)
    return { section: "spending", field: "task", text: problem };
  if (problem === RANGE_PROBLEM) return { section: "spending", text: problem };
  if (problem === NAME_PROBLEM) return { section: "dot", field: "name", text: problem };
  return { section: "models", text: problem };
}
const roleOf = (problem: string) => roles.find((role) => problem.startsWith(roleProblem(role, "")));
// The field of a role's card that says what is wrong: the model's unless it is about another.
export function roleProblemField(problem: string): "model" | "key" | "price" | "context" {
  if (problem === PRICE_PROBLEM) return "price";
  if (problem === CONTEXT_PROBLEM) return "context";
  const keyProblems = [
    STORED_KEY_PROBLEM,
    KEY_LAYER_PROBLEM,
    ...roles.flatMap((role) => [billingProblem(true, role), billingProblem(false, role)]),
  ];
  return keyProblems.includes(problem) ? "key" : "model";
}
// A problem without the role validateForm leads it with, for a place that asks about one role.
export function withoutRole(problem: string): string {
  const role = roleOf(problem);
  return role ? problem.slice(roleProblem(role, "").length) : problem;
}
// Reports the first problem in each role, and any limit or check-in problem, together.
export function validateForm(
  draft: SettingsDraft,
  saved: AgentSettingsDocument,
  index: ProviderIndex | null,
  subscriptionModels: readonly SubscriptionModel[] = [],
): FormResult {
  if (!index)
    return { ok: false, problems: [t`Load current model and key metadata before saving.`] };
  const problems: string[] = [];
  if (!draft.choices.main) problems.push(MAIN_PROBLEM);
  const document: AgentSettingsDocument = { ...saved };
  // An empty list says the user removed every model in it.
  if (draft.models) document.models = draft.models;
  if (draft.persona === DEFAULT_PERSONA) delete document.persona;
  else document.persona = draft.persona;
  if (draft.autoPersona) document.autoPersona = true;
  else delete document.autoPersona;
  const name = draft.name.trim();
  if (!name) delete document.name;
  else if (AgentSettingsDocument.shape.name.safeParse(name).success) document.name = name;
  else problems.push(NAME_PROBLEM);
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
    if (typeof checked === "string") problems.push(roleProblem(role, checked));
    else document[role] = checked;
  }
  // Settings shows no limits for a plan or a plan's own app, so those keep what was saved.
  const { spending } = draft;
  if (!subscription && !planOnly(draft.choices)) {
    delete document.taskBudgetUSD;
    delete document.dayBudgetUSD;
  }
  if (spending.on && !subscription && !planOnly(draft.choices)) {
    for (const [field, raw, problem] of [
      ["taskBudgetUSD", spending.task, LIMIT_PROBLEMS.task],
      ["dayBudgetUSD", spending.day, LIMIT_PROBLEMS.day],
    ] as const) {
      if (!raw) continue;
      const usd = decimal(raw);
      if (usd !== undefined && usd > 0 && usd <= 10_000) document[field] = usd;
      else problems.push(problem);
    }
    if (!spending.task && !spending.day) problems.push(LIMIT_PROBLEMS.none);
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
  if (!research.success) problems.push(RESEARCH_PROBLEM);
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
  if (draft.autoContinue) delete document.autoContinue;
  else document.autoContinue = "off";
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
        problems: [RANGE_PROBLEM],
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
  if (providerById(value.provider)?.notOffered) return t`choose a provider that is available here.`;
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
  if (modelIdProblem(value.model)) return t`choose a valid model ID.`;
  if (value.provider === "chatgpt") {
    if (
      role !== "main" ||
      value.key !== undefined ||
      value.price !== undefined ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.model)
    )
      return t`the ChatGPT plan is available for main only, without an API key or manual price.`;
    const model = subscriptionModels.find((m) => m.id === value.model);
    const unchanged = saved.main?.provider === "chatgpt" && saved.main.model === value.model;
    if (!model && !unchanged)
      return t`set up the ChatGPT plan and choose one of its available account models.`;
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
      return t`Claude Code works as the main or fast model, without an API key or manual price.`;
    const model = subscriptionModels.find((m) => m.id === value.model);
    const unchanged = saved[role]?.provider === "claude-code" && saved[role]?.model === value.model;
    if (!model && !unchanged) return t`set up Claude Code and choose one of its models.`;
    return {
      provider: value.provider,
      model: value.model,
      ...(value.options ? { options: value.options } : {}),
    };
  }
  const provider = providerById(value.provider);
  if (!provider || !providerAllowed(role, provider))
    return t`choose a supported provider for this role.`;
  if (isOpenRouterRouterId(provider.id, value.model))
    return t`choose a specific model rather than a router ID.`;
  const model = index.providers
    .find((p) => p.id === provider.id)
    ?.models.find((m) => m.id === value.model);
  if (!provider.custom && !provider.local && !model)
    return t`this model is unavailable. Refresh the catalog or choose another model.`;
  if (!provider.custom && model && !modelAllowed(role, model))
    return t`this model cannot call the required tools.`;
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
      return CONTEXT_PROBLEM;
    if (value.vision === false) next.vision = false;
    if (context !== undefined) next.contextTokens = context;
    if (flat) next.plan = true;
    if (value.speedTiers && provider.client !== "anthropic-compatible") next.speedTiers = true;
  }
  if (provider.local) {
    if (value.key !== undefined || value.price !== undefined)
      return t`local servers use no stored key or manual price.`;
    return next;
  }
  if (index.keyLayer !== "online") return KEY_LAYER_PROBLEM;
  if (!value.key || !matchingKeys(provider, pickerKeys(index)).some((key) => key.id === value.key))
    return STORED_KEY_PROBLEM;
  next.key = value.key;
  if (needsPrice(value, index)) {
    const price = priceOf(draft.prices[role]);
    if (!price) return PRICE_PROBLEM;
    next.price = price;
  } else if (!flat) {
    if (value.price !== undefined)
      return t`the catalog already prices this model. Remove its manual price by choosing the model again.`;
    if (model && (model.inputUSDPerMTok > 10_000 || model.outputUSDPerMTok > 10_000))
      return t`this catalog price is unsupported.`;
  }
  const route = routeFor(provider, next.key) ?? "";
  const kind = flat ? "plan" : "paid";
  const [billing, owner] = accounting.get(route)?.split("\0") ?? [];
  if (billing && billing !== kind) return billingProblem(flat, owner);
  if (!billing) accounting.set(route, `${kind}\0${role}`);
  const rate = flat ? { inputUSDPerMTok: 0, outputUSDPerMTok: 0 } : (next.price ?? model);
  if (rate) {
    const id = `${route}\0${next.model}`;
    const pair = JSON.stringify([rate.inputUSDPerMTok, rate.outputUSDPerMTok]);
    if (accounting.has(id) && accounting.get(id) !== pair)
      return t`one task cannot use conflicting prices for the same route and model.`;
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
