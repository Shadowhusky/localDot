import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  Agent,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import type { Duplex } from "node:stream";
import type { PreviewTarget } from "@localdot/protocol";
import { ForwarderRefused } from "./tunnel.ts";

// The daemon's own paths on a preview's origin. A device signs in by opening the entry page with
// a one-use secret after the #, which its script trades for this preview's cookie.
export const ENTRY_PATH = "/__localdot/preview";
const ENTRY_SCRIPT = `${ENTRY_PATH}.js`;
// Cookies ignore ports, so every preview on a host sees every other's cookie: each has a name of its
// own, and every one of them is taken out of what a server receives.
const COOKIE_PREFIX = "__Host-localdot-preview-";
export const cookieName = (port: number) => `${COOKIE_PREFIX}${port}`;
const ENTRY_MS = 120_000;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
// Who the owner is and how the request reached this Mac stay out of what the server sees.
const PRIVATE_REQUEST = /^(?:x-forwarded-.+|forwarded|x-real-ip|tailscale-.+)$/;
// A server's say over the whole host, which other previews and localDot itself share.
const HOST_WIDE = new Set(["strict-transport-security", "alt-svc", "clear-site-data"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGE_HEADERS = {
  "content-security-policy": PAGE_POLICY,
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const ENTRY_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening preview</title><script defer src="${ENTRY_SCRIPT}"></script><p id="status">Opening preview…</p></html>`;
const ENTRY_CODE = `(async () => {
  const secret = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  try {
    const answer = await fetch(${JSON.stringify(ENTRY_PATH)}, { method: "POST", body: secret, cache: "no-store" });
    if (!answer.ok) throw new Error();
    const { next } = await answer.json();
    location.replace(new URL(next, location.origin).href);
  } catch {
    document.getElementById("status").textContent =
      "This preview link was already used or has expired. Open the preview again from localDot.";
  }
})();
`;

export interface SiteOptions {
  port: number;
  target: PreviewTarget;
  // The Host values a request may carry: the tailnet fronts' names with this port.
  hosts(): ReadonlySet<string>;
  // A new connection to the server, with TLS already started for an https server.
  connect(): Promise<Duplex>;
  // Another server used this port before, so a device's first visit clears what that one stored.
  reused: boolean;
  now?: () => number;
}

// One preview: a loopback listener that only the owner's tailnet fronts reach. It signs devices in,
// then hands each request and WebSocket to the server as if it came to the server's own address:
// Host, Origin and Referer name that address, redirects to it come back to the preview's, and
// bodies pass untouched.
export class PreviewSite {
  readonly id = randomBytes(12).toString("base64url");
  readonly #cookie = randomBytes(32).toString("base64url");
  readonly #entries = new Map<string, { path: string; expires: number }>();
  readonly #upgraded = new Set<Duplex>();
  readonly #server: Server;
  readonly #agent: Agent;
  readonly #now: () => number;
  #busy = 0;
  #lastUsed: number;

  constructor(readonly options: SiteOptions) {
    this.#now = options.now ?? Date.now;
    this.#lastUsed = this.#now();
    this.#agent = new TunnelAgent(options.connect);
    this.#server = createServer((req, res) => this.#request(req, res));
    this.#server.on("upgrade", (req, socket, head) => this.#upgrade(req, socket, head));
  }

  get port(): number {
    return this.options.port;
  }

  get target(): PreviewTarget {
    return this.options.target;
  }

  // How long nothing has used it: never idle while a request or a socket is open.
  idleFor(): number {
    return this.#busy || this.#upgraded.size ? 0 : this.#now() - this.#lastUsed;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.#server.once("error", failed);
      this.#server.listen(this.port, "127.0.0.1", () => {
        this.#server.off("error", failed);
        this.#server.on("error", () => {});
        resolve();
      });
    });
  }

  // A secret that signs one device in once, within two minutes, and then opens `path`.
  mint(path: string): string {
    const now = this.#now();
    for (const [secret, entry] of this.#entries)
      if (entry.expires <= now) this.#entries.delete(secret);
    const secret = randomBytes(32).toString("base64url");
    const safe = path.startsWith("//") ? `/${path.replace(/^\/+/, "")}` : path;
    this.#entries.set(secret, { path: safe || "/", expires: now + ENTRY_MS });
    return secret;
  }

  close(): void {
    this.#server.close();
    this.#server.closeAllConnections();
    for (const socket of this.#upgraded) socket.destroy();
    this.#upgraded.clear();
    this.#agent.destroy();
    this.#entries.clear();
  }

  #request(req: IncomingMessage, res: ServerResponse) {
    const host = this.#host(req);
    if (!host) return plain(res, 403, "forbidden host");
    const path = (req.url ?? "").split("?")[0];
    if (path === ENTRY_PATH && req.method === "GET")
      return page(res, 200, ENTRY_PAGE, "text/html; charset=utf-8");
    if (path === ENTRY_SCRIPT && req.method === "GET")
      return page(res, 200, ENTRY_CODE, "text/javascript; charset=utf-8");
    if (path === ENTRY_PATH && req.method === "POST") return void this.#enter(req, res, host);
    if (!this.#signedIn(req.headers))
      return req.method === "GET"
        ? message(res, 401, "Open this preview from localDot to sign this device in to it.")
        : plain(res, 401, "unauthorized");
    if (!req.url?.startsWith("/")) return plain(res, 400, "bad request");
    this.#forward(req, res, host);
  }

  // The request's Host, when it is one of the fronts this preview is served through: anything else
  // (a page that rebound a name of its own to this Mac) is refused.
  #host(req: IncomingMessage): string | undefined {
    const host = req.headers.host?.toLowerCase();
    return host && this.options.hosts().has(host) ? host : undefined;
  }

  #signedIn(headers: IncomingHttpHeaders): boolean {
    const given = cookies(headers.cookie).get(cookieName(this.port));
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.#cookie);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async #enter(req: IncomingMessage, res: ServerResponse, host: string) {
    if (req.headers.origin !== `https://${host}`) return plain(res, 403, "forbidden origin");
    if (!/^text\/plain(?:;|$)/i.test(req.headers["content-type"] ?? ""))
      return plain(res, 415, "text required");
    const secret = await readSmall(req);
    const entry = secret && SECRET.test(secret) ? this.#entries.get(secret) : undefined;
    if (secret) this.#entries.delete(secret);
    if (!entry || entry.expires <= this.#now()) return plain(res, 401, "link used or expired");
    this.#lastUsed = this.#now();
    res.writeHead(200, {
      ...PAGE_HEADERS,
      "content-type": "application/json",
      "set-cookie": `${cookieName(this.port)}=${this.#cookie}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      ...(this.options.reused && !this.#signedIn(req.headers)
        ? { "clear-site-data": '"cache", "storage"' }
        : {}),
    });
    res.end(JSON.stringify({ next: entry.path }));
  }

  #forward(req: IncomingMessage, res: ServerResponse, host: string) {
    this.#busy++;
    this.#lastUsed = this.#now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.#busy--;
      this.#lastUsed = this.#now();
    };
    res.once("close", finish);
    const up = request({
      agent: this.#agent,
      method: req.method,
      path: req.url,
      headers: serverHeaders(req.headers, host, this.target),
      setHost: false,
    });
    up.on("response", (answer) => {
      answer.on("error", () => res.destroy());
      res.writeHead(
        answer.statusCode ?? 502,
        answer.statusMessage,
        deviceHeaders(answer.rawHeaders, host, this.target, false),
      );
      answer.pipe(res);
    });
    up.on("error", (error) => {
      if (res.headersSent) res.destroy();
      else failure(res, error, this.target);
    });
    res.once("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    const host = this.#host(req);
    if (!host) return refuseRaw(socket, 403);
    if (!this.#signedIn(req.headers)) return refuseRaw(socket, 401);
    // Another site's page could open a socket that carries the owner's cookie, and the server would
    // take the rewritten Origin for its own: only this preview's own pages may.
    if (req.headers.origin !== `https://${host}`) return refuseRaw(socket, 403);
    if (!req.url?.startsWith("/")) return refuseRaw(socket, 400);
    this.#upgraded.add(socket);
    this.#lastUsed = this.#now();
    socket.once("close", () => {
      this.#upgraded.delete(socket);
      this.#lastUsed = this.#now();
    });
    const up = request({
      createConnection: later(this.options.connect),
      method: req.method,
      path: req.url,
      headers: {
        ...serverHeaders(req.headers, host, this.target),
        connection: "Upgrade",
        upgrade: req.headers.upgrade ?? "websocket",
      },
      setHost: false,
    });
    socket.once("close", () => up.destroy());
    up.on("upgrade", (answer, server, serverHead) => {
      server.on("error", () => socket.destroy());
      socket.on("close", () => server.destroy());
      server.on("close", () => socket.destroy());
      socket.write(
        statusLine(answer) + rawLines(deviceHeaders(answer.rawHeaders, host, this.target, true)),
      );
      if (serverHead.length) socket.write(serverHead);
      if (head.length) server.write(head);
      server.pipe(socket);
      socket.pipe(server);
    });
    // The server turned the socket down: its answer goes back as it is, then the connection ends.
    up.on("response", (answer) => {
      socket.write(
        statusLine(answer) +
          rawLines([
            ...deviceHeaders(answer.rawHeaders, host, this.target, false),
            "Connection",
            "close",
          ]),
      );
      answer.pipe(socket);
    });
    up.on("error", (error) =>
      refuseRaw(
        socket,
        error instanceof ForwarderRefused && error.reason === "refused-port" ? 403 : 502,
      ),
    );
    up.end();
  }
}

class TunnelAgent extends Agent {
  constructor(private readonly open: () => Promise<Duplex>) {
    // HTTP/1.1 as a browser would: a few connections per preview, kept for the next request.
    super({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });
  }

  override createConnection(
    _options: unknown,
    done?: (error: Error | null, socket: Duplex) => void,
  ): undefined {
    if (done) later(this.open)(undefined, done);
    return undefined;
  }
}

// A tunnel comes paused, so nothing it carries is lost before its taker listens: the request
// attaches its listeners on the next tick, before the resumed socket reads again.
function later(open: () => Promise<Duplex>) {
  return (_options: unknown, done: (error: Error | null, socket: Duplex) => void): undefined => {
    open().then(
      (socket) => {
        done(null, socket);
        socket.resume();
      },
      (error: Error) => (done as (error: Error) => void)(error),
    );
    return undefined;
  };
}

export function cookies(header: string | undefined): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) found.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return found;
}

// What the server receives: the request as the browser sent it, addressed to the server itself,
// without the hop's own headers, the previews' cookies or who the owner is.
export function serverHeaders(
  headers: IncomingHttpHeaders,
  host: string,
  target: PreviewTarget,
): Record<string, string | string[]> {
  const own = `https://${host}`;
  const server = `${target.scheme}://${target.host}`;
  const hop = new Set([
    ...HOP,
    ...(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  ]);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !hop.has(name) && !PRIVATE_REQUEST.test(name)) out[name] = value;
  out.host = target.host;
  if (headers.origin === own) out.origin = server;
  const referer = headers.referer;
  if (referer === own || referer?.startsWith(`${own}/`))
    out.referer = `${server}${referer.slice(own.length)}`;
  const kept = (headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(COOKIE_PREFIX));
  if (kept.length) out.cookie = kept.join("; ");
  else delete out.cookie;
  return out;
}

// What the device receives: the server's answer as raw header pairs, without what would reach past
// this preview, and with redirects to the server's address sent to the preview's.
export function deviceHeaders(
  raw: readonly string[],
  host: string,
  target: PreviewTarget,
  upgrade: boolean,
): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    let value = raw[i + 1] as string;
    const lower = name.toLowerCase();
    if (HOST_WIDE.has(lower) || (!upgrade && HOP.has(lower))) continue;
    if (lower === "set-cookie" && value.trimStart().startsWith(COOKIE_PREFIX)) continue;
    if (lower === "location" || lower === "content-location")
      value = toPreview(value, host, target);
    out.push(name, value);
  }
  return out;
}

function toPreview(value: string, host: string, target: PreviewTarget): string {
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const named = new URL(`${target.scheme}://${target.host}`).hostname;
  const same =
    url.protocol === `${target.scheme}:` &&
    port === target.port &&
    (url.hostname === named || (LOOPBACK.has(url.hostname) && LOOPBACK.has(named)));
  return same ? `https://${host}${url.pathname}${url.search}${url.hash}` : value;
}

function failure(res: ServerResponse, error: Error, target: PreviewTarget) {
  if (error instanceof ForwarderRefused && error.reason === "refused-port")
    return message(res, 403, "localDot's own services can't be opened as a preview.");
  if (error instanceof ForwarderRefused && error.reason === "unreachable")
    return message(
      res,
      502,
      `Nothing is answering at ${target.host} in your computer. Start the server again, then reload this page.`,
    );
  if (error.name === "ForwarderMissing")
    return message(
      res,
      502,
      "Your computer isn't answering. Check that it's on, then reload this page.",
    );
  return message(
    res,
    502,
    target.scheme === "https"
      ? `The server at ${target.host} didn't answer over HTTPS. Reload this page to try again.`
      : `The server at ${target.host} stopped answering. Reload this page to try again.`,
  );
}

function plain(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { ...PAGE_HEADERS, "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function page(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { ...PAGE_HEADERS, "content-type": type });
  res.end(body);
}

function message(res: ServerResponse, status: number, text: string) {
  page(
    res,
    status,
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title><p>${text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p></html>`,
    "text/html; charset=utf-8",
  );
}

function statusLine(answer: IncomingMessage): string {
  const status = answer.statusCode ?? 502;
  return `HTTP/1.1 ${status} ${answer.statusMessage || STATUS_CODES[status] || ""}\r\n`;
}

function rawLines(pairs: readonly string[]): string {
  let text = "";
  for (let i = 0; i + 1 < pairs.length; i += 2) text += `${pairs[i]}: ${pairs[i + 1]}\r\n`;
  return `${text}\r\n`;
}

function refuseRaw(socket: Duplex, status: number) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

async function readSmall(req: IncomingMessage): Promise<string | undefined> {
  let text = "";
  for await (const chunk of req) {
    text += chunk.toString();
    if (text.length > 256) return undefined;
  }
  return text.trim();
}
