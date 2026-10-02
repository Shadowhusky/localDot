### Task 11: Desktop stream proxy with tickets and a connection-level stall watchdog

The UI never talks to a cell. The daemon serves the vendored Selkies client under
`/cells/:id/desktop/:ticket/`, proxies `GET api/*` to the cell's published stream port with the
per-cell basic-auth credential, and relays the WebSocket `api/websockets` the same way. The relay
dials the cell first and completes the viewer's upgrade only once the cell's socket is open:
Selkies' client sends its settings the moment its own socket opens, and the server streams nothing
until it has them. A cell that refuses the upgrade or can't be reached gets the viewer a 502. While a
relay is open the daemon pings the upstream every `STREAM_PING_MS`; when nothing (no frame, no
message, no pong) arrives for `STREAM_STALL_MS` the cell's stream state becomes `stalled` (A30: a
still screen on a live connection is not a stall, because the pongs keep coming; Selkies' own
server heartbeat is only every 30 s, so the daemon's pings are the liveness signal). Use the S8
numbers if FINDINGS raised the stall constant. The relay does not watch `client.bufferedAmount`;
backpressure towards a slow viewer is a Part 3 obligation (see the closing section).

**Files:**
- Create: `apps/daemon/src/static-files.ts`, `apps/daemon/src/cells/watchdog.ts`,
  `apps/daemon/src/cells/stream-proxy.ts`, `apps/daemon/src/static-ui.ts` (a stub holding `webDir`;
  Task 12 replaces it)
- Modify: `apps/daemon/src/app.ts`, `apps/daemon/src/main.ts`
- Test: `apps/daemon/src/static-files.test.ts`, `apps/daemon/src/cells/watchdog.test.ts`,
  `apps/daemon/src/cells/stream-proxy.test.ts`

**Interfaces:**
- Produces: `readStatic(dir, rel): { body: Uint8Array<ArrayBuffer>; type: string } | undefined` (never escapes `dir`);
  `class StallWatchdog { constructor({ pingEveryMs, stallAfterMs, ping(), onChange(state, lastAt), now? }); start(); touch(); stop(); get lastAt }`;
  `STREAM_PING_MS = 500`, `STREAM_STALL_MS = 1500`;
  `interface StreamProxyDeps { cells: CellApi; tickets: TicketRegistry; vendorDir: string; pingEveryMs?; stallAfterMs? }`;
  `desktopRoutes(app, deps)` (HTTP: `GET|HEAD /cells/:id/desktop/:ticket/*`), `desktopStreamRoute(deps): UpgradeRoute`
  (`/cells/:id/desktop/:ticket/api/websockets`, `auth: "ticket"`; dials the cell first, completes the
  viewer's upgrade from the cell socket's `open`, and answers 502 when the cell refuses or can't be
  reached); `AppOptions` gains `desktop?: StreamProxyDeps`.

- [ ] **Step 1: Static file reader with a traversal guard**

`apps/daemon/src/static-files.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStatic } from "./static-files.ts";

describe("readStatic", () => {
  const dir = mkdtempSync(join(tmpdir(), "local dot's static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>hi</html>");
  writeFileSync(join(dir, "assets", "a.js"), "export {}");
  writeFileSync(join(tmpdir(), "ld-outside.txt"), "secret");

  it("serves files under the directory with their media type", () => {
    expect(readStatic(dir, "/index.html")).toEqual({ body: Buffer.from("<html>hi</html>"), type: "text/html; charset=utf-8" });
    expect(readStatic(dir, "assets/a.js")?.type).toBe("text/javascript; charset=utf-8");
  });

  it("refuses paths that escape the directory, directories and missing files", () => {
    expect(readStatic(dir, "/../ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets/../../ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets")).toBeUndefined();
    expect(readStatic(dir, "/nope.js")).toBeUndefined();
  });
});
```

`apps/daemon/src/static-files.ts`:
```ts
import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

export function readStatic(dir: string, rel: string): StaticFile | undefined {
  const root = resolve(dir);
  const file = resolve(root, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  if (file !== root && !file.startsWith(root + sep)) return undefined;
  try {
    if (!statSync(file).isFile()) return undefined;
    return { body: readFileSync(file), type: TYPES[extname(file)] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}
```

Run: `pnpm exec vitest run apps/daemon/src/static-files.test.ts`
Expected: 2 tests pass.

- [ ] **Step 2: The watchdog**

`apps/daemon/src/cells/watchdog.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StallWatchdog } from "./watchdog.ts";

describe("StallWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pings on every tick, reports stalled after silence and live again on the next sign of life", () => {
    const pings: number[] = [];
    const changes: string[] = [];
    const dog = new StallWatchdog({
      pingEveryMs: 100,
      stallAfterMs: 250,
      ping: () => pings.push(Date.now()),
      onChange: (state) => changes.push(state),
    });
    dog.start();
    vi.advanceTimersByTime(200);
    dog.touch();
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(changes).toEqual(["stalled"]);
    expect(pings).toHaveLength(6);
    dog.touch();
    expect(changes).toEqual(["stalled", "live"]);
    dog.stop();
    vi.advanceTimersByTime(1000);
    expect(pings).toHaveLength(6);
  });
});
```

`apps/daemon/src/cells/watchdog.ts`:
```ts
export type WatchdogState = "live" | "stalled";

export interface WatchdogOptions {
  pingEveryMs: number;
  stallAfterMs: number;
  ping(): void;
  onChange(state: WatchdogState, lastAt: number): void;
  now?: () => number;
}

export class StallWatchdog {
  #timer: NodeJS.Timeout | undefined;
  #lastAt = 0;
  #state: WatchdogState = "live";
  readonly #opts: WatchdogOptions;
  readonly #now: () => number;

  constructor(opts: WatchdogOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get lastAt(): number {
    return this.#lastAt;
  }

  start(): void {
    this.#lastAt = this.#now();
    this.#state = "live";
    this.#timer = setInterval(() => this.#tick(), this.#opts.pingEveryMs);
  }

  touch(): void {
    this.#lastAt = this.#now();
    if (this.#state === "stalled") {
      this.#state = "live";
      this.#opts.onChange("live", this.#lastAt);
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #tick(): void {
    this.#opts.ping();
    if (this.#state === "live" && this.#now() - this.#lastAt > this.#opts.stallAfterMs) {
      this.#state = "stalled";
      this.#opts.onChange("stalled", this.#lastAt);
    }
  }
}
```

Run: `pnpm exec vitest run apps/daemon/src/cells/watchdog.test.ts`
Expected: 1 test passes.

- [ ] **Step 3: Write the failing proxy test**

`apps/daemon/src/cells/stream-proxy.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { attachUpgradeRouter } from "../upgrade-router.ts";
import { TicketRegistry } from "./secrets.ts";
import { desktopStreamRoute } from "./stream-proxy.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import { NO_STREAM } from "./types.ts";

const TOKEN = "s".repeat(43);
const AUTH = `Basic ${Buffer.from("localdot:streamtoken").toString("base64")}`;
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

// A Selkies stand-in: basic auth on every request and upgrade, /api/health, an echoing WebSocket
// that answers pings only while `alive` (ws's automatic pong is off), and a way to drop the connection.
async function fakeSelkies() {
  const port = await freePort();
  const seenAuth: (string | undefined)[] = [];
  const state = { alive: true, sockets: new Set<WebSocket>() };
  const server = createHttpServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  const wss = new WebSocketServer({
    server,
    path: "/api/websockets",
    autoPong: false,
    verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.authorization === AUTH,
  });
  wss.on("connection", (ws, req) => {
    seenAuth.push(req.headers.authorization);
    state.sockets.add(ws);
    ws.on("ping", () => {
      if (state.alive) ws.pong();
    });
    ws.on("message", (data, isBinary) => ws.send(isBinary ? Buffer.concat([Buffer.from("echo:"), data as Buffer]) : `echo:${data}`, { binary: isBinary }));
    ws.on("close", () => state.sockets.delete(ws));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  stops.push(() => server.close());
  return { baseUrl: `http://127.0.0.1:${port}`, seenAuth, state };
}

async function daemon(upstreamBaseUrl: string) {
  const port = await freePort();
  const cells = new FakeOrchestrator();
  const tickets = new TicketRegistry();
  const vendorDir = mkdtempSync(join(tmpdir(), "local dot's vendor-"));
  mkdirSync(join(vendorDir, "assets"));
  writeFileSync(join(vendorDir, "index.html"), "<html>selkies-core</html>");
  writeFileSync(join(vendorDir, "assets", "core.js"), "// core");
  const desktop = { cells, tickets, vendorDir, pingEveryMs: 50, stallAfterMs: 150 };
  const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's proxy-")));
  const app = createApp({ token: TOKEN, port, eventLog, cells: { cells, tickets }, desktop });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  attachUpgradeRouter(server as Server, { port, token: TOKEN }, [desktopStreamRoute(desktop)]);
  await new Promise((r) => server.once("listening", r));
  stops.push(() => {
    server.close();
    eventLog.close();
  });
  const id = ulid();
  cells.emit({ id, state: "ready", scale: 2, createdAt: new Date().toISOString(), stream: NO_STREAM });
  cells.endpointsById.set(id, {
    desktopd: { baseUrl: "http://127.0.0.1:1", token: "x".repeat(43) },
    stream: { baseUrl: upstreamBaseUrl, authorization: AUTH },
  });
  const ticket = tickets.issue(id);
  const origin = `http://127.0.0.1:${port}`;
  const prefix = `/cells/${id}/desktop/${ticket}`;
  const open = (path: string) => new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin });
  const connections = (id2: string) => cells.streamUpdates.filter((u) => u.id === id2).map((u) => u.patch.connection);
  return { port, cells, tickets, id, ticket, prefix, origin, open, connections, fetch: (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init) };
}

describe("desktop stream proxy", () => {
  it("serves the vendored client and proxies api/* with the cell's credential", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const index = await d.fetch(`${d.prefix}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("selkies-core");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect((await d.fetch(`${d.prefix}/assets/core.js`)).status).toBe(200);
    const health = await d.fetch(`${d.prefix}/api/health?x=1`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ path: "/api/health?x=1" });
    expect(selkies.seenAuth).toEqual([AUTH]);
    expect((await d.fetch(`${d.prefix}/api/health`, { method: "POST" })).status).toBe(405);
  });

  it("refuses wrong tickets, other cells' tickets and traversal", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    expect((await d.fetch(`/cells/${d.id}/desktop/${"A".repeat(22)}/`)).status).toBe(403);
    const other = ulid();
    expect((await d.fetch(`/cells/${other}/desktop/${d.ticket}/`)).status).toBe(403);
    // fetch() and the daemon's URL parsing fold "../" and "%2e%2e/" away before any route runs; an
    // encoded separator survives both and reaches readStatic's guard, aimed at a file that exists.
    writeFileSync(join(tmpdir(), "ld-proxy-outside.txt"), "secret");
    expect((await d.fetch(`${d.prefix}/..%2fld-proxy-outside.txt`)).status).toBe(404);
    expect((await d.fetch(`${d.prefix}/assets/..%2f..%2fld-proxy-outside.txt`)).status).toBe(404);
    d.tickets.revoke(d.id);
    expect((await d.fetch(`${d.prefix}/`)).status).toBe(403);
    expect(selkies.seenAuth).toEqual([]);
  });

  it("relays the WebSocket both ways, pings upstream, and reports stalled and live", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await new Promise((r) => ws.once("open", r));
    const echoed = new Promise<string>((r) => ws.once("message", (data) => r(String(data))));
    ws.send("hello");
    expect(await echoed).toBe("echo:hello");
    const binary = new Promise<Buffer>((r) => ws.once("message", (data) => r(data as Buffer)));
    ws.send(Buffer.from([1, 2, 3]));
    expect([...(await binary)]).toEqual([...Buffer.from("echo:"), 1, 2, 3]);
    await settle(200);
    expect(d.connections(d.id).at(-1)).toBe("live");
    selkies.state.alive = false;
    await settle(400);
    expect(d.connections(d.id).at(-1)).toBe("stalled");
    selkies.state.alive = true;
    await settle(200);
    expect(d.connections(d.id).at(-1)).toBe("live");
    expect(d.cells.get(d.id)?.stream.viewers).toBe(1);
    ws.close();
    await settle(100);
    expect(d.cells.get(d.id)?.stream.viewers).toBe(0);
    expect(d.connections(d.id).at(-1)).toBe("none");
  });

  it("closes the viewer with 1012 and reports disconnected when the upstream drops", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const ws = d.open(`${d.prefix}/api/websockets`);
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    for (const s of selkies.state.sockets) s.terminate();
    expect(await closed).toBe(1012);
    expect(d.connections(d.id).at(-1)).toBe("disconnected");
  });

  it("refuses a stream upgrade with a bad ticket, when the cell refuses it, or without endpoints", async () => {
    const selkies = await fakeSelkies();
    const d = await daemon(selkies.baseUrl);
    const bad = d.open(`/cells/${d.id}/desktop/${"B".repeat(22)}/api/websockets`);
    expect(await new Promise<string>((r) => bad.once("error", (e) => r(e.message)))).toContain("403");
    d.cells.endpointsById.set(d.id, {
      desktopd: { baseUrl: "http://127.0.0.1:1", token: "x".repeat(43) },
      stream: { baseUrl: selkies.baseUrl, authorization: "Basic d3Jvbmc=" },
    });
    const refused = d.open(`${d.prefix}/api/websockets`);
    expect(await new Promise<string>((r) => refused.once("error", (e) => r(e.message)))).toContain("502");
    d.cells.endpointsById.delete(d.id);
    const gone = d.open(`${d.prefix}/api/websockets`);
    expect(await new Promise<string>((r) => gone.once("error", (e) => r(e.message)))).toContain("503");
  });
});
```

- [ ] **Step 4: Run it to see it fail, then implement the proxy**

Run: `pnpm exec vitest run apps/daemon/src/cells/stream-proxy.test.ts`
Expected: FAIL — `Failed to load url ./stream-proxy.ts`.

`apps/daemon/src/cells/stream-proxy.ts`:
```ts
import { ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { readStatic } from "../static-files.ts";
import { refuse, type UpgradeContext, type UpgradeRoute } from "../upgrade-router.ts";
import type { CellApi } from "./orchestrator.ts";
import type { TicketRegistry } from "./secrets.ts";
import type { StreamConnection } from "./types.ts";
import { StallWatchdog } from "./watchdog.ts";

// Selkies' stream socket is an aiohttp WebSocketResponse(heartbeat=30): the server pings only every
// 30 s and encodes video only on damage, so liveness rests on the daemon's own ping every 0.5 s,
// which the server answers; 1.5 s without a pong, a message or a server ping is a stall (S8
// measured the idle cadence; raise STREAM_STALL_MS if its FINDINGS says so).
export const STREAM_PING_MS = 500;
export const STREAM_STALL_MS = 1500;

export interface StreamProxyDeps {
  cells: CellApi;
  tickets: TicketRegistry;
  vendorDir: string;
  pingEveryMs?: number;
  stallAfterMs?: number;
}

function cellFor(deps: StreamProxyDeps, id: string, ticket: string): string | undefined {
  if (!ULID_PATTERN.test(id)) return undefined;
  return deps.tickets.resolve(ticket) === id ? id : undefined;
}

export function desktopRoutes(app: Hono, deps: StreamProxyDeps): void {
  app.on(["GET", "HEAD"], "/cells/:id/desktop/:ticket/*", async (c) => {
    const id = c.req.param("id") ?? "";
    const ticket = c.req.param("ticket") ?? "";
    if (!cellFor(deps, id, ticket)) return c.text("forbidden", 403);
    const url = new URL(c.req.url);
    const rel = url.pathname.slice(`/cells/${id}/desktop/${ticket}`.length) || "/";
    if (rel.startsWith("/api/")) return proxyApi(c, deps, id, `${rel}${url.search}`);
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return c.text("bad path", 400);
    }
    const file = readStatic(deps.vendorDir, decoded === "/" ? "/index.html" : decoded);
    if (!file) return c.text("not found", 404);
    return c.body(file.body, 200, { "content-type": file.type, "cache-control": "no-store" });
  });
  app.all("/cells/:id/desktop/:ticket/*", (c) => c.text("method not allowed", 405));
}

async function proxyApi(c: Context, deps: StreamProxyDeps, id: string, pathWithQuery: string): Promise<Response> {
  const endpoints = deps.cells.endpoints(id);
  if (!endpoints) return c.text("cell not running", 503);
  try {
    const upstream = await fetch(`${endpoints.stream.baseUrl}${pathWithQuery}`, {
      method: c.req.method,
      headers: { authorization: endpoints.stream.authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const headers = new Headers({ "cache-control": "no-store" });
    const type = upstream.headers.get("content-type");
    if (type) headers.set("content-type", type);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return c.text(`upstream failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
}

export function desktopStreamRoute(deps: StreamProxyDeps): UpgradeRoute {
  const wss = new WebSocketServer({ noServer: true });
  const viewers = new Map<string, number>();
  return {
    pattern: /^\/cells\/([^/]+)\/desktop\/([^/]+)\/api\/websockets$/,
    params: ["id", "ticket"],
    auth: "ticket",
    open({ req, socket, head, url, params }) {
      const id = cellFor(deps, params.id ?? "", params.ticket ?? "");
      if (!id) {
        refuse(socket, "403 Forbidden");
        return;
      }
      const endpoints = deps.cells.endpoints(id);
      if (!endpoints) {
        refuse(socket, "503 Service Unavailable");
        return;
      }
      const upstreamUrl = `${endpoints.stream.baseUrl.replace(/^http/, "ws")}/api/websockets${url.search}`;
      relay({ req, socket, head }, { id, upstreamUrl, authorization: endpoints.stream.authorization, deps, viewers, wss });
    },
  };
}

interface RelayOptions {
  id: string;
  upstreamUrl: string;
  authorization: string;
  deps: StreamProxyDeps;
  viewers: Map<string, number>;
  wss: WebSocketServer;
}

// The cell is dialled first and the viewer's upgrade completes from its open: Selkies' client sends
// its settings the moment its socket opens, and the server streams nothing until it has them.
function relay({ req, socket, head }: Pick<UpgradeContext, "req" | "socket" | "head">, opts: RelayOptions): void {
  const { id, deps, viewers } = opts;
  const count = (delta: number) => viewers.set(id, Math.max(0, (viewers.get(id) ?? 0) + delta));
  const report = (connection: StreamConnection, lastUpstreamAt: number | null) =>
    deps.cells.updateStream(id, { connection, viewers: viewers.get(id) ?? 0, lastUpstreamAt });
  const upstream = new WebSocket(opts.upstreamUrl, { headers: { authorization: opts.authorization }, perMessageDeflate: false });
  const watchdog = new StallWatchdog({
    pingEveryMs: deps.pingEveryMs ?? STREAM_PING_MS,
    stallAfterMs: deps.stallAfterMs ?? STREAM_STALL_MS,
    ping: () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.ping();
    },
    onChange: (state, lastAt) => report(state, lastAt),
  });
  let client: WebSocket | undefined;
  let viewerGone = false;
  const abandon = () => {
    viewerGone = true;
    upstream.terminate();
  };
  socket.once("close", abandon);
  count(1);
  report("connecting", null);

  upstream.on("open", () => {
    opts.wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("close", abandon);
      client = ws;
      ws.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        viewerGone = true;
        upstream.close();
      });
      watchdog.start();
      report("live", Date.now());
    });
  });
  upstream.on("message", (data, isBinary) => {
    watchdog.touch();
    if (client?.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("ping", () => watchdog.touch());
  upstream.on("pong", () => watchdog.touch());
  upstream.on("error", () => {});
  upstream.on("close", () => {
    watchdog.stop();
    count(-1);
    report(viewerGone ? "none" : "disconnected", watchdog.lastAt || null);
    if (client?.readyState === WebSocket.OPEN) client.close(1012, "upstream closed");
    else if (!client && !viewerGone) refuse(socket, "502 Bad Gateway");
  });
}
```

`apps/daemon/src/app.ts` — add the option and the routes (before `cellRoutes`, outside the
`/api/*` token middleware, because the iframe carries no token):
```ts
import { desktopRoutes, type StreamProxyDeps } from "./cells/stream-proxy.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
  desktop?: StreamProxyDeps;
}
// inside createApp, after the host/origin guard middleware and before the /api/* token middleware:
  if (desktop) desktopRoutes(app, desktop);
```

`apps/daemon/src/main.ts` — wire it:
```ts
import { desktopStreamRoute } from "./cells/stream-proxy.ts";
import { webDir } from "./static-ui.ts";
// ...
const desktop = { cells: orchestrator, tickets, vendorDir: webDir("vendor/selkies") };
const app = createApp({ token, port, eventLog, cells: { cells: orchestrator, tickets }, desktop });
// ...
attachUpgradeRouter(server as Server, { port, token }, [
  sessionStreamRoute(eventLog),
  cellStatusRoute(orchestrator),
  desktopStreamRoute(desktop),
]);
```
`webDir` is written in Task 12 (`apps/daemon/src/static-ui.ts`); until then, create that file with
only:
```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// apps/daemon/src → apps/web/<sub>; fileURLToPath keeps the apostrophe in the repo path intact.
export function webDir(sub: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", sub);
}
```

- [ ] **Step 5: Run the suites**

Run: `pnpm exec vitest run apps/daemon/src/cells/stream-proxy.test.ts apps/daemon/src/app.test.ts apps/daemon/src/cells/api.test.ts`
Expected: 5 proxy tests pass; the app and API tests still pass. The stall test waits about one
second in total; if it is flaky on a loaded machine, raise `settle(400)` to `settle(600)` once and
leave it.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon
git commit -m "feat(daemon): desktop stream proxy with tickets and a stall watchdog"
```

---
