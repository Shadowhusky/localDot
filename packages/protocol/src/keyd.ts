import { z } from "zod";

// keyd's admin API as the daemon and the UI see it (Part 4a, "Interfaces Part 4b builds on").
// Replies are parsed loosely (unknown fields dropped) so a newer keyd stays readable; what the
// daemon sends is strict, because keyd refuses unknown fields.

export const SECRET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RESERVED_SECRET_IDS: readonly string[] = ["lmstudio", "ollama"];
export const SURROGATE_PATTERN = /^ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/;
export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "mistral",
  "deepseek",
  "groq",
  "openrouter",
  "openai-compatible",
  "azure",
] as const;
export const HTTP_FORMATS = ["bearer", "raw", "basic-user", "basic-password"] as const;

const printable = (max: number) =>
  z.string().max(max).regex(PRINTABLE_ASCII, "printable ASCII only");

export const SecretId = z
  .string()
  .regex(SECRET_ID_PATTERN, "lowercase letters, digits, - and _, starting with a letter or digit")
  .refine((id) => !RESERVED_SECRET_IDS.includes(id), "this name is reserved");

export const LlmBinding = z.strictObject({
  id: SecretId,
  kind: z.literal("llm"),
  provider: z.enum(LLM_PROVIDERS),
  baseURL: printable(2048).optional(),
});

export const HttpBinding = z.strictObject({
  id: SecretId,
  kind: z.literal("http"),
  hosts: z.array(printable(253).min(1)).min(1).max(16),
  header: printable(128).min(1),
  format: z.enum(HTTP_FORMATS),
  methods: z.array(printable(16).min(1)).max(16).optional(),
  paths: z.array(printable(1024).min(1)).max(16).optional(),
});

// What the UI seals a key for, and what the daemon relays unchanged: the AAD is built from it.
export const SecretBinding = z.discriminatedUnion("kind", [LlmBinding, HttpBinding]);
export type SecretBinding = z.infer<typeof SecretBinding>;

const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, "base64url without padding");

// v1: ECDH P-256 ephemeral key (uncompressed, 65 bytes), a 12-byte nonce, AES-256-GCM output of
// an 8-8192 byte value plus its 16-byte tag.
export const Sealed = z.strictObject({
  v: z.literal(1),
  epk: base64url(87, 87),
  nonce: base64url(16, 16),
  ct: base64url(32, 10_944),
});
export type Sealed = z.infer<typeof Sealed>;

export const SealedSecret = z.strictObject({ binding: SecretBinding, sealed: Sealed });
export type SealedSecret = z.infer<typeof SealedSecret>;

export const KeydRecord = z.object({
  id: z.string(),
  kind: z.enum(["llm", "http"]),
  provider: z.string().optional(),
  baseURL: z.string().optional(),
  hosts: z.array(z.string()).nullish(),
  header: z.string().optional(),
  format: z.string().optional(),
  methods: z.array(z.string()).nullish(),
  paths: z.array(z.string()).nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KeydRecord = z.infer<typeof KeydRecord>;

// keyd's hairpin-NAT guard: whether it knows the public address it must deny like the Mac's own.
// "unknown" while neither the router nor STUN has answered (keyd keeps asking), "off"
// when both are turned off. A state this code does not know reads as unknown.
export const HairpinGuard = z.object({
  state: z.enum(["active", "unknown", "off"]).catch("unknown"),
  source: z.string().max(32).optional(),
  addresses: z.number().int().nonnegative(),
  checkedAt: z.string().optional(),
  error: z.string().max(500).optional(),
});
export type HairpinGuard = z.infer<typeof HairpinGuard>;

export const KeydStatus = z.object({
  bootId: z.string().min(1),
  version: z.string(),
  sealKey: base64url(87, 87),
  cells: z.number().int().nonnegative(),
  secrets: z.number().int().nonnegative(),
  limits: z.object({ perTaskUSD: z.number(), perDayUSD: z.number() }),
  day: z.object({ date: z.string(), spentUSD: z.number() }),
  audit: z.object({ ok: z.boolean(), error: z.string().optional() }),
  hairpin: HairpinGuard.nullish(),
});
export type KeydStatus = z.infer<typeof KeydStatus>;

export const KeydOpened = z.object({
  cellId: z.string(),
  port: z.number().int(),
  proxyToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  caCertPem: z.string().startsWith("-----BEGIN CERTIFICATE-----"),
  caPath: z.string(),
  surrogates: z.record(z.string(), z.string().regex(SURROGATE_PATTERN)).nullish(),
});
export type KeydOpened = z.infer<typeof KeydOpened>;

export const KeydCellInfo = z.object({
  cellId: z.string(),
  role: z.string(),
  port: z.number().int(),
  intercepts: z.array(z.string()).nullish(),
  surrogates: z.array(z.object({ secretId: z.string(), surrogateId: z.string() })).nullish(),
  task: z.object({ id: z.string(), limitUSD: z.number(), spentUSD: z.number() }).nullish(),
});
export type KeydCellInfo = z.infer<typeof KeydCellInfo>;

export const KeydSecrets = z.object({ secrets: z.array(KeydRecord).nullish() });
export const KeydRevoked = z.object({ revoked: z.number().int().nonnegative() });
export const KeydMinted = z.object({
  surrogates: z.record(z.string(), z.string().regex(SURROGATE_PATTERN)).nullish(),
});
export const KeydErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// keyd's per-route model list (Part 4a): prices in USD per million tokens, and the maximum output
// keyd bounds every request's cap by.
export const KeydRouteModel = z.object({
  id: z.string().min(1).max(128),
  inputUSDPerMTok: z.number().nonnegative().max(10_000),
  outputUSDPerMTok: z.number().nonnegative().max(10_000),
  cacheReadUSDPerMTok: z.number().nonnegative().max(10_000).optional(),
  cacheWriteUSDPerMTok: z.number().nonnegative().max(10_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(100_000_000).optional(),
});
export type KeydRouteModel = z.infer<typeof KeydRouteModel>;
export const KeydRouteModels = z.object({
  route: z.string(),
  models: z.array(KeydRouteModel).nullish(),
});
export const KeydBudget = z.object({
  perTaskUSD: z.number(),
  perDayUSD: z.number(),
  day: z.object({ date: z.string(), spentUSD: z.number() }),
});
export type KeydBudget = z.infer<typeof KeydBudget>;

export const KeyUseData = z.object({
  secretId: z.string(),
  host: z.string(),
  method: z.string(),
  path: z.string(),
  decision: z.enum(["allow", "deny", "ask"]),
});

export const BudgetData = z.object({
  scope: z.enum(["task", "day"]),
  taskId: z.string().optional(),
  limitUSD: z.number(),
  spentUSD: z.number(),
  needUSD: z.number().optional(),
});

export const KeydEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key.use"), cell: z.string(), time: z.string(), data: KeyUseData }),
  z.object({
    type: z.literal("budget.exceeded"),
    cell: z.string(),
    time: z.string(),
    data: BudgetData,
  }),
  z.object({
    type: z.literal("events.dropped"),
    time: z.string(),
    data: z.object({ count: z.number().int().nonnegative() }),
  }),
]);
export type KeydEvent = z.infer<typeof KeydEvent>;

// The environment variable a desktop cell reads a web API key's surrogate from: always prefixed,
// so no secret name can shadow PATH, a proxy variable or anything else the cell relies on.
export function surrogateEnvName(secretId: string): string {
  return `LOCALDOT_KEY_${secretId.toUpperCase().replaceAll("-", "_")}`;
}

// Names that differ only in - and _ share one variable, so one key's stand-in would shadow the
// other's: the key already stored under such a name, if any.
export function surrogateEnvClash(
  secretId: string,
  existing: Iterable<string>,
): string | undefined {
  const name = surrogateEnvName(secretId);
  for (const other of existing) {
    if (other !== secretId && surrogateEnvName(other) === name) return other;
  }
  return undefined;
}
