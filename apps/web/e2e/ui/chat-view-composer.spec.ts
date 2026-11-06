import type { Page } from "@playwright/test";
import { composer, expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ viewStyle: "chat" });

for (const width of [320, 390, 430]) {
  test(`mobile composer keeps model controls together at ${width}px`, async ({ page, ui }) => {
    await page.setViewportSize({ width, height: 844 });
    await ui.open("running");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const card = await composer(page);
    const box = card.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("Check this page");
    const row = await card.locator(".composer-bar").boundingBox();
    for (const control of [card.locator(".composer-model"), card.locator(".composer-send")]) {
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

const viewport = (page: Page, height: number, offsetTop = 0) =>
  page.evaluate(
    ({ height, offsetTop }) => {
      const view = window.visualViewport;
      if (!view) throw new Error("Visual viewport required");
      Object.defineProperty(view, "height", { configurable: true, value: height });
      Object.defineProperty(view, "offsetTop", { configurable: true, value: offsetTop });
      view.dispatchEvent(new Event("resize"));
      view.dispatchEvent(new Event("scroll"));
    },
    { height, offsetTop },
  );

// The foot of the toolbar, against a given line.
const toolbarFoot = async (page: Page) => {
  const rect = await page.locator(".thread-toolbar").boundingBox();
  return Math.round((rect?.y ?? 0) + (rect?.height ?? 0));
};

test("the keyboard shrinks the app, so the composer rides on it and the thread keeps its end", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const app = page.locator(".app");
  const scroll = page.locator(".thread-scroll");
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await field.focus();
  // Below a keyboard's height it is Safari's toolbars; the home indicator's room stays.
  for (const covered of [0, 60, 119]) {
    await viewport(page, 844 - covered);
    await expect.poll(() => toolbarFoot(page)).toBe(844 - covered);
    await expect(app).not.toHaveAttribute("data-keyboard-up");
  }
  for (const covered of [121, 200, 310]) {
    await viewport(page, 844 - covered);
    await expect(app).toHaveAttribute("data-keyboard-up");
    await expect.poll(() => toolbarFoot(page)).toBe(844 - covered);
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(2);
  }
  // Safari pans the page to reveal the caret: the shell follows the visible part.
  for (const offset of [45, 240]) {
    await viewport(page, 534, offset);
    await expect.poll(() => toolbarFoot(page)).toBe(534 + offset);
    await expect(field).toBeFocused();
    const visible = await field.evaluate((input) => {
      const rect = input.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
    });
    expect(visible, "the composer must be hittable, not clipped").toBe(true);
  }
  await viewport(page, 844);
  await expect(app).not.toHaveAttribute("data-keyboard-up");
  await expect.poll(() => toolbarFoot(page)).toBe(844);
  await expect(field).toBeFocused();
});

// As an iPhone's Safari reports it: the pan that reveals the field also comes off innerHeight, so
// innerHeight less the visual viewport stops measuring the keyboard once the page has panned.
const panned = (page: Page, height: number, offsetTop: number, inner = 844 - offsetTop) =>
  page.evaluate(
    ({ height, offsetTop, inner }) => {
      const view = window.visualViewport;
      if (!view) throw new Error("Visual viewport required");
      Object.defineProperty(view, "height", { configurable: true, value: height });
      Object.defineProperty(view, "offsetTop", { configurable: true, value: offsetTop });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: inner });
      view.dispatchEvent(new Event("resize"));
      view.dispatchEvent(new Event("scroll"));
    },
    { height, offsetTop, inner },
  );

test("however far Safari pans, the composer sits on the keyboard and the top bar stays", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const app = page.locator(".app");
  await expect(app).not.toHaveAttribute("data-entering");
  const bar = page.locator(".phone-chat-bar");
  const field = (await composer(page)).getByRole("textbox", { name: "Message", exact: true });
  await field.focus();
  for (const offset of [20, 92, 163, 269, 277]) {
    await panned(page, 534, offset);
    await expect(app).toHaveAttribute("data-keyboard-up");
    await expect.poll(() => toolbarFoot(page)).toBe(534 + offset);
    await expect.poll(async () => (await bar.boundingBox())?.y).toBe(offset);
  }
  // The keyboard goes with the focus: WebKit puts innerHeight back at once and says nothing of the
  // visual viewport until the keyboard has gone. The page pans back as one piece, not a shell
  // shifted by a pan that has ended.
  await field.blur();
  await panned(page, 534, 277, 844);
  await expect(app).not.toHaveAttribute("data-keyboard-up", { timeout: 500 });
  await expect.poll(() => toolbarFoot(page), { timeout: 500 }).toBe(844);
  await expect.poll(async () => (await bar.boundingBox())?.y, { timeout: 500 }).toBe(0);
  await panned(page, 844, 0);
  await expect.poll(() => toolbarFoot(page)).toBe(844);
  await expect.poll(async () => (await bar.boundingBox())?.y).toBe(0);
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
  await viewport(page, 300, 220);
  await expect(page.locator(".app")).toHaveAttribute("data-keyboard-up");
  await expect
    .poll(async () => {
      const rect = await field.boundingBox();
      return !!rect && rect.y >= 220 && rect.y + rect.height <= 520;
    })
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

test("keyboard recovery tolerates a stale pan and reopening without another focus event", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const app = page.locator(".app");
  await expect(app).not.toHaveAttribute("data-entering");
  const field = (await composer(page)).getByRole("textbox", { name: "Message", exact: true });
  await field.fill("Keep this draft visible");
  await viewport(page, 534, 240);
  await expect(app).toHaveAttribute("data-keyboard-up");
  await expect.poll(() => toolbarFoot(page)).toBe(774);
  // WebKit can retain the old pan after the keyboard has gone away.
  await viewport(page, 844, 240);
  await expect(app).not.toHaveAttribute("data-keyboard-up");
  await expect
    .poll(() => app.evaluate((e) => e.style.getPropertyValue("--_visible-top")))
    .toBe("0px");
  // The textarea can stay focused while the OS dismisses and reopens the keyboard.
  for (const height of [784, 534]) {
    await viewport(page, height, 0);
    await expect.poll(() => toolbarFoot(page)).toBe(height);
  }
  await expect(field).toHaveValue("Keep this draft visible");
  // Ignore transient unusable geometry while the tab is suspended, then recover on pageshow.
  await viewport(page, 0, 844);
  await page.waitForTimeout(100);
  expect(await toolbarFoot(page)).toBe(534);
  await page.evaluate(() => {
    const view = window.visualViewport;
    if (!view) throw new Error("Visual viewport required");
    Object.defineProperty(view, "height", { configurable: true, value: 844 });
    Object.defineProperty(view, "offsetTop", { configurable: true, value: 240 });
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect(app).not.toHaveAttribute("data-keyboard-up");
  await expect(field).toBeVisible();
});

test("a viewport left short after the keyboard has gone opens no gap under the toolbar", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const app = page.locator(".app");
  const field = (await composer(page)).getByRole("textbox", { name: "Message", exact: true });
  await page.request.post(`${fixture.origin}/__qa/stream?ms=4000`);
  await field.focus();
  await viewport(page, 544);
  await expect(app).toHaveAttribute("data-keyboard-up");
  await expect.poll(() => toolbarFoot(page)).toBe(544);
  // The keyboard goes with the field's focus, and WebKit never says the viewport has grown back.
  await field.blur();
  await expect.poll(() => toolbarFoot(page), { timeout: 4000 }).toBe(844);
  await expect(app).not.toHaveAttribute("data-keyboard-up");
  await expect.poll(async () => (await app.boundingBox())?.height).toBe(844);
  // Typing again takes the toolbar back up to the keyboard.
  await field.focus();
  await viewport(page, 543);
  await expect.poll(() => toolbarFoot(page)).toBe(543);
});

test("with the keyboard up, the composer sits on it with no room for the home indicator", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Safe areas are emulated through Chromium's DevTools");
  await ui.open("running");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send(
    "Emulation.setSafeAreaInsetsOverride" as never,
    { insets: { top: 47, right: 0, bottom: 34, left: 0 } } as never,
  );
  const toolbar = page.locator(".thread-toolbar");
  const pad = () => toolbar.evaluate((element) => getComputedStyle(element).paddingBottom);
  await expect.poll(pad).toBe("22.1px");
  const field = (await composer(page)).getByRole("textbox", { name: "Message", exact: true });
  await field.focus();
  await viewport(page, 524);
  await expect.poll(pad).toBe("8px");
});
