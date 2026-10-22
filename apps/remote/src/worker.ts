import { DurableObject } from "cloudflare:workers";
import {
  CHUNK,
  cleanHeaders,
  DEVICE,
  HEARTBEAT,
  HEARTBEAT_ACK,
  HOST_SUFFIX,
  MAX_CHANNELS,
  MAX_FRAME,
  MAX_UPLOAD,
  type Open,
  SECRET,
} from "../../../packages/protocol/src/remote-wire.ts";
import { bouncePage, crossSiteEntry, pairPage } from "./pair-page.ts";

const COOKIE = "__Host-localdot-remote";
const encoder = new TextEncoder();
async function digest(s: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function same(a: string, b: string): boolean {
  return (
    a.length === b.length && crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b))
  );
}
function reply(text: string, status = 503): Response {
  return new Response(text, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
    },
  });
}
type Attachment =
  | { role: "host"; access: string; budget?: { at: number; count: number } }
  | { role: "viewer" | "upstream"; id: string }
  | { role: "http"; id: string };
type Pending = {
  open: Open;
  request: Request;
  resolve(response: Response): void;
  timer: ReturnType<typeof setTimeout>;
  socket?: WebSocket;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  rest?: Uint8Array;
  uploaded: number;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  reading?: boolean;
  responsePull?: { promise: Promise<void>; resolve(): void };
};

// One device per object. Only live socket metadata survives hibernation; no traffic is stored.
export class DeviceRelay extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  private host(): WebSocket | undefined {
    return this.ctx.getWebSockets("host").find((s) => s.readyState === WebSocket.OPEN);
  }
  private tag(s: WebSocket): Attachment {
    return s.deserializeAttachment() as Attachment;
  }
  private accept(tag: Attachment, tags: string[]): { client: WebSocket; server: WebSocket } {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], tags);
    pair[1].serializeAttachment(tag);
    return { client: pair[0], server: pair[1] };
  }
  private finish(id: string, reason = "Connection interrupted"): void {
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      void p.reader?.cancel().catch(() => {});
      p.controller?.error(new Error(reason));
      p.responsePull?.resolve();
      p.responsePull = undefined;
      p.resolve(reply(reason));
    }
    for (const s of this.ctx.getWebSockets(id)) {
      try {
        s.close(1011, reason);
      } catch {}
    }
  }
  private timeout(id: string): ReturnType<typeof setTimeout> {
    return setTimeout(
      () => this.finish(id, "The computer took too long to respond. Try again."),
      60_000,
    );
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const owner = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const id = (url.hostname.split(".")[0] ?? "").replace(new RegExp(`${HOST_SUFFIX}$`), "");
    if (url.pathname === "/_remote/host" || url.pathname.startsWith("/_remote/channel/")) {
      if (!upgrade || !SECRET.test(owner) || (await digest(owner)).slice(0, 32) !== id)
        return reply("Unauthorized", 401);
      if (url.pathname === "/_remote/host") {
        const access = request.headers.get("x-localdot-access-sha256") ?? "";
        if (!SECRET.test(access)) return reply("Invalid connection", 400);
        // A reconnect replaces every old channel; never replay a possibly completed mutation.
        for (const key of this.pending.keys()) this.finish(key);
        for (const s of this.ctx.getWebSockets()) {
          try {
            s.close(1012, "Computer reconnected");
          } catch {}
        }
        const { client } = this.accept({ role: "host", access }, ["host"]);
        this.ctx.setWebSocketAutoResponse(
          new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT_ACK),
        );
        return new Response(null, { status: 101, webSocket: client });
      }
      const channel = url.pathname.slice("/_remote/channel/".length);
      const p = this.pending.get(channel);
      if (!p || p.socket || !this.host()) return reply("Unknown channel", 404);
      if (p.open.kind === "ws") {
        const protocol = request.headers.get("x-localdot-protocol");
        const offered = p.request.headers.get("sec-websocket-protocol")?.split(/\s*,\s*/) ?? [];
        if (protocol && !offered.includes(protocol)) return reply("Invalid protocol", 400);
        const upstream = this.accept({ role: "upstream", id: channel }, [channel]);
        const viewer = this.accept({ role: "viewer", id: channel }, [channel]);
        clearTimeout(p.timer);
        this.pending.delete(channel);
        p.resolve(
          new Response(null, {
            status: 101,
            webSocket: viewer.client,
            headers: protocol ? { "sec-websocket-protocol": protocol } : {},
          }),
        );
        return new Response(null, { status: 101, webSocket: upstream.client });
      }
      const { client, server } = this.accept({ role: "http", id: channel }, [channel]);
      p.socket = server;
      return new Response(null, { status: 101, webSocket: client });
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return reply("Forbidden origin", 403);
    const host = this.host();
    if (!host)
      return reply("Your localDot is offline. Open localDot on your computer and try again.");
    const state = this.tag(host);
    if (state.role !== "host") return reply("Unavailable");
    if (url.pathname === "/_remote/unlock" && request.method === "POST") {
      if (origin !== url.origin || request.headers.get("content-type") !== "application/json")
        return reply("Forbidden", 403);
      const budget =
        state.budget && Date.now() - state.budget.at < 60_000
          ? state.budget
          : { at: Date.now(), count: 0 };
      budget.count++;
      host.serializeAttachment({ ...state, budget });
      if (budget.count > 12) return reply("Try again shortly", 429);
      // The stream is bounded even when Content-Length is missing or dishonest.
      const reader = request.body?.getReader();
      let body = "";
      if (!reader) return reply("Invalid request", 400);
      const timer = setTimeout(() => {
        void reader.cancel();
      }, 5000);
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          body += new TextDecoder().decode(part.value);
          if (body.length > 128) {
            void reader.cancel();
            return reply("Too large", 413);
          }
        }
        const value = JSON.parse(body) as { key?: string };
        if (
          typeof value.key !== "string" ||
          !SECRET.test(value.key) ||
          !same(await digest(value.key), state.access)
        )
          return reply("Invalid link", 401);
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "set-cookie": `${COOKIE}=${value.key}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
          },
        });
      } catch {
        return reply("Invalid request", 400);
      } finally {
        clearTimeout(timer);
      }
    }
    if (request.method === "GET" && url.pathname === "/_remote/pair" && !upgrade) return pairPage();
    const key =
      request.headers
        .get("cookie")
        ?.split(/;\s*/)
        .find((v) => v.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1) ?? "";
    if (!SECRET.test(key) || !same(await digest(key), state.access)) {
      if (crossSiteEntry(request, url)) return bouncePage(url);
      return request.method === "GET" &&
        !upgrade &&
        (url.pathname === "/" || request.headers.get("sec-fetch-mode") === "navigate")
        ? pairPage()
        : reply("Pair this browser from localDot Settings", 401);
    }
    if (url.pathname.startsWith("/_remote/")) return reply("Not found", 404);
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method))
      return reply("Unsupported method", 405);
    if (this.pending.size + this.ctx.getWebSockets().length >= MAX_CHANNELS)
      return reply("Too many connections. Try again shortly.", 429);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD)
      return reply("Upload is too large", 413);
    const channel = crypto.randomUUID();
    const headers = cleanHeaders(request.headers);
    const protocols = request.headers.get("sec-websocket-protocol");
    if (protocols) headers.push(["sec-websocket-protocol", protocols]);
    headers.push(["host", url.host], ["x-forwarded-for", "remote"], ["x-forwarded-proto", "https"]);
    const open: Open = {
      id: channel,
      kind: upgrade ? "ws" : "http",
      path: url.pathname + url.search,
      method: request.method,
      headers,
    };
    const response = new Promise<Response>((resolve) =>
      this.pending.set(channel, {
        open,
        request,
        resolve,
        timer: this.timeout(channel),
        uploaded: 0,
        reader: request.body?.getReader(),
      }),
    );
    request.signal.addEventListener("abort", () => this.finish(channel), { once: true });
    host.send(JSON.stringify(open));
    return response;
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tag = this.tag(socket);
    if ((typeof message === "string" ? message.length : message.byteLength) > MAX_FRAME) {
      socket.close(1009, "Message too large");
      return;
    }
    if (tag.role === "host") {
      if (socket !== this.host() || typeof message !== "string") return;
      try {
        const value = JSON.parse(message) as { failed?: string };
        if (typeof value.failed === "string" && this.pending.has(value.failed))
          this.finish(value.failed, "The computer could not open this connection. Try again.");
      } catch {}
      return;
    }
    if (tag.role === "viewer" || tag.role === "upstream") {
      const peer = this.ctx
        .getWebSockets(tag.id)
        .find((s) => s !== socket && s.readyState === WebSocket.OPEN);
      if (peer) peer.send(message);
      else socket.close(1011, "Connection interrupted");
      return;
    }
    const p = this.pending.get(tag.id);
    if (!p) {
      socket.close(1000);
      return;
    }
    clearTimeout(p.timer);
    p.timer = this.timeout(tag.id);
    try {
      if (typeof message !== "string") {
        if (!p.controller || message.byteLength > CHUNK) throw Error();
        p.controller.enqueue(new Uint8Array(message));
        p.responsePull?.resolve();
        p.responsePull = undefined;
      } else if (message === "pull-upload") {
        if (p.reading) throw Error();
        p.reading = true;
        const part = p.rest?.length ? { value: p.rest, done: false } : await p.reader?.read();
        if (!this.pending.has(tag.id)) return;
        if (!part || part.done) {
          socket.send("upload-end");
          p.reading = false;
          return;
        }
        const chunk = part.value.subarray(0, CHUNK);
        p.rest = part.value.subarray(CHUNK);
        p.uploaded += chunk.byteLength;
        if (p.uploaded > MAX_UPLOAD) throw Error();
        socket.send(chunk);
        p.reading = false;
      } else if (message === "response-end") {
        p.controller?.close();
        p.controller = undefined;
        this.finish(tag.id, "Complete");
      } else {
        if (p.controller) throw Error();
        const meta = JSON.parse(message) as { status: number; headers: [string, string][] };
        if (
          !Number.isInteger(meta.status) ||
          meta.status < 200 ||
          meta.status > 599 ||
          !Array.isArray(meta.headers)
        )
          throw Error();
        const headers = new Headers(cleanHeaders(meta.headers));
        headers.set("cache-control", "no-store");
        const noBody = p.open.method === "HEAD" || [204, 205, 304].includes(meta.status);
        const stream = noBody
          ? null
          : new ReadableStream<Uint8Array>(
              {
                start: (controller) => {
                  p.controller = controller;
                },
                pull: () => {
                  // A pull remains pending until its WebSocket chunk arrives. Returning
                  // immediately lets the edge reader issue overlapping pulls over the network.
                  if (p.responsePull) return p.responsePull.promise;
                  let resolve!: () => void;
                  const promise = new Promise<void>((done) => {
                    resolve = done;
                  });
                  p.responsePull = { promise, resolve };
                  socket.send("pull-response");
                  return promise;
                },
                cancel: () => this.finish(tag.id),
              },
              { highWaterMark: 0 },
            );
        p.resolve(new Response(stream, { status: meta.status, headers }));
        if (noBody) this.finish(tag.id, "Complete");
      }
    } catch {
      this.finish(tag.id);
    }
  }
  webSocketClose(socket: WebSocket): void {
    const tag = this.tag(socket);
    if (tag.role === "host") {
      if (this.host() && this.host() !== socket) return;
      for (const id of this.pending.keys()) this.finish(id);
      for (const peer of this.ctx.getWebSockets()) {
        try {
          peer.close(1012, "Computer disconnected");
        } catch {}
      }
    } else this.finish(tag.id);
  }
  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }
}

// biome-ignore lint/style/noDefaultExport: Cloudflare's module entry point.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return reply("Use HTTPS to connect", 400);
    const suffix = `${HOST_SUFFIX}.${env.REMOTE_DOMAIN}`;
    const id = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : "";
    if (!DEVICE.test(id) || url.search.length > 8192) return reply("Not found", 404);
    return env.DEVICES.getByName(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
