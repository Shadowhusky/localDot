import { PROVIDERS, providerById } from "@localdot/providers";
import type { SubscriptionModel } from "./choices.ts";
import { matchingKeys } from "./choices.ts";
import { CHATGPT, CLAUDE_CODE, subscription } from "./chooser.ts";
import type { ProviderIndex } from "./settings-api.ts";

export interface ModelNames {
  // The provider a model call's route belongs to: a plan's own app, a provider, or the provider of
  // the stored key it went through.
  provider(route: string, model: string): string | undefined;
  // What a model reads as: its name in the account or catalog it came from, else its ID.
  name(route: string, model: string): string;
}

// A plan's own app names the model its vendor's catalog lists.
const MAKERS: Record<string, string> = { [CHATGPT]: "openai", [CLAUDE_CODE]: "anthropic" };

export function modelNames(
  index: ProviderIndex | null,
  accounts: { chatgpt: readonly SubscriptionModel[]; claudeCode: readonly SubscriptionModel[] },
): ModelNames {
  const models = (provider: string) =>
    provider === CHATGPT
      ? accounts.chatgpt
      : provider === CLAUDE_CODE
        ? accounts.claudeCode
        : index?.providers.find((row) => row.id === provider)?.models;
  const listed = (provider: string, id: string) =>
    models(provider)?.find((model) => model.id === id)?.name;
  const provider = (route: string, model: string) => {
    if (subscription(route) || providerById(route)) return route;
    const key = index?.keys.find((row) => row.id === route);
    if (!key) return undefined;
    const bound = PROVIDERS.filter(
      (row) => matchingKeys(row, [{ ...key, kind: "llm" }]).length > 0,
    );
    return (
      bound.find((row) => listed(row.id, model)) ?? (bound.length === 1 ? bound[0] : undefined)
    )?.id;
  };
  return {
    provider,
    name(route, model) {
      const from = provider(route, model);
      const maker = from && MAKERS[from];
      return (
        (from && listed(from, model)) ??
        (maker && listed(maker, model)) ??
        index?.providers.flatMap((row) => row.models).find((row) => row.id === model)?.name ??
        model
      );
    },
  };
}
