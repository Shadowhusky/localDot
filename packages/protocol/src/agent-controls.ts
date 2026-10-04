import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

const Id = z.string().regex(ULID_PATTERN);
// Bound ordinary text to the existing redactor's UTF-16 limits. Manual text has its own
// Unicode code-point bound and never enters question or hand-back events.
const Text = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((text) => text.length <= limit && text.isWellFormed() && !text.includes("\0"));
export const QuestionAnswerRequest = z
  .strictObject({
    askId: Id,
    option: z
      .string()
      .regex(/^[A-F]$/)
      .optional(),
    text: Text(2000)
      .refine((text) => text.trim().length > 0)
      .optional(),
  })
  .refine((answer) => answer.option !== undefined || answer.text !== undefined);
export type QuestionAnswerRequest = z.infer<typeof QuestionAnswerRequest>;
export const HandbackRequest = z.strictObject({ requestId: Id, note: Text(1000).optional() });
export type HandbackRequest = z.infer<typeof HandbackRequest>;
export const StopOutcome = z.strictObject({
  revoked: z.boolean(),
  paused: z.boolean(),
  closed: z.boolean(),
  stopped: z.boolean(),
  errors: z
    .array(
      z.enum([
        "keyd: could not confirm completion",
        "pause: could not confirm completion",
        "keyd close: could not confirm completion",
        "stop: could not confirm completion",
      ]),
    )
    .max(4),
});
export type StopOutcome = z.infer<typeof StopOutcome>;
