import {
  type ConversationEntry,
  ConversationList,
  ConversationLiveEvent,
} from "@localdot/protocol";
import { useEffect, useSyncExternalStore } from "react";
import type { ApiClient } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";
import type { SessionStatus } from "../ui/SessionGlyph.tsx";

export type ConversationStatus = SessionStatus;

// How often a list on show reads the conversations again besides what /api/events pushes.
const CONVERSATIONS_POLL_MS = 30_000;

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  working: "Working",
  waiting: "Waiting for the computer",
  "needs-you": "Needs you",
  idle: "Idle",
  paused: "Paused",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

export interface ConversationRow {
  entry: ConversationEntry;
  title: string;
  status: ConversationStatus;
  // Under way: listed above the rest.
  active: boolean;
  // When it took up its status while under way, otherwise when its latest task started.
  since: string;
  // What dot is doing in it now, while it works.
  activity?: string;
}

export interface ConversationGroup {
  label: "Active" | "Today" | "Yesterday" | "Earlier";
  rows: ConversationRow[];
}

// What the computer is running, whether that task has finished its turn and waits for a
// follow-up, what dot is doing in it, and which tasks wait on the user, for each row's status.
export interface LiveFacts {
  live: string | null;
  idle?: boolean;
  activity?: string;
  needsYou: ReadonlySet<string>;
}

const LIVE_STATUS: Record<NonNullable<ConversationEntry["live"]>["state"], ConversationStatus> = {
  working: "working",
  "waiting-for-computer": "waiting",
  "needs-you": "needs-you",
  idle: "idle",
  paused: "paused",
};

// The daemon's word on a conversation under way comes first. Without it, a task with no ending
// that is not the one running was cut short, which reads as stopped.
export function conversationStatus(entry: ConversationEntry, facts: LiveFacts): ConversationStatus {
  if (facts.needsYou.has(entry.sessionId)) return "needs-you";
  if (entry.live) return LIVE_STATUS[entry.live.state];
  if (entry.ended === null && entry.sessionId === facts.live)
    return facts.idle ? "done" : "working";
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

// Conversations under way first, then the rest, each newest first as the daemon lists them.
export function pinActive(rows: readonly ConversationRow[]): ConversationRow[] {
  return [...rows.filter((row) => row.active), ...rows.filter((row) => !row.active)];
}

export function groupConversations(
  rows: readonly ConversationRow[],
  now: Date,
): ConversationGroup[] {
  const groups: ConversationGroup[] = [
    { label: "Active", rows: [] },
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "Earlier", rows: [] },
  ];
  for (const row of rows) {
    const days = daysBetween(new Date(row.entry.startedAt), now);
    groups[row.active ? 0 : days <= 0 ? 1 : days === 1 ? 2 : 3]?.rows.push(row);
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

const UNDER_WAY: ReadonlySet<ConversationStatus> = new Set(["working", "needs-you"]);

export function conversationRows(
  entries: readonly ConversationEntry[],
  facts: LiveFacts,
): ConversationRow[] {
  return entries.map((entry) => {
    const status = conversationStatus(entry, facts);
    const activity =
      status === "working"
        ? (entry.live?.activity ?? (entry.sessionId === facts.live ? facts.activity : undefined))
        : undefined;
    return {
      entry,
      title: conversationTitle(entry),
      status,
      active: !!entry.live || UNDER_WAY.has(status),
      since: entry.live?.since ?? entry.startedAt,
      ...(activity?.trim() ? { activity: activity.trim() } : {}),
    };
  });
}

// An empty title gives the conversation back its own.
export function renameConversation(
  api: ApiClient,
  sessionId: string,
  title: string | null,
): Promise<void> {
  return api.post(`/api/conversations/${sessionId}/title`, { title: title?.trim() || null });
}

export interface RecentConversations {
  entries: readonly ConversationEntry[];
  // Nothing read yet.
  loading: boolean;
  failed: boolean;
  retry(): void;
}

interface ListState {
  entries: readonly ConversationEntry[] | null;
  failed: boolean;
}

interface ListStore {
  state: ListState;
  subscribe(onChange: () => void): () => void;
  read(): void;
  // While anyone uses it the list follows the daemon; the returned function lets go.
  use(): () => void;
}

const stores = new WeakMap<ApiClient, ListStore>();

// One list for each daemon, shared by every list on show, so the rail and the popover always agree.
// While one is on show it follows /api/events, which pushes each conversation's state as it
// changes. It reads the whole list as each list opens, when a change names a conversation it does
// not hold or ends one, when the socket comes back, when the page is looked at again, and every
// 30 s besides, for a change the socket missed. A read that a change outdates is read again.
function listStore(api: ApiClient): ListStore {
  const known = stores.get(api);
  if (known) return known;
  const listeners = new Set<() => void>();
  let users = 0;
  let reading: AbortController | null = null;
  let outdated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | null = null;
  const set = (state: ListState) => {
    store.state = state;
    for (const listener of listeners) listener();
  };
  const later = () => {
    clearTimeout(timer);
    if (users > 0 && !document.hidden) timer = setTimeout(read, CONVERSATIONS_POLL_MS);
  };
  const read = () => {
    reading?.abort();
    outdated = false;
    const controller = new AbortController();
    reading = controller;
    if (store.state.failed) set({ ...store.state, failed: false });
    api
      .get("/api/conversations", { signal: controller.signal })
      .then((data) => ConversationList.parse(data).conversations)
      .then(
        (entries) => {
          if (!controller.signal.aborted) set({ entries, failed: false });
        },
        () => {
          if (!controller.signal.aborted) set({ ...store.state, failed: true });
        },
      )
      .finally(() => {
        if (reading !== controller) return;
        reading = null;
        if (outdated) read();
        else later();
      });
  };
  const refresh = () => {
    if (reading) outdated = true;
    else read();
  };
  const change = ({ sessionId, live }: ConversationLiveEvent) => {
    const entries = store.state.entries;
    const at = entries?.findIndex((entry) => entry.sessionId === sessionId) ?? -1;
    const entry = entries?.[at];
    if (entries && entry) {
      const { live: _was, ...rest } = entry;
      set({ entries: entries.with(at, live ? { ...rest, live } : rest), failed: false });
    }
    // How it ended, or a conversation the list doesn't hold yet, is only in a fresh read.
    if (!entry || !live) refresh();
  };
  const start = () => {
    let opened = false;
    const socket = openSocket({
      url: api.socketUrl("/api/events"),
      protocols: api.socketProtocols(),
      handlers: {
        onOpen: () => {
          if (opened) refresh();
          opened = true;
        },
        onMessage: (data) => {
          let value: unknown;
          try {
            value = JSON.parse(data);
          } catch {
            return;
          }
          const parsed = ConversationLiveEvent.safeParse(value);
          if (parsed.success) change(parsed.data);
        },
      },
    });
    const looked = () => {
      if (document.hidden) clearTimeout(timer);
      else refresh();
    };
    document.addEventListener("visibilitychange", looked);
    window.addEventListener("focus", looked);
    return () => {
      socket.close();
      document.removeEventListener("visibilitychange", looked);
      window.removeEventListener("focus", looked);
      clearTimeout(timer);
      reading?.abort();
      reading = null;
    };
  };
  const store: ListStore = {
    state: { entries: null, failed: false },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read,
    use() {
      if (users++ === 0) stop = start();
      read();
      return () => {
        if (--users > 0) return;
        stop?.();
        stop = null;
      };
    },
  };
  stores.set(api, store);
  return store;
}

// The recent conversations, kept current while the list is open. What was read before stays on
// show while it is read again, so the rows never blink.
export function useRecentConversations(api: ApiClient, open: boolean): RecentConversations {
  const store = listStore(api);
  const { entries, failed } = useSyncExternalStore(store.subscribe, () => store.state);
  useEffect(() => (open ? store.use() : undefined), [store, open]);
  return {
    entries: entries ?? NONE,
    loading: entries === null && !failed,
    failed: failed && entries === null,
    retry: store.read,
  };
}

const NONE: readonly ConversationEntry[] = [];
