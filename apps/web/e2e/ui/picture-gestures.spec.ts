import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test("pinch from Fit zooms the image, not the page or another file", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Real multitouch injection uses CDP");
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/previews`);
  const card = page.getByRole("region", { name: "Task result" }).last();
  await card.getByRole("button", { name: "Open chart.png", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "chart.png" });
  const picture = sheet.locator(".viewer-picture");
  const canvas = sheet.locator(".viewer-canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await ui.settle();
  const scale = () => canvas.evaluate((n) => new DOMMatrix(getComputedStyle(n).transform).a);
  const fitted = await scale();
  const box = await picture.boundingBox();
  if (!box) throw new Error("Picture is not visible");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, x: x - 35, y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: x - 35, y },
      { id: 2, x: x + 35, y },
    ],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { id: 1, x: x - 35 - i * 9, y },
        { id: 2, x: x + 35 + i * 9, y },
      ],
    });
  }
  await expect.poll(scale).toBeGreaterThan(fitted * 2);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(sheet).toBeVisible();
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  await page.screenshot({ path: test.info().outputPath("pinched.png") });
  const enlarged = await scale();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: x - 100, y },
      { id: 2, x: x + 100, y },
    ],
  });
  for (let i = 1; i <= 8; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { id: 1, x: x - 100 + i * 8, y },
        { id: 2, x: x + 100 - i * 8, y },
      ],
    });
  await expect.poll(scale).toBeLessThan(enlarged * 0.6);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sheet.getByRole("radio", { name: "Fit", exact: true }).click();
  await expect.poll(scale).toBeCloseTo(fitted, 2);
  await cdp.detach();
});
