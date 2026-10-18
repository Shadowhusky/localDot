import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { isApple } from "../ui/Kbd.tsx";
import { startHearing } from "./hearing.ts";
import { speechLanguage } from "./language.ts";
import { setListening } from "./listening.ts";
import { IDLE, type VoiceEvent, type VoiceState } from "./machine.ts";
import { useVoicePrefs } from "./prefs.ts";
import { useVoiceSupport, type VoiceRoute, voiceRoute } from "./support.ts";
import { VoiceTurns } from "./turns.ts";

const NOTICE_MS = 4000;

export interface VoiceOptions {
  api: ApiClient;
  owner?: string;
  field(): HTMLTextAreaElement | null;
  changed(input: HTMLTextAreaElement, caret?: number): void;
  // The message can take words now.
  enabled: boolean;
  // The message stays in view while the user talks, so the words can show as they come.
  live: boolean;
}

export interface Voice {
  readonly enabled: boolean;
  readonly state: VoiceState;
  readonly notice: string | null;
  readonly route: VoiceRoute;
  level(): number;
  finish(): Promise<boolean>;
  send(event: VoiceEvent): void;
  dismiss(): void;
}

export const browserLanguages = () =>
  navigator.languages?.length ? navigator.languages : [navigator.language];

// Talking to dot from the composer: the push-to-talk turns, the hold-to-talk shortcut, and the
// listening flag dot and its band react to.
export function useVoice(opts: VoiceOptions): Voice {
  const prefs = useVoicePrefs().value;
  const language = speechLanguage(prefs.language, browserLanguages());
  const { support, downloading, download } = useVoiceSupport(opts.api, language);
  const route = voiceRoute(support, prefs.online, language);
  const [state, setState] = useState<VoiceState>(IDLE);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloadDismissed, setDownloadDismissed] = useState(false);
  const latest = useRef({ opts, route, language, download });
  useLayoutEffect(() => {
    latest.current = { opts, route, language, download };
  });
  const [turns] = useState(
    () =>
      new VoiceTurns({
        field: () => latest.current.opts.field(),
        route: () => latest.current.route,
        hear: (chosen, events, signal) =>
          startHearing(
            chosen,
            { api: latest.current.opts.api, language: latest.current.language, signal },
            events,
          ),
        live: () => latest.current.opts.live,
        changed: (input, caret) => latest.current.opts.changed(input, caret),
        view: (next) => {
          // Interrupt read-aloud BEFORE starting recognition in the same gesture. Cancelling
          // playback in a later effect can take Safari's audio session away from the new mic.
          setListening(next.phase !== "idle");
          setState(next);
        },
        notice: setNotice,
        download: () => void latest.current.download(),
        now: () => performance.now(),
      }),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing conversations cancels the owned recording.
  useLayoutEffect(() => () => turns.dispose(), [turns, opts.api, opts.owner]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const active = state.phase !== "idle";
  useEffect(() => {
    if (!opts.enabled) turns.send({ type: "cancel" });
  }, [opts.enabled, turns]);
  // Escape, or leaving the page, drops what was said.
  useEffect(() => {
    if (!active && !notice && (!downloading || downloadDismissed)) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      turns.send({ type: "cancel" });
      setNotice(null);
      setDownloadDismissed(true);
    };
    const hidden = () => {
      if (document.hidden) turns.send({ type: "cancel" });
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [active, turns, notice, downloading, downloadDismissed]);
  useHoldShortcut(turns, opts.enabled, opts.field);
  return {
    enabled: opts.enabled,
    state,
    notice: downloading && !downloadDismissed ? "Getting speech ready on this device…" : notice,
    route,
    level: () => turns.level(),
    finish: () => turns.finish(),
    send: (event) => {
      if (event.type === "press") setDownloadDismissed(false);
      turns.send(event);
    },
    dismiss: () => {
      turns.send({ type: "cancel" });
      setNotice(null);
      setDownloadDismissed(true);
    },
  };
}

// Option-Space on a Mac, Control-Shift-Space elsewhere: held, it talks like the mic button.
export const HOLD_KEYS = (apple: boolean) => (apple ? ["Alt", " "] : ["Ctrl", "Shift", " "]);

export function holdShortcut(event: KeyboardEvent, apple: boolean): boolean {
  if (event.code !== "Space" || event.metaKey) return false;
  return apple
    ? event.altKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.altKey;
}

const editable = (target: Element | null) =>
  !!target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");

function useHoldShortcut(
  turns: VoiceTurns,
  enabled: boolean,
  field: () => HTMLTextAreaElement | null,
) {
  const own = useRef(field);
  own.current = field;
  useEffect(() => {
    if (!enabled) return;
    const apple = isApple();
    let held = false;
    const release = () => {
      if (!held) return;
      held = false;
      turns.send({ type: "release", at: performance.now() });
    };
    const down = (event: KeyboardEvent) => {
      if (!holdShortcut(event, apple) || event.isComposing) return;
      const focused = document.activeElement;
      // Typing somewhere else on the page keeps its own keys.
      if (editable(focused) && focused !== own.current()) return;
      const input = own.current();
      if (!input || input.closest("[inert], [hidden]") || !input.getClientRects().length) return;
      event.preventDefault();
      if (event.repeat || held) return;
      held = true;
      turns.send({ type: "press", at: performance.now() });
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space" || ["Alt", "Control", "Shift"].includes(event.key)) release();
    };
    document.addEventListener("keydown", down, true);
    document.addEventListener("keyup", up, true);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", release);
      release();
    };
  }, [enabled, turns]);
}
