import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { TicketRegistry } from "../cells/secrets.ts";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { monotonicClock } from "../clock.ts";
import { DesktopdRegistry } from "../desktopd/registry.ts";
import { FakeDesktopd } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "./frames.ts";
import { ActionGateway } from "./gateway.ts";
import { LiveSessions } from "./live.ts";
import { DEFAULT_ONSET_TABLE } from "./onset-table.ts";
import { keepPolicy } from "./ring-onset.ts";
import type { GatewayRoutesDeps } from "./routes.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const bearer = { authorization: `Bearer ${TOKEN}` };
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

function setup(
  prepareDesktopTask: GatewayRoutesDeps["prepareDesktopTask"] | null = async () => {},
) {
  const cells = new FakeOrchestrator();
  const fake = new FakeDesktopd();
  const clock = monotonicClock();
  const registry = new DesktopdRegistry(cells, clock, fake.fetchImpl);
  const home = mkdtempSync(join(tmpdir(), "local dot's routes-"));
  const eventLog = new EventLog(home, clock);
  const frames = new FrameStore(home);
  const gateway = new ActionGateway({
    eventLog,
    cells,
    registry,
    onset: DEFAULT_ONSET_TABLE,
    ringOnset: keepPolicy(DEFAULT_ONSET_TABLE),
    frames,
    now: () => clock.nowMicros(),
    sleep: (ms, signal) => sleep(ms, undefined, { signal }),
  });
  const live = new LiveSessions();
  const app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog,
    cells: { cells, tickets: new TicketRegistry() },
    gateway: {
      registry,
      clock,
      eventLog,
      gateway,
      frames,
      live,
      prepareDesktopTask: prepareDesktopTask ?? undefined,
    },
  });
  const id = ulid();
  cells.emit({
    id,
    state: "ready",
    scale: 2,
    createdAt: new Date().toISOString(),
    stream: NO_STREAM,
  });
  cells.endpointsById.set(id, {
    desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token },
    stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
  });
  return { app, cells, fake, id, registry, eventLog, live };
}

describe("raw desktopd routes", () => {
  it("refuses every legacy mutation while an agent owns the desktop, including after raw clock preflight", async () => {
    const h = setup(),
      sessionId = ulid();
    let finish!: () => void;
    h.live.start(
      h.id,
      sessionId,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      for (const name of ["input", "launch", "puppet"]) {
        const response = await h.app.request(url(`/api/cells/${h.id}/${name}`), {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: "{}",
        });
        expect(response.status).toBe(409);
      }
      expect(h.fake.calls).toEqual([]);
    } finally {
      finish();
      await h.live.settled(sessionId);
      h.registry.dispose();
      h.eventLog.close();
    }
  });

  it("holds idle admission while a legacy input waits for clock synchronization", async () => {
    const h = setup(),
      sessionId = ulid(),
      gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    // The registry is already constructed; gate its actual clock method, keeping its real input client.
    const desktop = h.registry.for(h.id);
    if (!desktop) throw new Error("missing desktop fixture");
    const original = desktop.client.clock.bind(desktop.client);
    desktop.client.clock = async () => {
      entered.resolve();
      await gate.promise;
      return original();
    };
    let finish!: () => void;
    const work = h.app.request(url(`/api/cells/${h.id}/input`), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ input: { kind: "key", combo: ["tab"] } }),
    });
    try {
      await entered.promise;
      expect(() => h.live.start(h.id, sessionId, async () => {})).toThrow("still settling");
      expect(h.live.get(h.id)).toBeUndefined();
      gate.resolve();
      expect((await work).status).toBe(200);
      expect(h.fake.calls).toHaveLength(1);
      expect(h.live.idleOperationPending(h.id)).toBe(false);
    } finally {
      gate.resolve();
      if (finish) finish();
      await work;
      await h.live.settled(sessionId);
      h.registry.dispose();
      h.eventLog.close();
    }
  });
  it("serves the daemon clock in microseconds", async () => {
    const { app } = setup();
    const a = (await (await app.request(url("/api/clock"), { headers: bearer })).json()) as {
      nowMicros: number;
    };
    const b = (await (await app.request(url("/api/clock"), { headers: bearer })).json()) as {
      nowMicros: number;
    };
    expect(b.nowMicros).toBeGreaterThanOrEqual(a.nowMicros);
    expect((await app.request(url("/api/clock"))).status).toBe(401);
  });

  it("injects input through the cell's desktopd and maps the press onto the daemon clock", async () => {
    const { app, id, fake } = setup();
    const res = await app.request(url(`/api/cells/${id}/input`), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({
        input: { kind: "click", button: "left", count: 1, at: { x: 100, y: 200 } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pressDaemonMicros: number;
      pressMono: number;
      armedDaemonMicros: number;
    };
    expect(body.pressDaemonMicros).toBeGreaterThan(0);
    expect(body.armedDaemonMicros).toBeLessThan(body.pressDaemonMicros);
    expect(fake.calls.at(-1)).toMatchObject({
      path: "/input",
      body: { input: { at: { x: 100, y: 200 } } },
    });
  });

  it("launches an app and refuses cells that are not ready or unknown", async () => {
    const { app, id, cells } = setup();
    const launched = await app.request(url(`/api/cells/${id}/launch`), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ app: "terminal" }),
    });
    expect(launched.status).toBe(200);
    expect(await launched.json()).toMatchObject({
      pid: 1234,
      armedDaemonMicros: expect.any(Number),
    });
    cells.emit({ ...(cells.get(id) as CellSummary), state: "stopped" });
    expect(
      (
        await app.request(url(`/api/cells/${id}/launch`), {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ app: "terminal" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(url("/api/cells/01JXYZ0000000000000000ABCD/launch"), {
          method: "POST",
          headers: bearer,
        })
      ).status,
    ).toBe(404);
  });
});

describe("puppet, live and frame routes", () => {
  it("does not start a scripted task without a profile preparation owner", async () => {
    const h = setup(null);
    try {
      const response = await h.app.request(url(`/api/cells/${h.id}/puppet`), {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ v: 1, title: "missing owner", steps: [{ do: "wait", ms: 0 }] }),
      });
      expect(response.status).toBe(503);
      expect(h.live.get(h.id)).toBeUndefined();
      expect(h.fake.calls).toEqual([]);
    } finally {
      h.registry.dispose();
      h.eventLog.close();
    }
  });

  it.each(["complete", "stop", "fail"] as const)(
    "keeps scripted-task recording and observation behind profile preparation: %s",
    async (outcome) => {
      const gate = Promise.withResolvers<void>();
      const prepare = vi.fn(async (_cellId: string, _sessionId: string, signal: AbortSignal) => {
        await gate.promise;
        signal.throwIfAborted();
      });
      const h = setup(prepare);
      const beforeRun = vi.fn(async () => {});
      const afterRun = vi.fn(async () => {});
      h.live.addHooks({ beforeRun, afterRun });
      let sessionId: string | undefined;
      try {
        const response = await h.app.request(url(`/api/cells/${h.id}/puppet`), {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ v: 1, title: "fresh profile", steps: [{ do: "wait", ms: 0 }] }),
        });
        expect(response.status).toBe(202);
        sessionId = ((await response.json()) as { sessionId: string }).sessionId;
        expect(prepare).toHaveBeenCalledWith(h.id, sessionId, expect.any(AbortSignal));
        expect(h.live.get(h.id)).toBe(sessionId);
        expect(beforeRun).not.toHaveBeenCalled();
        expect(h.fake.calls).toEqual([]);
        expect(h.eventLog.read(sessionId)).toEqual([]);
        if (outcome === "stop") {
          h.live.stop(sessionId);
          expect(h.live.get(h.id)).toBe(sessionId);
        }
        if (outcome === "fail") gate.reject(new Error("fixture preparation failed"));
        else gate.resolve();
        await h.live.settled(sessionId);
        expect(beforeRun).toHaveBeenCalledTimes(outcome === "complete" ? 1 : 0);
        expect(afterRun).toHaveBeenCalledTimes(outcome === "complete" ? 1 : 0);
        const events = h.eventLog.read(sessionId);
        expect(events.some((event) => event.type === "observe")).toBe(outcome === "complete");
        expect(events.at(-1)).toMatchObject({
          type: "session.end",
          data: { reason: outcome === "complete" ? "done" : "stopped" },
        });
      } finally {
        gate.resolve();
        if (sessionId) {
          h.live.stop(sessionId);
          await h.live.settled(sessionId);
        }
        h.registry.dispose();
        h.eventLog.close();
      }
    },
  );

  it("answers an idle computer's live query with no content rather than an error", async () => {
    const { app, id } = setup();
    const idle = await app.request(url(`/api/cells/${id}/live`), { headers: bearer });
    expect(idle.status).toBe(204);
    expect(await idle.text()).toBe("");
    expect((await app.request(url("/api/cells/not-a-cell/live"), { headers: bearer })).status).toBe(
      400,
    );
  });
  it("serves a session's clock origin and refuses an unknown session", async () => {
    const { app, eventLog } = setup();
    const id = eventLog.createSession("c");
    const response = await app.request(url(`/api/sessions/${id}/clock`), { headers: bearer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { originMicros: number; nowMicros: number };
    expect(body.nowMicros).toBeGreaterThanOrEqual(body.originMicros);
    expect(
      (
        await app.request(url("/api/sessions/01JXYZ0000000000000000ABCD/clock"), {
          headers: bearer,
        })
      ).status,
    ).toBe(404);
  });
  it("starts a puppet session, reports it live, serves its frames, and stops it", async () => {
    const { app, id, eventLog } = setup();
    const started = await app.request(url(`/api/cells/${id}/puppet`), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        title: "t",
        steps: [
          { do: "wait", ms: 300 },
          { do: "wait", ms: 300 },
        ],
      }),
    });
    expect(started.status).toBe(202);
    const { sessionId } = (await started.json()) as { sessionId: string };
    expect(
      await (await app.request(url(`/api/cells/${id}/live`), { headers: bearer })).json(),
    ).toEqual({ sessionId });
    expect(
      (
        await app.request(url(`/api/cells/${id}/puppet`), {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ v: 1, title: "t", steps: [{ do: "wait", ms: 1 }] }),
        })
      ).status,
    ).toBe(409);
    await new Promise((r) => setTimeout(r, 50));
    const observe = eventLog.read(sessionId).find((e) => e.type === "observe");
    expect(observe).toBeDefined();
    const frame = await app.request(
      url(
        `/api/sessions/${sessionId}/frames/${observe?.type === "observe" ? observe.data.frameId : ""}`,
      ),
      { headers: bearer },
    );
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/webp");
    expect(frame.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await app.request(url(`/api/sessions/${sessionId}/frames/01JXYZ0000000000000000ABCD`), {
          headers: bearer,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(url(`/api/sessions/${sessionId}/stop`), {
          method: "POST",
          headers: bearer,
        })
      ).status,
    ).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(eventLog.read(sessionId).at(-1)).toMatchObject({
      type: "session.end",
      data: { reason: "stopped" },
    });
    expect((await app.request(url(`/api/cells/${id}/live`), { headers: bearer })).status).toBe(204);
    expect(
      (
        await app.request(url(`/api/cells/${id}/puppet`), {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ v: 1, steps: [] }),
        })
      ).status,
    ).toBe(400);
  });
});
