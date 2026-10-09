import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SpeechBusyError, type Transcriber } from "./speech.ts";

export interface VoiceRoutesDeps {
  // The speech model on this computer, looked up again on each call so one installed later counts.
  speech(): Transcriber | null;
}

export const SPEECH_RATE = 16_000;
// Two minutes of 16 kHz 16-bit mono, the longest a held mic button records, with room to spare.
const MAX_BODY = 4 * 1024 * 1024;
const LANGUAGE = /^[a-z]{2,3}$/;

// Registered after the /api bearer guard. Audio is turned into text and dropped: nothing keeps it.
export function voiceRoutes(app: Hono, deps: VoiceRoutesDeps): void {
  app.get("/api/voice", (c) => {
    const speech = deps.speech();
    return c.json({
      onMac: speech ? { available: true, englishOnly: speech.englishOnly } : { available: false },
    });
  });

  app.post(
    "/api/voice/transcribe",
    bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.text("the recording is too long", 413) }),
    async (c) => {
      const speech = deps.speech();
      if (!speech) return c.text("no speech model on this computer", 404);
      if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "audio/wav")
        return c.text("audio/wav is required", 415);
      const language = c.req.query("lang") ?? null;
      if (language !== null && !LANGUAGE.test(language)) return c.text("invalid language", 400);
      if (speech.englishOnly && language !== null && language !== "en")
        return c.text("the speech model on this computer knows English only", 422);
      const wav = new Uint8Array(await c.req.arrayBuffer());
      if (!speechWav(wav)) return c.text("expected 16 kHz mono 16-bit WAV", 400);
      try {
        return c.json({ text: await speech.transcribe(wav, language) });
      } catch (error) {
        if (error instanceof SpeechBusyError) return c.text(error.message, 409);
        console.error("speech could not be turned into text");
        return c.text("speech could not be turned into text", 502);
      }
    },
  );
}

// A canonical 44-byte-header PCM WAV at the rate the browser records for this route.
export function speechWav(wav: Uint8Array): boolean {
  if (wav.length < 46) return false;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  return (
    tag(0) === "RIFF" &&
    tag(8) === "WAVE" &&
    tag(12) === "fmt " &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === SPEECH_RATE &&
    view.getUint16(34, true) === 16 &&
    tag(36) === "data" &&
    view.getUint32(40, true) === wav.length - 44
  );
}
