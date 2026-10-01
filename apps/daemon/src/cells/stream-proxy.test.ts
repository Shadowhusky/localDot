import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { attachUpgradeRouter } from "../upgrade-router.ts";
import { TicketRegistry } from "./secrets.ts";
import { desktopStreamRoute, type StreamProxyDeps } from "./stream-proxy.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import { type CellState, NO_STREAM, type StreamEndpoint } from "./types.ts";

const TOKEN = "s".repeat(43);
const AUTH = `Basic ${Buffer.from("localdot:streamtoken").toString("base64")}`;
const WRONG_AUTH = `Basic ${Buffer.from("localdot:wrong").toString("base64")}`;
const DESKTOPD = { baseUrl: "http://127.0.0.1:1", token: "x".repeat(43) };
const HOSTILE_PAGE = "<script>parent.document.title = 'owned'</script>";
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what}: nothing after ${ms} ms`)), ms),
    ),
  ]);
const until = async (what: string, check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(10);
  }
};
const opened = (ws: WebSocket) => new Promise<void>((r) => ws.once("open", () => r()));
const refusal = (ws: WebSocket) =>
  new Promise<string>((r) => ws.once("error", (err) => r(err.message)));

const stops: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stops.splice(0)) s();
});

interface Seen {
  url: string | undefined;
  authorization: string | undefined;
  cookie: string | undefined;
}

// A Selkies stand-in: basic auth on every request and upgrade, an answer that is the request's
// own path as JSON unless `answer` says otherwise, an echoing WebSocket that answers pings only
// while `alive` (ws's automatic pong is off), optional pings or messages of its own every 40 ms,
// a way to drop the connection and a way to wedge it (stop reading, like a paused container).
// `seen` records every request and upgrade that reached it.
async function fakeSelkies() {
  const port = await freePort();
  const seen: Seen[] = [];
  const state = {
    alive: true,
    chatter: undefined as "ping" | "message" | undefined,
    answer: undefined as { status: number; type: string; body: string } | undefined,
    sockets: new Set<WebSocket>(),
  };
  const raw = new Set<Socket>();
  const record = (req: IncomingMessage) =>
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
  const server = createHttpServer((req, res) => {
    record(req);
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Selkies"' });
      res.end();
      return;
    }
    const answer = state.answer ?? {
      status: 200,
      type: "application/json",
      body: JSON.stringify({ path: req.url }),
    };
    res.writeHead(answer.status, { "content-type": answer.type });
    res.end(answer.body);
  });
  const wss = new WebSocketServer({
    server,
    path: "/api/websockets",
    autoPong: false,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      record(req);
      return req.headers.authorization === AUTH;
    },
  });
  wss.on("connection", (ws, req) => {
    state.sockets.add(ws);
    raw.add(req.socket);
    const chatter = setInterval(() => {
      if (state.chatter === "ping") ws.ping();
      if (state.chatter === "message") ws.send("tick");
    }, 40);
    ws.on("ping", () => {
      if (state.alive) ws.pong();
    });
    ws.on("message", (data, isBinary) =>
      ws.send(isBinary ? Buffer.concat([Buffer.from("echo:"), data as Buffer]) : `echo:${data}`, {
        binary: isBinary,
      }),
    );
    ws.on("close", () => {
      clearInterval(chatter);
      state.sockets.delete(ws);
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  stops.push(() => {
    for (const ws of state.sockets) ws.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  });
  const wedge = () => {
    for (const socket of raw) socket.pause();
  };
  return { baseUrl: `http://127.0.0.1:${port}`, seen, state, wedge };
}

// Accepts connections and never answers, like a wedged cell.
async function silentCell() {
  const port = await freePort();
  const held = new Set<Socket>();
  const server = createServer((socket) => held.add(socket));
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  stops.push(() => {
    for (const socket of held) socket.destroy();
    server.close();
  });
  return `http://127.0.0.1:${port}`;
}

async function daemon(upstreamBaseUrl: string, overrides: Partial<StreamProxyDeps> = {}) {
  const port = await freePort();
  const cells = new FakeOrchestrator();
  const tickets = new TicketRegistry();
  const vendorDir = mkdtempSync(join(tmpdir(), "local dot's vendor-"));
  mkdirSync(join(vendorDir, "assets"));
  writeFileSync(join(vendorDir, "index.html"), "<html>selkies-core</html>");
  writeFileSync(join(vendorDir, "assets", "core.js"), "// core");
  const desktop = { cells, tickets, vendorDir, pingEveryMs: 50, stallAfterMs: 150, ...overrides };
  const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's proxy-")));
  const app = createApp({ token: TOKEN, port, eventLog, cells: { cells, tickets }, desktop });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }) as Server;
  attachUpgradeRouter(server, { port, token: TOKEN }, [desktopStreamRoute(desktop)]);
  await new Promise((r) => server.once("listening", r));
  const viewers = new Set<WebSocket>();
  stops.push(() => {
    for (const ws of viewers) ws.terminate();
    server.closeAllConnections();
    server.close();
    eventLog.close();
  });
  const origin = `http://127.0.0.1:${port}`;
  const streamAt = (cellId: string, stream: StreamEndpoint) =>
    cells.endpointsById.set(cellId, { desktopd: DESKTOPD, stream });
  const addCell = (baseUrl: string) => {
    const id = ulid();
    const createdAt = new Date().toISOString();
    cells.emit({ id, state: "ready", scale: 2, createdAt, stream: NO_STREAM });
    streamAt(id, { baseUrl, authorization: AUTH });
    const ticket = tickets.issue(id);
    return { id, ticket, prefix: `/cells/${id}/desktop/${ticket}` };
  };
  const { id, ticket, prefix } = addCell(upstreamBaseUrl);
  return {
    cells,
    tickets,
    id,
    ticket,
    prefix,
    addCell,
    streamAt: (stream: StreamEndpoint) => streamAt(id, stream),
    // Changes the state with no event, as if one had been lost: the cell keeps its live ticket.
    quietly: (state: CellState) => {
      const cell = cells.get(id);
      if (cell) cells.cells.set(id, { ...cell, state });
    },
    open: (path: string, headers: Record<string, string> = {}) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin, headers });
      viewers.add(ws);
      return ws;
    },
    stream: () => cells.get(id)?.stream,
    connections: () =>
      cells.streamUpdates.filter((u) => u.id === id).map((u) => u.patch.connection),
    fetch: (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init),
  };
}

describe("desktop stream proxy over HTTP", () => {
  it("serves the vendored client and proxies api/status with the cell's credential", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const index = await d.fetch(`${d.prefix}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("selkies-core");
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    // The client probes its own page with HEAD after every socket close.
    const head = await d.fetch(`${d.prefix}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await d.fetch(`${d.prefix}/assets/core.js`)).status).toBe(200);
    const status = await d.fetch(`${d.prefix}/api/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ path: "/api/status" });
    expect(selkies.seen).toEqual([{ url: "/api/status", authorization: AUTH, cookie: undefined }]);
  });

  it("proxies only GET api/status and api/websockets and answers 404 to the rest without dialing the cell", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const refused = [
      "api/screenshot",
      "api/health",
      "api/sessions",
      "api/recording",
      "api/files/x",
      "api/print/x",
      "api/turn",
      "api/",
      "api/status/",
      "api/websockets/x",
      "nope.js",
      "assets/",
    ];
    for (const path of refused) {
      expect((await d.fetch(`${d.prefix}/${path}`)).status, path).toBe(404);
    }
    expect((await d.fetch(`${d.prefix}/api/status`, { method: "HEAD" })).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await d.fetch(`${d.prefix}/api/status`, { method })).status, method).toBe(405);
    }
    expect((await d.fetch(`${d.prefix}/api/upload`, { method: "POST" })).status).toBe(405);
    expect(selkies.seen).toEqual([]);
    const plain = await d.fetch(`${d.prefix}/api/websockets`);
    expect(plain.status).toBe(200);
    expect(selkies.seen.map((s) => s.url)).toEqual(["/api/websockets"]);
  });

  it("pins the media type of every cell answer and turns the cell's 401 into a 502", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    selkies.state.answer = { status: 200, type: "text/html", body: HOSTILE_PAGE };
    const status = await d.fetch(`${d.prefix}/api/status`);
    expect(status.headers.get("content-type")).toBe("application/json");
    expect(status.headers.get("x-content-type-options")).toBe("nosniff");
    expect(status.headers.get("cache-control")).toBe("no-store");
    selkies.state.answer = { status: 400, type: "text/html", body: HOSTILE_PAGE };
    const plain = await d.fetch(`${d.prefix}/api/websockets`);
    expect(plain.status).toBe(400);
    expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
    // The client's fetch wrapper reloads the page on a same-origin 401 (S8).
    selkies.state.answer = undefined;
    d.streamAt({ baseUrl: selkies.baseUrl, authorization: WRONG_AUTH });
    const unauthorised = await d.fetch(`${d.prefix}/api/status`);
    expect(unauthorised.status).toBe(502);
    expect(unauthorised.headers.get("www-authenticate")).toBeNull();
  });

  it("answers 502 when the cell answers too much, can't be reached or never answers, and 503 without endpoints", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl, { upstreamTimeoutMs: 300 });
    selkies.state.answer = { status: 200, type: "application/json", body: "x".repeat(65 * 1024) };
    expect((await d.fetch(`${d.prefix}/api/status`)).status).toBe(502);
    d.streamAt({ baseUrl: `http://127.0.0.1:${await freePort()}`, authorization: AUTH });
    expect((await d.fetch(`${d.prefix}/api/status`)).status).toBe(502);
    d.streamAt({ baseUrl: await silentCell(), authorization: AUTH });
    expect((await within(d.fetch(`${d.prefix}/api/status`), 3000, "silent cell")).status).toBe(502);
    d.cells.endpointsById.delete(d.id);
    expect((await d.fetch(`${d.prefix}/api/status`)).status).toBe(503);
  });

  it("refuses wrong tickets, another cell's ticket, a cell that is not ready and traversal", async () => {
    const selkies = await fakeSelkies();
    const otherSelkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const other = d.addCell(otherSelkies.baseUrl);
    expect((await d.fetch(`/cells/${d.id}/desktop/${"A".repeat(22)}/`)).status).toBe(403);
    expect((await d.fetch(`/cells/${ulid()}/desktop/${d.ticket}/`)).status).toBe(403);
    expect((await d.fetch(`/cells/${other.id}/desktop/${d.ticket}/`)).status).toBe(403);
    expect((await d.fetch(`/cells/${other.id}/desktop/${d.ticket}/api/status`)).status).toBe(403);
    expect((await d.fetch(`${other.prefix}/api/status`)).status).toBe(200);
    // fetch() and the daemon's URL parsing fold "../" and "%2e%2e/" away before any route runs; an
    // encoded separator survives both and reaches readStatic's guard, aimed at a file that exists.
    writeFileSync(join(tmpdir(), "ld-proxy-outside.txt"), "secret");
    expect((await d.fetch(`${d.prefix}/..%2fld-proxy-outside.txt`)).status).toBe(404);
    expect((await d.fetch(`${d.prefix}/assets/..%2f..%2fld-proxy-outside.txt`)).status).toBe(404);
    d.quietly("failed");
    expect(d.tickets.resolve(d.ticket)).toBe(d.id);
    expect((await d.fetch(`${d.prefix}/`)).status).toBe(403);
    expect((await d.fetch(`${d.prefix}/api/status`)).status).toBe(403);
    d.quietly("ready");
    d.tickets.revoke(d.id);
    expect((await d.fetch(`${d.prefix}/`)).status).toBe(403);
    expect(selkies.seen).toEqual([]);
    expect(otherSelkies.seen.map((s) => s.url)).toEqual(["/api/status"]);
  });

  it("forwards only its own credential: no client Authorization, cookie or query", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const res = await d.fetch(`${d.prefix}/api/status?token=${TOKEN}&x=1`, {
      headers: { authorization: `Bearer ${TOKEN}`, cookie: `localdot_session=${TOKEN}` },
    });
    expect(await res.json()).toEqual({ path: "/api/status" });
    const ws = d.open(`${d.prefix}/api/websockets?token=${TOKEN}`, {
      authorization: `Bearer ${TOKEN}`,
      cookie: `localdot_session=${TOKEN}`,
    });
    await opened(ws);
    expect(selkies.seen).toEqual([
      { url: "/api/status", authorization: AUTH, cookie: undefined },
      { url: "/api/websockets", authorization: AUTH, cookie: undefined },
    ]);
  });
});

describe("desktop stream relay", () => {
  it("relays the WebSocket both ways, pings upstream, and reports stalled and live", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await opened(ws);
    const echoed = new Promise<string>((r) => ws.once("message", (data) => r(String(data))));
    ws.send("hello");
    expect(await echoed).toBe("echo:hello");
    const binary = new Promise<Buffer>((r) => ws.once("message", (data) => r(data as Buffer)));
    ws.send(Buffer.from([1, 2, 3]));
    expect([...(await binary)]).toEqual([...Buffer.from("echo:"), 1, 2, 3]);
    await settle(200);
    expect(d.connections().at(-1)).toBe("live");
    selkies.state.alive = false;
    await settle(400);
    expect(d.connections().at(-1)).toBe("stalled");
    selkies.state.alive = true;
    await settle(200);
    expect(d.connections().at(-1)).toBe("live");
    expect(d.stream()?.viewers).toBe(1);
    ws.close();
    await settle(100);
    expect(d.stream()?.viewers).toBe(0);
    expect(d.connections().at(-1)).toBe("none");
  });

  it("dials the cell first, so a message sent the moment the viewer's socket opens arrives", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    let cellSocketsAtOpen = -1;
    const echoed = new Promise<string>((r) => ws.once("message", (data) => r(String(data))));
    ws.once("open", () => {
      cellSocketsAtOpen = selkies.state.sockets.size;
      ws.send("SETTINGS,{}");
    });
    expect(await within(echoed, 1000, "the first message")).toBe("echo:SETTINGS,{}");
    expect(cellSocketsAtOpen).toBe(1);
  });

  it("counts the cell's own pings and messages as signs of life, not only pongs", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await opened(ws);
    await until("live", () => d.stream()?.connection === "live");
    selkies.state.alive = false;
    selkies.state.chatter = "ping";
    await settle(400);
    selkies.state.chatter = "message";
    await settle(400);
    expect(d.connections()).not.toContain("stalled");
    selkies.state.chatter = undefined;
    await until("stalled", () => d.stream()?.connection === "stalled");
  });

  it("keeps the cell live while any viewer's relay is, and counts every viewer", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const first = d.open(`${d.prefix}/api/websockets`);
    await opened(first);
    await until("live", () => d.stream()?.connection === "live");
    const before = d.connections().length;
    const second = d.open(`${d.prefix}/api/websockets`);
    await opened(second);
    await until("two viewers", () => d.stream()?.viewers === 2);
    expect(d.connections().slice(before)).not.toContain("connecting");
    second.close();
    await until("one viewer", () => d.stream()?.viewers === 1);
    expect(d.stream()?.connection).toBe("live");
    first.close();
    await until("no viewer", () => d.stream()?.viewers === 0);
    expect(d.stream()?.connection).toBe("none");
  });

  it("leaves the count as soon as the viewer goes, even when a wedged cell never finishes the close", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await opened(ws);
    selkies.wedge();
    await until("stalled", () => d.stream()?.connection === "stalled");
    ws.close();
    await until("no viewer", () => d.stream()?.viewers === 0);
    expect(d.stream()?.connection).toBe("none");
  });

  it("closes the viewer with 1012 and reports disconnected when the upstream drops", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await opened(ws);
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    for (const s of selkies.state.sockets) s.terminate();
    expect(await closed).toBe(1012);
    expect(d.connections().at(-1)).toBe("disconnected");
    expect(d.stream()?.viewers).toBe(0);
  });

  it("refuses a bad ticket, another cell's ticket and a cell that is not ready before dialing", async () => {
    const selkies = await fakeSelkies();
    const otherSelkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const other = d.addCell(otherSelkies.baseUrl);
    const bad = d.open(`/cells/${d.id}/desktop/${"B".repeat(22)}/api/websockets`);
    expect(await refusal(bad)).toContain("403");
    const crossed = d.open(`/cells/${other.id}/desktop/${d.ticket}/api/websockets`);
    expect(await refusal(crossed)).toContain("403");
    d.quietly("starting");
    expect(d.tickets.resolve(d.ticket)).toBe(d.id);
    expect(await refusal(d.open(`${d.prefix}/api/websockets`))).toContain("403");
    expect(selkies.seen).toEqual([]);
    expect(otherSelkies.seen).toEqual([]);
    await opened(d.open(`${other.prefix}/api/websockets`));
    expect(otherSelkies.seen).toHaveLength(1);
  });

  it("answers 502 when the cell refuses the upgrade, can't be reached or never answers, and 503 without endpoints", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl, { upstreamTimeoutMs: 300 });
    d.streamAt({ baseUrl: selkies.baseUrl, authorization: WRONG_AUTH });
    expect(await refusal(d.open(`${d.prefix}/api/websockets`))).toContain("502");
    expect(d.connections().at(-1)).toBe("disconnected");
    expect(d.stream()?.viewers).toBe(0);
    d.streamAt({ baseUrl: `http://127.0.0.1:${await freePort()}`, authorization: AUTH });
    expect(await refusal(d.open(`${d.prefix}/api/websockets`))).toContain("502");
    d.streamAt({ baseUrl: await silentCell(), authorization: AUTH });
    const silent = refusal(d.open(`${d.prefix}/api/websockets`));
    expect(await within(silent, 3000, "silent cell")).toContain("502");
    d.cells.endpointsById.delete(d.id);
    expect(await refusal(d.open(`${d.prefix}/api/websockets`))).toContain("503");
  });

  it("writes nothing to the console, so no path, ticket or token reaches a log", async () => {
    const methods = ["debug", "error", "info", "log", "trace", "warn"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const wrongTicket = `/cells/${d.id}/desktop/${"C".repeat(22)}`;
    await d.fetch(`${d.prefix}/`);
    await d.fetch(`${d.prefix}/api/status?token=${TOKEN}`);
    await d.fetch(`${d.prefix}/api/screenshot`);
    await d.fetch(`${wrongTicket}/`);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await opened(ws);
    const closed = new Promise((r) => ws.once("close", r));
    for (const s of selkies.state.sockets) s.terminate();
    await closed;
    await refusal(d.open(`${wrongTicket}/api/websockets`));
    d.streamAt({ baseUrl: selkies.baseUrl, authorization: WRONG_AUTH });
    await refusal(d.open(`${d.prefix}/api/websockets`));
    await d.fetch(`${d.prefix}/api/status`);
    d.streamAt({ baseUrl: `http://127.0.0.1:${await freePort()}`, authorization: AUTH });
    await d.fetch(`${d.prefix}/api/status`);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
