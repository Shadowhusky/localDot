import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog as ProductionEventLog } from "../event-log.ts";
import { streamEventLines } from "./ndjson.ts";

setFlagsFromString("--expose_gc");
const gc = runInNewContext("gc") as () => void;
const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const roots: string[] = [];
const logs = new Set<EventLog>();
class EventLog extends ProductionEventLog {
  constructor(home: string) {
    super(home);
    logs.add(this);
  }
  override close() {
    if (logs.delete(this)) super.close();
  }
}
afterEach(() => {
  for (const log of [...logs]) log.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A 2-hour session's log as M4 will write it: 150 000 events, about 55 MB.
async function longSession(): Promise<{ home: string; file: string; bytes: number }> {
  const home = mkdtempSync(join(tmpdir(), "local dot's long-log-"));
  roots.push(home);
  const dir = join(home, "sessions", ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify({ id: ID, title: "long", startedAt: "2026-10-02T10:00:00.000Z" }),
  );
  const file = join(dir, "events.jsonl");
  const out = createWriteStream(file);
  let bytes = 0;
  for (let i = 0; i < 150_000; i++) {
    const line = `${JSON.stringify({ v: 1, id: ID, seq: i, t: i * 48_000, agent: "main", step: `s${Math.floor(i / 12)}`, type: "text.progress", data: { count: i % 60, chunk: "x".repeat(200), masked: false } })}\n`;
    bytes += line.length;
    if (!out.write(line)) await new Promise<void>((r) => out.once("drain", () => r()));
  }
  await new Promise<void>((r) => out.end(() => r()));
  return { home, file, bytes };
}

describe("a 2-hour log (Review Focus 4, the daemon)", () => {
  it("reopens a home with a 2-hour log in under 200 ms, and recovers a torn tail without a full read", async () => {
    const { home, file } = await longSession();
    new EventLog(home).close(); // the first open builds the index once
    const started = performance.now();
    const log = new EventLog(home);
    expect(performance.now() - started).toBeLessThan(200);
    expect(
      log.append(ID, { type: "agent.state", agent: "main", data: { state: "idle" } }).seq,
    ).toBe(150_000);
    log.close();
    appendFileSync(file, '{"v":1,"id":"01J9ZQ3V8Y7X6W5T4S3R2Q1P0N","seq":150001,"t":');
    const again = performance.now();
    const reopened = new EventLog(home);
    expect(performance.now() - again).toBeLessThan(200);
    expect(
      reopened.append(ID, { type: "agent.state", agent: "main", data: { state: "acting" } }).seq,
    ).toBe(150_001);
    reopened.close();
  }, 120_000);

  it("streams a 2-hour log in bounded memory", async () => {
    const { file, bytes } = await longSession();
    expect(bytes).toBeGreaterThan(40e6);
    gc();
    const base = process.memoryUsage().heapUsed;
    let peak = 0;
    let n = 0;
    for await (const _line of streamEventLines(file)) {
      if (++n % 10_000 === 0) {
        gc();
        peak = Math.max(peak, process.memoryUsage().heapUsed - base);
      }
    }
    expect(n).toBe(150_000);
    expect(peak).toBeLessThan(16e6);
  }, 120_000);
});
