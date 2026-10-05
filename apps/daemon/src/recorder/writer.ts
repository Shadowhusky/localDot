import * as nodeFs from "node:fs";
import { join } from "node:path";
import {
  type FragmentEntry,
  MEDIA_TIMESCALE,
  RECORDING_FRAGMENTS,
  RECORDING_JOURNAL,
  RECORDING_VIDEO,
} from "@localdot/protocol";
import {
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from "mediabunny";
import { encodeJournalRecord, journalName } from "./journal.ts";

// Each key starts its own fragment so the muxer's sync flags remain seekable.
export const FRAGMENT_MIN_SECONDS = 0;
export interface RecordedFrame {
  tMicros: number;
  key: boolean;
  data: Uint8Array;
}
export type RecordingFs = Pick<
  typeof import("node:fs"),
  | "openSync"
  | "writeSync"
  | "closeSync"
  | "appendFileSync"
  | "mkdirSync"
  | "rmSync"
  | "readFileSync"
  | "readdirSync"
  | "statSync"
  | "truncateSync"
  | "existsSync"
>;
export interface RecordingWriterOptions {
  dir: string;
  codec: string;
  width: number;
  height: number;
  fs?: RecordingFs;
  onCommit?(entry: FragmentEntry): void;
}

function micros(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
    throw new RangeError(
      "recording time must be a nonnegative safe integer with room for a successor",
    );
}

export class RecordingWriter {
  readonly #opts: RecordingWriterOptions;
  readonly #fs: RecordingFs;
  readonly #source = new EncodedVideoPacketSource("avc");
  readonly #output: Output;
  readonly #entries: FragmentEntry[] = [];
  readonly #ready: FragmentEntry[] = [];
  #tail: Promise<void> = Promise.resolve();
  #phase: "new" | "started" | "finished" | "closed" = "new";
  #fd: number | null = null;
  #written = 0;
  #lastT: number | null = null;
  #pending: RecordedFrame | null = null;
  #journal: string | null = null;
  #error: unknown = null;
  #hasError = false;
  #firstPacket = true;
  #addingEnd = 0;
  #moof: { moofOffset: number; startMicros: number } | null = null;

  constructor(opts: RecordingWriterOptions) {
    if (
      !/^avc1\.[0-9a-f]{6}$/.test(opts.codec) ||
      ![opts.width, opts.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 16_384)
    )
      throw new RangeError("recording requires an AVC codec and positive bounded dimensions");
    this.#opts = { ...opts };
    this.#fs = opts.fs ?? nodeFs;
    const sink = new WritableStream({
      write: ({ data, position }: { data: Uint8Array; position: number }) => {
        const fd = this.#fd;
        if (fd === null) throw new Error("recording file is closed");
        if (position !== this.#written) throw new Error("fragmented recording writes must append");
        let offset = 0;
        while (offset < data.length) {
          const count = this.#fs.writeSync(fd, data, offset, data.length - offset, this.#written);
          if (!Number.isInteger(count) || count <= 0 || count > data.length - offset)
            throw new Error("recording disk write made no valid progress");
          offset += count;
          this.#written += count;
        }
      },
    });
    this.#output = new Output({
      target: new StreamTarget(sink),
      format: new Mp4OutputFormat({
        fastStart: "fragmented",
        minimumFragmentDuration: FRAGMENT_MIN_SECONDS,
        onMoof: (_data, moofOffset, timestamp) => {
          this.#moof = { moofOffset, startMicros: Math.round(timestamp * MEDIA_TIMESCALE) };
        },
        onMdat: (data, position) => {
          if (!this.#moof) throw new Error("recording fragment has no moof");
          this.#ready.push({
            seq: this.#entries.length + this.#ready.length + 1,
            ...this.#moof,
            endOffset: position + data.length,
            endMicros: this.#addingEnd,
          });
          this.#moof = null;
        },
      }),
    });
    this.#output.addVideoTrack(this.#source, { frameRate: MEDIA_TIMESCALE });
  }

  get entries(): readonly FragmentEntry[] {
    return this.#entries;
  }
  get committedBytes(): number {
    return this.#entries.at(-1)?.endOffset ?? 0;
  }
  get lastMicros(): number | null {
    return this.#lastT;
  }
  get failed(): boolean {
    return this.#hasError;
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(async () => {
      if (this.#hasError) throw this.#error;
      try {
        return await operation();
      } catch (error) {
        this.#hasError = true;
        this.#error = error;
        this.#closeFd();
        throw error;
      }
    });
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #closeFd(): void {
    const fd = this.#fd;
    this.#fd = null;
    if (fd !== null) {
      try {
        this.#fs.closeSync(fd);
      } catch (error) {
        if (!this.#hasError) {
          this.#hasError = true;
          this.#error = error;
        }
      }
    }
  }
  #requireStarted(): void {
    if (this.#phase !== "started") throw new Error(`recording writer is ${this.#phase}`);
  }
  #requireNew(): void {
    if (this.#phase !== "new") throw new Error(`recording writer is ${this.#phase}`);
  }

  start(): Promise<void> {
    return this.#run(async () => {
      if (this.#phase === "started") return;
      this.#requireNew();
      this.#fs.mkdirSync(join(this.#opts.dir, RECORDING_JOURNAL), { recursive: true });
      const fd = this.#fs.openSync(join(this.#opts.dir, RECORDING_VIDEO), "w");
      this.#fd = fd;
      await this.#output.start();
      // close() can run while the muxer starts; closure must remain terminal.
      this.#requireNew();
      if (this.#fd !== fd) throw new Error("recording file is closed");
      this.#phase = "started";
    });
  }

  push(frame: RecordedFrame): Promise<boolean> {
    // Snapshot bytes before an asynchronous predecessor can let a producer reuse its buffer.
    const copy = { ...frame, data: new Uint8Array(frame.data) };
    return this.#run(async () => {
      this.#requireStarted();
      micros(copy.tMicros);
      if (this.#lastT === null && !copy.key) return false;
      if (copy.data.length === 0) throw new Error("recording frame is empty");
      const t = Math.max(copy.tMicros, (this.#lastT ?? -1) + 1);
      micros(t);
      if (copy.key) this.#journal = join(this.#opts.dir, RECORDING_JOURNAL, journalName(t));
      if (!this.#journal) throw new Error("recording has no keyframe journal");
      const normalized = { ...copy, tMicros: t };
      this.#fs.appendFileSync(this.#journal, encodeJournalRecord(normalized));
      if (this.#pending) await this.#addPending(t - this.#pending.tMicros);
      this.#pending = normalized;
      this.#lastT = t;
      return true;
    });
  }

  async #addPending(durationMicros: number): Promise<void> {
    const frame = this.#pending;
    if (!frame) return;
    this.#addingEnd = frame.tMicros;
    await this.#source.add(
      new EncodedPacket(
        frame.data,
        frame.key ? "key" : "delta",
        frame.tMicros / MEDIA_TIMESCALE,
        durationMicros / MEDIA_TIMESCALE,
      ),
      this.#firstPacket
        ? {
            decoderConfig: {
              codec: this.#opts.codec,
              codedWidth: this.#opts.width,
              codedHeight: this.#opts.height,
            },
          }
        : undefined,
    );
    this.#firstPacket = false;
    this.#pending = null;
    this.#commitReady();
  }

  #commitReady(): void {
    while (true) {
      const entry = this.#ready[0];
      if (!entry || entry.endOffset > this.#written) break;
      this.#fs.appendFileSync(
        join(this.#opts.dir, RECORDING_FRAGMENTS),
        `${JSON.stringify(entry)}\n`,
      );
      this.#entries.push(entry);
      this.#ready.shift();
      this.#opts.onCommit?.(entry);
      for (const name of this.#fs.readdirSync(join(this.#opts.dir, RECORDING_JOURNAL))) {
        if (/^\d{16}\.bin$/.test(name) && Number(name.slice(0, -4)) < entry.endMicros)
          this.#fs.rmSync(join(this.#opts.dir, RECORDING_JOURNAL, name));
      }
    }
  }

  flushIdle(nowMicros: number): Promise<void> {
    return this.#run(async () => {
      this.#requireStarted();
      micros(nowMicros);
      if (this.#pending) await this.#addPending(Math.max(1, nowMicros - this.#pending.tMicros));
    });
  }

  finish(endMicros: number): Promise<void> {
    return this.#run(async () => {
      if (this.#phase === "finished") return;
      this.#requireStarted();
      micros(endMicros);
      if (this.#pending) await this.#addPending(Math.max(1, endMicros - this.#pending.tMicros));
      this.#addingEnd = Math.max(endMicros, (this.#lastT ?? -1) + 1);
      await this.#output.finalize();
      this.#commitReady();
      if (this.#ready.length)
        throw new Error("recording finalized before fragment bytes reached disk");
      this.#closeFd();
      if (this.#hasError) throw this.#error;
      this.#fs.rmSync(join(this.#opts.dir, RECORDING_JOURNAL), { recursive: true, force: true });
      this.#phase = "finished";
    });
  }

  close(): void {
    this.#closeFd();
    if (this.#phase !== "finished") this.#phase = "closed";
  }
}
