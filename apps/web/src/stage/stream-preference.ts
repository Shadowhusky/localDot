import type { StreamQuality } from "@localdot/protocol";
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

const names: Record<StreamPreference, string> = { auto: "Auto", sharp: "Sharp", smooth: "Smooth" };
const details: Record<StreamPreference, string> = {
  auto: "Adapts to your connection and device.",
  sharp: "Prioritizes crisp text when the stream slows down.",
  smooth: "Prioritizes fluid motion when the stream slows down.",
};
type Notify = (notice: { id: string; title: string; description: string }) => void;
let pending:
  | {
      value: StreamPreference;
      saved: boolean;
      notify: Notify;
      timer: ReturnType<typeof setTimeout>;
    }
  | undefined;

// Called only after the viewer has adopted the policy and can report on its live transport.
// This confirms the viewer's preference, not an encoder acknowledgement from the server.
export function streamPreferenceAdopted(value: StreamPreference, quality: StreamQuality): void {
  if (!pending || pending.value !== value || value !== streamPreference()) return;
  clearTimeout(pending.timer);
  const { saved, notify } = pending;
  pending = undefined;
  notify({
    id: "stream-preference",
    title: `${names[value]} preference active`,
    description: `${details[value]} Up to ${quality.framerate} fps requested. The picture may look unchanged on a good connection.${saved ? "" : " Not saved in this browser."}`,
  });
}

function switching(value: StreamPreference, saved: boolean, notify: Notify): void {
  clearTimeout(pending?.timer);
  notify({
    id: "stream-preference",
    title: `Switching to ${names[value]}…`,
    description: "Waiting for the live stream to use this preference.",
  });
  const request = {
    value,
    saved,
    notify,
    timer: setTimeout(() => {
      if (pending !== request) return;
      notify({
        id: "stream-preference",
        title: `${names[value]} preference ${saved ? "saved" : "selected"}`,
        description: "Waiting for the live stream. It will apply when connected.",
      });
    }, 3000),
  };
  pending = request;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStreamPreference(notify?: Notify) {
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
      const kept = chooseStreamPreference(next);
      setSaved(kept);
      if (notify) switching(next, kept, notify);
    },
  };
}

export type StreamPreferenceControl = ReturnType<typeof useStreamPreference>;
