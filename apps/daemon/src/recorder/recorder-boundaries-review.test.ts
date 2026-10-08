import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalDotEvent } from "@localdot/protocol";
import { synthFrame } from "@localdot/stage/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import { decodeJournal } from "./journal.ts";
import { Recorder } from "./recorder.ts";
import { SessionRecorder } from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";

const synth = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
const take = {
  type: "control.change",
  agent: "main",
  data: { holder: "user", reason: "user_takeover" },
} as const;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn();
    } catch (error) {
      failures.push(error);
    }
  }
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, "owned cleanup failed");
});
function journalTimes(dir: string) {
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
function environment() {
  const home = mkdtempSync(join(tmpdir(), "recorder-owned-boundary-"));
  const clock = { now: 0, nowMicros: () => clock.now };
  const log = new EventLog(home, clock);
  const id = log.createSession("owned boundary");
  cleanup.push(async () => {
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, clock, log, id, dir: join(home, "sessions", id, "recording") };
}
const turn = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

describe("independent recording lifecycle boundaries", () => {
  it("subscribes in the constructor so pre-start control cannot become journal bytes", async () => {
    const s = environment();
    const listeners = new Set<(event: LocalDotEvent) => void>();
    const feed = new FakeFeed();
    const rec = new SessionRecorder({
      sessionId: s.id,
      dir: s.dir,
      feed: (handlers) => feed.attach(handlers),
      toSessionT: (t) => t,
      freeBytes: () => 1024 ** 4,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    cleanup.push(async () => {
      await rec.stop(3000);
    });
    s.clock.now = 1000;
    const event = s.log.append(s.id, take);
    for (const listener of listeners) listener(event);
    await rec.start();
    feed.frame(synthFrame(synth, 0), 1100, 64, 64);
    await rec.drain();
    expect(journalTimes(s.dir)).toEqual([]);
    s.clock.now = 2000;
    const returned = s.log.append(s.id, {
      type: "control.change",
      agent: "main",
      data: { holder: "agent", reason: "resume" },
    });
    for (const listener of listeners) listener(returned);
    feed.frame(synthFrame(synth, 10), 2200, 64, 64);
    await rec.drain();
    expect(journalTimes(s.dir)).toEqual([2200]);
  });

  it("a control append during feed construction is observed before feed start", async () => {
    const s = environment();
    const feed = new FakeFeed();
    const rec = new Recorder({
      home: s.home,
      eventLog: s.log,
      clock: s.clock,
      cells: { get: () => undefined, endpoints: () => undefined },
      freeBytes: () => 1024 ** 4,
      startTimeoutMs: 1,
      feedFor: (_cell, handlers) => {
        s.clock.now = 1000;
        s.log.append(s.id, take);
        return feed.attach(handlers);
      },
    });
    cleanup.push(async () => {
      await rec.stopAll();
    });
    await rec.start("owned-cell", s.id);
    feed.frame(synthFrame(synth, 0), 500, 64, 64);
    feed.frame(synthFrame(synth, 1), 1000, 64, 64);
    await turn();
    expect(journalTimes(s.dir)).toEqual([500]);
    await rec.stopAll();
    expect(feed.stopped).toBe(true);
    expect(rec.isLive(s.id)).toBe(false);
    expect(rec.info(s.id)?.manifest.gaps).toEqual([
      { from: 1000, to: null, reason: "user-control" },
    ]);
  });

  it("Stop during real Recorder beforeRun keeps live ownership until finalization and never runs", async () => {
    const s = environment();
    const feed = new FakeFeed();
    let finalized = 0;
    const rec = new Recorder({
      home: s.home,
      eventLog: s.log,
      clock: s.clock,
      cells: { get: () => undefined, endpoints: () => undefined },
      freeBytes: () => 1024 ** 4,
      startTimeoutMs: 10,
      feedFor: (_cell, handlers) => feed.attach(handlers),
      onFinished: () => {
        finalized++;
      },
    });
    cleanup.push(async () => {
      await rec.stopAll();
    });
    const live = new LiveSessions();
    live.addHooks({
      beforeRun: (cell, id) => rec.start(cell, id),
      afterRun: (_cell, id) => rec.stop(id),
    });
    let runs = 0;
    live.start("owned-cell", s.id, async () => {
      runs++;
    });
    expect(live.get("owned-cell")).toBe(s.id);
    expect(live.stop(s.id)).toBe(true);
    expect(live.admitIdleOperation("owned-cell")).toBeUndefined();
    await live.settled(s.id);
    expect(runs).toBe(0);
    expect(finalized).toBe(1);
    expect(feed.stopped).toBe(true);
    expect(rec.isLive(s.id)).toBe(false);
    const idle = live.admitIdleOperation("owned-cell");
    expect(idle).toBeDefined();
    idle?.release();
  });

  it("a throwing feed factory releases its event subscription and hides raw diagnostics", async () => {
    const s = environment();
    let active = 0;
    const log = new Proxy(s.log, {
      get(target, key) {
        if (key === "subscribe")
          return (listener: Parameters<EventLog["subscribe"]>[0]) => {
            const unsub = target.subscribe(listener);
            active++;
            return () => {
              active--;
              unsub();
            };
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });
    const rec = new Recorder({
      home: s.home,
      eventLog: log,
      clock: s.clock,
      cells: { get: () => undefined, endpoints: () => undefined },
      freeBytes: () => 1024 ** 4,
      feedFor: () => {
        throw new Error("private fixture secret URL");
      },
    });
    cleanup.push(async () => {
      await rec.stopAll();
    });
    await rec.start("owned-cell", s.id);
    expect(active).toBe(0);
    expect(rec.isLive(s.id)).toBe(false);
    expect(errors).toEqual([["the session recorder could not start"]]);
  });
});
