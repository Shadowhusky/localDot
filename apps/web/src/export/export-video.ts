import { EncodedPacketSink, type Input, type VideoSample, VideoSampleSink } from "mediabunny";
import { openRecording } from "../replay/recording-source.ts";
import type { ReplaySource } from "../stage/worker-protocol.ts";

// The recording read in order for an export. Each wanted time gets the picture on screen then; a
// stretch the export skips over is never decoded past its key frame, and a time that falls on the
// picture before it gets that picture again without decoding anything.
export class ExportVideo {
  readonly #input: Input;
  readonly #sink: VideoSampleSink;
  readonly firstMs: number;
  readonly lastMs: number;

  private constructor(input: Input, sink: VideoSampleSink, firstMs: number, lastMs: number) {
    this.#input = input;
    this.#sink = sink;
    this.firstMs = firstMs;
    this.lastMs = lastMs;
  }

  static async open(source: ReplaySource, signal: AbortSignal): Promise<ExportVideo> {
    const input = openRecording(source);
    const abort = () => input.dispose();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("This recording has no video track.");
      if (!(await track.canDecode()))
        throw new Error(`This browser cannot decode the recording (${track.codec}).`);
      const packets = new EncodedPacketSink(track);
      const first = await packets.getFirstPacket({ metadataOnly: true });
      const last = await packets.getPacket(Infinity, { metadataOnly: true });
      signal.throwIfAborted();
      if (!first || !last) throw new Error("This recording has no video frames.");
      return new ExportVideo(
        input,
        new VideoSampleSink(track),
        first.microsecondTimestamp / 1000,
        (last.microsecondTimestamp + last.microsecondDuration) / 1000,
      );
    } catch (error) {
      input.dispose();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  // One sample, or null before the first picture, for each time in `timesMs`, which never go back.
  samples(timesMs: Iterable<number>): AsyncGenerator<VideoSample | null, void, unknown> {
    return this.#sink.samplesAtTimestamps(
      (function* () {
        for (const time of timesMs) yield time / 1000;
      })(),
    );
  }

  close(): void {
    this.#input.dispose();
  }
}
