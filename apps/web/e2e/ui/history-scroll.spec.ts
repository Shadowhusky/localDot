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
  await expect.poll(() => history.locator("li").count()).toBeGreaterThan(140);
  await history.dispatchEvent("wheel", { deltaY: -500 });
  await history.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => history.evaluate((node) => node.scrollTop)).toBe(0);
  const oldest = await history.locator("li").first().textContent();
  await page.request.post(`${fixture.origin}/__qa/steps?n=3`);
  await expect.poll(() => history.locator("li").count()).toBeGreaterThan(143);
  expect(await history.locator("li").first().textContent()).toBe(oldest);
  expect(await history.evaluate((node) => node.scrollTop)).toBeLessThan(2);
  expect(await history.evaluate((node) => node.clientHeight)).toBeLessThanOrEqual(280);
  await work.getByRole("button", { expanded: true }).click();
  const phone = (page.viewportSize()?.width ?? 0) < 700;
  if (phone) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: "Activity", exact: true }).click();
  const rail = page.locator(".activity-rail");
  await expect.poll(() => rail.locator(".activity-row").count()).toBe(103);
  const scroller = rail.locator(".activity-scroll");
  await scroller.dispatchEvent("wheel", { deltaY: -500 });
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => rail.locator(".activity-row").count()).toBeGreaterThan(143);
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
