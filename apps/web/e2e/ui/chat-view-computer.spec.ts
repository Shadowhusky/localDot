import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ viewStyle: "chat" });

test("Replay opens its picture from a phone's conversation and comes back to it", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("done");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Replay", exact: true }).click();
  const stack = page.locator(".phone-stack");
  await expect(page.locator(".app")).toHaveAttribute("data-replaying", "");
  await expect(stack).toBeHidden();
  const picture = page.locator(".replay-main .stage");
  await expect(picture).toBeVisible();
  await expect(page.locator(".replay-opening")).toBeHidden();
  await expect.poll(async () => (await picture.boundingBox())?.height ?? 0).toBeGreaterThan(100);
  await page.screenshot({ path: test.info().outputPath("replay.png") });
  await page.goBack();
  await expect(stack).toHaveAttribute("data-level", "1");
  await expect(page.getByRole("button", { name: "Back to conversations" })).toBeVisible();
  // A replay link opens by itself, whatever the stack was doing.
  await page.goto(`${fixture.origin}/?replay=${fixture.seeded[0]}&t=20000`);
  await expect(page.locator(".replay-opening")).toBeHidden();
  await ui.picture(page.locator(".replay-main .stage"));
});

test("the top bar never runs its name under its buttons, at any phone width or length of name", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const title = page.locator(".phone-chat-bar .phone-title-text");
  const monitor = page.locator(".phone-chat-bar .phone-lamp-host");
  await expect(title).toBeVisible();
  const long = "Checking February's net total against revenue minus returns, row by row";
  for (const width of [320, 344, 360, 375, 390, 414, 430]) {
    await page.setViewportSize({ width, height: 800 });
    for (const words of ["Thinking", long]) {
      await title.evaluate((element, text) => {
        element.textContent = text;
      }, words);
      const name = await title.boundingBox();
      const button = await monitor.boundingBox();
      expect(name && button && name.x + name.width <= button.x, `name at ${width}`).toBe(true);
      expect(button?.width).toBeGreaterThanOrEqual(36);
    }
    await page.screenshot({
      path: test.info().outputPath(`bar-${width}.png`),
      clip: { x: 0, y: 0, width, height: 120 },
    });
  }
});
