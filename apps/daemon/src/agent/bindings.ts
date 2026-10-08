import {
  type ClientKind,
  type KeydRecord,
  type ModelBinding,
  SURROGATE_PATTERN,
  type TaskModelSelection,
  TaskPricing,
} from "@localdot/protocol";
import {
  type Capability,
  type Catalog,
  CatalogModel,
  capabilityOf,
  findModel,
  isOpenRouterRouterId,
  keydRouteModel,
  localModel,
  providerById,
  routeFor,
  usableAs,
} from "@localdot/providers";
import { immutable } from "./private-files.ts";
import { RoleChoice } from "./settings.ts";
export type Role = "main" | "fast" | "local";
export const CHATGPT = "chatgpt";
export class BindingError extends Error {
  constructor(
    readonly role: Role,
    message: string,
  ) {
    super(`${role} model: ${message}`);
    this.name = "BindingError";
  }
}
export const OUTPUT_CAP_TOKENS = 16_000;
export function checkChatgptChoice(role: Role, choice: RoleChoice): void {
  if (role !== "main") throw new BindingError(role, "the ChatGPT plan can only be the main model");
  if (choice.key !== undefined) throw new BindingError(role, "the ChatGPT plan needs no key");
  if (choice.price !== undefined) throw new BindingError(role, "the ChatGPT plan needs no price");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(choice.model))
    throw new BindingError(role, "unknown ChatGPT model");
}
export function unpriced(m: CatalogModel): boolean {
  return m.inputUSDPerMTok === 0 && m.outputUSDPerMTok === 0;
}
export interface ResolvedRole {
  role: Role;
  providerId: string;
  client: ClientKind;
  route: string;
  model: CatalogModel;
  capability: Capability;
  keyId?: string;
  // A plan the provider bills at a flat rate: priced at zero, on a route keyd marks flat.
  flat?: true;
}
function endpoint(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new Error("invalid endpoint");
  return url.href.replace(/\/+$/, "");
}
export function resolveRole(
  role: Role,
  raw: RoleChoice,
  catalog: Catalog | undefined,
  keys: KeydRecord[],
): ResolvedRole {
  const parsed = RoleChoice.safeParse(raw);
  if (!parsed.success) throw new BindingError(role, "invalid model selection or price");
  const choice = parsed.data;
  const provider = providerById(choice.provider);
  if (!provider) throw new BindingError(role, `unknown provider ${choice.provider}`);
  if (role === "local" && !provider.local)
    throw new BindingError(role, "the local role requires LM Studio or Ollama");
  if (provider.availableIn)
    throw new BindingError(
      role,
      `${provider.name} arrives in ${provider.availableIn.toUpperCase()}`,
    );
  if (provider.notOffered) throw new BindingError(role, provider.notOffered);
  let keyId: string | undefined;
  if (!provider.local) {
    const key = keys.find((k) => k.id === choice.key);
    if (!choice.key || !key)
      throw new BindingError(role, `${provider.name} needs a key: add one under Keys`);
    if (key.kind !== "llm" || key.provider !== provider.keyd)
      throw new BindingError(role, `key ${key.id} is not a ${provider.name} key`);
    if (provider.baseURL) {
      let matches = false;
      try {
        matches = !!key.baseURL && endpoint(key.baseURL) === endpoint(provider.baseURL);
      } catch {
        /* Reject malformed metadata. */
      }
      if (!matches)
        throw new BindingError(
          role,
          `key ${key.id} is bound to ${key.baseURL ?? "no endpoint"}, not ${provider.baseURL}`,
        );
    }
    keyId = key.id;
  } else if (choice.key || choice.price)
    throw new BindingError(role, "local routes use no stored key or manual price");
  const route = routeFor(provider, keyId);
  if (!route) throw new BindingError(role, "no route");
  let model =
    provider.id === "openai-compatible"
      ? localModel(choice.model)
      : ((catalog && findModel(catalog, provider.id, choice.model)) ??
        (provider.local ? localModel(choice.model) : undefined));
  if (!model)
    throw new BindingError(
      role,
      `${choice.model} is not in the ${provider.name} catalog; refresh the catalog`,
    );
  model = { ...model };
  if (provider.plan && choice.price)
    throw new BindingError(
      role,
      `${provider.name} takes no manual price; choose its model again in Settings`,
    );
  if (provider.local || provider.plan) {
    model.inputUSDPerMTok = 0;
    model.outputUSDPerMTok = 0;
    delete model.cacheReadUSDPerMTok;
    delete model.cacheWriteUSDPerMTok;
  } else {
    if (isOpenRouterRouterId(provider.id, model.id))
      throw new BindingError(
        role,
        `${model.id} picks a model at that model's price, which keyd cannot hold; pick the model itself`,
      );
    if (unpriced(model)) {
      if (!choice.price)
        throw new BindingError(
          role,
          `${model.name} has no price in the catalog: give its input and output price or pick another model`,
        );
      model = { ...model, ...choice.price };
      // A manual pair supplies no trustworthy cache discount. Omission lets keyd use its normal
      // input-price fallback instead of retaining a discount from an incompletely priced record.
      delete model.cacheReadUSDPerMTok;
      delete model.cacheWriteUSDPerMTok;
    } else if (choice.price)
      throw new BindingError(
        role,
        "this model is already priced by the catalog; remove the manual price",
      );
  }
  try {
    model = CatalogModel.parse(model);
    keydRouteModel(model);
  } catch {
    throw new BindingError(role, "the model has an unsupported price or token limit");
  }
  const capability = capabilityOf(provider, model);
  if (!usableAs(role, capability)) throw new BindingError(role, `${model.name} cannot call tools`);
  return immutable({
    role,
    providerId: provider.id,
    client: provider.client,
    route,
    model,
    capability,
    ...(keyId ? { keyId } : {}),
    ...(provider.plan ? { flat: true as const } : {}),
  });
}
// No role is billed per token and at least one runs on a plan: no dollar budget applies.
export function planOnly(roles: readonly ResolvedRole[]): boolean {
  return (
    roles.some((r) => r.flat) && roles.every((r) => r.flat || providerById(r.providerId)?.local)
  );
}
export function taskSelection(roles: readonly ResolvedRole[]): TaskModelSelection {
  return {
    kind: "api",
    roles: roles.map((r) => ({ role: r.role, provider: r.providerId, model: r.model.id })),
    ...(planOnly(roles) ? { plan: true as const } : {}),
  };
}
export function bindingOf(r: ResolvedRole, surrogates: Record<string, string>): ModelBinding {
  const surrogate = r.keyId && Object.hasOwn(surrogates, r.keyId) ? surrogates[r.keyId] : undefined;
  if (r.keyId && (typeof surrogate !== "string" || !SURROGATE_PATTERN.test(surrogate)))
    throw new BindingError(r.role, "the session has no valid surrogate for its selected key");
  return immutable({
    route: r.route,
    client: r.client,
    model: r.model.id,
    ...(surrogate ? { surrogate } : {}),
    computer: r.capability.computer,
    coords: r.capability.coords,
    vision: r.model.vision,
    reasoning: r.model.reasoning,
    contextTokens: r.model.contextTokens,
    maxOutputTokens: Math.min(r.model.maxOutputTokens, OUTPUT_CAP_TOKENS),
  });
}
// Immutable session account policy, sent with every priced-task initialization/recovery. These
// are real secret-backed/local routes; this never mutates shared route model tables or aliases.
export function pricingOf(roles: readonly ResolvedRole[]): TaskPricing {
  const routes = new Map<string, Map<string, ReturnType<typeof keydRouteModel>>>();
  const flat = new Map<string, boolean>();
  for (const r of roles) {
    if ((flat.get(r.route) ?? !!r.flat) !== !!r.flat)
      throw new BindingError(
        r.role,
        `key ${r.route} is a plan for one model and pay as you go for another`,
      );
    flat.set(r.route, !!r.flat);
    const model = keydRouteModel({
      ...r.model,
      maxOutputTokens: Math.min(r.model.maxOutputTokens, OUTPUT_CAP_TOKENS),
    });
    const models = routes.get(r.route) ?? new Map();
    const previous = models.get(model.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(model))
      throw new BindingError(
        r.role,
        "one task cannot assign conflicting prices to the same route/model",
      );
    models.set(model.id, model);
    routes.set(r.route, models);
  }
  return immutable(
    TaskPricing.parse({
      v: 1,
      routes: [...routes]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([route, models]) => ({
          route,
          ...(flat.get(route) ? { flat: true } : {}),
          models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
        })),
    }),
  );
}
