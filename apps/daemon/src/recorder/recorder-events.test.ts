import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalDotEvent } from "@localdot/protocol";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { Recorder, tapSessionEvents } from "./recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";

const o = { widthMbs: 4, heightMbs: 4, keyEvery: 15 };
const at = (i: number) => 500_000 + i * 16_667;
const TAKE = 1_000_000;
const takeover = {
  type: "control.change",
  agent: "main",
  data: { holder: "user", reason: "user_takeover" },
} as const;

async function recordedTimes(file: string): Promise<number[]> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
  const t: number[] = [];
  for await (const p of sink.packets()) t.push(p.microsecondTimestamp);
  input.dispose();
  return t;
}

// A Recorder on a real EventLog whose clock the test sets, so session t is the clock's µs.
// `wrap` may stand in for the log the Recorder sees.
function setup(wrap?: (log: EventLog) => EventLog) {
  const home = mkdtempSync(join(tmpdir(), "local dot's gate-start-"));
  const clock: { now: number; nowMicros(): number } = { now: 0, nowMicros: () => clock.now };
  const log = new EventLog(home, clock);
  const id = log.createSession("gate race");
  const feed = new FakeFeed();
  const recorder = new Recorder({
    home,
    eventLog: wrap ? wrap(log) : log,
    cells: { get: () => undefined, endpoints: () => undefined },
    clock,
    freeBytes: () => 1024 ** 4,
    feedFor: (_cell, h) => feed.attach(h),
    startTimeoutMs: 20,
  });
  const result = { home, clock, log, id, feed, recorder };
  ownedSetups.push(result);
  return result;
}

async function recordAcrossTheTakeover(s: ReturnType<typeof setup>): Promise<void> {
  for (let i = 0; i < 90; i++) s.feed.frame(synthFrame(o, i), at(i), 64, 64);
  s.clock.now = at(90);
  await s.recorder.stop(s.id);
  const times = await recordedTimes(join(s.home, "sessions", s.id, "recording", "video.mp4"));
  expect(times.length).toBeGreaterThan(0);
  expect(times.every((t) => t < TAKE)).toBe(true);
  expect(s.recorder.info(s.id)?.manifest.gaps).toEqual([
    { from: TAKE, to: null, reason: "user-control" },
  ]);
}

describe("the gate sees every control change from the moment recording starts (I4, full tier)", () => {
  it("closes the gate for a takeover appended while the recorder starts", async () => {
    const s = setup();
    s.clock.now = TAKE;
    const starting = s.recorder.start("cell", s.id); // runs synchronously up to its first await
    s.log.append(s.id, takeover);
    await starting;
    await recordAcrossTheTakeover(s);
  });

  it("never loses a takeover appended between reading the backlog and subscribing", async () => {
    // read() lets an append land just after its snapshot: a recorder that read first and
    // subscribed after would find the takeover in neither.
    const s = setup(
      (log) =>
        new Proxy(log, {
          get(target, key) {
            if (key === "read") {
              return (sessionId: string, fromSeq?: number) => {
                const events = target.read(sessionId, fromSeq);
                target.append(sessionId, takeover);
                return events;
              };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
    s.clock.now = TAKE;
    await s.recorder.start("cell", s.id);
    await recordAcrossTheTakeover(s);
  });

  it("subscribes before it reads, replays what it buffered, then forwards only the session's events", () => {
    const calls: string[] = [];
    const listenerHolder: { current: ((sessionId: string, e: LocalDotEvent) => void) | null } = {
      current: null,
    };
    const ev = (seq: number, sid = "A") =>
      [sid, { seq, type: "agent.state" } as unknown as LocalDotEvent] as const;
    const log = {
      subscribe(l: (sessionId: string, e: LocalDotEvent) => void) {
        calls.push("subscribe");
        listenerHolder.current = l;
        return () => {
          listenerHolder.current = null;
        };
      },
      read(_sid: string) {
        calls.push("read");
        listenerHolder.current?.(...ev(1)); // appended while the backlog is read: in both
        listenerHolder.current?.(...ev(1, "B"));
        return [ev(0)[1], ev(1)[1]];
      },
    };
    const tap = tapSessionEvents(log as never, "A");
    expect(calls).toEqual(["subscribe", "read"]);
    listenerHolder.current?.(...ev(2)); // appended before the consumer subscribes: buffered
    const got: number[] = [];
    tap.subscribe((e) => void got.push(e.seq));
    listenerHolder.current?.(...ev(3));
    listenerHolder.current?.(...ev(4, "B"));
    expect(tap.backlog.map((e) => e.seq)).toEqual([0, 1]);
    expect(got).toEqual([1, 2, 3]); // the consumer drops seq 1, which it folded from the backlog
  });
});

const ownedSetups: { home: string; recorder: Recorder; log: EventLog }[] = [];
afterEach(async () => {
  for (const s of ownedSetups.splice(0)) {
    await s.recorder.stopAll();
    s.log.close();
    rmSync(s.home, { recursive: true, force: true });
  }
});
