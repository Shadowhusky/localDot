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
// The user took the computer themselves: the control their input and hand-back name.
export const TakeControlReply = z.strictObject({ requestId: Id });
export type TakeControlReply = z.infer<typeof TakeControlReply>;
export const BudgetRaiseRequest = z.strictObject({
  budgetUSD: z
    .number()
    .positive()
    .max(10_000)
    .refine((usd) => Math.floor(usd * 1e6 + 0.5) >= 1),
});
export type BudgetRaiseRequest = z.infer<typeof BudgetRaiseRequest>;
// Only the frozen public model identity is exposed: no key IDs, routes, prices or credentials.
export const TaskModelSelection = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("chatgpt"),
    model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  }),
  z.strictObject({
    kind: z.literal("api"),
    roles: z
      .array(
        z.strictObject({
          role: z.enum(["main", "fast", "local"]),
          provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
          model: z.string().min(1).max(128),
        }),
      )
      .min(1)
      .max(3)
      .refine(
        (roles) =>
          roles.some((role) => role.role === "main") &&
          new Set(roles.map((role) => role.role)).size === roles.length,
      ),
    // No role is billed per token and at least one runs on a flat-rate plan: no dollar budget applies.
    plan: z.literal(true).optional(),
  }),
]);
export type TaskModelSelection = z.infer<typeof TaskModelSelection>;
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
