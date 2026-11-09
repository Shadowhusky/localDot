import type { Locator, Page } from "@playwright/test";
import { openSettings } from "../settings-ui.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// A step that opens moves the page with its opening or not at all, and nothing moves once it has
// opened. Measured over the frames as painted, with the motion on.
runAt("c14", "c39", "w14", "w39");
test.use({ fixedClock: false, reducedMotion: "no-preference" });

const WORDS = 60;

interface Frame {
  t: number;
  // Where the pressed head sits on screen.
  head: number;
  // How far everything that scrolls around it has gone.
  scrolled: number;
  // How tall the panel it opens is.
  panel: number;
}

declare global {
  interface Window {
    unfolding?: { frames: Frame[]; stop(): void };
  }
}

// Samples just after each paint, so a move made in the frame it was needed counts with that frame.
const record = (head: Locator, panel: string) =>
  head.evaluate((node, selector) => {
    const scrollers: HTMLElement[] = [];
    for (let at = node.parentElement; at; at = at.parentElement)
      if (/auto|scroll/.test(getComputedStyle(at).overflowY)) scrollers.push(at);
    const owner = node.closest(".activity-row, .ui-disclosure, .ui-group") as HTMLElement;
    const frames: Frame[] = [];
    let on = true;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      frames.push({
        t: performance.now(),
        head: node.getBoundingClientRect().top,
        scrolled: scrollers.reduce((sum, scroller) => sum + scroller.scrollTop, 0),
        panel: owner.querySelector(selector)?.getBoundingClientRect().height ?? 0,
      });
    };
    const loop = () => {
      if (!on) return;
      channel.port2.postMessage(0);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.unfolding = {
      frames,
      stop: () => {
        on = false;
      },
    };
  }, panel);

const recorded = (page: Page) =>
  page.evaluate(() => {
    window.unfolding?.stop();
    return window.unfolding?.frames ?? [];
  });

// Where it is on screen, as a reader would, at its words: Playwright's own click first scrolls what
// it presses, and a jump button can lie over a row's middle.
async function press(page: Page, element: Locator) {
  const box = await element.boundingBox();
  if (!box) throw new Error("Nothing to press");
  const [x, y] = [box.x + WORDS, box.y + box.height / 2];
  if (isPhone(page)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

// Puts a head in the lower part of what the reader can see, out from under anything over the view's
// foot: the opening will want to run off it.
const low = (head: Locator) =>
  head.evaluate((node, words) => {
    node.scrollIntoView({ block: "end" });
    const view = node.closest<HTMLElement>(".thread-scroll, .activity-scroll");
    for (let tries = 0; view && tries < 40; tries++) {
      const box = node.getBoundingClientRect();
      if (node.contains(document.elementFromPoint(box.x + words, box.bottom - 2))) break;
      view.scrollTop += 16;
    }
  }, WORDS);

// Opens what `head` opens and waits until a good while after it has come to rest.
async function open(page: Page, head: Locator, panel: string, state = "aria-expanded") {
  await record(head, panel);
  await press(page, head);
  await expect(head).toHaveAttribute(state, "true");
  await page.waitForTimeout(1400);
  return recorded(page);
}

const steps = (seen: readonly Frame[]) =>
  seen.slice(1).map((frame, at) => ({
    t: frame.t,
    scroll: Math.abs(frame.scrolled - (seen[at] as Frame).scrolled),
    growth: frame.panel - (seen[at] as Frame).panel,
    panel: frame.panel,
  }));

// How far the page scrolled once the panel had all but opened, beyond what was still to come of it:
// the jump the eye sees after the transition.
function lateScroll(seen: readonly Frame[]) {
  const opened = seen.at(-1)?.panel ?? 0;
  const mostly = steps(seen).filter((step) => step.panel >= opened * 0.95);
  const left = opened - (mostly[0]?.panel ?? opened);
  return mostly.reduce((sum, step) => sum + step.scroll, 0) - left;
}

// The most any one frame scrolled, beyond what the panel grew in it.
const hardestStep = (seen: readonly Frame[]) =>
  Math.max(0, ...steps(seen).map((step) => step.scroll - step.growth));

const report = (seen: readonly Frame[]) =>
  JSON.stringify(seen.map((frame) => [Math.round(frame.scrolled), Math.round(frame.panel)]));

const moved = (seen: readonly Frame[]) => {
  const tops = seen.map((frame) => frame.scrolled);
  return Math.max(...tops) - Math.min(...tops);
};

// Once it has all but opened, what is still on its way is a few pixels.
const SLACK = 8;
// A glide catches up with what grew a frame or two before. A jump is most of the panel in a frame.
const CATCHING_UP = 64;

function runsAsOne(seen: readonly Frame[]) {
  expect(seen.at(-1)?.panel, report(seen)).toBeGreaterThan(20);
  expect(lateScroll(seen), `scrolled after it had opened: ${report(seen)}`).toBeLessThan(SLACK);
  expect(hardestStep(seen), `a frame that jumped: ${report(seen)}`).toBeLessThan(CATCHING_UP);
}

const ROW_PANEL = ".activity-row-detail";

// A finished run of `n` steps at the end of a chat, opened.
async function openRun(page: Page, n: number) {
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const trigger = page.locator(".thread-work-steps > .ui-disclosure-trigger:visible").last();
  await trigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await press(page, trigger);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(700);
  const list = page.getByRole("list", { name: "Steps" }).last();
  await expect(list.locator(".activity-row-head").nth(n - 1)).toBeVisible();
  return list;
}

for (const view of ["studio", "chat"] as const)
  test.describe(view, () => {
    test.use({ viewStyle: view });

    test("a step at the end of its list opens as one motion, and nothing moves after", async ({
      page,
      ui,
    }) => {
      await ui.open("image-output");
      const list = await openRun(page, 6);
      const head = list.getByRole("button", { name: /Validate report schema/ });
      await low(head);
      await page.waitForTimeout(200);
      const seen = await open(page, head, ROW_PANEL);
      runsAsOne(seen);
      await expect(head).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath("opened.png") });
    });

    test("a step with room to open stays under the pointer", async ({ page, ui }) => {
      const fixture = await ui.open("image-output");
      await page.request.post(`${fixture.origin}/__qa/say?n=12&text=Later%20message`);
      await page.waitForTimeout(400);
      const list = await openRun(page, 6);
      const head = list.locator(".activity-row-head").first();
      await head.evaluate((node, words) => {
        node.scrollIntoView({ block: "start" });
        const view = node.closest<HTMLElement>(".thread-scroll");
        if (view) view.scrollTop -= 40;
        for (let tries = 0; view && tries < 12; tries++) {
          const box = node.getBoundingClientRect();
          const middle = box.top + box.height / 2;
          if (node.contains(document.elementFromPoint(box.x + words, middle))) break;
          view.scrollTop -= 16;
        }
      }, WORDS);
      await page.waitForTimeout(200);
      const seen = await open(page, head, ROW_PANEL);
      // A phone's chat has no room for all of it, nor a chat's own list with its wider picture.
      if (isPhone(page) || view === "chat") runsAsOne(seen);
      else {
        expect(moved(seen), report(seen)).toBeLessThan(1);
        const place = seen.map((frame) => frame.head);
        expect(Math.max(...place) - Math.min(...place)).toBeLessThan(1);
      }
    });

    test("a reader taking hold of the chat stops it there", async ({ page, ui }) => {
      test.skip(isPhone(page), "A wheel");
      await ui.open("image-output");
      const list = await openRun(page, 6);
      const head = list.getByRole("button", { name: /Validate report schema/ });
      await low(head);
      await page.waitForTimeout(200);
      const box = await head.boundingBox();
      if (!box) throw new Error("Nothing to press");
      await record(head, ROW_PANEL);
      await page.mouse.click(box.x + WORDS, box.y + box.height / 2);
      await page.waitForTimeout(60);
      await page.mouse.wheel(0, -40);
      const wheeled = await page.evaluate(() => performance.now());
      await page.waitForTimeout(1400);
      const seen = await recorded(page);
      // The wheel's own scroll aside, nothing moved the page on toward the row's end.
      const after = seen.filter((frame) => frame.t > wheeled + 200);
      expect(moved(after), report(after)).toBeLessThan(1);
    });
  });

test("reduced motion opens at once, and nothing moves after", async ({ page, ui }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ui.open("image-output");
  const list = await openRun(page, 6);
  const head = list.getByRole("button", { name: /Validate report schema/ });
  await low(head);
  await page.waitForTimeout(100);
  const seen = await open(page, head, ROW_PANEL);
  const changes = steps(seen).filter((step) => step.scroll > 0.5 || step.growth > 0.5);
  expect(changes.length, report(seen)).toBeLessThanOrEqual(2);
  await expect(head).toBeInViewport();
});

// What is pressed is marked once, where it is: rows come and go as the list moves.
const workspaceHeads = async (page: Page, fromEnd = 2) => {
  await page.locator(".rail-chat").getByRole("radio", { name: "Workspace" }).click();
  const heads = page.locator(".activity-rail .activity-row-head[aria-expanded]:visible");
  await expect(heads.first()).toBeVisible();
  await page.waitForTimeout(500);
  await heads.evaluateAll((all, at) => {
    (all.at(-at - 1) as HTMLElement).dataset.above = "";
    (all.at(-at) as HTMLElement).dataset.below = "";
  }, fromEnd);
  return { above: page.locator("[data-above]"), below: page.locator("[data-below]") };
};

test("the Workspace panel's steps open the same way", async ({ page, ui }) => {
  test.skip(isPhone(page), "Studio's rail");
  await ui.open("long-run");
  const { below } = await workspaceHeads(page);
  await low(below);
  await page.waitForTimeout(200);
  const seen = await open(page, below, ROW_PANEL);
  runsAsOne(seen);
  await expect(below).toBeInViewport();
});

test("opening the step below an open one keeps it where it is while the other folds", async ({
  page,
  ui,
}) => {
  test.skip(isPhone(page), "Studio's rail");
  const fixture = await ui.open("long-run");
  await page.request.post(`${fixture.origin}/__qa/steps?n=6`);
  const { above, below } = await workspaceHeads(page, 7);
  await above.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(200);
  await press(page, above);
  await page.waitForTimeout(900);
  await expect(below).toBeInViewport();
  const folding = await above.evaluate(
    (node, panel) =>
      node.closest(".activity-row")?.querySelector(panel)?.getBoundingClientRect().height ?? 0,
    ROW_PANEL,
  );
  expect(folding).toBeGreaterThan(200);
  const seen = await open(page, below, ROW_PANEL);
  // It moves for its own opening, not by all that left above it.
  const place = seen.map((frame) => frame.head);
  expect(Math.max(...place) - Math.min(...place), JSON.stringify(place)).toBeLessThan(folding / 2);
});

test("a run of steps, opened at the end of a chat, moves it with its opening", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?n=20&text=History%20message`);
  await page.request.post(`${fixture.origin}/__qa/steps?n=40`);
  await page.request.post(`${fixture.origin}/__qa/finish?done=1`);
  await expect(page.locator(".thread-work[data-live]")).toHaveCount(0);
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const head = page.locator(".thread-work-steps > .ui-disclosure-trigger:visible").last();
  await low(head);
  await page.waitForTimeout(500);
  const seen = await open(page, head, ":scope > .ui-collapse");
  runsAsOne(seen);
  await expect(head).toBeInViewport();
});

test("Recovery options open in place", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/stall/model-busy`);
  const head = page.getByRole("button", { name: "Recovery options" });
  await expect(head).toBeVisible();
  await page.waitForTimeout(500);
  const seen = await open(page, head, ":scope > .ui-collapse");
  runsAsOne(seen);
});

test("a section of Settings opens in place", async ({ page, ui }) => {
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Notifications");
  const quiet = sheet.getByRole("switch", { name: /Quiet hours/ });
  await quiet.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await record(quiet, ".ui-collapse");
  await quiet.locator("xpath=ancestor::label").first().click();
  await expect(quiet).toBeChecked();
  await page.waitForTimeout(1400);
  const seen = await recorded(page);
  expect(moved(seen), report(seen)).toBeLessThan(1);
});
