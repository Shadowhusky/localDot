import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type LocalDotEvent, ULID_PATTERN } from "@localdot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { EventLog } from "./event-log.ts";
import { isAllowedHost, isAllowedOrigin, tokenFromHeaders } from "./guard.ts";
import { tokensMatch } from "./token.ts";

export const WS_PROTOCOL = "localdot.v1";

const STREAM_PATH = /^\/api\/sessions\/([^/]+)\/stream$/;

export interface EventStreamOptions {
  port: number;
  token: string;
  eventLog: EventLog;
}

export function attachEventStream(
  server: Server,
  { port, token, eventLog }: EventStreamOptions,
): void {
  // Never select the localdot.token.<t> entry: the chosen subprotocol is echoed back in the response.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
  const base = `http://127.0.0.1:${port}`;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const target = req.url ?? "/";
    if (!URL.canParse(target, base)) {
      refuse(socket, "400 Bad Request");
      return;
    }
    const url = new URL(target, base);
    const sessionId = STREAM_PATH.exec(url.pathname)?.[1];
    const given = tokenFromHeaders({
      authorization: req.headers.authorization,
      "sec-websocket-protocol": req.headers["sec-websocket-protocol"],
    });
    const allowed =
      isAllowedHost(req.headers.host, port) &&
      isAllowedHost(url.host, port) &&
      isAllowedOrigin(req.headers.origin, port) &&
      tokensMatch(token, given) &&
      sessionId !== undefined &&
      ULID_PATTERN.test(sessionId);
    if (!allowed) {
      refuse(socket, "403 Forbidden");
      return;
    }
    const fromSeq = Math.max(0, Number(url.searchParams.get("fromSeq")) || 0);
    wss.handleUpgrade(req, socket, head, (ws) => streamSession(ws, eventLog, sessionId, fromSeq));
  });
}

function refuse(socket: Duplex, status: string): void {
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
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
