import { type TaskModelRef, TaskModelReply } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import type { RoleChoice } from "./choices.ts";

const NEXT_TASK = "localdot.next-task-model";

function savedNext(): RoleChoice | undefined {
  try {
    const text = window.localStorage.getItem(NEXT_TASK);
    return text
      ? (TaskModelReply.parse({ choice: JSON.parse(text) }).choice ?? undefined)
      : undefined;
  } catch {
    return undefined;
  }
}
function saveNext(choice: RoleChoice | undefined): void {
  try {
    if (choice) window.localStorage.setItem(NEXT_TASK, JSON.stringify(choice));
    else window.localStorage.removeItem(NEXT_TASK);
  } catch {
    /* It lasts until the page does. */
  }
}

export interface TaskModel {
  // The model this task runs on from its next message, when one was chosen for it.
  readonly choice?: RoleChoice;
  // What each message carries: nothing until the task's own choice is known.
  readonly ref?: TaskModelRef;
  choose(choice: RoleChoice): Promise<boolean>;
}

const refOf = ({ provider, model, key, options }: RoleChoice): TaskModelRef => ({
  provider,
  model,
  ...(key ? { key } : {}),
  ...(options ? { options } : {}),
});

// Settings holds the default for new tasks; a task's own model is its own, kept with the task. Before
// a conversation has a task, the choice waits here for its first message.
export function useTaskModel(api: ApiClient, taskId: string | null): TaskModel {
  const [read, setRead] = useState<{ taskId: string | null; choice?: RoleChoice } | null>(() =>
    taskId ? null : { taskId: null, choice: savedNext() },
  );
  const asked = useRef(0);
  useEffect(() => {
    const ask = ++asked.current;
    if (!taskId) {
      setRead({ taskId: null, choice: savedNext() });
      return;
    }
    // A first message's choice is the task's now.
    saveNext(undefined);
    setRead((was) => (was?.taskId === taskId ? was : null));
    const controller = new AbortController();
    void api
      .get(`/api/agent/sessions/${taskId}/model`, { signal: controller.signal })
      .then((data) => {
        if (ask !== asked.current) return;
        const { choice } = TaskModelReply.parse(data);
        setRead({ taskId, ...(choice ? { choice } : {}) });
      })
      .catch(() => {
        if (ask === asked.current && !controller.signal.aborted) setRead({ taskId });
      });
    return () => controller.abort();
  }, [api, taskId]);
  const choose = useCallback(
    async (choice: RoleChoice) => {
      const ask = ++asked.current;
      if (!taskId) {
        saveNext(choice);
        setRead({ taskId, choice });
        return true;
      }
      const before = read;
      setRead({ taskId, choice });
      try {
        const reply = TaskModelReply.parse(
          await api.put(`/api/agent/sessions/${taskId}/model`, refOf(choice)),
        );
        if (ask === asked.current && reply.choice) setRead({ taskId, choice: reply.choice });
        return true;
      } catch {
        if (ask === asked.current) setRead(before);
        return false;
      }
    },
    [api, taskId, read],
  );
  const choice = read?.taskId === taskId ? read?.choice : undefined;
  return { ...(choice ? { choice, ref: refOf(choice) } : {}), choose };
}
