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

test("Replay opens its picture when Watch is minimized and keeps the live preference", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("done");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Minimize screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show screen", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Replay", exact: true }).click();
  const library = page.getByRole("main", { name: "Replay" });
  await library.getByRole("button", { name: /^Earlier sample task 1/ }).click();
  const picture = page.locator(".replay-main .stage");
  await expect(page.locator(".replay-opening")).toBeHidden();
  await expect(picture).toBeVisible();
  await expect.poll(async () => (await picture.boundingBox())?.height ?? 0).toBeGreaterThan(100);
  await expect(page.locator(".app")).not.toHaveAttribute("data-screen-minimized");
  expect(await page.evaluate(() => localStorage.getItem("localdot.mobile-screen-minimized"))).toBe(
    "true",
  );
  await page.screenshot({ path: test.info().outputPath("replay-from-collapsed.png") });
  await page.getByRole("navigation").getByRole("button", { name: "Replay" }).click();
  await page
    .getByRole("navigation", { name: "Replay" })
    .getByRole("button", { name: "Watch" })
    .click();
  await expect(page.getByRole("button", { name: "Show screen", exact: true })).toBeVisible();
  await expect(page.locator(".watch > .stage-col")).toHaveCSS("max-height", "0px");
  // Reloading a replay link must also ignore the saved live-screen preference.
  await page.goto(`${fixture.origin}/?replay=${fixture.seeded[0]}&t=20000`);
  await expect(page.locator(".replay-opening")).toBeHidden();
  await ui.picture(page.locator(".replay-main .stage"));
  await expect(page.locator(".replay-main .stage")).toBeVisible();
});
