import type { ApiClient } from "../lib/api.ts";
import { VoiceError, type VoiceFailure } from "./capture.ts";
import { computerHearing } from "./computer-hearing.ts";
import { speechRecognition, type VoiceRoute } from "./support.ts";

// One turn of listening: the waveform's level, then the words, or nothing kept.
export interface Hearing {
  level(): number;
  finish(): Promise<string>;
  abort(): void;
}

export interface HearingEvents {
  // The words so far, while the user still talks.
  partial(text: string): void;
  // The engine stopped on its own: whatever it heard is ready.
  ended(): void;
  failed(failure: VoiceFailure): void;
}

const FINISH_MS = 4000;

export function startHearing(
  route: Extract<VoiceRoute, { kind: "device" | "mac" | "online" }>,
  opts: { api: ApiClient; language: string; signal?: AbortSignal },
  events: HearingEvents,
): Promise<Hearing> {
  return route.kind === "mac"
    ? computerHearing(opts.api, opts.language, events, opts.signal)
    : browserHearing(opts.language, route.kind === "device", events, opts.signal);
}

export function speechFailure(error: string): VoiceFailure | null {
  switch (error) {
    case "aborted":
      return null;
    case "not-allowed":
      return "denied";
    case "audio-capture":
      return "no-mic";
    case "no-speech":
      return "no-speech";
    case "network":
      return "network";
    case "service-not-allowed":
    case "language-not-supported":
      return "unavailable";
    default:
      return "failed";
  }
}

// A browser can announce "start" and then silently lose its microphone after media playback.
// Retry one fresh recognizer if it never produces words; never leave an empty turn hanging for
// the whole recording limit. See WebKit 321436. No competing getUserMedia capture is opened.
const FIRST_WORD_MS = 12_000;

async function browserHearing(
  language: string,
  local: boolean,
  events: HearingEvents,
  signal?: AbortSignal,
): Promise<Hearing> {
  const Recognition = speechRecognition();
  if (!Recognition) throw new VoiceError("unavailable");
  if (signal?.aborted) throw new VoiceError("failed");
  let recognition: InstanceType<typeof Recognition> | null = null;
  let text = "";
  let begun = false;
  let closed = false;
  let retries = 0;
  let speaking = false;
  let lastSpeech = Number.NEGATIVE_INFINITY;
  let startTimer = 0;
  let wordTimer = 0;
  let finishTimer = 0;
  const opening = Promise.withResolvers<void>();
  let completion: ReturnType<typeof Promise.withResolvers<string>> | null = null;

  const release = () => {
    const old = recognition;
    recognition = null;
    if (!old) return;
    // stop() asks for final words. Once those arrive, explicitly release the service and detach
    // every callback before the next turn or read-aloud can claim the audio session.
    old.onstart = old.onresult = old.onerror = old.onend = null;
    old.onspeechstart = old.onspeechend = old.onaudioend = null;
    try {
      old.abort();
    } catch {
      // Already stopped by the browser.
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    speaking = false;
    window.clearTimeout(startTimer);
    window.clearTimeout(wordTimer);
    window.clearTimeout(finishTimer);
    signal?.removeEventListener("abort", cancel);
    release();
  };
  const cancel = () => {
    close();
    opening.reject(new VoiceError("failed"));
    completion?.resolve("");
  };
  const fail = (failure: VoiceFailure) => {
    if (closed) return;
    close();
    const error = new VoiceError(failure);
    if (!begun) opening.reject(error);
    else if (completion) completion.reject(error);
    else events.failed(failure);
  };
  const end = () => {
    if (closed) return;
    close();
    if (!begun) opening.reject(new VoiceError("no-speech"));
    else if (completion) completion.resolve(text);
    else events.ended();
  };
  const launch = () => {
    let current: InstanceType<typeof Recognition>;
    try {
      current = new Recognition();
    } catch {
      fail("unavailable");
      return;
    }
    recognition = current;
    current.lang = language;
    current.continuous = true;
    current.interimResults = true;
    current.maxAlternatives = 1;
    if (local) current.processLocally = true;
    const owns = () => !closed && recognition === current;
    current.onspeechstart = () => {
      if (owns()) speaking = true;
    };
    current.onspeechend = current.onaudioend = () => {
      if (!owns()) return;
      speaking = false;
      lastSpeech = Number.NEGATIVE_INFINITY;
    };
    current.onresult = (event) => {
      if (!owns()) return;
      text = Array.from(event.results, (result) => result[0].transcript).join("");
      lastSpeech = performance.now();
      if (text.trim()) window.clearTimeout(wordTimer);
      events.partial(text);
    };
    current.onstart = () => {
      if (!owns()) return;
      window.clearTimeout(startTimer);
      begun = true;
      opening.resolve();
      wordTimer = window.setTimeout(() => {
        if (!owns() || completion || text.trim()) return;
        if (retries++ === 0) {
          release();
          speaking = false;
          lastSpeech = Number.NEGATIVE_INFINITY;
          launch();
        } else fail("no-speech");
      }, FIRST_WORD_MS);
    };
    current.onerror = (event) => {
      if (!owns()) return;
      const failure = speechFailure(event.error);
      if (failure) fail(failure);
      else end();
    };
    current.onend = () => {
      if (owns()) end();
    };
    startTimer = window.setTimeout(() => fail("unavailable"), 15_000);
    try {
      current.start();
    } catch {
      fail("unavailable");
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  // Keep this synchronous: Safari requires the initial start to be in the user's gesture.
  launch();
  await opening.promise;
  return {
    level: () => {
      if (closed) return 0;
      const t = performance.now();
      const activity = speaking ? 1 : Math.max(0, 1 - (t - lastSpeech) / 1200);
      return activity * (0.35 + 0.4 * Math.abs(Math.sin(t / 115) * Math.cos(t / 193)));
    },
    finish() {
      if (completion) return completion.promise;
      if (closed) return Promise.resolve(text);
      completion = Promise.withResolvers<string>();
      window.clearTimeout(wordTimer);
      // A bounded wait keeps final words without retaining a dead recognizer between turns.
      finishTimer = window.setTimeout(end, FINISH_MS);
      try {
        recognition?.stop();
      } catch {
        end();
      }
      return completion.promise;
    },
    abort: cancel,
  };
}
