import { composer, expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");

for (const width of [320, 390, 430]) {
  test(`mobile composer keeps model controls together at ${width}px`, async ({ page, ui }) => {
    await page.setViewportSize({ width, height: 844 });
    await ui.open("running");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const card = await composer(page);
    const box = card.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("Check this page");
    const row = await card.locator(".composer-bar").boundingBox();
    for (const control of [
      card.locator(".composer-model"),
      card.locator(".composer-send"),
      card.getByRole("button", { name: "Attach files" }),
    ]) {
      const rect = await control.boundingBox();
      expect(
        rect && row && Math.abs(rect.y + rect.height / 2 - row.y - row.height / 2),
      ).toBeLessThanOrEqual(2);
      expect(
        rect && row && rect.x >= row.x - 1 && rect.x + rect.width <= row.x + row.width + 1,
      ).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath(`composer-${width}.png`) });
    await card.locator(".composer-model").click();
    await expect(page.getByRole("dialog", { name: "Model and thinking" })).toBeVisible();
  });
}

test("the keyboard lifts only the composer and restores it on dismissal", async ({ page, ui }) => {
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const app = page.locator(".app");
  const stage = page.locator(".stage-col");
  const before = await stage.boundingBox();
  const height = (await app.boundingBox())?.height;
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await field.focus();
  for (const offset of [0, 45, 240]) {
    await page.evaluate((offsetTop) => {
      const view = window.visualViewport;
      if (!view) throw new Error("Visual viewport required");
      Object.defineProperty(view, "height", { configurable: true, value: innerHeight - 310 });
      Object.defineProperty(view, "offsetTop", { configurable: true, value: offsetTop });
      view.dispatchEvent(new Event("resize"));
      view.dispatchEvent(new Event("scroll"));
    }, offset);
    await expect(app).toHaveAttribute("data-composer-keyboard", "");
    await expect.poll(async () => (await app.boundingBox())?.height).toBe(height);
    await expect
      .poll(async () => {
        const during = await stage.boundingBox();
        return during && { ...during, y: during.y - offset };
      })
      .toEqual(before);
    await expect
      .poll(async () => {
        const rect = await page.locator(".thread-toolbar").boundingBox();
        return Math.round((rect?.y ?? 0) + (rect?.height ?? 0));
      })
      .toBe(844 - 310 + offset);
    await expect(field).toBeFocused();
    const visible = await field.evaluate((input) => {
      const rect = input.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
    });
    expect(visible, "the composer must be hittable, not clipped by its rail").toBe(true);
  }
  // iOS can scroll the document while revealing the caret. This must not pan the shell.
  await page.evaluate(() => {
    document.body.style.minHeight = "1600px";
    window.scrollTo(0, 180);
    window.visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => (await stage.boundingBox())?.y).toBe((before?.y ?? 0) + 240);
  // Other mobile browsers shrink both viewport measurements. Position from the
  // visible bottom, rather than subtracting a keyboard inset from innerHeight.
  await page.evaluate(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 534 });
    window.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => (await app.boundingBox())?.height).toBe(height);
  await expect
    .poll(async () => {
      const rect = await page.locator(".thread-toolbar").boundingBox();
      return Math.round((rect?.y ?? 0) + (rect?.height ?? 0));
    })
    .toBe(774);
  await page.screenshot({ path: test.info().outputPath("keyboard-open.png") });
  await page.evaluate(() => {
    document.body.style.removeProperty("min-height");
    window.scrollTo(0, 0);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    const view = window.visualViewport;
    if (!view) throw new Error("Visual viewport required");
    Object.defineProperty(view, "height", { configurable: true, value: innerHeight });
    Object.defineProperty(view, "offsetTop", { configurable: true, value: 0 });
    view.dispatchEvent(new Event("resize"));
  });
  await expect(app).not.toHaveAttribute("data-composer-keyboard");
  await expect
    .poll(async () => {
      const rect = await page.locator(".thread-toolbar").boundingBox();
      return Math.round((rect?.y ?? 0) + (rect?.height ?? 0));
    })
    .toBe(844);
  expect(await stage.boundingBox()).toEqual(before);
});

test("the composer stays visible above a tall keyboard on a short phone viewport", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await field.focus();
  await page.evaluate(() => {
    const view = window.visualViewport;
    if (!view) throw new Error("Visual viewport required");
    Object.defineProperty(view, "height", { configurable: true, value: 300 });
    Object.defineProperty(view, "offsetTop", { configurable: true, value: 220 });
    view.dispatchEvent(new Event("resize"));
    view.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".app")).toHaveAttribute("data-composer-keyboard", "");
  await expect
    .poll(async () => {
      const rect = await field.boundingBox();
      return !!rect && rect.y >= 220 && rect.y + rect.height <= 520;
    })
    .toBe(true);
  await expect
    .poll(() =>
      field.evaluate((input) => {
        const rect = input.getBoundingClientRect();
        return (
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input
        );
      }),
    )
    .toBe(true);
  await field.fill("Keep the input visible");
  await expect(field).toBeFocused();
  for (const control of [card.locator(".composer-send"), card.locator(".composer-model")]) {
    await expect
      .poll(() =>
        control.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          );
        }),
      )
      .toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("short-phone-keyboard.png") });
});
