import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { choose, nestedKeys, roleCard, search, settingsSheet } from "./settings-ui.ts";
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
  const sheet = settingsSheet(page);
  await expect(sheet.getByText("All changes saved", { exact: true })).toBeVisible();
  return sheet;
}

const prompt = (sheet: Locator) =>
  sheet.getByRole("group", { name: "Discard unsaved changes?", includeHidden: true });

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

// A wide screen keeps an autonomy row's label and its three choices on one line; a phone puts the
// choices under the label, all three on one line.
async function expectAutonomyRow(sheet: Locator, wide: boolean) {
  const row = sheet.getByRole("radiogroup", { name: "Read and look" });
  await row.scrollIntoViewIfNeeded();
  const label = sheet.locator(".settings-autonomy-row").first().locator(".ui-field-label");
  const [text, control] = await Promise.all([label.boundingBox(), row.boundingBox()]);
  if (!text || !control) throw new Error("autonomy row missing");
  if (wide) {
    expect(Math.abs(text.y + text.height / 2 - (control.y + control.height / 2))).toBeLessThan(2);
    expect(control.x).toBeGreaterThan(text.x + text.width);
  } else {
    expect(control.y).toBeGreaterThanOrEqual(text.y + text.height);
  }
  const tops = await row
    .getByRole("radio")
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  const wrapped = await sheet
    .locator(".settings-autonomy-row > .ui-field-label, .settings-locked li > span")
    .evaluateAll((spans) =>
      spans.flatMap((span) =>
        span.getBoundingClientRect().height >
        1.5 * Number.parseFloat(getComputedStyle(span).lineHeight)
          ? [span.textContent]
          : [],
      ),
    );
  expect(wrapped).toEqual([]);
}

async function expectThemeTiles(sheet: Locator) {
  await expect(sheet.getByText("Change it in Settings")).toHaveCount(0);
  const graphite = sheet.getByRole("radio", { name: "Graphite" });
  expect(await graphite.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  const tile = sheet.locator('.appearance-swatch[data-appearance="graphite"]');
  expect(await tile.boundingBox()).toMatchObject({ width: 40, height: 28 });
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
      const model = roleCard(sheet, "main").getByRole("combobox", { name: "Model", exact: true });
      const before = await model.innerText();
      const target = before === "Claude Opus 5.5" ? "Claude Sonnet 5.5" : "Claude Opus 5.5";
      await choose(page, model, target, { tap: true });
      await expect(model).toHaveText(target);
      await expect(sheet.getByText("Unsaved changes", { exact: true })).toBeVisible();
      const save = sheet.getByRole("button", { name: "Save", exact: true });
      await background(page, () => expect(save).toBeDisabled());
      await expect(save).toBeEnabled();
      await expect(model).toHaveText(target);
      await expect(sheet.getByText("Unsaved changes", { exact: true })).toBeVisible();
      await save.tap();
      await expect(sheet.getByText(/^(Saved|All changes saved)$/)).toBeVisible();
      expect(puts).toHaveLength(1);
      expect(await savedModel()).toBe(
        target === "Claude Opus 5.5" ? "claude-opus-5-5" : "claude-sonnet-5-5",
      );
      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await expect(sheet).toBeHidden();
      await openSettings(page);
      await expect(model).toHaveText(target);
      await context.close();
    });

    test("a key saved after switching apps to copy it is listed and chosen", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      const main = roleCard(sheet, "main");
      await search(page, main.getByRole("combobox", { name: "Provider", exact: true }), "google");
      await choose(page, main.getByRole("combobox", { name: "Model", exact: true }), /./, {
        tap: true,
      });
      await main.getByRole("button", { name: "Add key", exact: true }).tap();
      const keys = nestedKeys(page);
      await expect(keys.getByRole("combobox", { name: "Provider" })).toHaveText("Google Gemini");
      const reread = page.waitForResponse((r) => r.url().endsWith("/api/agent/providers"));
      await background(page);
      await reread;
      const name = `copied-${engine}`;
      await keys.getByLabel("Label (optional)", { exact: true }).fill(name);
      await keys.getByLabel("Key", { exact: true }).fill(`AIza${"k".repeat(35)}`);
      await keys.getByRole("button", { name: "Save key" }).tap();
      await expect(keys.getByText(`Saved ${name}.`)).toBeVisible();
      await keys.getByRole("button", { name: "Settings", exact: true }).tap();
      await expect(keys).toHaveCount(0);
      await expect(main.getByRole("combobox", { name: "Key", exact: true })).toHaveText(name);
      await expect(sheet.getByText("Before you can save:")).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await context.close();
    });

    test("Escape from a picker keeps the sheet and the choice", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      const main = roleCard(sheet, "main");
      const model = main.getByRole("combobox", { name: "Model", exact: true });
      const saved = await model.innerText();
      const choice = saved === "Claude Opus 5.5" ? "Claude Sonnet 5.5" : "Claude Opus 5.5";
      await choose(page, model, choice, { tap: true });
      const provider = main.getByRole("combobox", { name: "Provider", exact: true });
      await provider.tap();
      await expect(provider).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(provider).toHaveAttribute("aria-expanded", "false");
      await expect(sheet).toBeVisible();
      await expect(prompt(sheet)).not.toHaveAttribute("data-shown", "");
      await expect(model).toHaveText(choice);
      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await expect(prompt(sheet)).toHaveAttribute("data-shown", "");
      await sheet.getByRole("button", { name: "Keep editing" }).tap();
      await expect(model).toHaveText(choice);
      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await sheet.getByRole("button", { name: "Discard" }).tap();
      await expect(sheet).toBeHidden();
      await openSettings(page);
      await expect(model).toHaveText(saved);

      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await expect(sheet).toBeHidden();
      await page.getByTestId("keys-button").tap();
      const keys = page.getByRole("dialog", { name: "Keys" });
      const keyProvider = keys.getByRole("combobox", { name: "Provider" });
      await search(page, keyProvider, "openai");
      await keyProvider.tap();
      await expect(keyProvider).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(keyProvider).toHaveAttribute("aria-expanded", "false");
      await expect(keys).toBeVisible();
      await expect(keyProvider).toHaveText("OpenAI");
      await context.close();
    });

    test("pickers and choices are tap-sized and never zoom the page", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      const main = roleCard(sheet, "main");
      for (const name of ["Provider", "Model", "Key"]) {
        const control = main.getByRole("combobox", { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        expect((await control.boundingBox())?.height, name).toBeGreaterThanOrEqual(44);
        const size = await control.evaluate((el) =>
          Number.parseFloat(getComputedStyle(el).fontSize),
        );
        expect(size, name).toBeGreaterThanOrEqual(16);
      }
      const segment = sheet
        .getByRole("radiogroup", { name: "Send as you" })
        .getByRole("radio", { name: "Ask me" });
      await segment.scrollIntoViewIfNeeded();
      expect((await segment.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      const provider = main.getByRole("combobox", { name: "Provider", exact: true });
      await provider.scrollIntoViewIfNeeded();
      await provider.tap();
      const searchField = page.getByRole("combobox", { name: "Search: Provider" });
      await expect(searchField).toBeVisible();
      const size = await searchField.evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).fontSize),
      );
      expect(size).toBeGreaterThanOrEqual(16);
      await page.getByRole("button", { name: "Close", exact: true }).tap();
      await expect(provider).toHaveAttribute("aria-expanded", "false");
      await sheet.getByRole("button", { name: "Close settings" }).tap();
      await expect(sheet).toBeHidden();
      await page.getByTestId("keys-button").tap();
      const keys = page.getByRole("dialog", { name: "Keys" });
      for (const control of [
        keys.getByRole("combobox", { name: "Provider" }),
        keys.getByRole("button", { name: "Remove weather" }),
        keys.getByRole("button", { name: "Save key" }),
      ]) {
        await control.scrollIntoViewIfNeeded();
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
      // Icon buttons draw small and take presses past their edge.
      for (const name of ["Close keys", "Paste key"]) {
        const reach = await keys
          .getByRole("button", { name })
          .evaluate(
            (el) =>
              el.getBoundingClientRect().height -
              2 * Number.parseFloat(getComputedStyle(el, "::after").top),
          );
        expect(reach, name).toBeGreaterThanOrEqual(44);
      }
      const key = keys.getByLabel("Key", { exact: true });
      expect(
        await key.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
      await context.close();
    });

    test("replay speed and export choices are tap-sized", async () => {
      const { context, page } = await phone(browser, `/?replay=${replayId}`);
      const speed = page.getByRole("combobox", { name: "Playback speed" });
      await speed.scrollIntoViewIfNeeded();
      expect((await speed.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await page.getByRole("button", { name: "Export video" }).tap();
      const exporter = page.getByRole("dialog", { name: "Export video" });
      for (const name of ["Range", "Speed"]) {
        const control = exporter.getByRole("radiogroup", { name });
        await control.scrollIntoViewIfNeeded();
        expect((await control.boundingBox())?.height, name).toBeGreaterThanOrEqual(44);
      }
      for (const name of ["Skip idle", "Captions"]) {
        const row = exporter.locator(".ui-choice").filter({ hasText: name });
        expect((await row.boundingBox())?.height, name).toBeGreaterThanOrEqual(44);
      }
      await context.close();
    });

    test("theme choices are preview tiles and autonomy choices sit under their labels down to 360", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSettings(page);
      await expectThemeTiles(sheet);
      const option = sheet.locator(".ui-radio-card").filter({ hasText: "Graphite" });
      expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await expectAutonomyRow(sheet, false);
      await page.setViewportSize({ width: 360, height: 780 });
      await expectAutonomyRow(sheet, false);
      // A row changed under the presets turns them to Custom without moving anything.
      await sheet.locator("#settings-autonomy").evaluate((section) => {
        const body = section.closest(".ui-sheet-body") as HTMLElement;
        body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
      });
      const browse = sheet.getByRole("radiogroup", { name: "Browse websites" });
      const before = (await browse.boundingBox())?.y;
      await browse.getByRole("radio", { name: "Ask me" }).tap();
      await expect(sheet.getByText("Custom: your own mix of choices.")).toBeVisible();
      expect((await browse.boundingBox())?.y).toBe(before);
      await context.close();
    });
  });

test("chrome at 1440: theme tiles, autonomy rows and pointer-sized pickers", async () => {
  const browser = await ENGINES.chrome();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/#token=${TOKEN}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sheet = settingsSheet(page);
  await expect(sheet.getByText("All changes saved", { exact: true })).toBeVisible();
  await expectThemeTiles(sheet);
  await expectAutonomyRow(sheet, true);
  // The inspector covers the bar's right end but for its top inset: nothing pressed shows there.
  const pressed = page.locator("header.bar").getByRole("button", { name: "Settings", exact: true });
  await expect(pressed).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(0, 450);
  expect(await pressed.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  const main = roleCard(sheet, "main");
  for (const name of ["Provider", "Model", "Key"]) {
    const height =
      (await main.getByRole("combobox", { name, exact: true }).boundingBox())?.height ?? 0;
    expect(height, name).toBeGreaterThanOrEqual(32);
    expect(height, name).toBeLessThan(44);
  }
  await sheet.getByRole("button", { name: "Show memory" }).click();
  const wells = sheet.locator(".settings-well");
  await expect(wells).toHaveCount(2);
  // Memory scrolls with the sheet's body, never in a box of its own.
  expect(await wells.evaluateAll((all) => all.map((el) => getComputedStyle(el).overflowY))).toEqual(
    ["visible", "visible"],
  );
  await browser.close();
});
