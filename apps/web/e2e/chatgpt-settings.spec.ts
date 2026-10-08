import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexInstallState } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import type { CodexInstaller, InstalledCodex } from "../../../harness/codex/src/index.ts";
import {
  AccountError,
  type ChatgptLogin,
  type ChatgptStatus,
  type CodexAccount,
} from "../../daemon/src/agent/codex/account.ts";
import { MemoryStore } from "../../daemon/src/agent/memory.ts";
import { type AgentRoutesDeps, agentRoutes } from "../../daemon/src/agent/routes.ts";
import { SettingsStore } from "../../daemon/src/agent/settings.ts";
import { KeydUnavailableError } from "../../daemon/src/keyd/client.ts";
import { serveUi } from "../../daemon/src/static-ui.ts";
import { ENGINES, TOKEN as FIXTURE_TOKEN, startUiFixture, type UiFixture } from "./ui-fixture.ts";

// Real production bundle/CSP and accepted authenticated routes/private settings store. The
// installer/account are owned inert stand-ins; no binary, actual account or model is contacted.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const CELL = "01JXYZ0000000000000000ABCD",
  TOKEN = "a".repeat(43);
const CODE = "TEST-ONLY-DEVICE-CODE",
  DEVICE_URL = "https://auth.openai.com/codex/device";
test.setTimeout(30_000);
async function fixture(supported = true) {
  const home = mkdtempSync(join(tmpdir(), "localdot-account-browser-")),
    settings = new SettingsStore(home);
  settings.put({
    fast: { provider: "openai", model: "stored-paid", key: "deleted" },
    taskBudgetUSD: 8,
  });
  let install: CodexInstallState = { state: "not_installed" },
    login: ChatgptLogin | undefined,
    signedIn = false,
    blocked = false;
  let installFinish: ((result: InstalledCodex) => void) | undefined,
    installReject: ((error: Error) => void) | undefined;
  const counters = {
    installations: 0,
    accountReads: 0,
    logins: 0,
    cancels: 0,
    refreshes: 0,
    logouts: 0,
    modelStarts: 0,
    stops: 0,
  };
  const calls: { method: string; path: string; body: string }[] = [];
  const available = () => ({
    available: supported && !blocked,
    ...(supported && !blocked
      ? {}
      : { reason: "ChatGPT support is unavailable in this owned fixture." }),
  });
  const installed: InstalledCodex = {
    version: "0.154.0",
    platform: "darwin-arm64",
    binDir: join(home, "inert"),
    codexBin: join(home, "inert/codex"),
    codeModeHostBin: join(home, "inert/code-mode-host"),
  };
  const installer: CodexInstaller = {
    status: () => install,
    ensureInstalled: () => {
      counters.installations++;
      install = { state: "downloading", receivedBytes: 2048 };
      return new Promise((resolve, reject) => {
        installFinish = resolve;
        installReject = reject;
      });
    },
    verifiedInstallation: async () => undefined,
    cancel: () => {
      install = { state: "failed", code: "cancelled" };
      installReject?.(new Error("inert install cancelled"));
    },
  };
  const account: CodexAccount = {
    status: async () => {
      counters.accountReads++;
      const status: ChatgptStatus = {
        available: !blocked,
        codexVersion: "0.154.0",
        state: blocked
          ? "unavailable"
          : login
            ? "signing_in"
            : signedIn
              ? "signed_in"
              : "signed_out",
        ...(login ? { login } : {}),
        ...(signedIn && !blocked
          ? {
              account: { email: "preview@example.test", plan: "plus" },
              checkedAt: Date.now(),
              models: [
                { id: "fixture-account-model", name: "Reported sample model", isDefault: true },
              ],
              usage: {
                provider: "chatgpt",
                windows: [{ window: "primary", usedPercent: 23, windowMinutes: 300 }],
                limitReached: false,
              },
            }
          : {}),
      };
      return status;
    },
    login: async (method = "code") => {
      counters.logins++;
      expect(method).toBe("code");
      login = {
        loginId: `owned-${counters.logins}`,
        method: "code",
        verificationUrl: DEVICE_URL,
        userCode: CODE,
        startedAt: Date.now(),
      };
      return login;
    },
    cancelLogin: async () => {
      counters.cancels++;
      login = undefined;
    },
    logout: async () => {
      counters.logouts++;
      signedIn = false;
      login = undefined;
    },
    refresh: async () => {
      counters.refreshes++;
      if (blocked) throw new AccountError(503, "Account process could not be stopped.");
      return account.status();
    },
  };
  const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-04T00:00:00Z"),
    app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${TOKEN}`) return c.text("unauthorized", 401);
    await next();
  });
  app.get("/api/whoami", (c) => c.json({ ok: true }));
  app.get("/api/cells", (c) =>
    c.json([
      {
        id: CELL,
        state: "ready",
        scale: 2,
        createdAt: "2026-10-04T00:00:00Z",
        stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
      },
    ]),
  );
  app.get(`/api/cells/${CELL}/live`, (c) => c.body(null, 404));
  app.post(`/api/cells/${CELL}/stream-ticket`, (c) => c.text("owned fixture has no stream", 503));
  app.post(`/api/cells/${CELL}/stop`, (c) => {
    counters.stops++;
    return c.json({ revoked: true, paused: true, stopped: false, closed: true, errors: [] }, 202);
  });
  app.get("/api/keyd", (c) => c.text("owned key layer offline", 503));
  app.get("/api/keys", (c) => c.text("owned key layer offline", 503));
  const deps: AgentRoutesDeps = {
    settings,
    catalog: { get: () => catalog, refresh: async () => catalog },
    keyd: {
      secrets: async () => {
        throw new KeydUnavailableError("owned key layer offline", "/owned-fixture");
      },
    },
    runner: {
      get: () => undefined,
      start: async () => {
        counters.modelStarts++;
        throw new Error("No model run is authorized");
      },
      raiseBudget: async () => {
        throw new Error("No budget change is authorized");
      },
    },
    memory: new MemoryStore(home),
    skills: () => [],
    desktop: () => undefined,
    home,
    redactUserText: (text) => text,
    appendTo: () => {
      throw new Error("No task event expected");
    },
    harness: available,
    chatgpt: { account, installer, availability: available },
  };
  agentRoutes(app, deps);
  serveUi(app, fileURLToPath(new URL("../dist", import.meta.url)));
  let origin = "";
  const server: Server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw new Error("fixture body bound");
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8"),
        path = new globalThis.URL(req.url ?? "/", origin).pathname;
      if (path.startsWith("/api/")) calls.push({ method: req.method ?? "GET", path, body });
      const response = await app.fetch(
        new Request(`${origin}${req.url ?? "/"}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(body ? { body } : {}),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end("owned fixture response failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("owned listener missing");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    counters,
    calls,
    settings,
    verifying: () => {
      install = { state: "verifying" };
    },
    ready: () => {
      install = { state: "ready", version: "0.154.0" };
      installFinish?.(installed);
    },
    completeLogin: () => {
      login = undefined;
      signedIn = true;
    },
    failRetirement: () => {
      blocked = true;
    },
    close: async () => {
      installer.cancel();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(home, { recursive: true, force: true });
      expect(server.listening).toBe(false);
    },
  };
}
async function load(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  const errors: string[] = [],
    logs: string[] = [],
    external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => logs.push(message.text()));
  await page.unroute("**/*");
  await page.route("**/*", (route) => {
    if (new globalThis.URL(route.request().url()).origin === f.origin) return route.fallback();
    external.push(route.request().url());
    return route.abort();
  });
  await page.routeWebSocket("**/*", (socket) => {
    expect(new globalThis.URL(socket.url()).pathname).toBe(`/api/cells/${CELL}/status`);
    socket.send(
      JSON.stringify({
        id: CELL,
        state: "ready",
        scale: 2,
        createdAt: "2026-10-04T00:00:00Z",
        stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
      }),
    );
  });
  await page.addInitScript(() => {
    localStorage.setItem("localdot.token", "a".repeat(43));
    Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
      value: undefined,
      configurable: true,
    });
    const csp: string[] = [];
    Object.defineProperty(window, "accountCsp", { value: csp, configurable: true });
    document.addEventListener("securitypolicyviolation", (event) =>
      csp.push(event.effectiveDirective),
    );
  });
  await page.goto(f.origin);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Models and settings" });
  await expect(sheet.getByRole("combobox", { name: "main provider", exact: true })).toBeEnabled();
  await sheet.getByRole("combobox", { name: "main provider", exact: true }).selectOption("chatgpt");
  return { sheet, errors, logs, external };
}
for (const width of [1280, 390])
  test(`explicit installation and account model save with offline paid keys at ${width}px`, async ({
    page,
  }, info) => {
    const f = await fixture();
    try {
      await page.setViewportSize({ width, height: 900 });
      const audit = await load(page, f),
        sheet = audit.sheet;
      await expect(
        sheet.getByRole("button", { name: "Install ChatGPT support", exact: true }),
      ).toBeEnabled();
      expect(f.counters.installations).toBe(0);
      expect(f.counters.accountReads).toBe(0);
      expect(f.counters.logins).toBe(0);
      await sheet.getByRole("button", { name: "Install ChatGPT support", exact: true }).click();
      await expect(
        sheet.getByRole("progressbar", { name: "ChatGPT download progress" }),
      ).toBeVisible();
      expect(f.counters.installations).toBe(1);
      f.verifying();
      await expect(sheet.getByText("Verifying ChatGPT support…")).toBeVisible();
      f.ready();
      await expect(
        sheet.getByRole("button", { name: "Sign in with code", exact: true }),
      ).toBeEnabled();
      expect(f.counters.logins).toBe(0);
      await sheet.getByRole("button", { name: "Sign in with code", exact: true }).click();
      await expect(sheet.getByLabel("Sign-in code")).toHaveValue(CODE);
      await expect(sheet.getByLabel("Sign-in page")).toHaveValue(DEVICE_URL);
      expect(
        f.calls
          .filter((call) => call.path.endsWith("/login") && call.method === "POST")
          .map((call) => call.body),
      ).toEqual(['{"method":"code"}']);
      f.completeLogin();
      await expect(sheet.getByText("Signed in as preview@example.test")).toBeVisible();
      await expect(sheet.getByLabel("Sign-in code")).toHaveValue("");
      await expect(sheet.getByText(/Primary window: 23% used/)).toBeVisible();
      await expect(sheet.getByText(/Secondary window: Unknown/)).toBeVisible();
      await sheet
        .getByRole("combobox", { name: "main model", exact: true })
        .selectOption("fixture-account-model");
      await expect(sheet.getByRole("button", { name: "Save settings", exact: true })).toBeEnabled();
      expect(await sheet.getByRole("combobox", { name: "fast key" }).count()).toBe(0);
      expect(await sheet.getByRole("group", { name: "Task spending ceiling" }).count()).toBe(0);
      await sheet.getByRole("button", { name: "Save settings", exact: true }).click();
      await expect(sheet.getByText("Saved choices", { exact: true })).toBeVisible();
      expect(f.settings.get()).toEqual({
        main: { provider: "chatgpt", model: "fixture-account-model" },
        fast: { provider: "openai", model: "stored-paid", key: "deleted" },
        taskBudgetUSD: 8,
      });
      await sheet.locator(".settings-body").evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({ path: info.outputPath(`chatgpt-settings-${width}.png`) });
      await sheet.getByRole("button", { name: "Close settings" }).click();
      if (width < 1180) await page.getByRole("tab", { name: "Conversation", exact: true }).click();
      await page.getByLabel("New task").fill("Prepare the synthetic report when I start it.");
      await expect(page.getByRole("button", { name: "Start task", exact: true })).toBeEnabled();
      expect(f.counters.modelStarts).toBe(0);
      expect(audit.errors).toEqual([]);
      expect(audit.external).toEqual([]);
      expect(audit.logs.join("\n")).not.toContain(CODE);
      expect(f.calls.every((call) => !call.body.includes(CODE))).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { accountCsp: string[] }).accountCsp),
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => Object.values(localStorage).join("\n") + Object.values(sessionStorage).join("\n"),
        ),
      ).not.toMatch(/TEST-ONLY-DEVICE-CODE|auth.openai.com/);
    } finally {
      await page.close();
      await f.close();
    }
  });
test("unsupported capability and an uncertain account retirement keep admission closed while Stop remains reachable", async ({
  page,
}) => {
  const unsupported = await fixture(false);
  try {
    const audit = await load(page, unsupported);
    await expect(
      audit.sheet.getByText("ChatGPT support is unavailable in this owned fixture."),
    ).toBeVisible();
    expect(await audit.sheet.getByRole("button", { name: "Install ChatGPT support" }).count()).toBe(
      0,
    );
    expect(unsupported.counters.installations).toBe(0);
    expect(unsupported.counters.accountReads).toBe(0);
  } finally {
    await unsupported.close();
  }
  const f = await fixture();
  try {
    f.ready();
    f.completeLogin();
    const audit = await load(page, f),
      sheet = audit.sheet;
    await expect(sheet.getByRole("button", { name: "Refresh account", exact: true })).toBeEnabled();
    await sheet.getByRole("button", { name: "Refresh account", exact: true }).click();
    expect(f.counters.refreshes).toBe(0);
    await expect(sheet.getByRole("alertdialog")).toContainText("pauses current ChatGPT work");
    f.failRetirement();
    await sheet.getByRole("button", { name: "Pause work and refresh" }).click();
    await expect(sheet.getByRole("alert")).toContainText("New ChatGPT tasks are blocked");
    await sheet.getByRole("button", { name: "Stop computer", exact: true }).click();
    await expect.poll(() => f.counters.stops).toBe(1);
    expect(f.counters.modelStarts).toBe(0);
  } finally {
    await page.close();
    await f.close();
  }
});

// The same states on the fixture daemon, which serves the built UI through the real agent routes.
const VIEWS = [
  { name: "c14", engine: "chrome", viewport: { width: 1440, height: 900 } },
  { name: "w14", engine: "webkit", viewport: { width: 1440, height: 900 } },
  { name: "w39", engine: "webkit", viewport: { width: 390, height: 844 }, phone: true },
] as const;
const DEVICE_HINT = "Turn on device code sign-in in ChatGPT under Settings → Security first.";
test.describe("ChatGPT plan states on the fixture daemon", () => {
  let daemon: UiFixture;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    daemon = await startUiFixture("localdot-chatgpt-states", {
      QA_CHATGPT: "unavailable",
      QA_SETTINGS: "chatgpt",
    });
  });
  test.afterAll(async () => {
    await daemon?.stop();
  });
  async function each(
    state: "unavailable" | "not_installed" | "signed_out" | "signed_in",
    check: (panel: Locator, page: Page, view: (typeof VIEWS)[number]) => Promise<void>,
  ) {
    for (const view of VIEWS) {
      const reset = await fetch(`${daemon.origin}/__qa/chatgpt/${state}`, { method: "POST" });
      expect(reset.status).toBe(200);
      const browser: Browser = await ENGINES[view.engine]();
      try {
        const page = await browser.newPage({
          viewport: view.viewport,
          deviceScaleFactor: 2,
          ...("phone" in view ? { isMobile: true, hasTouch: true } : {}),
        });
        await page.goto(`${daemon.origin}/#token=${FIXTURE_TOKEN}`);
        const settings = page.getByRole("button", { name: "Settings", exact: true });
        if ("phone" in view) await settings.tap();
        else await settings.click();
        const sheet = page.getByRole("dialog", { name: "Models and settings" });
        const panel = sheet.locator(".chatgpt-panel");
        await expect(panel.getByRole("heading", { name: "ChatGPT plan" })).toBeVisible();
        await check(panel, page, view);
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: test.info().outputPath(`chatgpt-${state}-${view.name}.png`),
        });
      } finally {
        await browser.close();
      }
    }
  }
  test("an unavailable plan says why and offers no install", async () => {
    await each("unavailable", async (panel) => {
      await expect(
        panel.getByText("ChatGPT plan support isn't switched on in this version yet."),
      ).toBeVisible();
      await expect(panel.getByRole("button", { name: "Install ChatGPT support" })).toHaveCount(0);
      await expect(panel.getByText(/daemon|harness/i)).toHaveCount(0);
    });
  });
  test("installing ChatGPT support leads to sign-in with a code and the device code hint", async () => {
    await each("not_installed", async (panel, page, view) => {
      const install = panel.getByRole("button", { name: "Install ChatGPT support", exact: true });
      await expect(install).toBeEnabled();
      if ("phone" in view) await install.tap();
      else await install.click();
      await expect(
        panel.getByRole("progressbar", { name: "ChatGPT download progress" }),
      ).toBeVisible();
      const signIn = panel.getByRole("button", { name: "Sign in with code", exact: true });
      await expect(signIn).toBeEnabled({ timeout: 15_000 });
      const hint = panel.getByText(DEVICE_HINT);
      await expect(hint).toBeVisible();
      const [above, button] = await Promise.all([hint.boundingBox(), signIn.boundingBox()]);
      expect(above && button && above.y + above.height <= button.y).toBe(true);
      if ("phone" in view) expect(button?.height).toBeGreaterThanOrEqual(44);
      await expect(page.getByText(/daemon|harness/i)).toHaveCount(0);
    });
  });
  test("a code start that fails asks for device code sign-in and a retry works", async () => {
    const deviceCode = async (mode: "on" | "off") =>
      expect(
        (await fetch(`${daemon.origin}/__qa/chatgpt/device-code/${mode}`, { method: "POST" }))
          .status,
      ).toBe(200);
    try {
      await each("signed_out", async (panel, page, view) => {
        await deviceCode("off");
        const signIn = panel.getByRole("button", { name: "Sign in with code", exact: true });
        const press = async () => ("phone" in view ? signIn.tap() : signIn.click());
        await expect(signIn).toBeEnabled();
        await press();
        await expect(panel.getByRole("alert")).toHaveText(DEVICE_HINT);
        await expect(panel.getByText(DEVICE_HINT)).toHaveCount(1);
        await expect(signIn).toBeEnabled();
        await expect(panel.getByRole("button", { name: "Cancel sign-in" })).toHaveCount(0);
        if ("phone" in view)
          expect((await signIn.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        await expect(panel.getByText(/blocked|could not be safely/i)).toHaveCount(0);
        await expect(page.getByText(/daemon|harness/i)).toHaveCount(0);
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: test.info().outputPath(`chatgpt-code-refused-${view.name}.png`),
        });
        await deviceCode("on");
        await press();
        await expect(panel.getByLabel("Sign-in code")).toHaveValue("TEST-ONLY");
        await expect(panel.getByRole("alert")).toHaveCount(0);
      });
    } finally {
      await deviceCode("on");
    }
  });
  test("a signed-in plan shows the account and its usage", async () => {
    await each("signed_in", async (panel) => {
      await expect(panel.getByText("Signed in as preview@example.test")).toBeVisible();
      await expect(panel.getByText(/Primary window: 23% used/)).toBeVisible();
      await expect(panel.getByText(DEVICE_HINT)).toHaveCount(0);
    });
  });
});
