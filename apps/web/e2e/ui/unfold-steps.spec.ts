import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39");

// Where a run sits in the chat's view, in px from its top and bottom, and how far up from the
// view's bottom the jump button reaches.
const placed = (run: Locator) =>
  run.evaluate((node) => {
    const view = node.closest(".thread-scroll") as HTMLElement;
    const column = view.closest(".thread-body") as HTMLElement;
    const jump = column.querySelector<HTMLElement>(".thread-jump") as HTMLElement;
    const port = view.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      top: box.top - port.top,
      bottom: port.bottom - box.bottom,
      scrollTop: view.scrollTop,
      jumpReach: port.bottom - column.getBoundingClientRect().top - jump.offsetTop,
    };
  });

const press = (page: Page, element: Locator) => (isPhone(page) ? element.tap() : element.click());

// What the reader sees in the middle of an element is the element, not something over it.
const seen = (element: Locator) =>
  element.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return node.contains(
      document.elementFromPoint(box.x + box.width / 2, box.y + Math.min(box.height / 2, 12)),
    );
  });

// A task whose last run of steps is long and folded, with a long chat before it, and `after` more
// messages after it.
async function foldedRun(page: Page, origin: string, after = 0) {
  await page.request.post(`${origin}/__qa/say?n=20&text=History%20message`);
  await page.request.post(`${origin}/__qa/steps?n=40`);
  if (after) await page.request.post(`${origin}/__qa/say?n=${after}&text=Later%20message`);
  await page.request.post(`${origin}/__qa/finish?done=1`);
  await expect(page.locator(".thread-work[data-live]")).toHaveCount(0);
  const run = page.locator(".thread-work-steps").last();
  const toggle = run.locator(":scope > .ui-disclosure-trigger");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  return { run, toggle };
}

// Scrolls the chat so the run's head sits `top` px down the view.
const headAt = (toggle: Locator, top: number) =>
  toggle.evaluate((node, at) => {
    const view = node.closest(".thread-scroll") as HTMLElement;
    view.scrollTop += node.getBoundingClientRect().top - view.getBoundingClientRect().top - at;
  }, top);

test("a long run of steps opened near the bottom of the chat comes into view to its end", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const { run, toggle } = await foldedRun(page, fixture.origin);
  await ui.settle();
  // Its head 40 px above the bottom of the view, so the list it opens would unfold out of sight.
  await toggle.evaluate((node) => {
    const view = node.closest(".thread-scroll") as HTMLElement;
    view.scrollTop -=
      view.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom - 40;
  });
  await ui.settle();
  const before = await placed(run);
  expect(Math.round(before.bottom)).toBe(40);

  await press(page, toggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = run.getByRole("region", { name: "Work history" });
  await expect(list).toBeVisible();

  // The list's end comes up to 8 px above the jump button, and no further. A phone's chat has no
  // room for that under the head, which goes up only as far as 16 px inside the view's top.
  const clear = Math.round(before.jumpReach + 8);
  if (isPhone(page)) {
    await expect.poll(async () => Math.round((await placed(run)).top)).toBe(16);
    expect((await placed(run)).bottom).toBeGreaterThanOrEqual(16);
  } else await expect.poll(async () => Math.round((await placed(run)).bottom)).toBe(clear);
  const after = await placed(run);
  expect(after.top).toBeGreaterThanOrEqual(16);
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
  await expect(page.locator(".thread-jump")).toHaveAttribute("data-shown");
  expect(await seen(toggle)).toBe(true);
  const last = list.locator("[data-last] .activity-row");
  await expect(last).toBeVisible();
  expect(await seen(last)).toBe(true);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("unfolded.png") });

  // It stays there: nothing pulls the view back, or on to the end.
  await page.waitForTimeout(600);
  expect(Math.round((await placed(run)).scrollTop)).toBe(Math.round(after.scrollTop));

  // Folding it again leaves its head where it is.
  await press(page, toggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await ui.settle();
  expect(Math.round((await placed(run)).top)).toBe(Math.round(after.top));
});

test("a run of steps opened high in the chat moves it only as far as the run needs", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const { run, toggle } = await foldedRun(page, fixture.origin, 20);
  await headAt(toggle, 40);
  await ui.settle();
  const before = await placed(run);
  expect(Math.round(before.top)).toBe(40);

  await press(page, toggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(run.getByRole("region", { name: "Work history" })).toBeVisible();
  await ui.settle();
  await page.waitForTimeout(300);
  const after = await placed(run);
  expect(await seen(toggle)).toBe(true);
  if (isPhone(page)) {
    // A phone's chat has no room for the whole run under its head: the head goes up to the top
    // of the view and no further, the list under it.
    expect(Math.round(after.top)).toBe(16);
  } else {
    // All of it is in view already: the chat stays where it is.
    expect(after.bottom).toBeGreaterThan(before.jumpReach + 8);
    expect(Math.round(after.scrollTop)).toBe(Math.round(before.scrollTop));
  }
});
