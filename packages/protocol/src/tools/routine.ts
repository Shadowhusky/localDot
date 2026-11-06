import { z } from "zod";
import { ULID_PATTERN } from "../ids.ts";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Flat, union-free shapes so every provider accepts them; the daemon validates the combination.
// No field can activate, fund or loosen a routine: only the user's Save routine does that.
export const RoutineToolSchedule = z.object({
  every: z.number().int().min(1).max(720).optional(),
  unit: z.enum(["minute", "hour", "day", "week", "month"]),
  times: z.array(time).min(1).max(12).optional(),
  days: z
    .array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]))
    .min(1)
    .max(7)
    .optional(),
  month_days: z.array(z.number().int().min(-1).max(31)).min(1).max(32).optional(),
  from: time.optional(),
  to: time.optional(),
});
export type RoutineToolSchedule = z.infer<typeof RoutineToolSchedule>;
export const RoutineToolInput = z.object({
  op: z.enum(["propose", "list", "pause"]),
  routine_id: z.string().regex(ULID_PATTERN).optional(),
  name: z.string().min(1).max(80).optional(),
  instruction: z.string().min(1).max(8000).optional(),
  schedules: z.array(RoutineToolSchedule).min(1).max(8).optional(),
  start: date.optional(),
  until: date.optional(),
  notify: z.enum(["changes", "always", "needs_me"]).optional(),
  profile: z.enum(["ask_first", "read_only"]).optional(),
});
export type RoutineToolInput = z.infer<typeof RoutineToolInput>;
export const FollowUpAtInput = z.object({
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/),
  note: z.string().min(1).max(500),
});
export type FollowUpAtInput = z.infer<typeof FollowUpAtInput>;
export const ROUTINE_TOOL_DESCRIPTION =
  'Propose a scheduled or recurring task for the user to save (op=propose with name, instruction and schedules), list routines (op=list) or pause one (op=pause with routine_id). Use it when the user asks for something to happen later or regularly, such as every morning or every weekday at 9. Each schedule repeats every N (every, default 1) units: minute (5 or more) or hour, within each day between from and to, optionally only on days; day, week or month, at times (HH:MM, one or several), with days ("mon") for a week and month_days (1-31, -1 for the last day) for a month, counted from start. Give several schedules when one rule cannot say it. start and until are the first and last local dates (YYYY-MM-DD); for something that happens once, set both to that date and use unit day with its time. A proposal never runs until the user presses Save routine on its card.';
export const FOLLOW_UP_TOOL_DESCRIPTION =
  "Come back to this task later: at is the user's local time YYYY-MM-DDTHH:MM within 7 days, note says what to check then. The user approves it.";
