import type { Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

// At rest dot sits inside its place, so whatever moves the place moves dot on the same frame.
runAt("c14", "w14", "w39");

// How far dot is from its place on the next frame drawn: x, y and size.
const gap = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number[]>((resolve) =>
        requestAnimationFrame(() => {
          const frame = document.querySelector<HTMLElement>(".presence-frame");
          const slot = [
            ...document.querySelectorAll(`.presence-slot[data-place="${frame?.dataset.place}"]`),
          ]
            .filter((element) => element.getBoundingClientRect().width > 0)
            .at(-1);
          if (!frame || !slot) return resolve([Number.NaN, Number.NaN, Number.NaN]);
          const a = frame.getBoundingClientRect();
          const b = slot.getBoundingClientRect();
          resolve([a.left - b.left, a.top - b.top, a.width - b.width]);
        }),
      ),
  );

async function aligned(page: Page) {
  for (const d of await gap(page)) expect(Math.abs(d)).toBeLessThan(0.5);
}

// dot is out and has come to rest in its place, after the curtain the page opens under.
async function resting(page: Page) {
  await expect(page.locator('.presence-frame[data-place="dock"][data-shown]')).toBeAttached();
  await expect
    .poll(async () => Math.max(...(await gap(page)).map(Math.abs)), { message: "dot at rest" })
    .toBeLessThan(0.5);
}

const desktop = () => test.info().project.name !== "w39";

test("dot stays with its place while the page scrolls either way", async ({ page, ui }) => {
  await ui.open("ready");
  await resting(page);
  // Room for the page to move both ways, as an overscroll bounce or a pinch-zoomed pan gives it.
  await page.evaluate(() => {
    const room = document.createElement("div");
    room.style.cssText = "position:absolute;top:0;left:0;width:160vw;height:160vh";
    document.body.append(room);
  });
  const offsets: [number, number][] = [
    [0, 40],
    [0, 120],
    [60, 120],
    [140, 30],
    [0, 0],
  ];
  for (const [x, y] of offsets) {
    await page.evaluate((to) => window.scrollTo(to.x, to.y), { x, y });
    expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([x, y]);
    await aligned(page);
  }
});

test("dot stays with its place while a panel's width is dragged", async ({ page, ui }) => {
  test.skip(!desktop(), "a phone has no panel handles");
  await ui.open("ready");
  await resting(page);
  const handle = await page.locator(".rail-resize-chat").boundingBox();
  if (!handle) throw new Error("no chat panel handle");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(x - step * 20, y);
    await aligned(page);
  }
  await page.mouse.up();
  await aligned(page);
});

test("dot scrolls with the recording it sits beside", async ({ page, ui }) => {
  test.skip(!desktop(), "a phone's library has no room for the chosen recording");
  await page.setViewportSize({ width: 1440, height: 600 });
  await ui.open("done", () => "/?replay=library");
  await expect(page.locator(".replay-says-dot")).toBeVisible();
  await resting(page);
  const preview = page.locator(".replay-preview");
  for (const top of [20, 50, 1000, 0]) {
    const scrolled = await preview.evaluate((element, to) => {
      element.scrollTo(0, to);
      return element.scrollTop;
    }, top);
    if (top) expect(scrolled).toBeGreaterThan(0);
    await aligned(page);
  }
});
