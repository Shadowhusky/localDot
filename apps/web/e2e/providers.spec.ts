import { fileURLToPath } from "node:url";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { choose, nestedKeys, roleCard, search, settingsSheet } from "./settings-ui.ts";
import { skipSetup } from "./skip-setup.ts";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

// Vendor presets and plans in Settings, in Chrome at desktop width and in WebKit on a phone,
// against the fixture daemon with a trimmed models.dev snapshot of those vendors.
const CATALOG = fileURLToPath(new URL("./fixtures/models-dev-providers.json", import.meta.url));
const OFFERED = [
  "moonshotai-cn",
  "alibaba-cn",
  "zai",
  "zhipuai",
  "minimax",
  "volcengine",
  "siliconflow",
  "siliconflow-cn",
  "minimax-coding-plan",
  "alibaba-token-plan",
  "alibaba-coding-plan",
];
const GLM_PLAN =
  "Z.ai lets this plan run only in the coding tools it lists. Use a Z.ai API key here instead.";

const runs = [
  { name: "Chrome at desktop width", engine: "chrome", phone: false },
  { name: "WebKit on a phone", engine: "webkit", phone: true },
] as const;

for (const run of runs) {
  test.describe(run.name, () => {
    let browser: Browser, fixture: UiFixture;
    test.beforeAll(async () => {
      browser = await ENGINES[run.engine]();
    });
    test.afterAll(async () => {
      await browser?.close();
    });
    test.beforeEach(async () => {
      test.setTimeout(120_000);
      fixture = await startUiFixture("localdot-providers", {
        QA_CATALOG: CATALOG,
        QA_SETTINGS: "empty",
        QA_KEYS: "0",
      });
    });
    test.afterEach(async () => {
      await fixture?.stop();
    });

    async function settings(): Promise<{
      page: Page;
      sheet: Locator;
      press(l: Locator): Promise<void>;
    }> {
      const context = await browser.newContext(
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
      await skipSetup(page);
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      await press(page.getByRole("button", { name: "Settings", exact: true }));
      const sheet = settingsSheet(page);
      await expect(
        roleCard(sheet, "main").getByRole("combobox", { name: "Provider", exact: true }),
      ).toBeEnabled();
      return { page, sheet, press };
    }
    const savedSettings = async () =>
      (await (
        await fetch(`${fixture.origin}/api/agent/settings`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).json()) as Record<string, unknown>;

    test("lists each vendor with its catalog models, and binds a plan's key to its address", async () => {
      const { page, sheet, press } = await settings();
      const main = roleCard(sheet, "main");
      const provider = main.getByRole("combobox", { name: "Provider", exact: true });
      const model = main.getByRole("combobox", { name: "Model", exact: true });
      for (const id of OFFERED) {
        await search(page, provider, id);
        await press(model);
        await expect(
          page
            .getByRole("listbox", { name: "Model" })
            .locator('[role=option]:not([aria-disabled="true"])')
            .first(),
          id,
        ).toBeAttached();
        await page.keyboard.press("Escape");
        await expect(model).toHaveAttribute("aria-expanded", "false");
      }
      await press(provider);
      await expect(
        page
          .getByRole("listbox", { name: "Provider" })
          .getByRole("group", { name: "Plans" })
          .locator(".ui-option-label"),
      ).toHaveText(["MiniMax Token Plan", "Alibaba Token Plan", "Alibaba Coding Plan"]);
      await page.keyboard.press("Escape");
      await search(page, provider, "minimax-coding-plan");
      await expect(provider).toHaveText("MiniMax Token Plan");
      await choose(page, model, /MiniMax-M3( ·|$)/);

      await press(main.getByRole("button", { name: "Add key", exact: true }));
      const keys = nestedKeys(page);
      await expect(keys.getByRole("combobox", { name: "Provider" })).toHaveText(
        "OpenAI-compatible",
      );
      await expect(keys.getByLabel("Base URL", { exact: true })).toHaveValue(
        "https://api.minimax.io/v1",
      );
      await keys.getByLabel("Label (optional)", { exact: true }).fill("token-plan");
      await keys.getByLabel("Key", { exact: true }).fill("fixture-token-plan-value");
      await press(keys.getByRole("button", { name: "Save key" }));
      await expect(keys.getByText("Saved token-plan.")).toBeVisible();
      await press(keys.getByRole("button", { name: "Settings", exact: true }));
      await expect(keys).toHaveCount(0);
      await expect(main.getByRole("combobox", { name: "Key", exact: true })).toHaveText(
        "token-plan",
      );

      // A plan uses its own limits: no per-token price, and no dollar limit.
      await expect(main.getByText("Uses your plan's limits.", { exact: true })).toBeVisible();
      await expect(
        main.getByText("Use a key from this plan, not a pay-as-you-go key."),
      ).toBeVisible();
      await expect(
        sheet
          .getByRole("region", { name: "Spending" })
          .getByText("Your plan's own limits apply, so no limit is needed."),
      ).toBeAttached();
      await expect(main.getByRole("textbox", { name: "Input price" })).toHaveCount(0);
      const save = sheet.getByRole("button", { name: "Save", exact: true });
      await expect(save).toBeEnabled();
      await press(save);
      await expect(sheet.getByText(/^(Saved|All changes saved)$/)).toBeVisible();
      expect((await savedSettings()).main).toEqual({
        provider: "minimax-coding-plan",
        model: "MiniMax-M3",
        key: "token-plan",
      });
    });

    test("says why the GLM Coding Plan is not available, and never saves it", async () => {
      const { page, sheet, press } = await settings();
      const puts: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "PUT" && r.url().endsWith("/api/agent/settings")) puts.push(r.url());
      });
      const main = roleCard(sheet, "main");
      const provider = main.getByRole("combobox", { name: "Provider", exact: true });
      await press(provider);
      const refused = page
        .getByRole("listbox", { name: "Provider" })
        .getByRole("group", { name: "Not available here" })
        .getByRole("option");
      await expect(refused.locator(".ui-option-label")).toHaveText([
        "GLM Coding Plan",
        "Kimi For Coding",
        "Ark Coding Plan",
      ]);
      await expect(refused.locator(".ui-option-note")).toHaveText(
        Array(3).fill("Not available here"),
      );
      await press(refused.first());
      await expect(provider).toHaveText("GLM Coding Plan");
      const reason = sheet.getByText(GLM_PLAN, { exact: true });
      await expect(reason).toBeVisible();
      await expect(provider).toHaveAttribute(
        "aria-describedby",
        (await reason.getAttribute("id")) as string,
      );
      await expect(main.getByRole("combobox", { name: "Model" })).toHaveCount(0);
      await expect(main.getByRole("combobox", { name: "Key" })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Add key" })).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await expect(sheet.locator(".settings-problems")).toContainText(
        "Main: choose a provider that is available here.",
      );
      expect(puts).toEqual([]);

      const forced = await fetch(`${fixture.origin}/api/agent/settings`, {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          main: {
            provider: "zai-coding-plan",
            model: "glm-5.3-flash",
            price: { inputUSDPerMTok: 1, outputUSDPerMTok: 1 },
          },
        }),
      });
      expect(forced.status).toBe(400);
      expect(await savedSettings()).toEqual({});
    });
  });
}
