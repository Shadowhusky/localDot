import { useSyncExternalStore } from "react";

// Whether the user is talking to dot right now, for dot's listening pose and the band's line. Only
// the start and the end of a turn change it, so nothing else redraws while the user talks.
let listening = false;
const listeners = new Set<() => void>();

export function setListening(on: boolean) {
  if (listening === on) return;
  listening = on;
  for (const listener of listeners) listener();
}

export function onListening(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const isListening = () => listening;

export const useListening = () => useSyncExternalStore(onListening, isListening);
