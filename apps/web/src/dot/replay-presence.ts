import { useSyncExternalStore } from "react";
import type { DotFeed } from "./dot-feed.ts";

// What dot does in Replay: the recording's own states and lines at the playhead, or the chosen
// recording's last line in the library. Replay writes it; the one live dot reads it.
export interface ReplayPresence {
  feed: DotFeed;
  line: string;
}

let current: ReplayPresence | null = null;
const listeners = new Set<() => void>();

export function setReplayPresence(next: ReplayPresence | null): void {
  if (
    next === current ||
    (next &&
      current &&
      next.line === current.line &&
      JSON.stringify(next.feed) === JSON.stringify(current.feed))
  )
    return;
  current = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const read = () => current;

export function useReplayPresence(): ReplayPresence | null {
  return useSyncExternalStore(subscribe, read, read);
}
