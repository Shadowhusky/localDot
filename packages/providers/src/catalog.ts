import { z } from "zod";

// models.dev's api.json, read loosely: every field this code does not use is ignored, and one
// malformed model or provider is skipped, never fatal (the catalog is someone else's data).
const DevModel = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/),
  name: z.string().max(200).optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  release_date: z.string().max(32).optional(),
  modalities: z
    .object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() })
    .optional(),
  cost: z
    .object({
      input: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
      cache_read: z.number().nonnegative().optional(),
      cache_write: z.number().nonnegative().optional(),
      reasoning: z.number().nonnegative().optional(),
    })
    .optional(),
  limit: z
    .object({
      context: z.number().int().nonnegative().optional(),
      output: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
const DevProvider = z.object({
  name: z.string().max(200).optional(),
  models: z.record(z.string(), z.unknown()),
});

// localDot's cache of the catalog: a fixed schema, written by the daemon from models.dev and read
// by the picker and the session runner. Prices are USD per million tokens.
export const CatalogModel = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/),
  name: z.string().max(200),
  vision: z.boolean(),
  toolCall: z.boolean(),
  reasoning: z.boolean(),
  contextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  inputUSDPerMTok: z.number().nonnegative(),
  outputUSDPerMTok: z.number().nonnegative(),
  cacheReadUSDPerMTok: z.number().nonnegative().optional(),
  cacheWriteUSDPerMTok: z.number().nonnegative().optional(),
  reasoningUSDPerMTok: z.number().nonnegative().optional(),
  releaseDate: z.string().max(32).optional(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

export const CATALOG_SOURCE = "https://models.dev/api.json";

export const Catalog = z.object({
  v: z.literal(1),
  source: z.string(),
  fetchedAt: z.string(),
  providers: z.record(
    z.string(),
    z.object({ name: z.string(), models: z.record(z.string(), CatalogModel) }),
  ),
  skipped: z.number().int().nonnegative(),
});
export type Catalog = z.infer<typeof Catalog>;

// Models with no context or output limit get these: keyd needs a maximum output to bound a hold.
const DEFAULT_CONTEXT = 32_768;
const DEFAULT_OUTPUT = 4_096;

export function normalizeCatalog(
  raw: unknown,
  fetchedAt: string,
  source = CATALOG_SOURCE,
): Catalog {
  const providers: Catalog["providers"] = Object.create(null);
  let skipped = 0;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("the catalog is not an object of providers");
  }
  for (const [providerId, value] of Object.entries(raw)) {
    const p = DevProvider.safeParse(value);
    if (!p.success || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId)) {
      skipped += 1;
      continue;
    }
    const models: Record<string, CatalogModel> = Object.create(null);
    for (const [key, m] of Object.entries(p.data.models)) {
      const parsed = DevModel.safeParse(m);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const d = parsed.data;
      const output = d.modalities?.output;
      if (output?.length && !output.includes("text")) {
        skipped += 1;
        continue;
      }
      const input = d.modalities?.input ?? [];
      // One missing price makes the pair unknown. Both-zero triggers explicit pricing
      // before a paid route is selected; an explicitly supplied zero remains valid.
      const priced = d.cost?.input !== undefined && d.cost?.output !== undefined;
      models[key] = {
        id: d.id,
        name: d.name ?? d.id,
        vision: input.includes("image") || (d.attachment === true && input.length === 0),
        toolCall: d.tool_call === true,
        reasoning: d.reasoning === true,
        contextTokens: d.limit?.context || DEFAULT_CONTEXT,
        maxOutputTokens: d.limit?.output || DEFAULT_OUTPUT,
        inputUSDPerMTok: priced ? (d.cost?.input ?? 0) : 0,
        outputUSDPerMTok: priced ? (d.cost?.output ?? 0) : 0,
        ...(d.cost?.cache_read !== undefined ? { cacheReadUSDPerMTok: d.cost.cache_read } : {}),
        ...(d.cost?.cache_write !== undefined ? { cacheWriteUSDPerMTok: d.cost.cache_write } : {}),
        ...(d.cost?.reasoning !== undefined ? { reasoningUSDPerMTok: d.cost.reasoning } : {}),
        ...(d.release_date ? { releaseDate: d.release_date } : {}),
      };
    }
    providers[providerId] = { name: p.data.name ?? providerId, models };
  }
  return { v: 1, source, fetchedAt, providers, skipped };
}

export function findModel(
  catalog: Catalog,
  providerId: string,
  modelId: string,
): CatalogModel | undefined {
  const models = Object.hasOwn(catalog.providers, providerId)
    ? catalog.providers[providerId]?.models
    : undefined;
  if (!models) return undefined;
  return (
    (Object.hasOwn(models, modelId) ? models[modelId] : undefined) ??
    Object.values(models).find((m) => m.id === modelId)
  );
}

// keyd's PUT /v1/llm/routes/{route}/models (Part 4a): a priced model must name its maximum output,
// which bounds every cap keyd writes; prices stay within keyd's $0–$10,000 per million tokens.
export interface KeydRouteModel {
  id: string;
  inputUSDPerMTok: number;
  outputUSDPerMTok: number;
  cacheReadUSDPerMTok?: number;
  cacheWriteUSDPerMTok?: number;
  reasoningUSDPerMTok?: number;
  maxOutputTokens: number;
}

export function keydRouteModel(m: CatalogModel): KeydRouteModel {
  const price = (n: number) => {
    if (!Number.isFinite(n) || n < 0 || n > 10_000)
      throw new RangeError("model price must be between $0 and $10,000 per million tokens");
    return n;
  };
  if (
    !Number.isSafeInteger(m.maxOutputTokens) ||
    m.maxOutputTokens < 1 ||
    m.maxOutputTokens > 100_000_000
  )
    throw new RangeError("model output limit must be an integer between 1 and 100,000,000");
  return {
    id: m.id,
    inputUSDPerMTok: price(m.inputUSDPerMTok),
    outputUSDPerMTok: price(m.outputUSDPerMTok),
    ...(m.cacheReadUSDPerMTok !== undefined
      ? { cacheReadUSDPerMTok: price(m.cacheReadUSDPerMTok) }
      : {}),
    ...(m.cacheWriteUSDPerMTok !== undefined
      ? { cacheWriteUSDPerMTok: price(m.cacheWriteUSDPerMTok) }
      : {}),
    ...(m.reasoningUSDPerMTok !== undefined
      ? { reasoningUSDPerMTok: price(m.reasoningUSDPerMTok) }
      : {}),
    maxOutputTokens: m.maxOutputTokens,
  };
}

// A local server's model (LM Studio, Ollama) is free and often missing from the catalog: the
// picker lets the user name it, with these limits.
export function localModel(
  id: string,
  opts: { vision?: boolean; contextTokens?: number } = {},
): CatalogModel {
  return {
    id,
    name: id,
    vision: opts.vision ?? true,
    toolCall: true,
    reasoning: false,
    contextTokens: opts.contextTokens ?? DEFAULT_CONTEXT,
    maxOutputTokens: DEFAULT_OUTPUT,
    inputUSDPerMTok: 0,
    outputUSDPerMTok: 0,
  };
}
