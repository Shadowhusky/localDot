import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";
import { type ScrollFrame, startRecording, stopRecording } from "./scroll-recorder.ts";

// A file's preview unfolds under its row, and the chat moves with it or not at all: every frame's
// scroll is explained by how far the preview grew in that frame, and none comes after it stops.
runAt("c14", "c39", "w39");
test.use({ fixedClock: false, reducedMotion: "no-preference", viewStyle: "chat" });

const PANEL = '.deliverable[aria-label="totals.csv"] > .ui-collapse';
const growth = (was: ScrollFrame, now: ScrollFrame) => (now.watched ?? 0) - (was.watched ?? 0);

// A glide catching up with what grew a frame or two before. A jump is the whole preview in a frame.
const SLACK = 24;

// How far any frame scrolled beyond what the preview's growth that frame explains.
function unexplained(seen: readonly ScrollFrame[]) {
  let most = 0;
  for (let at = 1; at < seen.length; at++) {
    const [was, now] = [seen[at - 1] as ScrollFrame, seen[at] as ScrollFrame];
    most = Math.max(most, Math.abs(now.top - was.top) - Math.abs(growth(was, now)));
  }
  return most;
}

// How fast the panel grew, in px a millisecond, at its fastest after it first came to rest: what
// arrives once the panel has opened on its placeholder.
function fastestAfterRest(seen: readonly ScrollFrame[]) {
  const grown = seen.findIndex((frame) => (frame.watched ?? 0) > 0);
  let rested = grown;
  while (rested + 5 < seen.length && seen[rested]?.watched !== seen[rested + 5]?.watched) rested++;
  let most = 0;
  for (let at = rested + 1; at < seen.length; at++) {
    const [was, now] = [seen[at - 1] as ScrollFrame, seen[at] as ScrollFrame];
    most = Math.max(most, Math.abs(growth(was, now)) / Math.max(1, now.t - was.t));
  }
  return most;
}

// Where it is on screen, as a reader would: Playwright's own tap first scrolls what it taps to suit.
async function press(page: Page, element: Locator) {
  const box = await element.boundingBox();
  if (!box) throw new Error("Nothing to press");
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  if (isPhone(page)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function resultAtEnd(page: Page, origin: string) {
  await page.request.post(`${origin}/__qa/say?n=12&text=History%20message`);
  const handed = await page.request.post(`${origin}/__qa/files?count=3`);
  expect(handed.ok(), await handed.text()).toBe(true);
  const card = page.getByRole("region", { name: "Task result" }).last();
  await expect(card).toBeVisible();
  const view = page.locator(".thread-scroll");
  await expect
    .poll(() => view.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThan(2);
  return card;
}

const settled = async (row: Locator) => {
  let was = -1;
  await expect
    .poll(
      async () => {
        const now = await row.evaluate((node) => node.getBoundingClientRect().height);
        const same = now === was;
        was = now;
        return same;
      },
      { intervals: [300] },
    )
    .toBe(true);
};

const opened = async (page: Page, row: Locator) => {
  const toggle = row.getByRole("button", { name: "Show totals.csv" });
  await startRecording(page, "open", PANEL);
  await press(page, toggle);
  await expect(row.getByRole("region", { name: "First rows of totals.csv" })).toBeVisible();
  await settled(row);
  await page.waitForTimeout(500);
  return (await stopRecording(page)).frames;
};

test("opening a file at the end of the chat never jumps", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const card = await resultAtEnd(page, fixture.origin);
  const row = card.getByRole("listitem", { name: "totals.csv" });
  const seen = await opened(page, row);
  expect(seen.at(-1)?.watched).toBeGreaterThan(60);
  expect(unexplained(seen), JSON.stringify(seen.map((f) => [f.top, f.watched]))).toBeLessThan(
    SLACK,
  );
  // The row's head is still in view, and the end of its preview has come into view.
  await expect(row.getByRole("button", { name: "Hide totals.csv" })).toBeInViewport();
  await expect(row.getByRole("button", { name: "Revise" })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("opened.png") });
});

test("a preview that arrives late eases in and still doesn't jump", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.route("**/preview*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  const card = await resultAtEnd(page, fixture.origin);
  const seen = await opened(page, card.getByRole("listitem", { name: "totals.csv" }));
  expect(fastestAfterRest(seen), "the panel eased to its new height").toBeLessThan(1.5);
  expect(unexplained(seen), JSON.stringify(seen.map((f) => [f.top, f.watched]))).toBeLessThan(
    SLACK,
  );
});

test("a file with room to open doesn't move the chat", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const card = await resultAtEnd(page, fixture.origin);
  await page.request.post(`${fixture.origin}/__qa/say?n=12&text=Later%20message`);
  const row = card.getByRole("listitem", { name: "totals.csv" });
  await row.evaluate((node) => {
    const view = node.closest(".thread-scroll") as HTMLElement;
    view.scrollTop +=
      node.getBoundingClientRect().top - view.getBoundingClientRect().top - view.clientHeight / 4;
  });
  await page.waitForTimeout(300);
  const toggle = row.getByRole("button", { name: "Show totals.csv" });
  await startRecording(page, "open", PANEL);
  await press(page, toggle);
  await expect(row.getByRole("region", { name: "First rows of totals.csv" })).toBeVisible();
  await settled(row);
  await page.waitForTimeout(500);
  const tops = (await stopRecording(page)).frames.map((frame) => frame.top);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
});

test("folding a file away keeps its row where it is", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const card = await resultAtEnd(page, fixture.origin);
  await page.request.post(`${fixture.origin}/__qa/say?n=12&text=Later%20message`);
  const row = card.getByRole("listitem", { name: "totals.csv" });
  await row.evaluate((node) => {
    const view = node.closest(".thread-scroll") as HTMLElement;
    view.scrollTop +=
      node.getBoundingClientRect().top - view.getBoundingClientRect().top - view.clientHeight / 4;
  });
  await page.waitForTimeout(300);
  await opened(page, row);
  const place = () => row.evaluate((node) => Math.round(node.getBoundingClientRect().top));
  const before = await place();
  await press(page, row.getByRole("button", { name: "Hide totals.csv" }));
  await settled(row);
  expect(await place()).toBe(before);
  await expect(row.getByRole("region", { name: "First rows of totals.csv" })).toHaveCount(0);
});
