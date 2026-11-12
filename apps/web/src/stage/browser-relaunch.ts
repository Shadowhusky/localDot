import { useSyncExternalStore } from "react";

// The web browser restarting for a sign-in without dot's connection, or back again. The sign-in
// panel that asked for it says so here, and the stage covers the moment the window is gone with what
// is happening, so it doesn't read as the browser vanishing.
let relaunching = false;
const listeners = new Set<() => void>();

export function setBrowserRelaunching(on: boolean): void {
  if (relaunching === on) return;
  relaunching = on;
  for (const listener of listeners) listener();
}

export function useBrowserRelaunching(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => relaunching,
    () => false,
  );
}
