import { appendFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";
import {
  analyse,
  noteDrag,
  type ScrollRecord,
  type ScrollReport,
  startRecording,
  stopRecording,
  summary,
} from "./scroll-recorder.ts";

runAt("c14", "c39", "w14", "w39");

test.use({ fixedClock: false, reducedMotion: "no-preference" });
test.setTimeout(360_000);

const threadOf = (page: Page) => page.locator(".thread-scroll");

const atEnd = (list: Locator) =>
  expect
    .poll(() => list.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThan(2);

// All that was said has reached the page: the list stops growing.
const arrived = async (list: Locator) => {
  let was = -1;
  await expect
    .poll(
      async () => {
        const now = await list.evaluate((node) => node.scrollHeight);
        const same = now === was;
        was = now;
        return same;
      },
      { intervals: [750], timeout: 45_000 },
    )
    .toBe(true);
};

const report = (name: string, numbers: ScrollReport, record?: ScrollRecord) => {
  const shown = summary(numbers);
  if (process.env.QA_SCROLL_DUMP && record)
    for (const jump of numbers.jumps.slice(0, 3)) {
      const at = record.frames.findIndex((frame) => frame.t === jump.t);
      appendFileSync(
        process.env.QA_SCROLL_DUMP,
        `${JSON.stringify({
          project: test.info().project.name,
          name,
          jump,
          inputs: record.inputs.filter((i) => Math.abs(i.t - jump.t) < 500),
          changes: record.changes
            .filter((c) => Math.abs(c.t - jump.t) < 60)
            .map((c) => [Math.round(c.t), c.mounted, c.key.slice(-10)]),
          frames: record.frames.slice(Math.max(0, at - 4), at + 3).map((f) => ({
            t: Math.round(f.t),
            top: f.top,
            below: f.below,
            rows: f.rows.slice(0, 4).map(([k, o]) => [k.slice(-10), o]),
          })),
        })}\n`,
      );
    }
  const out = process.env.QA_SCROLL_OUT;
  if (out)
    appendFileSync(
      out,
      `${JSON.stringify({ project: test.info().project.name, name, ...shown })}\n`,
    );
  console.log(test.info().project.name, name, JSON.stringify(shown));
};

const TOUCH_SPEED = 2400;
// A synthetic drag can run this far past the distance it was given.
const TOUCH_SLOP = 24;

// The reader's own input over the list: real wheel events where the browser has them, a real touch
// drag on Chrome's phone, and on Playwright's phone WebKit, which has neither, the wheel event and
// the scroll it makes by hand.
async function move(page: Page, list: Locator, by: number) {
  const project = test.info().project.name;
  if (project === "w39") {
    await list.evaluate((node, delta) => {
      node.dispatchEvent(
        new WheelEvent("wheel", { deltaY: delta, bubbles: true, cancelable: true }),
      );
      node.scrollTop += delta;
    }, by);
    return;
  }
  if (project === "c39") {
    const box = await list.boundingBox();
    if (!box) throw new Error("Missing list");
    await noteDrag(page, -by + Math.sign(-by) * TOUCH_SLOP);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizeScrollGesture", {
      x: box.x + box.width / 2,
      // Clear of the live run's own list, which keeps a finger that lands on it.
      y: box.y + box.height * 0.2,
      yDistance: -by,
      gestureSourceType: "touch",
      speed: TOUCH_SPEED,
    });
    await cdp.detach();
    return;
  }
  await page.mouse.wheel(0, by);
}

async function overList(page: Page, list: Locator) {
  const box = await list.boundingBox();
  if (!box) throw new Error("Missing list");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

const firstKey = (list: Locator) =>
  list.evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    for (const row of node.querySelectorAll<HTMLElement>(".thread > .thread-row[data-row]"))
      if (row.getBoundingClientRect().bottom > top) return row.dataset.row;
    return undefined;
  });

async function toTop(page: Page, list: Locator, step: number, most: number) {
  let still = 0;
  // An earlier task can take a while to read in at the top: only a long rest is the thread's start.
  for (let tick = 0; tick < most && still < 15; tick++) {
    const before = await list.evaluate((node) => node.scrollTop);
    await move(page, list, -step);
    await page.waitForTimeout(40);
    const after = await list.evaluate((node) => node.scrollTop);
    still = after === before ? still + 1 : 0;
  }
}

async function toBottom(page: Page, list: Locator, step: number, most: number) {
  for (let tick = 0; tick < most; tick++) {
    const below = await list.evaluate(
      (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
    );
    if (below < 2 && !(await list.locator(".thread-newer").count())) return;
    await move(page, list, step);
    await page.waitForTimeout(40);
  }
}

async function longConversation(
  page: Page,
  ui: { open(name: "long-thread"): Promise<{ origin: string }> },
) {
  const fixture = await ui.open("long-thread");
  await page.request.post(`${fixture.origin}/__qa/talk?turns=40`);
  const list = threadOf(page);
  await expect(list.locator(".thread-row").last()).toBeVisible({ timeout: 45_000 });
  await arrived(list);
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await overList(page, list);
  await atEnd(list);
  return { fixture, list };
}

test("scrolling all the way up and back down a long conversation moves only with the reader", async ({
  page,
  ui,
}) => {
  const { fixture, list } = await longConversation(page, ui);
  await startRecording(page, "walk");
  await page.request.post(`${fixture.origin}/__qa/stream?ms=20000`);
  await toTop(page, list, 320, 220);
  await toBottom(page, list, 320, 300);
  await page.waitForTimeout(300);
  const record = await stopRecording(page);
  const numbers = analyse(record, ["walk"]);
  report("walk", numbers, record);
  expect(numbers.jumps).toEqual([]);
  expect(numbers.remounts).toEqual([]);
  expect(numbers.teleports).toBe(0);
  expect(numbers.empty).toBe(0);
  expect(numbers.picturesLost).toBe(0);
});

test("a thread of one-line rows pages through without bouncing between its ends", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("long-thread");
  await page.request.post(`${fixture.origin}/__qa/talk?turns=160&short=1`);
  const list = threadOf(page);
  await expect(list.locator(".thread-row").last()).toBeVisible({ timeout: 45_000 });
  await arrived(list);
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await overList(page, list);
  await atEnd(list);
  await startRecording(page, "short");
  await toTop(page, list, 240, 120);
  await page.waitForTimeout(500);
  await toBottom(page, list, 240, 160);
  await page.waitForTimeout(300);
  const record = await stopRecording(page);
  const numbers = analyse(record, ["short"]);
  report("short-rows", numbers, record);
  expect(numbers.jumps).toEqual([]);
  expect(numbers.remounts).toEqual([]);
  expect(numbers.teleports).toBe(0);
  expect(numbers.empty).toBe(0);
});

test("a reader above the end stays put while dot streams, works and finishes", async ({
  page,
  ui,
}) => {
  const { fixture, list } = await longConversation(page, ui);
  await page.request.post(`${fixture.origin}/__qa/steps?n=6`);
  await expect(async () => {
    await move(page, list, -300);
    await expect(page.locator(".thread-jump")).toHaveAttribute("data-shown", { timeout: 300 });
  }).toPass();
  await page.waitForTimeout(600);
  await startRecording(page, "still");
  const held = await firstKey(list);
  await page.request.post(`${fixture.origin}/__qa/stream?ms=3000`);
  await page.waitForTimeout(3300);
  await page.request.post(`${fixture.origin}/__qa/say?n=4&text=Later%20words`);
  await page.request.post(`${fixture.origin}/__qa/finish?done=1`);
  await page.waitForTimeout(900);
  const numbers = analyse(await stopRecording(page), ["still"]);
  report("still", numbers);
  expect(await firstKey(list)).toBe(held);
  expect(numbers.jumps).toEqual([]);
  expect(numbers.remounts).toEqual([]);
  expect(numbers.stuckLater).toBe(0);
});

// Up into the history, far enough that the end of the thread is pages away.
async function intoHistory(page: Page, list: Locator) {
  for (let tick = 0; tick < 24; tick++) {
    await move(page, list, -500);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);
}

test("a big scroll down through history goes as far as it asked, not on to the end", async ({
  page,
  ui,
}) => {
  test.skip(test.info().project.name === "w39", "Playwright's phone WebKit has no wheel to fling");
  const { list } = await longConversation(page, ui);
  await intoHistory(page, list);
  await expect(page.locator(".thread-jump")).toHaveAttribute("data-shown");
  await startRecording(page, "flick");
  await move(page, list, 4000);
  await page.waitForTimeout(1200);
  const numbers = analyse(await stopRecording(page), ["flick"]);
  report("flick", numbers);
  // Still reading, not carried to the end by the pages coming in as it goes.
  await expect(page.locator(".thread-jump")).toHaveAttribute("data-shown");
  expect(numbers.jumps).toEqual([]);
  expect(numbers.remounts).toEqual([]);
});

test("sending from far back goes to the end and follows it", async ({ page, ui }) => {
  const { fixture, list } = await longConversation(page, ui);
  await intoHistory(page, list);
  const field = page.getByRole("textbox", { name: "Message", exact: true });
  await field.fill("Back to the end please");
  await page
    .getByRole("button", { name: /^(Send|Send now|Send follow-up|Queue message)$/ })
    .click();
  await expect(list.getByText("Back to the end please")).toBeInViewport();
  await atEnd(list);
  await page.request.post(`${fixture.origin}/__qa/say?n=6&text=More%20to%20read`);
  await expect(list.getByText("More to read (6)")).toBeInViewport();
  await atEnd(list);
  await expect(page.locator(".thread-jump")).not.toHaveAttribute("data-shown");
});

test("a reader's place survives the list leaving the page and coming back", async ({
  page,
  ui,
}) => {
  const { fixture, list } = await longConversation(page, ui);
  await intoHistory(page, list);
  const place = () =>
    list.evaluate((node) => {
      const top = node.getBoundingClientRect().top;
      for (const row of node.querySelectorAll<HTMLElement>(".thread > .thread-row[data-row]")) {
        const box = row.getBoundingClientRect();
        if (box.bottom > top) return [row.dataset.row, Math.round(box.top - top)];
      }
      return [];
    });
  const before = await place();
  await page.locator(".rail-chat").evaluate((rail) => {
    (rail as HTMLElement).hidden = true;
  });
  // Rows go on arriving while it is out of the page.
  await page.request.post(`${fixture.origin}/__qa/say?n=3&text=Meanwhile`);
  await page.waitForTimeout(400);
  await page.locator(".rail-chat").evaluate((rail) => {
    (rail as HTMLElement).hidden = false;
  });
  await page.waitForTimeout(400);
  expect(await place()).toEqual(before);
});

test("a finger on the live run's own list goes on to the thread at the list's end", async ({
  page,
  ui,
}) => {
  test.skip(test.info().project.name !== "c39", "Touch drags run on Chrome's phone");
  const { fixture, list } = await longConversation(page, ui);
  await page.request.post(`${fixture.origin}/__qa/steps?n=40`);
  const steps = page.locator(".thread-work[data-live]").getByRole("region", {
    name: "Work history",
  });
  await atEnd(steps);
  await atEnd(list);
  const box = await steps.boundingBox();
  if (!box) throw new Error("Missing list");
  const cdp = await page.context().newCDPSession(page);
  await expect(async () => {
    await cdp.send("Input.synthesizeScrollGesture", {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      yDistance: 800,
      gestureSourceType: "touch",
      speed: TOUCH_SPEED,
    });
    await expect(page.locator(".thread-jump")).toHaveAttribute("data-shown", { timeout: 300 });
  }).toPass();
  await cdp.detach();
});
