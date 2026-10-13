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
  })
  .refine(
    (value) => value.reasoningEffort === undefined || value.thinkingBudget === undefined,
    "Choose effort or a thinking budget, not both",
  );
export type ModelOptions = z.infer<typeof ModelOptions>;
