import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventDraft } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { EventLog } from "./event-log.ts";

const home = () => mkdtempSync(join(tmpdir(), "local dot's log-"));
const fakeClock = (start = 0): Clock & { advance(us: number): void } => {
  let now = start;
  return {
    nowMicros: () => now,
    advance: (us) => {
      now += us;
    },
  };
};
const thinking: EventDraft = { type: "agent.state", agent: "main", data: { state: "thinking" } };

describe("EventLog", () => {
  it("appends events with increasing seq and non-decreasing t", () => {
    const clock = fakeClock();
    const log = new EventLog(home(), clock);
    const id = log.createSession("demo");
    log.append(id, thinking);
    clock.advance(1500);
    log.append(id, thinking);
    clock.advance(-5000);
    log.append(id, thinking);
    const events = log.read(id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.t)).toEqual([0, 1500, 1500]);
  });

  it("rejects an invalid event without writing it", () => {
    const log = new EventLog(home(), fakeClock());
    const id = log.createSession();
    const invalid = {
      type: "action.intent",
      agent: "main",
      data: { verb: "click", risk: "none" },
    } as unknown as EventDraft;
    expect(() => log.append(id, invalid)).toThrow();
    expect(log.read(id)).toEqual([]);
  });

  it("recovers after a crash mid-append: drops the partial line, continues seq and t", () => {
    const dir = home();
    const first = new EventLog(dir, fakeClock(0));
    const id = first.createSession();
    first.append(id, thinking);
    first.append(id, thinking);
    const file = join(dir, "sessions", id, "events.jsonl");
    appendFileSync(file, '{"v":1,"id":"01J9ZQ3V8Y7X6W5T4S3R2Q1P0N","seq":2,"t":');
    first.close();

    const second = new EventLog(dir, fakeClock(0));
    const next = second.append(id, thinking);
    expect(next.seq).toBe(2);
    const events = second.read(id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(next.t).toBeGreaterThan(Math.max(...events.slice(0, -1).map((e) => e.t)));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("lists sessions with event counts", () => {
    const log = new EventLog(home(), fakeClock());
    const id = log.createSession("counted");
    log.append(id, thinking);
    expect(log.listSessions()).toEqual([
      expect.objectContaining({ id, title: "counted", events: 1 }),
    ]);
  });

  it("notifies subscribers of each appended event", () => {
    const log = new EventLog(home(), fakeClock());
    const id = log.createSession();
    const seen: number[] = [];
    const stop = log.subscribe((sid, e) => {
      if (sid === id) seen.push(e.seq);
    });
    log.append(id, thinking);
    stop();
    log.append(id, thinking);
    expect(seen).toEqual([0]);
  });

  it("refuses session ids that are not ULIDs", () => {
    const log = new EventLog(home(), fakeClock());
    expect(() => log.read("../../etc")).toThrow("invalid session id");
    expect(() => log.append("01j9zq3v8y7x6w5t4s3r2q1p0n", thinking)).toThrow("invalid session id");
  });
});
