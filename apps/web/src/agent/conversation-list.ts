import { type ConversationEntry, ConversationList } from "@localdot/protocol";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";

export type ConversationStatus = "running" | "needs-you" | "done" | "failed" | "stopped";

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  running: "Running",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export interface ConversationRow {
  entry: ConversationEntry;
  title: string;
  status: ConversationStatus;
}

export interface ConversationGroup {
  label: "Today" | "Yesterday" | "Earlier";
  rows: ConversationRow[];
}

// What the computer is running, whether that task has finished its turn and waits for a
// follow-up, and which tasks wait on the user, for each row's status.
export interface LiveFacts {
  live: string | null;
  idle?: boolean;
  needsYou: ReadonlySet<string>;
}

// A task with no ending that is not the one running was cut short, which reads as stopped.
export function conversationStatus(entry: ConversationEntry, facts: LiveFacts): ConversationStatus {
  if (facts.needsYou.has(entry.sessionId)) return "needs-you";
  if (entry.ended === null && entry.sessionId === facts.live)
    return facts.idle ? "done" : "running";
  if (entry.ended === "done") return "done";
  if (entry.ended === "error") return "failed";
  return "stopped";
}

export function conversationTitle(entry: Pick<ConversationEntry, "title" | "said">): string {
  return entry.title?.trim() || entry.said?.trim() || "Untitled conversation";
}

// Every word of the search is in the title or the first message, or the search index found the
// words in one of the conversation's tasks.
export function matchesConversation(
  entry: ConversationEntry,
  query: string,
  found: ReadonlySet<string> = new Set(),
): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${entry.title ?? ""} ${entry.said ?? ""}`.toLocaleLowerCase();
  return words.every((word) => text.includes(word)) || entry.sessions.some((id) => found.has(id));
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const daysBetween = (at: Date, now: Date) =>
  Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);

export function groupConversations(
  rows: readonly ConversationRow[],
  now: Date,
): ConversationGroup[] {
  const groups: ConversationGroup[] = [
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "Earlier", rows: [] },
  ];
  for (const row of rows) {
    const days = daysBetween(new Date(row.entry.startedAt), now);
    groups[days <= 0 ? 0 : days === 1 ? 1 : 2]?.rows.push(row);
  }
  return groups.filter((group) => group.rows.length > 0);
}

// How long ago, as short as it can be: minutes and hours today, the time yesterday, then the day.
export function whenLabel(value: string, now: Date): string {
  const at = new Date(value);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  const days = daysBetween(at, now);
  if (days <= 0) {
    if (minutes < 1) return "Now";
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h`;
  }
  if (days === 1)
    return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (days < 7) return at.toLocaleDateString([], { weekday: "short" });
  return at.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function conversationRows(
  entries: readonly ConversationEntry[],
  facts: LiveFacts,
): ConversationRow[] {
  return entries.map((entry) => ({
    entry,
    title: conversationTitle(entry),
    status: conversationStatus(entry, facts),
  }));
}

export interface RecentConversations {
  entries: readonly ConversationEntry[];
  // Nothing read yet.
  loading: boolean;
  failed: boolean;
  retry(): void;
}

// The recent conversations, read each time the list opens. What was read before stays on show
// while it is read again, so the rows never blink.
export function useRecentConversations(api: ApiClient, open: boolean): RecentConversations {
  const [entries, setEntries] = useState<readonly ConversationEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt reads the list again.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api.get("/api/conversations", { signal: controller.signal }).then(
      (data) => {
        if (controller.signal.aborted) return;
        setEntries(ConversationList.parse(data).conversations);
        setFailed(false);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [api, open, attempt]);
  return {
    entries: entries ?? [],
    loading: entries === null && !failed,
    failed: failed && entries === null,
    retry: () => {
      setFailed(false);
      setAttempt((value) => value + 1);
    },
  };
}
