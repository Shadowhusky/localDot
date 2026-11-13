import type { Locator, Page } from "@playwright/test";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { expect, runAt, test } from "./harness.ts";

// A long list of steps draws only the rows near the view. Scrolled back, the rows it draws again
// were there all along: one that fades in, rises or draws its check again flickers under the reader.
runAt("c14", "c39");

interface Frame {
  rows: [index: number, top: number][];
  arriving: string[];
}

// Every frame: where each row in view sits, and which rows or checks are still arriving.
async function watch(scroller: Locator) {
  await scroller.evaluate((pane) => {
    const frames: Frame[] = [];
    Object.defineProperty(window, "frames", { value: frames, configurable: true });
    const sample = () => {
      const edge = pane.getBoundingClientRect();
      const rows: Frame["rows"] = [];
      for (const row of pane.querySelectorAll<HTMLElement>("[data-index]")) {
        const box = row.getBoundingClientRect();
        if (box.bottom > edge.top && box.top < edge.bottom)
          rows.push([Number(row.dataset.index), Math.round(box.top - edge.top)]);
      }
      const arriving = pane.getAnimations({ subtree: true }).flatMap((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const property = (animation as CSSTransition).transitionProperty;
        const row = target?.closest("[data-index]");
        return row && target?.matches(".activity-row, .ui-status-check")
          ? [`${row.getAttribute("data-index")}:${property}`]
          : [];
      });
      frames.push({ rows, arriving });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as { frames: Frame[] }).frames.splice(0));

async function scrollBack(page: Page, scroller: Locator, times: number) {
  const box = await scroller.boundingBox();
  if (!box) throw new Error("Missing scroller geometry");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  if ((page.viewportSize()?.width ?? 0) < 700) {
    const cdp = await page.context().newCDPSession(page);
    for (let n = 0; n < times; n++)
      await cdp.send("Input.synthesizeScrollGesture", {
        x,
        y,
        yDistance: Math.min(400, box.height * 0.8),
        speed: 1400,
        gestureSourceType: "touch",
      });
  } else {
    await page.mouse.move(x, y);
    for (let n = 0; n < times * 8; n++) {
      await page.mouse.wheel(0, -60);
      await page.waitForTimeout(16);
    }
  }
  await page.waitForTimeout(400);
}

// Scrolling back, the rows two frames share all move down together, and none is still arriving.
function flickers(seen: Frame[]) {
  const problems = new Set<string>();
  for (let i = 1; i < seen.length; i++) {
    const before = new Map(seen[i - 1]?.rows),
      rows = seen[i]?.rows ?? [];
    const moves = rows.flatMap(([index, top]) =>
      before.has(index) ? [top - (before.get(index) ?? 0)] : [],
    );
    if (before.size && rows.length && !moves.length) problems.add("the view jumped");
    if (moves.length && Math.max(...moves) - Math.min(...moves) > 1)
      problems.add("rows moved apart");
    if (moves.length && Math.min(...moves) < -1) problems.add("rows went back up");
    for (const each of seen[i]?.arriving ?? []) problems.add(`row ${each} arrived again`);
  }
  return [...problems].slice(0, 12);
}

async function longTask(page: Page, origin: string) {
  await page.request.post(`${origin}/__qa/steps?n=300`);
  // The motion a reader sees: the matrix runs with it reduced.
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

test("the thread's steps stand still as the reader scrolls back, and a new one arrives", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await longTask(page, fixture.origin);
  const history = page
    .locator(".thread-work[data-live]")
    .getByRole("region", { name: "Work history" });
  const last = () => history.locator("[data-last]").getAttribute("data-index").then(Number);
  await expect.poll(last).toBeGreaterThan(300);
  await ui.settle();
  await page.waitForTimeout(1000);
  await watch(history);
  const end = await last();
  await page.request.post(`${fixture.origin}/__qa/steps?n=1`);
  await expect.poll(last).toBe(end + 1);
  await page.waitForTimeout(600);
  expect(
    (await frames(page)).flatMap((frame) => frame.arriving),
    "a step that has just been taken arrives",
  ).toContain(`${end + 1}:opacity`);
  await scrollBack(page, history, 12);
  const seen = await frames(page);
  expect(seen.at(-1)?.rows[0]?.[0]).toBeLessThan(end - 20);
  expect(flickers(seen)).toEqual([]);
});

test("Activity's steps stand still as the reader scrolls back", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await longTask(page, fixture.origin);
  const phone = (page.viewportSize()?.width ?? 0) < 700;
  if (phone) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: PANEL_NAME, exact: true }).click();
  const rail = page.locator(".activity-rail");
  await expect(rail.locator(".activity-window-row[data-last]")).toBeVisible();
  const scroller = rail.locator('[role="tabpanel"]:not([aria-hidden]) .activity-scroll');
  await ui.settle();
  await page.waitForTimeout(1000);
  await watch(scroller);
  // A phone's sheet is pulled away by a drag at its top, so it stops short of it.
  await scrollBack(page, scroller, phone ? 6 : 12);
  const seen = await frames(page);
  expect(seen.at(-1)?.rows.length).toBeGreaterThan(0);
  expect(flickers(seen)).toEqual([]);
});
