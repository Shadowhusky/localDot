import type { Page } from "@playwright/test";
import { expect, keepBaselinesAt, test } from "./harness.ts";

// Replay's states beyond its first picture (screens.spec.ts): a task with no video once its card has
// become a chip in the transport, and the task library opened from the bar.
keepBaselinesAt("c14", "w14", "w39");

const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => null)),
    ),
  );

test("replay, no video", async ({ page, ui }) => {
  await ui.open("done", (fixture) => `/?replay=${fixture.sessionId}`);
  const controls = page.getByRole("group", { name: "Playback controls" });
  await expect(controls.getByText("No video", { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".replay-gap-card")).toBeHidden();
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("replay-no-video.png");
});

test("tasks library", async ({ page, ui }) => {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=20000`);
  await expect(page.getByRole("status", { name: "Replay time" })).toHaveText("0:20 / 3:00");
  await ui.picture(page.locator(".replay-stage"));
  await page.getByRole("button", { name: /^All tasks/ }).click();
  const library = page.getByRole("dialog", { name: "Tasks" });
  await expect(library.getByRole("link", { name: /^Earlier sample task 1/ })).toBeVisible();
  await settled(page);
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("tasks-library.png");
});
