import { emptyModel, foldEvents } from "@localdot/stage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { readTaskHistory } from "../replay/useReplay.ts";
import { timelineRows } from "../session/key-uses.ts";
import { stepRows } from "../session/session-view.ts";
import { emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import { type ThreadItem, threadItems, withWork, workSteps } from "./thread.ts";

// The thread opens on about this many rows, reading in earlier tasks until it has them; the rest
// come in one task at a time as the reader scrolls up.
export const OPENING_ROWS = 40;

// The conversation's tasks before the one shown, oldest first.
function before(sessions: readonly string[], sessionId: string | null): readonly string[] {
  if (!sessionId) return [];
  const at = sessions.indexOf(sessionId);
  return at < 0 ? sessions : sessions.slice(0, at);
}

// Results of an earlier task download that task's files, its steps unfold what it recorded, and
// the files its messages carried open from its computer.
function owned(items: readonly ThreadItem[], sessionId: string): ThreadItem[] {
  return items.map((item) => {
    const own =
      item.kind === "result" && item.result.sessionId !== sessionId
        ? { ...item, result: { ...item.result, sessionId } }
        : item.kind === "work"
          ? { ...item, sessionId }
          : item.kind === "message" && !item.message.sessionId
            ? { ...item, message: { ...item.message, sessionId } }
            : item;
    // What dot did before any message of the user's goes by the same name in every task.
    return own.key.endsWith("-start") ? { ...own, key: `${own.key}-${sessionId}` } : own;
  });
}

// An ended task's thread, read once from its history.
export async function readThread(
  api: ApiClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<ThreadItem[]> {
  const stage = emptyModel();
  let model = emptyAgentModel();
  await readTaskHistory(api, sessionId, signal, (events) => {
    foldEvents(stage, events);
    for (const event of events) model = projectAgentEvent(model, event);
  });
  const items = threadItems(
    model.messages.values(),
    model.questions.values(),
    model.results,
    model.takeovers.values(),
    model.routineProposals.values(),
    model.origin,
    model.dots,
    model.unapproved.values(),
    model.blockers.values(),
  );
  const steps = workSteps(timelineRows(stepRows(stage), stage.keyUses), model);
  return owned(
    withWork(items, steps, false, model.spendCalls, { usage: model.usageCalls }),
    sessionId,
  );
}

export interface EarlierThread {
  // The earlier tasks read in, oldest first, as one thread.
  readonly items: ThreadItem[];
  // Still reading the tasks the thread opens with.
  readonly opening: boolean;
  // The conversation has earlier tasks than these.
  readonly more: boolean;
  readonly reading: boolean;
  // Names the conversation on show, however its list of tasks changes.
  readonly owner: string;
  // Reads in the next earlier task.
  older(): void;
}

interface Shown {
  sessionId: string | null;
  items: readonly ThreadItem[];
}

const RETRY_MS = 1000;
const RETRY_MOST_MS = 30_000;

// The conversation's tasks before the one shown, as one thread above it. Once the shown task's own
// history is in (`ready`), earlier tasks are read in, newest first, until the thread has its opening
// rows; then one more each time `older` asks. The shown task's thread carries over as it is when the
// next task takes its place, so nothing above moves, and stays however late the list of tasks learns
// of the new one. It is then read once from its history like any earlier task, as what was on show
// can lack the task's last words, so the thread comes to hold what a fresh load of it holds.
export function useEarlierThread(
  api: ApiClient | null,
  sessions: readonly string[],
  shown: Shown,
  ready = true,
): EarlierThread {
  const threads = useRef(new Map<string, readonly ThreadItem[]>());
  // Tasks whose thread here may not be all of it: kept as they were left, or failed to read.
  const unsure = useRef(new Set<string>());
  const failures = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const [tries, setTries] = useState(0);
  // The conversation is known by the tasks seen in it: a list naming none of them is another one,
  // and nothing at all on show is none.
  const conversation = useRef({ owner: "", tasks: new Set<string>(), carried: [] as string[] });
  const seen = conversation.current;
  const named = shown.sessionId ? [...sessions, shown.sessionId] : sessions;
  const another = sessions.length > 0 && !sessions.some((id) => seen.tasks.has(id));
  if (!named.length || another || !seen.owner)
    conversation.current = { owner: named[0] ?? "", tasks: new Set(named), carried: [] };
  else for (const id of named) seen.tasks.add(id);
  const { owner, carried } = conversation.current;
  const previous = useRef(shown);
  if (previous.current.sessionId !== shown.sessionId) {
    const left = previous.current;
    if (left.sessionId && left.items.length) {
      threads.current.set(left.sessionId, owned(left.items, left.sessionId));
      unsure.current.add(left.sessionId);
    }
    if (
      left.sessionId &&
      shown.sessionId &&
      seen === conversation.current &&
      !carried.includes(left.sessionId)
    )
      carried.push(left.sessionId);
  }
  previous.current = shown;
  const listed = before(sessions, shown.sessionId);
  const all = sessions.includes(shown.sessionId ?? "")
    ? listed
    : [...listed, ...carried.filter((id) => !listed.includes(id) && id !== shown.sessionId)];
  // The task shown when the thread opened.
  const [opener, setOpener] = useState<string | null>(null);
  const opened = !!owner && opener === owner;
  // The oldest task read in, kept by id so a task added at the end moves nothing above. Should it
  // fall out of the conversation's listed tasks, every listed one stays.
  const [oldest, setOldest] = useState<{ owner: string; id: string } | null>(null);
  const reach = oldest?.owner === owner ? oldest.id : null;
  const at =
    reach && !all.includes(reach) ? 0 : all.findIndex((id) => id === reach || carried.includes(id));
  const start = at >= 0 ? at : all.length;
  const earlier = all.slice(start);
  const key = earlier.join(" ");
  const missing = api ? earlier.filter((id) => !threads.current.has(id)) : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the tasks; a read changes the version.
  const items = useMemo(
    () => earlier.flatMap((id) => threads.current.get(id) ?? []),
    [key, version],
  );
  const next = all[start - 1];
  const short = shown.items.length + items.length < OPENING_ROWS;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the tasks to read; another try reads them again.
  useEffect(() => {
    const reads = api
      ? earlier.filter((id) => !threads.current.has(id) || unsure.current.has(id))
      : [];
    if (!api || !reads.length) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      let again = 0;
      for (const id of [...reads].reverse()) {
        try {
          threads.current.set(id, await readThread(api, id, controller.signal));
          unsure.current.delete(id);
          failures.current.delete(id);
        } catch (error) {
          if (controller.signal.aborted) return;
          // A task that can't be read shows nothing rather than holding the thread back, and is
          // read again until it can be, unless it no longer exists.
          if (!threads.current.has(id)) threads.current.set(id, []);
          if (error instanceof ApiError && error.status === 404) unsure.current.delete(id);
          else {
            unsure.current.add(id);
            const count = (failures.current.get(id) ?? 0) + 1;
            failures.current.set(id, count);
            again = Math.max(again, Math.min(RETRY_MOST_MS, RETRY_MS * 2 ** (count - 1)));
          }
        }
        setVersion((value) => value + 1);
      }
      if (again) retry = setTimeout(() => setTries((value) => value + 1), again);
    })();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [api, key, tries]);

  const waiting = missing.length > 0;
  useEffect(() => {
    if (!ready || opened || !shown.sessionId || waiting) return;
    if (short && next) setOldest({ owner, id: next });
    else setOpener(owner);
  }, [ready, opened, shown.sessionId, waiting, short, next, owner]);

  const older = useCallback(() => {
    if (next && !waiting) setOldest({ owner, id: next });
  }, [next, waiting, owner]);
  return {
    items,
    opening: !!shown.sessionId && !opened,
    more: !!next,
    reading: waiting,
    owner,
    older,
  };
}
