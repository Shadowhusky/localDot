import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

export const RECENT_TASKS = 5;
export const RecentOutcome = z.enum(["done", "stopped", "error", "interrupted", "running"]);
export type RecentOutcome = z.infer<typeof RecentOutcome>;
// A recent task as the user typed it, how it ended and the day it started; nothing dot read.
export const RecentLine = z.strictObject({
  title: z.string().min(1).max(200),
  outcome: RecentOutcome,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type RecentLine = z.infer<typeof RecentLine>;
export const RecentTask = RecentLine.extend({ sessionId: z.string().regex(ULID_PATTERN) });
export type RecentTask = z.infer<typeof RecentTask>;
export const RecentActivityReply = z.strictObject({
  enabled: z.boolean(),
  tasks: z.array(RecentTask).max(RECENT_TASKS),
});
export type RecentActivityReply = z.infer<typeof RecentActivityReply>;
