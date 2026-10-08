import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
  webkit,
} from "@playwright/test";

// Settings and Keys on a phone, in Chrome and in WebKit (Safari and Chrome on iOS), against the
// fixture daemon serving the built UI: run `pnpm --filter @localdot/web build` first.
const TOKEN = "a".repeat(43);
const ENGINES = {
  chrome: () => chromium.launch({ channel: "chrome" }),
  webkit: () => webkit.launch({ channel: undefined }),
};
let fixture: ChildProcess, origin: string, scratch: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("port")),
      );
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const port = Number(process.env.QA_PORT) || (await freePort());
  scratch = mkdtempSync(join(tmpdir(), "localdot-settings-phone-"));
  fixture = spawn(process.execPath, ["--import", "tsx", "e2e/fixtures/ui-server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, QA_PORT: String(port), QA_HOME: join(scratch, "home") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: fixture.stdout as NonNullable<typeof fixture.stdout> });
  origin = await new Promise<string>((resolve, reject) => {
    fixture.once("exit", (code) => reject(new Error(`fixture exited with ${code}`)));
    lines.on("line", (line) => {
      if (line.includes('"ready":true')) resolve((JSON.parse(line) as { origin: string }).origin);
    });
  });
});

test.afterAll(async () => {
  if (fixture && fixture.exitCode === null) {
    const exited = new Promise((resolve) => fixture.once("exit", resolve));
    fixture.kill("SIGTERM");
    await exited;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function phone(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${origin}/#token=${TOKEN}`);
  return { context, page };
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Models and settings" });
  await expect(sheet.getByText("Saved choices", { exact: true })).toBeVisible();
  return sheet;
}

// Playwright cannot switch apps, so hide and show the page the way the browser reports it.
async function background(page: Page) {
  const flip = (hidden: boolean) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await flip(true);
  await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
  await flip(false);
}

async function savedModel(): Promise<string | undefined> {
  const response = await fetch(`${origin}/api/agent/settings`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return ((await response.json()) as { main?: { model?: string } }).main?.model;
}

for (const [engine, launch] of Object.entries(ENGINES))
  test.describe(`${engine} at 390 with touch`, () => {
    let browser: Browser;
    test.beforeAll(async () => {
      browser = await launch();
    });
    test.afterAll(async () => {
      await browser?.close();
    });

    test("a model chosen before switching apps still saves, once", async () => {
      const { context, page } = await phone(browser);
      const puts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "PUT" && request.url().endsWith("/api/agent/settings"))
          puts.push(request.url());
      });
      const sheet = await openSettings(page);
      const model = sheet.getByRole("combobox", { name: "main model" });
      const before = await model.inputValue();
      const target = before === "claude-opus-5-5" ? "claude-sonnet-5-5" : "claude-opus-5-5";
      await model.selectOption(target);
      await expect(sheet.getByText("Unsaved choices", { exact: true })).toBeVisible();
      await background(page);
      const save = sheet.getByRole("button", { name: "Save settings" });
      await expect(save).toBeEnabled();
      await expect(model).toHaveValue(target);
      await expect(sheet.getByText("Unsaved choices", { exact: true })).toBeVisible();
      await save.tap();
      await expect(sheet.getByText("Saved choices", { exact: true })).toBeVisible();
      expect(puts).toHaveLength(1);
      expect(await savedModel()).toBe(target);
      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await expect(sheet).toBeHidden();
      await openSettings(page);
      await expect(model).toHaveValue(target);
      await context.close();
    });

    test("Escape after a select change keeps the sheet and the choice", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      const send = sheet.getByRole("combobox", { name: "Send messages" });
      const saved = await send.inputValue();
      const choice = saved === "handoff" ? "act" : "handoff";
      await send.focus();
      await send.selectOption(choice);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("Discard unsaved changes?")).toBeHidden();
      await expect(send).toHaveValue(choice);
      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await expect(sheet.getByText("Discard unsaved changes?")).toBeVisible();
      await sheet.getByRole("button", { name: "Keep editing" }).tap();
      await expect(send).toHaveValue(choice);
      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await sheet.getByRole("button", { name: "Discard" }).tap();
      await expect(sheet).toBeHidden();
      await openSettings(page);
      await expect(send).toHaveValue(saved);

      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await page.getByTestId("keys-button").tap();
      const keys = page.getByRole("dialog", { name: "Keys" });
      const provider = keys.getByRole("combobox", { name: "Provider" });
      await provider.focus();
      await provider.selectOption("openai");
      await page.keyboard.press("Escape");
      await expect(keys).toBeVisible();
      await expect(provider).toHaveValue("openai");
      await context.close();
    });

    test("selects and fields are tap-sized and never zoom the page", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      for (const name of ["main provider", "main model", "main key", "Send messages"]) {
        const control = sheet.getByRole("combobox", { name });
        await control.scrollIntoViewIfNeeded();
        expect((await control.boundingBox())?.height, name).toBeGreaterThanOrEqual(44);
        expect(await control.evaluate((el) => getComputedStyle(el).fontSize), name).toBe("16px");
      }
      const search = sheet.getByRole("searchbox", { name: "Search main providers" });
      expect(await search.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await page.getByTestId("keys-button").tap();
      const keys = page.getByRole("dialog", { name: "Keys" });
      for (const control of [
        keys.getByRole("combobox", { name: "Provider" }),
        keys.getByRole("button", { name: "Close keys" }),
        keys.getByRole("button", { name: "Remove weather" }),
        keys.getByRole("button", { name: "Save key" }),
      ]) {
        await control.scrollIntoViewIfNeeded();
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
      const key = keys.getByLabel("Key", { exact: true });
      expect(await key.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
      await context.close();
    });

    test("theme choices are preview tiles and autonomy rows sit on one line", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      await expect(sheet.getByText("Change it in Settings")).toHaveCount(0);
      const graphite = sheet.getByRole("radio", { name: "Graphite" });
      expect(await graphite.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
      const tile = sheet.locator(".appearance-tile.graphite");
      expect(await tile.boundingBox()).toMatchObject({ width: 20, height: 14 });
      const option = sheet.locator(".appearance-option").filter({ hasText: "Graphite" });
      expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      const row = sheet.locator(".safety-settings label").first();
      await row.scrollIntoViewIfNeeded();
      const [text, select] = await Promise.all([
        row.locator("span").boundingBox(),
        row.locator("select").boundingBox(),
      ]);
      if (!text || !select) throw new Error("autonomy row missing");
      expect(Math.abs(text.y + text.height / 2 - (select.y + select.height / 2))).toBeLessThan(2);
      expect(select.x).toBeGreaterThan(text.x + text.width);
      await context.close();
    });
  });
