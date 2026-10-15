import { isOpenRouterRouterId, PROVIDERS, type ProviderSpec } from "@localdot/providers";
import type { PickerGroup, PickerItem } from "../ui/listbox.ts";
import {
  customModelAllowed,
  groupOf,
  type ModelRole,
  modelAllowed,
  type PickerModel,
  PROVIDER_GROUPS,
  type SubscriptionModel,
} from "./choices.ts";

export const CHATGPT = "chatgpt";
export const CLAUDE_CODE = "claude-code";
// A plan the user signs in to in its own app, which brings its own models and limits.
export const subscription = (id: string | undefined) => id === CHATGPT || id === CLAUDE_CODE;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

export function priceLine(model: PickerModel): string | undefined {
  if (!model.inputUSDPerMTok && !model.outputUSDPerMTok) return undefined;
  return `${usd.format(model.inputUSDPerMTok)} in · ${usd.format(model.outputUSDPerMTok)} out`;
}

function providerItem(provider: ProviderSpec): PickerItem {
  return {
    value: provider.id,
    label: provider.name,
    // A Claude plan search finds Anthropic, where an API key works.
    keywords: provider.id === "anthropic" ? "anthropic claude code api key token" : provider.id,
    description: provider.notOffered
      ? "Not available here"
      : provider.local
        ? "Runs on this Mac"
        : provider.custom
          ? "Your own endpoint"
          : provider.plan
            ? "Uses your plan's limits"
            : undefined,
    disabledReason: provider.availableIn ? "Coming in a later release" : undefined,
  };
}

// The API formats a custom endpoint can speak, each one of the registry's custom providers. Lists
// show a custom endpoint once; its format is a row of its own (ModelChooser).
export const CUSTOM_FORMATS = [
  {
    value: "openai-compatible",
    label: "OpenAI Chat Completions",
    description: "Most servers and proxies",
  },
  {
    value: "openai-responses-compatible",
    label: "OpenAI Responses",
    description: "Needed by GPT-6.1 Sol and newer",
  },
  {
    value: "anthropic-compatible",
    label: "Anthropic Messages",
    description: "Servers that speak Claude's API",
  },
] as const;

export const isCustomFormat = (id: string) => CUSTOM_FORMATS.some((format) => format.value === id);

// Every provider a role can use, grouped as the registry groups them, with one entry for a custom
// endpoint whatever its format. A plan its vendor keeps to their own tools can still be chosen,
// only to read why it can't be used.
export function providerGroups(role: ModelRole, value: string): PickerGroup[] {
  const offered = PROVIDERS.filter(
    (provider) =>
      (role !== "local" || provider.local) &&
      (!isCustomFormat(provider.id) || provider.id === CUSTOM_FORMATS[0].value),
  );
  const groups: PickerGroup[] = [];
  if (value && !subscription(value) && !PROVIDERS.some((provider) => provider.id === value))
    groups.push({
      label: "Chosen before",
      items: [{ value, label: value, disabledReason: "No longer offered" }],
    });
  for (const label of PROVIDER_GROUPS) {
    const items = offered
      .filter((provider) => groupOf(provider) === label)
      .map((provider) =>
        isCustomFormat(provider.id)
          ? {
              value: isCustomFormat(value) ? value : provider.id,
              label: "Custom endpoint",
              keywords: "custom endpoint own server proxy openai compatible responses anthropic",
              description: "Your own server or proxy",
            }
          : providerItem(provider),
      );
    if (label === "Local servers" && role !== "local") groups.push(subscriptions(role));
    if (items.length) groups.push({ label, items });
  }
  return groups;
}

function subscriptions(role: ModelRole): PickerGroup {
  return {
    label: "Subscription",
    items: [
      {
        value: CHATGPT,
        label: "ChatGPT plan",
        keywords: "chatgpt subscription plan",
        description: "Sign in with your account",
        disabledReason: role === "main" ? undefined : "Main model only",
      },
      {
        value: CLAUDE_CODE,
        label: "Claude Code (your plan)",
        keywords: "claude code anthropic subscription plan pro max",
        description: "Uses your own Claude Code",
        disabledReason: role === "main" ? undefined : "Main model only",
      },
    ],
  };
}

function blockedReason(role: ModelRole, providerId: string, model: PickerModel) {
  if (isOpenRouterRouterId(providerId, model.id)) return "Choose a specific model, not a router";
  if (!modelAllowed(role, model)) return "Can't use tools, so it can't do the work";
  return undefined;
}

// The models a role can choose from one provider, with whatever is chosen now kept in the list.
export function modelItems(
  role: ModelRole,
  provider: ProviderSpec | undefined,
  providerId: string,
  models: readonly PickerModel[],
  accountModels: readonly SubscriptionModel[],
  value: string,
): PickerItem[] {
  const items: PickerItem[] = subscription(providerId)
    ? accountModels.map((model) => ({ value: model.id, label: model.name, description: model.id }))
    : models.map((model) => ({
        value: model.id,
        label: model.name,
        keywords: model.id,
        description: [model.id, priceLine(model)].filter(Boolean).join(" · "),
        disabledReason: blockedReason(role, providerId, model),
      }));
  if (value && !items.some((item) => item.value === value)) {
    const typed = !!provider && customModelAllowed(provider);
    items.unshift({
      value,
      label: value,
      ...(typed
        ? { description: "Your model ID" }
        : {
            disabledReason:
              providerId === CHATGPT
                ? "This account no longer offers it"
                : providerId === CLAUDE_CODE
                  ? "Your Claude Code doesn't offer it now"
                  : "Not in the model list now",
          }),
    });
  }
  return items;
}
