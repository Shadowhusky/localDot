import { readFileSync } from "node:fs";
import {
  Agent,
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import type { Duplex } from "node:stream";

export const FORWARDER_PORT = 3129;
export const GATE_PROXY_PORT = 3128;
export const PROXY_TOKEN_FILE = "/etc/localdot/cell/proxy-token";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HANDSHAKE_TIMEOUT_MS = 30_000;
// Headers that describe one hop are never relayed. The client's Proxy-Authorization is replaced
// with the cell's token, and Proxy-Authenticate never reaches a client, so nothing prompts for it.
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

export interface ForwarderOptions {
  gate: { host: string; port: number } | undefined;
  readToken(): string | undefined;
  handshakeTimeoutMs?: number;
}

type Ready =
  | { gate: { host: string; port: number }; authorization: string }
  | { status: 503; reason: string };

// The token is read for every connection, so a rewired cell needs no restart of this process.
export function readTokenFile(path = PROXY_TOKEN_FILE): string | undefined {
  try {
    const token = readFileSync(path, "utf8").trim();
    return TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

// Every program in the cell reaches keyd through this forwarder on the cell's loopback: it adds
// the cell's proxy token, which some clients cannot send themselves (Chromium ignores credentials
// in --proxy-server; sudo drops proxy variables), and relays to the gate. It never uses a proxy
// of its own: its agent is not the global one that NODE_USE_ENV_PROXY configures.
export function createForwarder(opts: ForwarderOptions): Server {
  const agent = new Agent({ keepAlive: false });
  const server = createServer((req, res) => {
    forwardRequest(opts, agent, req, res);
  });
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    forwardTunnel(opts, agent, req, client, head);
  });
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
    socket.on("error", () => socket.destroy());
    refuseRaw(socket, 501, { "X-Localdot-Reason": "upgrade-refused" });
  });
  server.on("close", () => agent.destroy());
  return server;
}

function forwardRequest(
  opts: ForwarderOptions,
  agent: Agent,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const ready = prepare(opts);
  if ("reason" in ready) {
    refuse(res, ready.status, ready.reason);
    return;
  }
  if (!req.url?.startsWith("http://")) {
    refuse(res, 400, "absolute-form-only");
    return;
  }
  const headers = relayable(req.headers);
  headers["proxy-authorization"] = ready.authorization;
  // The body arrives de-chunked; frame it the same way on the way out.
  if (req.headers["transfer-encoding"]) headers["transfer-encoding"] = "chunked";
  const { host, port } = ready.gate;
  let deadline: NodeJS.Timeout | undefined;
  const up = send(() =>
    httpRequest({ host, port, method: req.method, path: req.url, headers, agent }, (upRes) => {
      clearTimeout(deadline);
      upRes.on("error", () => res.destroy());
      const status = upRes.statusCode ?? 502;
      if (status === 407) {
        upRes.resume();
        refuse(res, 502, "proxy-token-refused");
        return;
      }
      res.writeHead(status, relayable(upRes.headers));
      upRes.pipe(res);
    }),
  );
  if (!up) {
    refuse(res, 400, "bad-request");
    return;
  }
  // Only the handshake is bounded; a successful response or tunnel may stream indefinitely.
  deadline = setTimeout(() => {
    refuse(res, 504, "gate-timeout");
    up.destroy();
  }, opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  up.once("close", () => clearTimeout(deadline));
  res.once("close", () => {
    clearTimeout(deadline);
    up.destroy();
  });
  req.once("aborted", () => up.destroy());
  req.once("error", () => up.destroy());
  up.on("upgrade", (_res, socket) => {
    clearTimeout(deadline);
    socket.destroy();
    refuse(res, 502, "upgrade-refused");
  });
  up.on("error", () => {
    clearTimeout(deadline);
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.destroy();
    else refuse(res, 502, "gate-unreachable");
  });
  req.pipe(up);
}

function forwardTunnel(
  opts: ForwarderOptions,
  agent: Agent,
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
) {
  client.on("error", () => client.destroy());
  const ready = prepare(opts);
  if ("reason" in ready) {
    refuseRaw(client, ready.status, { "X-Localdot-Reason": ready.reason });
    return;
  }
  const { host, port } = ready.gate;
  const up = send(() =>
    httpRequest({
      host,
      port,
      method: "CONNECT",
      path: req.url,
      headers: { host: req.url, "proxy-authorization": ready.authorization },
      agent,
    }),
  );
  if (!up) {
    refuseRaw(client, 400, { "X-Localdot-Reason": "bad-request" });
    return;
  }
  let tunnel: Duplex | undefined;
  const deadline = setTimeout(() => {
    refuseRaw(client, 504, { "X-Localdot-Reason": "gate-timeout" });
    up.destroy();
  }, opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  up.once("close", () => clearTimeout(deadline));
  client.once("close", () => {
    clearTimeout(deadline);
    up.destroy();
    tunnel?.destroy();
  });
  client.once("end", () => {
    if (!tunnel) {
      clearTimeout(deadline);
      up.destroy();
      client.end();
    }
  });
  up.on("connect", (res: IncomingMessage, upSocket: Duplex, upHead: Buffer) => {
    clearTimeout(deadline);
    if (client.destroyed || client.writableEnded) {
      upSocket.destroy();
      return;
    }
    const status = res.statusCode ?? 502;
    if (status !== 200) {
      upSocket.destroy();
      const reason = res.headers["x-keyd-reason"];
      if (status === 407) refuseRaw(client, 502, { "X-Localdot-Reason": "proxy-token-refused" });
      else refuseRaw(client, status, typeof reason === "string" ? { "X-Keyd-Reason": reason } : {});
      return;
    }
    tunnel = upSocket;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (upHead.length > 0) client.write(upHead);
    if (head.length > 0) upSocket.write(head);
    upSocket.on("error", () => client.destroy());
    upSocket.on("close", () => client.destroy());
    upSocket.pipe(client);
    client.pipe(upSocket);
  });
  up.on("error", () => {
    clearTimeout(deadline);
    refuseRaw(client, 502, { "X-Localdot-Reason": "gate-unreachable" });
  });
  up.end();
}

function prepare(opts: ForwarderOptions): Ready {
  if (
    !opts.gate?.host ||
    !Number.isInteger(opts.gate.port) ||
    opts.gate.port < 1 ||
    opts.gate.port > 65535
  )
    return { status: 503, reason: "no-gate" };
  let token: string | undefined;
  try {
    token = opts.readToken();
  } catch {
    /* A failed rotation must fail closed. */
  }
  if (!token || !TOKEN.test(token)) return { status: 503, reason: "no-proxy-token" };
  const authorization = `Basic ${Buffer.from(`cell:${token}`).toString("base64")}`;
  return { gate: opts.gate, authorization };
}

// Node refuses a request line or a header it cannot send (CR or LF in a path) by throwing.
function send(make: () => ClientRequest): ClientRequest | undefined {
  try {
    return make();
  } catch {
    return undefined;
  }
}

function relayable(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  const hop = new Set([
    ...HOP,
    ...(headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()),
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !hop.has(name)) out[name] = value;
  }
  return out;
}

function refuse(res: ServerResponse, status: number, reason: string) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "X-Localdot-Reason": reason,
    "Content-Length": "0",
    Connection: "close",
  });
  res.end();
}

function refuseRaw(socket: Duplex, status: number, headers: Record<string, string>) {
  if (socket.destroyed || socket.writableEnded) return;
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n${lines.join("")}Content-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}
