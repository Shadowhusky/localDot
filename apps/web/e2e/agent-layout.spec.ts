import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { LocalDotEvent } from "@localdot/protocol";
import { expect, type Page, test } from "@playwright/test";
import { serveUi } from "../../daemon/src/static-ui.ts";
import { fits, isPhone } from "./layout.ts";

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
const samples = [
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
      text: "The sample report is ready. The monthly total is 12,480, with the formulas included in the spreadsheet.\n\nYou can review the steps alongside the conversation.",
    },
  ],
  [
    "plan.set",
    {
      items: [
        { id: "read", text: "Read the sales table", status: "done" },
        { id: "calculate", text: "Calculate monthly totals", status: "done" },
        { id: "export", text: "Prepare the spreadsheet and summary", status: "done" },
      ],
    },
  ],
  [
    "task.result",
    {
      summary: "Sample monthly report prepared with a spreadsheet and a short summary.",
      files: [
        { name: "monthly-report.ods", path: "monthly-report.ods", bytes: 2048 },
        { name: "summary.txt", path: "summary.txt", bytes: 180 },
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
  const { paused: _paused, ...activeCell } = pausedCell;
  const shownCell = activeComposer ? activeCell : pausedCell;
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
    // The app-wide events socket (routines, attention) stays open and quiet.
    else if (url.pathname !== "/api/events") throw new Error("unexpected layout socket");
  });
  await page.addInitScript(() => {
    localStorage.setItem("localdot.token", "a".repeat(43));
    const native = window.Worker;
    const counts = { created: 0, retired: 0 };
    Object.defineProperty(window, "layoutWorkers", { value: counts });
    const csp: string[] = [];
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
  // A phone has no top bar and keeps the plan in its Activity sheet; elsewhere the visible sample
  // title also prevents these screenshots implying real application execution.
  if (!isPhone(page)) {
    await expect(page.getByRole("list", { name: "Task plan", includeHidden: true })).toContainText(
      "Calculate monthly totals",
    );
    await expect(page.locator(".bar-title")).toHaveText("Sample · monthly report");
  }
  return { errors, external, sockets };
}
// Whether the thread is out of reach behind another view of the rail.
const threadInert = (page: Page) =>
  page
    .getByRole("region", { name: "Conversation history", includeHidden: true })
    .evaluate((element) => element.closest("[inert]") !== null);
test("desktop, tablet, phone, keyboard and 200 percent zoom keep the stage, rail and stream mounted", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const proof = await load(page);
  await fits(page);
  const stage = page.getByRole("main", { name: "Computer" });
  const rail = page.getByRole("complementary", { name: "Conversation" });
  const thread = rail.getByRole("region", { name: "Conversation history" });
  const views = rail.getByRole("radiogroup", { name: "Show" });
  await expect(stage).toBeVisible();
  await expect(thread).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("desktop-sample.png") });
  const workers = await page.evaluate(
    () => (window as unknown as { layoutWorkers: unknown }).layoutWorkers,
  );
  expect(workers).toEqual({ created: 1, retired: 0 });
  const sockets = [...proof.sockets];
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(stage).toBeVisible();
    await expect(thread).toBeVisible();
    await fits(page);
    if (width >= 700) {
      // The rail switches its views over the one thread, which is out of reach while covered.
      for (const view of ["Activity", "Chat"]) {
        const radio = views.getByRole("radio", { name: view, exact: true });
        await radio.click();
        await expect(radio).toHaveAttribute("aria-checked", "true");
        await fits(page);
        expect(await threadInert(page)).toBe(view !== "Chat");
      }
      await expect(page.getByRole("complementary", { name: "Plan and steps" })).toBeAttached();
    } else {
      // A phone has no views to switch: Activity is a sheet over the thread.
      await expect(views).toHaveCount(0);
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "Activity" });
      await expect(sheet.getByRole("list", { name: "Task plan" })).toContainText(
        "Calculate monthly totals",
      );
      await sheet.getByRole("button", { name: "Done", exact: true }).click();
      await expect(sheet).toBeHidden();
      await fits(page);
    }
    if (width === 390) await page.screenshot({ path: info.outputPath("phone-sample.png") });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const chat = views.getByRole("radio", { name: "Chat", exact: true });
  await chat.focus();
  await page.keyboard.press("ArrowRight");
  await expect(views.getByRole("radio", { name: "Activity", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(chat).toBeFocused();
  await expect(chat).toHaveAttribute("aria-checked", "true");
  await thread.focus();
  await page.setViewportSize({ width: 390, height: 316 });
  await expect(thread).toBeVisible();
  await fits(page);
  // Emulate 200% zoom with half the CSS viewport and a doubled view scale.
  await page.setViewportSize({ width: 1280, height: 800 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 640,
    height: 400,
    deviceScaleFactor: 2,
    mobile: false,
    scale: 2,
  });
  await expect(thread).toBeVisible();
  await fits(page);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  expect(
    await page.evaluate(() => (window as unknown as { layoutWorkers: unknown }).layoutWorkers),
  ).toEqual(workers);
  expect(proof.sockets).toEqual(sockets);
  expect(proof.external).toEqual([]);
  expect(proof.errors).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { layoutCsp: unknown }).layoutCsp),
  ).toEqual([]);
});
test("Keys keeps keyboard focus, an accessible Shut down and reduced-preference rendering", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  const proof = await load(page);
  expect(
    await page
      .locator(".stage > canvas")
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
  expect(
    await page
      .locator(".island-plate")
      .evaluate((element) => getComputedStyle(element).backdropFilter),
  ).toBe("none");
  // A phone has no top bar: Keys is in More, and opens Settings at its Keys page.
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  await page.getByRole("menuitem", { name: "Keys", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Keys", exact: true });
  await expect(dialog.locator("#settings-sheet-body[data-page='keys']")).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await more.evaluate((element) => element.focus());
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("keys-phone-sample.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
  await fits(page);
  const before = requests.length;
  await page.locator(".island").getByRole("button", { name: "Shut down", exact: true }).click();
  await expect.poll(() => requests.length).toBe(before + 1);
  expect(requests.at(-1)).toBe(`/api/cells/${CELL}/stop`);
  expect(proof.external).toEqual([]);
  expect(proof.errors).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { layoutCsp: unknown }).layoutCsp),
  ).toEqual([]);
});

test("composer submits once and moves a recognised key without a task request", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const proof = await load(page, true);
  const bodies: string[] = [];
  const accepted = Promise.withResolvers<void>();
  await page.route(`${origin}/api/agent/sessions/${SESSION}/messages`, async (route) => {
    bodies.push(route.request().postData() ?? "");
    await accepted.promise;
    await route.fulfill({ status: 202, body: "" });
  });
  const draft = page.getByLabel("Message", { exact: true });
  await draft.fill("请继续 the sample report");
  await expect(page.getByRole("button", { name: "Send follow-up" })).toBeEnabled();
  await draft.press("Enter");
  await expect.poll(() => bodies.length).toBe(1);
  await page.getByRole("form", { name: "Message dot" }).evaluate((element) => {
    (element as HTMLFormElement).requestSubmit();
    (element as HTMLFormElement).requestSubmit();
  });
  expect(bodies).toEqual([JSON.stringify({ kind: "followup", text: "请继续 the sample report" })]);
  accepted.resolve();
  await expect(draft).toHaveValue("");
  await expect(
    page
      .getByRole("region", { name: "Conversation history" })
      .getByText("请继续 the sample report"),
  ).toBeVisible();
  const key = `sk-proj-${"a".repeat(156)}`;
  await draft.fill(`before ${key} after`);
  await expect(draft).toHaveValue("before  after");
  await expect(page.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
  await page.getByRole("button", { name: "Move to Keys" }).click();
  const keys = page.getByRole("dialog", { name: "Keys", exact: true });
  await expect(keys).toBeVisible();
  await expect(keys.getByLabel("Key", { exact: true })).toHaveValue(key);
  await expect(keys.getByRole("combobox", { name: "Provider", exact: true })).toHaveText("OpenAI");
  await page.keyboard.press("Escape");
  await keys.getByRole("button", { name: "Discard" }).click();
  await expect(draft).toHaveValue("before  after");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Keys", exact: true }).click();
  await expect(keys.getByLabel("Key", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  expect(bodies).toHaveLength(1);
  expect(JSON.stringify(bodies)).not.toContain(key);
  expect(await page.evaluate(() => document.body.innerHTML)).not.toContain(key);
  expect(proof.sockets).toEqual([
    "/api/events",
    `/api/cells/${CELL}/status`,
    `/api/sessions/${SESSION}/stream`,
  ]);
  expect(
    await page.evaluate(() => (window as unknown as { layoutWorkers: unknown }).layoutWorkers),
  ).toEqual({ created: 1, retired: 0 });
  await page.screenshot({ path: info.outputPath("composer-phone-sample.png") });
  expect(proof.errors).toEqual([]);
  expect(proof.external).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { layoutCsp: unknown }).layoutCsp),
  ).toEqual([]);
});
