import { join } from "node:path";
import { MEDIA_TIMESCALE } from "@localdot/protocol";
import {
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FilePathSource,
  FilePathTarget,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { ENCODED, type TrackEncoder } from "../compaction.ts";

export interface FakeEncoderOptions {
  // The source frames (by decode index) the "encode" keeps after the first.
  keep?(index: number): boolean;
  // Added to every kept frame after the first, as a broken encoder would move them.
  shiftMicros?: number;
  before?(signal: AbortSignal): void | Promise<void>;
  after?(): void | Promise<void>;
  // What decoding reports, given the number of frames in the file.
  decoded?(frames: number): number;
}

// Stands in for ffmpeg: copies some of the source's frames into a plain MP4 whose times start at
// zero, in microseconds, as the real encode writes them.
export class FakeEncoder implements TrackEncoder {
  readonly encoded: string[] = [];
  constructor(readonly options: FakeEncoderOptions = {}) {}

  async encode(video: string, outDir: string, signal: AbortSignal): Promise<void> {
    this.encoded.push(video);
    await this.options.before?.(signal);
    signal.throwIfAborted();
    const input = new Input({ formats: [MP4], source: new FilePathSource(video) });
    try {
      const track = await input.getPrimaryVideoTrack();
      const config = await track?.getDecoderConfig();
      if (!track || !config) throw new Error("no video track");
      const output = new Output({
        format: new Mp4OutputFormat(),
        target: new FilePathTarget(join(outDir, ENCODED)),
      });
      const source = new EncodedVideoPacketSource("avc");
      output.addVideoTrack(source, { frameRate: MEDIA_TIMESCALE });
      await output.start();
      let first: number | null = null;
      let index = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        if (first === null || (this.options.keep?.(index) ?? true)) {
          const shift = first === null ? 0 : (this.options.shiftMicros ?? 0);
          first ??= packet.microsecondTimestamp;
          await source.add(
            new EncodedPacket(
              packet.data,
              packet.type,
              (packet.microsecondTimestamp - first + shift) / MEDIA_TIMESCALE,
              packet.microsecondDuration / MEDIA_TIMESCALE,
            ),
            index === 0 ? { decoderConfig: config } : undefined,
          );
        }
        index++;
      }
      await output.finalize();
    } finally {
      input.dispose();
    }
    await this.options.after?.();
  }

  async decode(video: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    const input = new Input({ formats: [MP4], source: new FilePathSource(video) });
    try {
      const track = await input.getPrimaryVideoTrack();
      let frames = 0;
      if (track)
        for await (const _ of new EncodedPacketSink(track).packets(undefined, undefined, {
          metadataOnly: true,
        }))
          frames++;
      return this.options.decoded?.(frames) ?? frames;
    } finally {
      input.dispose();
    }
  }
}
