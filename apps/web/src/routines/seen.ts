import { useEffect } from "react";
import type { ApiClient } from "../lib/api.ts";

// Looking at a routine's results tells the daemon someone still wants it (the 14-day absence
// guard). Once an hour per routine is plenty for that.
const AGAIN_AFTER_MS = 3_600_000;
const told = new Map<string, number>();

export function markRoutineSeen(
  seen: (routineId: string) => Promise<unknown>,
  routineId: string,
  now = Date.now(),
): void {
  const last = told.get(routineId);
  if (last !== undefined && now - last < AGAIN_AFTER_MS) return;
  told.set(routineId, now);
  seen(routineId).catch(() => {
    told.delete(routineId);
  });
}

// While a routine's thread is on screen.
export function useRoutineSeen(
  api: ApiClient | null,
  routineId: string | undefined,
  visible: boolean,
): void {
  useEffect(() => {
    if (!api || !routineId || !visible) return;
    const look = () => {
      if (document.visibilityState === "visible")
        markRoutineSeen((id) => api.post<void>(`/api/routines/${id}/seen`), routineId);
    };
    look();
    document.addEventListener("visibilitychange", look);
    return () => document.removeEventListener("visibilitychange", look);
  }, [api, routineId, visible]);
}
