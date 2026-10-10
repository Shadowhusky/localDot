import { expect, type Page } from "@playwright/test";
import { reach } from "./reach.ts";

// A phone has no top bar and keeps Activity in a sheet over the thread.
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 700;

// Activity: a view of the rail beside the stage, or a sheet on a phone.
export async function showActivity(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else await page.getByRole("radio", { name: "Activity", exact: true }).click();
  return page.getByRole("complementary", { name: "Plan and steps" });
}

// Back to the chat: the rail's first view, or the thread under a phone's Activity sheet.
export async function showChat(page: Page) {
  if (isPhone(page)) {
    const sheet = page.getByRole("dialog", { name: "Activity" });
    if (await sheet.isVisible()) {
      await sheet.getByRole("button", { name: "Done", exact: true }).click();
      await expect(sheet).toBeHidden();
    }
  } else await page.getByRole("radio", { name: "Chat", exact: true }).click();
  return page.getByRole("complementary", { name: "Conversation" });
}

// The page fits the screen, and the island's Shut down takes a finger without scrolling.
export async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await page.locator(".app").boundingBox();
  expect(box?.height).toBe(await page.evaluate(() => innerHeight));
  const stop = page.locator(".island").getByRole("button", { name: "Shut down", exact: true });
  await expect(stop).toBeVisible();
  await expect.poll(() => stop.evaluate(reach)).toEqual({ width: 44, height: 44 });
  const touch = await stop.boundingBox();
  expect((touch?.y ?? Infinity) + (touch?.height ?? Infinity)).toBeLessThanOrEqual(
    await page.evaluate(() => innerHeight),
  );
}
