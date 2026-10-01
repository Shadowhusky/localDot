import { ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { readStatic, type StaticFile } from "../static-files.ts";
import { refuse, type UpgradeContext, type UpgradeRoute } from "../upgrade-router.ts";
import type { CellApi } from "./orchestrator.ts";
import { readCapped } from "./readiness.ts";
import type { TicketRegistry } from "./secrets.ts";
import type { StreamEndpoint } from "./types.ts";
import { StallWatchdog } from "./watchdog.ts";

// Selkies encodes only on damage, so a still screen sends nothing, and its aiohttp heartbeat (30 s)
// never fires while the daemon pings: every frame it receives resets it. Selkies' receive loop
// answers the daemon's pings itself (autoping=False), so each pong proves its handler is alive.
// S8 measured at most 505 ms between signs of life on a live stream.
export const STREAM_PING_MS = 500;
export const STREAM_STALL_MS = 1500;
const UPSTREAM_TIMEOUT_MS = 10_000;

// The only cell endpoints Selkies' client calls (S8): GET api/status at start, and a plain GET of
// api/websockets before each self-reload. Each answer gets the type set here, never the cell's, so
// nothing a cell sends can run as a page in the daemon's origin.
const CELL_API = new Map([
  ["/api/status", "application/json"],
  ["/api/websockets", "text/plain; charset=utf-8"],
]);
const MAX_CELL_ANSWER_BYTES = 64 * 1024;
const SERVED = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const UNDER_TICKET = /^\/cells\/[^/]+\/desktop\/[^/]+(\/.*)$/;

export interface StreamProxyDeps {
  cells: CellApi;
  tickets: TicketRegistry;
  vendorDir: string;
  pingEveryMs?: number;
  stallAfterMs?: number;
  upstreamTimeoutMs?: number;
}

// The ready check stands on its own: a revocation lost with a state event must not leave a
// ticket that still opens the stream of a cell that is failing or restarting.
function cellFor(deps: StreamProxyDeps, id: string, ticket: string): string | undefined {
  if (!ULID_PATTERN.test(id) || deps.tickets.resolve(ticket) !== id) return undefined;
  return deps.cells.get(id)?.state === "ready" ? id : undefined;
}

export function desktopRoutes(app: Hono, deps: StreamProxyDeps): void {
  // Hono answers HEAD from this route without the body; the client probes its page with HEAD.
  app.get("/cells/:id/desktop/:ticket/*", async (c) => {
    const id = cellFor(deps, c.req.param("id") ?? "", c.req.param("ticket") ?? "");
    if (!id) return c.text("forbidden", 403);
    const rel = UNDER_TICKET.exec(new URL(c.req.url).pathname)?.[1] ?? "";
    if (rel.startsWith("/api/")) {
      const type = c.req.method === "GET" ? CELL_API.get(rel) : undefined;
      return type ? proxyApi(c, deps, id, rel, type) : c.text("not found", 404);
    }
    const file = vendored(deps.vendorDir, rel);
    if (!file) return c.text("not found", 404);
    return c.body(file.body, 200, { ...SERVED, "content-type": file.type });
  });
  app.all("/cells/:id/desktop/:ticket/*", (c) => c.text("method not allowed", 405));
}

function vendored(dir: string, rel: string): StaticFile | undefined {
  try {
    const path = decodeURIComponent(rel);
    return readStatic(dir, path === "/" ? "/index.html" : path);
  } catch {
    return undefined;
  }
}

// Only the proxy's own credential reaches the cell: none of the viewer's headers, nor its query.
async function proxyApi(
  c: Context,
  deps: StreamProxyDeps,
  id: string,
  path: string,
  type: string,
): Promise<Response> {
  const endpoints = deps.cells.endpoints(id);
  if (!endpoints) return c.text("cell not running", 503);
  try {
    const res = await fetch(`${endpoints.stream.baseUrl}${path}`, {
      headers: { authorization: endpoints.stream.authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS),
    });
    const body = await readCapped(res, MAX_CELL_ANSWER_BYTES);
    // The client's fetch wrapper reloads its page on a same-origin 401 (S8): the cell refusing
    // the proxy's credential is the gateway's failure, not the viewer's.
    if (body === undefined || res.status === 401) return c.text("bad gateway", 502);
    return new Response(body, { status: res.status, headers: { ...SERVED, "content-type": type } });
  } catch {
    return c.text("cell unreachable", 502);
  }
}

export function desktopStreamRoute(deps: StreamProxyDeps): UpgradeRoute {
  const wss = new WebSocketServer({ noServer: true });
  const streams = new CellStreams(deps.cells);
  return {
    pattern: /^\/cells\/([^/]+)\/desktop\/([^/]+)\/api\/websockets$/,
    params: ["id", "ticket"],
    auth: "ticket",
    open({ req, socket, head, params }) {
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
      relay({ req, socket, head }, { id, stream: endpoints.stream, deps, streams, wss });
    },
  };
}

interface RelayOptions {
  id: string;
  stream: StreamEndpoint;
  deps: StreamProxyDeps;
  streams: CellStreams;
  wss: WebSocketServer;
}

// The cell is dialled first and the viewer's upgrade completes from its open: Selkies' client sends
// its settings the moment its socket opens, and the server streams nothing until it has them.
function relay(
  { req, socket, head }: Pick<UpgradeContext, "req" | "socket" | "head">,
  opts: RelayOptions,
): void {
  const { id, deps, streams } = opts;
  const upstream = new WebSocket(`${opts.stream.baseUrl.replace(/^http/, "ws")}/api/websockets`, {
    headers: { authorization: opts.stream.authorization },
    perMessageDeflate: false,
    handshakeTimeout: deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
  });
  const viewer = streams.open(id);
  const watchdog = new StallWatchdog({
    pingEveryMs: deps.pingEveryMs ?? STREAM_PING_MS,
    stallAfterMs: deps.stallAfterMs ?? STREAM_STALL_MS,
    ping: () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.ping();
    },
    onChange: (state, lastAt) => streams.update(id, viewer, state, lastAt),
  });
  let client: WebSocket | undefined;
  let finished = false;
  // The relay leaves the count as soon as either side goes: the cell's close handshake can take
  // seconds, and its silence meanwhile must not read as a stall.
  const finish = (last: "none" | "disconnected") => {
    if (finished) return;
    finished = true;
    watchdog.stop();
    streams.close(id, viewer, last, watchdog.lastAt);
  };
  const abandon = () => {
    finish("none");
    upstream.terminate();
  };
  socket.once("close", abandon);

  upstream.on("open", () => {
    opts.wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("close", abandon);
      client = ws;
      ws.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        finish("none");
        upstream.close();
      });
      watchdog.start();
      streams.update(id, viewer, "live", watchdog.lastAt);
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
    const refused = !client && !finished;
    finish("disconnected");
    if (refused) refuse(socket, "502 Bad Gateway");
    else if (client?.readyState === WebSocket.OPEN) client.close(1012, "upstream closed");
  });
}

type RelayState = "connecting" | "live" | "stalled";

interface Viewer {
  state: RelayState;
  lastAt: number;
}

const HEALTH: Record<RelayState, number> = { connecting: 0, stalled: 1, live: 2 };

// The API hands every viewer of a cell the same ticket, so a cell can have several relays: its
// stream state is the healthiest one's, and one viewer connecting, stalling or leaving never hides
// another's live stream.
class CellStreams {
  readonly #viewers = new Map<string, Set<Viewer>>();
  readonly #cells: CellApi;

  constructor(cells: CellApi) {
    this.#cells = cells;
  }

  open(id: string): Viewer {
    const viewer: Viewer = { state: "connecting", lastAt: 0 };
    this.#viewers.set(id, (this.#viewers.get(id) ?? new Set()).add(viewer));
    this.#report(id);
    return viewer;
  }

  update(id: string, viewer: Viewer, state: RelayState, lastAt: number): void {
    viewer.state = state;
    viewer.lastAt = lastAt;
    this.#report(id);
  }

  close(id: string, viewer: Viewer, last: "none" | "disconnected", lastAt: number): void {
    const viewers = this.#viewers.get(id);
    viewers?.delete(viewer);
    if (viewers?.size) {
      this.#report(id);
      return;
    }
    this.#viewers.delete(id);
    this.#cells.updateStream(id, { connection: last, viewers: 0, lastUpstreamAt: lastAt || null });
  }

  #report(id: string): void {
    const viewers = [...(this.#viewers.get(id) ?? [])];
    const best = viewers.reduce<RelayState>(
      (state, v) => (HEALTH[v.state] > HEALTH[state] ? v.state : state),
      "connecting",
    );
    const lastAt = Math.max(0, ...viewers.map((v) => v.lastAt));
    this.#cells.updateStream(id, {
      connection: best,
      viewers: viewers.length,
      lastUpstreamAt: lastAt || null,
    });
  }
}
