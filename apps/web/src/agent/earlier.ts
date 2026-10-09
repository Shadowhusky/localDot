import { emptyModel, foldEvents } from "@localdot/stage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
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

// Results of an earlier task download that task's files.
function owned(items: readonly ThreadItem[], sessionId: string): ThreadItem[] {
  return items.map((item) =>
    item.kind === "result" && item.result.sessionId !== sessionId
      ? { ...item, result: { ...item.result, sessionId } }
      : item,
  );
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
  );
  const steps = workSteps(timelineRows(stepRows(stage), stage.keyUses), model);
  return owned(withWork(items, steps, false, model.spendCalls), sessionId);
}

export interface EarlierThread {
  // The earlier tasks read in, oldest first, as one thread.
  readonly items: ThreadItem[];
  // Still reading the tasks the thread opens with.
  readonly opening: boolean;
  // The conversation has earlier tasks than these.
  readonly more: boolean;
  readonly reading: boolean;
  // Reads in the next earlier task.
  older(): void;
}

// The conversation's tasks before the one shown, as one thread above it. Once the shown task's own
// history is in (`ready`), earlier tasks are read in, newest first, until the thread has its opening
// rows; then one more each time `older` asks. The shown task's thread carries over as it is when the
// next task takes its place, so nothing above moves.
export function useEarlierThread(
  api: ApiClient | null,
  sessions: readonly string[],
  shown: { sessionId: string | null; items: readonly ThreadItem[] },
  ready = true,
): EarlierThread {
  const threads = useRef(new Map<string, readonly ThreadItem[]>());
  const [version, setVersion] = useState(0);
  const previous = useRef(shown);
  if (previous.current.sessionId !== shown.sessionId) {
    const left = previous.current;
    if (left.sessionId && left.items.length && !threads.current.has(left.sessionId))
      threads.current.set(left.sessionId, owned(left.items, left.sessionId));
  }
  previous.current = shown;
  const all = before(sessions, shown.sessionId);
  // The task shown when the thread opened. Another conversation, known once the daemon lists the
  // task shown now, opens anew.
  const [opener, setOpener] = useState<string | null>(null);
  const elsewhere =
    !!opener &&
    opener !== shown.sessionId &&
    !sessions.includes(opener) &&
    sessions.includes(shown.sessionId ?? "");
  const opened = !!opener && !elsewhere;
  // The oldest task read in, kept by id so a task added at the end moves nothing above. Should it
  // fall out of the conversation's listed tasks, every listed one stays.
  const [oldest, setOldest] = useState<string | null>(null);
  const at = oldest ? all.indexOf(oldest) : -1;
  const start = at >= 0 ? at : opened ? 0 : all.length;
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the tasks to read.
  useEffect(() => {
    if (!api || !missing.length) return;
    const controller = new AbortController();
    void (async () => {
      for (const id of [...missing].reverse()) {
        try {
          threads.current.set(id, await readThread(api, id, controller.signal));
        } catch {
          if (controller.signal.aborted) return;
          // A task that can't be read shows nothing rather than holding the thread back.
          threads.current.set(id, []);
        }
        setVersion((value) => value + 1);
      }
    })();
    return () => controller.abort();
  }, [api, key]);

  const waiting = missing.length > 0;
  useEffect(() => {
    if (!ready || opened || !shown.sessionId || waiting) return;
    if (short && next) setOldest(next);
    else setOpener(shown.sessionId);
  }, [ready, opened, shown.sessionId, waiting, short, next]);

  const older = useCallback(() => {
    if (next && !waiting) setOldest(next);
  }, [next, waiting]);
  return {
    items,
    opening: !!shown.sessionId && !opened,
    more: !!next,
    reading: waiting,
    older,
  };
}
