import type {
  AgentRoleChoice,
  ModelControls,
  ModelOptions,
  PremiumSpeed,
} from "@localdot/protocol";
import {
  type Capability,
  choiceControls,
  type ProviderSpec,
  providerById,
  speedTiers,
  usableAs,
} from "@localdot/providers";
import type { KeyRecord } from "../keys/keys-api.ts";

export type ModelRole = "main" | "fast" | "local";
export type RoleChoice = AgentRoleChoice;
export type PickerKey = Pick<KeyRecord, "id" | "kind" | "provider" | "baseURL">;
export interface SubscriptionModel {
  id: string;
  name: string;
  resolvedModel?: string;
  efforts?: readonly import("@localdot/protocol").ReasoningEffort[];
  // The premium speeds the account offers the model; unsaid when the account doesn't list them.
  speeds?: readonly PremiumSpeed[];
}
export interface PickerModel extends Capability {
  controls?: import("@localdot/protocol").ModelControls;
  controlsCheckedAt?: string;
  id: string;
  name: string;
  contextTokens: number;
  maxOutputTokens?: number;
  releaseDate?: string;
  inputUSDPerMTok: number;
  outputUSDPerMTok: number;
}
export interface ProviderModels {
  id: string;
  models: readonly PickerModel[];
}
export type ProviderGroup =
  | "API providers"
  | "Compatible providers"
  | "Plans"
  | "Local servers"
  | "Not available here"
  | "Later releases";
export function groupOf(provider: ProviderSpec): ProviderGroup {
  if (provider.availableIn) return "Later releases";
  if (provider.notOffered) return "Not available here";
  if (provider.local) return "Local servers";
  if (provider.plan) return "Plans";
  return provider.client === "openai-compatible" || provider.custom
    ? "Compatible providers"
    : "API providers";
}
export const PROVIDER_GROUPS: readonly ProviderGroup[] = [
  "API providers",
  "Compatible providers",
  "Plans",
  "Local servers",
  "Not available here",
  "Later releases",
];
// What people read for a provider: the registry's name, or a plan's own app.
export function providerName(id: string): string {
  if (id === "chatgpt") return "ChatGPT plan";
  if (id === "claude-code") return "Claude Code";
  return providerById(id)?.name ?? id;
}
export function providerAllowed(role: ModelRole, provider: ProviderSpec): boolean {
  return (
    !provider.availableIn && !provider.notOffered && (role !== "local" || provider.local === true)
  );
}
const planApp = (id: string | undefined) => id === "chatgpt" || id === "claude-code";
// Whether a role's choice works beside the main model, as the daemon decides it. A plan's own app
// runs only that plan's models: beside it a fast model on the same plan works and any other waits,
// kept for when the main model changes back; a plan's model in turn waits beside an API model.
export function roleActive(role: ModelRole, choices: Partial<Record<ModelRole, RoleChoice>>) {
  const choice = choices[role];
  if (!choice) return false;
  const main = choices.main?.provider;
  if (role === "main") return true;
  if (planApp(main)) return role === "fast" && choice.provider === main;
  return !planApp(choice.provider);
}
// A registry plan, or a custom endpoint its user says is on a flat-rate plan.
export function onPlan(choice: RoleChoice | undefined): boolean {
  const provider = providerById(choice?.provider ?? "");
  return !!provider?.plan || (!!provider?.custom && choice?.plan === true);
}
// No role a task runs with is billed per token and at least one runs on a plan.
export function planOnly(choices: Partial<Record<ModelRole, RoleChoice>>): boolean {
  const chosen = (["main", "fast", "local"] as const)
    .filter((role) => roleActive(role, choices))
    .map((role) => choices[role]);
  return (
    chosen.some(onPlan) &&
    chosen.every((choice) => onPlan(choice) || providerById(choice?.provider ?? "")?.local)
  );
}
function endpoint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}
// Metadata only. Compatible presets share a key kind, so their bound endpoint must also match.
export function matchingKeys(
  provider: ProviderSpec,
  keys: readonly PickerKey[],
): readonly PickerKey[] {
  if (provider.local || provider.availableIn || provider.notOffered) return [];
  const bound = endpoint(provider.baseURL);
  return keys.filter(
    (key) =>
      key.kind === "llm" &&
      key.provider === provider.keyd &&
      (!provider.baseURL || (bound !== undefined && endpoint(key.baseURL) === bound)),
  );
}
export function modelAllowed(role: ModelRole, model: PickerModel): boolean {
  return usableAs(role, model);
}
export function customModelAllowed(provider: ProviderSpec): boolean {
  return !provider.availableIn && (provider.local === true || provider.custom === true);
}
export function modelIdProblem(id: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(id)
    ? null
    : "Use a model ID of 1–128 letters, numbers or supported separators.";
}
export const SPEED_NAMES: Readonly<Record<PremiumSpeed, string>> = {
  fast: "Fast",
  ultrafast: "Ultrafast",
};
// The premium speed a choice asks for, if any; Standard and the provider's default are one.
export const premiumSpeed = (options?: ModelOptions): PremiumSpeed | undefined =>
  options?.speed === "fast" || options?.speed === "ultrafast" ? options.speed : undefined;
// What a premium speed costs: its price per token over Standard, or what a plan draws on.
export function speedCost(choice: AgentRoleChoice, speed: PremiumSpeed): string {
  if (choice.provider === "chatgpt") return "Uses more of your plan";
  if (choice.provider === "claude-code") return "Uses usage credits";
  const price = speedTiers(choice.provider, choice.model, choice.speedTiers).find(
    (tier) => tier.speed === speed,
  )?.price;
  return price ? `${price}× the price` : "Costs more";
}
// The controls a choice offers: a plan account's own for its model, else the provider's.
export function controlsOf(
  choice: AgentRoleChoice,
  accountModel?: SubscriptionModel,
  discovered?: ModelControls,
) {
  const base = choiceControls(
    { ...choice, model: accountModel?.resolvedModel ?? choice.model },
    discovered,
  );
  // A ChatGPT plan's speeds come only from its account; Claude Code's when its account says.
  const speeds =
    accountModel?.speeds ??
    (choice.provider === "chatgpt"
      ? []
      : (base.speeds ?? []).filter((speed): speed is PremiumSpeed => speed !== "standard"));
  return { ...base, efforts: accountModel?.efforts ?? base.efforts, speeds };
}
