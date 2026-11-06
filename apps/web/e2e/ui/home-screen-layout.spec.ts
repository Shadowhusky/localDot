import type { Page } from "@playwright/test";
import { composer, expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ viewStyle: "chat", phoneList: true });

const faceIsSolid = (control: ReturnType<Page["locator"]>) =>
  control.evaluate((element) => {
    const face = getComputedStyle(element, "::before").backgroundColor;
    return !/rgba?\(.*,\s*0?\.\d+\)|\/\s*0?\.\d+\)/.test(face);
  });

test("what scrolls under the list's bar goes behind the glass, never through its controls", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await ui.open("conversations");
  const bar = page.locator(".phone-list-bar");
  const list = page.locator(".phone-list-scroll");
  await expect(bar).toBeVisible();
  expect(await faceIsSolid(page.locator(".phone-pill"))).toBe(true);
  expect(await faceIsSolid(bar.getByRole("button", { name: "New conversation" }))).toBe(true);

  // The large title reaches the pill long before it has gone: the glass is up from the start of
  // that, and the bar takes over the title only once it has gone.
  await list.evaluate((element) => {
    element.scrollTop = 12;
  });
  await expect(bar).toHaveAttribute("data-under", "");
  await expect(bar).not.toHaveAttribute("data-titled", "");
  await expect(page.locator(".phone-pill-name")).toBeVisible();
  await list.evaluate((element) => {
    element.scrollTop = 60;
  });
  await expect(bar).toHaveAttribute("data-titled", "");
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(bar).not.toHaveAttribute("data-under", "");
});

test("a turn of the phone fits the app, whatever scale iOS reports for it", async ({
  page,
  ui,
}) => {
  await ui.open("conversations");
  const app = page.locator(".app");
  await expect(page.locator(".phone-list-bar")).toBeVisible();
  await page.evaluate(() => {
    const view = window.visualViewport;
    if (!view) throw new Error("Visual viewport required");
    Object.defineProperty(view, "scale", { configurable: true, value: 844 / 390 });
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => app.evaluate((element) => element.clientHeight)).toBe(390);
});

test.describe("at the foot of the screen", () => {
  test.use({ phoneList: false });

  test("the composer stops clear of the home indicator, and a keyboard takes the inset away", async ({
    page,
    ui,
  }) => {
    test.skip(test.info().project.name !== "c39", "Only Chromium can set the screen's insets");
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, right: 0, bottom: 34, left: 0 },
    });
    await ui.open("running");
    const toolbar = page.locator(".thread-toolbar");
    const foot = () =>
      toolbar.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
    await expect(toolbar).toBeVisible();
    await expect.poll(foot).toBeCloseTo(22, 0);

    const field = (await composer(page)).getByRole("textbox", { name: "Message", exact: true });
    await field.focus();
    await page.evaluate(() => {
      const view = window.visualViewport;
      if (!view) throw new Error("Visual viewport required");
      Object.defineProperty(view, "height", { configurable: true, value: 500 });
      view.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator(".app")).toHaveAttribute("data-keyboard-up", "");
    await expect.poll(foot).toBe(8);
  });
});
