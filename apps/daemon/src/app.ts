import { ULID_PATTERN } from "@localdot/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { type AgentRoutesDeps, agentRoutes } from "./agent/routes.ts";
import { type CellApiDeps, cellRoutes } from "./cells/api.ts";
import { desktopRoutes, type StreamProxyDeps } from "./cells/stream-proxy.ts";
import { errorCode } from "./error-code.ts";
import { type EventLog, UnknownSessionError } from "./event-log.ts";
import { type GatewayRoutesDeps, gatewayRoutes } from "./gateway/routes.ts";
import { isAllowedHost, isAllowedOrigin, tokenFromHeaders } from "./guard.ts";
import { type KeyRoutesDeps, keyRoutes } from "./keyd/routes.ts";
import { serveUi } from "./static-ui.ts";
import { tokensMatch } from "./token.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
  desktop?: StreamProxyDeps;
  ui?: { dir: string };
  gateway?: GatewayRoutesDeps;
  keys?: KeyRoutesDeps;
  agent?: AgentRoutesDeps;
}

export function createApp({
  token,
  port,
  eventLog,
  cells,
  desktop,
  ui,
  gateway,
  keys,
  agent,
}: AppOptions): Hono {
  const app = new Hono();

  // Hono's default handler logs the whole error, and a message can quote a file path or the
  // request. Middleware's own responses (bodyLimit's 413) pass through.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`request ${routePath(c)} failed (${errorCode(err)})`);
    return c.text("internal error", 500);
  });

  app.use("*", async (c, next) => {
    const urlHost = new URL(c.req.url).host;
    const rawHost = c.req.header("host") ?? urlHost;
    if (!isAllowedHost(rawHost, port) || !isAllowedHost(urlHost, port)) {
      return c.text("forbidden host", 403);
    }
    if (!isAllowedOrigin(c.req.header("origin"), port)) return c.text("forbidden origin", 403);
    await next();
  });

  app.get("/healthz", (c) => c.text("ok"));

  if (ui) serveUi(app, ui.dir);

  // The Selkies iframe can carry no install token: its routes authorise themselves by ticket.
  if (desktop) desktopRoutes(app, desktop);

  app.use("/api/*", async (c, next) => {
    const given = tokenFromHeaders({ authorization: c.req.header("authorization") });
    if (!tokensMatch(token, given)) return c.text("unauthorized", 401);
    await next();
  });

  app.get("/api/whoami", (c) => c.json({ ok: true }));

  app.get("/api/sessions", (c) => c.json(eventLog.listSessions()));

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    const fromSeq = Math.max(0, Number(c.req.query("fromSeq")) || 0);
    try {
      return c.json(eventLog.read(id, fromSeq));
    } catch (err) {
      if (err instanceof UnknownSessionError) return c.text("unknown session", 404);
      throw err;
    }
  });

  if (cells) cellRoutes(app, cells);
  if (keys) keyRoutes(app, keys);
  if (agent) agentRoutes(app, agent);
  if (cells && gateway) gatewayRoutes(app, cells.cells, gateway);
  return app;
}
