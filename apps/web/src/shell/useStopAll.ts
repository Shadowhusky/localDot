import type { StopAllOutcome } from "@localdot/protocol";
import { useCallback, useMemo, useRef, useState } from "react";
import { count } from "../copy/format.ts";
import type { RoutinesApi } from "../routines/routines-api.ts";
import { showToast } from "../ui/Toast.tsx";
import type { ToastOptions } from "../ui/toasts.ts";

const TOAST = "stop-all";

// What Stop everything did, in plain words.
export function stoppedText(outcome: StopAllOutcome): string {
  const parts = [
    outcome.sessions.length ? count(outcome.sessions.length, "task stopped", "tasks stopped") : "",
    outcome.cells.length ? count(outcome.cells.length, "computer frozen", "computers frozen") : "",
    outcome.routinesPaused
      ? count(outcome.routinesPaused, "routine paused", "routines paused")
      : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "Nothing was running.";
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
          title: "Everything stopped",
          description: stoppedText(outcome),
          ...(outcome.routinesPaused > 0
            ? {
                action: {
                  label: "Continue routines",
                  onAction: () =>
                    void api
                      .resume()
                      .then(() => toast({ id: TOAST, title: "Routines are running again" }))
                      .catch(() =>
                        toast({
                          id: TOAST,
                          title: "Routines couldn't be turned back on",
                          tone: "danger",
                        }),
                      ),
                },
              }
            : {}),
        });
      } catch {
        toast({
          id: TOAST,
          title: "Couldn't confirm that everything stopped",
          description: "Keep an eye on your computer, and check again.",
          tone: "danger",
          urgency: "assertive",
          action: { label: "Check again", onAction: () => void run() },
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
