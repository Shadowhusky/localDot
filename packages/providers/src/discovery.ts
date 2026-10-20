import { ModelControls, ReasoningEffort } from "@localdot/protocol";
import { z } from "zod";
import { type Catalog, CatalogModel } from "./catalog.ts";
import { modelControls } from "./model-options.ts";

const support = z.object({ supported: z.boolean() });
const anthropic = z.object({
  effort: z.object({
    supported: z.boolean(),
    low: support,
    medium: support,
    high: support,
    xhigh: support.nullish(),
    max: support.optional(),
  }),
  thinking: z.object({
    supported: z.boolean(),
    types: z.object({
      adaptive: support,
      enabled: support,
      disabled: support.optional(),
    }),
  }),
});
const row = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/)
    .optional(),
  name: z.string().max(200).optional(),
  display_name: z.string().max(200).optional(),
  capabilities: z.unknown().optional(),
  supported_parameters: z.array(z.string().max(100)).max(128).optional(),
  max_input_tokens: z.number().int().positive().optional().nullable(),
  max_tokens: z.number().int().positive().optional().nullable(),
  inputTokenLimit: z.number().int().positive().optional(),
  outputTokenLimit: z.number().int().positive().optional(),
});
// Parse only documented capability fields. A reasoning boolean is not an effort enum.
// In particular OpenAI/DeepSeek's model list does not disclose effort or speed levels.
export function discoveredControls(
  provider: string,
  id: string,
  raw: unknown,
): ModelControls | undefined {
  const parsed = row.safeParse(raw);
  if (!parsed.success) return;
  const item = parsed.data;
  const base = ModelControls.parse(modelControls(provider, id));
  if (provider === "anthropic") {
    const parsed = anthropic.safeParse(item.capabilities);
    if (!parsed.success) return;
    const c = parsed.data;
    const adaptive = c.thinking.supported && c.thinking.types.adaptive.supported;
    const budget = c.thinking.supported && c.thinking.types.enabled.supported && !adaptive;
    const efforts: import("@localdot/protocol").ReasoningEffort[] = c.effort.supported
      ? (["low", "medium", "high", "xhigh", "max"] as const).filter((e) => c.effort[e]?.supported)
      : [];
    if (budget && c.thinking.types.disabled?.supported) efforts.unshift("none");
    return {
      ...base,
      efforts: ReasoningEffort.array().parse(efforts),
      wire: adaptive ? "anthropic" : budget || efforts.length ? "anthropic-budget" : undefined,
      budget,
      verbosity: false,
    };
  }
  if (provider === "openrouter" && item.supported_parameters) {
    const reasoning =
      item.supported_parameters.includes("reasoning") ||
      item.supported_parameters.includes("reasoning.effort");
    return {
      ...base,
      efforts: reasoning ? base.efforts : [],
      budget: reasoning && !!base.budget,
      verbosity: false,
      speeds: undefined,
      wire: reasoning ? base.wire : undefined,
    };
  }
}

export function applyProviderMetadata(
  catalog: Catalog,
  provider: string,
  raw: unknown,
  checkedAt: string,
): number {
  if (!Object.hasOwn(catalog.providers, provider)) return 0;
  const list = z
    .object({
      data: z.array(z.unknown()).max(10000).optional(),
      models: z.array(z.unknown()).max(10000).optional(),
    })
    .parse(raw);
  const items = list.data ?? list.models;
  if (!items?.length) throw new Error("No models in provider reply");
  const models = catalog.providers[provider]?.models;
  if (!models) return 0;
  let updated = 0;
  for (const raw of items) {
    const parsed = row.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    const id = item.id ?? (provider === "google" ? item.name?.replace(/^models\//, "") : undefined);
    if (!id || !Object.hasOwn(models, id)) continue;
    const old = models[id];
    if (!old) continue;
    const controls = discoveredControls(provider, id, raw);
    const next = CatalogModel.safeParse({
      ...old,
      ...(provider === "anthropic"
        ? {
            name: item.display_name ?? old.name,
            contextTokens: item.max_input_tokens ?? old.contextTokens,
            maxOutputTokens: item.max_tokens ?? old.maxOutputTokens,
          }
        : provider === "google"
          ? {
              contextTokens: item.inputTokenLimit ?? old.contextTokens,
              maxOutputTokens: item.outputTokenLimit ?? old.maxOutputTokens,
            }
          : {}),
      controlsCheckedAt: checkedAt,
      ...(controls ? { controls } : {}),
    });
    if (next.success) {
      models[id] = next.data;
      updated++;
    }
  }
  return updated;
}
