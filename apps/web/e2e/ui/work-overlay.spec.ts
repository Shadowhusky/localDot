import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("commands toggle from More without a floating minimized control and stay within the screen", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await ui.picture();
  const overlay = page.getByRole("region", { name: "Background work", exact: true });
  await expect(overlay).toBeHidden();
  await expect(page.locator(".work-overlay-show")).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show commands", exact: true }).click();
  await expect(overlay).toBeVisible();
  await expect(page.getByRole("button", { name: "Minimize command window" })).toHaveCount(0);
  expect(await overlay.locator("iframe,canvas").count()).toBe(0);
  expect(await page.locator(".stage .work-overlay").count()).toBe(0);
  const assertFits = async () => {
    const panel = await overlay.boundingBox();
    const stage = await page.locator(".watch .stage-box").boundingBox();
    if (!panel || !stage) throw new Error("missing geometry");
    expect(panel.x).toBeGreaterThanOrEqual(stage.x);
    expect(panel.y).toBeGreaterThanOrEqual(stage.y);
    expect(panel.x + panel.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
    expect(panel.y + panel.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
  };
  const handle = page.getByRole("button", { name: "Move command window" });
  for (const point of [
    { x: 0, y: 0 },
    { x: 1400, y: 0 },
    { x: 1400, y: 890 },
    { x: 0, y: 890 },
  ]) {
    const box = await handle.boundingBox();
    if (!box) throw new Error("missing handle");
    await page.mouse.move(box.x + 15, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await page.mouse.up();
    await assertFits();
  }
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Hide commands", exact: true }).click();
  await expect(overlay).toBeHidden();
  await page.reload();
  await ui.picture();
  await expect(overlay).toBeHidden();
  await expect(page.getByRole("button", { name: "Show commands", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show commands", exact: true }).click();
  await expect(overlay).toBeVisible();
  await assertFits();
  if ((page.viewportSize()?.width ?? 0) < 700) {
    for (const size of [
      { width: 320, height: 640 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(size);
      await assertFits();
    }
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.screenshot({ path: test.info().outputPath("work-menu.png") });
});

test("dragging the command handle does not scroll the page", async ({ page, ui }) => {
  await ui.open("running");
  await ui.picture();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show commands", exact: true }).click();
  const handle = page.getByRole("button", { name: "Move command window" });
  await expect(handle).toBeVisible();
  const positions = () =>
    page.evaluate(() => [
      window.scrollY,
      ...Array.from(document.querySelectorAll(".watch, .stage-col, .thread-body")).map(
        (node) => node.scrollTop,
      ),
    ]);
  const before = await positions();
  // All engines must prevent the legacy touchmove default, including Safari.
  expect(
    await handle.evaluate((node) => {
      const event = new Event("touchmove", { bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  expect(await handle.evaluate((node) => getComputedStyle(node).touchAction)).toBe("none");
  if (test.info().project.name === "c39") {
    const box = await handle.boundingBox();
    if (!box) throw new Error("missing handle");
    const client = await page.context().newCDPSession(page);
    const x = box.x + 20,
      y = box.y + 20;
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let n = 1; n <= 8; n++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + n * 3, y: y - n * 8 }],
      });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await client.detach();
  }
  expect(await positions()).toEqual(before);
});
