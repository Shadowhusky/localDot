import { ULID_PATTERN } from "@localdot/protocol";
import { Hono } from "hono";
import { type CellApiDeps, cellRoutes } from "./cells/api.ts";
import { type EventLog, UnknownSessionError } from "./event-log.ts";
import { isAllowedHost, isAllowedOrigin, tokenFromHeaders } from "./guard.ts";
import { tokensMatch } from "./token.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
}

export function createApp({ token, port, eventLog, cells }: AppOptions): Hono {
  const app = new Hono();

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
  return app;
}
