import * as nodeFs from "node:fs";
import { join } from "node:path";
import {
  FragmentEntry,
  MEDIA_TIMESCALE,
  RECORDING_FRAGMENTS,
  RECORDING_JOURNAL,
  RECORDING_MANIFEST,
  RECORDING_VIDEO,
} from "@localdot/protocol";
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { mfraBox, topLevelBoxes } from "./boxes.ts";
import { decodeJournal, type JournalRecord } from "./journal.ts";
import { FRAGMENT_MIN_SECONDS, type RecordingFs } from "./writer.ts";

export interface StreamFormat {
  codec: string;
  width: number;
  height: number;
}
export interface RecoveryResult {
  state: "recovered" | "failed";
  finalized: boolean;
  fragments: number;
  tailFrames: number;
  bytes: number;
  firstMicros: number | null;
  lastMicros: number | null;
}
export const NOMINAL_FRAME_MICROS = 16_667;

function scanFragments(
  dir: string,
  fs: RecordingFs,
): { entries: FragmentEntry[]; prefixBytes: number } {
  const index = join(dir, RECORDING_FRAGMENTS);
  const video = join(dir, RECORDING_VIDEO);
  if (!fs.existsSync(index) || !fs.existsSync(video)) return { entries: [], prefixBytes: 0 };
  const size = fs.statSync(video).size;
  const bytes = fs.readFileSync(index);
  const entries: FragmentEntry[] = [];
  let prefixBytes = 0;
  for (let at = 0; at < bytes.length; ) {
    const next = bytes.indexOf(10, at);
    if (next === -1) break; // A committed index line includes its LF.
    let entry: FragmentEntry;
    try {
      entry = FragmentEntry.parse(JSON.parse(bytes.subarray(at, next).toString("utf8")));
    } catch {
      break;
    }
    const prev = entries.at(-1);
    if (
      entry.seq !== entries.length + 1 ||
      entry.endOffset > size ||
      (prev && (entry.moofOffset < prev.endOffset || entry.startMicros < prev.endMicros))
    )
      break;
    entries.push(entry);
    prefixBytes = next + 1;
    at = next + 1;
  }
  return { entries, prefixBytes };
}
export function readFragments(dir: string): FragmentEntry[] {
  return scanFragments(dir, nodeFs).entries;
}

function formatOf(value: unknown): StreamFormat | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<StreamFormat>;
  if (
    typeof v.codec !== "string" ||
    !/^avc1\.[0-9a-f]{6}$/.test(v.codec) ||
    typeof v.width !== "number" ||
    typeof v.height !== "number" ||
    ![v.width, v.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 16_384)
  )
    return undefined;
  return { codec: v.codec, width: v.width, height: v.height };
}

// Inspect only the small suffix; a finished multi-hour video must not be loaded into memory.
// RecordingFs injects every write. Its real descriptors can also use an optional injected reader.
function hasFinalMfra(video: string, endOffset: number, fs: RecordingFs): boolean {
  if (!fs.existsSync(video)) return false;
  const size = fs.statSync(video).size;
  if (size < endOffset + 16) return false;
  const fd = fs.openSync(video, "r");
  const read =
    (fs as RecordingFs & { readSync?: typeof nodeFs.readSync }).readSync ?? nodeFs.readSync;
  try {
    const tail = Buffer.alloc(16);
    if (
      read(fd, tail, 0, 16, size - 16) !== 16 ||
      tail.readUInt32BE(0) !== 16 ||
      tail.toString("ascii", 4, 8) !== "mfro"
    )
      return false;
    const length = tail.readUInt32BE(12);
    if (length < 40 || size - length !== endOffset) return false;
    const header = Buffer.alloc(8);
    return (
      read(fd, header, 0, 8, endOffset) === 8 &&
      header.readUInt32BE(0) === length &&
      header.toString("ascii", 4, 8) === "mfra"
    );
  } finally {
    fs.closeSync(fd);
  }
}

async function muxTail(records: JournalRecord[], format: StreamFormat) {
  const target = new BufferTarget();
  const starts: number[] = [];
  const output = new Output({
    target,
    format: new Mp4OutputFormat({
      fastStart: "fragmented",
      minimumFragmentDuration: FRAGMENT_MIN_SECONDS,
      onMoof: (_data, _offset, timestamp) => starts.push(Math.round(timestamp * MEDIA_TIMESCALE)),
    }),
  });
  const source = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(source, { frameRate: MEDIA_TIMESCALE });
  await output.start();
  for (const [i, record] of records.entries()) {
    const next = records[i + 1];
    const duration = next ? next.tMicros - record.tMicros : NOMINAL_FRAME_MICROS;
    if (duration <= 0) throw new Error("journal times must increase");
    await source.add(
      new EncodedPacket(
        record.data,
        record.key ? "key" : "delta",
        record.tMicros / MEDIA_TIMESCALE,
        duration / MEDIA_TIMESCALE,
      ),
      i === 0
        ? {
            decoderConfig: {
              codec: format.codec,
              codedWidth: format.width,
              codedHeight: format.height,
            },
          }
        : undefined,
    );
  }
  await output.finalize();
  if (!target.buffer) throw new Error("journal mux produced no data");
  const bytes = new Uint8Array(target.buffer);
  const boxes = topLevelBoxes(bytes);
  const pairs: { bytes: Uint8Array; startMicros: number; endMicros: number; frames: number }[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const moof = boxes[i];
    const mdat = boxes[i + 1];
    if (moof?.type !== "moof") continue;
    if (mdat?.type !== "mdat") throw new Error("journal mux has an incomplete fragment");
    const startMicros = starts[pairs.length];
    const endMicros =
      starts[pairs.length + 1] ?? (records.at(-1)?.tMicros ?? 0) + NOMINAL_FRAME_MICROS;
    if (startMicros === undefined) throw new Error("journal mux has no fragment timestamp");
    pairs.push({
      bytes: bytes.subarray(moof.start, mdat.start + mdat.size),
      startMicros,
      endMicros,
      frames: records.filter((r) => r.tMicros >= startMicros && r.tMicros < endMicros).length,
    });
  }
  const firstMoof = boxes.find((box) => box.type === "moof");
  if (!firstMoof || pairs.length !== starts.length)
    throw new Error("journal mux produced no complete fragments");
  return { headers: bytes.subarray(0, firstMoof.start), pairs };
}

export async function recoverRecording(
  dir: string,
  format?: StreamFormat,
  fs: RecordingFs = nodeFs,
): Promise<RecoveryResult> {
  const video = join(dir, RECORDING_VIDEO);
  const index = join(dir, RECORDING_FRAGMENTS);
  const journal = join(dir, RECORDING_JOURNAL);
  const scanned = scanFragments(dir, fs);
  const entries = scanned.entries;
  if (fs.existsSync(index)) fs.truncateSync(index, scanned.prefixBytes);
  let actualFormat = formatOf(format);
  if (!actualFormat && fs.existsSync(join(dir, RECORDING_MANIFEST))) {
    try {
      actualFormat = formatOf(JSON.parse(fs.readFileSync(join(dir, RECORDING_MANIFEST), "utf8")));
    } catch {
      /* A damaged manifest cannot identify its uncommitted tail. */
    }
  }
  const unexaminedJournal =
    !actualFormat &&
    fs.existsSync(journal) &&
    fs
      .readdirSync(journal)
      .some((name) => /^\d{16}\.bin$/.test(name) && fs.statSync(join(journal, name)).size > 0);
  const records: JournalRecord[] = [];
  if (actualFormat && fs.existsSync(journal)) {
    for (const name of fs
      .readdirSync(journal)
      .filter((n) => /^\d{16}\.bin$/.test(n))
      .sort())
      records.push(...decodeJournal(fs.readFileSync(join(journal, name))));
  }
  const cutoff = entries.at(-1)?.endMicros ?? 0;
  const newer = records.filter((r) => r.tMicros >= cutoff);
  const firstKey = newer.findIndex((r) => r.key);
  const tail = firstKey === -1 ? [] : newer.slice(firstKey);
  let tailFrames = 0;
  const result = (finalized: boolean): RecoveryResult => ({
    state: entries.length ? "recovered" : "failed",
    finalized,
    fragments: entries.length,
    tailFrames,
    bytes: fs.existsSync(video) ? fs.statSync(video).size : 0,
    firstMicros: entries[0]?.startMicros ?? null,
    lastMicros: entries.at(-1)?.endMicros ?? null,
  });
  // Missing metadata is not evidence that the journal is empty. Retain opaque tail bytes for a later retry.
  if (unexaminedJournal) return result(false);
  const keepPrefix = () => {
    const end = entries.at(-1)?.endOffset;
    if (end === undefined) {
      if (fs.existsSync(video)) fs.rmSync(video);
    } else fs.truncateSync(video, end);
  };
  if (
    entries.length &&
    tail.length === 0 &&
    hasFinalMfra(video, entries.at(-1)?.endOffset ?? 0, fs)
  ) {
    fs.rmSync(journal, { recursive: true, force: true });
    return result(true);
  }
  keepPrefix();
  try {
    if (tail.length && actualFormat) {
      const muxed = await muxTail(tail, actualFormat);
      if (!entries.length) fs.appendFileSync(video, muxed.headers);
      for (const pair of muxed.pairs) {
        const indexBefore = fs.existsSync(index) ? fs.statSync(index).size : 0;
        const moofOffset = fs.statSync(video).size;
        try {
          fs.appendFileSync(video, pair.bytes);
          const entry: FragmentEntry = {
            seq: entries.length + 1,
            moofOffset,
            endOffset: moofOffset + pair.bytes.length,
            startMicros: pair.startMicros,
            endMicros: pair.endMicros,
          };
          fs.appendFileSync(index, `${JSON.stringify(entry)}\n`);
          entries.push(entry);
          tailFrames += pair.frames;
        } catch (error) {
          if (fs.existsSync(index)) fs.truncateSync(index, indexBefore);
          keepPrefix();
          throw error;
        }
      }
    }
    if (!entries.length) {
      keepPrefix();
      fs.rmSync(journal, { recursive: true, force: true });
      return result(false);
    }
    fs.appendFileSync(video, mfraBox(entries));
    fs.rmSync(journal, { recursive: true, force: true });
    return result(true);
  } catch {
    keepPrefix(); // Includes a torn initialization segment or final random-access box.
    return result(false); // Journals remain for a later retry with available space.
  }
}
