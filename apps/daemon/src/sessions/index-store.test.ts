import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../event-log.ts";
import { writeManifest } from "../recorder/manifest.ts";
import { SessionIndex } from "./index-store.ts";
import * as summaries from "./summary.ts";

const roots: string[] = [];
const logs = new Set<EventLog>();
const indexes = new Set<SessionIndex>();
function setup(isLive = (_sessionId: string) => false) {
  const home = mkdtempSync(join(tmpdir(), "localdot-session-index-"));
  roots.push(home);
  const log = new EventLog(home);
  logs.add(log);
  const index = new SessionIndex(home, { isLive });
  indexes.add(index);
  return { home, log, index };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const index of indexes) index.close();
  indexes.clear();
  for (const log of logs) log.close();
  logs.clear();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("persistent session index", () => {
  it("refreshes browser-only manifest changes while retaining desktop compatibility", async () => {
    const { home, log, index } = setup();
    const id = log.createSession("Two screens");
    const summarize = vi.spyOn(summaries, "summarizeSession");
    expect((await index.card(id)).recordings).toEqual({
      desktop: { state: "none", bytes: 0 },
      browser: { state: "none", bytes: 0 },
    });
    const dir = join(home, "sessions", id, "recording-browser");
    writeManifest(dir, { ...emptyManifest("complete"), bytes: 1234 });
    const card = await index.card(id);
    expect(card.recording).toEqual({ state: "none", bytes: 0 });
    expect(card.recordings?.browser).toEqual({ state: "complete", bytes: 1234 });
    writeManifest(dir, emptyManifest("expired"));
    utimesSync(join(dir, "manifest.json"), 100, 100);
    expect((await index.page()).sessions[0]?.recordings?.browser.state).toBe("expired");
    expect(summarize).toHaveBeenCalledOnce();
  });
  it("pages 120 sessions newest first and rebuilds after the database is removed", async () => {
    const { home, log, index } = setup();
    const ids: string[] = [];
    for (let position = 0; position < 120; position++) {
      const sessionId = log.createSession(`Session ${position}`);
      const startedAt = new Date(Date.UTC(2026, 9, 2, 0, 0, position)).toISOString();
      ids.push(sessionId);
      writeFileSync(
        join(home, "sessions", sessionId, "session.json"),
        JSON.stringify({ id: sessionId, title: `Session ${position}`, startedAt }),
      );
      summaries.writeSummary(home, {
        id: sessionId,
        title: `Session ${position}`,
        startedAt,
        durationMs: 0,
        verdict: "done",
        steps: 0,
        failedSteps: 0,
        coverFrameId: null,
        screen: null,
        recording: { state: "none", bytes: 0 },
        logBytes: 0,
      });
    }
    const first = await index.page();
    const second = await index.page({ before: first.next as string });
    const third = await index.page({ before: second.next as string });
    expect([first.sessions.length, second.sessions.length, third.sessions.length]).toEqual([
      50, 50, 20,
    ]);
    expect(third.next).toBeNull();
    expect(
      [...first.sessions, ...second.sessions, ...third.sessions].map((card) => card.id),
    ).toEqual(ids.toReversed());
    index.close();
    indexes.delete(index);
    log.close();
    logs.delete(log);
    rmSync(join(home, "index.sqlite"));
    const rebuilt = new SessionIndex(home, { isLive: () => false });
    indexes.add(rebuilt);
    expect(await rebuilt.page()).toEqual(first);
  });

  it("reuses unchanged rows and refreshes after log or manifest changes", async () => {
    const { home, log, index } = setup();
    const sessionId = log.createSession("Cache");
    const summarize = vi.spyOn(summaries, "summarizeSession");
    expect((await index.card(sessionId)).steps).toBe(0);
    await index.card(sessionId);
    expect(summarize).toHaveBeenCalledTimes(1);
    log.append(sessionId, {
      type: "step.start",
      agent: "main",
      step: "one",
      data: { kind: "gui" },
    });
    expect((await index.card(sessionId)).steps).toBe(1);
    expect(summarize).toHaveBeenCalledTimes(2);
    const recording = join(home, "sessions", sessionId, "recording");
    mkdirSync(recording);
    writeManifest(recording, emptyManifest("expired"));
    expect((await index.card(sessionId)).recording.state).toBe("expired");
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("recomputes live cards and never reuses a live verdict after the session ends", async () => {
    let live = true;
    const { log, index } = setup(() => live);
    const sessionId = log.createSession();
    const summarize = vi.spyOn(summaries, "summarizeSession");
    expect((await index.card(sessionId)).verdict).toBe("live");
    expect((await index.card(sessionId)).verdict).toBe("live");
    expect(summarize).toHaveBeenCalledTimes(2);
    live = false;
    expect((await index.card(sessionId)).verdict).toBe("interrupted");
  });

  it("rejects malformed cursors and page sizes", async () => {
    const { index } = setup();
    for (const before of [
      "",
      "bad",
      "2026-10-02T00:00:00.000Z~bad",
      "no-date~01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    ])
      await expect(index.page({ before })).rejects.toThrow(RangeError);
    for (const limit of [0, -1, 101, 1.5, Infinity])
      await expect(index.page({ limit })).rejects.toThrow(RangeError);
  });
});
