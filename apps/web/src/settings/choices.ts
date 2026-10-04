import type { AgentRoleChoice } from "@localdot/protocol";
import { type Capability, PROVIDERS, type ProviderSpec, usableAs } from "@localdot/providers";
import type { KeyRecord } from "../keys/keys-api.ts";

export type ModelRole = "main" | "fast" | "local";
export type RoleChoice = AgentRoleChoice;
export type PickerKey = Pick<KeyRecord, "id" | "kind" | "provider" | "baseURL">;
export interface SubscriptionModel {
  id: string;
  name: string;
}
export interface PickerModel extends Capability {
  id: string;
  name: string;
  contextTokens: number;
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
  | "Local servers"
  | "Later releases";
export function groupOf(provider: ProviderSpec): ProviderGroup {
  if (provider.availableIn) return "Later releases";
  if (provider.local) return "Local servers";
  return provider.client === "openai-compatible" ? "Compatible providers" : "API providers";
}
export const PROVIDER_GROUPS: readonly ProviderGroup[] = [
  "API providers",
  "Compatible providers",
  "Local servers",
  "Later releases",
];
export function providerAllowed(role: ModelRole, provider: ProviderSpec): boolean {
  return !provider.availableIn && (role !== "local" || provider.local === true);
}
export function matchingProviders(search: string): readonly ProviderSpec[] {
  const query = search.trim().toLowerCase();
  return PROVIDERS.filter((provider) =>
    `${provider.name} ${provider.id}`.toLowerCase().includes(query),
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
  if (provider.local || provider.availableIn) return [];
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
  return !provider.availableIn && (provider.local === true || provider.id === "openai-compatible");
}
export function modelIdProblem(id: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(id)
    ? null
    : "Use a model ID of 1–128 letters, numbers or supported separators.";
}
