import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ulid } from "@localdot/protocol";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "../app.ts";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { TicketRegistry } from "../cells/secrets.ts";
import { cellStatusRoute } from "../cells/status-stream.ts";
import { desktopStreamRoute } from "../cells/stream-proxy.ts";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { attachUpgradeRouter } from "../upgrade-router.ts";
import { BrowserStreams } from "./streams.ts";

const token = "t".repeat(43),
  auth = { authorization: `Bearer ${token}` };
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});
const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );
const freePort = async () => {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};
function fixture(port = 4750, baseUrl = "http://127.0.0.1:1") {
  const parents = new FakeOrchestrator(),
    parent = {
      id: ulid(),
      state: "ready" as const,
      scale: 2 as const,
      createdAt: "2026-10-06",
      stream: { ...NO_STREAM },
    };
  parents.emit(parent);
  const current: ReadyBrowser = {
    parentCellId: parent.id,
    browserCellId: ulid(),
    instance: randomUUID(),
    browserd: { baseUrl, token: "private-browser-token" },
    stream: { baseUrl, authorization: "Basic private-stream-auth" },
  };
  const listeners = new Set<(id: string) => void>();
  const tickets = new TicketRegistry();
  const cells = new BrowserStreams({
    parents,
    tickets,
    browser: {
      endpoints: (id) => (id === parent.id ? structuredClone(current) : undefined),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "localdot-browser-viewer-"));
  writeFileSync(join(dir, "index.html"), "<html>browser-client</html>");
  const eventLog = new EventLog(dir);
  const deps = { cells, tickets, vendorDir: dir };
  const app = createApp({ token, port, eventLog, browser: deps });
  stops.push(() => {
    cells.dispose();
    eventLog.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`http://127.0.0.1:${port}${path}`, init);
  const ticket = async () => {
    const res = await request(`/api/cells/${parent.id}/browser-stream-ticket`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { ticket: string; cellId: string; path: string };
  };
  return {
    parents,
    parent,
    current,
    cells,
    tickets,
    app,
    deps,
    request,
    ticket,
    restart() {
      current.instance = randomUUID();
      for (const listener of listeners) listener(parent.id);
    },
  };
}

it("requires install authentication, mints a separate physical browser ticket and serves only that screen", async () => {
  const f = fixture();
  expect(
    (await f.request(`/api/cells/${f.parent.id}/browser-stream-ticket`, { method: "POST" })).status,
  ).toBe(401);
  expect((await f.request(`/api/browsers/${f.current.browserCellId}`)).status).toBe(401);
  const ticket = await f.ticket();
  expect(ticket.cellId).toBe(f.current.browserCellId);
  expect(f.tickets.resolve(ticket.ticket)).toBe(f.current.browserCellId);
  expect(ticket.path).toBe(`/cells/${ticket.cellId}/browser/${ticket.ticket}/`);
  const index = await f.request(ticket.path);
  expect(index.status).toBe(200);
  expect(await index.text()).toContain("browser-client");
  expect(index.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts allow-same-origin",
  );
  expect((await f.request(ticket.path.replace(ticket.cellId, f.parent.id))).status).toBe(403);
  expect((await f.request(ticket.path.replace("/browser/", "/desktop/"))).status).toBe(404);
  expect((await f.request(`/api/browsers/${ticket.cellId}`, { headers: auth })).status).toBe(200);
  const body = await (await f.request(`/api/browsers/${ticket.cellId}`, { headers: auth })).text();
  expect(body).not.toMatch(/private-|authorization|browserd/);
  expect((await f.request(`/api/browsers/${f.parent.id}`, { headers: auth })).status).toBe(404);
});

it("refuses the old ticket on a same-ID restart and on a silent parent pause", async () => {
  const f = fixture(),
    old = await f.ticket();
  f.restart();
  expect((await f.request(old.path)).status).toBe(403);
  const next = await f.ticket();
  expect(next.cellId).toBe(old.cellId);
  expect(next.ticket).not.toBe(old.ticket);
  f.parents.cells.set(f.parent.id, { ...f.parent, paused: true });
  expect((await f.request(next.path)).status).toBe(403);
  expect(
    (
      await f.request(`/api/cells/${f.parent.id}/browser-stream-ticket`, {
        method: "POST",
        headers: auth,
      })
    ).status,
  ).toBe(409);
});

it("relays authenticated browser video/status separately and retires both on pause", async () => {
  const upstream = createServer();
  const upstreamPort = await listen(upstream),
    upstreamWs = new WebSocketServer({ server: upstream });
  stops.push(() => {
    for (const ws of upstreamWs.clients) ws.terminate();
    upstreamWs.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  let credential = "",
    upstreamPath = "";
  upstreamWs.on("connection", (ws, req) => {
    credential = req.headers.authorization ?? "";
    upstreamPath = req.url ?? "";
    ws.on("message", (data) => ws.send(`video:${data}`));
  });
  const port = await freePort(),
    f = fixture(port, `http://127.0.0.1:${upstreamPort}`);
  const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port }) as Server;
  attachUpgradeRouter(server, { port, token }, [
    cellStatusRoute(f.cells, "browsers"),
    desktopStreamRoute(f.deps, "browser"),
  ]);
  await new Promise((resolve) => server.once("listening", resolve));
  stops.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const ticket = await f.ticket(),
    origin = `http://127.0.0.1:${port}`;
  const status = new WebSocket(
    `ws://127.0.0.1:${port}/api/browsers/${ticket.cellId}/status`,
    ["localdot.v1", `localdot.token.${token}`],
    { origin },
  );
  stops.push(() => status.terminate());
  const initial = await new Promise<string>((resolve, reject) => {
    status.once("message", (data) => resolve(String(data)));
    status.once("error", reject);
  });
  expect(JSON.parse(initial).id).toBe(ticket.cellId);
  const video = new WebSocket(`ws://127.0.0.1:${port}${ticket.path}api/websockets`, { origin });
  stops.push(() => video.terminate());
  const received = new Promise<string>((resolve, reject) => {
    video.once("message", (data) => resolve(String(data)));
    video.once("error", reject);
    video.once("open", () => video.send("SETTINGS,{}"));
  });
  expect(await received).toBe("video:SETTINGS,{}");
  expect(credential).toBe("Basic private-stream-auth");
  expect(upstreamPath).toBe("/api/websockets?role=viewer");
  expect(f.cells.get(ticket.cellId)?.stream.viewers).toBe(1);
  expect(f.parents.get(f.parent.id)?.stream).toEqual(NO_STREAM);
  const closed = new Promise<number>((resolve) => video.once("close", (code) => resolve(code)));
  const stopped = new Promise<void>((resolve) =>
    status.on("message", (data) => {
      if (JSON.parse(String(data)).state === "stopped") resolve();
    }),
  );
  f.parents.emit({ ...f.parent, paused: true });
  expect(await closed).toBe(1012);
  await stopped;
  expect((await f.request(ticket.path)).status).toBe(403);
});
