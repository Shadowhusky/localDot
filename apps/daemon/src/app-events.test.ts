import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type AttentionChangeEvent, type RoutineAppEvent, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app.ts";
import { AppEvents, appEventsRoute } from "./app-events.ts";
import { EventLog } from "./event-log.ts";
import { setPublicOrigin, WS_TOKEN_PREFIX } from "./guard.ts";
import { PresenceBoard } from "./notify/presence.ts";
import { attachUpgradeRouter, WS_PROTOCOL } from "./upgrade-router.ts";

const TOKEN = "s".repeat(43);
const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  setPublicOrigin(undefined);
});

const change: AttentionChangeEvent = {
  type: "attention.change",
  item: {
    key: `${SESSION}:done:4`,
    sessionId: SESSION,
    level: "done",
    reason: "done",
    task: "Pay the bill",
    at: 1,
  },
  page: false,
};

async function start() {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "ld-app-events-"));
  const eventLog = new EventLog(home);
  const events = new AppEvents();
  const presence = new PresenceBoard();
  const server = serve({
    fetch: createApp({ token: TOKEN, port, eventLog }).fetch,
    hostname: "127.0.0.1",
    port,
  });
  attachUpgradeRouter(server as Server, { port, token: TOKEN }, [appEventsRoute(events, presence)]);
  await new Promise((resolve) => server.once("listening", resolve));
  stop = () => {
    server.close();
    eventLog.close();
    rmSync(home, { recursive: true, force: true });
  };
  const open = async (token = true, front?: string, origin = `http://127.0.0.1:${port}`) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/events`,
      token ? [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${TOKEN}`] : [WS_PROTOCOL],
      front ? { origin: `https://${front}`, headers: { host: front } } : { origin },
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return socket;
  };
  return { events, presence, open };
}

describe("app events", () => {
  it("delivers to every listener even when one throws", () => {
    const events = new AppEvents();
    const seen = vi.fn();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    events.subscribe(() => {
      throw new Error("listener bug");
    });
    events.subscribe(seen);
    events.publish(change);
    expect(seen).toHaveBeenCalledWith(change);
    quiet.mockRestore();
  });

  it("streams events to a signed-in socket and refuses one without the token", async () => {
    const { events, open } = await start();
    await expect(open(false)).rejects.toThrow();
    const socket = await open();
    const message = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(String(data))),
    );
    events.publish(change);
    expect(JSON.parse(await message)).toEqual(change);
    socket.close();
  });

  it("counts a loopback tab's presence and forgets it when the tab closes", async () => {
    const { presence, open } = await start();
    const socket = await open();
    socket.send(JSON.stringify({ type: "presence", visible: false, canNotify: true }));
    await vi.waitFor(() =>
      expect(presence.snapshot()).toEqual({ localVisible: false, localHiddenCanNotify: true }),
    );
    socket.send(JSON.stringify({ type: "presence", visible: true, canNotify: true, extra: 1 }));
    socket.send("not json");
    socket.send(JSON.stringify({ type: "presence", visible: true, canNotify: true }));
    await vi.waitFor(() => expect(presence.snapshot().localVisible).toBe(true));
    socket.close();
    await vi.waitFor(() =>
      expect(presence.snapshot()).toEqual({ localVisible: false, localHiddenCanNotify: false }),
    );
  });

  it("never counts a tab that came through the tailnet front as this Mac", async () => {
    setPublicOrigin("https://mac.example.ts.net");
    const { presence, open } = await start();
    const socket = await open(true, "mac.example.ts.net");
    socket.send(JSON.stringify({ type: "presence", visible: true, canNotify: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(presence.snapshot()).toEqual({ localVisible: false, localHiddenCanNotify: false });
    socket.close();
  });

  it("never counts a page from the front as this Mac, even with a loopback Host", async () => {
    setPublicOrigin("https://mac.example.ts.net");
    const { presence, open } = await start();
    const socket = await open(true, undefined, "https://mac.example.ts.net");
    socket.send(JSON.stringify({ type: "presence", visible: true, canNotify: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(presence.snapshot()).toEqual({ localVisible: false, localHiddenCanNotify: false });
    const waiting = presence.waitForShown("k3", 200);
    socket.send(JSON.stringify({ type: "shown", key: "k3" }));
    await expect(waiting).resolves.toBe(false);
    socket.close();
  });

  it("asks only tabs on this Mac to show a notification themselves", async () => {
    setPublicOrigin("https://mac.example.ts.net");
    const { events, open } = await start();
    const mac = await open();
    const phone = await open(true, "mac.example.ts.net");
    const heard = (socket: WebSocket) => {
      const got: AttentionChangeEvent[] = [];
      socket.on("message", (data) => got.push(JSON.parse(String(data))));
      return got;
    };
    const onMac = heard(mac);
    const onPhone = heard(phone);
    events.publish({ ...change, page: true });
    events.publish(change);
    await vi.waitFor(() => expect(onPhone).toEqual([change]));
    await vi.waitFor(() => expect(onMac).toEqual([{ ...change, page: true }, change]));
    mac.close();
    phone.close();
  });

  it("streams routine events to every signed-in device, the phone too", async () => {
    setPublicOrigin("https://mac.example.ts.net");
    const { events, open } = await start();
    const mac = await open();
    const phone = await open(true, "mac.example.ts.net");
    const heard = (socket: WebSocket) => {
      const got: RoutineAppEvent[] = [];
      socket.on("message", (data) => got.push(JSON.parse(String(data))));
      return got;
    };
    const onMac = heard(mac);
    const onPhone = heard(phone);
    const routineId = ulid();
    const changed: RoutineAppEvent = {
      type: "routine.changed",
      routineId,
      revision: 2,
      state: "active",
    };
    const run: RoutineAppEvent = {
      type: "routine.run",
      routineId,
      runId: ulid(),
      outcome: "done",
      sessionId: null,
      notify: true,
      title: "Morning bills: Done",
    };
    events.publish(changed);
    events.publish(run);
    await vi.waitFor(() => expect(onMac).toEqual([changed, run]));
    await vi.waitFor(() => expect(onPhone).toEqual([changed, run]));
    mac.close();
    phone.close();
  });

  it("closes a socket that sends more than 1 KiB at once", async () => {
    const { presence, open } = await start();
    const socket = await open();
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(JSON.stringify({ type: "shown", key: "k".repeat(2048) }));
    expect(await closed).toBe(1009);
    expect(presence.snapshot()).toEqual({ localVisible: false, localHiddenCanNotify: false });
  });

  it("takes a shown confirmation from a tab on this Mac only", async () => {
    const { presence, open } = await start();
    const socket = await open();
    const waiting = presence.waitForShown("k1", 2000);
    socket.send(JSON.stringify({ type: "shown", key: "k1" }));
    await expect(waiting).resolves.toBe(true);
    await expect(presence.waitForShown("k2", 50)).resolves.toBe(false);
    socket.close();
  });
});
