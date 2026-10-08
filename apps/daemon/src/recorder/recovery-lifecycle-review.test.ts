import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { decodeJournal } from "./journal.ts";
import { readManifest } from "./manifest.ts";
import { Recorder } from "./recorder.ts";
import { recoverRecording } from "./recover.ts";
import { SessionRecorder } from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";
import type { RecordingFs } from "./writer.ts";

it("retries durable journal frames after disk-full recovery could not commit the first fragment", async () => {
  const home = mkdtempSync(join(tmpdir(), "task10-review-full-retry-"));
  const clock = { now: 0, nowMicros: () => clock.now };
  const log = new EventLog(home, clock);
  const id = log.createSession("owned ENOSPC retry");
  const dir = join(home, "sessions", id, "recording");
  const feed = new FakeFeed();
  let full = false;
  const enospc = () => Object.assign(new Error("owned disk fixture"), { code: "ENOSPC" });
  const limited: RecordingFs = {
    ...fs,
    writeSync: ((...args: Parameters<typeof fs.writeSync>) => {
      if (full) throw enospc();
      return fs.writeSync(...args);
    }) as typeof fs.writeSync,
    appendFileSync: ((file: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
      if (full) throw enospc();
      return fs.appendFileSync(file, data);
    }) as typeof fs.appendFileSync,
  };
  const rec = new SessionRecorder({
    sessionId: id,
    dir,
    feed: (handlers) => feed.attach(handlers),
    toSessionT: (t) => t,
    freeBytes: () => 1024 ** 4,
    fs: limited,
  });
  const service = new Recorder({
    home,
    eventLog: log,
    clock,
    cells: { get: () => undefined, endpoints: () => undefined },
  });
  try {
    await rec.start();
    const opts = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
    feed.frame(synthFrame(opts, 0), 1000, 64, 64);
    await rec.drain();
    const initial = readdirSync(join(dir, "journal")).flatMap((name) =>
      decodeJournal(readFileSync(join(dir, "journal", name))),
    );
    expect(initial.map((frame) => frame.tMicros)).toEqual([1000]);
    full = true;
    feed.frame(synthFrame(opts, 1), 2000, 64, 64);
    feed.frame(synthFrame(opts, 10), 3_000_000, 64, 64);
    feed.frame(synthFrame(opts, 11), 3_010_000, 64, 64);
    await rec.drain();
    expect(feed.stopped).toBe(true);
    expect(rec.manifest.finalized).toBe(false);
    const retained = readdirSync(join(dir, "journal")).flatMap((name) =>
      decodeJournal(readFileSync(join(dir, "journal", name))),
    );
    expect(retained.length).toBeGreaterThan(0);
    full = false;
    const result = await service.recoverAll();
    const read = readManifest(dir);
    console.log(
      JSON.stringify({
        retained: retained.map((frame) => frame.tMicros),
        stateBefore: rec.manifest.state,
        retry: result,
        stateAfter: read?.ok && read.manifest.state,
      }),
    );
    const direct = await recoverRecording(dir);
    expect(direct).toMatchObject({ state: "recovered", finalized: true, fragments: 1 });
    const input = new Input({
      source: new FilePathSource(join(dir, "video.mp4")),
      formats: ALL_FORMATS,
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("expected retained video");
      const times: number[] = [];
      for await (const packet of new EncodedPacketSink(track).packets())
        times.push(packet.microsecondTimestamp);
      expect(times).toEqual(retained.map((frame) => frame.tMicros));
    } finally {
      input.dispose();
    }
    expect(result.recovered).toBe(1);
  } finally {
    full = false;
    await rec.stop(4_000_000);
    await service.stopAll();
    log.close();
    rmSync(home, { recursive: true, force: true });
  }
});
