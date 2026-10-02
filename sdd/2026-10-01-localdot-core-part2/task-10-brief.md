### Task 10: Cell API, the cell status socket and the upgrade router

The daemon gets a second WebSocket route (cell status) and, in the next task, a third (the stream
proxy), so the single `upgrade` handler in `event-stream.ts` becomes a router that runs the Host and
Origin checks once and dispatches by path; token checks stay per route because the stream route is
authorised by a ticket instead.

**Files:**
- Create: `apps/daemon/src/upgrade-router.ts`, `apps/daemon/src/cells/api.ts`,
  `apps/daemon/src/cells/status-stream.ts`, `apps/daemon/src/cells/testing/fake-orchestrator.ts`
- Modify: `apps/daemon/src/event-stream.ts`, `apps/daemon/src/app.ts`, `apps/daemon/src/main.ts`
- Test: `apps/daemon/src/cells/api.test.ts`, `apps/daemon/src/cells/status-stream.test.ts`;
  `apps/daemon/src/app.test.ts` and `apps/daemon/src/event-stream.test.ts` keep passing.

**Interfaces:**
- Produces: `WS_PROTOCOL` (moved; still re-exported from `event-stream.ts`);
  `interface UpgradeRoute { pattern: RegExp; params: string[]; auth: "token" | "ticket"; open(ctx: UpgradeContext): void }`;
  `interface UpgradeContext { req; socket; head; url: URL; params: Record<string, string> }`;
  `attachUpgradeRouter(server, { port, token }, routes)`; `refuse(socket, status)`;
  `tokenSocketServer(): WebSocketServer`; `sessionStreamRoute(eventLog): UpgradeRoute`;
  `cellStatusRoute(cells: CellApi): UpgradeRoute` at `/api/cells/:id/status` (JSON `CellSummary`
  on connect and on every change; closes with 1000 after `removed`);
  `type CellApi = Pick<CellOrchestrator, "list" | "get" | "endpoints" | "create" | "start" | "stop" | "remove" | "subscribe" | "updateStream">`;
  `cellRoutes(app, { cells, tickets })` — `GET /api/cells`, `POST /api/cells {scale?}` → 202,
  `GET /api/cells/:id`, `POST /api/cells/:id/start|stop` → 202, `DELETE /api/cells/:id[?purge=1]` → 204,
  `POST /api/cells/:id/stream-ticket` → `{ ticket, path }` (409 unless `ready`; the same ticket
  while the cell stays ready; revoked by `cellRoutes`' subscription whenever the cell leaves `ready`);
  `AppOptions` gains `cells?: { cells: CellApi; tickets: TicketRegistry }`; `main.ts` prints
  `open http://127.0.0.1:<port>/#token=<token>` at startup.

- [ ] **Step 1: The upgrade router, and the event stream on top of it**

`apps/daemon/src/upgrade-router.ts`:
```ts
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { isAllowedHost, isAllowedOrigin, tokenFromHeaders } from "./guard.ts";
import { tokensMatch } from "./token.ts";

export const WS_PROTOCOL = "localdot.v1";

export interface UpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  url: URL;
  params: Record<string, string>;
}

export interface UpgradeRoute {
  pattern: RegExp;
  params: string[];
  // "ticket" routes authorise themselves (the Selkies iframe cannot carry the install token).
  auth: "token" | "ticket";
  open(ctx: UpgradeContext): void;
}

export function refuse(socket: Duplex, status: string): void {
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

// Never select the localdot.token.<t> entry: the chosen subprotocol is echoed back in the response.
export function tokenSocketServer(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
}

export function attachUpgradeRouter(
  server: Server,
  opts: { port: number; token: string },
  routes: UpgradeRoute[],
): void {
  const base = `http://127.0.0.1:${opts.port}`;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const target = req.url ?? "/";
    if (!URL.canParse(target, base)) {
      refuse(socket, "400 Bad Request");
      return;
    }
    const url = new URL(target, base);
    const allowed =
      isAllowedHost(req.headers.host, opts.port) &&
      isAllowedHost(url.host, opts.port) &&
      isAllowedOrigin(req.headers.origin, opts.port);
    if (!allowed) {
      refuse(socket, "403 Forbidden");
      return;
    }
    for (const route of routes) {
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      if (route.auth === "token") {
        const given = tokenFromHeaders({
          authorization: req.headers.authorization,
          "sec-websocket-protocol": req.headers["sec-websocket-protocol"],
        });
        if (!tokensMatch(opts.token, given)) {
          refuse(socket, "403 Forbidden");
          return;
        }
      }
      const params = Object.fromEntries(route.params.map((name, i) => [name, match[i + 1] ?? ""]));
      route.open({ req, socket, head, url, params });
      return;
    }
    refuse(socket, "404 Not Found");
  });
}
```

`apps/daemon/src/event-stream.ts` (replace the whole file; `streamSession` is unchanged):
```ts
import type { Server } from "node:http";
import { type LocalDotEvent, ULID_PATTERN } from "@localdot/protocol";
import type { WebSocket } from "ws";
import type { EventLog } from "./event-log.ts";
import {
  attachUpgradeRouter,
  refuse,
  tokenSocketServer,
  type UpgradeRoute,
  WS_PROTOCOL,
} from "./upgrade-router.ts";

export { WS_PROTOCOL };

export interface EventStreamOptions {
  port: number;
  token: string;
  eventLog: EventLog;
}

export function sessionStreamRoute(eventLog: EventLog): UpgradeRoute {
  const wss = tokenSocketServer();
  return {
    pattern: /^\/api\/sessions\/([^/]+)\/stream$/,
    params: ["id"],
    auth: "token",
    open({ req, socket, head, url, params }) {
      const sessionId = params.id ?? "";
      if (!ULID_PATTERN.test(sessionId)) {
        refuse(socket, "403 Forbidden");
        return;
      }
      if (!eventLog.hasSession(sessionId)) {
        refuse(socket, "404 Not Found");
        return;
      }
      const fromSeq = Math.max(0, Number(url.searchParams.get("fromSeq")) || 0);
      wss.handleUpgrade(req, socket, head, (ws) => streamSession(ws, eventLog, sessionId, fromSeq));
    },
  };
}

export function attachEventStream(server: Server, { port, token, eventLog }: EventStreamOptions): void {
  attachUpgradeRouter(server, { port, token }, [sessionStreamRoute(eventLog)]);
}

function streamSession(
  ws: WebSocket,
  eventLog: EventLog,
  sessionId: string,
  fromSeq: number,
): void {
  // ws closes the connection itself after a protocol error; an unhandled 'error' would crash the daemon.
  ws.on("error", () => {});
  let nextSeq = fromSeq;
  const send = (event: LocalDotEvent) => {
    if (event.seq < nextSeq) return;
    ws.send(JSON.stringify(event));
    nextSeq = event.seq + 1;
  };
  try {
    for (const event of eventLog.read(sessionId, fromSeq)) send(event);
  } catch {
    ws.close(1011, "backlog unavailable");
    return;
  }
  const unsubscribe = eventLog.subscribe((sid, event) => {
    if (sid === sessionId) send(event);
  });
  ws.on("close", unsubscribe);
}
```

Run: `pnpm exec vitest run apps/daemon/src/event-stream.test.ts`
Expected: the Part 1 event-stream tests still pass unchanged.

- [ ] **Step 2: Write the fake orchestrator for route tests**

`CellApi` (the subset of `CellOrchestrator` the routes consume) is already exported by Task 8's
`orchestrator.ts`; the fake below implements it.

`apps/daemon/src/cells/testing/fake-orchestrator.ts`:
```ts
import { ulid } from "@localdot/protocol";
import { type CellApi, type CellListener, UnknownCellError } from "../orchestrator.ts";
import { type CellEndpoints, type CellSummary, NO_STREAM, type Scale, type StreamState } from "../types.ts";

export class FakeOrchestrator implements CellApi {
  readonly cells = new Map<string, CellSummary>();
  readonly endpointsById = new Map<string, CellEndpoints>();
  readonly listeners = new Set<CellListener>();
  readonly streamUpdates: { id: string; patch: Partial<StreamState> }[] = [];
  failWith: Error | undefined;

  list(): CellSummary[] {
    return [...this.cells.values()];
  }

  get(id: string): CellSummary | undefined {
    return this.cells.get(id);
  }

  endpoints(id: string): CellEndpoints | undefined {
    return this.endpointsById.get(id);
  }

  subscribe(listener: CellListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(cell: CellSummary): void {
    this.cells.set(cell.id, cell);
    for (const listener of this.listeners) listener(cell);
  }

  updateStream(id: string, patch: Partial<StreamState>): void {
    this.streamUpdates.push({ id, patch });
    const cell = this.cells.get(id);
    if (cell) this.emit({ ...cell, stream: { ...cell.stream, ...patch } });
  }

  async create({ scale }: { scale: Scale }): Promise<CellSummary> {
    if (this.failWith) throw this.failWith;
    const cell: CellSummary = { id: ulid(), state: "starting", scale, createdAt: new Date().toISOString(), stream: NO_STREAM };
    this.cells.set(cell.id, cell);
    return cell;
  }

  async start(id: string): Promise<void> {
    this.emit({ ...this.#require(id), state: "starting" });
  }

  async stop(id: string): Promise<void> {
    this.emit({ ...this.#require(id), state: "stopped" });
  }

  async remove(id: string): Promise<void> {
    this.emit({ ...this.#require(id), state: "removed" });
    this.cells.delete(id);
  }

  #require(id: string): CellSummary {
    const cell = this.cells.get(id);
    if (!cell) throw new UnknownCellError(id);
    return cell;
  }
}
```

- [ ] **Step 3: Write the failing API and status tests**

`apps/daemon/src/cells/api.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { DockerError } from "./docker.ts";
import { TicketRegistry } from "./secrets.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import type { CellSummary } from "./types.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const bearer = { authorization: `Bearer ${TOKEN}` };
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

function setup() {
  const cells = new FakeOrchestrator();
  const tickets = new TicketRegistry();
  const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's api-")));
  const app = createApp({ token: TOKEN, port: PORT, eventLog, cells: { cells, tickets } });
  return { app, cells, tickets };
}

describe("cell API", () => {
  it("requires the install token", async () => {
    const { app } = setup();
    expect((await app.request(url("/api/cells"))).status).toBe(401);
    expect((await app.request(url("/api/cells"), { method: "POST" })).status).toBe(401);
  });

  it("lists, creates and reads cells", async () => {
    const { app } = setup();
    expect(await (await app.request(url("/api/cells"), { headers: bearer })).json()).toEqual([]);
    const created = await app.request(url("/api/cells"), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ scale: 1 }) });
    expect(created.status).toBe(202);
    const cell = (await created.json()) as CellSummary;
    expect(cell).toMatchObject({ state: "starting", scale: 1 });
    const read = await app.request(url(`/api/cells/${cell.id}`), { headers: bearer });
    expect(await read.json()).toEqual(cell);
    const empty = await app.request(url("/api/cells"), { method: "POST", headers: bearer });
    expect(((await empty.json()) as CellSummary).scale).toBe(2);
  });

  it("rejects bad scales, bad ids and unknown cells", async () => {
    const { app } = setup();
    const bad = await app.request(url("/api/cells"), { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ scale: 3 }) });
    expect(bad.status).toBe(400);
    expect((await app.request(url("/api/cells/../etc"), { headers: bearer })).status).toBe(404);
    expect((await app.request(url("/api/cells/not-a-ulid"), { headers: bearer })).status).toBe(400);
    expect((await app.request(url("/api/cells/01JXYZ0000000000000000ABCD"), { headers: bearer })).status).toBe(404);
    expect((await app.request(url("/api/cells/01JXYZ0000000000000000ABCD/stop"), { method: "POST", headers: bearer })).status).toBe(404);
  });

  it("issues stream tickets only for ready cells and revokes them on removal", async () => {
    const { app, cells, tickets } = setup();
    const cell = await cells.create({ scale: 2 });
    const early = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { method: "POST", headers: bearer });
    expect(early.status).toBe(409);
    cells.emit({ ...cell, state: "ready" });
    const res = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { method: "POST", headers: bearer });
    expect(res.status).toBe(200);
    const { ticket, path } = (await res.json()) as { ticket: string; path: string };
    expect(path).toBe(`/cells/${cell.id}/desktop/${ticket}/`);
    expect(tickets.resolve(ticket)).toBe(cell.id);
    const again = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { method: "POST", headers: bearer });
    expect(((await again.json()) as { ticket: string }).ticket).toBe(ticket);
    expect((await app.request(url(`/api/cells/${cell.id}/stop`), { method: "POST", headers: bearer })).status).toBe(202);
    expect(tickets.resolve(ticket)).toBeUndefined();
    cells.emit({ ...cell, state: "ready" });
    const fresh = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { method: "POST", headers: bearer });
    const reissued = ((await fresh.json()) as { ticket: string }).ticket;
    expect(reissued).not.toBe(ticket);
    expect((await app.request(url(`/api/cells/${cell.id}`), { method: "DELETE", headers: bearer })).status).toBe(204);
    expect(tickets.resolve(reissued)).toBeUndefined();
    expect(cells.get(cell.id)).toBeUndefined();
  });

  it("stops and starts a cell and maps Docker failures to 502", async () => {
    const { app, cells } = setup();
    const cell = await cells.create({ scale: 2 });
    expect((await app.request(url(`/api/cells/${cell.id}/stop`), { method: "POST", headers: bearer })).status).toBe(202);
    expect(cells.get(cell.id)?.state).toBe("stopped");
    expect((await app.request(url(`/api/cells/${cell.id}/start`), { method: "POST", headers: bearer })).status).toBe(202);
    cells.failWith = new DockerError(0, "ECONNREFUSED; is Docker Desktop running?", "/networks/create");
    const failed = await app.request(url("/api/cells"), { method: "POST", headers: bearer });
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("Docker Desktop");
  });
});
```

`apps/daemon/src/cells/status-stream.test.ts`:
```ts
import type { Server } from "node:http";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WS_TOKEN_PREFIX } from "../guard.ts";
import { attachUpgradeRouter, WS_PROTOCOL } from "../upgrade-router.ts";
import { cellStatusRoute } from "./status-stream.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import type { CellSummary } from "./types.ts";

const TOKEN = "s".repeat(43);
const PROTOCOLS = [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${TOKEN}`];
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

let stop: (() => void) | undefined;
afterEach(() => stop?.());

async function start() {
  const port = await freePort();
  const cells = new FakeOrchestrator();
  const server = serve({ fetch: new Hono().fetch, hostname: "127.0.0.1", port });
  attachUpgradeRouter(server as Server, { port, token: TOKEN }, [cellStatusRoute(cells)]);
  await new Promise((r) => server.once("listening", r));
  stop = () => server.close();
  const origin = `http://127.0.0.1:${port}`;
  const open = (path: string, protocols = PROTOCOLS) => new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { origin });
  const messages = (ws: WebSocket, n: number) =>
    new Promise<CellSummary[]>((resolve) => {
      const got: CellSummary[] = [];
      ws.on("message", (data) => {
        got.push(JSON.parse(String(data)) as CellSummary);
        if (got.length === n) resolve(got);
      });
    });
  const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const refused = (ws: WebSocket) => new Promise<string>((resolve) => ws.on("error", (err) => resolve(err.message)));
  return { cells, open, messages, closed, refused };
}

describe("cell status socket", () => {
  it("sends the current summary, then every change, and closes after removal", async () => {
    const { cells, open, messages, closed } = await start();
    const cell = await cells.create({ scale: 2 });
    const ws = open(`/api/cells/${cell.id}/status`);
    const first = messages(ws, 1);
    await new Promise((r) => ws.once("open", r));
    expect((await first)[0]).toEqual(cell);
    const next = messages(ws, 3);
    cells.emit({ ...cell, state: "ready" });
    cells.updateStream(cell.id, { connection: "live" });
    cells.emit({ ...cell, state: "removed" });
    const got = await next;
    expect(got.map((c) => c.state)).toEqual(["ready", "ready", "removed"]);
    expect(got[1]?.stream.connection).toBe("live");
    expect(await closed(ws)).toBe(1000);
  });

  it("refuses unknown cells, bad ids and missing tokens", async () => {
    const { cells, open, refused } = await start();
    expect(await refused(open("/api/cells/01JXYZ0000000000000000ABCD/status"))).toContain("404");
    expect(await refused(open("/api/cells/nope/status"))).toContain("403");
    const cell = await cells.create({ scale: 2 });
    expect(await refused(open(`/api/cells/${cell.id}/status`, [WS_PROTOCOL]))).toContain("403");
  });
});
```

- [ ] **Step 4: Run them to see them fail, then implement the routes**

Run: `pnpm exec vitest run apps/daemon/src/cells/api.test.ts apps/daemon/src/cells/status-stream.test.ts`
Expected: FAIL — `Failed to load url ./status-stream.ts` and type errors on `cells` in `createApp`.

`apps/daemon/src/cells/status-stream.ts`:
```ts
import { ULID_PATTERN } from "@localdot/protocol";
import { refuse, tokenSocketServer, type UpgradeRoute } from "../upgrade-router.ts";
import type { CellApi } from "./orchestrator.ts";

export function cellStatusRoute(cells: CellApi): UpgradeRoute {
  const wss = tokenSocketServer();
  return {
    pattern: /^\/api\/cells\/([^/]+)\/status$/,
    params: ["id"],
    auth: "token",
    open({ req, socket, head, params }) {
      const id = params.id ?? "";
      if (!ULID_PATTERN.test(id)) {
        refuse(socket, "403 Forbidden");
        return;
      }
      const current = cells.get(id);
      if (!current) {
        refuse(socket, "404 Not Found");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        ws.send(JSON.stringify(current));
        const unsubscribe = cells.subscribe((cell) => {
          if (cell.id !== id) return;
          ws.send(JSON.stringify(cell));
          if (cell.state === "removed") ws.close(1000, "cell removed");
        });
        ws.on("close", unsubscribe);
      });
    },
  };
}
```

`apps/daemon/src/cells/api.ts`:
```ts
import { ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { DockerError } from "./docker.ts";
import { type CellApi, UnknownCellError } from "./orchestrator.ts";
import type { TicketRegistry } from "./secrets.ts";

export interface CellApiDeps {
  cells: CellApi;
  tickets: TicketRegistry;
}

export function cellRoutes(app: Hono, { cells, tickets }: CellApiDeps): void {
  // A stream ticket lives only while its cell is ready (P2-R2): stopping, failing or removing the
  // cell revokes it, so no stream path stays open for a computer that is off.
  cells.subscribe((cell) => {
    if (cell.state !== "ready") tickets.revoke(cell.id);
  });

  app.get("/api/cells", (c) => c.json(cells.list()));

  app.post("/api/cells", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scale?: unknown };
    const scale = body.scale === undefined || body.scale === 2 ? 2 : body.scale === 1 ? 1 : undefined;
    if (scale === undefined) return c.text("scale must be 1 or 2", 400);
    return withDocker(c, async () => c.json(await cells.create({ scale }), 202));
  });

  app.get("/api/cells/:id", (c) =>
    withCell(c, (id) => {
      const cell = cells.get(id);
      return cell ? c.json(cell) : c.text("unknown cell", 404);
    }),
  );

  app.post("/api/cells/:id/start", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        await cells.start(id);
        return c.body(null, 202);
      }),
    ),
  );

  app.post("/api/cells/:id/stop", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        await cells.stop(id);
        return c.body(null, 202);
      }),
    ),
  );

  app.delete("/api/cells/:id", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        await cells.remove(id, { purgeHome: c.req.query("purge") === "1" });
        tickets.revoke(id);
        return c.body(null, 204);
      }),
    ),
  );

  app.post("/api/cells/:id/stream-ticket", (c) =>
    withCell(c, (id) => {
      const cell = cells.get(id);
      if (!cell) return c.text("unknown cell", 404);
      if (cell.state !== "ready") return c.text(`cell is ${cell.state}`, 409);
      // The registry hands back the cell's live ticket, so a second viewer shares the same path.
      const ticket = tickets.issue(id);
      return c.json({ ticket, path: `/cells/${id}/desktop/${ticket}/` });
    }),
  );
}

function withCell(c: Context, fn: (id: string) => Response | Promise<Response>): Response | Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
  return fn(id);
}

async function withDocker(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnknownCellError) return c.text("unknown cell", 404);
    if (err instanceof DockerError) return c.text(err.message, 502);
    throw err;
  }
}
```

`apps/daemon/src/app.ts` — extend `AppOptions` and wire the routes (the rest of the file is unchanged):
```ts
import { type CellApiDeps, cellRoutes } from "./cells/api.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
}

export function createApp({ token, port, eventLog, cells }: AppOptions): Hono {
  // ... existing guard, /healthz, /api/* token middleware, /api/whoami, session routes ...
  if (cells) cellRoutes(app, cells);
  return app;
}
```
(Place the `cellRoutes` call after the existing session routes, inside `createApp`, so the `/api/*`
token middleware registered above it applies.)

`apps/daemon/src/main.ts` — replace the token/app/server block (keep the lock, port and home code):
```ts
import { DockerClient } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { CellOrchestrator } from "./cells/orchestrator.ts";
import { probeDesktopd, probeStream } from "./cells/readiness.ts";
import { TicketRegistry } from "./cells/secrets.ts";
import { cellStatusRoute } from "./cells/status-stream.ts";
import { CellStore } from "./cells/store.ts";
import { sessionStreamRoute } from "./event-stream.ts";
import { attachUpgradeRouter } from "./upgrade-router.ts";

const tokenFile = join(home, "daemon-token");
const token = loadOrCreateToken(tokenFile);
const eventLog = new EventLog(home);
const tickets = new TicketRegistry();
const orchestrator = new CellOrchestrator({
  docker: new DockerClient(),
  store: new CellStore(home),
  images: imagesFromEnv(),
  probeDesktopd,
  probeStream,
});
// The daemon serves the UI without Docker; the UI shows the cell as failed with the reason.
await orchestrator.reconcile().catch((err) => console.error(`cell reconcile failed: ${String(err)}`));
const app = createApp({ token, port, eventLog, cells: { cells: orchestrator, tickets } });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`localdot daemon on http://127.0.0.1:${port} (token in ${tokenFile})`);
  console.log(`open http://127.0.0.1:${port}/#token=${token}`);
});
// serve() is typed as HTTP/1-or-HTTP/2; this daemon only ever creates an HTTP/1 server.
attachUpgradeRouter(server as Server, { port, token }, [sessionStreamRoute(eventLog), cellStatusRoute(orchestrator)]);
server.on("error", (err: NodeJS.ErrnoException) => {
  fail(err.code === "EADDRINUSE" ? `port ${port} is already in use` : err.message);
});
```
Remove the now-unused `attachEventStream` import from `main.ts`. The `server.on("error")` handler is
the one Part 1 has: keep it, or a busy port ends the daemon with a stack trace.

- [ ] **Step 5: Run the suites**

Run: `pnpm exec vitest run apps/daemon/src`
Expected: every daemon unit suite passes (the Part 1 app, event-stream, event-log, guard, lock,
paths, port, token tests plus the cells tests, api and status-stream). Start the daemon
(`LOCALDOT_HOME=$(mktemp -d) pnpm --filter @localdot/daemon start`) and check it prints the
`open http://127.0.0.1:4750/#token=…` line, then stop it with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon
git commit -m "feat(daemon): cell API, status stream and upgrade router"
```

---
