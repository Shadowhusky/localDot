import type { ApiClient } from "../lib/api.ts";
import { openCapture, VoiceError } from "./capture.ts";
import type { Hearing, HearingEvents } from "./hearing.ts";
import { modelLanguage } from "./language.ts";
import { SPEECH_RATE, wavFile } from "./wav.ts";

const PARTIAL_MS = 4000;
const TRANSCRIBE_MS = 40_000;

// The microphone and recognition have independent lifetimes. Stop releases capture immediately;
// final transcription may still be running. Cancel aborts both, and never delivers late words.
export async function computerHearing(
  api: ApiClient,
  language: string,
  events: HearingEvents,
  signal?: AbortSignal,
): Promise<Hearing> {
  const controller = new AbortController();
  const cancelled = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const capture = await openCapture(true, cancelled);
  let completion: Promise<string> | null = null;
  let pending: Promise<void> | null = null;
  let finishing = false;
  let timer = 0;
  let lastLength = 0;
  let previewLength = 0;
  let text = "";
  const transcribe = async (samples: Float32Array): Promise<string> => {
    cancelled.throwIfAborted();
    if (
      samples.length < SPEECH_RATE * 0.3 ||
      !samples.some((sample) => Math.abs(sample) > 1 / 32768)
    )
      return "";
    const response = await api.fetch(
      `${api.socketUrl("").replace(/^ws/, "http")}/api/voice/transcribe?lang=${modelLanguage(language)}`,
      {
        method: "POST",
        headers: { authorization: api.authorization(), "content-type": "audio/wav" },
        body: wavFile(samples),
        signal: AbortSignal.any([cancelled, AbortSignal.timeout(TRANSCRIBE_MS)]),
        credentials: "same-origin",
        cache: "no-store",
      },
    );
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
    cancelled.throwIfAborted();
    const words = (reply as { text?: unknown } | null)?.text;
    if (typeof words !== "string") throw new VoiceError("failed");
    lastLength = samples.length;
    text = words;
    return words;
  };
  const preview = async () => {
    let samples: Float32Array;
    try {
      samples = await capture.snapshot();
      if (finishing || cancelled.aborted) return;
      if (samples.length === previewLength) throw new VoiceError("no-mic");
      previewLength = samples.length;
    } catch (error) {
      if (!finishing && !cancelled.aborted)
        events.failed(error instanceof VoiceError ? error.failure : "failed");
      pending = null;
      return;
    }
    try {
      if (samples.length > lastLength && samples.length >= SPEECH_RATE * 0.3) {
        const words = await transcribe(samples);
        if (!finishing && !cancelled.aborted) events.partial(words);
      }
    } catch {
      // A missed preview never loses the recording or races a second request. Stop gets one
      // final attempt and reports any error rather than sending an unverified partial draft.
    } finally {
      pending = null;
      if (!finishing && !cancelled.aborted) schedule();
    }
  };
  const schedule = () => {
    timer = window.setTimeout(() => {
      pending = preview();
    }, PARTIAL_MS);
  };
  const stopPreview = () => window.clearTimeout(timer);
  cancelled.addEventListener("abort", stopPreview, { once: true });
  schedule();
  return {
    level: () => capture.level(),
    finish() {
      if (completion) return completion;
      finishing = true;
      stopPreview();
      completion = (async () => {
        try {
          // Flush the tail and stop all tracks before awaiting the pending network/model work.
          const samples = await capture.audio();
          await pending;
          cancelled.throwIfAborted();
          return samples.length === lastLength ? text : await transcribe(samples);
        } catch (error) {
          throw error instanceof VoiceError ? error : new VoiceError("failed");
        } finally {
          capture.close();
          cancelled.removeEventListener("abort", stopPreview);
        }
      })();
      return completion;
    },
    abort() {
      finishing = true;
      controller.abort();
      capture.close();
    },
  };
}
