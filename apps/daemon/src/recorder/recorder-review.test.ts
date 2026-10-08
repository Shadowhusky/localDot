import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalDotEvent } from "@localdot/protocol";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../agent/session.ts";
import { EventLog } from "../event-log.ts";
import { decodeJournal } from "./journal.ts";
import { Recorder } from "./recorder.ts";
import { SessionRecorder } from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";
import type { RecordingFs } from "./writer.ts";

const synth = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "owned review fixture cleanup failed");
});
function journalTimes(dir: string): number[] {
  try {
    return readdirSync(join(dir, "journal"))
      .sort()
      .flatMap((name) =>
        decodeJournal(readFileSync(join(dir, "journal", name))).map((packet) => packet.tMicros),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function packetTimes(file: string): Promise<number[]> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("positive fixture missing video track");
    const out: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets())
      out.push(packet.microsecondTimestamp);
    return out;
  } finally {
    input.dispose();
  }
}
function setup() {
  const home = mkdtempSync(join(tmpdir(), "task10-review-"));
  const clock = { now: 0, nowMicros: () => clock.now };
  const log = new EventLog(home, clock);
  const id = log.createSession("Inert recording privacy fixture");
  const session = new AgentSession(id, "owned-cell", "Synthetic task", log);
  session.beginBrain();
  const feed = new FakeFeed();
  const recorder = new Recorder({
    home,
    eventLog: log,
    clock,
    cells: { get: () => undefined, endpoints: () => undefined },
    feedFor: (_cell, handlers) => feed.attach(handlers),
    freeBytes: () => 1024 ** 4,
    startTimeoutMs: 1,
  });
  cleanups.push(async () => {
    session.stop();
    await recorder.stopAll();
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    clock,
    log,
    id,
    session,
    feed,
    recorder,
    dir: join(home, "sessions", id, "recording"),
  };
}
async function settleFrames() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function take(s: ReturnType<typeof setup>, t: number) {
  s.clock.now = t;
  const pending = s.session
    .takeover("login", "Inert manual fixture")
    .catch(() => ({ by: "stop" as const }));
  await settleFrames();
  expect(s.session.manualControl).toBe("ready");
  expect(s.session.controlHeld).toBe(true);
  expect(s.log.read(s.id).some((event) => event.type === "takeover.request")).toBe(true);
  return { pending };
}

describe("independent actual session recorder privacy", () => {
  it("does not journal actual AgentSession user-control frames", async () => {
    const s = setup();
    await s.recorder.start("owned-cell", s.id);
    s.feed.frame(synthFrame(synth, 0), 500, 64, 64);
    await settleFrames();
    expect(journalTimes(s.dir)).toEqual([500]);
    await take(s, 1000);
    s.feed.frame(synthFrame(synth, 1), 1000, 64, 64);
    s.feed.frame(synthFrame(synth, 2), 1100, 64, 64);
    await settleFrames();
    expect(journalTimes(s.dir).filter((t) => t >= 1000)).toEqual([]);
  });

  it("folds actual held-takeover backlog before admitting the first key", async () => {
    const s = setup();
    await take(s, 1000);
    await s.recorder.start("owned-cell", s.id);
    s.feed.frame(synthFrame(synth, 0), 1100, 64, 64);
    await settleFrames();
    expect(journalTimes(s.dir)).toEqual([]);
  });

  it("requires a fresh key after actual handback while preserving pre-take pixels", async () => {
    const s = setup();
    await s.recorder.start("owned-cell", s.id);
    s.feed.frame(synthFrame(synth, 0), 500, 64, 64);
    await settleFrames();
    const taking = await take(s, 1000);
    s.clock.now = 2000;
    expect(await s.session.handback(s.session.pendingTakeover as string, undefined)).toBe(true);
    await taking.pending;
    s.feed.frame(synthFrame(synth, 1), 2000, 64, 64);
    s.feed.frame(synthFrame(synth, 10), 2200, 64, 64);
    s.clock.now = 3000;
    await s.recorder.stop(s.id);
    expect(await packetTimes(join(s.dir, "video.mp4"))).toEqual([500, 2200]);
  });

  it("judges queued older frames by their timestamp and drops synthetic control user-era bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "task10-review-queue-"));
    const dir = join(root, "recording");
    const feed = new FakeFeed();
    let listener: ((event: LocalDotEvent) => void) | undefined;
    const written: number[] = [];
    const spy: RecordingFs = {
      ...fs,
      appendFileSync: ((file: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
        if (String(file).includes(`${join("recording", "journal")}`) && typeof data !== "string")
          written.push(...decodeJournal(data).map((packet) => packet.tMicros));
        fs.appendFileSync(file, data);
      }) as typeof fs.appendFileSync,
    };
    const rec = new SessionRecorder({
      sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      dir,
      feed: (handlers) => feed.attach(handlers),
      toSessionT: (t) => t,
      freeBytes: () => 1024 ** 4,
      fs: spy,
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    });
    cleanups.push(async () => {
      await rec.stop(5000);
      rmSync(root, { recursive: true, force: true });
    });
    await rec.start();
    const control = (seq: number, t: number, holder: "user" | "agent") =>
      ({
        v: 1,
        id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
        seq,
        t,
        agent: "main",
        type: "control.change",
        data: { holder, reason: holder === "user" ? "user_takeover" : "resume" },
      }) as LocalDotEvent;
    feed.frame(synthFrame(synth, 0), 500, 64, 64);
    feed.frame(synthFrame(synth, 1), 900, 64, 64);
    listener?.(control(1, 1000, "user"));
    feed.frame(synthFrame(synth, 2), 1000, 64, 64);
    feed.handlers?.onState("lost");
    listener?.(control(2, 2000, "agent"));
    feed.handlers?.onState("live");
    feed.frame(synthFrame(synth, 3), 2100, 64, 64);
    feed.frame(synthFrame(synth, 10), 2200, 64, 64);
    await rec.drain();
    expect(written).toEqual([500, 900, 2200]);
    await rec.stop(3000);
    expect(await packetTimes(join(dir, "video.mp4"))).toEqual([500, 900, 2200]);
    expect(rec.manifest.gaps).toContainEqual({ from: 1000, to: 2200, reason: "user-control" });
  });
});
