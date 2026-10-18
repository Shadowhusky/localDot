import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ reducedMotion: "no-preference" });

test("long key requests scroll to every control and expand by drag or button", async ({
  page,
  ui,
  browserName,
}) => {
  const fixture = await ui.open("running");
  expect((await page.request.post(`${fixture.origin}/__qa/ask?fields=servicekey`)).ok()).toBe(true);
  const sheet = page.locator(".decision-sheet");
  const scroller = sheet.locator(".decision-sheet-content");
  await expect(sheet.getByRole("textbox", { name: "API key", exact: true })).toBeAttached();
  await sheet.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((a) => a.finished.catch(() => {})));
  });
  // The fixed mascot lives above the stage but must remain behind the question surface.
  expect(
    await sheet.evaluate((e) => {
      const mascot = document.querySelector(".presence");
      return (
        !mascot || Number(getComputedStyle(e).zIndex) > Number(getComputedStyle(mascot).zIndex)
      );
    }),
  ).toBe(true);
  const before = await sheet.boundingBox();
  if (!before) throw new Error("Missing sheet");
  expect(await scroller.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const box = await scroller.boundingBox();
    if (!box) throw new Error("Missing scroll area");
    for (let swipe = 0; swipe < 5; swipe++) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height - 30;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - step * 30 }],
        });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    await cdp.detach();
  }
  await scroller.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  const save = sheet.getByRole("button", { name: "Save and continue", exact: true });
  const decline = sheet.getByRole("button", { name: "Not now", exact: true });
  await expect(save).toBeInViewport({ ratio: 1 });
  await expect(decline).toBeInViewport({ ratio: 1 });
  // Real pointer movement exercises the same gesture path as touch; scrolling owns the body.
  const handle = await sheet.locator(".decision-sheet-handle").boundingBox();
  if (!handle) throw new Error("Missing drag handle");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 15; step++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + ((30 - y) * step) / 15 }],
      });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, 30, { steps: 15 });
    await page.mouse.up();
  }
  await expect(sheet).toHaveAttribute("data-expanded", "");
  const expanded = await sheet.boundingBox();
  expect(expanded?.height).toBeGreaterThan(before.height + 100);
  expect(expanded?.y).toBeLessThan(30);
  await sheet.getByRole("button", { name: "Collapse question" }).click();
  await expect(sheet).not.toHaveAttribute("data-expanded");
  await sheet.getByRole("button", { name: "Expand question" }).click();
  await expect(sheet).toHaveAttribute("data-expanded", "");
  const input = sheet.getByRole("textbox", { name: "API key", exact: true });
  await input.fill("synthetic-test-only");
  await page.evaluate(() => {
    const view = window.visualViewport;
    if (!view) throw new Error("Missing viewport");
    Object.defineProperty(view, "height", { configurable: true, value: innerHeight - 310 });
    view.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => (await sheet.boundingBox())?.height ?? 9999).toBeLessThan(550);
  await scroller.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await expect(save).toBeInViewport({ ratio: 1 });
  const savedBox = await save.boundingBox();
  if (!savedBox) throw new Error("Missing save button");
  expect(savedBox.y + savedBox.height).toBeLessThan(844 - 310);
  await page.screenshot({ path: test.info().outputPath("key-request-keyboard.png") });
  await decline.click();
  await expect(sheet).toHaveCount(0);
});

test("short landscape sheets keep approval actions reachable", async ({ page, ui }) => {
  await page.setViewportSize({ width: 600, height: 360 });
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/approval?kind=delete`);
  const sheet = page.locator(".decision-sheet");
  await sheet.getByRole("button", { name: "Expand question" }).click();
  const action = sheet.getByRole("button", { name: "Delete", exact: true });
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeInViewport({ ratio: 1 });
  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/approvals/answer"),
  );
  await action.click();
  expect((await sent).postDataJSON()).toMatchObject({ decision: "approve" });
  await expect(sheet).toHaveCount(0);
});
