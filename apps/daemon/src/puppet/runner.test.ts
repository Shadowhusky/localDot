import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import { monotonicClock } from "../clock.ts";
import { DesktopdRegistry } from "../desktopd/registry.ts";
import { FakeDesktopd } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { ActionGateway } from "../gateway/gateway.ts";
import { DEFAULT_ONSET_TABLE } from "../gateway/onset-table.ts";
import { keepPolicy } from "../gateway/ring-onset.ts";
import { runPuppet } from "./runner.ts";
import { parsePuppetScript } from "./script.ts";

function setup(fake = new FakeDesktopd()) {
  const home = mkdtempSync(join(tmpdir(), "local dot's puppet-"));
  const clock = monotonicClock();
  const eventLog = new EventLog(home, clock);
  const cells = new FakeOrchestrator();
  const registry = new DesktopdRegistry(cells, clock, fake.fetchImpl);
  const cellId = ulid();
  cells.emit({
    id: cellId,
    state: "ready",
    scale: 2,
    createdAt: new Date().toISOString(),
    stream: { ...NO_STREAM, connection: "none" },
  });
  cells.endpointsById.set(cellId, {
    desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token },
    stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
  });
  const sleep = async () => {};
  const gateway = new ActionGateway({
    eventLog,
    cells,
    registry,
    onset: DEFAULT_ONSET_TABLE,
    ringOnset: keepPolicy(DEFAULT_ONSET_TABLE),
    frames: new FrameStore(home),
    now: () => clock.nowMicros(),
    sleep,
  });
  return {
    eventLog,
    cells,
    registry,
    cellId,
    gateway,
    fake,
    deps: { gateway, eventLog, registry, cells, sleep },
  };
}

describe("runPuppet", () => {
  it("runs a script as one session with steps, a screen declaration and a first observe", async () => {
    const s = setup();
    const script = parsePuppetScript({
      v: 1,
      title: "demo",
      steps: [
        { do: "launch", app: "terminal", waitMs: 10 },
        { do: "click", x: 100, y: 100 },
        { do: "key", combo: ["Return"] },
      ],
    });
    const sessionId = s.eventLog.createSession(script.title);
    const result = await runPuppet(s.deps, { cellId: s.cellId, sessionId, script });
    expect(result).toEqual({ ok: true, steps: 3 });
    const types = s.eventLog.read(sessionId).map((e) => e.type);
    expect(types.slice(0, 4)).toEqual(["session.start", "agent.state", "observe", "step.start"]);
    expect(types.at(-2)).toBe("agent.state");
    expect(types.at(-1)).toBe("session.end");
    const start = s.eventLog.read(sessionId)[0];
    expect(start?.type === "session.start" && start.data).toMatchObject({
      screen: { w: 2560, h: 1600, scale: 2 },
      os: "linux",
      title: "demo",
    });
    expect(types.filter((t) => t === "step.start")).toHaveLength(3);
    expect(types.filter((t) => t === "step.end")).toHaveLength(3);
    expect(s.fake.calls.map((c) => c.path)).toEqual(
      expect.arrayContaining(["/observe", "/launch", "/input"]),
    );
    const steps = new Set(
      s.eventLog
        .read(sessionId)
        .map((e) => e.step)
        .filter(Boolean),
    );
    expect(steps.size).toBe(3);
  });

  it("stops at the first failed step and ends the session with error", async () => {
    const s = setup(new FakeDesktopd({ find: () => ({ target: null, window: null, ms: 1 }) }));
    const script = parsePuppetScript({
      v: 1,
      title: "bad",
      steps: [
        { do: "click", find: { name: "Nope" } },
        { do: "wait", ms: 1 },
      ],
    });
    const sessionId = s.eventLog.createSession(script.title);
    const result = await runPuppet(s.deps, { cellId: s.cellId, sessionId, script });
    expect(result.ok).toBe(false);
    const events = s.eventLog.read(sessionId);
    expect(
      events
        .filter((e) => e.type === "step.end")
        .map((e) => (e.type === "step.end" ? e.data.status : "")),
    ).toEqual(["failed"]);
    expect(events.at(-1)).toMatchObject({ type: "session.end", data: { reason: "error" } });
  });

  it("ends with stopped when aborted", async () => {
    const s = setup();
    const script = parsePuppetScript({
      v: 1,
      title: "stop",
      steps: [
        { do: "wait", ms: 5 },
        { do: "wait", ms: 5 },
      ],
    });
    const sessionId = s.eventLog.createSession(script.title);
    const ac = new AbortController();
    ac.abort();
    const result = await runPuppet(s.deps, {
      cellId: s.cellId,
      sessionId,
      script,
      signal: ac.signal,
    });
    expect(result.ok).toBe(false);
    expect(s.eventLog.read(sessionId).at(-1)).toMatchObject({
      type: "session.end",
      data: { reason: "stopped" },
    });
  });
});
