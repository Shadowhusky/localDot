import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { reach } from "./reach.ts";
import {
  choose,
  closeSettings,
  nestedKeys,
  openSettings,
  roleCard,
  search,
  settingsSheet,
} from "./settings-ui.ts";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

// Settings and Keys on a phone, in Chrome and in WebKit (Safari and Chrome on iOS), and in Chrome
// at desktop width, against the fixture daemon serving the built UI.
let fixture: UiFixture, origin: string, replayId: string, initial: string;

const settingsApi = (init: RequestInit = {}) =>
  fetch(`${origin}/api/agent/settings`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixture = await startUiFixture("localdot-settings-phone");
  origin = fixture.origin;
  replayId = fixture.seeded[0] as string;
  initial = await (await settingsApi()).text();
});

// Settings saves itself, so each test starts from the fixture's own settings again.
test.beforeEach(async () => {
  const reset = await settingsApi({ method: "PUT", body: initial });
  expect(reset.ok, await reset.text()).toBe(true);
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

const tap = (target: Locator) => target.tap();

// A phone's Settings: from More, into one section, once the saved settings are in.
async function openSection(page: Page, name = "Models") {
  const sheet = await openSettings(page, tap, name);
  if (name === "Models")
    await expect(
      roleCard(sheet, "main").getByRole("combobox", { name: "Model", exact: true }),
    ).toBeVisible();
  return sheet;
}

// From one section of a phone's Settings to another, through the list of them.
async function section(sheet: Locator, name: string) {
  await sheet.getByRole("button", { name: "Settings", exact: true }).tap();
  await sheet.getByRole("button", { name: new RegExp(`^${name}`) }).tap();
}

// The per-action choices sit under the presets, behind a disclosure.
async function eachAction(sheet: Locator, press: (target: Locator) => Promise<void> = tap) {
  const more = sheet.getByRole("button", { name: "Choose for each kind of action" });
  if ((await more.getAttribute("aria-expanded")) !== "true") await press(more);
}

// Keys from More, with its form for a new key open.
async function openKeys(page: Page) {
  await page.getByRole("button", { name: "More", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Keys", exact: true }).tap();
  const keys = nestedKeys(page);
  await keys.getByRole("button", { name: /^Add (a )?key$/ }).tap();
  return keys;
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

// A wide screen keeps an autonomy row's label and its three choices on one line; a phone puts the
// choices under the label, all three on one line. A fixed choice's mode never wraps; on the
// narrowest phone its label may.
async function expectAutonomyRow(sheet: Locator, wide: boolean, narrow = false) {
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
    .locator(
      narrow
        ? ".settings-autonomy-row > .ui-field-label, .settings-locked-mode"
        : ".settings-autonomy-row > .ui-field-label, .settings-locked li > span",
    )
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
  // A mini preview of the theme, wider than it is tall.
  const tile = await sheet.locator('.appearance-swatch[data-appearance="graphite"]').boundingBox();
  expect(tile?.height).toBeGreaterThanOrEqual(28);
  expect(tile?.width).toBeGreaterThan(tile?.height ?? Number.POSITIVE_INFINITY);
}

async function savedMain(): Promise<{ model?: string; key?: string } | undefined> {
  const response = await fetch(`${origin}/api/agent/settings`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return ((await response.json()) as { main?: { model?: string; key?: string } }).main;
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

    test("a model chosen before switching apps saves itself, once", async () => {
      const { context, page } = await phone(browser);
      const puts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "PUT" && request.url().endsWith("/api/agent/settings"))
          puts.push(request.url());
      });
      const sheet = await openSection(page);
      const model = roleCard(sheet, "main").getByRole("combobox", { name: "Model", exact: true });
      const before = await model.innerText();
      const target = before === "Claude Opus 5.5" ? "Claude Sonnet 5.5" : "Claude Opus 5.5";
      await choose(page, model, target, { tap: true });
      await expect(model).toHaveText(target);
      await background(page, () => expect(model).toHaveText(target));
      await expect(model).toHaveText(target);
      const id = target === "Claude Opus 5.5" ? "claude-opus-5-5" : "claude-sonnet-5-5";
      await expect.poll(async () => (await savedMain())?.model).toBe(id);
      // Well past the half second a change waits before it saves itself, it saved only once.
      await page.waitForTimeout(1000);
      expect(puts).toHaveLength(1);
      await closeSettings(page);
      await openSection(page);
      await expect(model).toHaveText(target);
      await context.close();
    });

    test("a key saved after switching apps to copy it is listed and chosen", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSection(page);
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
      // Keys is pushed over Models, which Back returns to with the new key chosen.
      await sheet.getByRole("button", { name: "Models", exact: true }).tap();
      await expect(keys).toHaveCount(0);
      await expect(main.getByRole("combobox", { name: "Key", exact: true })).toHaveText(name);
      await expect(sheet.getByText("Before this can be saved:")).toHaveCount(0);
      await expect.poll(async () => (await savedMain())?.key).toBe(name);
      await context.close();
      // The fixture's keys outlive the test; the next engine starts with no Google key again.
      const removed = await fetch(`${origin}/api/keys/${name}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(removed.ok).toBe(true);
    });

    test("Escape from a picker keeps the sheet and the choice", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSection(page);
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
      await expect(model).toHaveText(choice);
      // Closing waits for the change on its way, so the sheet opened again shows it kept.
      await closeSettings(page);
      await openSection(page);
      await expect(model).toHaveText(choice);
      await closeSettings(page);

      const keys = await openKeys(page);
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
      const sheet = await openSection(page);
      const main = roleCard(sheet, "main");
      for (const name of ["Provider", "Model", "Key"]) {
        const control = main.getByRole("combobox", { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        // An inline picker draws as its value and takes a finger past its edge.
        expect((await control.evaluate(reach)).height, name).toBe(44);
        const size = await control.evaluate((el) =>
          Number.parseFloat(getComputedStyle(el).fontSize),
        );
        expect(size, name).toBeGreaterThanOrEqual(16);
      }
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
      await section(sheet, "Autonomy");
      await eachAction(sheet);
      const segment = sheet
        .getByRole("radiogroup", { name: "Send as you" })
        .getByRole("radio", { name: "Ask me" });
      await segment.scrollIntoViewIfNeeded();
      expect((await segment.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await closeSettings(page);
      const keys = await openKeys(page);
      for (const control of [
        keys.getByRole("combobox", { name: "Provider" }),
        keys.getByRole("button", { name: "Remove weather" }),
        keys.getByRole("button", { name: "Save key" }),
      ]) {
        await control.scrollIntoViewIfNeeded();
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
      // An icon button draws small and takes presses past its edge.
      expect(await keys.getByRole("button", { name: "Paste key" }).evaluate(reach)).toEqual({
        width: 44,
        height: 44,
      });
      const back = settingsSheet(page).getByRole("button", { name: "Settings", exact: true });
      expect((await back.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      const key = keys.getByLabel("Key", { exact: true });
      expect(
        await key.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
      await context.close();
    });

    // A phone's transport keeps play, the scrubber and Export; speed is the desktop's.
    test("export choices are tap-sized", async () => {
      const { context, page } = await phone(browser, `/?replay=${replayId}`);
      await expect(page.getByRole("combobox", { name: "Playback speed" })).toHaveCount(0);
      await page.getByRole("button", { name: "Export video" }).tap();
      const exporter = page.getByRole("dialog", { name: "Export video" });
      for (const name of ["Range", "Speed"]) {
        const control = exporter.getByRole("radiogroup", { name });
        await control.scrollIntoViewIfNeeded();
        expect((await control.boundingBox())?.height, name).toBeGreaterThanOrEqual(44);
      }
      await exporter.getByRole("button", { name: /^More options/ }).tap();
      for (const name of ["Skip idle", "Show the current step"]) {
        const row = exporter.locator(".ui-group-row").filter({ hasText: name });
        await row.scrollIntoViewIfNeeded();
        expect((await row.boundingBox())?.height, name).toBeGreaterThanOrEqual(44);
      }
      await context.close();
    });

    test("theme choices are preview tiles and autonomy choices sit under their labels down to 360", async () => {
      const { context, page } = await phone(browser);
      const sheet = await openSection(page, "Appearance");
      await expectThemeTiles(sheet);
      const option = sheet.locator(".ui-radio-card").filter({ hasText: "Graphite" });
      expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await section(sheet, "Autonomy");
      await eachAction(sheet);
      await expectAutonomyRow(sheet, false);
      await page.setViewportSize({ width: 360, height: 780 });
      await expectAutonomyRow(sheet, false, true);
      // A row changed under the presets turns them to Custom without moving anything.
      await sheet.locator("#settings-autonomy").evaluate((section) => {
        const body = section.closest(".ui-sheet-body") as HTMLElement;
        body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
      });
      const browse = sheet.getByRole("radiogroup", { name: "Browse websites" });
      const before = (await browse.boundingBox())?.y;
      await browse.getByRole("radio", { name: "Ask me" }).tap();
      await expect(sheet.getByText(/^Your own mix of choices\./)).toBeVisible();
      expect((await browse.boundingBox())?.y).toBe(before);
      await context.close();
    });
  });

test("chrome at 1440: theme tiles, autonomy rows and pointer-sized pickers", async () => {
  const browser = await ENGINES.chrome();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/#token=${TOKEN}`);
  const sheet = await openSettings(page);
  const main = roleCard(sheet, "main");
  await expect(main.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
  await expectThemeTiles(sheet);
  await eachAction(sheet, (target) => target.click());
  await expectAutonomyRow(sheet, true);
  // The inspector covers the bar's right end but for its top inset: nothing pressed shows there.
  const pressed = page.locator("header.bar").getByRole("button", { name: "Settings", exact: true });
  await expect(pressed).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(0, 450);
  expect(await pressed.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  // Under a pointer the inline pickers draw as one line of text, smaller than a finger's target.
  for (const name of ["Provider", "Model", "Key"]) {
    const height =
      (await main.getByRole("combobox", { name, exact: true }).boundingBox())?.height ?? 0;
    expect(height, name).toBeGreaterThanOrEqual(18);
    expect(height, name).toBeLessThan(44);
  }
  const knows = sheet.getByRole("region", { name: "What dot knows" });
  for (const file of ["About you", "Notes"]) {
    await knows.getByRole("radio", { name: file, exact: true }).click();
    await knows.getByRole("button", { name: /^Show the file/ }).click();
    const well = sheet.locator(".settings-well");
    await expect(well).toHaveCount(1);
    // Memory scrolls with the sheet's body, never in a box of its own.
    expect(await well.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    await knows.getByRole("button", { name: /^Hide the file/ }).click();
  }
  await browser.close();
});
