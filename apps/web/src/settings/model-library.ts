import { type ProviderSpec, providerById } from "@localdot/providers";
import { t, tr } from "../i18n/index.ts";
import type { PickerGroup } from "../ui/listbox.ts";
import {
  groupOf,
  type ModelRole,
  matchingKeys,
  type PickerKey,
  PROVIDER_GROUPS,
  type ProviderModels,
  type RoleChoice,
} from "./choices.ts";
import { CHATGPT, CLAUDE_CODE, CUSTOM_FORMATS, isCustomFormat, subscription } from "./chooser.ts";
import { modelGroupLabel, optionId } from "./model-options.ts";
import type { ProviderIndex } from "./settings-api.ts";
import { formOf, priceOf, type SettingsDraft } from "./settings-form.ts";

export interface LibraryRow {
  readonly id: string;
  readonly choice: RoleChoice;
  readonly role?: ModelRole;
}
export interface LibraryGroup {
  readonly label: string;
  readonly rows: readonly LibraryRow[];
}

const ROLES = ["main", "fast", "local"] as const;

// Every model the user has: those in a role first, then their list, under the provider or endpoint
// each goes through.
export function libraryGroups(
  draft: Pick<SettingsDraft, "choices" | "models">,
  index: ProviderIndex | null,
): LibraryGroup[] {
  const groups = new Map<string, LibraryRow[]>();
  const seen = new Set<string>();
  const place = (choice: RoleChoice | undefined, role?: ModelRole) => {
    if (!choice?.provider || !choice.model) return;
    const id = optionId(choice);
    if (seen.has(id)) return;
    seen.add(id);
    const label = modelGroupLabel(choice, index);
    groups.set(label, [...(groups.get(label) ?? []), { id, choice, ...(role ? { role } : {}) }]);
  };
  for (const role of ROLES) place(draft.choices[role], role);
  for (const choice of draft.models ?? []) place(choice);
  return [...groups].map(([label, rows]) => ({ label, rows }));
}

// Why a model on the list can't run as it stands, if it can't.
export function libraryProblem(choice: RoleChoice, keys: readonly PickerKey[]): string | undefined {
  if (subscription(choice.provider)) return undefined;
  const provider = providerById(choice.provider);
  if (!provider) return t`No longer offered`;
  if (provider.local) return undefined;
  if (!choice.key || !matchingKeys(provider, keys).some((key) => key.id === choice.key))
    return t`Its key is gone`;
  if (provider.custom && !choice.plan && !choice.price) return t`Needs a price`;
  return undefined;
}

export const setModelOn = (
  models: readonly RoleChoice[],
  choice: RoleChoice,
  on: boolean,
): RoleChoice[] =>
  models.map((model) => {
    if (optionId(model) !== optionId(choice)) return model;
    const { off: _, ...rest } = model;
    return on ? rest : { ...rest, off: true };
  });

export const withoutModel = (models: readonly RoleChoice[], choice: RoleChoice): RoleChoice[] =>
  models.filter((model) => optionId(model) !== optionId(choice));

export function withModels(
  models: readonly RoleChoice[],
  added: readonly RoleChoice[],
): RoleChoice[] {
  const ids = new Set(added.map(optionId));
  return [...models.filter((model) => !ids.has(optionId(model))), ...added];
}

// One of the user's models takes a role, whatever held it joining the list.
export function promoted(
  draft: SettingsDraft,
  role: ModelRole,
  choice: RoleChoice,
): Pick<SettingsDraft, "choices" | "prices" | "models"> {
  const { off: _, ...taken } = choice;
  const old = draft.choices[role];
  const holding = old?.provider && old.model ? old : undefined;
  const models = withoutModel(draft.models ?? [], choice);
  const choices = { ...draft.choices, [role]: taken };
  const prices = { ...draft.prices };
  const price = formOf({ [role]: taken }).prices[role];
  if (price) prices[role] = price;
  else delete prices[role];
  if (!holding || optionId(holding) === optionId(choice)) return { choices, prices, models };
  const typed = priceOf(draft.prices[role]);
  return {
    choices,
    prices,
    models: withModels(models, [{ ...holding, ...(typed ? { price: typed } : {}) }]),
  };
}

export const SOURCE_GROUPS = [
  "Ready",
  "Not set up yet",
  "Not available here",
  "Later releases",
] as const;

const SOURCE_GROUP_NAMES: Readonly<Record<(typeof SOURCE_GROUPS)[number], string>> = {
  Ready: tr("Ready"),
  "Not set up yet": tr("Not set up yet"),
  "Not available here": tr("Not available here"),
  "Later releases": tr("Later releases"),
};

export interface ModelSource {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly provider: string;
  readonly key?: string;
  readonly custom: boolean;
  // Takes model IDs as its server names them; a catalog provider's models are its catalog's.
  readonly typed: boolean;
  readonly group: (typeof SOURCE_GROUPS)[number];
  // What it needs before its models can be added: a key, its plan's own sign-in, or an endpoint's
  // address and key.
  readonly setup?: "key" | "plan" | "endpoint";
  readonly disabledReason?: string;
}

const PLAN_SOURCES = [
  {
    id: CHATGPT,
    label: tr("ChatGPT plan"),
    ready: tr("Signed in"),
    setup: tr("Sign in with your account"),
  },
  {
    id: CLAUDE_CODE,
    label: tr("Claude Code (your plan)"),
    ready: tr("Uses your own Claude Code"),
    setup: tr("Set up Claude Code"),
  },
] as const;

// Where models can come from, every provider localDot offers: first what is ready (a saved key's
// provider or endpoint, a plan signed in, the local servers), then what can be set up here, then
// what can't be used yet. A key that two providers share is offered under each.
export function modelSources(
  index: ProviderIndex | null,
  keys: readonly PickerKey[],
  plansReady: Readonly<Record<typeof CHATGPT | typeof CLAUDE_CODE, boolean>> = {
    [CHATGPT]: false,
    [CLAUDE_CODE]: false,
  },
): ModelSource[] {
  const listed = (index?.providers ?? [])
    .map((row) => providerById(row.id))
    .filter((row): row is ProviderSpec => !!row);
  const usable = listed.filter((row) => !row.notOffered && !row.availableIn && !row.local);
  const sources: ModelSource[] = [];
  for (const key of keys) {
    const fits = usable.filter((row) => matchingKeys(row, [key]).length > 0);
    const named = fits.filter((row) => !row.custom);
    for (const provider of named.length ? named : fits.slice(0, 1)) {
      const custom = !!provider.custom;
      sources.push({
        id: `${provider.id}/${key.id}`,
        label: custom
          ? modelGroupLabel({ provider: provider.id, model: "", key: key.id }, index)
          : provider.name,
        description: t`Key ${key.id}`,
        provider: provider.id,
        key: key.id,
        custom,
        typed: custom,
        group: "Ready",
      });
    }
  }
  const unavailable = (id: string) =>
    index?.subscriptions.find((row) => row.id === id)?.available === false;
  const plan = (row: (typeof PLAN_SOURCES)[number], ready: boolean): ModelSource => ({
    id: row.id,
    label: row.label,
    description: ready ? row.ready : row.setup,
    provider: row.id,
    custom: false,
    typed: false,
    group: ready ? "Ready" : "Not set up yet",
    ...(ready ? {} : { setup: "plan" as const }),
    ...(!ready && unavailable(row.id) ? { disabledReason: t`Not available on this Mac yet` } : {}),
  });
  for (const row of PLAN_SOURCES) if (plansReady[row.id]) sources.push(plan(row, true));
  for (const provider of listed)
    if (provider.local)
      sources.push({
        id: provider.id,
        label: provider.name,
        description: t`Runs on this Mac`,
        provider: provider.id,
        custom: false,
        typed: true,
        group: "Ready",
      });
  // The rest in the order the model pickers list providers, a custom endpoint once.
  for (const label of PROVIDER_GROUPS) {
    if (label === "Local servers")
      for (const row of PLAN_SOURCES) if (!plansReady[row.id]) sources.push(plan(row, false));
    for (const provider of listed) {
      if (groupOf(provider) !== label || provider.local) continue;
      if (provider.custom && provider.id !== CUSTOM_FORMATS[0].value) continue;
      if (!provider.custom && matchingKeys(provider, keys).length) continue;
      sources.push({
        id: provider.id,
        label: provider.custom ? t`Custom endpoint` : provider.name,
        description: provider.custom
          ? t`Add your server's address and key`
          : provider.plan
            ? t`Add your plan's key`
            : t`Add an API key`,
        provider: provider.id,
        custom: !!provider.custom,
        typed: !!provider.custom,
        ...(provider.availableIn
          ? { group: "Later releases" as const, disabledReason: t`Coming in a later release` }
          : provider.notOffered
            ? {
                group: "Not available here" as const,
                disabledReason: t`Its maker allows it only in their own tools`,
              }
            : {
                group: "Not set up yet" as const,
                setup: provider.custom ? ("endpoint" as const) : ("key" as const),
              }),
      });
    }
  }
  return sources;
}

// The source the sheet starts on: the first key or plan that is ready. A local server may not be
// running, so it is never assumed.
export const firstSource = (sources: readonly ModelSource[]) =>
  sources.find(
    (row) => row.group === "Ready" && !providerById(row.provider)?.local && !row.disabledReason,
  );

export function sourceGroups(sources: readonly ModelSource[]): PickerGroup[] {
  return SOURCE_GROUPS.map((label) => ({
    label: SOURCE_GROUP_NAMES[label],
    items: sources
      .filter((row) => row.group === label)
      .map((row) => ({
        value: row.id,
        label: row.label,
        ...(row.description ? { description: row.description } : {}),
        ...(row.disabledReason ? { disabledReason: row.disabledReason } : {}),
        // A Claude search finds Anthropic, where an API key works, as the model pickers do.
        keywords: `${row.provider} ${row.key ?? ""}${row.provider === "anthropic" ? " claude" : ""}`,
      })),
  })).filter((group) => group.items.length > 0);
}

// What another provider's catalog says of a model an endpoint passes on under the same name.
export function knownFacts(
  providers: readonly ProviderModels[],
  id: string,
): Pick<RoleChoice, "price" | "vision" | "contextTokens"> {
  const model = providers
    .flatMap((row) => row.models)
    .find(
      (row) =>
        row.id.toLowerCase() === id.toLowerCase() &&
        (row.inputUSDPerMTok > 0 || row.outputUSDPerMTok > 0),
    );
  if (!model) return {};
  return {
    price: { inputUSDPerMTok: model.inputUSDPerMTok, outputUSDPerMTok: model.outputUSDPerMTok },
    ...(model.contextTokens >= 4_096 && model.contextTokens <= 2_000_000
      ? { contextTokens: model.contextTokens }
      : {}),
  };
}

// New models from a source, each set up as the endpoint's other models are: what the user said of
// that endpoint holds for all of them.
export function newChoices(
  source: ModelSource,
  ids: readonly string[],
  providers: readonly ProviderModels[],
  siblings: readonly RoleChoice[],
  typedPrice: RoleChoice["price"],
  format?: string,
): RoleChoice[] {
  const provider = format && isCustomFormat(format) ? format : source.provider;
  const sibling = siblings.find((row) => row.key === source.key && isCustomFormat(row.provider));
  return ids.map((model) => {
    const facts = source.custom ? knownFacts(providers, model) : {};
    return {
      provider,
      model,
      ...(source.key ? { key: source.key } : {}),
      ...(source.custom ? facts : {}),
      ...(source.custom && !sibling?.plan && !facts.price && typedPrice
        ? { price: typedPrice }
        : {}),
      ...(sibling?.plan ? { plan: true as const } : {}),
      ...(sibling?.speedTiers ? { speedTiers: true as const } : {}),
    };
  });
}
