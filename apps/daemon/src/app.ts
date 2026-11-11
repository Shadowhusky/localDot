import { ULID_PATTERN } from "@localdot/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { ServiceReadinessReply } from "../../../packages/protocol/src/install-services.ts";
import type { AccessLinks } from "./access-links.ts";
import { type AgentRoutesDeps, agentRoutes } from "./agent/routes.ts";
import { type AccountsDeps, accountsRoutes } from "./browser/accounts.ts";
import { type BrowserEngineDeps, browserEngineRoutes } from "./browser/engine-routes.ts";
import { type BrowserStatusDeps, browserStatusRoutes } from "./browser/status-routes.ts";
import { type BrowserViewerDeps, browserViewerApi } from "./browser/viewer.ts";
import { type CellApiDeps, cellRoutes } from "./cells/api.ts";
import { clientAssetRoutes, desktopRoutes, type StreamProxyDeps } from "./cells/stream-proxy.ts";
import {
  type ConnectorRoutesDeps,
  connectorCallbackRoute,
  connectorRoutes,
} from "./connectors/routes.ts";
import { type DeliverablesDeps, deliverableRoutes } from "./deliverables/routes.ts";
import { type DockRoutesDeps, dockRoutes } from "./desktopd/dock.ts";
import { type DoctorSelfTestsDeps, doctorSelfTestRoutes } from "./doctor-selftests.ts";
import { type DotsRoutesDeps, dotsRoutes } from "./dots/routes.ts";
import { errorCode } from "./error-code.ts";
import { type EventLog, UnknownSessionError } from "./event-log.ts";
import type { ExportJobs } from "./exports/jobs.ts";
import { ExportLinks, exportRoutes } from "./exports/routes.ts";
import { type GatewayRoutesDeps, gatewayRoutes } from "./gateway/routes.ts";
import { isAllowedHost, isAllowedOrigin, tokenFromHeaders } from "./guard.ts";
import { installCodeRoutes } from "./install-code-routes.ts";
import type { InstallCodes } from "./install-codes.ts";
import { type KeyRoutesDeps, keyRoutes } from "./keyd/routes.ts";
import { type NotifyRoutesDeps, notifyRoutes } from "./notify/routes.ts";
import type { Previews } from "./previews/previews.ts";
import { previewRoutes } from "./previews/routes.ts";
import type { Recorder } from "./recorder/recorder.ts";
import { forGuest } from "./remote/guest-events.ts";
import { publicGrant } from "./remote/links.ts";
import { type RemoteAccess, remoteRoutes } from "./remote/manager.ts";
import { revocableResponse } from "./remote/response.ts";
import { type ReportRoutesDeps, reportRoutes } from "./reports/routes.ts";
import { type RoutineRoutesDeps, routineRoutes } from "./routines/routes.ts";
import { type SearchRoutesDeps, searchRoutes } from "./search/routes.ts";
import type { ManagedServiceReadiness } from "./service-readiness.ts";
import { NDJSON_TYPE } from "./sessions/ndjson.ts";
import { eventStreamResponse, type ReplayRoutesDeps, replayRoutes } from "./sessions/routes.ts";
import { serveUi } from "./static-ui.ts";
import { tokensMatch } from "./token.ts";
import type { AppUpdater } from "./updates/app-updater.ts";
import { appUpdateRoutes } from "./updates/routes.ts";
import { type VoiceRoutesDeps, voiceRoutes } from "./voice/routes.ts";

export interface AppOptions {
  token: string;
  port: number;
  eventLog: EventLog;
  cells?: CellApiDeps;
  desktop?: StreamProxyDeps;
  browser?: BrowserViewerDeps;
  accounts?: AccountsDeps;
  browserStatus?: BrowserStatusDeps;
  browserEngine?: BrowserEngineDeps;
  ui?: { dir: string };
  gateway?: GatewayRoutesDeps;
  dock?: DockRoutesDeps;
  keys?: KeyRoutesDeps;
  agent?: AgentRoutesDeps;
  search?: SearchRoutesDeps;
  recorder?: Pick<Recorder, "info" | "isLive">;
  replay?: ReplayRoutesDeps;
  deliverables?: Omit<DeliverablesDeps, "port">;
  installCodes?: InstallCodes;
  accessLinks?: AccessLinks;
  serviceReadiness?: Pick<ManagedServiceReadiness, "snapshot">;
  doctorSelfTests?: DoctorSelfTestsDeps;
  exports?: ExportJobs;
  notify?: NotifyRoutesDeps;
  routines?: RoutineRoutesDeps;
  connectors?: Omit<ConnectorRoutesDeps, "port">;
  voice?: VoiceRoutesDeps;
  previews?: Pick<Previews, "status" | "open" | "stop" | "stopServer">;
  appUpdater?: AppUpdater;
  remoteAccess?: RemoteAccess;
  appInstalling?(): boolean;
  dots?: DotsRoutesDeps;
  reports?: ReportRoutesDeps;
}

export function createApp({
  token,
  port,
  eventLog,
  cells,
  desktop,
  browser,
  accounts,
  browserStatus,
  browserEngine,
  ui,
  gateway,
  dock,
  keys,
  agent,
  search,
  replay,
  deliverables,
  installCodes,
  accessLinks,
  serviceReadiness,
  doctorSelfTests,
  exports,
  notify,
  routines,
  connectors,
  voice,
  previews,
  appUpdater,
  remoteAccess,
  appInstalling,
  dots,
  reports,
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
    const allowed = () => isAllowedHost(rawHost, port) && isAllowedHost(urlHost, port);
    if (!allowed()) {
      await accessLinks?.recheck(rawHost);
      if (!allowed()) return c.text("forbidden host", 403);
    }
    if (!isAllowedOrigin(c.req.header("origin"), port)) return c.text("forbidden origin", 403);
    await next();
  });

  app.get("/healthz", (c) => c.text("ok"));
  if (connectors?.signIn) connectorCallbackRoute(app, connectors.signIn);

  if (ui) serveUi(app, ui.dir);

  // The Selkies iframe can carry no install token: its routes authorise themselves by ticket.
  if (desktop) desktopRoutes(app, desktop);
  if (browser) desktopRoutes(app, browser, "browser");
  const client = desktop ?? browser;
  if (client) clientAssetRoutes(app, client.vendorDir);

  if (remoteAccess)
    remoteAccess.links.onRevoke((id) => {
      desktop?.tickets.revokeScope(id);
      browser?.tickets.revokeScope(id);
      for (const sessionId of remoteAccess.links.sessions(id))
        void agent?.runner
          .stopRun?.(sessionId)
          .catch(() => console.error("Shared task could not be stopped after link revocation"));
    });
  app.use("/api/*", async (c, next) => {
    const given = tokenFromHeaders({ authorization: c.req.header("authorization") });
    if (!tokensMatch(token, given)) {
      const grant = remoteAccess?.authenticate(given);
      if (!grant) return c.text("unauthorized", 401);
      if (!remoteAccess?.links.permits(grant, c.req.method, c.req.path))
        return c.text("This link does not allow that action", 403);
      c.set("remoteGrant", grant);
      c.set("remoteValid", () => !!remoteAccess?.authenticate(given));
    }
    // Asking for the update again joins it, so a second device gets a plain answer.
    if (
      appInstalling?.() &&
      !["GET", "HEAD"].includes(c.req.method) &&
      !c.req.path.startsWith("/api/app-update/")
    )
      return c.text("localDot is installing an update. Please wait.", 503);
    await next();
    const grant = c.get("remoteGrant");
    if (grant && remoteAccess)
      c.res = revocableResponse(
        c.res,
        () => !!remoteAccess.authenticate(given),
        (end) =>
          remoteAccess.links.onRevoke((id) => {
            if (id === grant.id) end();
          }),
      );
  });

  if (appUpdater) appUpdateRoutes(app, appUpdater);
  if (remoteAccess) {
    remoteRoutes(app, remoteAccess, agent?.settings.get.bind(agent.settings));
    // The models the owner has configured now, which a link that allows switching offers.
    const configured = () => {
      const saved = agent?.settings.get();
      return [saved?.main, saved?.fast, saved?.local, ...(saved?.models ?? [])].filter(
        (choice): choice is NonNullable<typeof choice> => !!choice && !choice.off,
      );
    };
    // A plan the owner uses offers every model it lists now, as it does in the owner's own menu.
    const planModels = async () => {
      const used = new Set(configured().map((choice) => choice.provider));
      const listed: { provider: string; model: string; name: string }[] = [];
      if (used.has("claude-code") && agent?.claudeCode) {
        const status = await agent.claudeCode.status().catch(() => null);
        if (status?.state === "signed_in")
          for (const row of status.models)
            listed.push({ provider: "claude-code", model: row.id, name: row.name });
      }
      if (used.has("chatgpt") && agent?.chatgpt) {
        const status = await agent.chatgpt.account.status().catch(() => null);
        for (const row of status?.models ?? [])
          listed.push({ provider: "chatgpt", model: row.id, name: row.name });
      }
      return listed;
    };
    const offered = async () => {
      const plans = await planModels();
      return {
        plans,
        choices: [...configured(), ...plans.map(({ provider, model }) => ({ provider, model }))],
      };
    };
    app.get("/api/remote-session", async (c) => {
      const grant = c.get("remoteGrant");
      if (!grant) return c.text("Not a shared session", 400);
      const { plans, choices } = await offered();
      const models = remoteAccess.links.choices(grant, choices);
      // The page has no catalog of its own: the link's models come with their names.
      const catalog = agent?.catalog.get();
      const names = models.flatMap(({ provider, model }) => {
        const name =
          plans.find((row) => row.provider === provider && row.model === model)?.name ??
          (
            catalog?.providers[provider]?.models[model] ??
            Object.values(catalog?.providers ?? {}).find((each) => each.models[model])?.models[
              model
            ]
          )?.name;
        return name ? [{ provider, model, name }] : [];
      });
      return c.json({
        ...publicGrant(grant),
        models,
        ownedSessions: remoteAccess.links.sessions(grant.id),
        names,
      });
    });
    app.post("/api/remote-session/model", async (c) => {
      const grant = c.get("remoteGrant");
      if (!grant) return c.text("Not a shared session", 400);
      try {
        const { index, options } = await c.req.json();
        if (!Number.isInteger(index)) return c.text("Invalid model", 400);
        remoteAccess.links.select(grant.id, index, (await offered()).choices, options);
        return c.body(null, 204);
      } catch {
        return c.text("Model not permitted", 403);
      }
    });
  }
  app.get("/api/whoami", (c) =>
    c.json({ ok: true, ...(c.get("remoteGrant") ? { shared: true } : {}) }),
  );
  if (doctorSelfTests) doctorSelfTestRoutes(app, doctorSelfTests);
  if (serviceReadiness)
    app.get("/api/service/ready", async (c) => {
      const snapshot = ServiceReadinessReply.parse(await serviceReadiness.snapshot());
      return c.json(snapshot, snapshot.ready ? 200 : 503);
    });
  if (installCodes)
    installCodeRoutes(app, installCodes, port, accessLinks, (code) =>
      remoteAccess?.authenticate(code) ? code : undefined,
    );
  if (browser)
    browserViewerApi(app, {
      ...browser,
      ...(remoteAccess
        ? { sees: (grant: string, session: string) => remoteAccess.links.owns(grant, session) }
        : {}),
    });
  if (accounts) accountsRoutes(app, accounts);
  if (browserStatus) browserStatusRoutes(app, browserStatus);
  if (browserEngine) browserEngineRoutes(app, browserEngine);

  app.get("/api/sessions", (c) => c.json(eventLog.listSessions()));

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    const fromSeq = Math.max(0, Number(c.req.query("fromSeq")) || 0);
    const guest = !!c.get("remoteGrant");
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
        return eventStreamResponse(
          file,
          fromSeq,
          c.req.raw.signal,
          guest ? { project: forGuest } : undefined,
        );
      }
      const events = eventLog.read(id, fromSeq);
      return c.json(guest ? events.map(forGuest) : events);
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
      return eventStreamResponse(eventLog.logFile(id), fromSeq, c.req.raw.signal, {
        shown: true,
        ...(c.get("remoteGrant") ? { project: forGuest } : {}),
      });
    } catch (err) {
      if (err instanceof UnknownSessionError) return c.text("unknown session", 404);
      throw err;
    }
  });

  if (cells) cellRoutes(app, cells);
  if (previews) previewRoutes(app, previews);
  if (keys) keyRoutes(app, keys);
  if (agent) agentRoutes(app, { ...agent, remoteLinks: remoteAccess?.links });
  if (search) searchRoutes(app, search);
  if (routines) routineRoutes(app, routines);
  if (cells && gateway) gatewayRoutes(app, cells.cells, gateway);
  if (dock) dockRoutes(app, dock);
  if (replay) replayRoutes(app, replay);
  if (deliverables)
    deliverableRoutes(app, {
      ...deliverables,
      port,
      ...(remoteAccess
        ? { sees: (grant: string, session: string) => remoteAccess.links.owns(grant, session) }
        : {}),
    });
  if (notify) notifyRoutes(app, notify);
  if (voice) voiceRoutes(app, voice);
  if (exports) exportRoutes(app, exports, new ExportLinks());
  if (connectors) connectorRoutes(app, { ...connectors, port });
  if (dots) dotsRoutes(app, dots);
  if (reports) reportRoutes(app, reports);
  return app;
}
