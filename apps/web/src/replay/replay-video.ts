import { EncodedPacketSink, type Input, type VideoSample, VideoSampleSink } from "mediabunny";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import { type DecodeMode, nextDecodeStep } from "./decode-policy.ts";
import { openRecording } from "./recording-source.ts";

export interface ReplayVideoStats {
  openFrames: number;
  decodeQueue: number;
  seeks: number;
  decoded: number;
}

interface WantedFrame {
  generation: number;
  targetMs: number;
  mode: DecodeMode;
  resolve(frame: VideoFrame | null): void;
  reject(error: unknown): void;
}

export class ReplayVideo {
  readonly #input: Input;
  readonly #packets: EncodedPacketSink;
  readonly #samples: VideoSampleSink;
  readonly #sequential: boolean;
  readonly firstMs: number;
  readonly lastMs: number;
  #iterator: AsyncGenerator<VideoSample> | null = null;
  #next: VideoFrame | null = null;
  #shown: VideoFrame | null = null;
  #shownKeyMs: number | null = null;
  #pending: WantedFrame | null = null;
  #generation = 0;
  #running = false;
  #closed = false;
  #openFrames = 0;
  #seeks = 0;
  #decoded = 0;

  private constructor(
    input: Input,
    packets: EncodedPacketSink,
    samples: VideoSampleSink,
    firstMs: number,
    lastMs: number,
    sequential: boolean,
  ) {
    this.#input = input;
    this.#packets = packets;
    this.#samples = samples;
    this.firstMs = firstMs;
    this.lastMs = lastMs;
    this.#sequential = sequential;
  }

  static async open(
    source: ReplaySource,
    signal?: AbortSignal,
    options?: { sequential: boolean },
  ): Promise<ReplayVideo> {
    const input = openRecording(source);
    const abort = () => input.dispose();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("This recording has no video track.");
      if (!(await track.canDecode()))
        throw new Error(`This browser cannot decode the recording (${track.codec}).`);
      const packets = new EncodedPacketSink(track);
      const first = await packets.getFirstPacket({ metadataOnly: true });
      const last = await packets.getPacket(Infinity, { metadataOnly: true });
      signal?.throwIfAborted();
      if (!first || !last) throw new Error("This recording has no video frames.");
      return new ReplayVideo(
        input,
        packets,
        new VideoSampleSink(track),
        first.microsecondTimestamp / 1000,
        (last.microsecondTimestamp + last.microsecondDuration) / 1000,
        options?.sequential === true,
      );
    } catch (error) {
      input.dispose();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  want(targetMs: number, mode: DecodeMode): Promise<VideoFrame | null> {
    if (!Number.isFinite(targetMs)) return Promise.reject(new RangeError("Invalid replay time."));
    if (this.#closed) return Promise.resolve(null);
    const generation = ++this.#generation;
    this.#pending?.resolve(null);
    const result = new Promise<VideoFrame | null>((resolve, reject) => {
      this.#pending = { generation, targetMs, mode, resolve, reject };
    });
    if (!this.#running) void this.#drain();
    return result;
  }

  async #drain(): Promise<void> {
    this.#running = true;
    try {
      while (this.#pending && !this.#closed) {
        const wanted = this.#pending;
        this.#pending = null;
        try {
          await this.#update(wanted);
          if (!this.#current(wanted)) {
            await this.#reset();
            wanted.resolve(null);
          } else {
            wanted.resolve(this.#shown ? this.#own(this.#shown.clone()) : null);
          }
        } catch (error) {
          await this.#reset();
          if (this.#current(wanted)) wanted.reject(error);
          else wanted.resolve(null);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  #current(wanted: WantedFrame): boolean {
    return !this.#closed && wanted.generation === this.#generation;
  }

  async #update(wanted: WantedFrame): Promise<void> {
    if (wanted.targetMs < this.firstMs) {
      await this.#reset();
      return;
    }
    const key = await this.#packets.getKeyPacket(wanted.targetMs / 1000, { metadataOnly: true });
    if (!this.#current(wanted)) return;
    const keyMs = key ? key.microsecondTimestamp / 1000 : null;
    const sequentialAdvance =
      this.#sequential &&
      wanted.mode === "play" &&
      this.#shown !== null &&
      wanted.targetMs >= this.#shown.timestamp / 1000;
    const step = sequentialAdvance
      ? this.#next && this.#next.timestamp / 1000 <= wanted.targetMs
        ? "advance"
        : "hold"
      : nextDecodeStep({
          targetMs: wanted.targetMs,
          mode: wanted.mode,
          shownMs: this.#shown ? this.#shown.timestamp / 1000 : null,
          shownKeyMs: this.#shownKeyMs,
          targetKeyMs: keyMs,
          nextMs: this.#next ? this.#next.timestamp / 1000 : null,
        });
    if (step === "hold") return;
    if (step === "seek-exact" || step === "seek-key") {
      await this.#reset();
      if (!this.#current(wanted)) return;
      this.#seeks++;
      const sample = await this.#samples.getSample(
        step === "seek-key" && key ? key.timestamp : wanted.targetMs / 1000,
      );
      if (!sample) return;
      if (!this.#current(wanted)) {
        sample.close();
        return;
      }
      this.#shown = this.#frame(sample);
      this.#shownKeyMs = keyMs;
      this.#iterator = this.#samples.samples(this.#shown.timestamp / 1_000_000);
      await this.#lookAhead(wanted);
      return;
    }
    while (this.#current(wanted) && this.#next && this.#next.timestamp / 1000 <= wanted.targetMs) {
      this.#shown?.close();
      this.#shown = this.#next;
      this.#next = null;
      this.#shownKeyMs = keyMs;
      await this.#lookAhead(wanted);
    }
  }

  async #lookAhead(wanted: WantedFrame): Promise<void> {
    while (this.#iterator && this.#current(wanted)) {
      const iterator = this.#iterator;
      const result = await iterator.next();
      if (result.done) {
        if (this.#iterator === iterator) this.#iterator = null;
        return;
      }
      const sample = result.value;
      if (!this.#current(wanted) || this.#iterator !== iterator) {
        sample.close();
        return;
      }
      if (this.#shown && sample.microsecondTimestamp <= this.#shown.timestamp) {
        sample.close();
        continue;
      }
      this.#next = this.#frame(sample);
      return;
    }
  }

  #frame(sample: VideoSample): VideoFrame {
    try {
      const frame = this.#own(sample.toVideoFrame());
      this.#decoded++;
      return frame;
    } finally {
      sample.close();
    }
  }

  #own(frame: VideoFrame): VideoFrame {
    this.#openFrames++;
    const close = frame.close.bind(frame);
    let closed = false;
    frame.close = () => {
      if (closed) return;
      closed = true;
      this.#openFrames--;
      close();
    };
    return frame;
  }

  async #reset(): Promise<void> {
    this.#shown?.close();
    this.#shown = null;
    this.#shownKeyMs = null;
    this.#next?.close();
    this.#next = null;
    const iterator = this.#iterator;
    this.#iterator = null;
    await iterator?.return(undefined).catch(() => {});
  }

  stats(): ReplayVideoStats {
    return {
      openFrames: this.#openFrames,
      decodeQueue: Number(this.#running) + Number(this.#pending !== null),
      seeks: this.#seeks,
      decoded: this.#decoded,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation++;
    this.#pending?.resolve(null);
    this.#pending = null;
    this.#input.dispose();
    void this.#reset();
  }
}
