import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input, StreamSource } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { readFragments, recoverRecording } from "./recover.ts";
import { fullAfter } from "./testing/full-fs.ts";
import { openRecordingView, type RecordingView } from "./view.ts";
import { RecordingWriter } from "./writer.ts";

const directories: string[] = [];
function temporaryDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Every packet time a reader of the served view gets, in order.
async function packetTimes(view: RecordingView): Promise<number[]> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new StreamSource({ getSize: () => view.size, read: (s, e) => view.read(s, e) }),
  });
  const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
  const t: number[] = [];
  for await (const p of sink.packets()) t.push(p.microsecondTimestamp);
  input.dispose();
  return t;
}

describe("disk full (Review Focus 3), the writer", () => {
  it("fails the push with ENOSPC, stays failed, and recovery leaves every journaled frame playable", async () => {
    const o = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
    const format = { codec: SYNTH_CODEC, width: 64, height: 64 };
    const dir = temporaryDir("local dot's full-");
    const w = new RecordingWriter({ dir, ...format, fs: fullAfter(150_000) });
    await w.start();
    let pushed = 0;
    let error: unknown;
    try {
      for (let i = 0; i < 1000; i++) {
        const f = synthFrame(o, i);
        await w.push({ tMicros: 500_000 + i * 16_667, key: f.key, data: f.data });
        pushed = i + 1;
      }
    } catch (err) {
      error = err;
    }
    expect((error as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(pushed).toBeGreaterThan(20);
    expect(w.failed).toBe(true);
    await expect(
      w.push({ tMicros: 99_000_000, key: true, data: synthFrame(o, 0).data }),
    ).rejects.toThrow(/ENOSPC/);
    // Space comes back (the user frees some): recovery runs with the real filesystem.
    await recoverRecording(dir, format);
    const input = new Input({
      source: new FilePathSource(join(dir, "video.mp4")),
      formats: ALL_FORMATS,
    });
    const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
    let n = 0;
    for await (const _ of sink.packets()) n++;
    input.dispose();
    // Every pushed frame reached the journal or a fragment; the one that hit ENOSPC may too.
    expect(n).toBeGreaterThanOrEqual(pushed);
    expect(n).toBeLessThanOrEqual(pushed + 1);
  });

  it("never serves a torn recovery as finished: on a still-full disk the view plays every indexed fragment (I5)", async () => {
    const o = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
    const format = { codec: SYNTH_CODEC, width: 64, height: 64 };
    const arrival = (i: number) => 500_000 + i * 16_667;
    const failed = temporaryDir("local dot's still-full-");
    const w = new RecordingWriter({ dir: failed, ...format, fs: fullAfter(150_000) });
    await w.start();
    let pushed = 0;
    try {
      for (let i = 0; i < 1000; i++) {
        const f = synthFrame(o, i);
        await w.push({ tMicros: arrival(i), key: f.key, data: f.data });
        pushed = i + 1;
      }
    } catch {
      // ENOSPC: the writer pin above covers the error itself.
    }
    expect(w.failed).toBe(true);
    const committed = readFragments(failed);
    expect(committed.length).toBeGreaterThan(1);
    // The frames that may be on disk: every pushed one, and the one that hit ENOSPC.
    const all = Array.from({ length: pushed + 1 }, (_, i) => arrival(i));
    const outcomes = new Set<string>();
    // The disk is still full: recovery gets `room` more bytes, and its last write is torn there.
    for (let room = 0; room <= 20_000; room += 97) {
      const dir = temporaryDir("local dot's still-full-");
      cpSync(failed, dir, { recursive: true });
      const r = await recoverRecording(dir, format, fullAfter(room, { torn: true }));
      expect(r.state).toBe("recovered");
      const entries = readFragments(dir);
      expect(entries.slice(0, committed.length)).toEqual(committed);
      if (!r.finalized) {
        expect(statSync(join(dir, "video.mp4")).size).toBe(entries.at(-1)?.endOffset);
        expect(existsSync(join(dir, "journal"))).toBe(true);
      }
      outcomes.add(
        r.finalized
          ? "finalized"
          : entries.length > committed.length
            ? "tail-without-mfra"
            : "prefix-only",
      );
      // What the route serves (Task 12): the file as is only when finalized, else the indexed
      // fragments with a fresh mfra. Either way, every indexed frame plays, in order.
      const view = openRecordingView(dir, { complete: r.finalized });
      const got = await packetTimes(view);
      view.close();
      const indexedTo = entries.at(-1)?.endMicros ?? 0;
      expect(got).toEqual(all.filter((t) => t < indexedTo));
    }
    expect([...outcomes].sort()).toEqual(["finalized", "prefix-only", "tail-without-mfra"]);
    // Space comes back: the next start's recovery appends the tail and finalizes.
    const dir = temporaryDir("local dot's still-full-");
    cpSync(failed, dir, { recursive: true });
    expect((await recoverRecording(dir, format, fullAfter(0, { torn: true }))).finalized).toBe(
      false,
    );
    expect((await recoverRecording(dir, format)).finalized).toBe(true);
    const view = openRecordingView(dir, { complete: true });
    const got = await packetTimes(view);
    view.close();
    expect(got.slice(0, pushed)).toEqual(all.slice(0, pushed));
    expect(got.length).toBeLessThanOrEqual(pushed + 1);
    expect(existsSync(join(dir, "journal"))).toBe(false);
  });
});
