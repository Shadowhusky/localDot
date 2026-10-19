import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("earlier Activity and work steps remain reachable without paging or moving the reader", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/steps?n=140`);
  const work = page.locator(".thread-live .thread-work");
  await expect(work).toContainText("steps");
  await work.getByRole("button", { expanded: false }).click();
  const history = work.getByRole("region", { name: "Work history" });
  await expect
    .poll(async () => Number(await history.locator("[data-last]").getAttribute("data-index")))
    .toBeGreaterThan(140);
  await history.dispatchEvent("wheel", { deltaY: -500 });
  await history.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => history.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(history.locator('[data-index="0"]')).toBeVisible();
  const oldest = await history.locator('[data-index="0"]').textContent();
  await page.request.post(`${fixture.origin}/__qa/steps?n=3`);
  await expect(work).toContainText("149 steps");
  expect(await history.locator('[data-index="0"]').textContent()).toBe(oldest);
  expect(await history.evaluate((node) => node.scrollTop)).toBeLessThan(2);
  expect(await history.evaluate((node) => node.clientHeight)).toBeLessThanOrEqual(280);
  await work.getByRole("button", { expanded: true }).click();
  const phone = (page.viewportSize()?.width ?? 0) < 700;
  if (phone) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: "Activity", exact: true }).click();
  const rail = page.locator(".activity-rail");
  // Virtualized rows stay bounded; the last logical row records the loaded window.
  await expect(rail.locator(".activity-window-row[data-last]")).toBeVisible();
  const scroller = rail.locator('[role="tabpanel"]:not([aria-hidden]) .activity-scroll');
  await scroller.dispatchEvent("wheel", { deltaY: -500 });
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(rail.getByRole("button", { name: "Earlier steps" })).toHaveCount(0);
  await expect(rail.locator('.activity-window-row[data-index="0"]')).toBeVisible();
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  const first = rail.locator(".activity-row").first();
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  const room = await scroller.boundingBox();
  if (!box || !room) throw new Error("Missing Activity geometry");
  expect(box.y).toBeGreaterThanOrEqual(room.y - 1);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => null)),
    ),
  );
  await page.screenshot({ path: test.info().outputPath("complete-history.png") });
});

test("expanding work keeps the composer inside a short viewport", async ({ page, ui }) => {
  await ui.open("running");
  const work = page.locator(".thread-live .thread-work");
  for (const height of [620, 480]) {
    await page.setViewportSize({ width: page.viewportSize()?.width ?? 390, height });
    const toggle = work.getByRole("button", { expanded: false });
    if (await toggle.count()) await toggle.click();
    await ui.settle();
    const field = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(field).toBeInViewport();
    const box = await page.locator(".thread-toolbar").boundingBox();
    if (!box) throw new Error("Missing composer geometry");
    expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
    expect(box.y).toBeGreaterThanOrEqual(0);
  }
});
