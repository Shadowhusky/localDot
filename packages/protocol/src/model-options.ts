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
  "enabled",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;
export const ModelOptions = z
  .strictObject({
    reasoningEffort: ReasoningEffort.optional(),
    thinkingBudget: z.number().int().min(1024).max(15000).optional(),
    verbosity: z.enum(["low", "medium", "high"]).optional(),
    speed: z.enum(["standard", "fast"]).optional(),
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
  speeds: z
    .array(z.enum(["standard", "fast"]))
    .max(2)
    .optional(),
});
export type ModelControls = z.infer<typeof ModelControls>;
