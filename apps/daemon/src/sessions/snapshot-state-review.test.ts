import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { Recorder } from "../recorder/recorder.ts";
import { streamEventLines } from "./ndjson.ts";
import { sweepRecordings } from "./retention.ts";
import { recordingCard } from "./summary.ts";

const homes: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "review-history-snapshot-"));
  homes.push(home);
  const log = new EventLog(home);
  logs.push(log);
  const id = log.createSession("fixture");
  log.append(id, { type: "agent.state", agent: "main", data: { state: "idle" } });
  return { home, log, id };
}
describe("review: recording summary and event snapshot contracts", () => {
  it("freezes the complete event prefix when streamEventLines is called", async () => {
    const { log, id } = setup();
    const snapshot = streamEventLines(log.logFile(id));
    log.append(id, { type: "agent.state", agent: "main", data: { state: "acting" } });
    const lines: string[] = [];
    for await (const line of snapshot) lines.push(line);
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([0]);
  });
  it("classifies existing quarantined video with a missing manifest consistently with Recorder.info", () => {
    const { home, id, log } = setup();
    const dir = join(home, "sessions", id, "recording");
    mkdirSync(dir);
    writeFileSync(join(dir, "video.mp4"), "owned quarantined bytes");
    const recorder = new Recorder({
      home,
      eventLog: log,
      cells: { get: () => undefined, endpoints: () => undefined },
      clock: { nowMicros: () => 0 },
    });
    expect(recorder.info(id)?.manifest.state).toBe("failed");
    expect(recordingCard(home, id).state).toBe("failed");
  });
  it("retention preserves missing-manifest media and distinguishes a truly absent recording", () => {
    const { home, id } = setup();
    expect(recordingCard(home, id)).toEqual({ state: "none", bytes: 0 });
    const dir = join(home, "sessions", id, "recording");
    mkdirSync(dir);
    const file = join(dir, "video.mp4");
    writeFileSync(file, "owned quarantined bytes");
    expect(
      sweepRecordings({
        home,
        now: new Date("2026-10-05T00:00:00Z"),
        policy: { maxBytes: 0, maxAgeDays: 0 },
        isLive: () => false,
      }),
    ).toEqual({ expired: [], freedBytes: 0 });
    expect(readFileSync(file, "utf8")).toBe("owned quarantined bytes");
  });
});
