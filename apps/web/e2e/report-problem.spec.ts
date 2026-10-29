import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { expect, type Page, test } from "@playwright/test";
import { MemoryStore } from "../../daemon/src/agent/memory.ts";
import { type AgentRoutesDeps, agentRoutes } from "../../daemon/src/agent/routes.ts";
import { SettingsStore } from "../../daemon/src/agent/settings.ts";
import type { ReportFacts } from "../../daemon/src/reports/bundle.ts";
import { reportRoutes } from "../../daemon/src/reports/routes.ts";
import { ReportStore } from "../../daemon/src/reports/store.ts";
import { serveUi } from "../../daemon/src/static-ui.ts";
import { settingsSheet } from "./settings-ui.ts";
import { skipSetup } from "./skip-setup.ts";

// The production UI and the daemon's real report routes, sending to the reports Worker run
// locally: Miniflare with in-memory D1 and KV from apps/reports/dist (pnpm test:reports builds
// it), or a `wrangler dev` given as LOCALDOT_E2E_REPORTS_URL with its LOCALDOT_E2E_OWNER_TOKEN.
// The computer, its checks and keyd are stand-ins; nothing leaves this machine.
const daemonRequire = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = daemonRequire("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const reportsRequire = createRequire(new URL("../../reports/package.json", import.meta.url));
const CELL = "01JXYZ0000000000000000ABCD",
  TOKEN = "a".repeat(43),
  CODE = "Itv4dFzbVVFmlS4bnD5WC2IU1v6-Q2L4bvNo0EedN_Y";
const at = "2026-10-29T08:00:00Z";
const OUT = fileURLToPath(new URL("out/report-problem/", import.meta.url));
const PROBLEM = "dot's web browser couldn't start: Chromium exited with status 133.";
let home: string, server: Server, origin: string, service: string, owner: string;
interface LocalWorker {
  dispose(): Promise<void>;
}
interface LocalD1 {
  prepare(sql: string): unknown;
  batch(statements: unknown[]): Promise<unknown>;
}
let worker: LocalWorker | undefined;
test.setTimeout(90_000);

const COMPUTER = {
  id: CELL,
  state: "ready" as const,
  scale: 2 as const,
  createdAt: at,
  stream: { connection: "none" as const, viewers: 0, lastUpstreamAt: null },
};
const BROWSER = { state: "failed" as const, problem: PROBLEM, problemAt: at, restarts: 3 };

const facts = (): ReportFacts => ({
  version: "1.4.0-rc.2",
  install: "managed",
  app: "running",
  uptimeSeconds: 5400,
  update: { phase: "idle", available: null, error: null },
  keyd: "ready",
  docker: "running",
  remoteAccess: { enabled: false, state: "off" },
  doctor: [
    { name: "docker-engine", ok: true, detail: "Docker Engine 29.2.0 (API 1.52)" },
    { name: "isolated-gateway-mode", ok: true, detail: "Internal networks reach no gateway" },
    { name: "image-desktop", ok: true, detail: "localdot/desktop:1.4.0-rc.2" },
    { name: "image-browser", ok: true, detail: "localdot/browser:1.4.0-rc.2" },
    { name: "port", ok: true, detail: "127.0.0.1:4750 is localDot's own" },
    { name: "keyd", ok: true, detail: "boot 8c1e2f, version 1.4.0-rc.2" },
    { name: "hairpin-guard", ok: true, detail: "Public address known; dialling it is refused" },
    { name: "browser-egress", ok: false, detail: "The cloud metadata address answered" },
  ],
  computers: [
    {
      cell: COMPUTER,
      browser: BROWSER,
      supervisor: {
        state: "stopped",
        restarts: 3,
        lastFailure: { kind: "browser_exited", detail: "exit status 133", recovered: false, at },
      },
    },
  ],
});

function seedHome(dir: string) {
  mkdirSync(join(dir, "logs"));
  writeFileSync(
    join(dir, "logs", "daemon.log"),
    `${[
      "[2026-10-29T07:58:02.114Z] localdot daemon on http://127.0.0.1:4750 (token in /Users/jordan/.localdot/daemon-token)",
      `[2026-10-29T07:58:02.115Z] open http://127.0.0.1:4750/#code=${CODE} (expires in one minute)`,
      "[2026-10-29T07:58:02.130Z] the key service is back; the web browser restarts with it",
      "[2026-10-29T07:59:41.502Z] web browser for 01JXYZ0000000000000000ABCD failed to start: exit status 133",
      "[2026-10-29T08:00:12.877Z] web browser for 01JXYZ0000000000000000ABCD failed to start: exit status 133",
    ].join("\n")}\n`,
  );
  writeFileSync(join(dir, "logs", "keyd.log"), "keyd 1.4.0-rc.2 listening on 4760-4789\n");
}

async function startService() {
  if (process.env.LOCALDOT_E2E_REPORTS_URL) {
    service = process.env.LOCALDOT_E2E_REPORTS_URL.replace(/\/$/, "");
    owner = process.env.LOCALDOT_E2E_OWNER_TOKEN ?? "";
    return;
  }
  const { convertV4MiniflareOptions, Miniflare } = reportsRequire("miniflare") as {
    convertV4MiniflareOptions(options: unknown): unknown;
    Miniflare: new (
      options: unknown,
    ) => LocalWorker & {
      ready: Promise<URL>;
      getD1Database(name: string): Promise<LocalD1>;
    };
  };
  owner = "owner-token-for-e2e-0123456789abcdef";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "reports",
          modules: true,
          // Module names are relative to this root, which otherwise is the working directory.
          modulesRoot: fileURLToPath(new URL("../../reports/dist", import.meta.url)),
          scriptPath: fileURLToPath(new URL("../../reports/dist/worker.js", import.meta.url)),
          compatibilityDate: "2026-10-10",
          bindings: { OWNER_TOKEN: owner },
          d1Databases: { DB: "reports-db" },
          kvNamespaces: { BUNDLES: "reports-kv" },
        },
      ],
      host: "127.0.0.1",
      port: 0,
    }),
  );
  worker = mf;
  const url = await mf.ready;
  const db = await mf.getD1Database("DB");
  const sql = readFileSync(
    fileURLToPath(new URL("../../reports/migrations/0001_reports.sql", import.meta.url)),
    "utf8",
  )
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await db.batch(sql.map((statement) => db.prepare(statement)));
  service = url.origin;
}

test.beforeAll(async () => {
  await startService();
  home = mkdtempSync(join(tmpdir(), "localdot-report-e2e-"));
  seedHome(home);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const settings = new SettingsStore(home);
  settings.put({});
  const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, at),
    app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${TOKEN}`) return c.text("unauthorized", 401);
    await next();
  });
  app.get("/api/whoami", (c) => c.json({ ok: true }));
  app.get("/api/cells", (c) => c.json([COMPUTER]));
  app.get(`/api/cells/${CELL}/live`, (c) => c.body(null, 404));
  app.post(`/api/cells/${CELL}/stream-ticket`, (c) => c.text("owned fixture has no stream", 503));
  app.get(`/api/cells/${CELL}/accounts`, (c) => c.json({ sites: [] }));
  app.get(`/api/cells/${CELL}/browser`, (c) => c.json(BROWSER));
  app.get("/api/keyd", (c) =>
    c.json({
      online: true,
      bootId: "owned-fixture",
      audit: { ok: true },
      hairpin: { state: "active", addresses: 1 },
    }),
  );
  app.get("/api/keys", (c) => c.json({ keys: [] }));
  const deps: AgentRoutesDeps = {
    settings,
    catalog: {
      get: () => catalog,
      refresh: async () => catalog,
      fresh: async () => catalog,
      freshness: () => ({ stale: false, refreshing: false, refreshFailed: false }),
    },
    keyd: {
      secrets: async () => [],
      budget: async () => ({
        perTaskUSD: 2,
        perDayUSD: 20,
        day: { date: "2026-10-29", spentUSD: 0 },
      }),
    },
    runner: {
      get: () => undefined,
      start: async () => {
        throw new Error("No fixture model run is authorized");
      },
      raiseBudget: async () => {
        throw new Error("Unexpected fixture mutation");
      },
    },
    memory: new MemoryStore(home),
    skills: () => [],
    desktop: () => undefined,
    home,
    redactUserText: (text) => text,
    appendTo: () => {
      throw new Error("No fixture task events expected");
    },
    harness: () => ({ available: false, reason: "owned fixture has no account" }),
  };
  agentRoutes(app, deps);
  reportRoutes(app, {
    home,
    store: new ReportStore(home),
    env: { LOCALDOT_REPORTS_URL: service },
    facts: async () => facts(),
  });
  serveUi(app, fileURLToPath(new URL("../dist", import.meta.url)));
  server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
    const response = await app.fetch(
      new Request(`${origin}${req.url ?? "/"}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(body.length ? { body } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("owned listener missing");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await worker?.dispose();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function load(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket("**/*", (ws) => {
    if (new URL(ws.url()).pathname === `/api/cells/${CELL}/status`)
      ws.send(JSON.stringify(COMPUTER));
  });
  await page.addInitScript((token) => localStorage.setItem("localdot.token", token), TOKEN);
  await skipSetup(page);
  await page.goto(origin);
  await expect(
    page
      .getByRole("button", { name: "Settings", exact: true })
      .or(page.getByRole("button", { name: "More", exact: true }))
      .first(),
  ).toBeVisible();
  return errors;
}

test("a failure becomes a reviewed report the owner can find and track", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await load(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sheet = settingsSheet(page);
  await sheet.getByRole("button", { name: "Accounts", exact: true }).click();
  await sheet.getByRole("button", { name: "Report this problem" }).click();
  const section = sheet.getByRole("region", { name: "Report a problem", exact: true });
  await expect(section.getByText(PROBLEM)).toBeVisible();
  await section
    .getByRole("textbox", { name: "What happened?" })
    .fill(
      "I asked dot to book a table and the browser never opened. Reach me at jordan@example.com.",
    );
  await page.screenshot({ path: join(OUT, "1-write.png") });

  await section.getByRole("button", { name: "Review report" }).click();
  await expect(section.getByText("What will be sent")).toBeVisible();
  await expect(section.getByText("1 of 8 failed")).toBeVisible();
  await page.screenshot({ path: join(OUT, "2-review.png") });
  await section.getByRole("button", { name: "Everything that will be sent" }).click();
  const text = section.locator(".settings-report-text");
  await expect(text).toContainText("#code=[redacted]");
  await expect(text).toContainText("/Users/[user]/.localdot");
  await expect(text).toContainText("Reach me at [email]");
  await expect(text).not.toContainText(CODE);
  await page.screenshot({ path: join(OUT, "3-everything.png") });

  await section.getByRole("button", { name: "Send report" }).click();
  await expect(
    section.getByText("Report sent. Quote this ID when you ask for help."),
  ).toBeVisible();
  const id = (await section.locator(".settings-report-id").first().textContent()) ?? "";
  expect(id).toMatch(/^LD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  await expect(section.getByText("Received")).toBeVisible();
  await page.screenshot({ path: join(OUT, "4-sent.png") });
  expect(errors).toEqual([]);

  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await desk.goto(service);
  await desk.getByLabel("Owner token").fill(owner);
  await desk.getByRole("button", { name: "Open reports" }).click();
  const row = desk.getByRole("button", { name: new RegExp(id) });
  await expect(row).toContainText(`Web browser: ${PROBLEM}`);
  await row.click();
  await expect(desk.getByRole("heading", { name: id })).toBeVisible();
  await expect(desk.getByText("1 failed", { exact: false })).toBeVisible();
  await desk.getByRole("combobox", { name: "Status" }).selectOption("investigating");
  await desk
    .getByLabel("Notes")
    .fill("Chromium exits at launch on this image; see the browser log.");
  await desk.getByRole("button", { name: "Save" }).click();
  await expect(desk.getByRole("status")).toHaveText("Saved");
  await desk.screenshot({ path: join(OUT, "5-owner.png") });
  await desk.setViewportSize({ width: 390, height: 844 });
  await desk.screenshot({ path: join(OUT, "6-owner-phone.png"), fullPage: true });
  await desk.close();

  // The sender sees how far the owner has got.
  await sheet.getByRole("button", { name: "Report another problem" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await sheet.getByRole("button", { name: "Report a problem", exact: true }).click();
  await expect(section.getByText("Being looked at")).toBeVisible();
});

test("reports read well on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const sheet = settingsSheet(page);
  await sheet.getByRole("button", { name: /^Report a problem/ }).click();
  await sheet.getByRole("button", { name: "Review report" }).click();
  await expect(sheet.getByText("What will be sent")).toBeVisible();
  await page.screenshot({ path: join(OUT, "7-review-phone.png") });
});
