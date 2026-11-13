import {
  type ChangeTag,
  CONVERSATION_TAGS,
  type ConversationEntry,
  ConversationList,
  type ConversationLive,
  ConversationLiveEvent,
  ConversationOrganizedEvent,
  ConversationTag,
  ConversationTagsEvent,
  type CreateTag,
  type LookWearables,
  NamedTag,
  type PersonaId,
  SmartTagLine,
  type SmartTagOptions,
  type SmartTagRequest,
  type SmartTagResult,
  type TagId,
  type TagOnConversation,
  taskOutfit,
  type Wearable,
} from "@localdot/protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { t, tr } from "../i18n/index.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";
import type { SessionStatus } from "../ui/SessionGlyph.tsx";

export type ConversationStatus = SessionStatus;

// How often a list on show reads the conversations again besides what /api/events pushes.
const CONVERSATIONS_POLL_MS = 30_000;

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  working: tr("Working"),
  waiting: tr("Waiting for the computer"),
  "needs-you": tr("Needs you"),
  idle: tr("Idle"),
  paused: tr("Paused"),
  done: tr("Done"),
  stopped: tr("Stopped"),
  failed: tr("Failed"),
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
  return entry.title?.trim() || entry.said?.trim() || t`Untitled conversation`;
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

// How soon a conversation under way wants the user: one asking for them first, then those at work.
const URGENCY: Record<ConversationStatus, number> = {
  "needs-you": 0,
  working: 1,
  waiting: 2,
  idle: 3,
  paused: 4,
  done: 5,
  stopped: 5,
  failed: 5,
};

// The conversations under way, most urgent first, each kind newest first as the daemon lists them.
export function liveConversations(rows: readonly ConversationRow[]): ConversationRow[] {
  return rows
    .filter((row) => row.active)
    .map((row, at) => ({ row, at }))
    .sort((a, b) => URGENCY[a.row.status] - URGENCY[b.row.status] || a.at - b.at)
    .map(({ row }) => row);
}

// All of them, most urgent first, each kind newest first as the daemon lists them.
export function mostUrgent(rows: readonly ConversationRow[]): ConversationRow[] {
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => URGENCY[a.row.status] - URGENCY[b.row.status] || a.at - b.at)
    .map(({ row }) => row);
}

// A tag ready to show, by its id: a colour, or one of the user's named tags; none once it is gone.
export function tagOf(id: TagId, library: readonly NamedTag[]): TagOnConversation | undefined {
  const colour = ConversationTag.safeParse(id);
  if (colour.success) return { id, color: colour.data };
  const named = library.find((tag) => tag.id === id);
  return named && { id, color: named.color, name: named.name };
}

export type TagInUse = TagOnConversation & { count: number };

// The tags given to any of `rows`, each with how many carry it: the most carried first, then the
// colours in the order the swatches show them, then the user's own by name.
export function tagsInUse(rows: readonly ConversationRow[]): TagInUse[] {
  const used = new Map<string, TagInUse>();
  for (const row of rows)
    for (const tag of row.entry.tags ?? [])
      used.set(tag.id, { ...tag, count: (used.get(tag.id)?.count ?? 0) + 1 });
  const rank = (tag: TagInUse) => {
    const colour = (CONVERSATION_TAGS as readonly string[]).indexOf(tag.id);
    return colour < 0 ? CONVERSATION_TAGS.length : colour;
  };
  return [...used.values()].sort(
    (a, b) => b.count - a.count || rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

// Whether it carries the tag.
export const carries = (entry: ConversationEntry, id: TagId) =>
  !!entry.tags?.some((tag) => tag.id === id);

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
    if (minutes < 1) return t`Now`;
    if (minutes < 60) return t`${minutes} min`;
    return t`${Math.floor(minutes / 60)} h`;
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

// How a conversation looks wherever it is drawn: what the user dressed it in, else its first task's
// draw for the dot it works as now, or as `persona` for a line that names another.
export function conversationLook(
  entry: ConversationEntry,
  persona: PersonaId | undefined = entry.live?.persona ?? entry.persona,
): readonly Wearable[] {
  return entry.look ?? taskOutfit(drawSeed(entry), persona);
}

export const lookSeed = (entry: ConversationEntry) =>
  entry.firstTask ?? entry.sessions.at(-1) ?? entry.sessionId;

// A conversation whose draw matches an older one's look draws again, so no two in the list look
// alike while the outfits allow it. Oldest first by their first task's id (a ULID), so a look never
// changes as newer conversations arrive, and every device draws the same.
const redrawn = new Map<string, string>();
const REDRAWS = 12;
const drawSeed = (entry: ConversationEntry) => redrawn.get(lookSeed(entry)) ?? lookSeed(entry);

export function spreadLooks(entries: readonly ConversationEntry[]): void {
  redrawn.clear();
  const taken = new Set<string>();
  const oldestFirst = [...entries].sort((a, b) =>
    lookSeed(a) < lookSeed(b) ? -1 : lookSeed(a) > lookSeed(b) ? 1 : 0,
  );
  for (const entry of oldestFirst) {
    if (entry.look) {
      taken.add(entry.look.join(" "));
      continue;
    }
    const seed = lookSeed(entry);
    const persona = entry.live?.persona ?? entry.persona;
    let drawn = seed;
    let worn = taskOutfit(drawn, persona).join(" ");
    for (let n = 1; n <= REDRAWS && taken.has(worn); n++) {
      drawn = `${seed}#${n}`;
      worn = taskOutfit(drawn, persona).join(" ");
    }
    taken.add(worn);
    if (drawn !== seed) redrawn.set(seed, drawn);
  }
}

// An empty title gives the conversation back its own.
export function renameConversation(
  api: ApiClient,
  sessionId: string,
  title: string | null,
): Promise<void> {
  return api.post(`/api/conversations/${sessionId}/title`, { title: title?.trim() || null });
}

// How the user files a conversation: all the tags it carries, pinned to the top, or archived out of
// the list.
export type Organize =
  | { tags: readonly TagId[] }
  | { pinned: boolean }
  | { archived: boolean }
  | { look: LookWearables | null };

type Filing = Partial<{
  tags: readonly TagOnConversation[];
  pinned: boolean;
  archived: boolean;
  look: LookWearables | null;
}>;

const filingOf = (change: Organize, library: readonly NamedTag[]): Filing =>
  "tags" in change
    ? { tags: change.tags.flatMap((id) => tagOf(id, library) ?? []) }
    : (change as Filing);

// A conversation's one tag: the one chosen, or none when it is chosen again or none is.
export function toggledTag(ids: readonly TagId[], tag: TagId | null): TagId[] {
  return tag === null || ids.includes(tag) ? [] : [tag];
}

export const tagIds = (entry: ConversationEntry | null | undefined): TagId[] =>
  entry?.tags?.map((tag) => tag.id) ?? [];

const organized = (entry: ConversationEntry, change: Filing): ConversationEntry => {
  const { tags, pinned, archived, look, ...rest } = { ...entry, ...change };
  return {
    ...rest,
    ...(tags?.length ? { tags: [...tags] } : {}),
    ...(pinned ? { pinned } : {}),
    ...(archived ? { archived } : {}),
    ...(look ? { look } : {}),
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
  for (const list of lists) list.patch(sessionId, filingOf(change, list.state.tags));
  const route =
    "tags" in change ? "tags" : "pinned" in change ? "pin" : "look" in change ? "look" : "archive";
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

// Shows a change to several at once, in one commit, however the saves that follow are spaced.
export function showOrganized(api: ApiClient, ids: readonly string[], change: Organize): void {
  for (const list of stores.get(api)?.values() ?? [])
    for (const id of ids) list.patch(id, filingOf(change, list.state.tags));
}

// The user's own tags: made, renamed, recoloured or deleted, then every list reads again.
export async function createTag(api: ApiClient, tag: CreateTag): Promise<NamedTag> {
  const made = NamedTag.parse(await api.post("/api/tags", tag));
  readConversationsAgain(api);
  return made;
}

export async function changeTag(api: ApiClient, id: string, change: ChangeTag): Promise<NamedTag> {
  const changed = NamedTag.parse(await api.post(`/api/tags/${id}`, change));
  readConversationsAgain(api);
  return changed;
}

export async function deleteTag(api: ApiClient, id: string): Promise<void> {
  await api.del(`/api/tags/${id}`);
  readConversationsAgain(api);
}

const SmartTagsRead = z.object({
  smart: z.object({
    granularity: z.enum(["broad", "balanced", "detailed"]),
    create: z.boolean(),
    auto: z.boolean(),
  }),
});

// How dot sorts conversations into tags, as last chosen.
export async function readSmartTagOptions(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<SmartTagOptions> {
  return SmartTagsRead.parse(await api.get("/api/tags", signal ? { signal } : {})).smart;
}

export function saveSmartTagOptions(api: ApiClient, options: SmartTagOptions): Promise<void> {
  return api.post("/api/tags/smart", options);
}

// Sorts with the user's model, told how far it has come as each batch is tagged; done once the
// last is answered, however long that takes. A sort that can't start, or stops, throws why.
export async function sortConversations(
  api: ApiClient,
  request: SmartTagRequest,
  onProgress?: (progress: { done: number; total: number }) => void,
): Promise<SmartTagResult> {
  const response = await api.fetch(
    `${api.socketUrl("").replace(/^ws/, "http")}/api/conversations/smart-tags`,
    {
      method: "POST",
      headers: { authorization: api.authorization(), "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (response.status === 401) api.rejectUnauthorized?.();
  if (!response.ok || !response.body)
    throw new ApiError(response.status, (await response.text().catch(() => "")) || "failed");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  let result: SmartTagResult | undefined;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      text += part.value;
      const lines = text.split("\n");
      text = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const said = SmartTagLine.parse(JSON.parse(line));
        if ("progress" in said) onProgress?.(said.progress);
        else if ("result" in said) result = said.result;
        else throw new ApiError(502, said.problem);
      }
    }
  } finally {
    readConversationsAgain(api);
  }
  if (!result) throw new ApiError(502, "no-answer");
  return result;
}

export async function undoSort(api: ApiClient, run: string): Promise<void> {
  await api.post("/api/conversations/smart-tags/undo", { run });
  readConversationsAgain(api);
}

// While conversations are being deleted the lists keep their rows, whatever a read would say, so
// each row stays until it has played out. Returns what lets go, when they read again.
export function holdConversations(api: ApiClient): () => void {
  const held = [...(stores.get(api)?.values() ?? [])].map((list) => list.hold());
  return () => {
    for (const release of held) release();
  };
}

// Conversations the daemon has deleted leave every list at once.
export function dropConversations(api: ApiClient, ids: readonly string[]): void {
  for (const list of stores.get(api)?.values() ?? []) list.drop(ids);
}

// The recent conversations, or those archived.
export type ConversationView = "recent" | "archived";

export interface RecentConversations {
  entries: readonly ConversationEntry[];
  archivedCount: number;
  tags: readonly NamedTag[];
  // Nothing read yet.
  loading: boolean;
  failed: boolean;
  retry(): void;
}

interface ListState {
  entries: readonly ConversationEntry[] | null;
  archivedCount: number;
  // The user's named tags.
  tags: readonly NamedTag[];
  failed: boolean;
}

interface ListStore {
  state: ListState;
  subscribe(onChange: () => void): () => void;
  read(): void;
  // A read, or another once the one under way is in.
  refresh(): void;
  patch(sessionId: string, change: Filing): void;
  // No read touches the rows until the returned function lets go, when the list reads again.
  hold(): () => void;
  drop(ids: readonly string[]): void;
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
  let holds = 0;
  // States pushed while a read is on its way, which the daemon may have answered before them.
  let pushed = new Map<string, ConversationLive | undefined>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | null = null;
  const set = (state: ListState) => {
    if (state.entries !== store.state.entries && state.entries) spreadLooks(state.entries);
    store.state = state;
    for (const listener of listeners) listener();
  };
  const later = () => {
    clearTimeout(timer);
    if (users > 0 && !document.hidden) timer = setTimeout(read, CONVERSATIONS_POLL_MS);
  };
  const read = () => {
    if (holds > 0) {
      outdated = true;
      return;
    }
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
        ({ conversations, archivedCount = 0, tags = [] }) => {
          if (!controller.signal.aborted)
            set({
              entries: conversations.map((entry) =>
                pushed.has(entry.sessionId) ? withLive(entry, pushed.get(entry.sessionId)) : entry,
              ),
              archivedCount,
              tags,
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
  const hold = () => {
    holds++;
    outdated = true;
    reading?.abort();
    reading = null;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--holds === 0) read();
    };
  };
  const drop = (ids: readonly string[]) => {
    const { entries } = store.state;
    if (entries?.some((entry) => ids.includes(entry.sessionId)))
      set({ ...store.state, entries: entries.filter((entry) => !ids.includes(entry.sessionId)) });
  };
  const reorganized = ({ sessionId, tags, pinned, archived, look }: ConversationOrganizedEvent) => {
    const { entry } = held(sessionId);
    // One that comes into the view or leaves it, and the count of those archived, need a read.
    if (entry && !!entry.archived === archived)
      patch(sessionId, { tags, pinned, ...(look === undefined ? {} : { look }) });
    else refresh();
  };
  const start = () => {
    let opened = false;
    // A shared link hears no app events, which name the owner's conversations: it reads its own.
    const socket =
      api.permits?.("GET", "/api/events") === false
        ? null
        : openSocket({
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
                if (ConversationTagsEvent.safeParse(value).success) refresh();
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
      socket?.close();
      document.removeEventListener("visibilitychange", looked);
      window.removeEventListener("focus", looked);
      clearTimeout(timer);
      reading?.abort();
      reading = null;
    };
  };
  const store: ListStore = {
    state: { entries: null, archivedCount: 0, tags: [], failed: false },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read,
    refresh,
    patch,
    hold,
    drop,
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
  const { entries, archivedCount, tags, failed } = useSyncExternalStore(
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
    tags,
    loading: entries === null && !failed,
    failed: failed && entries === null,
    retry: store.read,
  };
}

const NONE: readonly ConversationEntry[] = [];

// A recent conversation as the list last read it, without following the list.
export function knownConversation(
  api: ApiClient,
  sessionId: string,
): ConversationEntry | undefined {
  return stores
    .get(api)
    ?.get("recent")
    ?.state.entries?.find((entry) => entry.sessionId === sessionId);
}
