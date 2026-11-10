import { expect, runAt, test } from "./harness.ts";

// The overview's gallery page, with eight conversations in every state at each size and on a phone,
// in both houses. The shots are for looking at; the spec checks every tile is drawn whole.
runAt("c14");

for (const appearance of ["graphite", "daylight"] as const)
  test(`the overview's tiles at each size, ${appearance}`, async ({ page, ui }) => {
    await page.addInitScript((choice) => {
      localStorage.setItem("localdot.appearance.v1", choice);
    }, appearance);
    await page.setViewportSize({ width: 2560, height: 1600 });
    await ui.gallery("overview");
    const frames = page.locator(".gallery-overview-frame");
    await expect(frames).toHaveCount(5);
    for (const frame of await frames.all()) {
      const tiles = frame.locator(".overview-tile");
      await expect(tiles).toHaveCount(8);
      // Needs you first, then at work.
      await expect(tiles.first()).toHaveAccessibleName(/needs you/);
      await expect(tiles.nth(2)).toHaveAccessibleName(/working, on screen/);
    }
    await page.clock.runFor(1000);
    for (const [at, frame] of (await frames.all()).entries())
      await frame.screenshot({
        path: test.info().outputPath(`overview-${appearance}-${at}.png`),
        animations: "disabled",
      });
  });
