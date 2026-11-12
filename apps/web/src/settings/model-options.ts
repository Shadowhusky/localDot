import type { AgentSettingsDocument } from "@localdot/protocol";
import { t } from "../i18n/index.ts";
import { providerName, type RoleChoice, type SubscriptionModel } from "./choices.ts";
import { CHATGPT, CLAUDE_CODE, isCustomFormat } from "./chooser.ts";
import type { ModelNames } from "./model-names.ts";
import type { ProviderIndex } from "./settings-api.ts";
import { formOf, validateForm } from "./settings-form.ts";

export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly choice: RoleChoice;
  readonly accountModel?: SubscriptionModel;
  readonly controls?: import("@localdot/protocol").ModelControls;
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

export const optionId = (choice: RoleChoice) =>
  [choice.provider, choice.model, choice.key ?? ""].join("\0");
// A custom endpoint is named by its address, a provider by its name.
export function modelGroupLabel(choice: RoleChoice, index: ProviderIndex | null): string {
  if (!isCustomFormat(choice.provider)) return providerName(choice.provider);
  const url = index?.keys.find((key) => key.id === choice.key)?.baseURL;
  try {
    return url ? new URL(url).host : t`Custom endpoint`;
  } catch {
    return t`Custom endpoint`;
  }
}

// The models a task can run on: the ones in Settings that are on, for any role, and those of each
// plan the user is signed in to. Each is one Settings would save as main now, its key present; the
// current one is always listed. Plans come last, in a fixed order.
export function modelGroups(
  saved: AgentSettingsDocument | null,
  index: ProviderIndex | null,
  accounts: { chatgpt: PlanAccount; claudeCode: PlanAccount },
  names: ModelNames,
  current: RoleChoice | undefined = saved?.main,
): ModelGroup[] {
  if (!saved || !current) return [];
  const plans = { [CLAUDE_CODE]: accounts.claudeCode, [CHATGPT]: accounts.chatgpt };
  const usable = (choice: RoleChoice) =>
    validateForm(
      formOf({ ...saved, main: choice }),
      saved,
      index,
      plans[choice.provider as keyof typeof plans]?.models ?? [],
    ).ok;
  // Of a model chosen on one endpoint in both OpenAI formats, the Responses one is listed: newer
  // models need it for tools, and an endpoint that speaks it speaks Chat Completions too.
  const responsesFirst = (a: RoleChoice, b: RoleChoice) =>
    Number(b.provider === "openai-responses-compatible") -
    Number(a.provider === "openai-responses-compatible");
  const chosen = [
    current,
    ...[saved.main, saved.fast, saved.local, ...(saved.models ?? [])]
      .filter((choice): choice is RoleChoice => !!choice && !choice.off)
      .sort(responsesFirst),
  ].filter((choice): choice is RoleChoice => !!choice && !(choice.provider in plans));
  const offered = Object.entries(plans).flatMap(([provider, account]) => {
    const models = account.ready
      ? account.models
          .map((model) =>
            current.provider === provider && current.model === model.id
              ? current
              : (saved.models?.find(
                  (choice) => choice.provider === provider && choice.model === model.id,
                ) ?? { provider, model: model.id }),
          )
          .filter((choice) => !choice.off)
      : [];
    return provider === current.provider && !models.some((row) => row.model === current.model)
      ? [current, ...models]
      : models;
  });
  // A custom endpoint's models go under its address, each once in whatever format it was chosen.
  const now = optionId(current);
  const groups = new Map<string, ModelOption[]>();
  const seen = new Set<string>();
  for (const choice of [...chosen, ...offered]) {
    const id = optionId(choice);
    const custom = isCustomFormat(choice.provider);
    const same = custom ? ["custom", choice.model, choice.key ?? ""].join("\0") : id;
    if (seen.has(same) || (id !== now && !usable(choice))) continue;
    seen.add(same);
    const label = modelGroupLabel(choice, index);
    groups.set(label, [
      ...(groups.get(label) ?? []),
      {
        id,
        name: names.name(choice.provider, choice.model),
        choice,
        controls: index?.providers
          .find((p) => p.id === choice.provider)
          ?.models.find((m) => m.id === choice.model)?.controls,
        accountModel: plans[choice.provider as keyof typeof plans]?.models.find(
          (model) => model.id === choice.model,
        ),
      },
    ]);
  }
  return [...groups].map(([label, options]) => ({ label, options }));
}
