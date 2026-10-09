import { isOpenRouterRouterId, providerById } from "@localdot/providers";
import { Combobox } from "../ui/Combobox.tsx";
import { Field } from "../ui/Field.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  customModelAllowed,
  type ModelRole,
  modelIdProblem,
  type ProviderModels,
  type RoleChoice,
  type SubscriptionModel,
} from "./choices.ts";
import { CHATGPT, CLAUDE_CODE, modelItems, providerGroups, subscription } from "./chooser.ts";

export interface ModelChooserProps {
  modelRole: ModelRole;
  value: RoleChoice;
  providers: readonly ProviderModels[];
  subscriptionModels: readonly SubscriptionModel[];
  // The role's notes under its rows, which say what the choice means.
  describedBy?: string;
  onChange(value: RoleChoice): void;
}

export function providerNote(id: string): string | undefined {
  if (id === CHATGPT) return "Uses your ChatGPT account. No key or price needed.";
  if (id === CLAUDE_CODE) return "No key or price needed.";
  const provider = providerById(id);
  if (!provider) return id ? "This provider is no longer offered. Choose another." : undefined;
  if (provider.notOffered) return provider.notOffered;
  if (provider.plan) return ["Uses your plan's limits.", provider.rule].filter(Boolean).join(" ");
  if (provider.id === "anthropic")
    return "Uses API keys. To use your Claude plan, choose Claude Code (your plan).";
  return undefined;
}

export function modelNote(
  value: RoleChoice,
  providers: readonly ProviderModels[],
): string | undefined {
  const chosen = providers
    .find((row) => row.id === value.provider)
    ?.models.find((model) => model.id === value.model);
  return chosen && isOpenRouterRouterId(value.provider, chosen.id)
    ? "Choose a specific model. A router can't set aside a known price."
    : chosen?.note;
}

// The provider, then one of its models: two rows of a group, each a searchable list that opens as a
// sheet on a phone.
export function ModelChooser({
  modelRole: role,
  value,
  providers,
  subscriptionModels,
  describedBy,
  onChange,
}: ModelChooserProps) {
  const provider = providerById(value.provider);
  const models = providers.find((row) => row.id === value.provider)?.models ?? [];
  const typed = !!provider && customModelAllowed(provider);
  const plan = subscription(value.provider);
  const items = modelItems(role, provider, value.provider, models, subscriptionModels, value.model);
  const empty =
    value.provider === CHATGPT
      ? "Sign in and check the account to load its models."
      : value.provider === CLAUDE_CODE
        ? "Set up Claude Code to load its models."
        : "No models in the list yet. Refresh the model list.";
  const idProblem = value.model ? modelIdProblem(value.model) : null;
  return (
    <>
      <Field label="Provider" inline className="ui-group-row">
        <Combobox
          appearance="inline"
          value={value.provider}
          groups={providerGroups(role, value.provider)}
          aria-describedby={describedBy}
          placeholder="Choose a provider"
          searchPlaceholder="Search providers"
          onValueChange={(id) => onChange({ provider: id, model: "" })}
        />
      </Field>
      {(plan || (provider && !provider.notOffered)) &&
        (typed && !models.length ? (
          <Field label="Model ID" inline className="ui-group-row" error={idProblem ?? undefined}>
            <TextField
              size="sm"
              value={value.model}
              maxLength={128}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="e.g. my-model-1"
              onChange={(event) => onChange({ ...value, model: event.target.value })}
            />
          </Field>
        ) : (
          <Field
            label="Model"
            inline
            className="ui-group-row"
            {...(typed ? { error: idProblem ?? undefined } : {})}
            disabledReason={items.length || typed ? undefined : empty}
          >
            <Combobox
              appearance="inline"
              value={value.model}
              items={items}
              aria-describedby={describedBy}
              placeholder="Choose a model"
              searchPlaceholder="Search models"
              customDescription={typed ? "Use this model ID" : undefined}
              onValueChange={(model) => onChange({ ...value, model, price: undefined })}
            />
          </Field>
        ))}
    </>
  );
}
