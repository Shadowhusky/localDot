import { composer, expect, runAt, test } from "./harness.ts";

// The slash menu on a phone: all of it in view, over everything but the island, with the keyboard up
// on the shortest phone too.
runAt("c39", "w39");

const SIZES = [
  [430, 932, 346],
  [390, 844, 310],
  [390, 664, 310],
  [375, 667, 260],
  [320, 568, 216],
  [390, 844, 0],
  [375, 667, 0],
  [320, 568, 0],
] as const;

for (const [width, height, keyboard] of SIZES)
  test(`whole at ${width}x${height}, keyboard ${keyboard}`, async ({ page, ui }) => {
    await page.setViewportSize({ width, height });
    await ui.open("running");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const card = await composer(page);
    await card.getByRole("textbox").first().click();
    await page.keyboard.type("/");
    if (keyboard)
      await page.evaluate((keyboard) => {
        const view = window.visualViewport;
        if (!view) throw new Error("Visual viewport required");
        Object.defineProperty(view, "height", {
          configurable: true,
          value: innerHeight - keyboard,
        });
        view.dispatchEvent(new Event("resize"));
      }, keyboard);
    const menu = card.getByRole("listbox", { name: "Commands" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: test.info().outputPath("menu.png") });
    const seen = await page.evaluate(() => {
      const element = document.querySelector(".command-menu");
      if (!element) throw new Error("Missing menu");
      const box = element.getBoundingClientRect();
      const island = document.querySelector(".island")?.getBoundingClientRect();
      const inside = [0.1, 0.5, 0.9].flatMap((across) =>
        [4, box.height / 2, box.height - 4].map((down) =>
          element.contains(
            document.elementFromPoint(box.left + box.width * across, box.top + down),
          ),
        ),
      );
      return {
        top: box.top,
        height: box.height,
        cardTop: document.querySelector(".composer-card")?.getBoundingClientRect().top ?? 0,
        bottom: box.bottom,
        inside,
        islandBottom: island?.bottom ?? 0,
      };
    });
    expect(seen.top).toBeGreaterThanOrEqual(0);
    expect(seen.top).toBeGreaterThanOrEqual(seen.islandBottom);
    expect(seen.bottom).toBeLessThanOrEqual(seen.cardTop);
    expect(seen.height).toBeGreaterThanOrEqual(80);
    expect(seen.inside).toEqual(seen.inside.map(() => true));
    // The list inside it scrolls to every command.
    const list = await menu.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      const rows = element.querySelectorAll('[role="option"]');
      const last = rows[rows.length - 1]?.getBoundingClientRect();
      const frame = element.getBoundingClientRect();
      return { bottom: last?.bottom ?? 0, frameBottom: frame.bottom };
    });
    expect(list.bottom).toBeLessThanOrEqual(list.frameBottom + 1);
  });
