import {
  type ConversationEntry,
  ConversationList,
  type ConversationLive,
  ConversationLiveEvent,
  ConversationOrganizedEvent,
  type ConversationTag,
} from "@localdot/protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
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
  label: "Results" | "Pinned" | "Active" | "Today" | "Yesterday" | "Earlier";
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

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const daysBetween = (at: Date, now: Date) =>
  Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);

// Those the user pinned first, whatever they are doing, then those under way, then the rest, each
// newest first as the daemon lists them.
export function arrangeConversations(rows: readonly ConversationRow[]): {
  pinned: ConversationRow[];
  active: ConversationRow[];
  rest: ConversationRow[];
} {
  const unpinned = rows.filter((row) => !row.entry.pinned);
  return {
    pinned: rows.filter((row) => row.entry.pinned),
    active: unpinned.filter((row) => row.active),
    rest: unpinned.filter((row) => !row.active),
  };
}

export function groupConversations(
  rows: readonly ConversationRow[],
  now: Date,
): ConversationGroup[] {
  const groups: ConversationGroup[] = [
    { label: "Pinned", rows: [] },
    { label: "Active", rows: [] },
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "Earlier", rows: [] },
  ];
  for (const row of rows) {
    const days = daysBetween(new Date(row.entry.startedAt), now);
    groups[row.entry.pinned ? 0 : row.active ? 1 : days <= 0 ? 2 : days === 1 ? 3 : 4]?.rows.push(
      row,
    );
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

// How the user files a conversation: a colour tag, pinned to the top, or archived out of the list.
export type Organize =
  | { tag: ConversationTag | null }
  | { pinned: boolean }
  | { archived: boolean };

type Filing = Partial<{ tag: ConversationTag | null; pinned: boolean; archived: boolean }>;

const organized = (entry: ConversationEntry, change: Filing): ConversationEntry => {
  const { tag, pinned, archived, ...rest } = { ...entry, ...change };
  return {
    ...rest,
    ...(tag ? { tag } : {}),
    ...(pinned ? { pinned } : {}),
    ...(archived ? { archived } : {}),
  };
};

const withLive = (entry: ConversationEntry, live: ConversationLive | undefined) => {
  const { live: _was, ...rest } = entry;
  return live ? { ...rest, live } : rest;
};

// Shows the change in every list at once, then saves it; whatever the daemon then says, each list
// reads itself again. A refusal is thrown for the caller to say.
export async function organizeConversation(
  api: ApiClient,
  sessionId: string,
  change: Organize,
): Promise<void> {
  const lists = [...(stores.get(api)?.values() ?? [])];
  for (const list of lists) list.patch(sessionId, change);
  const route = "tag" in change ? "tag" : "pinned" in change ? "pin" : "archive";
  try {
    await api.post(`/api/conversations/${sessionId}/${route}`, change);
  } finally {
    for (const list of lists) list.refresh();
  }
}

// After a conversation was deleted.
export function readConversationsAgain(api: ApiClient): void {
  for (const list of stores.get(api)?.values() ?? []) list.refresh();
}

// The recent conversations, or those archived.
export type ConversationView = "recent" | "archived";

export interface RecentConversations {
  entries: readonly ConversationEntry[];
  archivedCount: number;
  // Nothing read yet.
  loading: boolean;
  failed: boolean;
  retry(): void;
}

interface ListState {
  entries: readonly ConversationEntry[] | null;
  archivedCount: number;
  failed: boolean;
}

interface ListStore {
  state: ListState;
  subscribe(onChange: () => void): () => void;
  read(): void;
  // A read, or another once the one under way is in.
  refresh(): void;
  patch(sessionId: string, change: Filing): void;
  // While anyone uses it the list follows the daemon; the returned function lets go.
  use(): () => void;
}

const stores = new WeakMap<ApiClient, Map<ConversationView, ListStore>>();

// One list of each view for each daemon, shared by every list on show, so the rail and the popover
// always agree. While one is on show it follows /api/events, which pushes each conversation's state
// as it changes. It reads the whole list as each list opens, when a change names a conversation it
// does not hold, ends one or moves one in or out of the view, when the socket comes back, when the
// page is looked at again, and every 30 s besides, for a change the socket missed. A read that a
// change outdates is read again.
function listStore(api: ApiClient, view: ConversationView): ListStore {
  const views = stores.get(api) ?? new Map<ConversationView, ListStore>();
  stores.set(api, views);
  const known = views.get(view);
  if (known) return known;
  const path = view === "archived" ? "/api/conversations?archived=1" : "/api/conversations";
  const listeners = new Set<() => void>();
  let users = 0;
  let reading: AbortController | null = null;
  let outdated = false;
  // States pushed while a read is on its way, which the daemon may have answered before them.
  let pushed = new Map<string, ConversationLive | undefined>();
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
    pushed = new Map();
    const controller = new AbortController();
    reading = controller;
    if (store.state.failed) set({ ...store.state, failed: false });
    api
      .get(path, { signal: controller.signal })
      .then((data) => ConversationList.parse(data))
      .then(
        ({ conversations, archivedCount = 0 }) => {
          if (!controller.signal.aborted)
            set({
              entries: conversations.map((entry) =>
                pushed.has(entry.sessionId) ? withLive(entry, pushed.get(entry.sessionId)) : entry,
              ),
              archivedCount,
              failed: false,
            });
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
  const held = (sessionId: string) => {
    const at = store.state.entries?.findIndex((entry) => entry.sessionId === sessionId) ?? -1;
    return { at, entry: store.state.entries?.[at] };
  };
  const change = ({ sessionId, live }: ConversationLiveEvent) => {
    if (reading) pushed.set(sessionId, live);
    const { at, entry } = held(sessionId);
    if (store.state.entries && entry)
      set({
        ...store.state,
        entries: store.state.entries.with(at, withLive(entry, live)),
        failed: false,
      });
    // How it ended, or a conversation the list doesn't hold yet, is only in a fresh read.
    if (!entry || !live) refresh();
  };
  const patch = (sessionId: string, change: Filing) => {
    const { at, entry } = held(sessionId);
    if (store.state.entries && entry)
      set({ ...store.state, entries: store.state.entries.with(at, organized(entry, change)) });
  };
  const reorganized = ({ sessionId, tag, pinned, archived }: ConversationOrganizedEvent) => {
    const { entry } = held(sessionId);
    // One that comes into the view or leaves it, and the count of those archived, need a read.
    if (entry && !!entry.archived === archived) patch(sessionId, { tag, pinned });
    else refresh();
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
          const live = ConversationLiveEvent.safeParse(value);
          if (live.success) change(live.data);
          const filed = ConversationOrganizedEvent.safeParse(value);
          if (filed.success) reorganized(filed.data);
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
    state: { entries: null, archivedCount: 0, failed: false },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read,
    refresh,
    patch,
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
  views.set(view, store);
  return store;
}

// The recent conversations, or those archived, kept current while the list is open. What was read
// before stays on show while it is read again, so the rows never blink; one just archived or
// unarchived leaves at once.
export function useRecentConversations(
  api: ApiClient,
  open: boolean,
  view: ConversationView = "recent",
): RecentConversations {
  const store = listStore(api, view);
  const { entries, archivedCount, failed } = useSyncExternalStore(
    store.subscribe,
    () => store.state,
  );
  useEffect(() => (open ? store.use() : undefined), [store, open]);
  const shown = useMemo(
    () => entries?.filter((entry) => !!entry.archived === (view === "archived")) ?? NONE,
    [entries, view],
  );
  return {
    entries: shown,
    archivedCount,
    loading: entries === null && !failed,
    failed: failed && entries === null,
    retry: store.read,
  };
}

const NONE: readonly ConversationEntry[] = [];
