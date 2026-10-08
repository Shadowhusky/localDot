import { CLAUDE_PLAN_REFUSAL } from "@localdot/protocol";
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
import { CHATGPT, modelItems, providerGroups } from "./chooser.ts";

export interface ModelChooserProps {
  modelRole: ModelRole;
  value: RoleChoice;
  providers: readonly ProviderModels[];
  subscriptionModels: readonly SubscriptionModel[];
  onChange(value: RoleChoice): void;
}

function providerNote(id: string): string | undefined {
  if (id === CHATGPT) return "Uses your ChatGPT account. No key or price needed.";
  const provider = providerById(id);
  if (!provider) return id ? "This provider is no longer offered. Choose another." : undefined;
  if (provider.notOffered) return provider.notOffered;
  if (provider.plan) return ["Uses your plan's limits.", provider.rule].filter(Boolean).join(" ");
  if (provider.id === "anthropic") return CLAUDE_PLAN_REFUSAL;
  return undefined;
}

// The provider, then one of its models: two searchable lists that open as a sheet on a phone.
export function ModelChooser({
  modelRole: role,
  value,
  providers,
  subscriptionModels,
  onChange,
}: ModelChooserProps) {
  const provider = providerById(value.provider);
  const models = providers.find((row) => row.id === value.provider)?.models ?? [];
  const typed = !!provider && customModelAllowed(provider);
  const chatgpt = value.provider === CHATGPT;
  const items = modelItems(role, provider, value.provider, models, subscriptionModels, value.model);
  const chosen = models.find((model) => model.id === value.model);
  const modelNote =
    chosen && isOpenRouterRouterId(value.provider, chosen.id)
      ? "Choose a specific model. A router can't set aside a known price."
      : chosen?.note;
  const empty = chatgpt
    ? "Sign in and check the account to load its models."
    : "No models in the list yet. Refresh the model list.";
  const idProblem = value.model ? modelIdProblem(value.model) : null;
  return (
    <>
      <Field label="Provider" description={providerNote(value.provider)}>
        <Combobox
          value={value.provider}
          groups={providerGroups(role, value.provider)}
          placeholder="Choose a provider"
          searchPlaceholder="Search providers"
          onValueChange={(id) => onChange({ provider: id, model: "" })}
        />
      </Field>
      {(chatgpt || (provider && !provider.notOffered)) &&
        (typed && !models.length ? (
          <Field
            label="Model ID"
            description="As the server names it."
            error={idProblem ?? undefined}
          >
            <TextField
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
            description={modelNote}
            {...(typed ? { error: idProblem ?? undefined } : {})}
            disabledReason={items.length || typed ? undefined : empty}
          >
            <Combobox
              value={value.model}
              items={items}
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
