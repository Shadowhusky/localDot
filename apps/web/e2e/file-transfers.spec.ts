import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalDotEvent } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { expect, type Page, test } from "@playwright/test";
import { addToolRoutes } from "../../../cells/desktop/desktopd/src/tools/routes.ts";
import { MemoryStore } from "../../daemon/src/agent/memory.ts";
import { type AgentRoutesDeps, agentRoutes } from "../../daemon/src/agent/routes.ts";
import { AgentSession } from "../../daemon/src/agent/session.ts";
import { SettingsStore } from "../../daemon/src/agent/settings.ts";
import { DesktopdTools } from "../../daemon/src/desktopd/tools-client.ts";
import { serveUi } from "../../daemon/src/static-ui.ts";
import { isPhone } from "./layout.ts";
import { reach } from "./reach.ts";
import { skipSetup } from "./skip-setup.ts";

// Owned production page/CSP, real authenticated agent routes, desktop file routes and actual
// private files. Cell status/events/catalog are samples; no container, model or account runs.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: InstanceType<typeof Hono>["fetch"],
  ): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};
const CELL = "01JXYZ0000000000000000ABCD",
  SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const TOKEN = "a".repeat(43),
  DESKTOP_TOKEN = "d".repeat(43);
const OUTPUT = Buffer.from(
  "<!doctype html><script>window.artifactExecuted=true</script>\n中文 and English result\n",
);
const ONE = Buffer.from("one 中文\n"),
  TWO = Buffer.from("two English\n");
const cell = {
  id: CELL,
  state: "ready",
  scale: 2,
  createdAt: "2026-10-03T00:00:00Z",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
};
const samples = [
  [
    "session.start",
    { screen: { w: 1280, h: 800, scale: 2 }, os: "linux", title: "Sample · files and results" },
  ],
  [
    "message.user",
    {
      messageId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0Q",
      kind: "task",
      text: "Prepare the sample report and attach the result.",
    },
  ],
  [
    "message.assistant",
    {
      messageId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0R",
      text: "## Sample report ready\n\nDownload the result to inspect it. You can attach files to a follow-up.",
    },
  ],
  ["plan.set", { items: [{ id: "report", text: "Prepare the sample report", status: "done" }] }],
  [
    "task.result",
    {
      summary: "Sample report prepared.\nReview the downloaded file.",
      files: [
        {
          name: "report.html",
          path: "https://outside.invalid/arbitrary-model-path",
          bytes: OUTPUT.length,
        },
      ],
    },
  ],
  ["agent.state", { state: "idle" }],
].map(([type, data], seq) =>
  JSON.stringify(
    LocalDotEvent.parse({
      v: 1,
      id: String(seq).padStart(26, "0"),
      seq,
      t: seq * 1000,
      agent: "main",
      type,
      data,
    }),
  ),
);
let home: string,
  desktopHome: string,
  server: Server,
  origin: string,
  tools: DesktopdTools,
  session: AgentSession;
let calls: { method: string; path: string; authorization: boolean }[] = [],
  messages: string[] = [];
let activeUploads = 0,
  maxUploads = 0,
  releases = 0;
test.setTimeout(60_000);
test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "localdot-files-browser-"));
  desktopHome = mkdtempSync(join(tmpdir(), "localdot-files-desktop-"));
  const toolApp = new Hono();
  toolApp.use("*", async (c, next) =>
    c.req.header("authorization") === `Bearer ${DESKTOP_TOKEN}`
      ? next()
      : c.text("unauthorized", 401),
  );
  addToolRoutes(toolApp, {
    home: desktopHome,
    env: {},
    browser: {
      read: async () => {
        throw new Error("Unexpected owned browser read");
      },
      navigate: async () => {
        throw new Error("Unexpected owned browser navigation");
      },
    },
  });
  tools = new DesktopdTools(
    { baseUrl: "http://owned-desktopd", token: DESKTOP_TOKEN },
    async (url, init) => toolApp.fetch(new Request(url, init)),
  );
  session = new AgentSession(SESSION, CELL, "owned sample task", {
    append: (_id, event) => {
      if (event.type === "message.user") messages.push(String(event.data.text));
      return undefined as never;
    },
  });
  session.status = "idle";
  const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-03T00:00:00Z");
  const deps: AgentRoutesDeps = {
    home,
    settings: new SettingsStore(home),
    catalog: {
      get: () => catalog,
      refresh: async () => catalog,
      fresh: async () => catalog,
      freshness: () => ({ stale: false, refreshing: false, refreshFailed: false }),
    },
    keyd: { secrets: async () => [] },
    memory: new MemoryStore(home),
    skills: () => [],
    runner: {
      get: (id) => (id === SESSION ? session : undefined),
      start: async () => {
        throw new Error("No fixture model run is authorized");
      },
      raiseBudget: async () => {
        throw new Error("Unexpected fixture budget mutation");
      },
    },
    desktop: (id, requestSignal) => {
      if (id !== CELL || session.stopped || session.controlHeld) return undefined;
      const signal = AbortSignal.any([requestSignal, session.abort.signal]);
      activeUploads++;
      maxUploads = Math.max(maxUploads, activeUploads);
      return {
        tools,
        signal,
        check: () => signal.throwIfAborted(),
        release: () => {
          activeUploads--;
          releases++;
        },
      };
    },
    redactUserText: (text) => text,
    appendTo: () => {
      throw new Error("Unexpected fixture memory change");
    },
    harness: () => ({ available: false, reason: "Owned fixture has no account" }),
  };
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    const authorization = c.req.header("authorization") === `Bearer ${TOKEN}`;
    calls.push({ method: c.req.method, path: c.req.path, authorization });
    return authorization ? next() : c.text("unauthorized", 401);
  });
  app.get("/api/whoami", (c) => c.json({ ok: true }));
  app.get("/api/cells", (c) => c.json([cell]));
  app.get(`/api/cells/${CELL}/live`, (c) => c.json({ sessionId: SESSION }));
  app.post(`/api/cells/${CELL}/stream-ticket`, (c) =>
    c.text("Owned fixture has no video stream", 503),
  );
  app.get("/api/keyd", (c) =>
    c.json({
      online: true,
      bootId: "owned-file-fixture",
      audit: { ok: true },
      hairpin: { state: "active" },
    }),
  );
  app.get("/api/keys", (c) => c.json({ keys: [] }));
  app.get(`/api/sessions/${SESSION}/clock`, (c) => c.json({ originMicros: 0 }));
  app.get("/api/clock", (c) => c.json({ nowMicros: 0 }));
  agentRoutes(app, deps);
  serveUi(app, fileURLToPath(new URL("../dist", import.meta.url)));
  // Use the daemon's actual Node adapter: a cancelled unread body must not destroy the
  // HTTP response before a confirmed refusal is delivered.
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned listener missing");
  origin = `http://127.0.0.1:${address.port}`;
});
test.beforeEach(() => {
  rmSync(join(desktopHome, "Downloads"), { recursive: true, force: true });
  mkdirSync(join(home, "sessions", SESSION, "out"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "sessions", SESSION, "out", "report.html"), OUTPUT, { mode: 0o600 });
  calls = [];
  messages = [];
  activeUploads = 0;
  maxUploads = 0;
  releases = 0;
});
test.afterAll(async () => {
  session?.stop();
  await tools?.close();
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (home) rmSync(home, { recursive: true, force: true });
  if (desktopHome) rmSync(desktopHome, { recursive: true, force: true });
  expect(server?.listening).toBe(false);
  expect(activeUploads).toBe(0);
});
async function load(page: Page) {
  const errors: string[] = [],
    external: string[] = [],
    downloads: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await skipSetup(page);
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    external.push(route.request().url());
    return route.abort();
  });
  await page.routeWebSocket("**/*", (ws) => {
    const url = new URL(ws.url());
    expect(url.host).toBe(new URL(origin).host);
    if (url.pathname === `/api/cells/${CELL}/status`) ws.send(JSON.stringify(cell));
    else if (url.pathname === `/api/sessions/${SESSION}/stream`)
      for (const sample of samples) ws.send(sample);
    // The app-wide events socket (routines, attention) stays open and quiet.
    else if (url.pathname !== "/api/events") throw new Error("Unexpected owned fixture socket");
  });
  await page.addInitScript(() => {
    localStorage.setItem("localdot.token", "a".repeat(43));
    const proof = { csp: [] as string[], rejections: [] as string[], urls: 0, revoked: 0 };
    Object.defineProperty(window, "fileProof", { value: proof });
    document.addEventListener("securitypolicyviolation", (e) =>
      proof.csp.push(e.effectiveDirective),
    );
    window.addEventListener("unhandledrejection", () =>
      proof.rejections.push("Unhandled rejection"),
    );
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      proof.urls++;
      return create(blob);
    };
    URL.revokeObjectURL = (url) => {
      proof.revoked++;
      revoke(url);
    };
  });
  const response = await page.goto(origin);
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(response?.headers()["content-security-policy"]).not.toContain("unsafe-");
  if (!isPhone(page))
    await expect(page.locator(".bar-title")).toHaveText("Sample · files and results");
  await expect(
    page.getByRole("region", { name: "Conversation history", includeHidden: true }),
  ).toContainText("Sample report ready");
  return { errors, external, downloads };
}
async function chooser(page: Page, name: string, buffer: Buffer) {
  const attach = page.getByRole("button", { name: "Attach files" });
  await attach.focus();
  const opening = page.waitForEvent("filechooser");
  await attach.press("Enter");
  await (await opening).setFiles({ name, mimeType: "text/plain", buffer });
}
for (const width of [1280, 390])
  test(`explicit files and inert authenticated download at ${width}px`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const proof = await load(page);
    await page.getByLabel("Message", { exact: true }).fill("Read the two sample files");
    expect(messages).toEqual([]);
    expect(proof.downloads).toEqual([]);
    await chooser(page, "one.txt", ONE);
    await expect(page.getByText("Uploaded to Downloads", { exact: true })).toHaveCount(1);
    await page.getByRole("form", { name: "Message dot" }).evaluate((form, content) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], "two.txt", { type: "text/plain" }));
      form.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    }, TWO.toString("utf8"));
    await expect(page.getByText("Uploaded to Downloads", { exact: true })).toHaveCount(2);
    expect(messages).toEqual([]);
    expect(maxUploads).toBe(1);
    expect(releases).toBe(2);
    expect(readFileSync(join(desktopHome, "Downloads", "one.txt"))).toEqual(ONE);
    expect(readFileSync(join(desktopHome, "Downloads", "two.txt"))).toEqual(TWO);
    expect(readdirSync(join(desktopHome, "Downloads")).sort()).toEqual(["one.txt", "two.txt"]);
    if (width >= 1100)
      await page.screenshot({ path: info.outputPath(`files-${width}-sample.png`) });
    await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
    const history = page.getByRole("region", { name: "Conversation history" });
    await expect(history.getByText("Read the two sample files", { exact: true })).toBeVisible();
    await expect(history.getByRole("list", { name: "Attached files" })).toHaveText(
      "one.txttwo.txt",
    );
    expect(messages).toEqual([
      "Read the two sample files\n\nAttached files on this computer:\n- ~/Downloads/one.txt\n- ~/Downloads/two.txt",
    ]);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    await expect(page.getByText("Uploaded to Downloads", { exact: true })).toHaveCount(0);
    await chooser(page, "one.txt", Buffer.from("must not replace"));
    await expect(page.getByText("Not uploaded", { exact: true })).toBeVisible();
    expect(messages).toHaveLength(1);
    expect(readFileSync(join(desktopHome, "Downloads", "one.txt"))).toEqual(ONE);
    const files = page
      .getByRole("region", { name: "Conversation history" })
      .getByRole("region", { name: "Task result", exact: true });
    await expect(files).toContainText("report.html");
    expect(proof.downloads).toEqual([]);
    const reply = page.waitForResponse((r) => r.url().endsWith(`/files/report.html`));
    const downloading = page.waitForEvent("download");
    await files.getByRole("button", { name: "Download report.html", exact: true }).click();
    const download = await downloading,
      response = await reply;
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/octet-stream");
    expect(response.headers()["content-disposition"]).toBe(
      "attachment; filename*=UTF-8''report.html",
    );
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe("report.html");
    const saved = await download.path();
    if (!saved) throw new Error("Owned browser download missing");
    expect(readFileSync(saved)).toEqual(OUTPUT);
    expect(download.url().startsWith("blob:")).toBe(true);
    expect(download.url()).not.toContain(TOKEN);
    expect(proof.downloads).toEqual(["report.html"]);
    // Said through the page's one polite region.
    await expect(page.locator(".app > [role=status]")).toHaveText("report.html downloaded.");
    expect(context.pages()).toHaveLength(1);
    expect(await page.evaluate(() => "artifactExecuted" in window)).toBe(false);
    // The card's own icons are the only pictures in it; the file itself never renders.
    expect(
      await files.locator("iframe,img,svg:not(.ui-icon, .ui-spinner),object,embed,script").count(),
    ).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { fileProof: { revoked: number } }).fileProof.revoked,
        ),
      )
      .toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // The composer's controls stay on screen and take a finger after the files went through.
    for (const name of ["Attach files", "Send follow-up"]) {
      const control = page.getByRole("form", { name: "Message dot" }).getByRole("button", { name });
      await expect(control).toBeVisible();
      expect(await control.evaluate(reach), name).toEqual({ width: 44, height: 44 });
      const box = await control.boundingBox();
      expect((box?.y ?? Infinity) + (box?.height ?? Infinity)).toBeLessThanOrEqual(800);
    }
    if (width < 1100) await page.screenshot({ path: info.outputPath(`files-${width}-sample.png`) });
    expect(proof.errors).toEqual([]);
    expect(proof.external).toEqual([]);
    const browserProof = await page.evaluate(
      () => (window as unknown as { fileProof: { csp: string[]; rejections: string[] } }).fileProof,
    );
    expect(browserProof.csp).toEqual([]);
    expect(browserProof.rejections).toEqual([]);
    expect(calls.filter((c) => c.path.endsWith("/upload"))).toHaveLength(3);
    expect(calls.filter((c) => c.path.endsWith("/messages"))).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith("/api/")).every((c) => c.authorization)).toBe(
      true,
    );
    expect(calls.some((c) => c.path.includes("arbitrary-model-path"))).toBe(false);
  });
