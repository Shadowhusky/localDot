import { providerById } from "@localdot/providers";
import {
  type ModelRole,
  matchingKeys,
  type PickerKey,
  type ProviderModels,
  type RoleChoice,
} from "./choices.ts";
import { isCustomFormat, subscription } from "./chooser.ts";
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
  if (!provider) return "No longer offered";
  if (provider.local) return undefined;
  if (!choice.key || !matchingKeys(provider, keys).some((key) => key.id === choice.key))
    return "Its key is gone";
  if (provider.custom && !choice.plan && !choice.price) return "Needs a price";
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

export interface ModelSource {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly provider: string;
  readonly key?: string;
  readonly custom: boolean;
  // Takes model IDs as its server names them; a catalog provider's models are its catalog's.
  readonly typed: boolean;
}

// Where models can come from: a saved key's provider or endpoint, once each, and the local servers.
export function modelSources(
  index: ProviderIndex | null,
  keys: readonly PickerKey[],
): ModelSource[] {
  const sources: ModelSource[] = [];
  for (const key of keys) {
    const provider = (index?.providers ?? [])
      .map((row) => providerById(row.id))
      .find(
        (row) =>
          row &&
          !row.notOffered &&
          !row.availableIn &&
          !row.local &&
          matchingKeys(row, [key]).length > 0,
      );
    if (!provider) continue;
    const custom = !!provider.custom;
    sources.push({
      id: key.id,
      label: custom
        ? modelGroupLabel({ provider: provider.id, model: "", key: key.id }, index)
        : provider.name,
      description: `Key ${key.id}`,
      provider: provider.id,
      key: key.id,
      custom,
      typed: custom,
    });
  }
  for (const row of index?.providers ?? []) {
    const provider = providerById(row.id);
    if (provider?.local)
      sources.push({
        id: provider.id,
        label: provider.name,
        description: "Runs on this Mac",
        provider: provider.id,
        custom: false,
        typed: true,
      });
  }
  return sources;
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
