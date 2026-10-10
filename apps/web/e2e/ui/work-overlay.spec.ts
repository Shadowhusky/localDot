import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("command overlay moves, minimizes, survives reload and never joins the stream", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await ui.picture();
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const overlay = page.getByRole("region", { name: "Background work", exact: true });
  await expect(overlay).toBeVisible();
  const expand = page.getByRole("button", { name: "Expand command window" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.getByRole("region", { name: "Recent command output" })).toBeVisible();
  expect(await overlay.locator("iframe,canvas").count()).toBe(0);
  expect(await page.locator(".stage .work-overlay").count()).toBe(0);
  const assertFits = async () => {
    const panel = await overlay.boundingBox();
    const stage = await page.locator(".watch .stage-box").boundingBox();
    expect(panel).not.toBeNull();
    expect(stage).not.toBeNull();
    if (!panel || !stage) throw new Error("missing geometry");
    expect(panel.x).toBeGreaterThanOrEqual(stage.x);
    expect(panel.y).toBeGreaterThanOrEqual(stage.y);
    expect(panel.x + panel.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
    expect(panel.y + panel.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
    expect(
      await page
        .locator(".work-overlay-header")
        .evaluate((node) => node.getBoundingClientRect().height),
    ).toBeCloseTo(
      (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) ? 44 : 36,
      2,
    );
  };
  await assertFits();
  const handle = page.getByRole("button", { name: "Move command window" });
  await handle.focus();
  await handle.press("ArrowUp");
  await handle.press("ArrowRight");
  await page.getByRole("button", { name: "Minimize command window" }).click();
  await expect(expand).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error("missing handle");
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 85, box.y - 80, { steps: 8 });
  await page.mouse.up();
  await assertFits();
  expect((await overlay.boundingBox())?.width).toBeLessThanOrEqual(168);
  // Both sizes must stay inside the actual computer, even when dragged beyond every corner.
  for (const expanded of [false, true]) {
    if (expanded) await expand.click();
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
  }
  await page.getByRole("button", { name: "Minimize command window" }).click();
  await page.screenshot({ path: `e2e/out/work-overlay-compact-${test.info().project.name}.png` });
  const saved = await page.evaluate(() => localStorage.getItem("localdot.work-overlay.v1"));
  await page.reload();
  await ui.picture();
  await expect(expand).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("localdot.work-overlay.v1"))).toBe(saved);
  await expand.click();
  await assertFits();
  if (test.info().project.name === "c14") {
    await overlay.screenshot({ path: "/tmp/localdot-floating-work.png" });
  }
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
  await page.screenshot({ path: `e2e/out/work-overlay-${test.info().project.name}.png` });
});
