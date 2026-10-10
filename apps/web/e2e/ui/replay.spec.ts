import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

// Replay's states: a task with no video once its card has become a chip in the transport, and the
// recordings beside the player, or one screen back from it on a phone.
runAt("c14", "w14", "w39");

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
});

test("tasks library", async ({ page, ui }) => {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=20000`);
  await expect(page.getByRole("status", { name: "Replay time" })).toHaveText("0:20");
  await expect(page.locator(".replay-length")).toHaveText("3:00");
  await ui.picture(page.getByRole("main", { name: "Replay" }).locator(".stage"));
  let library: Locator;
  if (isPhone(page)) {
    await page.getByRole("navigation").getByRole("button", { name: "Replay" }).click();
    library = page.getByRole("main", { name: "Replay" });
  } else {
    library = page.getByRole("complementary", { name: "Recording" });
    await library.getByRole("radio", { name: "Recordings", exact: true }).click();
  }
  await expect(library.getByRole("button", { name: /^Earlier sample task 1/ })).toBeVisible();
  await settled(page);
  await ui.settle();
  await ui.still();
});
