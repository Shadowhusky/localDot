import { useEffect, useRef, useState } from "react";
import { showToast } from "../ui/Toast.tsx";
import { markdownToPlain } from "./markdown.ts";
import type { AgentTakeover } from "./model.ts";

export interface HandOffInput {
  sessionId: string | null;
  // The page holds the task's current state.
  fresh: boolean;
  // The computer dot handed over that the user doesn't hold yet.
  offered: AgentTakeover | undefined;
  // The page shows the live computer, with nothing over it.
  shown: boolean;
  canTake: boolean;
  take(): Promise<boolean>;
}

// Every hand-off explains why the task needs the user's help.
export function sayHandedOver(offered: AgentTakeover): void {
  showToast({
    id: "handoff",
    title: "dot handed you the computer",
    ...(offered.note ? { description: markdownToPlain(offered.note) } : {}),
    icon: "hand",
  });
}

// dot handing the computer over puts it in the user's hands at once: a page that shows the computer
// takes it without a press. One out of sight takes it as soon as it is in sight again, and says so.
export function useHandOff(
  { offered, shown, canTake, take }: HandOffInput,
  notify: (offered: AgentTakeover) => void = sayHandedOver,
): void {
  const [, looked] = useState(0);
  useEffect(() => {
    const check = () => looked((n) => n + 1);
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);
  const inSight = !document.hidden && shown;
  const seen = useRef<{ id: string; tried: boolean } | null>(null);
  const id = offered?.requestId;
  if (id && seen.current?.id !== id) seen.current = { id, tried: false };
  const now = useRef({ offered, take, notify });
  now.current = { offered, take, notify };
  useEffect(() => {
    const record = seen.current;
    if (!id || !record || record.id !== id) return;
    // Out of sight, it waits; a take that didn't go through is tried again on the next look.
    if (!inSight) {
      record.tried = false;
      return;
    }
    const handed = now.current.offered;
    if (!canTake || record.tried || !handed) return;
    record.tried = true;
    void now.current.take().then((taken) => {
      if (taken) now.current.notify(handed);
    });
  }, [id, inSight, canTake]);
}
