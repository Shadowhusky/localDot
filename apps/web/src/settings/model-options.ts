import type { AgentSettingsDocument } from "@localdot/protocol";
import { providerName, type RoleChoice, type SubscriptionModel } from "./choices.ts";
import { CHATGPT, CLAUDE_CODE } from "./chooser.ts";
import type { ModelNames } from "./model-names.ts";
import type { ProviderIndex } from "./settings-api.ts";
import { formOf, validateForm } from "./settings-form.ts";

export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly choice: RoleChoice;
}
export interface ModelGroup {
  readonly label: string;
  readonly options: readonly ModelOption[];
}
export interface PlanAccount {
  // Signed in and able to start a task.
  readonly ready: boolean;
  readonly models: readonly SubscriptionModel[];
}

const optionId = (choice: RoleChoice) =>
  [choice.provider, choice.model, choice.key ?? ""].join("\0");

// The models the main model can switch to without a trip to Settings: the ones chosen there for any
// role, and those of each plan the user is signed in to. Each is one Settings would save as main
// now, its key present; the current one is always listed. Plans come last, in a fixed order.
export function modelGroups(
  saved: AgentSettingsDocument | null,
  index: ProviderIndex | null,
  accounts: { chatgpt: PlanAccount; claudeCode: PlanAccount },
  names: ModelNames,
): ModelGroup[] {
  const current = saved?.main;
  if (!saved || !current) return [];
  const plans = { [CLAUDE_CODE]: accounts.claudeCode, [CHATGPT]: accounts.chatgpt };
  const usable = (choice: RoleChoice) =>
    validateForm(
      formOf({ ...saved, main: choice }),
      saved,
      index,
      plans[choice.provider as keyof typeof plans]?.models ?? [],
    ).ok;
  const chosen = [current, saved.fast, saved.local, ...(saved.models ?? [])].filter(
    (choice): choice is RoleChoice => !!choice && !(choice.provider in plans),
  );
  const offered = Object.entries(plans).flatMap(([provider, account]) => {
    const models = account.ready
      ? account.models.map((model) => ({ provider, model: model.id }))
      : [];
    return provider === current.provider && !models.some((row) => row.model === current.model)
      ? [current, ...models]
      : models;
  });
  const now = optionId(current);
  const groups = new Map<string, ModelOption[]>();
  const seen = new Set<string>();
  for (const choice of [...chosen, ...offered]) {
    const id = optionId(choice);
    if (seen.has(id) || (id !== now && !usable(choice))) continue;
    seen.add(id);
    const label = providerName(choice.provider);
    groups.set(label, [
      ...(groups.get(label) ?? []),
      { id, name: names.name(choice.provider, choice.model), choice },
    ]);
  }
  return [...groups].map(([label, options]) => ({ label, options }));
}

export const currentOption = (saved: AgentSettingsDocument | null) =>
  saved?.main ? optionId(saved.main) : undefined;
