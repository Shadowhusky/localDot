import { composer, expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test("minimize gives the conversation room and restores the same computer", async ({
  page,
  ui,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await ui.open("running");
  const chat = page.locator(".rail-chat");
  const stage = page.locator(".stage").first();
  const original = await stage.elementHandle();
  const before = await chat.evaluate((n) => n.clientHeight);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Minimize screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show screen", exact: true })).toBeVisible();
  await expect.poll(() => chat.evaluate((n) => n.clientHeight)).toBeGreaterThan(before + 200);
  const field = await composer(page);
  const bottom = await field.boundingBox();
  if (!bottom) throw new Error("Composer is not visible");
  expect(bottom.y + bottom.height).toBeLessThanOrEqual(844);
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(page.locator(".stage-col")).toHaveCSS("max-height", "0px");
  await page.screenshot({ path: test.info().outputPath("conversation-expanded.png") });
  await page.getByRole("button", { name: "Show screen", exact: true }).click();
  await expect.poll(() => chat.evaluate((n) => n.clientHeight)).toBe(before);
  expect(await stage.evaluate((n, first) => n === first, original)).toBe(true);
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
});
