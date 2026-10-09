import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import type { Clock } from "../clock.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import { KeydUnavailableError } from "../keyd/client.ts";
import { LiveSessions } from "./live.ts";
import { gatewayRoutes } from "./routes.ts";

const SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const CELL = "01JXYZ0000000000000000ABCD";

// Only the routes Part 4b changes: the registry and the clock are never reached here.
function setup(
  paused = false,
  keydOffline = false,
  state: "ready" | "starting" = "ready",
  busy = false,
) {
  const cells = new FakeOrchestrator();
  cells.emit({
    id: CELL,
    state,
    scale: 2,
    createdAt: "t",
    stream: NO_STREAM,
    ...(paused ? { paused: true as const } : {}),
  });
  const live = new LiveSessions();
  const calls: string[] = [];
  const killSwitch = {
    isBusy: () => busy,
    stopSession: async (id: string) => {
      calls.push(`stop ${id}`);
      return live.cellOf(id)
        ? { revoked: true, paused: true, closed: false, stopped: false, errors: [] }
        : undefined;
    },
    resume: async (id: string) => {
      calls.push(`resume ${id}`);
      if (keydOffline) throw new KeydUnavailableError("ENOENT", `/v1/cells/${id}/revoke`);
    },
  };
  const app = new Hono();
  gatewayRoutes(app, cells, {
    registry: { for: () => undefined } as unknown as DesktopdRegistry,
    clock: { nowMicros: () => 0 } as unknown as Clock,
    live,
    killSwitch,
  });
  return { app, live, calls };
}

describe("Stop, resume and a paused computer", () => {
  it("runs the kill switch on Stop and reports what it did", async () => {
    const { app, live, calls } = setup();
    live.start(CELL, SESSION, (signal) => new Promise((r) => signal.addEventListener("abort", r)));
    const res = await app.request(`/api/sessions/${SESSION}/stop`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      revoked: true,
      paused: true,
      closed: false,
      stopped: false,
      errors: [],
    });
    expect(calls).toEqual([`stop ${SESSION}`]);
    live.stop(SESSION);
    const other = await app.request("/api/sessions/01J9ZQ3V8Y7X6W5T4S3R2Q1P0Z/stop", {
      method: "POST",
    });
    expect(other.status).toBe(404);
  });

  it.each(["input", "launch", "puppet"])(
    "refuses %s to a paused computer and resumes it on request",
    async (route) => {
      const { app, calls } = setup(true);
      const input = await app.request(`/api/cells/${CELL}/${route}`, { method: "POST" });
      expect(input.status).toBe(409);
      expect(await input.text()).toBe("the computer is paused: resume it first");
      expect((await app.request(`/api/cells/${CELL}/resume`, { method: "POST" })).status).toBe(204);
      expect(calls).toEqual([`resume ${CELL}`]);
    },
  );

  it.each(["input", "launch", "puppet"])("refuses %s during a pending Stop", async (route) => {
    const { app } = setup(false, false, "ready", true);
    expect((await app.request(`/api/cells/${CELL}/${route}`, { method: "POST" })).status).toBe(409);
    const paused = setup(true, false, "ready", true);
    expect((await paused.app.request(`/api/cells/${CELL}/resume`, { method: "POST" })).status).toBe(
      409,
    );
    expect(paused.calls).toEqual([]);
  });

  it.each(["input", "launch"])(
    "rechecks pause after clock synchronization for %s",
    async (route) => {
      const cells = new FakeOrchestrator();
      const cell = {
        id: CELL,
        state: "ready" as const,
        scale: 2 as const,
        createdAt: "t",
        stream: NO_STREAM,
      };
      cells.emit(cell);
      let dispatched = false;
      const d = {
        clocks: {
          sample: undefined,
          sync: async () => {
            cells.emit({ ...cell, paused: true });
          },
        },
        client: {
          input: async () => {
            dispatched = true;
          },
          launch: async () => {
            dispatched = true;
          },
        },
      };
      const app = new Hono();
      gatewayRoutes(app, cells, {
        registry: { for: () => d } as unknown as DesktopdRegistry,
        clock: { nowMicros: () => 0 } as Clock,
      });
      const body =
        route === "launch" ? { app: "terminal" } : { input: { kind: "key", combo: ["Return"] } };
      const response = await app.request(`/api/cells/${CELL}/${route}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(409);
      expect(dispatched).toBe(false);
    },
  );

  it("keeps a paused computer frozen with 503 while the key layer is offline", async () => {
    const { app } = setup(true, true);
    const res = await app.request(`/api/cells/${CELL}/resume`, { method: "POST" });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(
      "key protection is off: turn it back on, then resume the computer",
    );
  });

  it("refuses to resume a computer that is not paused, or an unknown one", async () => {
    const { app } = setup();
    expect((await app.request(`/api/cells/${CELL}/resume`, { method: "POST" })).status).toBe(409);
    expect((await app.request("/api/cells/nope/resume", { method: "POST" })).status).toBe(400);
  });

  it("waits to resume a frozen computer until its gate is back", async () => {
    const { app, calls } = setup(true, false, "starting");
    const res = await app.request(`/api/cells/${CELL}/resume`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("the computer is restarting: resume it once it is ready");
    expect(calls).toEqual([]);
  });
});
