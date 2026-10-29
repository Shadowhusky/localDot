import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  REPORT_ID,
  type ReportBundle,
  type ReportDraft,
  ReportDraftRequest,
} from "../../../../packages/protocol/src/reports.ts";
import type { BrowserOrchestrator } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";
import type { DoctorReport } from "../doctor.ts";
import type { KeydClient } from "../keyd/client.ts";
import type { AppUpdater } from "../updates/app-updater.ts";
import { buildReport, packReport, type ReportFacts } from "./bundle.ts";
import {
  deleteSentReport,
  ReportServiceError,
  reportState,
  reportsUrl,
  sendReport,
} from "./service.ts";
import type { ReportStore } from "./store.ts";

// The daemon's view of itself for a report: the same checks localdot doctor runs, its computers
// and their web browsers, keyd, updates and remote access (on or off, never its address).
export interface LiveSources {
  install: ReportFacts["install"];
  updater: Pick<AppUpdater, "status">;
  keyd: Pick<KeydClient, "status">;
  cells: Pick<CellApi, "list">;
  browser: Pick<BrowserOrchestrator, "status" | "supervisor">;
  remote?(): { enabled: boolean; state: string };
  doctor(signal: AbortSignal): Promise<DoctorReport>;
}

const DOCTOR_MS = 25_000;

export async function liveFacts(sources: LiveSources, signal: AbortSignal): Promise<ReportFacts> {
  const doctor = sources
    .doctor(AbortSignal.any([signal, AbortSignal.timeout(DOCTOR_MS)]))
    .catch(() => undefined);
  const [update, keyd, computers] = await Promise.all([
    sources.updater.status(),
    sources.keyd.status().then(
      (status) =>
        status.vault?.state === undefined || status.vault.state === "ready"
          ? ("ready" as const)
          : ("locked" as const),
      () => "down" as const,
    ),
    Promise.all(
      sources.cells.list().map(async (cell) => ({
        cell,
        browser: await sources.browser.status(cell.id).catch(() => undefined),
        supervisor: await sources.browser.supervisor(cell.id),
      })),
    ),
  ]);
  const checks = (await doctor)?.checks;
  const engine = checks?.find((check) => check.name === "docker-engine");
  const remote = sources.remote?.();
  return {
    version: update.currentVersion,
    install: sources.install,
    app: "running",
    uptimeSeconds: Math.round(process.uptime()),
    update: { phase: update.phase, available: update.availableVersion, error: update.error },
    keyd,
    ...(engine ? { docker: engine.ok ? "running" : "stopped" } : {}),
    ...(remote ? { remoteAccess: { enabled: remote.enabled, state: remote.state } } : {}),
    ...(checks ? { doctor: checks } : {}),
    computers,
  };
}

export interface ReportRoutesDeps {
  home: string;
  store: ReportStore;
  env: NodeJS.ProcessEnv;
  facts(signal: AbortSignal): Promise<ReportFacts>;
  fetch?: typeof fetch;
}

// A reviewed report waits this long to be sent, exactly as it was shown.
const DRAFT_MS = 15 * 60_000;
const DRAFTS = 4;
const Enabled = z.strictObject({ enabled: z.boolean() });

// Problem reports for the app and `localdot report`. Mount behind the install-token middleware.
export function reportRoutes(app: Hono, deps: ReportRoutesDeps): void {
  const drafts = new Map<
    string,
    { bundle: ReportBundle; gzip: Uint8Array<ArrayBuffer>; at: number }
  >();
  const prune = () => {
    for (const [id, draft] of drafts) if (Date.now() - draft.at > DRAFT_MS) drafts.delete(id);
    while (drafts.size > DRAFTS) drafts.delete(drafts.keys().next().value as string);
  };
  const off = (c: Context) =>
    c.text("Problem reports are turned off. Turn them on in Settings › Report a problem.", 403);
  const failed = (c: Context, error: unknown) => {
    if (error instanceof ReportServiceError) return c.text(error.message, 502);
    throw error;
  };

  app.use("/api/reports*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  app.get("/api/reports", (c) => c.json(deps.store.overview()));
  app.put("/api/reports", bodyLimit({ maxSize: 1024 }), async (c) => {
    const body = Enabled.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.text("Invalid setting", 400);
    return c.json(deps.store.setEnabled(body.data.enabled));
  });
  app.post("/api/reports/drafts", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    if (!deps.store.read().enabled) return off(c);
    const ask = ReportDraftRequest.safeParse(await c.req.json().catch(() => null));
    if (!ask.success) return c.text("Invalid report", 400);
    const facts = await deps.facts(c.req.raw.signal);
    const bundle = buildReport({
      home: deps.home,
      installId: deps.store.installId(),
      facts,
      ask: ask.data,
    });
    const gzip = packReport(bundle);
    prune();
    const draft = randomUUID();
    drafts.set(draft, { bundle, gzip, at: Date.now() });
    return c.json({ draft, bundle, bytes: gzip.byteLength } satisfies ReportDraft);
  });
  app.post("/api/reports/drafts/:draft/send", async (c) => {
    if (!deps.store.read().enabled) return off(c);
    prune();
    const id = c.req.param("draft");
    const draft = drafts.get(id);
    if (!draft) return c.text("This report has expired. Review it again, then send it.", 404);
    try {
      const sent = await sendReport(
        deps.store,
        reportsUrl(deps.env),
        draft.bundle,
        draft.gzip,
        c.req.raw.signal,
        deps.fetch,
      );
      drafts.delete(id);
      return c.json(sent);
    } catch (error) {
      return failed(c, error);
    }
  });
  app.on(["GET", "DELETE"], "/api/reports/sent/:id", async (c) => {
    const id = c.req.param("id");
    const sent = REPORT_ID.test(id) ? deps.store.find(id) : undefined;
    if (!sent) return c.text("This localDot didn't send that report.", 404);
    try {
      const base = reportsUrl(deps.env);
      if (c.req.method === "DELETE") {
        await deleteSentReport(deps.store, base, sent, c.req.raw.signal, deps.fetch);
        return c.body(null, 204);
      }
      const state = await reportState(base, sent, c.req.raw.signal, deps.fetch);
      return state ? c.json(state) : c.text("The report is no longer kept.", 404);
    } catch (error) {
      return failed(c, error);
    }
  });
}
