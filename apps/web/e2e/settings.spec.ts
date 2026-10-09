import { webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindingJson,
  fromBase64url,
  type KeydRecord,
  SEAL_INFO,
  SealedSecret,
  toBase64url,
} from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { expect, type Page, test } from "@playwright/test";
import { MemoryStore } from "../../daemon/src/agent/memory.ts";
import { type AgentRoutesDeps, agentRoutes } from "../../daemon/src/agent/routes.ts";
import { SettingsStore } from "../../daemon/src/agent/settings.ts";
import { serveUi } from "../../daemon/src/static-ui.ts";
import { closeSettings, nestedKeys, roleCard, search, settingsSheet } from "./settings-ui.ts";
import { skipSetup } from "./skip-setup.ts";

// Production UI/CSP, real settings routes/private store and real browser ECDH/AES-GCM. The
// computer, keyd metadata and catalog are owned stand-ins; no model/account/shared service runs.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const CELL = "01JXYZ0000000000000000ABCD",
  TOKEN = "a".repeat(43);
const SECRET = "fixture-private-value-for-browser-sealing";
const at = "2026-10-03T00:00:00Z";
let home: string, settings: SettingsStore, server: Server, origin: string;
let keys: KeydRecord[] = [],
  calls: { method: string; path: string; body: string }[] = [];
test.setTimeout(45_000);
test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "localdot-settings-browser-"));
  settings = new SettingsStore(home);
  const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, at),
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
        createdAt: at,
        stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
      },
    ]),
  );
  app.get(`/api/cells/${CELL}/live`, (c) => c.body(null, 404));
  app.post(`/api/cells/${CELL}/stream-ticket`, (c) => c.text("owned fixture has no stream", 503));
  app.get("/api/keyd", (c) =>
    c.json({
      online: true,
      bootId: "owned-fixture",
      sealKey: toBase64url(publicRaw),
      audit: { ok: true },
      hairpin: { state: "active", addresses: 1 },
    }),
  );
  app.get("/api/keys", (c) => c.json({ keys }));
  app.post("/api/keys", async (c) => {
    const raw = await c.req.text();
    expect(raw).not.toContain(SECRET);
    const { binding, sealed } = SealedSecret.parse(JSON.parse(raw));
    const ephemeralRaw = fromBase64url(sealed.epk);
    const ephemeral = await webcrypto.subtle.importKey(
      "raw",
      ephemeralRaw,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const shared = await webcrypto.subtle.deriveBits(
      { name: "ECDH", public: ephemeral },
      pair.privateKey,
      256,
    );
    const hkdf = await webcrypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const salt = new Uint8Array(ephemeralRaw.length + publicRaw.length);
    salt.set(ephemeralRaw);
    salt.set(publicRaw, ephemeralRaw.length);
    const aes = await webcrypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(SEAL_INFO) },
      hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plain = new Uint8Array(
      await webcrypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64url(sealed.nonce),
          additionalData: new TextEncoder().encode(`${SEAL_INFO}:${bindingJson(binding)}`),
        },
        aes,
        fromBase64url(sealed.ct),
      ),
    );
    try {
      expect(new TextDecoder().decode(plain)).toBe(SECRET);
    } finally {
      plain.fill(0);
    }
    const key = { ...binding, createdAt: at, updatedAt: at };
    keys.push(key);
    return c.json({ key, restart: false });
  });
  const deps: AgentRoutesDeps = {
    settings,
    catalog: { get: () => catalog, refresh: async () => catalog },
    keyd: {
      secrets: async () => keys,
      budget: async () => ({
        perTaskUSD: 2,
        perDayUSD: 20,
        day: { date: "2026-10-03", spentUSD: 0 },
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
  serveUi(app, fileURLToPath(new URL("../dist", import.meta.url)));
  server = createServer(async (req, res) => {
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 64 * 1024) throw new Error("fixture request limit");
        parts.push(Buffer.from(part));
      }
      const body = Buffer.concat(parts).toString("utf8"),
        path = new URL(req.url ?? "/", origin).pathname;
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
});
test.beforeEach(() => {
  settings.put({});
  keys = [];
  calls = [];
});
test.afterAll(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (home) rmSync(home, { recursive: true, force: true });
  expect(server?.listening).toBe(false);
});
async function load(page: Page) {
  const errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    external.push(route.request().url());
    return route.abort();
  });
  await page.routeWebSocket("**/*", (ws) => {
    const path = new URL(ws.url()).pathname;
    // The app-wide events socket (routines, attention) stays open and quiet.
    if (path === "/api/events") return;
    if (path !== `/api/cells/${CELL}/status`) throw new Error("unexpected settings socket");
    ws.send(
      JSON.stringify({
        id: CELL,
        state: "ready",
        scale: 2,
        createdAt: at,
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
    Object.defineProperty(window, "settingsCsp", { value: csp });
    document.addEventListener("securitypolicyviolation", (event) =>
      csp.push(event.effectiveDirective),
    );
  });
  await skipSetup(page);
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "Choose…" })).toBeEnabled();
  return { errors, external };
}
for (const width of [1280, 390])
  test(`sealed configuration and nested Keys ownership at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const audit = await load(page);
    const draft = page.getByLabel("New task");
    await draft.fill("Prepare a sample report later.");
    await draft.press("Enter");
    const sheet = settingsSheet(page);
    await expect(sheet).toBeVisible();
    // One inspector over the page, which waits under it.
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    const main = roleCard(sheet, "main");
    const provider = main.getByRole("combobox", { name: "Provider", exact: true });
    try {
      await expect(provider).toBeVisible();
    } catch (failure) {
      await page.screenshot({ path: info.outputPath("settings-before-key-diagnostic.png") });
      await info.attach("settings-before-key-diagnostic", {
        body: JSON.stringify({
          text: await page.locator("body").innerText(),
          audit,
          calls,
        }),
        contentType: "application/json",
      });
      throw failure;
    }
    await search(page, provider, "openai-compatible");
    await expect(provider).toHaveText("Other (OpenAI-compatible)");
    const custom = main.getByRole("textbox", { name: "Model ID", exact: true });
    await custom.fill("fixture-custom");
    await custom.press("-");
    await custom.press("x");
    await expect(custom).toBeFocused();
    await expect(custom).toHaveValue("fixture-custom-x");
    const input = main.getByRole("textbox", { name: "Input price", exact: true }),
      output = main.getByRole("textbox", { name: "Output price", exact: true });
    await expect(input).toHaveValue("");
    await expect(output).toHaveValue("");
    await main.getByRole("button", { name: "Add key", exact: true }).click();
    // Keys is a section of Settings: on the same page beside a wide screen, pushed on a phone.
    const keySheet = nestedKeys(page);
    await expect(keySheet.getByRole("combobox", { name: "Provider" })).toHaveText(
      "OpenAI-compatible",
    );
    await keySheet.getByLabel("Label (optional)", { exact: true }).fill("fixture-gateway");
    await keySheet.getByLabel("Base URL", { exact: true }).fill("https://example.test/v1");
    await keySheet.getByLabel("Key", { exact: true }).fill(SECRET);
    await keySheet.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(keySheet.getByLabel("Key", { exact: true })).toHaveValue("");
    await expect(keySheet.getByRole("status")).toContainText("Saved fixture-gateway.");
    if (width < 700) {
      await sheet.getByRole("button", { name: "Models", exact: true }).click();
      await expect(keySheet).toBeHidden();
    }
    await expect(main.getByRole("combobox", { name: "Key", exact: true })).toHaveText(
      "fixture-gateway",
    );
    await expect(custom).toHaveValue("fixture-custom-x");
    // Changes save themselves once they can be, and a model with no price can't be.
    const problems = sheet.getByRole("status").filter({ hasText: "Before this can be saved:" });
    await expect(problems).toBeVisible();
    await input.fill("0");
    await expect(problems).toBeVisible();
    await output.fill("0");
    await expect(problems).toBeVisible();
    expect(settings.get()).toEqual({});
    await output.fill("2");
    await expect(problems).toBeHidden();
    await expect
      .poll(() => settings.get())
      .toEqual({
        main: {
          provider: "openai-compatible",
          model: "fixture-custom-x",
          key: "fixture-gateway",
          price: { inputUSDPerMTok: 0, outputUSDPerMTok: 2 },
        },
      });
    await input.scrollIntoViewIfNeeded();
    const heading = await sheet.locator(".ui-sheet-header").boundingBox(),
      field = await input.boundingBox();
    expect(heading).not.toBeNull();
    expect(field).not.toBeNull();
    expect(field?.y).toBeGreaterThanOrEqual((heading?.y ?? 0) + (heading?.height ?? 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 1280)
      await sheet.locator(".ui-sheet-body").evaluate((body) => {
        body.scrollTop = 0;
      });
    await page.screenshot({ path: info.outputPath(`settings-${width}-sample.png`) });
    await closeSettings(page);
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue("Prepare a sample report later.");
    await expect(page.getByRole("button", { name: "Start task", exact: true })).toBeEnabled();
    expect(
      calls.filter((c) => c.method === "PUT" && c.path === "/api/agent/settings"),
    ).toHaveLength(1);
    expect(
      calls
        .filter((c) => c.method === "POST" && !c.path.endsWith("/stream-ticket"))
        .map((c) => c.path),
    ).toEqual(["/api/keys"]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(JSON.stringify(keys)).not.toContain(SECRET);
    expect(audit.errors).toEqual([]);
    expect(audit.external).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { settingsCsp: string[] }).settingsCsp),
    ).toEqual([]);
  });
