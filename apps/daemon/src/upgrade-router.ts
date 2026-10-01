import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { errorCode } from "./error-code.ts";
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
      // A throw would escape the 'upgrade' listener and end the daemon. The log names only the route
      // and the error code: tickets travel in paths, and an error's message can quote the request.
      try {
        route.open({ req, socket, head, url, params });
      } catch (err) {
        console.error(`upgrade ${route.pattern} failed (${errorCode(err)})`);
        refuse(socket, "500 Internal Server Error");
      }
      return;
    }
    refuse(socket, "404 Not Found");
  });
}
