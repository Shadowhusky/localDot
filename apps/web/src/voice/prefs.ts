import { useSyncExternalStore } from "react";
import { AUTO_LANGUAGE } from "./language.ts";

export const VOICE_KEY = "localdot.voice.v1";

// Settings → Voice, kept in this browser: what the mic and the speaker can use differs per device.
export interface VoicePrefs {
  // "auto" follows the browser's language.
  readonly language: string;
  // The browser's online speech service may hear the user when nothing on the device can.
  readonly online: boolean;
  readonly readAloud: boolean;
}

export const DEFAULT_VOICE: VoicePrefs = {
  language: AUTO_LANGUAGE,
  online: false,
  readAloud: false,
};
const TAG = /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/;

export function readVoicePrefs(): VoicePrefs {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "{}");
    if (!value || typeof value !== "object") return DEFAULT_VOICE;
    const stored = value as Record<string, unknown>;
    return {
      language:
        typeof stored.language === "string" && TAG.test(stored.language)
          ? stored.language
          : DEFAULT_VOICE.language,
      online: stored.online === true,
      readAloud: stored.readAloud === true,
    };
  } catch {
    return DEFAULT_VOICE;
  }
}

// One copy for the page, so the composer hears a change made in Settings at once.
let current: VoicePrefs | null = null;
let saved = true;
const listeners = new Set<() => void>();
const snapshot = () => {
  current ??= readVoicePrefs();
  return current;
};
const notify = () => {
  for (const listener of listeners) listener();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key !== VOICE_KEY && event.key !== null) return;
    current = readVoicePrefs();
    notify();
  };
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}

export function changeVoicePrefs(patch: Partial<VoicePrefs>) {
  current = { ...snapshot(), ...patch };
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(current));
    saved = true;
  } catch {
    saved = false;
  }
  notify();
}

export function useVoicePrefs() {
  const value = useSyncExternalStore(subscribe, snapshot);
  return { value, saved, change: changeVoicePrefs };
}

export type VoicePrefsControl = ReturnType<typeof useVoicePrefs>;
