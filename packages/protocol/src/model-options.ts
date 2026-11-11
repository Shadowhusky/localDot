import { z } from "zod";

// Omission always means the provider's default. Never persist an assumed vendor default.
export const ReasoningEffort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  // Codex's level above max, offered only where a ChatGPT plan account lists it.
  "ultra",
  "enabled",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;
// A billing and latency choice, never an effort synonym. Omission is the provider's default.
export const ModelSpeed = z.enum(["standard", "fast", "ultrafast"]);
export type ModelSpeed = z.infer<typeof ModelSpeed>;
export type PremiumSpeed = Exclude<ModelSpeed, "standard">;
export const ModelOptions = z
  .strictObject({
    reasoningEffort: ReasoningEffort.optional(),
    thinkingBudget: z.number().int().min(1024).max(15000).optional(),
    verbosity: z.enum(["low", "medium", "high"]).optional(),
    speed: ModelSpeed.optional(),
  })
  .refine(
    (value) => value.reasoningEffort === undefined || value.thinkingBudget === undefined,
    "Choose effort or a thinking budget, not both",
  );
export type ModelOptions = z.infer<typeof ModelOptions>;

// Only supported wire encodings can cross into a task. Discovery never supplies request keys.
export const ModelControls = z.strictObject({
  efforts: z.array(ReasoningEffort).max(8),
  wire: z
    .enum([
      "binary-effort",
      "effort",
      "anthropic",
      "anthropic-budget",
      "google-level",
      "google-budget",
      "deepseek",
      "thinking",
      "enable-thinking",
      "together",
      "openrouter",
    ])
    .optional(),
  budget: z.boolean().optional(),
  verbosity: z.boolean().optional(),
  speeds: z.array(ModelSpeed).max(3).optional(),
});
export type ModelControls = z.infer<typeof ModelControls>;

// One model under two names on a route: the one chosen ("opus", or a plan's "default") and what the
// provider calls what it served ("claude-opus-5-5"), or a dated snapshot or a context variant of
// the same. A run of steps names its model only where it really changes, so these count as one.
const PLAIN = new Set(["claude", "latest"]);
const words = (model: string) =>
  model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
export function sameRunningModel(
  a: { route: string; model: string },
  b: { route: string; model: string },
): boolean {
  if (a.route !== b.route) return false;
  if (a.model === b.model || a.model === "default" || b.model === "default") return true;
  const [one, other] = [words(a.model), words(b.model)];
  const [short, long] = one.length <= other.length ? [one, other] : [other, one];
  const rest = [...long];
  for (const word of short) {
    const at = rest.indexOf(word);
    if (at < 0) return false;
    rest.splice(at, 1);
  }
  // What the longer name adds says nothing of another model: a version, a date, a context size.
  return short.length > 0 && rest.every((word) => PLAIN.has(word) || /^\d+[km]?$/.test(word));
}
