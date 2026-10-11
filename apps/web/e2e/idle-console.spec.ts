import { expect, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

test.setTimeout(150_000);

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

test("an idle computer logs no failed requests and is checked for tasks at a calm pace", async ({
  page,
}) => {
  fixture = await startUiFixture({ QA_SESSION: "0" });
  const errors: string[] = [];
  let looks = 0;
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().startsWith("Failed to load resource"))
      errors.push(`${message.text()} ${message.location().url}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/api\/cells\/[^/]+\/live$/.test(new URL(request.url()).pathname)) looks++;
  });
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await expect(page.getByTestId("hud-status")).toHaveText("Ready");
  await page.waitForTimeout(60_000);
  expect(errors).toEqual([]);
  expect(looks).toBeGreaterThan(0);
  expect(looks).toBeLessThanOrEqual(20);
});

test("hidden viewers stop task polling and streaming, then refresh on return", async ({ page }) => {
  fixture = await startUiFixture({ QA_SESSION: "0" });
  let looks = 0;
  page.on("request", (request) => {
    if (/\/api\/cells\/[^/]+\/live$/.test(new URL(request.url()).pathname)) looks++;
  });
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await expect(page.getByTestId("hud-status")).toHaveText("Ready");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1000);
  const hiddenLooks = looks;
  await page.waitForTimeout(10_000);
  expect(looks).toBe(hiddenLooks);
  expect(await page.locator("iframe.desktop-frame").count()).toBe(0);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => looks).toBeGreaterThan(hiddenLooks);
  await expect(page.getByTestId("hud-status")).toHaveText("Ready");
});
