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
import { type Duplex, pipeline, type Transform } from "node:stream";
import { constants, createGzip } from "node:zlib";
import { type PreviewTarget, previewTarget } from "@localdot/protocol";
import {
  bodyRewrite,
  type Computer,
  deviceCookie,
  deviceHeader,
  type Route,
  TextRewriter,
  VIA_PATH,
  viaOf,
} from "./rewrite.ts";
import { ForwarderRefused } from "./tunnel.ts";

// The daemon's own paths on a preview's origin. A device signs in by opening the entry page with
// a one-use secret after the #, which its script trades for this preview's cookie.
export const ENTRY_PATH = "/__localdot/preview";
const ENTRY_SCRIPT = `${ENTRY_PATH}.js`;
const PAGE_STYLE = `${ENTRY_PATH}.css`;
// Cookies ignore ports, so every preview on a host sees every other's cookie: each has a name of its
// own, and every one of them is taken out of what a server receives.
const COOKIE_PREFIX = "__Host-localdot-preview-";
export const cookieName = (port: number) => `${COOKIE_PREFIX}${port}`;
const ENTRY_MS = 120_000;
// How long a page the device opens may take to start answering before it is told why and offered
// another try. Requests a page makes itself (events, long polls, uploads) have no limit.
const NAVIGATE_MS = 30_000;
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
const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGE_HEADERS = {
  "content-security-policy": PAGE_POLICY,
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const PAGE_CSS = `:root{color-scheme:light dark;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:Canvas;color:CanvasText}
main{max-width:30rem}
h1{font-size:1.125rem;font-weight:600;margin:0 0 .25rem}
p{margin:0;opacity:.72}
a{display:inline-block;margin-top:1rem;color:inherit;font-weight:600}
`;
const ENTRY_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening preview</title><link rel="stylesheet" href="${PAGE_STYLE}"><script defer src="${ENTRY_SCRIPT}"></script><main><h1 id="title">Opening preview…</h1><p id="status"></p></main></html>`;
// While the server's first page is on its way the browser keeps this page up, and its clock runs.
const ENTRY_CODE = `(async () => {
  const secret = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  const title = document.getElementById("title");
  const status = document.getElementById("status");
  try {
    const answer = await fetch(${JSON.stringify(ENTRY_PATH)}, { method: "POST", body: secret, cache: "no-store" });
    if (!answer.ok) throw new Error();
    const { next, server } = await answer.json();
    title.textContent = "Waiting for " + server + " to answer…";
    const started = Date.now();
    setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      status.textContent = seconds < 3 ? "" : seconds + " s. A server that is starting up can take a while.";
    }, 1000);
    location.replace(new URL(next, location.origin).href);
  } catch {
    title.textContent = "This preview link has expired";
    status.textContent = "Links open once, within two minutes. Open the preview again from localDot.";
  }
})();
`;

export interface SiteOptions {
  port: number;
  target: PreviewTarget;
  // The Host values a request may carry: the tailnet fronts' names with this port.
  hosts(): ReadonlySet<string>;
  // A new connection to a server in the computer, with TLS already started for an https one.
  connect(target: PreviewTarget): Promise<Duplex>;
  // The computer's addresses and listening ports, as last seen.
  computer(): Computer;
  // Opens another server in the computer as a preview of its own and returns the link that signs this
  // device in to it, for a page that goes there.
  hop(target: PreviewTarget, host: string): Promise<string>;
  // Another server used this port before, so a device's first visit clears what that one stored.
  reused: boolean;
  now?: () => number;
  navigateMs?: number;
}

// One preview: a loopback listener that only the owner's tailnet fronts reach. It signs devices in,
// then hands each request and WebSocket to the server as if it came to the server's own address:
// Host, Origin and Referer name that address, and addresses of the computer's servers in what comes
// back (redirects, links, a page's own requests) lead to this preview or, through the via path, to
// the computer's other servers.
export class PreviewSite {
  readonly id = randomBytes(12).toString("base64url");
  readonly #cookie = randomBytes(32).toString("base64url");
  readonly #entries = new Map<string, { path: string; expires: number }>();
  readonly #upgraded = new Set<Duplex>();
  readonly #agents = new Map<string, Agent>();
  readonly #server: Server;
  readonly #now: () => number;
  #busy = 0;
  #lastUsed: number;

  constructor(readonly options: SiteOptions) {
    this.#now = options.now ?? Date.now;
    this.#lastUsed = this.#now();
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
    for (const agent of this.#agents.values()) agent.destroy();
    this.#agents.clear();
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
    if (path === PAGE_STYLE && req.method === "GET")
      return page(res, 200, PAGE_CSS, "text/css; charset=utf-8");
    if (path === ENTRY_PATH && req.method === "POST") return void this.#enter(req, res, host);
    if (!this.#signedIn(req.headers))
      return req.method === "GET"
        ? message(res, 401, "Open this preview from localDot", "That signs this device in to it.")
        : plain(res, 401, "unauthorized");
    if (!req.url?.startsWith("/")) return plain(res, 400, "bad request");
    if (req.url.startsWith(`${VIA_PATH}/`)) return void this.#via(req, res, host);
    this.#forward(req, res, host, this.target, req.url);
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
      // Only "storage", which takes an old service worker with it: "cache" makes browsers walk their
      // whole disk cache first (seconds to tens of seconds). Answers a browser could keep without
      // asking are told to ask again instead (deviceHeaders).
      ...(this.options.reused && !this.#signedIn(req.headers)
        ? { "clear-site-data": '"storage"' }
        : {}),
    });
    res.end(JSON.stringify({ next: entry.path, server: this.target.host }));
  }

  // Another server in the computer, named by the via path. A page the device opens there becomes a
  // preview of its own, so the server's own paths work; anything a page asks of it, a form it posts
  // included, travels here.
  async #via(req: IncomingMessage, res: ServerResponse, host: string) {
    const via = viaOf(req.url ?? "");
    const target = via && previewTarget(via.address, this.options.computer().addresses);
    if (!via || !target) return message(res, 400, "That address isn't in your computer");
    if (!navigating(req) || (req.method !== "GET" && req.method !== "HEAD"))
      return this.#forward(req, res, host, target, target.path, via.prefix);
    // Another site may send the owner here, but not have a preview opened for it.
    if (req.headers["sec-fetch-site"] === "cross-site")
      return message(res, 403, "Open this page from its preview", "Another site sent you here.");
    try {
      const link = await this.options.hop(target, host);
      res.writeHead(303, { ...PAGE_HEADERS, location: link });
      res.end();
    } catch (error) {
      message(
        res,
        502,
        `${target.host} couldn't open`,
        error instanceof Error && error.name === "PreviewError"
          ? error.message
          : "Open it from localDot instead.",
      );
    }
  }

  #agent(target: PreviewTarget): Agent {
    const key = `${target.scheme}://${target.host} ${target.dial}`;
    let agent = this.#agents.get(key);
    if (!agent) {
      agent = new TunnelAgent(() => this.options.connect(target));
      this.#agents.set(key, agent);
    }
    return agent;
  }

  #route(host: string, via?: string): Route {
    return {
      front: host,
      target: this.target,
      computer: this.options.computer(),
      ...(via ? { via } : {}),
    };
  }

  #forward(
    req: IncomingMessage,
    res: ServerResponse,
    host: string,
    target: PreviewTarget,
    path: string,
    via?: string,
  ) {
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
    const route = this.#route(host, via);
    const up = request({
      agent: this.#agent(target),
      method: req.method,
      path,
      headers: serverHeaders(req.headers, host, target, this.target),
      setHost: false,
    });
    const limit = this.options.navigateMs ?? NAVIGATE_MS;
    const slow =
      navigating(req) && (req.method === "GET" || req.method === "HEAD")
        ? setTimeout(() => {
            up.destroy();
            if (res.headersSent) return;
            message(
              res,
              504,
              `${target.host} didn't answer within ${Math.round(limit / 1000)} seconds`,
              "It may still be starting, or it may be stuck. Try again in a moment.",
              true,
            );
          }, limit)
        : undefined;
    up.on("response", (answer) => {
      clearTimeout(slow);
      answer.on("error", () => res.destroy());
      const status = answer.statusCode ?? 502;
      const body = bodyRewrite(req.method, status, answer.headers);
      res.writeHead(
        status,
        answer.statusMessage,
        deviceHeaders(answer.rawHeaders, route, false, body && (body.decode ? "gzip" : "")),
      );
      if (!body) return void answer.pipe(res);
      const steps: Transform[] = [
        ...(body.decode ? [body.decode()] : []),
        new TextRewriter(route),
        ...(body.decode ? [createGzip({ flush: constants.Z_SYNC_FLUSH })] : []),
      ];
      pipeline([answer, ...steps, res], () => undefined);
    });
    up.on("error", (error) => {
      clearTimeout(slow);
      if (res.headersSent) res.destroy();
      else if (!res.writableEnded) failure(res, error, target);
    });
    res.once("close", () => {
      clearTimeout(slow);
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
    const via = req.url.startsWith(`${VIA_PATH}/`) ? viaOf(req.url) : undefined;
    const target = via
      ? previewTarget(via.address, this.options.computer().addresses)
      : this.target;
    if (!target) return refuseRaw(socket, 400);
    this.#upgraded.add(socket);
    this.#lastUsed = this.#now();
    socket.once("close", () => {
      this.#upgraded.delete(socket);
      this.#lastUsed = this.#now();
    });
    const route = this.#route(host, via?.prefix);
    const up = request({
      createConnection: later(() => this.options.connect(target)),
      method: req.method,
      path: via ? target.path : req.url,
      headers: {
        ...serverHeaders(req.headers, host, target, this.target),
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
      socket.write(statusLine(answer) + rawLines(deviceHeaders(answer.rawHeaders, route, true)));
      if (serverHead.length) socket.write(serverHead);
      if (head.length) server.write(head);
      server.pipe(socket);
      socket.pipe(server);
    });
    // The server turned the socket down: its answer goes back as it is, then the connection ends.
    up.on("response", (answer) => {
      socket.write(
        statusLine(answer) +
          rawLines([...deviceHeaders(answer.rawHeaders, route, false), "Connection", "close"]),
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
    // HTTP/1.1 as a browser would, with room for every device's open event streams and long polls
    // beside its page loads: a request waiting for a free connection would wait for them to end.
    super({ keepAlive: true, maxSockets: 32, maxFreeSockets: 4 });
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

// A page the device itself opens, as browsers mark one; older browsers by what they accept.
function navigating(req: IncomingMessage): boolean {
  const mode = req.headers["sec-fetch-mode"];
  if (mode) return mode === "navigate" && req.headers["sec-fetch-dest"] === "document";
  return req.method === "GET" && /\btext\/html\b/.test(req.headers.accept ?? "");
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
// without the hop's own headers, the previews' cookies or who the owner is. Origin and Referer name
// the server whose page sent it (`page`), as they would in the computer's own browser.
export function serverHeaders(
  headers: IncomingHttpHeaders,
  host: string,
  target: PreviewTarget,
  page: PreviewTarget = target,
): Record<string, string | string[]> {
  const own = `https://${host}`;
  const server = `${page.scheme}://${page.host}`;
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
// this preview, with the addresses it names sent where they open on the device and its cookies kept
// on the preview's host. `body` is the encoding of a rewritten body ("" for none), whose length is
// no longer the server's.
export function deviceHeaders(
  raw: readonly string[],
  route: Route,
  upgrade: boolean,
  body?: "" | "gzip",
): string[] {
  const out: string[] = [];
  let cached = false;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    const value = raw[i + 1] as string;
    const lower = name.toLowerCase();
    if (HOST_WIDE.has(lower) || (!upgrade && HOP.has(lower))) continue;
    if (lower === "set-cookie" && value.trimStart().startsWith(COOKIE_PREFIX)) continue;
    if (body !== undefined && (lower === "content-length" || lower === "content-encoding"))
      continue;
    cached ||= lower === "cache-control" || lower === "expires";
    out.push(
      name,
      lower === "set-cookie"
        ? deviceCookie(value, route.computer)
        : deviceHeader(lower, value, route),
    );
  }
  if (body) out.push("Content-Encoding", "gzip");
  // A port serves one server after another: what one left in a browser's cache without saying how
  // long it stays fresh must not answer for the next.
  if (!upgrade && !cached) out.push("Cache-Control", "no-cache");
  return out;
}

function failure(res: ServerResponse, error: Error, target: PreviewTarget) {
  if (error instanceof ForwarderRefused && error.reason === "refused-port")
    return message(res, 403, "localDot's own services can't be opened as a preview");
  if (error instanceof ForwarderRefused && error.reason === "unreachable")
    return message(
      res,
      502,
      `Nothing is answering at ${target.host}`,
      "The server in your computer stopped or hasn't started. Start it again, then try again.",
      true,
    );
  if (error.name === "ForwarderMissing")
    return message(
      res,
      502,
      "Your computer isn't answering",
      "Check that it's on, then try again.",
      true,
    );
  return message(
    res,
    502,
    target.scheme === "https"
      ? `${target.host} didn't answer over HTTPS`
      : `${target.host} stopped answering`,
    "Try again in a moment.",
    true,
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

const escaped = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// A page of localDot's own on the preview's origin: what happened, what to do, and a link that asks
// for the same page again.
function message(res: ServerResponse, status: number, title: string, detail = "", retry = false) {
  page(
    res,
    status,
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped(title)}</title><link rel="stylesheet" href="${PAGE_STYLE}"><main><h1>${escaped(title)}</h1>${detail ? `<p>${escaped(detail)}</p>` : ""}${retry ? '<a href="">Try again</a>' : ""}</main></html>`,
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
