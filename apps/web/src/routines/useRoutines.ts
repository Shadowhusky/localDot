import type { RoutineAppEvent, RoutineListReply } from "@localdot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { type RoutinesApi, routinesApi, subscribeRoutineEvents } from "./routines-api.ts";

export const CHANGED_ELSEWHERE = "This routine changed on another device. Here's the latest.";
const RELOAD_AFTER_MS = 150;

export interface RoutinesView {
  readonly api: RoutinesApi;
  // Undefined until the first answer.
  readonly reply: RoutineListReply | undefined;
  readonly failed: boolean;
  // What the last change couldn't do, in plain words.
  readonly problem: string | null;
  readonly busy: boolean;
  reload(): void;
  // Runs one change and reads the list again; false when it didn't happen.
  act(work: (api: RoutinesApi) => Promise<unknown>): Promise<boolean>;
  clearProblem(): void;
}

function problemOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409 && /another device/.test(error.message)) return CHANGED_ELSEWHERE;
    if (error.status === 400 || error.status === 409) return error.message;
    if (error.status === 404) return "That routine was deleted.";
    if (error.status === 503) return error.message || "That couldn't be changed right now.";
  }
  return "That didn't go through. Check your connection and try again.";
}

// "live" while the routines are on show: read, then kept current by every device's changes and every
// run. "read" reads them once, for a setting beside them. "off" keeps what was last read.
export type RoutinesDemand = "off" | "read" | "live";

export function useRoutines(
  api: ApiClient,
  demand: RoutinesDemand,
  onEvent?: (event: RoutineAppEvent) => void,
): RoutinesView {
  const client = useMemo(() => routinesApi(api), [api]);
  const [reply, setReply] = useState<RoutineListReply | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heard = useRef(onEvent);
  heard.current = onEvent;

  const load = useCallback(() => {
    const ask = ++asked.current;
    return client
      .list()
      .then((next) => {
        if (ask !== asked.current) return;
        setReply(next);
        setFailed(false);
      })
      .catch(() => {
        if (ask === asked.current) setFailed(true);
      });
  }, [client]);

  const reload = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), RELOAD_AFTER_MS);
  }, [load]);

  useEffect(() => {
    if (demand === "off") return;
    void load();
    if (demand === "read") return;
    const stop = subscribeRoutineEvents(
      api,
      (event) => {
        heard.current?.(event);
        reload();
      },
      // A socket that comes back may have missed changes.
      reload,
    );
    return () => {
      stop();
      clearTimeout(timer.current);
    };
  }, [api, demand, load, reload]);

  const act = useCallback(
    async (work: (routines: RoutinesApi) => Promise<unknown>) => {
      setBusy(true);
      setProblem(null);
      try {
        await work(client);
        return true;
      } catch (error) {
        setProblem(problemOf(error));
        return false;
      } finally {
        setBusy(false);
        await load();
      }
    },
    [client, load],
  );

  const clearProblem = useCallback(() => setProblem(null), []);
  return useMemo(
    () => ({ api: client, reply, failed, problem, busy, reload, act, clearProblem }),
    [client, reply, failed, problem, busy, reload, act, clearProblem],
  );
}
