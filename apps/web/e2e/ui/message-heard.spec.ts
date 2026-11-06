import type { Page } from "@playwright/test";
import { composer, expect, runAt, test } from "./harness.ts";

// What dot set aside to read a message says so under it, at every size and in both modes.
runAt("c14", "c39", "w14", "w39");

const yours = (page: Page, text: string) =>
  page.getByRole("article", { name: "You", exact: true }).filter({ hasText: text });

for (const appearance of ["graphite", "daylight"] as const) {
  test.describe(appearance, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((choice) => {
        localStorage.setItem("localdot.appearance.v1", choice);
      }, appearance);
    });

    test("a message says when it woke dot, and when dot left a command running", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("running");
      await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
      const card = await composer(page);
      const field = card.getByRole("textbox", { name: "Message", exact: true });
      const send = async (text: string) => {
        await field.fill(text);
        const sent = page.locator(".thread-pending, .thread-message").filter({ hasText: text });
        await expect(async () => {
          if (!(await sent.count()))
            await card.getByRole("button", { name: "Send now" }).click({ timeout: 2000 });
          await expect(yours(page, text)).toHaveCount(1, { timeout: 2000 });
        }).toPass({ timeout: 60_000 });
      };

      await send("Skip the wait and check the page now");
      const woke = yours(page, "Skip the wait");
      await expect(woke.getByText("Sent while working")).toBeVisible();
      const heard = await page.request.post(`${fixture.origin}/__qa/message-heard?state=woke`);
      expect(heard.ok()).toBe(true);
      await expect(woke.getByText("dot stopped waiting to read this")).toBeVisible();
      await expect(woke.getByRole("button", { name: "Steer now" })).toHaveCount(0);

      await send("Also add the changelog while that builds");
      const left = yours(page, "Also add the changelog");
      const running = await page.request.post(
        `${fixture.origin}/__qa/message-heard?state=left_running`,
      );
      expect(running.ok()).toBe(true);
      const tag = left.getByText("dot left its command running to read this");
      await expect(tag).toBeVisible();
      // It fits its row, whatever the width.
      const box = await tag.boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
      await page.locator(".thread").evaluate((thread) =>
        Promise.all(
          thread
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      await page.screenshot({
        path: test.info().outputPath(`heard-${appearance}.png`),
      });
    });
  });
}
