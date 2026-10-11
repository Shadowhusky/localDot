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
  // The mic is asked for first, so the one permission prompt covers both, and it drives the
  // waveform: speech recognition does not say how loud anything is.
  const capture = await openCapture(false);
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
  recognition.onresult = (event) => {
    text = Array.from(event.results, (result) => result[0].transcript).join("");
    events.partial(text);
  };
  recognition.onend = () => {
    ended = true;
    capture.close();
    if (settle) settle();
    else if (begun) events.ended();
  };
  try {
    await new Promise<void>((resolve, reject) => {
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
    capture.close();
    recognition.abort();
    throw error;
  }
  return {
    level: () => capture.level(),
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
      settle = () => {};
      recognition.abort();
      capture.close();
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
