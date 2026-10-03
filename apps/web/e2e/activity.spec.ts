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
    { screen: { w: 1280, h: 800, scale: 2 }, os: "linux", title: "Sample · mixed activity" },
  ],
  [
    "message.user",
    {
      messageId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0Q",
      kind: "task",
      text: "Show the sample timeline and report.",
    },
  ],
  [
    "message.assistant",
    {
      messageId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0R",
      text: "Review the sample plan, commands, changes and results in Activity.",
    },
  ],
  [
    "plan.set",
    {
      items: [
        { id: "read", text: "Read the sample data", status: "done" },
        { id: "prepare", text: "Prepare the report", status: "doing" },
        { id: "review", text: "Review the result", status: "todo" },
        { id: "send", text: "Send externally", status: "skipped" },
      ],
    },
  ],
  ["step.start", { kind: "gui" }, "stale-click"],
  ["action.intent", { verb: "click", label: "Click Save", risk: "none" }, "stale-click"],
  ["action.cancel", { reason: "stale" }, "stale-click"],
  ["step.end", { status: "cancelled", note: "The target changed before input." }, "stale-click"],
  [
    "key.use",
    { secretId: "sample", host: "example.test", method: "GET", path: "/sample", decision: "allow" },
  ],
  ["step.start", { kind: "shell" }, "sample-command"],
  ["tool.start", { tool: "shell", title: "Check report" }, "sample-command"],
  [
    "tool.output",
    { stream: "stderr", chunk: "Sample report needs another check.\n" },
    "sample-command",
  ],
  ["tool.end", { ok: false, exitCode: 2 }, "sample-command"],
  ["step.end", { status: "failed", note: "The command returned exit code 2." }, "sample-command"],
  [
    "key.use",
    { secretId: "sample", host: "example.test", method: "GET", path: "/sample", decision: "allow" },
  ],
  ["step.start", { kind: "file" }, "sample-file"],
  [
    "file.change",
    {
      path: "report.txt",
      op: "create",
      patch: "@@ -0,0 +1,2 @@\n+Sample report\n+中文 and English",
    },
    "sample-file",
  ],
  ["step.end", { status: "ok" }, "sample-file"],
  [
    "memory.change",
    {
      file: "MEMORY.md",
      patch: "@@ -1 +1,2 @@\n About the user\n+Prefers concise reports",
      changeId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0S",
    },
  ],
  ["step.start", { kind: "ask" }, "sample-question"],
  [
    "ask.request",
    {
      askId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0T",
      question: "Which format do you prefer?",
      options: [{ key: "A", text: "Text report" }],
      allowText: true,
    },
  ],
  ["ask.answer", { askId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0T", by: "user", option: "A" }],
  ["step.end", { status: "ok" }, "sample-question"],
  ["task.result", { summary: "Earlier sample result.\nNo files were attached.", files: [] }],
  [
    "task.result",
    {
      summary: "Sample report prepared.\nOne command failed; inspect its output before continuing.",
      files: [
        { name: "report.txt", path: "https://outside.invalid/report", bytes: 87 },
        { name: "notes.txt", path: "/arbitrary-model-path", bytes: 18 },
      ],
    },
  ],
  ["step.start", { kind: "browser" }, "unfinished-browser"],
  ["tool.start", { tool: "browser", title: "Read sample page" }, "unfinished-browser"],
  ["session.end", { reason: "error" }],
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
  ).toContainText("sample timeline");
  await expect(page.getByRole("list", { name: "Task plan", includeHidden: true })).toContainText(
    "Prepare the report",
  );
  // The visible sample title also prevents these screenshots implying real application execution.
  await expect(page.locator(".title")).toHaveText("Sample · mixed activity");
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
  test(`mixed activity, filters and bounded inspection at ${width}px`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 800 });
    const proof = await load(page);
    if (width < 1180) await page.getByRole("tab", { name: "Activity", exact: true }).click();
    const rail = page.getByRole("complementary", { name: "Plan and steps" });
    await expect(rail.getByRole("list", { name: "Task plan", exact: true })).toContainText(
      "4. Skipped",
    );
    await expect(rail.getByText("1 of 4 completed", { exact: true })).toBeVisible();
    await expect(rail.getByRole("region", { name: "Task result", exact: true })).toHaveCount(2);
    await expect(
      rail.getByText(
        "Sample report prepared.\nOne command failed; inspect its output before continuing.",
        { exact: true },
      ),
    ).toBeVisible();
    const steps = rail.getByRole("region", { name: "Recorded steps", exact: true });
    expect(
      await steps
        .locator(":scope > div")
        .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid"))),
    ).toEqual(["step-row", "key-use", "tool-row", "key-use", "tool-row", "tool-row", "tool-row"]);
    await expect(steps.getByText("Click Save", { exact: true })).toBeVisible();
    await expect(steps.getByText("Input not delivered", { exact: true })).toBeVisible();
    await expect(steps.getByText("Completion not confirmed", { exact: true })).toBeVisible();
    await expect(steps.getByText("Tool failed. Exit code 2.", { exact: true })).toBeVisible();
    const filter = rail.getByRole("group", { name: "Activity filter", exact: true });
    await filter.getByRole("button", { name: "Computer", exact: true }).click();
    await expect(steps.getByTestId("step-row")).toHaveCount(1);
    await expect(steps.getByTestId("tool-row")).toHaveCount(0);
    await filter.getByRole("button", { name: "Tools", exact: true }).click();
    await expect(steps.getByTestId("tool-row")).toHaveCount(4);
    await expect(steps.getByTestId("key-use")).toHaveCount(2);
    await filter.getByRole("button", { name: "All", exact: true }).click();
    const output = rail.getByRole("button", { name: "Inspect Check report", exact: true });
    await output.click();
    const detail = rail.getByRole("region", { name: "Selected output", exact: true });
    await expect(detail).toBeFocused();
    await expect(
      detail.getByRole("region", { name: "Standard error text", exact: true }),
    ).toHaveText("Sample report needs another check.\n");
    await detail.getByRole("button", { name: "Close output", exact: true }).click();
    await expect(output).toBeFocused();
    await rail.getByRole("button", { name: "Inspect create: report.txt", exact: true }).click();
    await expect(
      detail.getByRole("region", { name: "Unified text diff", exact: true }),
    ).toContainText("中文 and English");
    await detail.getByRole("button", { name: "Close output", exact: true }).click();
    await rail.getByRole("button", { name: "Inspect memory diff", exact: true }).click();
    await expect(
      detail.getByRole("region", { name: "Unified text diff", exact: true }),
    ).toContainText("Prefers concise reports");
    await detail.getByRole("button", { name: "Close output", exact: true }).click();
    await expect(rail.getByRole("region", { name: "Question history", exact: true })).toContainText(
      "Answer: Text report",
    );
    await rail.evaluate((element) => {
      element.scrollTop = 0;
    });
    await fits(page);
    await page.screenshot({ path: info.outputPath(`activity-${width}-sample.png`) });
    await rail.getByRole("heading", { name: "Steps", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`steps-${width}-sample.png`) });
    const filters = filter.getByRole("button");
    for (const button of await filters.all()) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect(proof.errors).toEqual([]);
    expect(proof.external).toEqual([]);
    expect(
      await page.evaluate(
        () => (window as unknown as { outputRejections: string[] }).outputRejections,
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { layoutCsp: string[] }).layoutCsp),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => (window as unknown as { outputClipboard: { writes: number } }).outputClipboard.writes,
      ),
    ).toBe(0);
  });
}
