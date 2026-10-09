import { useEffect, useState } from "react";
import type { PresencePlace } from "./presence-rules.ts";

export const ENTRANCE_HOLD_MS = 600;

// dot's first appearance waits while its place is only a guess, as before anything is known about
// the computer, so it enters where it will sit instead of flying off as it appears. After a short
// hold it enters anyway, and from then on it always goes where it is asked.
export function useEntrance(
  place: PresencePlace | null,
  provisional: boolean,
): PresencePlace | null {
  const [entered, setEntered] = useState(!provisional);
  if (!provisional && !entered) setEntered(true);
  useEffect(() => {
    if (entered) return;
    const timer = setTimeout(() => setEntered(true), ENTRANCE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [entered]);
  return entered ? place : null;
}
