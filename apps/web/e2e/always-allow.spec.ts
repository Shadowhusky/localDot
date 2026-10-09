import { type Browser, expect, type Page, test } from "@playwright/test";
import { reach } from "./reach.ts";
import { openSettings } from "./settings-ui.ts";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

// "Always allow" on a real approval card from the fixture daemon: the card offers this task and
// the mail site, the choice reaches Settings, and Undo or Remove takes it back.
test.setTimeout(120_000);

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

const SIZES = [
  { name: "Chrome 1440×900", engine: "chrome", width: 1440, height: 900, phone: false },
  { name: "WebKit 390×844 phone", engine: "webkit", width: 390, height: 844, phone: true },
] as const;

async function open(browser: Browser, size: (typeof SIZES)[number] = SIZES[0]) {
  fixture = await startUiFixture("localdot-always-allow");
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 2,
    isMobile: size.phone,
    hasTouch: size.phone,
  });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await expect(page.getByTestId("hud-status")).toBeVisible();
  return page;
}

async function api<T>(path: string, origin: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, origin },
  });
  return response.json() as Promise<T>;
}

async function requestSend(page: Page, origin: string) {
  const response = await page.request.post(`${origin}/__qa/approval?always=1`);
  expect(response.ok()).toBe(true);
  const card = page.locator(".decision");
  await expect(card).toBeVisible();
  return card;
}

// How far a yes reaches is chosen first; Send then answers with it.
async function allow(page: Page, scope: string, phone: boolean) {
  const trigger = page.getByRole("combobox", { name: "How long this answer lasts" });
  if (phone) {
    // An inline pop-up draws as text and takes a finger past its edge.
    expect(await trigger.evaluate(reach)).toEqual({ width: 44, height: 44 });
    await trigger.tap();
  } else await trigger.click();
  const option = page.getByRole("option", { name: scope });
  await expect(option).toBeVisible();
  if (phone) await option.tap();
  else await option.click();
  await press(page, "Send", phone);
}

async function press(page: Page, name: string, phone: boolean) {
  const target = page.getByRole("button", { name, exact: true });
  await expect(target).toBeEnabled();
  if (phone) await target.tap();
  else await target.click();
  return target;
}

for (const size of SIZES)
  test(`allows sending on one site from the card, then removes it in Settings at ${size.name}`, async ({
    browser,
  }) => {
    const owned = size.engine === "webkit" ? await ENGINES.webkit() : null;
    const page = await open(owned ?? browser, size);
    try {
      const origin = fixture?.origin ?? "";
      await requestSend(page, origin);
      await allow(page, "On mail.example.test", size.phone);

      await expect(page.locator(".decision")).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: "Allowed on" })).toHaveText(
        "Allowed on mail.example.test: sending messages.",
      );
      await expect(page.locator(".always-notice")).toBeVisible();
      await expect
        .poll(async () => (await api<{ effects: string[] }>("/__qa/state", origin)).effects)
        .toContain("approval:approve");
      const saved = await api<{ rules: { actionClass: string; site?: string }[] }>(
        "/api/agent/rules",
        origin,
      );
      expect(saved.rules).toMatchObject([
        { actionClass: "send", scope: "site", site: "https://mail.example.test" },
      ]);

      const sheet = await openSettings(
        page,
        (target) => (size.phone ? target.tap() : target.click()),
        "Always allow",
      );
      const list = sheet.getByRole("list", { name: "Always allowed" });
      await expect(list.getByRole("listitem")).toHaveText([
        "Send as youOn mail.example.testRemove",
      ]);
      const remove = list.getByRole("button", {
        name: "Remove Send as you: On mail.example.test",
      });
      await remove.scrollIntoViewIfNeeded();
      if (size.phone) {
        expect((await remove.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        await remove.tap();
      } else await remove.click();
      await expect(sheet.getByText("Nothing allowed yet")).toBeVisible();
      await expect(list).toHaveCount(0);
      expect((await api<{ rules: unknown[] }>("/api/agent/rules", origin)).rules).toEqual([]);
    } finally {
      await page.context().close();
      await owned?.close();
    }
  });

test("Undo from the status line takes back a task allowance", async ({ browser }) => {
  const page = await open(browser);
  try {
    const origin = fixture?.origin ?? "";
    await requestSend(page, origin);
    await allow(page, "For this task", false);
    await expect(page.locator(".decision")).toHaveCount(0);
    const status = page.getByRole("status").filter({ hasText: "this task" });
    await expect(status).toHaveText("Allowed for this task: sending messages.");
    await press(page, "Undo allowing sending messages for this task", false);
    await expect(page.getByRole("status").filter({ hasText: "Undone." })).toHaveText(
      "Undone. You'll be asked again next time.",
    );
    await expect(page.locator(".always-notice")).toHaveText(
      "Undone. You'll be asked again next time.",
    );
    await expect(page.getByRole("button", { name: /^Undo allowing/ })).toHaveCount(0);

    await requestSend(page, origin);
    const effects = (await api<{ effects: string[] }>("/__qa/state", origin)).effects;
    expect(effects.filter((effect) => effect.startsWith("approval:"))).toEqual([
      "approval:approve",
    ]);
  } finally {
    await page.context().close();
  }
});
