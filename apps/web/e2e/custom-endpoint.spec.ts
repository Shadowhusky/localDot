import { type Browser, type BrowserContext, expect, type Locator, test } from "@playwright/test";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

// A custom Anthropic-compatible endpoint, from an empty setup: its key with the vendor's base URL,
// a typed model ID that cannot see images, then a flat-rate plan, through the daemon's real
// bindings, until the welcome screen says the model is ready.
const MODEL = { provider: "anthropic-compatible", model: "glm-5.3-flash", key: "zai-anthropic" };
const runs = [
  { name: "Chrome at desktop width", engine: "chrome", phone: false },
  { name: "WebKit on a phone", engine: "webkit", phone: true },
] as const;

for (const run of runs) {
  test.describe(run.name, () => {
    let browser: Browser, fixture: UiFixture, context: BrowserContext | undefined;
    test.beforeAll(async () => {
      browser = await ENGINES[run.engine]();
    });
    test.afterAll(async () => {
      await browser?.close();
    });
    test.beforeEach(async () => {
      test.setTimeout(120_000);
      fixture = await startUiFixture("localdot-custom-endpoint", {
        QA_CELL: "none",
        QA_SESSION: "0",
        QA_SETTINGS: "empty",
        QA_KEYS: "0",
      });
    });
    test.afterEach(async () => {
      await context?.close();
      context = undefined;
      await fixture?.stop();
    });
    const api = async (path: string, init: RequestInit = {}) =>
      fetch(`${fixture.origin}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });

    test("an Anthropic-compatible model that cannot see images is ready, then runs on a plan", async () => {
      context = await browser.newContext(
        run.phone
          ? {
              viewport: { width: 390, height: 844 },
              deviceScaleFactor: 2,
              isMobile: true,
              hasTouch: true,
            }
          : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
      );
      const page = await context.newPage();
      const press = (l: Locator) => (run.phone ? l.tap() : l.click());
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      const welcome = page.locator(".welcome-steps li").first().getByRole("status");
      await expect(welcome).toHaveText("Choose a main model and connect its provider in Settings.");

      await press(page.getByRole("button", { name: "Choose model" }));
      const sheet = page.getByRole("dialog", { name: "Models and settings" });
      const provider = sheet.getByRole("combobox", { name: "main provider" });
      await expect(provider).toBeEnabled();
      await expect(
        provider.locator('optgroup[label="Compatible providers"] > option'),
      ).toContainText(["Other (OpenAI-compatible)", "Other (Anthropic-compatible)"]);
      await provider.selectOption({ label: "Other (Anthropic-compatible)" });

      await press(sheet.getByRole("button", { name: "Add key for main" }));
      const keys = page.getByRole("dialog", { name: "Keys" });
      await expect(keys.getByRole("combobox", { name: "Provider" })).toHaveValue(
        "anthropic-compatible",
      );
      const base = keys.getByLabel("Base URL", { exact: true });
      await expect(base).toHaveValue("");
      await expect(base).toHaveAccessibleDescription(
        "Use https, ending in /v1 (added if missing). Local servers go through LM Studio or Ollama.",
      );
      await keys.getByLabel("Name", { exact: true }).fill(MODEL.key);
      await base.fill("https://127.0.0.1:8080/anthropic");
      await keys.getByLabel("Key", { exact: true }).fill("fixture-anthropic-compatible-value");
      await press(keys.getByRole("button", { name: "Save key" }));
      await expect(
        keys.getByText(/^Enter the API's https:\/\/ address by host name/),
      ).toBeVisible();
      await base.fill("https://api.z.ai/api/anthropic");
      await keys.getByLabel("Key", { exact: true }).fill("fixture-anthropic-compatible-value");
      await press(keys.getByRole("button", { name: "Save key" }));
      await expect(keys.getByText(`Saved ${MODEL.key}.`)).toBeVisible();
      expect((await (await api("/api/keys")).json()).keys).toEqual([
        expect.objectContaining({
          id: MODEL.key,
          provider: "anthropic-compatible",
          baseURL: "https://api.z.ai/api/anthropic/v1",
        }),
      ]);
      await press(keys.getByRole("button", { name: "Close keys" }));
      await expect(sheet.getByRole("combobox", { name: "main key" })).toHaveValue(MODEL.key);

      const main = sheet.getByRole("group", { name: "Main" });
      await main.getByLabel("main custom model ID").fill(MODEL.model);
      const vision = main.getByRole("checkbox", {
        name: "Can see images (needed to use the screen)",
      });
      await expect(vision).toBeChecked();
      await press(vision);
      await expect(vision).not.toBeChecked();
      await main.getByLabel("main context window — tokens").fill("128,000");
      await expect(main.getByLabel("main context window — tokens")).toHaveValue("128000");
      await main.getByLabel("main Input — USD per million tokens").fill("0.6");
      await main.getByLabel("main Output — USD per million tokens").fill("2.2");
      const save = sheet.getByRole("button", { name: "Save settings" });
      await expect(save).toBeEnabled();
      await press(save);
      await expect(sheet.getByText("Saved choices", { exact: true })).toBeVisible();
      expect((await (await api("/api/agent/settings")).json()).main).toEqual({
        ...MODEL,
        vision: false,
        contextTokens: 128_000,
        price: { inputUSDPerMTok: 0.6, outputUSDPerMTok: 2.2 },
      });
      await press(sheet.getByRole("button", { name: "Close settings" }));
      await expect(welcome).toHaveText("Ready · Other (Anthropic-compatible) · glm-5.3-flash");

      // On a flat-rate plan: no per-token price, no dollar ceiling, and still ready.
      await press(page.getByRole("button", { name: "Change model" }));
      await press(main.getByRole("checkbox", { name: "Flat-rate plan (no per-token price)" }));
      await expect(
        main.getByText("Uses your plan's limits, not a spending ceiling."),
      ).toBeVisible();
      await expect(sheet.getByText(/USD per million tokens/)).toHaveCount(0);
      await expect(
        sheet
          .getByRole("group", { name: "Task spending ceiling" })
          .getByText("Uses your plan's limits.", { exact: true }),
      ).toBeAttached();
      await press(save);
      await expect(sheet.getByText("Saved choices", { exact: true })).toBeVisible();
      expect((await (await api("/api/agent/settings")).json()).main).toEqual({
        ...MODEL,
        vision: false,
        contextTokens: 128_000,
        plan: true,
      });
      await press(sheet.getByRole("button", { name: "Close settings" }));
      await expect(welcome).toHaveText("Ready · Other (Anthropic-compatible) · glm-5.3-flash");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );

      // Only a custom endpoint states what its model can do.
      const forged = await api("/api/agent/settings", {
        method: "PUT",
        body: JSON.stringify({ main: { provider: "ollama", model: "qwen3.8:27b", vision: false } }),
      });
      expect(forged.status).toBe(400);
      expect((await (await api("/api/agent/settings")).json()).main).toMatchObject({ plan: true });
    });
  });
}
