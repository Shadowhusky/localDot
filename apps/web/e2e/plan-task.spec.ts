import { type Browser, type BrowserContext, expect, type Locator, test } from "@playwright/test";
import { showActivity } from "./layout.ts";
import { closeSettings, openSettings, roleCard } from "./settings-ui.ts";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

// A task on a flat-rate plan, through the daemon's real bindings: no per-token price, no dollar
// ceiling, and the task says it uses the plan's limits.
const PLAN = { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" };
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
      fixture = await startUiFixture("localdot-plan-task", {
        QA_SETTINGS: "plan",
        QA_SESSION: "0",
      });
    });
    test.afterEach(async () => {
      await context?.close();
      context = undefined;
      await fixture?.stop();
    });
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${fixture.origin}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });

    test("a plan task shows that it uses the plan's limits", async () => {
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

      const sheet = await openSettings(page, press, "Models");
      const main = roleCard(sheet, "main");
      await expect(main.getByRole("combobox", { name: "Provider", exact: true })).toHaveText(
        "MiniMax Token Plan",
      );
      await expect(main.getByRole("textbox", { name: "Input price" })).toHaveCount(0);
      // A phone shows one section at a time: back to the list, then into Spending.
      if (run.phone) {
        await press(sheet.getByRole("button", { name: "Settings", exact: true }));
        await press(sheet.getByRole("button", { name: /^Spending/ }));
      }
      await expect(
        sheet
          .getByRole("region", { name: "Spending" })
          .getByText("Your plan's own limits apply, so no limit is needed."),
      ).toBeAttached();
      await expect(sheet.getByRole("switch", { name: "Spending limit" })).toHaveCount(0);
      await closeSettings(page);

      await page.getByLabel("New task").fill("Tidy the sample folder.");
      await press(page.getByRole("button", { name: "Start task", exact: true }));
      await showActivity(page);
      await press(page.getByRole("button", { name: /^Usage:/ }));
      const usage = page.getByRole("region", { name: "Task usage" });
      await expect(usage).toContainText("MainMiniMax-M3");
      await expect(
        usage.getByText("Included in your plan. Uses your plan's limits.", { exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );

      // The plan saved with no price, and the daemon refuses one.
      expect((await (await api("/api/agent/settings")).json()).main).toEqual(PLAN);
      const priced = await api("/api/agent/settings", {
        method: "PUT",
        body: JSON.stringify({
          main: { ...PLAN, price: { inputUSDPerMTok: 0.3, outputUSDPerMTok: 1.2 } },
        }),
      });
      expect(priced.status).toBe(400);
      expect((await (await api("/api/agent/settings")).json()).main).toEqual(PLAN);
    });
  });
}
