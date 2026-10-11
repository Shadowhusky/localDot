import { expect, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});
for (const width of [390, 1440]) {
  test(`startup keeps the mascot in place at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    fixture = await startUiFixture({ QA_CELL: "off", QA_SESSION: "0" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/api/cells", async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(`${fixture.origin}/#token=${TOKEN}`);
    await expect(page.locator(".curtain-col[data-checking]")).toBeVisible();
    const hero = page.locator(".curtain-hero");
    const before = await hero.boundingBox();
    release();
    await expect(page.locator(".curtain-title")).toHaveText("Your computer is off");
    const after = await hero.boundingBox();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs((before?.y ?? 0) - (after?.y ?? 0))).toBeLessThanOrEqual(2);
    await expect(page.locator(".curtain-title")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `/tmp/localdot-startup-${width}.png` });
  });
}
test("a paired browser retains the relay cookie while loading history and replay", async ({
  page,
  context,
}) => {
  fixture = await startUiFixture();
  await context.addCookies([{ name: "relay-test", value: "paired", url: fixture.origin }]);
  let history = 0;
  await page.route("**/api/sessions/**/history", async (route) => {
    history++;
    const headers = await route.request().allHeaders();
    expect(headers.cookie).toContain("relay-test=paired");
    await route.continue();
  });
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await expect.poll(() => history).toBeGreaterThan(0);
  await expect(page.locator(".sign-in")).toHaveCount(0);
});
