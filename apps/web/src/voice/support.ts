import { useEffect, useState, useSyncExternalStore } from "react";
import type { ApiClient } from "../lib/api.ts";
import { modelLanguage } from "./language.ts";

// What the browser's speech recognition offers: on this device, after a one-time download, only
// through its online service, or nothing.
export type BrowserSpeech = "local" | "download" | "online" | "none";

export interface VoiceSupport {
  readonly browser: BrowserSpeech;
  // The computer's own speech model: every language, English only, or none.
  readonly mac: "all" | "en" | null;
}

// An installed local engine owns capture consistently across clients; otherwise use browser
// on-device recognition, then its online service only when the user has enabled it.
export type VoiceRoute =
  | { readonly kind: "device" | "mac" | "online" }
  | {
      readonly kind: "none";
      readonly why: "checking" | "download" | "online-off" | "unsupported" | "insecure";
    };

export function voiceRoute(
  support: VoiceSupport | null,
  online: boolean,
  language: string,
): VoiceRoute {
  if (globalThis.isSecureContext === false) return { kind: "none", why: "insecure" };
  if (!support) return { kind: "none", why: "checking" };
  if (support.mac === "all" || (support.mac === "en" && modelLanguage(language) === "en"))
    return { kind: "mac" };
  if (support.browser === "local") return { kind: "device" };
  if (online && support.browser !== "none") return { kind: "online" };
  if (support.browser === "download") return { kind: "none", why: "download" };
  return { kind: "none", why: support.browser === "online" ? "online-off" : "unsupported" };
}

export interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  onstart: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
  onaudioend?: (() => void) | null;
  onresult: ((event: { results: ArrayLike<SpeechResultLike> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface LocalOptions {
  langs: string[];
  processLocally: boolean;
}
export interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
  available?(options: LocalOptions): Promise<string>;
  install?(options: LocalOptions): Promise<boolean>;
}

export function speechRecognition(): SpeechRecognitionCtor | undefined {
  const scope = globalThis as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

// Chrome alone serves speech on the device. Other Chromium builds can offer the same method with no
// service behind it, and the browser closes the tab that calls it.
function servesOnDevice(): boolean {
  const agent = navigator as { userAgentData?: { brands?: readonly { brand: string }[] } };
  return !!agent.userAgentData?.brands?.some((entry) => entry.brand === "Google Chrome");
}

export async function browserSpeech(language: string): Promise<BrowserSpeech> {
  const recognition = speechRecognition();
  if (!recognition) return "none";
  if (typeof recognition.available !== "function" || !servesOnDevice()) return "online";
  try {
    const status = await recognition.available({ langs: [language], processLocally: true });
    if (status === "available") return "local";
    return status === "downloadable" || status === "downloading" ? "download" : "online";
  } catch {
    return "online";
  }
}

export async function macSpeech(api: ApiClient): Promise<VoiceSupport["mac"]> {
  try {
    const reply = await api.get<{ onMac?: { available?: boolean; englishOnly?: boolean } }>(
      "/api/voice",
    );
    if (!reply.onMac?.available) return null;
    return reply.onMac.englishOnly ? "en" : "all";
  } catch {
    return null;
  }
}

let checked = new WeakMap<ApiClient, Map<string, Promise<VoiceSupport>>>();
// A download changes what the browser can do: every user of the answer asks again.
let round = 0;
let downloading = false;
const listeners = new Set<() => void>();
const changed = () => {
  round += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function check(api: ApiClient, language: string): Promise<VoiceSupport> {
  let languages = checked.get(api);
  if (!languages) {
    languages = new Map();
    checked.set(api, languages);
  }
  let found = languages.get(language);
  if (!found) {
    found = Promise.all([browserSpeech(language), macSpeech(api)]).then(([browser, mac]) => ({
      browser,
      mac,
    }));
    languages.set(language, found);
  }
  return found;
}

// The browser's one-time download of on-device speech, which needs a press to start.
export async function downloadSpeech(language: string) {
  const recognition = speechRecognition();
  if (!recognition?.install || downloading) return;
  downloading = true;
  changed();
  try {
    await recognition.install({ langs: [language], processLocally: true });
  } catch {
    // Asked again below: the browser says how far it got.
  } finally {
    downloading = false;
    checked = new WeakMap();
    changed();
  }
}

// Recheck after returning to the page: a speech model may have been installed while it was open.
export function useVoiceSupport(api: ApiClient, language: string) {
  const [support, setSupport] = useState<{
    api: ApiClient;
    language: string;
    value: VoiceSupport;
  } | null>(null);
  const asked = useSyncExternalStore(subscribe, () => round);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round asks again
  useEffect(() => {
    let live = true;
    let request = 0;
    const load = () => {
      const own = ++request;
      void check(api, language).then((value) => {
        if (live && own === request) setSupport({ api, language, value });
      });
    };
    const refresh = () => {
      if (document.hidden) return;
      checked.delete(api);
      load();
    };
    load();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [api, language, asked]);
  return {
    support: support?.api === api && support.language === language ? support.value : null,
    downloading,
    download: () => downloadSpeech(language),
  };
}
