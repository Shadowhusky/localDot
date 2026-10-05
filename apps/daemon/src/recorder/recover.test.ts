import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTH_CODEC, synthFrame, synthStream } from "@localdot/stage/testing";
import { BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { encodeJournalRecord } from "./journal.ts";
import { readFragments, recoverRecording } from "./recover.ts";
import { fullAfter } from "./testing/full-fs.ts";
import { NoFragmentsError, openRecordingView, type RecordingView } from "./view.ts";
import { RecordingWriter } from "./writer.ts";

const format = { codec: SYNTH_CODEC, width: 64, height: 64 };
const options = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
const roots: string[] = [];
const writers: RecordingWriter[] = [];
const views: RecordingView[] = [];
function setup() {
  const dir = fs.mkdtempSync(join(tmpdir(), "localdot-recovery-"));
  roots.push(dir);
  const writer = new RecordingWriter({ dir, ...format });
  writers.push(writer);
  return { dir, writer };
}
async function push(writer: RecordingWriter, count: number, from = 0) {
  for (const f of synthStream(options, count).slice(from))
    await writer.push({ ...f, tMicros: 1_000_000 + f.index * 16_667 });
}
async function packets(dir: string) {
  const input = new Input({
    source: new BufferSource(fs.readFileSync(join(dir, "video.mp4"))),
    formats: [MP4],
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("missing recovered video");
    const out = [];
    for await (const p of new EncodedPacketSink(track).packets()) out.push(p);
    return out;
  } finally {
    input.dispose();
  }
}
afterEach(() => {
  for (const view of views.splice(0)) view.close();
  for (const writer of writers.splice(0)) writer.close();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("recording recovery", () => {
  it("leaves a finished recording alone apart from its journal", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await push(writer, 25);
    await writer.finish(1_500_000);
    const before = fs.readFileSync(join(dir, "video.mp4"));
    const result = await recoverRecording(dir, format);
    expect(result.finalized).toBe(true);
    expect(fs.readFileSync(join(dir, "video.mp4"))).toEqual(before);
    expect(await packets(dir)).toHaveLength(25);
  });
  it("rebuilds a recording from the journal alone", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await push(writer, 2);
    writer.close();
    expect(readFragments(dir)).toEqual([]);
    const result = await recoverRecording(dir, format);
    expect(result).toMatchObject({
      state: "recovered",
      finalized: true,
      fragments: 1,
      tailFrames: 2,
    });
    expect((await packets(dir)).map((p) => p.microsecondTimestamp)).toEqual([1_000_000, 1_016_667]);
  });
  it("ignores a stale journal left between a commit and its journal delete", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await push(writer, 25);
    await writer.finish(1_500_000);
    fs.mkdirSync(join(dir, "journal"));
    fs.writeFileSync(
      join(dir, "journal/0000000001000000.bin"),
      encodeJournalRecord({ ...synthFrame(options, 0), tMicros: 1_000_000 }),
    );
    const result = await recoverRecording(dir, format);
    expect(result.tailFrames).toBe(0);
    expect(await packets(dir)).toHaveLength(25);
    expect(fs.existsSync(join(dir, "journal"))).toBe(false);
  });
  it("stops reading fragments.jsonl at a torn or out-of-order line", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await push(writer, 35);
    await writer.finish(1_700_000);
    const entries = [...writer.entries];
    fs.writeFileSync(
      join(dir, "fragments.jsonl"),
      `${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n{"seq":3`,
    );
    expect(readFragments(dir)).toEqual(entries.slice(0, 2));
    fs.writeFileSync(
      join(dir, "fragments.jsonl"),
      `${JSON.stringify(entries[0])}\n${JSON.stringify({ ...entries[1], moofOffset: 0 })}\n`,
    );
    expect(readFragments(dir)).toEqual(entries.slice(0, 1));
  });
  for (const count of [2, 23]) {
    it(`preserves ${count} admitted frames until missing format metadata becomes available`, async () => {
      const { writer, dir } = setup();
      await writer.start();
      await push(writer, count);
      writer.close();
      const videoBefore = fs.readFileSync(join(dir, "video.mp4"));
      const journalBefore = fs
        .readdirSync(join(dir, "journal"))
        .sort()
        .map((name) => ({
          name,
          bytes: fs.readFileSync(join(dir, "journal", name)),
        }));
      const entriesBefore = readFragments(dir);
      const initial = await recoverRecording(dir);
      expect(initial).toMatchObject({
        state: entriesBefore.length ? "recovered" : "failed",
        finalized: false,
        fragments: entriesBefore.length,
        tailFrames: 0,
      });
      expect(fs.readFileSync(join(dir, "video.mp4"))).toEqual(videoBefore);
      expect(
        fs
          .readdirSync(join(dir, "journal"))
          .sort()
          .map((name) => ({
            name,
            bytes: fs.readFileSync(join(dir, "journal", name)),
          })),
      ).toEqual(journalBefore);
      expect(readFragments(dir)).toEqual(entriesBefore);
      const retry = await recoverRecording(dir, format);
      expect(retry.finalized).toBe(true);
      expect((await packets(dir)).map((p) => p.microsecondTimestamp)).toEqual(
        Array.from({ length: count }, (_, i) => 1_000_000 + i * 16_667),
      );
    });
  }
  it("gives a two-GOP journal tail two fragments, each starting with its key frame", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await push(writer, 11);
    writer.close();
    expect(readFragments(dir)).toEqual([]);
    const result = await recoverRecording(dir, format);
    expect(result.fragments).toBe(2);
    const got = await packets(dir);
    expect(got.map((p) => p.type)).toEqual(
      Array.from({ length: 11 }, (_, i) => (i % 10 === 0 ? "key" : "delta")),
    );
    const input = new Input({
      source: new BufferSource(fs.readFileSync(join(dir, "video.mp4"))),
      formats: [MP4],
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("missing track");
      expect(
        (await new EncodedPacketSink(track).getKeyPacket(1.166671))?.microsecondTimestamp,
      ).toBe(1_166_670);
    } finally {
      input.dispose();
    }
  });
  it("retries an unfinalized recovery and appends the tail it could not write", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await push(writer, 25);
    writer.close();
    const first = await recoverRecording(dir, format, fullAfter(1, { torn: true }));
    expect(first).toMatchObject({ state: "recovered", finalized: false });
    expect(fs.existsSync(join(dir, "journal"))).toBe(true);
    const second = await recoverRecording(dir, format);
    expect(second.finalized).toBe(true);
    expect(await packets(dir)).toHaveLength(25);
  });
  it("reports no fragments before the first commit instead of exposing a partial file", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await push(writer, 2);
    expect(() => openRecordingView(dir, { complete: false, entries: writer.entries })).toThrow(
      NoFragmentsError,
    );
  });
  it("keeps a live snapshot byte-stable when the writer commits later fragments", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await push(writer, 14);
    const view = openRecordingView(dir, { complete: false, entries: writer.entries });
    views.push(view);
    const before = view.read(0, view.size);
    await push(writer, 34, 14);
    expect(view.read(0, view.size)).toEqual(before);
    expect(view.read(0, 0)).toEqual(new Uint8Array());
    expect(() => view.read(-1, 0)).toThrow(RangeError);
  });
});
