import { z } from "zod";
import { CONVERSATION_LIST } from "./conversation.ts";
import { ULID_PATTERN } from "./ids.ts";
import { ScreenName } from "./screens.ts";

// The most tasks one read of the overview names: a list's worth.
export const OVERVIEW_TILES = CONVERSATION_LIST;
export const OVERVIEW_NEED_CHARS = 160;
export const OVERVIEW_PLAN_CHARS = 200;

const TaskId = z.string().regex(ULID_PATTERN);

// What a task waits on the user for, in a line: a decision, a question, the computer handed over,
// a connection to allow, or something to fix.
export const OverviewNeed = z.strictObject({
  reason: z.enum(["approval", "question", "takeover", "connection", "fix"]),
  text: z.string().max(OVERVIEW_NEED_CHARS).optional(),
});
export type OverviewNeed = z.infer<typeof OverviewNeed>;

// How far through its plan a task is, and the item it is on.
export const OverviewPlan = z.strictObject({
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  current: z.string().max(OVERVIEW_PLAN_CHARS).optional(),
});
export type OverviewPlan = z.infer<typeof OverviewPlan>;

// One task as the overview shows it, beside what the conversation list already says of it: its
// latest screenshot, the screen it works on, how many steps it has taken, its plan and what it
// needs from the user.
export const OverviewTile = z.strictObject({
  sessionId: TaskId,
  frame: TaskId.optional(),
  screen: ScreenName.optional(),
  steps: z.number().int().nonnegative(),
  plan: OverviewPlan.optional(),
  needs: OverviewNeed.optional(),
});
export type OverviewTile = z.infer<typeof OverviewTile>;

export const OverviewReply = z.strictObject({
  tiles: z.array(OverviewTile).max(OVERVIEW_TILES),
});
export type OverviewReply = z.infer<typeof OverviewReply>;

// `?ids=` names the tasks asked about, comma-separated.
export const OverviewIds = z
  .string()
  .transform((value) => (value ? value.split(",") : []))
  .pipe(z.array(TaskId).max(OVERVIEW_TILES));
