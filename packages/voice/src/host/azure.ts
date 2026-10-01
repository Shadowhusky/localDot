import type { MouthShape, Viseme } from "@localdot/avatar";
import type { Lang } from "../lang.ts";
import { encodeAudioFrame } from "../wire.ts";
import { PcmChunker } from "./pcm-stream.ts";
import { ProviderError, type Sentence, type TtsOutput, type TtsProvider } from "./router.ts";

// One multilingual voice for all three languages; never a Dragon HD voice, which sends no visemes.
export const AZURE_VOICE = "zh-CN-XiaoxiaoMultilingualNeural";
const LOCALES: Record<Lang, string> = { zh: "zh-CN", en: "en-US", ja: "ja-JP" };
const TICKS_PER_MS = 10_000;

// Azure viseme IDs: 0 is silence, 21 is p/b/m with the lips closed, the vowels map to the five
// shapes, and the other consonants (12 to 20) keep the shape the mouth already has.
const AZURE_SHAPES: Record<number, MouthShape> = {
  0: "rest",
  1: "A",
  2: "A",
  9: "A",
  11: "A",
  6: "I",
  7: "U",
  4: "E",
  5: "E",
  3: "O",
  8: "O",
  10: "O",
  21: "N",
};

export interface AzureViseme {
  offsetTicks: number;
  id: number;
}

export function azureVisemes(events: AzureViseme[]): Viseme[] {
  const out: Viseme[] = [];
  let shape: MouthShape = "rest";
  for (const event of [...events].sort((a, b) => a.offsetTicks - b.offsetTicks)) {
    const next: MouthShape = AZURE_SHAPES[event.id] ?? shape;
    if (next === shape) continue;
    shape = next;
    if (out.length === 0 && shape === "rest") continue;
    out.push({ t: event.offsetTicks / TICKS_PER_MS, shape });
  }
  return out;
}

const escapeXml = (text: string) =>
  text.replace(
    /[<>&"']/g,
    (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch] ?? ch,
  );

export function ssmlFor(text: string, lang: Lang, voice: string = AZURE_VOICE): string {
  const locale = LOCALES[lang];
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${escapeXml(voice)}"><lang xml:lang="${locale}">${escapeXml(text)}</lang></voice></speak>`;
}

export interface AzureCredentials {
  key: string;
  region: string;
  voice: string;
}

export interface AzureSynth {
  // Resolves when synthesis completes; audio and viseme callbacks fire before that.
  speak(
    ssml: string,
    onAudio: (bytes: Uint8Array) => void,
    onViseme: (event: AzureViseme) => void,
    signal: AbortSignal,
  ): Promise<void>;
  close(): void;
}

export type AzureSynthFactory = (credentials: AzureCredentials) => Promise<AzureSynth>;

export class AzureTts implements TtsProvider {
  readonly kind = "azure" as const;
  readonly #credentials: () => AzureCredentials | null;
  readonly #out: TtsOutput;
  readonly #factory: AzureSynthFactory;
  #synth: AzureSynth | null = null;

  constructor(
    credentials: () => AzureCredentials | null,
    out: TtsOutput,
    factory: AzureSynthFactory = azureSdkSynth,
  ) {
    this.#credentials = credentials;
    this.#out = out;
    this.#factory = factory;
  }

  async speak(sentence: Sentence, signal: AbortSignal): Promise<void> {
    const credentials = this.#credentials();
    if (!credentials) throw new ProviderError("unavailable", "Azure is not configured");
    this.#synth ??= await this.#factory(credentials);
    const chunker = new PcmChunker();
    const visemes: AzureViseme[] = [];
    let seq = 0;
    let samples = 0;
    try {
      await this.#synth.speak(
        ssmlFor(sentence.text, sentence.lang, credentials.voice),
        (bytes) => {
          const pcm = chunker.push(bytes);
          if (pcm.length === 0 || signal.aborted) return;
          this.#out.frame(encodeAudioFrame(sentence.id, seq++, pcm));
          samples += pcm.length;
        },
        (event) => visemes.push(event),
        signal,
      );
    } catch (error) {
      this.#synth?.close();
      this.#synth = null;
      if (signal.aborted) return;
      throw new ProviderError(
        "synthesis_failed",
        error instanceof Error ? error.message : String(error),
        samples > 0,
      );
    }
    if (signal.aborted) return;
    this.#out.message({ type: "end", id: sentence.id, samples });
    const track = azureVisemes(visemes);
    this.#out.message(
      track.length > 0
        ? { type: "track", id: sentence.id, lang: sentence.lang, visemes: track }
        : {
            type: "error",
            id: sentence.id,
            code: "align_failed",
            message: "Azure sent no visemes",
          },
    );
  }

  close(): void {
    this.#synth?.close();
    this.#synth = null;
  }
}

export async function azureSdkSynth(credentials: AzureCredentials): Promise<AzureSynth> {
  const sdk = await import("microsoft-cognitiveservices-speech-sdk");
  const config = sdk.SpeechConfig.fromSubscription(credentials.key, credentials.region);
  config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
  const synthesizer = new sdk.SpeechSynthesizer(config, null);
  return {
    speak: (ssml, onAudio, onViseme, signal) =>
      new Promise<void>((resolve, reject) => {
        synthesizer.synthesizing = (_sender, event) =>
          onAudio(new Uint8Array(event.result.audioData));
        synthesizer.visemeReceived = (_sender, event) =>
          onViseme({ offsetTicks: event.audioOffset, id: event.visemeId });
        const onAbort = () => reject(new Error("cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        synthesizer.speakSsmlAsync(
          ssml,
          (result) => {
            signal.removeEventListener("abort", onAbort);
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) resolve();
            else reject(new Error(result.errorDetails || "Azure synthesis failed"));
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error(error));
          },
        );
      }),
    close: () => synthesizer.close(),
  };
}
