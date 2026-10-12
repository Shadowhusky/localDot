import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");

test("the home-screen app follows the visible viewport after launch and resume", async ({
  page,
  ui,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    const view = window.visualViewport;
    if (!view) throw new Error("Visual viewport required");
    Object.defineProperty(view, "height", { configurable: true, get: () => 760 });
  });
  await ui.open("running");
  await ui.picture();
  const app = page.locator(".app");
  const toolbar = page.locator(".thread-toolbar");
  await expect(app).not.toHaveAttribute("data-keyboard", "");
  for (const height of [760, 844, 780, 844]) {
    await page.evaluate((height) => {
      const view = window.visualViewport;
      Object.defineProperty(view, "height", { configurable: true, get: () => height });
      view?.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("pageshow"));
    }, height);
    await expect.poll(async () => Math.round((await app.boundingBox())?.height ?? 0)).toBe(height);
    await expect
      .poll(async () => {
        const box = await toolbar.boundingBox();
        return Math.round((box?.y ?? 0) + (box?.height ?? 0));
      })
      .toBe(height);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  }
  // Zooming should magnify the page, without resizing its layout underneath the user.
  await page.evaluate(() => {
    const view = window.visualViewport;
    Object.defineProperty(view, "scale", { configurable: true, get: () => 2 });
    Object.defineProperty(view, "height", { configurable: true, get: () => 422 });
    view?.dispatchEvent(new Event("resize"));
  });
  await ui.settle();
  expect(Math.round((await app.boundingBox())?.height ?? 0)).toBe(844);
});

test("home-screen sign-in explains where to create a link without requiring Safari", async ({
  page,
  ui,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)",
    });
  });
  await ui.open("ready", undefined, "");
  await expect(page.getByRole("heading", { name: "Sign in this app" })).toBeVisible();
  await expect(page.getByText(/browser where you’re already signed in/)).toBeVisible();
  await expect(page.getByPlaceholder("Paste a fresh sign-in link")).toBeVisible();
  await expect(page.getByText(/Safari/)).toHaveCount(0);
  await expect(page.locator(".sign-in-body")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: test.info().outputPath("home-screen-sign-in.png") });
});
