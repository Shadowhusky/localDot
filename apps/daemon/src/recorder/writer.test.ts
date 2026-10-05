import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FragmentEntry, MEDIA_TIMESCALE } from "@localdot/protocol";
import { SYNTH_CODEC, synthFrame, synthStream } from "@localdot/stage/testing";
import { BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { topLevelBoxes } from "./boxes.ts";
import { decodeJournal } from "./journal.ts";
import { type RecordingFs, RecordingWriter } from "./writer.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing expected recording value");
  return value;
}

const roots: string[] = [];
const writers: RecordingWriter[] = [];
const options = { widthMbs: 8, heightMbs: 8, keyEvery: 12 };
function setup(overrides: { fs?: RecordingFs; onCommit?: (entry: FragmentEntry) => void } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), "localdot-writer-"));
  roots.push(dir);
  const writer = new RecordingWriter({
    dir,
    codec: SYNTH_CODEC,
    width: 128,
    height: 128,
    ...overrides,
  });
  writers.push(writer);
  return { dir, writer };
}
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function readPackets(dir: string) {
  const input = new Input({
    source: new BufferSource(fs.readFileSync(join(dir, "video.mp4"))),
    formats: [MP4],
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("recording has no video track");
    const packets = [];
    for await (const p of new EncodedPacketSink(track).packets()) packets.push(p);
    return packets;
  } finally {
    input.dispose();
  }
}

describe("RecordingWriter", () => {
  it.each([false, true])(
    "owns admitted frame bytes even when a producer reuses its buffer (%s)",
    async (buffer) => {
      const { writer, dir } = setup();
      await writer.start();
      const original = synthFrame(options, 0);
      const data = buffer ? Buffer.from(original.data) : new Uint8Array(original.data);
      const accepted = writer.push({ tMicros: 0, key: true, data });
      data.fill(0);
      expect(await accepted).toBe(true);
      const journal = required(fs.readdirSync(join(dir, "journal"))[0]);
      const saved = required(decodeJournal(fs.readFileSync(join(dir, "journal", journal)))[0]);
      expect([...saved.data]).toEqual([...original.data]);
      await writer.finish(16_667);
      expect((await readPackets(dir))[0]?.type).toBe("key");
    },
  );
  it("keeps close terminal when the muxer is still starting", async () => {
    let didOpen: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      didOpen = resolve;
    });
    let appends = 0;
    let closed = 0;
    const observedFs: RecordingFs = {
      ...fs,
      openSync: ((...args: Parameters<typeof fs.openSync>) => {
        const fd = fs.openSync(...args);
        required(didOpen)();
        return fd;
      }) as typeof fs.openSync,
      appendFileSync: ((...args: Parameters<typeof fs.appendFileSync>) => {
        appends++;
        return fs.appendFileSync(...args);
      }) as typeof fs.appendFileSync,
      closeSync: (fd) => {
        closed++;
        fs.closeSync(fd);
      },
    };
    const { writer } = setup({ fs: observedFs });
    const starting = writer.start();
    await opened;
    writer.close();
    await expect(starting).rejects.toThrow("closed");
    await expect(writer.push({ ...synthFrame(options, 0), tMicros: 0 })).rejects.toThrow("closed");
    expect(appends).toBe(0);
    expect(closed).toBe(1);
  });
  it("writes one fragment per GOP, each starting with its key frame", async () => {
    const { writer, dir } = setup();
    await writer.start();
    const frames = synthStream(options, 60);
    for (const f of frames) await writer.push({ ...f, tMicros: f.index * 16_667 });
    await writer.finish(60 * 16_667);
    const packets = await readPackets(dir);
    expect(packets).toHaveLength(60);
    expect(packets.map((p) => p.type)).toEqual(frames.map((f) => (f.key ? "key" : "delta")));
    expect(writer.entries).toHaveLength(5);
    expect(writer.entries.map((e) => e.startMicros)).toEqual(
      [0, 12, 24, 36, 48].map((i) => i * 16_667),
    );
    for (const entry of writer.entries) expect(FragmentEntry.safeParse(entry).success).toBe(true);
  });
  it("keeps exact session microseconds two hours in", async () => {
    const { writer, dir } = setup();
    await writer.start();
    const times = synthStream(options, 40).map((f) => 7_199_123_457 + f.index * 16_667);
    for (const [i, tMicros] of times.entries())
      await writer.push({ ...synthFrame(options, i), tMicros });
    await writer.finish(required(times[39]) + 16_667);
    expect((await readPackets(dir)).map((p) => p.microsecondTimestamp)).toEqual(times);
  });
  it("drops delta frames before the first key frame", async () => {
    const { writer, dir } = setup();
    await writer.start();
    const before = fs.statSync(join(dir, "video.mp4")).size;
    expect(await writer.push({ ...synthFrame(options, 1), tMicros: 50 })).toBe(false);
    expect(writer.lastMicros).toBeNull();
    expect(fs.statSync(join(dir, "video.mp4")).size).toBe(before);
    expect(fs.readdirSync(join(dir, "journal"))).toEqual([]);
    expect(await writer.push({ ...synthFrame(options, 0), tMicros: 100 })).toBe(true);
    const journals = fs.readdirSync(join(dir, "journal"));
    expect(journals).toHaveLength(1);
    expect(
      decodeJournal(fs.readFileSync(join(dir, "journal", required(journals[0]))))[0]?.tMicros,
    ).toBe(100);
  });
  it("never lets time run backwards", async () => {
    const { writer, dir } = setup();
    await writer.start();
    for (const [i, tMicros] of [1_000_000, 1_000_000, 999_995].entries())
      await writer.push({ ...synthFrame(options, i), tMicros });
    await writer.finish(1_010_000);
    expect((await readPackets(dir)).map((p) => p.microsecondTimestamp)).toEqual([
      1_000_000, 1_000_001, 1_000_002,
    ]);
    expect(writer.lastMicros).toBe(1_000_002);
  });
  it("indexes a fragment only after its bytes are on disk, and deletes its journal then", async () => {
    const observed: FragmentEntry[] = [];
    let dir = "";
    const created = setup({
      onCommit: (entry) => {
        expect(fs.statSync(join(dir, "video.mp4")).size).toBeGreaterThanOrEqual(entry.endOffset);
        const index = fs
          .readFileSync(join(dir, "fragments.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        expect(index.at(-1)).toEqual(entry);
        observed.push(entry);
      },
    });
    dir = created.dir;
    const writer = created.writer;
    await writer.start();
    for (const f of synthStream(options, 14))
      await writer.push({ ...f, tMicros: f.index * 16_667 });
    expect(writer.entries).toHaveLength(1);
    expect(observed).toHaveLength(1);
    expect(fs.statSync(join(dir, "video.mp4")).size).toBeGreaterThanOrEqual(
      required(writer.entries[0]).endOffset,
    );
    const journalStarts = fs.readdirSync(join(dir, "journal")).map((n) => Number(n.slice(0, -4)));
    expect(journalStarts).toEqual([12 * 16_667]);
    expect(writer.committedBytes).toBe(required(writer.entries[0]).endOffset);
  });
  it("gives the last frame the duration up to finish or the idle flush", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await writer.push({ ...synthFrame(options, 0), tMicros: 1_000_000 });
    await writer.push({ ...synthFrame(options, 1), tMicros: 1_010_000 });
    await writer.flushIdle(3_000_000);
    await writer.finish(5_000_000);
    const packets = await readPackets(dir);
    expect(packets).toHaveLength(2);
    expect(Math.round(required(packets[1]).duration * MEDIA_TIMESCALE)).toBe(1_990_000);
  });
  it("removes the journal and leaves a file with mediabunny's own mfra after finish", async () => {
    const { writer, dir } = setup();
    await writer.start();
    await writer.push({ ...synthFrame(options, 0), tMicros: 0 });
    await writer.finish(1_000_000);
    expect(fs.existsSync(join(dir, "journal"))).toBe(false);
    const bytes = fs.readFileSync(join(dir, "video.mp4"));
    expect(bytes.subarray(-12, -8).toString()).toBe("mfro");
    expect(topLevelBoxes(bytes).at(-1)?.type).toBe("mfra");
    expect(writer.committedBytes).toBe(writer.entries.at(-1)?.endOffset);
  });
  it("handles short disk writes without indexing unwritten bytes", async () => {
    const shortFs: RecordingFs = {
      ...fs,
      writeSync: ((
        fd: number,
        data: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) => fs.writeSync(fd, data, offset, Math.min(length, 37), position)) as typeof fs.writeSync,
    };
    const { writer, dir } = setup({ fs: shortFs });
    await writer.start();
    for (const f of synthStream(options, 15))
      await writer.push({ ...f, tMicros: f.index * 16_667 });
    await writer.finish(15 * 16_667);
    expect(await readPackets(dir)).toHaveLength(15);
    expect(writer.entries.at(-1)?.endOffset).toBeLessThanOrEqual(
      fs.statSync(join(dir, "video.mp4")).size,
    );
  });
  it("retains the original journal error and rejects every later operation with it", async () => {
    const error = Object.assign(new Error("no space"), { code: "ENOSPC" });
    let fail = false;
    const failingFs: RecordingFs = {
      ...fs,
      appendFileSync: ((...args: Parameters<typeof fs.appendFileSync>) => {
        if (fail) throw error;
        return fs.appendFileSync(...args);
      }) as typeof fs.appendFileSync,
    };
    const { writer, dir } = setup({ fs: failingFs });
    await writer.start();
    await writer.push({ ...synthFrame(options, 0), tMicros: 0 });
    fail = true;
    await expect(writer.push({ ...synthFrame(options, 1), tMicros: 100 })).rejects.toBe(error);
    expect(writer.failed).toBe(true);
    expect(fs.readdirSync(join(dir, "journal"))).toHaveLength(1);
    for (const operation of [
      writer.start(),
      writer.push({ ...synthFrame(options, 1), tMicros: 200 }),
      writer.flushIdle(300),
      writer.finish(400),
    ])
      await expect(operation).rejects.toBe(error);
  });
});
