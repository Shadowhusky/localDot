import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { LocalDotEvent } from "@localdot/protocol";
import { expect, type Page, test } from "@playwright/test";
import { serveUi } from "../../daemon/src/static-ui.ts";

// Layout acceptance uses the built production page and its unchanged CSP. Only the API/stream
// data are samples; no daemon, desktop, provider, keyd, account or shared browser is started.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const CELL = "01JXYZ0000000000000000ABCD";
const SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const pausedCell = {
  id: CELL,
  state: "ready",
  scale: 2,
  paused: true,
  createdAt: "2026-10-03T00:00:00Z",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
};
const messages = [
  [
    "session.start",
    { screen: { w: 1280, h: 800, scale: 2 }, os: "linux", title: "Sample · monthly report" },
  ],
  [
    "message.user",
    {
      messageId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0Q",
      kind: "task",
      text: "Summarise the sample sales table and calculate the monthly totals.",
    },
  ],
  [
    "message.assistant",
    {
      messageId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0R",
      text: "## Report ready\n\nThe **monthly total** is 12,480. Review the *sample* output and changes in Activity.\n\n- Spreadsheet totals checked\n- Summary prepared\n\n[Report reference](https://example.test/report)\n\n```txt\nTotal: 12,480\n```\n\n<img src=https://example.test/pixel onerror=alert(1)> ![remote](https://example.test/image) [unsafe](javascript:alert(1))",
    },
  ],
  ["plan.set", { items: [{ id: "calculate", text: "Calculate monthly totals", status: "done" }] }],
  ["thought.delta", { text: "Checking the supplied totals and preparing the summary." }],
  ["tool.start", { tool: "shell", title: "Check report" }, "sample-command"],
  [
    "tool.output",
    { stream: "stdout", chunk: "Checked 12 rows\nTotal: 12,480\n\x1b]52;c;" },
    "sample-command",
  ],
  [
    "tool.output",
    { stream: "stdout", chunk: "clipboard-sentinel\x07Completed\n" },
    "sample-command",
  ],
  ["tool.output", { stream: "stderr", chunk: "No validation errors.\n" }, "sample-command"],
  ["tool.end", { ok: true, exitCode: 0 }, "sample-command"],
  [
    "file.change",
    {
      path: "monthly-summary.txt",
      op: "modify",
      patch:
        "@@ -1 +1,2 @@\n-Monthly total pending\n+Monthly total: 12,480\n+Checked 12 rows\n\\ No newline at end of file",
    },
    "sample-command",
  ],
  ["agent.state", { state: "idle" }],
];
const samples = messages.map(([type, data, step], seq) =>
  JSON.stringify(
    LocalDotEvent.parse({
      v: 1,
      id: String(seq).padStart(26, "0"),
      seq,
      t: seq * 1000,
      agent: "main",
      type,
      data,
      ...(step ? { step } : {}),
    }),
  ),
);

let server: Server;
let origin: string;
const requests: string[] = [];
test.beforeAll(async () => {
  const app = new Hono();
  app.get("/api/whoami", (c) => c.json({ ok: true }));
  app.get("/api/cells", (c) => c.json([pausedCell]));
  app.get(`/api/cells/${CELL}/live`, (c) => c.json({ sessionId: SESSION }));
  app.get(`/api/agent/sessions/${SESSION}`, (c) =>
    c.json({ sessionId: SESSION, cellId: CELL, status: "idle", toolCalls: 0 }),
  );
  app.get("/api/keyd", (c) =>
    c.json({
      online: true,
      bootId: "layout-sample",
      audit: { ok: true },
      hairpin: { state: "active" },
    }),
  );
  app.get("/api/keys", (c) => c.json({ keys: [] }));
  app.get(`/api/sessions/${SESSION}/clock`, (c) => c.json({ originMicros: 0 }));
  app.get("/api/clock", (c) => c.json({ nowMicros: 0 }));
  app.post(`/api/cells/${CELL}/stop`, (c) => {
    requests.push(c.req.path);
    return c.body(null, 204);
  });
  serveUi(app, fileURLToPath(new URL("../dist", import.meta.url)));
  server = createServer(async (req, res) => {
    try {
      const response = await app.fetch(
        new Request(`${origin}${req.url ?? "/"}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end("fixture response failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing owned listener");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  expect(server.listening).toBe(false);
});

async function load(page: Page, activeComposer = false) {
  const shownCell = activeComposer ? { ...pausedCell, paused: false } : pausedCell;
  if (activeComposer)
    await page.route(`${origin}/api/cells`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([shownCell]),
      }),
    );
  const errors: string[] = [],
    external: string[] = [];
  const sockets: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    external.push(route.request().url());
    return route.abort();
  });
  await page.routeWebSocket("**/*", (ws) => {
    const url = new URL(ws.url());
    expect(url.host).toBe(new URL(origin).host);
    sockets.push(url.pathname);
    if (url.pathname === `/api/cells/${CELL}/status`) ws.send(JSON.stringify(shownCell));
    else if (url.pathname === `/api/sessions/${SESSION}/stream`)
      for (const sample of samples) ws.send(sample);
    else throw new Error("unexpected layout socket");
  });
  await page.addInitScript(() => {
    localStorage.setItem("localdot.token", "a".repeat(43));
    const native = window.Worker;
    const counts = { created: 0, retired: 0 };
    Object.defineProperty(window, "layoutWorkers", { value: counts });
    const csp: string[] = [];
    const rejectionErrors: string[] = [];
    Object.defineProperty(window, "outputRejections", { value: rejectionErrors });
    window.addEventListener("unhandledrejection", () =>
      rejectionErrors.push("unhandled rejection"),
    );
    const clip = { writes: 0 };
    Object.defineProperty(window, "outputClipboard", { value: clip });
    const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text: string) => {
      clip.writes++;
      return nativeWrite(text);
    };
    Object.defineProperty(window, "layoutCsp", { value: csp });
    document.addEventListener("securitypolicyviolation", (event) =>
      csp.push(event.effectiveDirective),
    );
    window.Worker = class extends native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        counts.created++;
      }
      override terminate() {
        counts.retired++;
        super.terminate();
      }
    };
  });
  const response = await page.goto(origin);
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(response?.headers()["content-security-policy"]).not.toContain("unsafe-");
  await expect(
    page.getByRole("region", { name: "Conversation history", includeHidden: true }),
  ).toContainText("sample sales table");
  await expect(page.getByRole("list", { name: "Task plan", includeHidden: true })).toContainText(
    "Calculate monthly totals",
  );
  // The visible sample title also prevents these screenshots implying real application execution.
  await expect(page.locator(".title")).toHaveText("Sample · monthly report");
  return { errors, external, sockets };
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await page.locator(".app").boundingBox();
  expect(box?.height).toBe(await page.evaluate(() => innerHeight));
  const stop = page.getByRole("button", { name: "Stop computer", exact: true });
  await expect(stop).toBeVisible();
  const touch = await stop.boundingBox();
  expect(touch?.height).toBeGreaterThanOrEqual(44);
  expect(touch?.width).toBeGreaterThanOrEqual(44);
  expect((touch?.y ?? Infinity) + (touch?.height ?? Infinity)).toBeLessThanOrEqual(
    await page.evaluate(() => innerHeight),
  );
}

for (const width of [1280, 390]) {
  test(`safe output previews, clipboard and production CSP at ${width}px`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 800 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const proof = await load(page);
    if (width < 1180) await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    const markdown = page.locator(".safe-markdown");
    await expect(markdown.locator("strong")).toHaveText("monthly total");
    await expect(markdown.locator("ul li")).toHaveCount(2);
    await expect(markdown.locator("pre")).toHaveText("Total: 12,480");
    await expect(markdown.locator("a")).toHaveCount(1);
    const link = markdown.getByRole("link", { name: "Report reference" });
    await expect(link).toHaveAttribute("href", "https://example.test/report");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(await markdown.locator("img,svg,iframe,object,embed,script,style").count()).toBe(0);
    expect(proof.external).toEqual([]);
    expect(
      await page.evaluate(
        () => (window as unknown as { outputClipboard: { writes: number } }).outputClipboard.writes,
      ),
    ).toBe(0);
    if (width < 1180) await page.getByRole("tab", { name: "Activity", exact: true }).click();
    const activity = page.locator("details.model-activity");
    expect(await activity.getAttribute("open")).toBeNull();
    const trigger = page.getByRole("button", { name: "Inspect Check report", exact: true });
    await trigger.click();
    const detail = page.getByRole("region", { name: "Selected output", exact: true });
    await expect(detail).toBeFocused();
    const stdout = detail.getByRole("region", { name: "Standard output text", exact: true });
    await expect(stdout).toHaveText("Checked 12 rows\nTotal: 12,480\nCompleted\n");
    await expect(
      detail.getByRole("region", { name: "Standard error text", exact: true }),
    ).toHaveText("No validation errors.\n");
    expect((await stdout.textContent())?.includes("clipboard-sentinel")).toBe(false);
    expect(await detail.locator("input,textarea,a").count()).toBe(0);
    await detail.getByRole("button", { name: "Copy stdout", exact: true }).click();
    await expect(detail.getByRole("status")).toHaveText("Copied shown text.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "Checked 12 rows\nTotal: 12,480\nCompleted\n",
    );
    await stdout.focus();
    await expect(stdout).toBeFocused();
    await fits(page);
    await page.screenshot({ path: info.outputPath(`output-${width}-sample.png`) });
    await detail.getByRole("button", { name: "Close output" }).click();
    await expect(trigger).toBeFocused();
    await page
      .getByRole("button", { name: "Inspect modify: monthly-summary.txt", exact: true })
      .click();
    const diff = page.getByRole("region", { name: "Unified text diff", exact: true });
    await expect(diff).toContainText("Monthly total: 12,480");
    await expect(diff).toContainText("\\ No newline at end of file");
    expect(await diff.locator("img,svg,input,a").count()).toBe(0);
    await page.getByRole("button", { name: "Copy shown diff", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      await diff.textContent(),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(proof.errors).toEqual([]);
    expect(
      await page.evaluate(
        () => (window as unknown as { outputRejections: string[] }).outputRejections,
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => (window as unknown as { outputClipboard: { writes: number } }).outputClipboard.writes,
      ),
    ).toBe(2);
    expect(proof.external).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { layoutCsp: string[] }).layoutCsp),
    ).toEqual([]);
  });
}
