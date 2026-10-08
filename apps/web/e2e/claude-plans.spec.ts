import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

const SENTENCE =
  "Claude Pro and Max plans can't be used here: Anthropic doesn't allow other apps to sign in with them. Add an Anthropic API key instead.";
const PLAN_TOKEN = `sk-ant-oat01-${"Qz7_".repeat(24)}`;
const REFRESH_TOKEN = `sk-ant-ort01-${"Pv5_".repeat(24)}`;
const API_KEY = `sk-ant-api03-${"Rw8-".repeat(24)}`;

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
      fixture = await startUiFixture("localdot-claude-plans", {
        QA_SETTINGS: "empty",
        QA_KEYS: "0",
      });
    });
    test.afterEach(async () => {
      await context?.close();
      context = undefined;
      await fixture?.stop();
    });

    async function open(): Promise<{
      page: Page;
      press(l: Locator): Promise<void>;
      carried: string[];
    }> {
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
      const carried: string[] = [];
      page.on("request", (r) => {
        const sent = `${r.url()} ${r.postData() ?? ""}`;
        if (/sk-ant-o[ar]t/.test(sent)) carried.push(`${r.method()} ${new URL(r.url()).pathname}`);
      });
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      const press = (l: Locator) => (run.phone ? l.tap() : l.click());
      return { page, press, carried };
    }
    async function settings(page: Page, press: (l: Locator) => Promise<void>) {
      await press(page.getByRole("button", { name: "Settings", exact: true }));
      const sheet = page.getByRole("dialog", { name: "Models and settings" });
      await expect(sheet.getByRole("combobox", { name: "main provider" })).toBeEnabled();
      return sheet;
    }

    test("says Claude plans can't be used, under Anthropic, on a search and in Subscription", async () => {
      const { page, press } = await open();
      const sheet = await settings(page, press);
      const provider = sheet.getByRole("combobox", { name: "main provider" });
      const plan = provider.locator('optgroup[label="Subscription"] > option', {
        hasText: "Claude Pro or Max",
      });
      await expect(plan).toHaveText("Claude Pro or Max — not available here");
      await expect(plan).toHaveJSProperty("disabled", true);
      await expect(sheet.getByText(SENTENCE)).toHaveCount(0);

      await sheet.getByLabel("Search main providers").fill("claude code");
      await expect(sheet.getByText(SENTENCE, { exact: true })).toBeVisible();
      await expect(plan).toBeAttached();
      await expect(provider.locator('option[value="anthropic"]')).toHaveJSProperty(
        "disabled",
        false,
      );
      await sheet.getByLabel("Search main providers").fill("");
      await expect(sheet.getByText(SENTENCE)).toHaveCount(0);

      await provider.selectOption("anthropic");
      const note = sheet.getByText(SENTENCE, { exact: true });
      await expect(note).toBeVisible();
      await expect(provider).toHaveAttribute(
        "aria-describedby",
        (await note.getAttribute("id")) as string,
      );
      await expect(sheet.getByRole("button", { name: "Add key for main" })).toBeVisible();
    });

    test("refuses a plan token pasted into an Anthropic key, and no request carries it", async () => {
      const { page, press, carried } = await open();
      const posts: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).pathname === "/api/keys") posts.push(r.url());
      });
      const sheet = await settings(page, press);
      await sheet.getByRole("combobox", { name: "main provider" }).selectOption("anthropic");
      await press(sheet.getByRole("button", { name: "Add key for main" }));
      const keys = page.getByRole("dialog", { name: "Keys" });
      await expect(keys.getByRole("combobox", { name: "Provider" })).toHaveValue("anthropic");
      const hint = keys.locator("#key-value-hint");
      await expect(hint).toHaveText("Starts with sk-ant-api");
      await keys.getByLabel("Name", { exact: true }).fill("anthropic");
      const field = keys.getByLabel("Key", { exact: true });
      await field.focus();
      await page.keyboard.insertText(PLAN_TOKEN);
      await expect(field).toHaveValue("");
      const error = keys.getByText(SENTENCE, { exact: true });
      await expect(error).toBeVisible();
      await expect(keys.getByRole("alert")).toHaveText(SENTENCE);
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toHaveAttribute("aria-describedby", "key-value-error key-value-hint");

      await keys.getByLabel("Name", { exact: true }).fill("claudewrapped");
      await expect(error).toHaveCount(0);
      await field.focus();
      await page.keyboard.insertText(`export CLAUDE_CODE_OAUTH_TOKEN=${PLAN_TOKEN}`);
      await expect(field).toHaveValue("");
      await expect(error).toBeVisible();

      // A value that arrives without an input event is refused on save.
      for (const value of [PLAN_TOKEN, `Bearer ${PLAN_TOKEN}`]) {
        await field.evaluate((input: HTMLInputElement, token) => {
          input.value = token;
        }, value);
        await press(keys.getByRole("button", { name: "Save key" }));
        await expect(field).toHaveValue("");
        await expect(error).toBeVisible();
      }
      await expect(keys.getByText("No keys yet.")).toBeVisible();
      expect(posts).toEqual([]);
      expect(carried).toEqual([]);
      const stored = await (
        await fetch(`${fixture.origin}/api/keys`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).json();
      expect(stored).toEqual({ keys: [] });
    });

    test("removes a plan token from a message, says why and offers no move to Keys", async () => {
      const { page, press, carried } = await open();
      if (run.phone) {
        // The tabs move down when the task's pause button arrives; a tap before then misses.
        await expect(page.getByRole("button", { name: "Pause after this step" })).toBeVisible();
        const tab = page.getByRole("tab", { name: "Conversation" });
        await press(tab);
        await expect(tab).toHaveAttribute("aria-selected", "true");
      }
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill(`use ${PLAN_TOKEN} please`);
      await expect(box).toHaveValue("use  please");
      const notice = page.getByRole("region", { name: "Key safeguard" });
      await expect(notice).toContainText("Claude plan token removed");
      await expect(notice.getByRole("alert")).toHaveText(SENTENCE);
      await expect(notice.getByRole("button", { name: "Move to Keys" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send now" })).toBeDisabled();
      await press(notice.getByRole("button", { name: "Discard key" }));
      await expect(notice).toHaveCount(0);

      // With an API key beside it, only the API key can move to Keys.
      await box.fill(`${PLAN_TOKEN} and ${API_KEY}`);
      const choice = notice.getByRole("combobox", { name: "Key to move" });
      await expect(choice).toContainText("Claude plan token · character 1");
      expect((await choice.boundingBox())?.height).toBeGreaterThanOrEqual(run.phone ? 44 : 32);
      await expect(notice.getByText(SENTENCE, { exact: true })).toBeVisible();
      await expect(notice.getByRole("button", { name: "Move to Keys" })).toHaveCount(0);
      await press(choice);
      await press(page.getByRole("option", { name: /^Anthropic · character/ }));
      await expect(notice.getByText(SENTENCE, { exact: true })).toHaveCount(0);
      await expect(notice.getByRole("button", { name: "Move to Keys" })).toBeVisible();
      await press(notice.getByRole("button", { name: "Discard keys" }));
      await expect(notice).toHaveCount(0);

      await box.fill(`${API_KEY} and ${PLAN_TOKEN}`);
      await expect(choice).toContainText("Anthropic · character 1");
      await expect(notice.getByRole("button", { name: "Move to Keys" })).toBeVisible();
      await press(notice.getByRole("button", { name: "Discard keys" }));
      await expect(notice).toHaveCount(0);

      await box.fill(`${PLAN_TOKEN} and ${REFRESH_TOKEN}`);
      await expect(notice).toContainText("Claude plan tokens removed");
      await expect(notice.getByRole("alert")).toHaveText(SENTENCE);
      await expect(notice.getByRole("combobox", { name: "Key to move" })).toHaveCount(0);
      await expect(notice.getByText(/Moving one key/)).toHaveCount(0);
      await expect(notice.getByRole("button", { name: "Move to Keys" })).toHaveCount(0);
      await press(notice.getByRole("button", { name: "Discard keys" }));
      await expect(notice).toHaveCount(0);
      expect(carried).toEqual([]);
    });
  });
}
