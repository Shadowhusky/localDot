import { emptyModel, foldEvents } from "@localdot/stage";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { readReplayEvents } from "../replay/useReplay.ts";
import { timelineRows } from "../session/key-uses.ts";
import { stepRows } from "../session/session-view.ts";
import { emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import { type ThreadItem, threadItems, withWork, workSteps } from "./thread.ts";

// The earlier tasks the thread shows above the latest one; older ones stay in Replay.
export const EARLIER_SHOWN = 6;

// Results of an earlier task download that task's files.
function owned(items: readonly ThreadItem[], sessionId: string): ThreadItem[] {
  return items.map((item) =>
    item.kind === "result" && item.result.sessionId !== sessionId
      ? { ...item, result: { ...item.result, sessionId } }
      : item,
  );
}

// An ended task's thread, read once from its log.
export async function readThread(
  api: ApiClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<ThreadItem[]> {
  const stage = emptyModel();
  let model = emptyAgentModel();
  await readReplayEvents(api, sessionId, 0, signal, (events) => {
    foldEvents(stage, events);
    for (const event of events) model = projectAgentEvent(model, event);
  });
  const items = threadItems(model.messages.values(), model.questions.values(), model.results);
  const steps = workSteps(timelineRows(stepRows(stage), stage.keyUses), model);
  return owned(withWork(items, steps, false), sessionId);
}

// The conversation's tasks before the one shown, oldest first, as one thread. The shown task's
// thread carries over as it is when the next task takes its place, so nothing above moves.
export function useEarlierThread(
  api: ApiClient | null,
  sessions: readonly string[],
  shown: { sessionId: string | null; items: readonly ThreadItem[] },
): ThreadItem[] {
  const threads = useRef(new Map<string, readonly ThreadItem[]>());
  const [version, setVersion] = useState(0);
  const previous = useRef(shown);
  if (previous.current.sessionId !== shown.sessionId) {
    const left = previous.current;
    if (left.sessionId && left.items.length && !threads.current.has(left.sessionId))
      threads.current.set(left.sessionId, owned(left.items, left.sessionId));
  }
  previous.current = shown;
  const at = shown.sessionId ? sessions.indexOf(shown.sessionId) : -1;
  const earlier = shown.sessionId
    ? (at < 0 ? sessions : sessions.slice(0, at)).slice(-EARLIER_SHOWN)
    : [];
  const key = earlier.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the tasks to read.
  useEffect(() => {
    const missing = earlier.filter((id) => !threads.current.has(id)).reverse();
    if (!api || !missing.length) return;
    const controller = new AbortController();
    void (async () => {
      for (const id of missing) {
        try {
          const items = await readThread(api, id, controller.signal);
          if (controller.signal.aborted) return;
          threads.current.set(id, items);
          setVersion((value) => value + 1);
        } catch {
          if (controller.signal.aborted) return;
        }
      }
    })();
    return () => controller.abort();
  }, [api, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread read in changes the version.
  return useMemo(() => earlier.flatMap((id) => threads.current.get(id) ?? []), [key, version]);
}
