import type { Viseme } from "@localdot/avatar";
import { CJK, type Lang } from "../lang.ts";
import { encodeAudioFrame, SAMPLE_RATE } from "../wire.ts";
import type { VoicedEndpoint } from "./local.ts";
import { NdjsonReader, PcmChunker } from "./pcm-stream.ts";
import { ProviderError, type Sentence, type TtsOutput, type TtsProvider } from "./router.ts";

export const ELEVENLABS_MODEL = "eleven_v4_turbo";
export const ELEVENLABS_API = "https://api.elevenlabs.io";
const WORD = /[\p{L}\p{N}'’]/u;

export interface ElevenLabsCredentials {
  key: string;
  voiceId: string;
  model: string;
}

export interface TimedUnit {
  text: string;
  start: number;
  end: number;
}

export type VisemesFor = (lang: Lang, units: TimedUnit[]) => Promise<Viseme[] | null>;

interface CharTime {
  ch: string;
  start: number;
  end: number;
}

// ElevenLabs times each character from the start of the request; if a chunk's times restart, they
// are taken as relative to that chunk and shifted by the audio sent before it.
export class AlignmentCollector {
  readonly #chars: CharTime[] = [];
  #latest = 0;

  push(alignment: unknown, secondsBefore: number): void {
    if (typeof alignment !== "object" || alignment === null) return;
    const a = alignment as Record<string, unknown>;
    const chars = a.characters;
    const starts = a.character_start_times_seconds;
    const ends = a.character_end_times_seconds;
    if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return;
    const first = Number(starts[0]);
    const shift = first < this.#latest - 0.05 ? secondsBefore : 0;
    chars.forEach((ch, i) => {
      const start = Number(starts[i]) + shift;
      const end = Number(ends[i]) + shift;
      if (typeof ch !== "string" || !Number.isFinite(start) || !Number.isFinite(end)) return;
      this.#chars.push({ ch, start, end });
      this.#latest = Math.max(this.#latest, end);
    });
  }

  // Latin runs become words; each Chinese or Japanese character is its own unit; the rest is spacing.
  units(): TimedUnit[] {
    const units: TimedUnit[] = [];
    let word: TimedUnit | null = null;
    for (const { ch, start, end } of this.#chars) {
      if (CJK.test(ch)) {
        if (word) units.push(word);
        word = null;
        units.push({ text: ch, start, end });
      } else if (WORD.test(ch)) {
        if (word) {
          word.text += ch;
          word.end = end;
        } else {
          word = { text: ch, start, end };
        }
      } else if (word) {
        units.push(word);
        word = null;
      }
    }
    if (word) units.push(word);
    return units;
  }
}

export class ElevenLabsTts implements TtsProvider {
  readonly kind = "elevenlabs" as const;
  readonly #credentials: () => ElevenLabsCredentials | null;
  readonly #out: TtsOutput;
  readonly #visemesFor: VisemesFor;
  readonly #fetch: typeof fetch;

  constructor(
    credentials: () => ElevenLabsCredentials | null,
    out: TtsOutput,
    visemesFor: VisemesFor,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.#credentials = credentials;
    this.#out = out;
    this.#visemesFor = visemesFor;
    this.#fetch = fetchImpl;
  }

  async speak(sentence: Sentence, signal: AbortSignal): Promise<void> {
    const credentials = this.#credentials();
    if (!credentials) throw new ProviderError("unavailable", "ElevenLabs is not configured");
    const url = `${ELEVENLABS_API}/v1/text-to-speech/${encodeURIComponent(credentials.voiceId)}/stream/with-timestamps?output_format=pcm_24000`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "xi-api-key": credentials.key, "content-type": "application/json" },
        body: JSON.stringify({
          text: sentence.text,
          model_id: credentials.model,
          language_code: sentence.lang,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw new ProviderError(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!response.ok || !response.body) {
      throw new ProviderError("synthesis_failed", `ElevenLabs answered ${response.status}`);
    }
    const reader = new NdjsonReader();
    const chunker = new PcmChunker();
    const alignment = new AlignmentCollector();
    let seq = 0;
    let samples = 0;
    const take = (chunk: unknown) => {
      if (typeof chunk !== "object" || chunk === null) return;
      const c = chunk as Record<string, unknown>;
      alignment.push(c.alignment, samples / SAMPLE_RATE);
      if (typeof c.audio_base64 !== "string") return;
      const pcm = chunker.push(Buffer.from(c.audio_base64, "base64"));
      if (pcm.length === 0) return;
      this.#out.frame(encodeAudioFrame(sentence.id, seq++, pcm));
      samples += pcm.length;
    };
    try {
      for await (const bytes of response.body) for (const chunk of reader.push(bytes)) take(chunk);
      for (const chunk of reader.flush()) take(chunk);
    } catch (error) {
      if (signal.aborted) return;
      throw new ProviderError(
        "synthesis_failed",
        error instanceof Error ? error.message : String(error),
        samples > 0,
      );
    }
    if (signal.aborted) return;
    this.#out.message({ type: "end", id: sentence.id, samples });
    const visemes = await Promise.race([
      this.#visemesFor(sentence.lang, alignment.units()).catch(() => null),
      whenAborted(signal),
    ]);
    if (signal.aborted) return;
    this.#out.message(
      visemes && visemes.length > 0
        ? { type: "track", id: sentence.id, lang: sentence.lang, visemes }
        : {
            type: "error",
            id: sentence.id,
            code: "align_failed",
            message: "no mouth shapes for these timings",
          },
    );
  }

  close(): void {}
}

// The next sentence waits on the mouth shapes, so voiced gets this long in all, start-up included.
export const VISEMES_TIMEOUT_MS = 2000;

// Character timings become mouth shapes through voiced's own phonetics, as the local voice's do.
export function voicedVisemes(
  endpoint: () => Promise<VoicedEndpoint | null>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = VISEMES_TIMEOUT_MS,
): VisemesFor {
  return async (lang, units) => {
    if (units.length === 0) return null;
    const signal = AbortSignal.timeout(timeoutMs);
    const found = await Promise.race([endpoint(), whenAborted(signal)]);
    if (!found) return null;
    const response = await fetchImpl(`http://${found.host}/visemes`, {
      method: "POST",
      headers: { authorization: `Bearer ${found.token}`, "content-type": "application/json" },
      body: JSON.stringify({ lang, units }),
      signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { visemes?: unknown };
    return Array.isArray(body.visemes) ? (body.visemes as Viseme[]) : null;
  };
}

function whenAborted(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}
