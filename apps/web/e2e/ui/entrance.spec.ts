import { expect, runAt, test } from "./harness.ts";

// The page's entrance on a phone, with motion as a phone has it.
runAt("c39", "w39");
test.use({ reducedMotion: "no-preference" });

type Rect = [number, number, number, number];

test("the phone's toolbar paints where it stays", async ({ page, ui }) => {
  await page.addInitScript(() => {
    const rects: Rect[] = [];
    (window as unknown as { toolbar_: Rect[] }).toolbar_ = rects;
    const tick = () => {
      const box = document.querySelector(".thread-toolbar")?.getBoundingClientRect();
      if (box) rects.push([box.x, box.y, box.width, box.height]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await ui.open("ready");
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await ui.settle();
  await page.waitForFunction(
    () => document.querySelector(".rail-chat")?.getAnimations().length === 0,
  );
  await ui.settle();
  const rects = await page.evaluate(() => (window as unknown as { toolbar_: Rect[] }).toolbar_);
  const settled = rects.at(-1);
  expect(rects.length).toBeGreaterThan(10);
  expect(rects.filter((rect) => rect.join() !== settled?.join())).toEqual([]);
});
