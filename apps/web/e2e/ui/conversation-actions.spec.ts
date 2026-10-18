import type { Locator, Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w14");

// Visibility alone allows clipped buttons to pass. Check their full hit areas, including the
// corners nearest the rounded panel edge, and then use each action through its normal UI.
async function reachable(page: Page, button: Locator) {
  await expect(button).toBeVisible();
  const panel = await page.locator(".rail-chat").boundingBox();
  const box = await button.boundingBox();
  if (!panel || !box) throw new Error("Missing conversation panel or action");
  expect(box.width).toBeGreaterThanOrEqual(32);
  expect(box.height).toBeGreaterThanOrEqual(32);
  expect(box.x).toBeGreaterThanOrEqual(panel.x);
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
  expect(box.y).toBeGreaterThanOrEqual(panel.y);
  expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height);
  expect(
    await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const corners: [number, number][] = [
        [rect.left + 4, rect.top + 4],
        [rect.right - 4, rect.top + 4],
        [rect.left + 4, rect.bottom - 4],
        [rect.right - 4, rect.bottom - 4],
      ];
      return corners.every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    }),
  ).toBe(true);
}

for (const width of [320, 336, 368]) {
  test(`both conversation actions fit and work in a ${width}px panel`, async ({ page, ui }) => {
    await page.addInitScript((width) => {
      localStorage.setItem("localdot.width.chat", String(width));
    }, width);
    await ui.open("continued");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    await ui.settle();
    const header = page.locator(".rail-chat > .rail-head");
    const conversations = header.getByRole("button", { name: "Conversations", exact: true });
    const create = header.getByRole("button", { name: "New conversation", exact: true });
    await reachable(page, conversations);
    await reachable(page, create);
    // The supported minimum panel width still fits on a single compact row.
    expect((await header.boundingBox())?.height).toBe(56);
    const tabs = await header.getByRole("radiogroup").boundingBox();
    const actions = await header.locator(".rail-actions").boundingBox();
    if (!tabs || !actions) throw new Error("Missing header controls");
    expect(tabs.x + tabs.width + 4).toBeLessThanOrEqual(actions.x);
    for (const tab of await header.getByRole("radio").all()) {
      const box = await tab.boundingBox();
      if (!box) throw new Error("Missing tab");
      expect(box.x + box.width).toBeLessThanOrEqual(tabs.x + tabs.width + 0.5);
      expect(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    }
    await page.screenshot({ path: test.info().outputPath("conversation-header.png") });
    await conversations.click();
    await expect(page.getByRole("dialog", { name: "Conversations", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await create.click();
    await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
  });
}

test("conversation actions stay reachable while resizing past the minimum", async ({
  page,
  ui,
}) => {
  await ui.open("continued");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await ui.settle();
  const handle = await page.locator(".rail-resize-chat").boundingBox();
  if (!handle) throw new Error("Missing panel resize handle");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const distance of [20, 48, 80, 160, 400, 0]) {
    await page.mouse.move(x + distance, y);
    const header = page.locator(".rail-chat > .rail-head");
    for (const name of ["Conversations", "New conversation"]) {
      await reachable(page, header.getByRole("button", { name, exact: true }));
    }
  }
  await page.mouse.up();
});
