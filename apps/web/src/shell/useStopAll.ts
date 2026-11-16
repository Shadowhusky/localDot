import type { RoutineListReply, StopAllOutcome } from "@localdot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { locale, t } from "../i18n/index.ts";
import type { RoutinesApi } from "../routines/routines-api.ts";
import { showToast } from "../ui/Toast.tsx";
import type { ToastOptions } from "../ui/toasts.ts";

const TOAST = "stop-all";

// What Stop everything did, in plain words.
export function stoppedText(outcome: StopAllOutcome): string {
  const number = (value: number) => value.toLocaleString(locale());
  const tasks = outcome.sessions.length;
  const computers = outcome.cells.length;
  const routines = outcome.routinesPaused;
  const parts = [
    tasks ? (tasks === 1 ? t`1 task stopped` : t`${number(tasks)} tasks stopped`) : "",
    computers
      ? computers === 1
        ? t`1 computer paused`
        : t`${number(computers)} computers paused`
      : "",
    routines ? (routines === 1 ? t`1 routine paused` : t`${number(routines)} routines paused`) : "",
  ].filter(Boolean);
  if (!parts.length) return t`Nothing was running.`;
  const list = parts.reduce((done, part) => t`${done}, ${part}`);
  return t`${list}.`;
}

// Turns back on the routines Stop everything paused, and says how that went.
function continueRoutines(
  api: Pick<RoutinesApi, "resume">,
  toast: (options: ToastOptions) => void,
): ToastOptions["action"] {
  return {
    label: t`Continue routines`,
    onAction: () =>
      void api
        .resume()
        .then(() => toast({ id: TOAST, title: t`Routines are running again` }))
        .catch(() =>
          toast({
            id: TOAST,
            title: t`Routines couldn't be turned back on`,
            tone: "danger",
          }),
        ),
  };
}

// Routines Stop everything paused stay paused through an update or a new page, where its own toast
// is long gone: the first list read here says so once, with the way to continue them.
export function useStoppedRoutinesNotice(
  reply: RoutineListReply | undefined,
  api: Pick<RoutinesApi, "resume">,
  toast: (options: ToastOptions) => void = showToast,
): void {
  const told = useRef(false);
  useEffect(() => {
    if (!reply || told.current) return;
    told.current = true;
    const paused = reply.routines.filter((routine) => routine.pausedReason === "stop_all").length;
    if (!paused) return;
    toast({
      id: TOAST,
      title:
        paused === 1
          ? t`1 routine is still paused`
          : t`${paused.toLocaleString(locale())} routines are still paused`,
      description: t`Stop everything paused them. They run again once you continue them.`,
      action: continueRoutines(api, toast),
    });
  }, [reply, api, toast]);
}

export interface StopAll {
  run(): Promise<void>;
  running: boolean;
}

// One press stops every task, pauses every routine and freezes every computer. Pressing it again
// is harmless: it checks again and reports what is still stopped.
export function useStopAll(
  api: Pick<RoutinesApi, "stopAll" | "resume">,
  toast: (options: ToastOptions) => void = showToast,
): StopAll {
  const [running, setRunning] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const run = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const work = (async () => {
      setRunning(true);
      try {
        const outcome = await api.stopAll();
        if (!outcome.confirmed) throw new Error("unconfirmed");
        toast({
          id: TOAST,
          title: t`Everything stopped`,
          description: stoppedText(outcome),
          ...(outcome.routinesPaused > 0 ? { action: continueRoutines(api, toast) } : {}),
        });
      } catch {
        toast({
          id: TOAST,
          title: t`Couldn't confirm that everything stopped`,
          description: t`Keep an eye on your computer, and check again.`,
          tone: "danger",
          urgency: "assertive",
          action: { label: t`Check again`, onAction: () => void run() },
        });
      } finally {
        setRunning(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = work;
    return work;
  }, [api, toast]);
  return useMemo(() => ({ run, running }), [run, running]);
}
