import type { ApiClient } from "../lib/api.ts";
import { type Capture, openCapture, VoiceError, type VoiceFailure } from "./capture.ts";
import { modelLanguage } from "./language.ts";
import { speechRecognition, type VoiceRoute } from "./support.ts";
import { SPEECH_RATE, wavFile } from "./wav.ts";

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

// A recording shorter than this has no words in it.
const SHORTEST_S = 0.3;
const FINISH_MS = 4000;
const TRANSCRIBE_MS = 40_000;

export function startHearing(
  route: Extract<VoiceRoute, { kind: "device" | "mac" | "online" }>,
  opts: { api: ApiClient; language: string },
  events: HearingEvents,
): Promise<Hearing> {
  return route.kind === "mac"
    ? computerHearing(opts.api, opts.language)
    : browserHearing(opts.language, route.kind === "device", events);
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

async function browserHearing(
  language: string,
  local: boolean,
  events: HearingEvents,
): Promise<Hearing> {
  const Recognition = speechRecognition();
  if (!Recognition) throw new VoiceError("unavailable");
  // Start within the user's gesture. Recognition owns its microphone; a second capture
  // competes for it on mobile and an awaited permission prompt loses user activation.
  const recognition = new Recognition();
  recognition.lang = language;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  if (local) recognition.processLocally = true;
  let text = "";
  let begun = false;
  let ended = false;
  let settle: (() => void) | null = null;
  let rejectStart: ((error: Error) => void) | undefined;
  let startTimer = 0;
  // Recognition exposes speech activity, not PCM amplitude. Animate that activity without
  // opening a competing microphone. Result pulses cover engines that omit speech events.
  let speaking = false;
  let lastSpeech = Number.NEGATIVE_INFINITY;
  recognition.onspeechstart = () => {
    speaking = true;
  };
  recognition.onspeechend = recognition.onaudioend = () => {
    speaking = false;
    lastSpeech = Number.NEGATIVE_INFINITY;
  };
  recognition.onresult = (event) => {
    text = Array.from(event.results, (result) => result[0].transcript).join("");
    lastSpeech = performance.now();
    events.partial(text);
  };
  recognition.onend = () => {
    ended = true;
    if (!begun) rejectStart?.(new VoiceError("no-speech"));
    if (settle) settle();
    else if (begun) events.ended();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      rejectStart = reject;
      startTimer = window.setTimeout(() => reject(new VoiceError("unavailable")), 15_000);
      recognition.onstart = () => {
        begun = true;
        resolve();
      };
      recognition.onerror = (event) => {
        const failure = speechFailure(event.error);
        if (!failure) return;
        if (begun) events.failed(failure);
        else reject(new VoiceError(failure));
      };
      recognition.start();
    });
  } catch (error) {
    recognition.abort();
    throw error;
  } finally {
    window.clearTimeout(startTimer);
  }
  return {
    level: () => {
      if (ended) return 0;
      const t = performance.now();
      const activity = speaking ? 1 : Math.max(0, 1 - (t - lastSpeech) / 1200);
      return activity * (0.35 + 0.4 * Math.abs(Math.sin(t / 115) * Math.cos(t / 193)));
    },
    finish() {
      if (ended) return Promise.resolve(text);
      return new Promise<string>((resolve) => {
        const timer = window.setTimeout(() => {
          recognition.abort();
          resolve(text);
        }, FINISH_MS);
        settle = () => {
          window.clearTimeout(timer);
          resolve(text);
        };
        recognition.stop();
      });
    },
    abort() {
      ended = true;
      settle = () => {};
      recognition.abort();
    },
  };
}

async function computerHearing(api: ApiClient, language: string): Promise<Hearing> {
  const capture: Capture = await openCapture(true);
  return {
    level: () => capture.level(),
    async finish() {
      let samples: Float32Array;
      try {
        samples = await capture.audio();
      } catch {
        throw new VoiceError("failed");
      }
      if (samples.length < SPEECH_RATE * SHORTEST_S) return "";
      const response = await api
        .fetch(
          `${api.socketUrl("").replace(/^ws/, "http")}/api/voice/transcribe?lang=${modelLanguage(language)}`,
          {
            method: "POST",
            headers: { authorization: api.authorization(), "content-type": "audio/wav" },
            body: wavFile(samples),
            signal: AbortSignal.timeout(TRANSCRIBE_MS),
            credentials: "same-origin",
            cache: "no-store",
          },
        )
        .catch(() => {
          throw new VoiceError("failed");
        });
      if (response.status === 401) api.rejectUnauthorized?.();
      if (!response.ok)
        throw new VoiceError(
          response.status === 409
            ? "busy"
            : response.status === 404 || response.status === 422
              ? "unavailable"
              : "failed",
        );
      const reply: unknown = await response.json().catch(() => null);
      const words = (reply as { text?: unknown } | null)?.text;
      return typeof words === "string" ? words : "";
    },
    abort: () => capture.close(),
  };
}
