import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { seedSession } from "../recorder/testing/seed-session.ts";
import { readSummary, summarizeSession, writeSummary } from "./summary.ts";

const roots: string[] = [];
const logs: EventLog[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-summary-"));
  roots.push(home);
  return home;
}
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("session summaries", () => {
  it("folds verdict, duration, failures, cover, screen and recording without event retention", async () => {
    const home = setup();
    const seed = await seedSession({ home, minutes: 1, title: "A completed session" });
    const log = new EventLog(home);
    logs.push(log);
    const observations = log.read(seed.sessionId).filter((event) => event.type === "observe");
    const summary = await summarizeSession(home, seed.sessionId, { live: false });
    expect(summary).toMatchObject({
      title: "A completed session",
      verdict: "done",
      durationMs: 60_000,
      steps: 12,
      failedSteps: 1,
      screen: { w: 2560, h: 1600, scale: 2 },
      coverFrameId: observations.at(-1)?.data.frameId,
      recording: { state: "complete" },
    });
    expect(summary.recording.bytes).toBeGreaterThan(0);
    writeSummary(home, summary);
    expect(readSummary(home, seed.sessionId)).toEqual(summary);
    expect(statSync(join(home, "sessions", seed.sessionId, "summary.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(summary.logBytes).toBe(readFileSync(log.logFile(seed.sessionId)).length);
  });

  it("distinguishes live and interrupted logs and prefers a session-start title", async () => {
    const home = setup();
    let time = 0;
    const log = new EventLog(home, { nowMicros: () => time });
    logs.push(log);
    const sessionId = log.createSession("Metadata title");
    expect((await summarizeSession(home, sessionId, { live: false })).title).toBe("Metadata title");
    log.append(sessionId, {
      type: "session.start",
      agent: "main",
      data: { title: "Event title", os: "linux", screen: { w: 1280, h: 800, scale: 1 } },
    });
    time = 2_000_000;
    log.append(sessionId, {
      type: "step.start",
      agent: "main",
      step: "first",
      data: { kind: "gui" },
    });
    expect(await summarizeSession(home, sessionId, { live: false })).toMatchObject({
      title: "Event title",
      verdict: "interrupted",
      durationMs: 2000,
    });
    expect((await summarizeSession(home, sessionId, { live: true })).verdict).toBe("live");
  });

  it("ends duration at session.end even when cleanup events follow", async () => {
    const home = setup();
    let time = 0;
    const log = new EventLog(home, { nowMicros: () => time });
    logs.push(log);
    const sessionId = log.createSession();
    log.append(sessionId, {
      type: "session.start",
      agent: "main",
      data: { os: "linux", screen: { w: 1280, h: 800, scale: 1 } },
    });
    time = 3_000_000;
    log.append(sessionId, { type: "session.end", agent: "main", data: { reason: "stopped" } });
    time = 8_000_000;
    log.append(sessionId, { type: "agent.state", agent: "main", data: { state: "idle" } });
    expect(await summarizeSession(home, sessionId, { live: false })).toMatchObject({
      verdict: "stopped",
      durationMs: 3000,
    });
  });
});

describe("routine runs", () => {
  it("carries a routine origin onto the card", async () => {
    const home = setup();
    const log = new EventLog(home);
    logs.push(log);
    const screen = { w: 2560, h: 1600, scale: 2 };
    const origin = {
      kind: "routine" as const,
      routineId: ulid(),
      runId: ulid(),
      name: "Morning bills",
      dueAt: "2026-10-12T07:30:00.000Z",
    };
    const routine = log.createSession("Morning bills");
    log.append(routine, {
      type: "session.start",
      agent: "main",
      data: { screen, os: "linux", title: "Morning bills", origin },
    });
    const typed = log.createSession("Typed task");
    log.append(typed, {
      type: "session.start",
      agent: "main",
      data: { screen, os: "linux", title: "Typed task" },
    });
    expect((await summarizeSession(home, routine, { live: false })).origin).toEqual(origin);
    expect(await summarizeSession(home, typed, { live: false })).not.toHaveProperty("origin");
  });
});
