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

// The notification ledger's levels: the same order, with failed kept apart from blocked (they rank
// the same) and none for a session that asks nothing.
export const AttentionLevel = schema.enum([
  "needs_you",
  "blocked",
  "failed",
  "done",
  "working",
  "none",
]);
export type AttentionLevel = schema.infer<typeof AttentionLevel>;

export const ATTENTION_RANK: Readonly<Record<AttentionLevel, number>> = Object.freeze({
  needs_you: 4,
  blocked: 3,
  failed: 3,
  done: 2,
  working: 1,
  none: 0,
});

// Sorts the most urgent first.
export function compareAttention(a: AttentionLevel, b: AttentionLevel): number {
  return ATTENTION_RANK[b] - ATTENTION_RANK[a];
}

export function topAttention(levels: Iterable<AttentionLevel>): AttentionLevel {
  let top: AttentionLevel = "none";
  for (const level of levels) if (ATTENTION_RANK[level] > ATTENTION_RANK[top]) top = level;
  return top;
}
