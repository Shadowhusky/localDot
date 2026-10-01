import { prepareTrack, type SpeechTrack, type Viseme } from "@localdot/avatar";
import { type AudioClock, audioToPerf } from "./clock.ts";
import { ENVELOPE_RATE_HZ, ENVELOPE_STEP_MS, EnvelopeMeter, envelopeVisemes } from "./envelope.ts";
import type { Lang } from "./lang.ts";
import { int16ToFloat32 } from "./pcm.ts";
import { SAMPLE_RATE } from "./wire.ts";

export interface SpeechSink {
  speak(track: SpeechTrack | null): void;
}

export interface PlaybackContext extends AudioClock {
  readonly destination: AudioNode;
  readonly state: AudioContextState;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  resume(): Promise<void>;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface ChunkTiming {
  sample: number;
  samples: number;
  at: number;
}

export interface SentenceAudio {
  id: number;
  lang: Lang;
  chunks: ChunkTiming[];
  levels: number[];
  visemes: Viseme[] | null;
  samples: number;
  ended: boolean;
}

export const START_LEAD_S = 0.08;
export const MIN_LEAD_S = 0.02;
const KEEP_AFTER_END_S = 1;

// Where a moment of a sentence (ms from its first sample) plays on the audio clock; a gap from a
// late chunk shifts everything after it.
export function contextTimeOf(sentence: SentenceAudio, ms: number): number {
  const sample = (ms / 1000) * SAMPLE_RATE;
  let chunk = sentence.chunks[0];
  for (const c of sentence.chunks) {
    if (c.sample > sample) break;
    chunk = c;
  }
  if (!chunk) return Number.NaN;
  return chunk.at + (sample - chunk.sample) / SAMPLE_RATE;
}

export function buildTrack(
  sentences: SentenceAudio[],
  toPerf: (contextTime: number) => number,
): SpeechTrack | null {
  const playing = sentences.filter((s) => s.chunks.length > 0);
  const first = playing[0];
  const base = first?.chunks[0]?.at;
  if (!first || base === undefined) return null;
  const visemes: Viseme[] = [];
  const add = (v: Viseme) => {
    // To the microsecond: float drift would put an onset on a 12 fps frame boundary a frame late.
    const t = Math.round(v.t * 1000) / 1000;
    const last = visemes.at(-1);
    if (last && t - last.t < 0.5) visemes.pop();
    if (visemes.at(-1)?.shape !== v.shape) visemes.push({ t, shape: v.shape });
  };
  const envelope: number[] = [];
  for (const s of playing) {
    const rel = (ms: number) => (contextTimeOf(s, ms) - base) * 1000;
    const own = s.visemes ?? envelopeVisemes(s.levels);
    for (const v of own) add({ t: rel(v.t), shape: v.shape });
    if (s.ended && (own.at(-1)?.shape ?? "rest") !== "rest") {
      add({ t: rel((s.samples / SAMPLE_RATE) * 1000), shape: "rest" });
    }
    s.levels.forEach((level, i) => {
      const k = Math.round(rel(i * ENVELOPE_STEP_MS) / ENVELOPE_STEP_MS);
      if (k >= 0) envelope[k] = level;
    });
  }
  return prepareTrack({
    lang: first.lang,
    startsAt: toPerf(base),
    visemes,
    envelope: Float32Array.from(envelope, (v) => v ?? 0),
    envelopeRateHz: ENVELOPE_RATE_HZ,
  });
}

interface Sentence extends SentenceAudio {
  meter: EnvelopeMeter;
}

export class VoicePlayer {
  readonly #ctx: PlaybackContext;
  readonly #sink: SpeechSink;
  readonly #now: () => number;
  readonly #sentences = new Map<number, Sentence>();
  readonly #sources = new Set<AudioBufferSourceNode>();
  readonly #firstAudio = new Map<number, number>();
  #cursor = 0;
  #ignoreBelow = 0;

  constructor(ctx: PlaybackContext, sink: SpeechSink, now: () => number = () => performance.now()) {
    this.#ctx = ctx;
    this.#sink = sink;
    this.#now = now;
    ctx.addEventListener("statechange", () => this.#publish());
  }

  get speaking(): boolean {
    return this.#sources.size > 0;
  }

  // The browser keeps audio suspended until the page gets a click or key press.
  get blocked(): boolean {
    return this.#ctx.state !== "running";
  }

  unlock(): Promise<void> {
    return this.#ctx.state === "suspended" ? this.#ctx.resume() : Promise.resolve();
  }

  begin(id: number, lang: Lang): void {
    if (id < this.#ignoreBelow || this.#sentences.has(id)) return;
    this.#sentences.set(id, {
      id,
      lang,
      chunks: [],
      levels: [],
      visemes: null,
      samples: 0,
      ended: false,
      meter: new EnvelopeMeter(SAMPLE_RATE),
    });
  }

  audio(id: number, pcm: Int16Array): void {
    if (id < this.#ignoreBelow || pcm.length === 0) return;
    this.begin(id, "en");
    const sentence = this.#sentences.get(id);
    if (!sentence) return;
    const samples = int16ToFloat32(pcm);
    const buffer = this.#ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = this.#ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#ctx.destination);
    const lead = this.#sources.size === 0 ? START_LEAD_S : MIN_LEAD_S;
    const at = Math.max(this.#cursor, this.#ctx.currentTime + lead);
    source.onended = () => this.#sources.delete(source);
    source.start(at);
    this.#sources.add(source);
    this.#cursor = at + samples.length / SAMPLE_RATE;
    if (sentence.chunks.length === 0) {
      this.#firstAudio.set(id, audioToPerf(this.#ctx, at, this.#now()));
    }
    sentence.chunks.push({ sample: sentence.samples, samples: samples.length, at });
    sentence.samples += samples.length;
    sentence.levels.push(...sentence.meter.push(samples));
    this.#publish();
  }

  track(id: number, visemes: Viseme[]): void {
    const sentence = this.#sentences.get(id);
    if (!sentence) return;
    sentence.visemes = visemes;
    this.#publish();
  }

  end(id: number): void {
    const sentence = this.#sentences.get(id);
    if (!sentence) return;
    sentence.ended = true;
    this.#publish();
  }

  // Barge-in: silence now, mouth to rest, and anything still arriving for these sentences dropped.
  stop(): void {
    for (const source of this.#sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that never started throws on stop; it is silent either way.
      }
      source.disconnect();
    }
    this.#sources.clear();
    const highest = Math.max(this.#ignoreBelow - 1, ...this.#sentences.keys());
    this.#ignoreBelow = highest + 1;
    this.#sentences.clear();
    this.#cursor = 0;
    this.#sink.speak(null);
  }

  firstAudioAt(id: number): number | undefined {
    return this.#firstAudio.get(id);
  }

  // A suspended context plays nothing, so the mouth waits for the sound instead of moving silently.
  #publish(): void {
    if (this.blocked) return;
    const now = this.#ctx.currentTime;
    for (const [id, s] of this.#sentences) {
      if (s.ended && contextTimeOf(s, (s.samples / SAMPLE_RATE) * 1000) < now - KEEP_AFTER_END_S) {
        this.#sentences.delete(id);
      }
    }
    const perfNow = this.#now();
    const track = buildTrack([...this.#sentences.values()], (t) =>
      audioToPerf(this.#ctx, t, perfNow),
    );
    if (track) this.#sink.speak(track);
  }
}
