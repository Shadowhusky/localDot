import type { Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

test.use({ viewStyle: "chat", phoneList: true });

const look = (page: Page, appearance: string) =>
  page.addInitScript((value) => localStorage.setItem("localdot.appearance.v1", value), appearance);

test.describe("a touch tablet", () => {
  runAt("c39");
  test.use({ viewport: { width: 820, height: 1180 } });

  test("a touch tablet shows the list beside the conversation", async ({ page, ui }) => {
    await ui.open("running");
    const stack = page.locator(".phone-stack");
    await expect(stack).toHaveAttribute("data-split");
    const list = await page.locator(".phone-list").boundingBox();
    const chat = await page.locator(".phone-chat").boundingBox();
    expect(list?.width).toBeGreaterThanOrEqual(300);
    expect(list?.width).toBeLessThanOrEqual(368);
    expect(chat?.x).toBe(list?.width);
    await expect(page.getByPlaceholder("Message dot")).toBeVisible();
    await expect(page.locator(".phone-row").first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("split.png") });
    await page.getByRole("button", { name: "Show or hide the list" }).click();
    await expect(stack).toHaveAttribute("data-list-hidden");
    await page.getByRole("button", { name: "Show or hide the list" }).click();
    await expect(stack).not.toHaveAttribute("data-list-hidden");
    await page.locator(".phone-thumb").click();
    await expect(page.getByRole("button", { name: "Take control" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("split-computer.png") });
  });
});

test.describe("a desktop", () => {
  runAt("c14", "w14");

  for (const { width, height, appearance } of [
    { width: 1440, height: 900, appearance: "graphite" },
    { width: 1920, height: 1080, appearance: "daylight" },
    { width: 1100, height: 700, appearance: "daylight" },
    { width: 760, height: 700, appearance: "graphite" },
  ]) {
    test(`at ${width} by ${height}, ${appearance}: the list beside a thread of a readable width, the computer over it`, async ({
      page,
      ui,
    }) => {
      await page.setViewportSize({ width, height });
      await look(page, appearance);
      await ui.open("running");
      await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
      const stack = page.locator(".phone-stack");
      await expect(stack).toHaveAttribute("data-split");
      const chat = await page.locator(".phone-chat").boundingBox();
      if (!chat) throw new Error("No conversation");
      const field = await page.getByPlaceholder("Message dot").boundingBox();
      const content = await page.locator(".phone-thread .thread-content").boundingBox();
      // A wide window gives the thread room, up to a measure that still reads.
      expect(content?.width).toBeLessThanOrEqual(960);
      expect(content?.width).toBeGreaterThanOrEqual(Math.min(960, chat.width - 48));
      expect((field?.x ?? 0) + (field?.width ?? 0)).toBeLessThanOrEqual(chat.x + chat.width);
      await ui.settle();
      await page.screenshot({ path: test.info().outputPath("thread.png") });

      await page.locator(".phone-thumb").click();
      await expect(page.getByRole("button", { name: "Take control" })).toBeVisible();
      await ui.settle();
      const picture = await page.locator(".phone-picture").boundingBox();
      expect(picture?.x).toBeGreaterThanOrEqual(chat.x);
      expect((picture?.x ?? 0) + (picture?.width ?? 0)).toBeLessThanOrEqual(chat.x + chat.width);
      expect((picture?.y ?? 0) + (picture?.height ?? 0)).toBeLessThan(height - 120);
      await expect(page.locator(".phone-row").first()).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("computer.png") });
      await page.getByRole("button", { name: "Back to the conversation" }).click();
      await expect(stack).not.toHaveAttribute("data-level", "2");
    });
  }

  // With the list put away, the computer pill and its Settings go with it: the conversation's ⋯
  // has them too.
  test("the conversation's ⋯ opens Settings, with the list put away", async ({ page, ui }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ui.open("done");
    await page.locator(".phone-chat-bar").getByRole("button").first().click();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-list-hidden");
    await page.getByRole("button", { name: "More", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  // A long reply uses the room a wide window has, as a messenger's does, and a short one stays short.
  test("a long reply takes the room a wide window gives it", async ({ page, ui }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await ui.open("running");
    const words = "The totals line up with the sheet once the returns are taken off each month, ";
    await page.request.post(
      `${fixture.origin}/__qa/say?text=${encodeURIComponent(words.repeat(6).trim())}`,
    );
    const thread = page.locator(".phone-thread");
    const long = thread
      .locator(".thread-message[data-role='dot']")
      .filter({ hasText: words.trim() });
    await expect(long).toBeVisible();
    const column = await thread.locator(".thread-content").boundingBox();
    const box = await long.boundingBox();
    if (!column || !box) throw new Error("Nothing to measure");
    expect(box.width).toBeGreaterThanOrEqual(700);
    expect(box.width).toBeLessThanOrEqual(column.width * 0.86 + 1);
    await page.screenshot({ path: test.info().outputPath("long-reply.png") });
  });

  // Nov 12: with the user holding the web browser, the sign-in offer under the controls stood
  // narrower than the picture and ran off the bottom of the window, the message box with it.
  for (const { width, height, saved } of [
    { width: 1645, height: 957, saved: false },
    { width: 1440, height: 900, saved: true },
    { width: 1100, height: 700, saved: true },
  ]) {
    test(`at ${width} by ${height}, what waits on a user holding the browser sits under the controls, within the window${saved ? ", with a saved login" : ""}`, async ({
      page,
      ui,
    }) => {
      await page.setViewportSize({ width, height });
      await page.route("**/takeover/sign-in", (route) =>
        route.fulfill({
          status: 200,
          json: {
            available: true,
            mode: "standard",
            changing: false,
            ...(saved
              ? { page: { saved: { site: "github.com", username: "henry@example.com" } } }
              : {}),
          },
          headers: { "content-type": "application/json" },
        }),
      );
      const fixture = await ui.open("running");
      await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
      await page.locator(".phone-thumb").click();
      const controls = page.locator(".phone-computer-controls");
      await controls.getByRole("button", { name: "Take control" }).click();
      const handBack = controls.getByRole("button", { name: "Hand back" });
      await expect(handBack).toBeVisible();
      expect((await page.request.post(`${fixture.origin}/__qa/screen?to=browser`)).ok()).toBe(true);
      const panel = page.locator(".phone-computer-dock .thread-browser-signin");
      await expect(
        panel.getByRole("button", { name: "Sign in without agent control" }),
      ).toBeVisible();
      await ui.settle();
      const box = await panel.boundingBox();
      const field = await page.locator(".phone-computer-dock textarea").boundingBox();
      const first = await controls.getByRole("button").first().boundingBox();
      const last = await handBack.boundingBox();
      const picture = await page.locator(".phone-picture").boundingBox();
      if (!box || !field || !first || !last || !picture) throw new Error("Nothing to measure");
      await page.screenshot({ path: test.info().outputPath("holding-browser.png") });
      // Under the picture, at the width of its controls.
      expect(box.y).toBeGreaterThan(picture.y + picture.height);
      expect(Math.abs(box.x - first.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.x + box.width - (last.x + last.width))).toBeLessThanOrEqual(1);
      // All of it on the screen, and the message box under it with room to spare.
      expect(box.y + box.height).toBeLessThanOrEqual(field.y);
      expect(field.y + field.height).toBeLessThanOrEqual(height - 8);
      // The picture gives way to it: none of it is squeezed into scrolling.
      expect(
        await panel.evaluate((element) => element.scrollHeight - element.clientHeight),
      ).toBeLessThanOrEqual(0);
      // An offer, not a page of reading: a row for each thing it offers.
      expect(box.height).toBeLessThanOrEqual(saved ? 200 : 130);
    });
  }

  test("a mouse selects text, and a right click opens what a hold would", async ({ page, ui }) => {
    await ui.open("done");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const reply = page.locator('.phone-thread .thread-message[data-role="dot"]').first();
    expect(await reply.evaluate((element) => getComputedStyle(element).userSelect)).not.toBe(
      "none",
    );
    const box = await reply.boundingBox();
    if (!box) throw new Error("No reply");
    // A drag across a reply is a selection, not a way back.
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", /^[01]$/);
    await reply.click({ button: "right" });
    await expect(page.getByRole("menu", { name: "Message actions" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".phone-row").first().click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: /Pin|Unpin/ })).toBeVisible();
  });

  test("Replay comes up with the top bar, and back", async ({ page, ui }) => {
    await ui.open("done");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    await page.getByRole("button", { name: "See all in Replay" }).click();
    await expect(page.getByRole("textbox", { name: "Search recordings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-split");
  });
});
