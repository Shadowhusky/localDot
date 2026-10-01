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

export function attachEventStream(
  server: Server,
  { port, token, eventLog }: EventStreamOptions,
): void {
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
