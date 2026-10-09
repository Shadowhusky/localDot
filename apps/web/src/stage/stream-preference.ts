import { useEffect, useState, useSyncExternalStore } from "react";
import { STREAM_PREFERENCES, type StreamPreference } from "./stream-quality.ts";

export const STREAM_PREFERENCE_KEY = "localdot.stream-quality.v1";

let current: StreamPreference | null = null;
const listeners = new Set<() => void>();

function stored(): StreamPreference {
  try {
    const value = localStorage.getItem(STREAM_PREFERENCE_KEY);
    return STREAM_PREFERENCES.find((each) => each === value) ?? "auto";
  } catch {
    return "auto";
  }
}

function set(next: StreamPreference): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

// This browser's choice for the live view, read by every stream each time it judges its quality.
export function streamPreference(): StreamPreference {
  current ??= stored();
  return current;
}

// Settings → Your computer → Stream quality: applies at once, and is kept for this browser when it
// can be. Returns whether it was kept.
export function chooseStreamPreference(next: StreamPreference): boolean {
  set(next);
  try {
    localStorage.setItem(STREAM_PREFERENCE_KEY, next);
    return true;
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStreamPreference() {
  const value = useSyncExternalStore(subscribe, streamPreference);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === STREAM_PREFERENCE_KEY || event.key === null) set(stored());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return {
    value,
    saved,
    change(next: StreamPreference) {
      setSaved(chooseStreamPreference(next));
    },
  };
}

export type StreamPreferenceControl = ReturnType<typeof useStreamPreference>;
