import { z as schema } from "zod";

// What a task asks of its user, most urgent first: dot needs you (an approval, a question or a
// takeover), then a task that is blocked or failed, then a finished task the user has not seen
// yet, then work in progress. A surface that sums up several tasks (the tab title, the favicon, a
// notification) shows the most urgent.
export const ATTENTION_ORDER = ["needs_you", "blocked", "done", "working"] as const;
export const Attention = schema.enum(ATTENTION_ORDER);
export type Attention = schema.infer<typeof Attention>;

export function mostUrgent(levels: Iterable<Attention | null>): Attention | null {
  let top: Attention | null = null;
  for (const level of levels)
    if (
      level !== null &&
      (top === null || ATTENTION_ORDER.indexOf(level) < ATTENTION_ORDER.indexOf(top))
    )
      top = level;
  return top;
}
