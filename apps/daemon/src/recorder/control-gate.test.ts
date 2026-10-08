import * as fs from "node:fs";
import { rmSync as cleanupDir, mkdtempSync as makeTemp, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalDotEvent } from "@localdot/protocol";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { ControlGate } from "./control-gate.ts";
import { decodeJournal } from "./journal.ts";
import { recoverRecording } from "./recover.ts";
import { SessionRecorder as ProductionSessionRecorder } from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";
import type { RecordingFs } from "./writer.ts";

const o = { widthMbs: 4, heightMbs: 4, keyEvery: 15 };
const at = (i: number) => 500_000 + i * 16_667;
const TAKE = 1_000_000;
const GIVE = 2_000_000;
let seq = 0;
const control = (t: number, holder: "user" | "agent"): LocalDotEvent =>
  ({
    v: 1,
    id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    seq: seq++,
    t,
    agent: "main",
    type: "control.change",
    data: { holder, reason: holder === "user" ? "user_takeover" : "resume" },
  }) as LocalDotEvent;

// Every byte the recorder appends to its journal, decoded: what a crash would leave behind.
function journalSpy(): RecordingFs & { journaled: number[] } {
  const journaled: number[] = [];
  return {
    ...fs,
    journaled,
    appendFileSync: ((file: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
      if (String(file).includes(`${join("recording", "journal")}`) && typeof data !== "string")
        for (const r of decodeJournal(data)) journaled.push(r.tMicros);
      fs.appendFileSync(file, data);
    }) as typeof fs.appendFileSync,
  };
}

async function recordedTimes(file: string): Promise<number[]> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
  const t: number[] = [];
  for await (const p of sink.packets()) t.push(p.microsecondTimestamp);
  input.dispose();
  return t;
}

describe("the takeover privacy gate (Review Focus 6, full tier)", () => {
  it("keeps recording fenced when Stop ends an actual takeover", () => {
    const gate = new ControlGate();
    const requestId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
    const base = { v: 1 as const, id: requestId, agent: "main" };
    expect(
      gate.observe({
        ...base,
        seq: 0,
        t: TAKE,
        type: "takeover.request",
        data: { requestId, reason: "login", note: "Private manual control" },
      }),
    ).toBe("took");
    expect(
      gate.observe({
        ...base,
        seq: 1,
        t: GIVE,
        type: "takeover.end",
        data: { requestId, by: "stop" },
      }),
    ).toBeNull();
    expect(gate.userHasControl).toBe(true);
    expect(gate.admit(GIVE + 1, true)).toBe(false);
    expect(gate.gaps).toEqual([{ from: TAKE, to: null, reason: "user-control" }]);
  });
  it("records nothing while the user has control, not even in the journal, and resumes at a key frame", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's gate-")), "recording");
    const feed = new FakeFeed();
    const spy = journalSpy();
    const listeners: ((e: LocalDotEvent) => void)[] = [];
    const rec = new SessionRecorder({
      sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      dir,
      feed: (h) => feed.attach(h),
      toSessionT: (us) => us,
      freeBytes: () => 1024 ** 4,
      fs: spy,
      subscribe: (l) => {
        listeners.push(l);
        return () => {};
      },
    });
    await rec.start();
    const frames = Array.from({ length: 150 }, (_, i) => i);
    let took = false;
    let requestsWhenGiven = -1;
    for (const i of frames) {
      // The control changes reach the log between frames, as M5's routes append them.
      if (!took && at(i) >= TAKE) {
        took = true;
        for (const l of listeners) l(control(TAKE, "user"));
      }
      if (requestsWhenGiven < 0 && at(i) >= GIVE) {
        requestsWhenGiven = feed.keyRequests.length;
        for (const l of listeners) l(control(GIVE, "agent"));
      }
      feed.frame(synthFrame(o, i), at(i), 64, 64);
    }
    await rec.drain();
    const firstKeyBack = frames.map(at).find((t, i) => t >= GIVE && i % o.keyEvery === 0) as number;
    const userEra = (t: number) => t >= TAKE && t < firstKeyBack;
    expect(spy.journaled.filter(userEra)).toEqual([]);
    expect(feed.keyRequests.length).toBeGreaterThan(requestsWhenGiven);
    await rec.stop(at(150));
    const recorded = await recordedTimes(join(dir, "video.mp4"));
    expect(recorded.filter(userEra)).toEqual([]);
    expect(recorded).toEqual(frames.map(at).filter((t) => !userEra(t)));
    expect(rec.manifest.gaps).toEqual([{ from: TAKE, to: firstKeyBack, reason: "user-control" }]);
  });

  it("leaves no user frame on disk when the daemon dies during a takeover", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's gate-crash-")), "recording");
    const feed = new FakeFeed();
    const rec = new SessionRecorder({
      sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      dir,
      feed: (h) => feed.attach(h),
      toSessionT: (us) => us,
      freeBytes: () => 1024 ** 4,
      backlog: [control(TAKE, "user")],
    });
    await rec.start();
    for (let i = 0; i < 90; i++) feed.frame(synthFrame(o, i), at(i), 64, 64);
    await rec.drain();
    // No stop(): the process is gone. Recovery works from what is on disk.
    await recoverRecording(dir);
    const files = readdirSync(dir);
    expect(files).not.toContain("journal");
    expect((await recordedTimes(join(dir, "video.mp4"))).every((t) => t < TAKE)).toBe(true);
  });

  it("judges frames by their own time, whatever order they and the control change are processed in", () => {
    const gate = new ControlGate();
    expect(gate.admit(999_999, false)).toBe(true);
    gate.observe(control(TAKE, "user"));
    expect(gate.admit(999_999, false)).toBe(true);
    expect(gate.admit(TAKE, true)).toBe(false);
    gate.observe(control(GIVE, "agent"));
    expect(gate.admit(GIVE - 1, true)).toBe(false);
    expect(gate.admit(GIVE + 10, false)).toBe(false);
    expect(gate.admit(GIVE + 20, true)).toBe(true);
    expect(gate.admit(GIVE + 30, false)).toBe(true);
    expect(gate.gaps).toEqual([{ from: TAKE, to: GIVE + 20, reason: "user-control" }]);
  });

  it("keeps one gap when control is taken again before the video came back", () => {
    const gate = new ControlGate();
    gate.observe(control(TAKE, "user"));
    gate.observe(control(GIVE, "agent"));
    expect(gate.admit(GIVE + 50, false)).toBe(false);
    gate.observe(control(GIVE + 100, "user"));
    gate.observe(control(GIVE + 500, "agent"));
    expect(gate.admit(GIVE + 300, true)).toBe(false);
    expect(gate.admit(GIVE + 600, true)).toBe(true);
    expect(gate.gaps).toEqual([{ from: TAKE, to: GIVE + 600, reason: "user-control" }]);
  });

  it("keeps two gaps when a key frame came back between two takeovers", () => {
    const gate = new ControlGate();
    for (const e of [
      control(TAKE, "user"),
      control(GIVE, "agent"),
      control(GIVE + 100, "user"),
      control(GIVE + 500, "agent"),
    ])
      gate.observe(e);
    expect(gate.admit(GIVE + 50, true)).toBe(true);
    expect(gate.admit(GIVE + 600, true)).toBe(true);
    expect(gate.gaps).toEqual([
      { from: TAKE, to: GIVE + 50, reason: "user-control" },
      { from: GIVE + 100, to: GIVE + 600, reason: "user-control" },
    ]);
  });
});

const ownedRoots: string[] = [];
const ownedRecorders: ProductionSessionRecorder[] = [];
function mkdtempSync(prefix: string): string {
  const dir = makeTemp(prefix);
  ownedRoots.push(dir);
  return dir;
}
class SessionRecorder extends ProductionSessionRecorder {
  constructor(...args: ConstructorParameters<typeof ProductionSessionRecorder>) {
    super(...args);
    ownedRecorders.push(this);
  }
}
afterEach(async () => {
  for (const rec of ownedRecorders.splice(0)) await rec.stop(8_000_000_000);
  for (const dir of ownedRoots.splice(0)) cleanupRoot(dir);
});

function cleanupRoot(dir: string): void {
  cleanupDir(dir, { recursive: true, force: true });
}
