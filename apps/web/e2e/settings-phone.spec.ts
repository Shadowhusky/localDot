import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

// Settings and Keys on a phone, in Chrome and in WebKit (Safari and Chrome on iOS), and in Chrome
// at desktop width, against the fixture daemon serving the built UI.
let fixture: UiFixture, origin: string, replayId: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixture = await startUiFixture("localdot-settings-phone");
  origin = fixture.origin;
  replayId = fixture.seeded[0] as string;
});

test.afterAll(async () => {
  await fixture?.stop();
});

async function phone(
  browser: Browser,
  path = "/",
  init?: () => void,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto(`${origin}${path}#token=${TOKEN}`);
  return { context, page };
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Models and settings" });
  await expect(sheet.getByText("Saved choices", { exact: true })).toBeVisible();
  return sheet;
}

// Playwright cannot switch apps, so hide and show the page the way the browser reports it.
async function background(page: Page, whileHidden?: () => Promise<void>) {
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
  await whileHidden?.();
  await flip(false);
}

async function expectAutonomyRow(sheet: Locator) {
  const row = sheet.locator(".safety-settings label").first();
  await row.scrollIntoViewIfNeeded();
  const [text, select] = await Promise.all([
    row.locator("span").boundingBox(),
    row.locator("select").boundingBox(),
  ]);
  if (!text || !select) throw new Error("autonomy row missing");
  expect(Math.abs(text.y + text.height / 2 - (select.y + select.height / 2))).toBeLessThan(2);
  expect(select.x).toBeGreaterThan(text.x + text.width);
}

async function expectThemeTiles(sheet: Locator) {
  await expect(sheet.getByText("Change it in Settings")).toHaveCount(0);
  const graphite = sheet.getByRole("radio", { name: "Graphite" });
  expect(await graphite.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  const tile = sheet.locator(".appearance-tile.graphite");
  expect(await tile.boundingBox()).toMatchObject({ width: 20, height: 14 });
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
      const save = sheet.getByRole("button", { name: "Save settings" });
      await background(page, () => expect(save).toBeDisabled());
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

    test("a key saved after switching apps to copy it is listed and chosen", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      await sheet.getByRole("combobox", { name: "main provider" }).selectOption("google");
      const model = sheet.getByRole("combobox", { name: "main model" });
      const first = model.locator("option:not([disabled]):not([value=''])").first();
      await model.selectOption((await first.getAttribute("value")) as string);
      await sheet.getByRole("button", { name: "Add key for main" }).tap();
      const keys = page.getByRole("dialog", { name: "Keys" });
      await expect(keys.getByRole("combobox", { name: "Provider" })).toHaveValue("google");
      const reread = page.waitForResponse((r) => r.url().endsWith("/api/agent/providers"));
      await background(page);
      await reread;
      const name = `copied-${engine}`;
      await keys.getByLabel("Name", { exact: true }).fill(name);
      await keys.getByLabel("Key", { exact: true }).fill(`AIza${"k".repeat(35)}`);
      await keys.getByRole("button", { name: "Save key" }).tap();
      await expect(keys.getByText(`Saved ${name}.`)).toBeVisible();
      await keys.getByRole("button", { name: "Close keys" }).tap();
      await expect(sheet.getByRole("combobox", { name: "main key" })).toHaveValue(name);
      await expect(sheet.locator("#settings-problems")).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: "Save settings" })).toBeEnabled();
      await context.close();
    });

    test("Escape after a select change keeps the sheet and the choice", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      const send = sheet.getByRole("combobox", { name: "Send as you" });
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
      for (const name of ["main provider", "main model", "main key", "Send as you"]) {
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

    test("replay speed and export choices are tap-sized", async () => {
      // WebKit has no save picker, so Export stays off there; lend it one to reach the sheet.
      const { context, page } = await phone(browser, `/?replay=${replayId}`, () =>
        Object.assign(window, { showSaveFilePicker: () => Promise.reject(new Error("unused")) }),
      );
      const speed = page.getByRole("combobox", { name: "Playback speed" });
      await speed.scrollIntoViewIfNeeded();
      expect((await speed.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await page.getByRole("button", { name: "Export MP4" }).tap();
      const exporter = page.getByRole("dialog", { name: "Export MP4" });
      for (const name of ["Export range", "Export speed", "Export size"]) {
        const control = exporter.getByRole("combobox", { name });
        await control.scrollIntoViewIfNeeded();
        expect((await control.boundingBox())?.height, name).toBeGreaterThanOrEqual(44);
        expect(await control.evaluate((el) => getComputedStyle(el).fontSize), name).toBe("16px");
      }
      await context.close();
    });

    test("theme choices are preview tiles and autonomy rows sit on one line", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      await expectThemeTiles(sheet);
      const option = sheet.locator(".appearance-option").filter({ hasText: "Graphite" });
      expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await expectAutonomyRow(sheet);
      await context.close();
    });
  });

test("chrome at 1440: theme tiles, autonomy rows and pointer-sized selects", async () => {
  const browser = await ENGINES.chrome();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/#token=${TOKEN}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Models and settings" });
  await expect(sheet.getByText("Saved choices", { exact: true })).toBeVisible();
  await expectThemeTiles(sheet);
  await expectAutonomyRow(sheet);
  for (const name of ["main provider", "main model", "main key", "Send as you"]) {
    const height = (await sheet.getByRole("combobox", { name }).boundingBox())?.height ?? 0;
    expect(height, name).toBeGreaterThanOrEqual(32);
    expect(height, name).toBeLessThan(44);
  }
  await browser.close();
});
