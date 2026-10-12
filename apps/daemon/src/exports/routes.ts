import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { Readable } from "node:stream";
import { ExportStart, type HostExport, ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StatusSocket } from "../cells/status-stream.ts";
import { refuse, tokenSocketServer, type UpgradeRoute } from "../upgrade-router.ts";
import { type ExportJobs, ExportRefused } from "./jobs.ts";

const LINK_MS = 10 * 60 * 1000;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const TYPES = { mp4: "video/mp4", webm: "video/webm" } as const;

// A download link carries no install token, so a plain link can save the file (a phone's browser
// downloads it outside the page): 256 random bits, one finished video, ten minutes, memory only.
export class ExportLinks {
  readonly #links = new Map<string, { id: string; until: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(id: string): string {
    const now = this.#now();
    for (const [ticket, link] of this.#links) if (link.until <= now) this.#links.delete(ticket);
    const ticket = randomBytes(32).toString("base64url");
    this.#links.set(ticket, { id, until: now + LINK_MS });
    return ticket;
  }

  resolve(ticket: string): string | undefined {
    if (!TICKET.test(ticket)) return undefined;
    const given = Buffer.from(ticket);
    const now = this.#now();
    for (const [live, link] of this.#links)
      if (timingSafeEqual(given, Buffer.from(live))) return link.until > now ? link.id : undefined;
    return undefined;
  }
}

function disposition(name: string): string {
  return `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendFile(c: Context, jobs: ExportJobs, id: string): Response {
  const found = ULID_PATTERN.test(id) ? jobs.file(id) : undefined;
  if (!found) return c.text("not found", 404);
  const info = lstatSync(found.path, { throwIfNoEntry: false });
  if (!info?.isFile()) return c.text("not found", 404);
  const range = c.req.header("range");
  let start = 0,
    end = info.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return c.body(null, 416, { "content-range": `bytes */${info.size}` });
    start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start < 0 ||
      start >= info.size
    )
      return c.body(null, 416, { "content-range": `bytes */${info.size}` });
  }
  const stream = Readable.toWeb(
    createReadStream(found.path, range ? { start, end } : undefined),
  ) as ReadableStream<Uint8Array>;
  return c.body(stream, range ? 206 : 200, {
    "content-type": TYPES[found.record.request.format],
    "content-length": String(range ? end - start + 1 : info.size),
    "accept-ranges": "bytes",
    ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}),
    "content-disposition":
      c.req.query("preview") === "1"
        ? disposition(found.record.name).replace(/^attachment/, "inline")
        : disposition(found.record.name),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "sandbox; default-src 'none'",
  });
}

function refused(c: Context, error: unknown): Response {
  if (error instanceof ExportRefused) return c.text(error.message, error.status);
  throw error;
}

export function exportRoutes(app: Hono, jobs: ExportJobs, links: ExportLinks): void {
  app.get("/api/exports", (c) => {
    void jobs.check();
    return c.json(jobs.state());
  });
  app.post("/api/exports", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const parsed = ExportStart.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("invalid export", 400);
    await jobs.check();
    try {
      return c.json<HostExport>(jobs.start(parsed.data), 201);
    } catch (error) {
      return refused(c, error);
    }
  });
  app.post("/api/exports/:id/cancel", (c) => {
    try {
      jobs.cancel(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return refused(c, error);
    }
  });
  app.post("/api/exports/:id/retry", async (c) => {
    await jobs.check();
    try {
      return c.json<HostExport>(jobs.retry(c.req.param("id")));
    } catch (error) {
      return refused(c, error);
    }
  });
  app.delete("/api/exports/:id", (c) => {
    try {
      jobs.remove(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return refused(c, error);
    }
  });
  app.post("/api/exports/:id/link", (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id) || !jobs.file(id)) return c.text("not found", 404);
    return c.json({ href: `/export-files/${links.issue(id)}` });
  });
  app.get("/api/exports/:id/file", (c) => sendFile(c, jobs, c.req.param("id")));
  app.get("/export-files/:ticket", (c) => {
    const id = links.resolve(c.req.param("ticket"));
    return id ? sendFile(c, jobs, id) : c.text("not found", 404);
  });
}

// Every viewer gets the whole list on connecting and again on each change, so one that falls
// behind is cut off and starts again from the current state when it reconnects.
export function exportsStreamRoute(jobs: ExportJobs): UpgradeRoute {
  const wss = tokenSocketServer();
  return {
    pattern: /^\/api\/exports\/stream$/,
    params: [],
    auth: "token",
    open({ req, socket, head }) {
      if (req.method !== "GET") {
        refuse(socket, "405 Method Not Allowed");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => followExports(ws, jobs));
    },
  };
}

export function followExports(ws: StatusSocket, jobs: ExportJobs): void {
  const send = (state: ReturnType<ExportJobs["state"]>) => {
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
    else ws.send(JSON.stringify(state));
  };
  ws.on("error", () => {});
  const unsubscribe = jobs.subscribe(send);
  ws.on("close", unsubscribe);
  send(jobs.state());
  void jobs.check();
}
