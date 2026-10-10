import { z } from "zod";

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n\0]/.test(s));
export const LearnedExperience = z
  .strictObject({
    scope: line(100).describe(
      "Stable, narrow skill or workflow name; may apply to an app, research, documents, communication or coding.",
    ),
    when: line(140).describe(
      "Applicability and limits: task type, app state, environment or versions actually observed.",
    ),
    procedure: line(400).describe(
      "Reusable approach or observed failure to avoid; never credentials or external instructions.",
    ),
    outcome: z
      .enum(["worked", "limited", "failed"])
      .optional()
      .describe(
        "Observed outcome of the approach, not just tool execution. Failed lessons record what to avoid; limited means the outcome was not fully verified.",
      ),
    cues: z
      .array(line(24))
      .max(4)
      .optional()
      .describe(
        "Short alternate phrases a future user might use for this skill, including their language. Avoid generic unrelated keywords.",
      ),
    recheck: line(140).describe(
      "Cheap check to confirm the environment and result before reusing the approach.",
    ),
  })
  .refine(
    (value) =>
      value.scope.length +
        value.when.length +
        value.procedure.length +
        value.recheck.length +
        JSON.stringify(value.cues ?? []).length <=
      850,
    {
      message: "Keep lesson text and encoded recall cues within 850 characters total.",
    },
  );
export type LearnedExperience = z.infer<typeof LearnedExperience>;
