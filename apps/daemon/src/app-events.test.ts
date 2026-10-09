import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app.ts";
import { AppEvents, appEventsRoute } from "./app-events.ts";
import { EventLog } from "./event-log.ts";
import { WS_TOKEN_PREFIX } from "./guard.ts";
import { attachUpgradeRouter, WS_PROTOCOL } from "./upgrade-router.ts";

const TOKEN = "s".repeat(43);
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("app events", () => {
  it("delivers to every listener even when one throws", () => {
    const events = new AppEvents();
    const seen = vi.fn();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    events.subscribe(() => {
      throw new Error("listener bug");
    });
    events.subscribe(seen);
    const event = {
      type: "routine.changed" as const,
      routineId: ulid(),
      revision: 2,
      state: "active" as const,
    };
    events.publish(event);
    expect(seen).toHaveBeenCalledWith(event);
    quiet.mockRestore();
  });

  it("streams events to a signed-in socket and refuses one without the token", async () => {
    const port = await freePort();
    const home = mkdtempSync(join(tmpdir(), "ld-app-events-"));
    const eventLog = new EventLog(home);
    const events = new AppEvents();
    const server = serve({
      fetch: createApp({ token: TOKEN, port, eventLog }).fetch,
      hostname: "127.0.0.1",
      port,
    });
    attachUpgradeRouter(server as Server, { port, token: TOKEN }, [appEventsRoute(events)]);
    await new Promise((resolve) => server.once("listening", resolve));
    stop = () => {
      server.close();
      eventLog.close();
      rmSync(home, { recursive: true, force: true });
    };
    const origin = `http://127.0.0.1:${port}`;
    const denied = new WebSocket(`ws://127.0.0.1:${port}/api/events`, [WS_PROTOCOL], { origin });
    await new Promise((resolve) => denied.once("error", resolve));
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/events`,
      [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${TOKEN}`],
      { origin },
    );
    await new Promise((resolve) => socket.once("open", resolve));
    const message = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(String(data))),
    );
    const event = {
      type: "routine.run" as const,
      routineId: ulid(),
      runId: ulid(),
      outcome: "done" as const,
      sessionId: null,
      notify: true,
      title: "Morning bills: Done",
    };
    events.publish(event);
    expect(JSON.parse(await message)).toEqual(event);
    socket.close();
  });
});
