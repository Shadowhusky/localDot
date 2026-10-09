import { ULID_PATTERN } from "@localdot/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { ServiceReadinessReply } from "../../../packages/protocol/src/install-services.ts";
import { type AgentRoutesDeps, agentRoutes } from "./agent/routes.ts";
import { type AccountsDeps, accountsRoutes } from "./browser/accounts.ts";
import { type BrowserViewerDeps, browserViewerApi } from "./browser/viewer.ts";
import { type CellApiDeps, cellRoutes } from "./cells/api.ts";
import { desktopRoutes, type StreamProxyDeps } from "./cells/stream-proxy.ts";
import { type DoctorSelfTestsDeps, doctorSelfTestRoutes } from "./doctor-selftests.ts";
import { errorCode } from "./error-code.ts";
import { type EventLog, UnknownSessionError } from "./event-log.ts";
import { type GatewayRoutesDeps, gatewayRoutes } from "./gateway/routes.ts";
import { isAllowedHost, isAllowedOrigin, tokenFromHeaders } from "./guard.ts";
import { installCodeRoutes } from "./install-code-routes.ts";
import type { InstallCodes } from "./install-codes.ts";
import { type KeyRoutesDeps, keyRoutes } from "./keyd/routes.ts";
import { type NotifyRoutesDeps, notifyRoutes } from "./notify/routes.ts";
import type { Recorder } from "./recorder/recorder.ts";
import { type RoutineRoutesDeps, routineRoutes } from "./routines/routes.ts";
import { type SearchRoutesDeps, searchRoutes } from "./search/routes.ts";
import type { ManagedServiceReadiness } from "./service-readiness.ts";
import { NDJSON_TYPE } from "./sessions/ndjson.ts";
import { eventStreamResponse, type ReplayRoutesDeps, replayRoutes } from "./sessions/routes.ts";
import { serveUi } from "./static-ui.ts";
import { tokensMatch } from "./token.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
  desktop?: StreamProxyDeps;
  browser?: BrowserViewerDeps;
  accounts?: AccountsDeps;
  ui?: { dir: string };
  gateway?: GatewayRoutesDeps;
  keys?: KeyRoutesDeps;
  agent?: AgentRoutesDeps;
  search?: SearchRoutesDeps;
  recorder?: Pick<Recorder, "info" | "isLive">;
  replay?: ReplayRoutesDeps;
  installCodes?: InstallCodes;
  serviceReadiness?: Pick<ManagedServiceReadiness, "snapshot">;
  doctorSelfTests?: DoctorSelfTestsDeps;
  notify?: NotifyRoutesDeps;
  routines?: RoutineRoutesDeps;
}

export function createApp({
  token,
  port,
  eventLog,
  cells,
  desktop,
  browser,
  accounts,
  ui,
  gateway,
  keys,
  agent,
  search,
  replay,
  installCodes,
  serviceReadiness,
  doctorSelfTests,
  notify,
  routines,
}: AppOptions): Hono {
  if (installCodes && !installCodes.belongsTo(token, port)) {
    throw new Error("install codes belong to another daemon");
  }
  const app = new Hono();

  // Include guard failures and unsupported methods: credential responses never enter caches.
  for (const path of [
    "/auth/exchange-code",
    "/api/install-code",
    "/api/service/ready",
    "/api/service/self-tests",
  ]) {
    app.use(path, async (c, next) => {
      c.header("cache-control", "no-store");
      c.header("referrer-policy", "no-referrer");
      await next();
    });
  }

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
  if (browser) desktopRoutes(app, browser, "browser");

  app.use("/api/*", async (c, next) => {
    const given = tokenFromHeaders({ authorization: c.req.header("authorization") });
    if (!tokensMatch(token, given)) return c.text("unauthorized", 401);
    await next();
  });

  app.get("/api/whoami", (c) => c.json({ ok: true }));
  if (doctorSelfTests) doctorSelfTestRoutes(app, doctorSelfTests);
  if (serviceReadiness)
    app.get("/api/service/ready", async (c) => {
      const snapshot = ServiceReadinessReply.parse(await serviceReadiness.snapshot());
      return c.json(snapshot, snapshot.ready ? 200 : 503);
    });
  if (installCodes) installCodeRoutes(app, installCodes);
  if (browser) browserViewerApi(app, browser);
  if (accounts) accountsRoutes(app, accounts);

  app.get("/api/sessions", (c) => c.json(eventLog.listSessions()));

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    const fromSeq = Math.max(0, Number(c.req.query("fromSeq")) || 0);
    try {
      if (
        c.req
          .header("accept")
          ?.split(",")
          .some((part) => part.trim().split(";")[0] === NDJSON_TYPE)
      ) {
        if (!Number.isSafeInteger(fromSeq)) return c.text("invalid sequence", 400);
        const file = eventLog.logFile(id);
        if (c.req.raw.method === "HEAD")
          return new Response(null, {
            headers: { "content-type": NDJSON_TYPE, "cache-control": "no-store" },
          });
        return eventStreamResponse(file, fromSeq, c.req.raw.signal);
      }
      return c.json(eventLog.read(id, fromSeq));
    } catch (err) {
      if (err instanceof UnknownSessionError) return c.text("unknown session", 404);
      throw err;
    }
  });

  // What a conversation shows of a task, read whole before its live feed opens: the log without the
  // events it never shows.
  app.get("/api/sessions/:id/history", (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    const fromSeq = Math.max(0, Number(c.req.query("fromSeq")) || 0);
    if (!Number.isSafeInteger(fromSeq)) return c.text("invalid sequence", 400);
    try {
      return eventStreamResponse(eventLog.logFile(id), fromSeq, c.req.raw.signal, { shown: true });
    } catch (err) {
      if (err instanceof UnknownSessionError) return c.text("unknown session", 404);
      throw err;
    }
  });

  if (cells) cellRoutes(app, cells);
  if (keys) keyRoutes(app, keys);
  if (agent) agentRoutes(app, agent);
  if (search) searchRoutes(app, search);
  if (routines) routineRoutes(app, routines);
  if (cells && gateway) gatewayRoutes(app, cells.cells, gateway);
  if (replay) replayRoutes(app, replay);
  if (notify) notifyRoutes(app, notify);
  return app;
}
