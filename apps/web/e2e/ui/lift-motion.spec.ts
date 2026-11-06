import type { Locator, Page } from "@playwright/test";
import sharp from "sharp";
import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ viewStyle: "chat", reducedMotion: "no-preference", fixedClock: false });

type Rect = [number, number, number, number];

interface Frame {
  t: number;
  // What it lifted out of.
  source: Rect | null;
  sourceShows: boolean;
  // The moving copy, and how much of it, its card and what dims the page show.
  copy: Rect | null;
  copyOpacity: number;
  card: number;
  plate: number;
  dim: number;
  layer: number;
}

interface Watch {
  source: string;
  // What moves: the first of these on the page.
  copy: readonly string[];
  card?: string;
  plate: string;
  dim: string;
}

const PEEK: Watch = {
  source: ".phone-row[aria-label^='Clean up my Downloads']",
  copy: [".peek-row", ".peek-card"],
  card: ".peek-card",
  plate: ".peek-plate",
  dim: ".peek-scrim",
};
const BUBBLE: Watch = {
  source: '.phone-thread .thread-message[data-role="user"] .thread-bubble',
  copy: [".bubble-hold-preview"],
  plate: ".bubble-hold-plate",
  dim: ".bubble-hold-back",
};

declare global {
  interface Window {
    liftFrames?: Frame[];
    liftHeld?: boolean;
    letLand?(): void;
  }
}

// Every frame from here on: where things are and what shows of them, as the page has them to paint.
async function recordFrames(page: Page, watch: Watch) {
  await page.evaluate((w) => {
    const frames: Frame[] = [];
    window.liftFrames = frames;
    const rect = (element: Element | null): Rect | null => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return [box.left, box.top, box.width, box.height];
    };
    const opacity = (selector?: string) => {
      const element = selector ? document.querySelector(selector) : null;
      return element ? Number(getComputedStyle(element).opacity) : 0;
    };
    const tick = () => {
      const all = document.querySelectorAll(w.source);
      const source = all[0] ?? null;
      const style = source && getComputedStyle(source);
      const copy = w.copy.map((each) => document.querySelector(each)).find(Boolean) ?? null;
      frames.push({
        t: performance.now(),
        source: rect(source),
        sourceShows: !!style && style.visibility === "visible" && Number(style.opacity) > 0,
        copy: rect(copy),
        copyOpacity: copy ? Number(getComputedStyle(copy).opacity) : 0,
        card: opacity(w.card),
        plate: opacity(w.plate),
        dim: opacity(w.dim),
        layer: copy?.closest(".ui-layer") ? opacity(".ui-layer:has(> .lift-copy)") : 0,
      });
      requestAnimationFrame(tick);
    };
    tick();
  }, watch);
}

const framesOf = (page: Page) => page.evaluate(() => window.liftFrames ?? []);

const distance = (a: Rect, b: Rect) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);

// The whole of what the owner asked of a close: the copy and what it came from never show together,
// something always shows, it goes straight home in one motion, and it lands exactly on the row.
function expectWentHome(frames: Frame[]) {
  const flying = frames.filter((frame) => frame.copy);
  expect(flying.length, "it took frames to go home").toBeGreaterThan(5);
  for (const frame of frames) {
    if (frame.copy) expect(frame.sourceShows, "the row and its copy at once").toBe(false);
    else expect(frame.sourceShows, "neither the row nor its copy").toBe(true);
  }
  const home = (frames.at(-1) as Frame).source as Rect;
  const away = flying.map((frame) => distance(frame.copy as Rect, home));
  away.forEach((now, index) => {
    const before = away[index - 1];
    if (before !== undefined) expect(now, "it never turns back").toBeLessThanOrEqual(before + 0.5);
  });
  const last = flying.at(-1) as Frame;
  expect(distance(last.copy as Rect, home), "it lands on the row").toBeLessThan(0.5);
  expect(last.copyOpacity).toBe(1);
  expect(last.card).toBe(0);
  expect(last.plate).toBe(0);
  expect(last.dim).toBe(0);
}

// No step bigger than a fast spring takes in the time it had, weighed by the frames it spans.
function expectNoJump(frames: Frame[]) {
  const flying = frames.filter((frame) => frame.copy);
  flying.slice(1).forEach((frame, index) => {
    const before = flying[index] as Frame;
    const spans = Math.max(1, (frame.t - before.t) / 16.7);
    expect(distance(frame.copy as Rect, before.copy as Rect) / spans).toBeLessThan(90);
  });
}

// Stops the page's frames as soon as `dim` reaches nothing, which is when it is drawn on its place.
async function holdAtLanding(page: Page, dim: string) {
  await page.evaluate((selector) => {
    const raf = window.requestAnimationFrame.bind(window);
    let waiting: FrameRequestCallback[] = [];
    let landed = false;
    window.liftHeld = false;
    window.letLand = () => {
      landed = true;
      window.liftHeld = false;
      const queue = waiting;
      waiting = [];
      for (const callback of queue) raf(callback);
    };
    window.requestAnimationFrame = (callback) =>
      raf((t) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!landed && element?.style.opacity === "0") window.liftHeld = true;
        if (window.liftHeld) waiting.push(callback);
        else callback(t);
      });
  }, dim);
}

async function expectSamePixels(page: Page, before: Buffer, after: Buffer, box: Rect) {
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const { width = 0, height = 0 } = await sharp(after).metadata();
  const left = Math.max(0, Math.round(box[0] * scale));
  const top = Math.max(0, Math.round(box[1] * scale));
  const region = {
    left,
    top,
    width: Math.min(width - left, Math.round(box[2] * scale)),
    height: Math.min(height - top, Math.round(box[3] * scale)),
  };
  const read = (png: Buffer) => sharp(png).extract(region).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([read(before), read(after)]);
  let total = 0;
  for (let index = 0; index < a.length; index++)
    total += Math.abs((a[index] as number) - (b[index] as number));
  expect(total / a.length, "the mean change at the swap, of 255").toBeLessThan(0.5);
}

async function pressAndHold(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("Nothing to hold");
  await page.mouse.click(box.x + box.width / 2, box.y + Math.min(30, box.height / 2), {
    button: "right",
  });
}

const closed = async (page: Page, watch: Watch) => {
  await expect(page.locator(watch.copy.join())).toHaveCount(0);
  await page.waitForTimeout(120);
};

test.describe("a conversation's row", () => {
  test.use({ phoneList: true });

  const openList = async (page: Page, ui: { open(s: "conversations"): Promise<unknown> }) => {
    await ui.open("conversations");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const row = page.locator(PEEK.source);
    await expect(row).toBeVisible();
    return row;
  };

  test("goes straight home and lands on its own pixels", async ({ page, ui }) => {
    const row = await openList(page, ui);
    await pressAndHold(page, row);
    const menu = page.getByRole("menu", { name: "Conversation actions" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(700);
    await recordFrames(page, PEEK);
    await page.keyboard.press("Escape");
    await closed(page, PEEK);
    const frames = await framesOf(page);
    expectWentHome(frames);
    expectNoJump(frames);
  });

  test("shows nothing at the swap", async ({ page, ui }) => {
    const row = await openList(page, ui);
    const box = await row.boundingBox();
    if (!box) throw new Error("No row");
    await pressAndHold(page, row);
    await expect(page.locator(PEEK.card as string)).toBeVisible();
    await page.waitForTimeout(700);
    await holdAtLanding(page, PEEK.dim);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => window.liftHeld)).toBe(true);
    const landing = await page.screenshot();
    await page.evaluate(() => window.letLand?.());
    await closed(page, PEEK);
    const after = await page.screenshot();
    await expectSamePixels(page, landing, after, [box.x, box.y, box.width, box.height]);
  });

  test("closed while still opening, it turns back from where it has got to", async ({
    page,
    ui,
  }) => {
    const row = await openList(page, ui);
    await recordFrames(page, PEEK);
    const home = await row.boundingBox();
    await pressAndHold(page, row);
    // Part of the way there.
    await page.waitForFunction(
      (top) =>
        Math.abs((document.querySelector(".peek-row")?.getBoundingClientRect().top ?? top) - top) >
        15,
      home?.y ?? 0,
    );
    await page.keyboard.press("Escape");
    await closed(page, PEEK);
    const frames = await framesOf(page);
    const flying = frames.filter((frame) => frame.copy);
    expect(flying.length).toBeGreaterThan(5);
    for (const frame of frames) if (frame.copy) expect(frame.sourceShows).toBe(false);
    expectNoJump(frames);
    const end = (frames.at(-1) as Frame).source as Rect;
    expect(distance((flying.at(-1) as Frame).copy as Rect, end)).toBeLessThan(0.5);
  });

  test("lands where the row has got to if the list moves on the way", async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height: 520 });
    await ui.open("conversations");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const row = page.locator(PEEK.source);
    await row.scrollIntoViewIfNeeded();
    const list = page.locator(".phone-list-scroll").first();
    await pressAndHold(page, row);
    await expect(page.locator(PEEK.card as string)).toBeVisible();
    await page.waitForTimeout(700);
    await recordFrames(page, PEEK);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
    const moved = await list.evaluate((node) => {
      const before = node.scrollTop;
      node.scrollTop = before > 30 ? before - 30 : before + 30;
      return node.scrollTop - before;
    });
    expect(Math.abs(moved)).toBeGreaterThan(0);
    await closed(page, PEEK);
    const frames = await framesOf(page);
    const home = (frames.at(-1) as Frame).source as Rect;
    const flying = frames.filter((frame) => frame.copy);
    expect(distance((flying.at(-1) as Frame).copy as Rect, home)).toBeLessThan(0.5);
    for (const frame of frames) if (frame.copy) expect(frame.sourceShows).toBe(false);
  });

  test("fades on its way if the choice takes the row away", async ({ page, ui }) => {
    const row = await openList(page, ui);
    await pressAndHold(page, row);
    const menu = page.getByRole("menu", { name: "Conversation actions" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(600);
    await recordFrames(page, PEEK);
    await menu.getByRole("menuitem", { name: "Rename" }).click();
    await closed(page, PEEK);
    const frames = await framesOf(page);
    const flying = frames.filter((frame) => frame.copy);
    expect(flying.length).toBeGreaterThan(0);
    await expect(page.locator(".phone-row-renaming")).toBeVisible();
    // Archived: the row goes while the copy may still be on its way, which must not leave anything.
    await page.keyboard.press("Escape");
    const again = page.locator(PEEK.source);
    await pressAndHold(page, again);
    await expect(menu).toBeVisible();
    await page.waitForTimeout(600);
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    await closed(page, PEEK);
    await expect(page.locator(PEEK.source)).toHaveCount(0);
    await expect(page.locator(".peek-scrim")).toHaveCount(0);
  });

  test("fades over the row, without travelling, under reduced motion", async ({ page, ui }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const row = await openList(page, ui);
    await pressAndHold(page, row);
    await expect(page.locator(PEEK.card as string)).toBeVisible();
    await page.waitForTimeout(400);
    await recordFrames(page, PEEK);
    await page.keyboard.press("Escape");
    await closed(page, PEEK);
    const frames = await framesOf(page);
    const showing = frames.filter((frame) => frame.copy);
    expect(showing.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.sourceShows, "the row stays").toBe(true);
    const first = showing[0] as Frame;
    for (const frame of showing)
      expect(distance(frame.copy as Rect, first.copy as Rect), "nothing travels").toBeLessThan(0.5);
    const faded = showing.map((frame) => frame.layer);
    expect(faded.at(-1)).toBeLessThan(faded[0] as number);
  });
});

test.describe("a message", () => {
  const openThread = async (page: Page, ui: { open(s: "done"): Promise<unknown> }) => {
    await ui.open("done");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const bubble = page.locator(BUBBLE.source).last();
    await expect(bubble).toBeVisible();
    return bubble;
  };

  test("lifts as it is, wrapped the same, and goes straight home", async ({ page, ui }) => {
    const bubble = await openThread(page, ui);
    const seen = await bubble.boundingBox();
    if (!seen) throw new Error("No bubble");
    await pressAndHold(page, bubble);
    await expect(page.getByRole("menu", { name: "Message actions" })).toBeVisible();
    await page.waitForTimeout(700);
    const lifted = await page.locator(BUBBLE.copy.join()).boundingBox();
    // Grown a little, and no other shape: the words wrap as they do in the thread.
    expect(lifted?.width).toBeCloseTo(seen.width * 1.025, 0);
    expect(lifted?.height).toBeCloseTo(seen.height * 1.025, 0);
    await recordFrames(page, BUBBLE);
    await page.keyboard.press("Escape");
    await closed(page, BUBBLE);
    const frames = await framesOf(page);
    expectWentHome(frames);
    expectNoJump(frames);
  });

  test("shows nothing at the swap", async ({ page, ui }) => {
    const bubble = await openThread(page, ui);
    await pressAndHold(page, bubble);
    await expect(page.getByRole("menu", { name: "Message actions" })).toBeVisible();
    await page.waitForTimeout(700);
    await page.mouse.move(4, 4);
    await holdAtLanding(page, BUBBLE.dim);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => window.liftHeld)).toBe(true);
    const landing = await page.screenshot();
    await page.evaluate(() => window.letLand?.());
    await closed(page, BUBBLE);
    const after = await page.screenshot();
    const box = await bubble.boundingBox();
    if (!box) throw new Error("No bubble");
    await expectSamePixels(page, landing, after, [box.x, box.y, box.width, box.height]);
  });

  test("too tall for the screen, it opens out to its full height on the way home", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 390, height: 360 });
    await ui.open("done");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    // The reply with the most in it, too tall to lift whole over its menu.
    const replies = page.locator('.phone-thread .thread-message[data-role="dot"]');
    const heights = await replies.evaluateAll((all) => all.map((node) => node.clientHeight));
    const reply = replies.nth(heights.indexOf(Math.max(...heights)));
    await reply.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect(reply).toBeInViewport();
    await page.waitForTimeout(400);
    const watch = { ...BUBBLE, source: "[data-never]" };
    await pressAndHold(page, reply);
    await expect(page.getByRole("menu", { name: "Message actions" })).toBeVisible();
    await page.waitForTimeout(700);
    await expect(page.locator(".bubble-hold-preview[data-clip]")).toBeVisible();
    await recordFrames(page, watch);
    await page.keyboard.press("Escape");
    await closed(page, BUBBLE);
    const frames = await framesOf(page);
    const last = frames.filter((frame) => frame.copy).at(-1) as Frame;
    const landed = await reply.boundingBox();
    expect(Math.abs((last.copy as Rect)[3] - (landed?.height ?? 0))).toBeLessThan(0.5);
    expect(Math.abs((last.copy as Rect)[1] - (landed?.y ?? 0))).toBeLessThan(0.5);
  });
});

test.describe("the dot", () => {
  async function recordFlyer(page: Page) {
    await page.evaluate(() => {
      const frames: { shown: boolean; opacity: number; size: number; away: boolean }[] = [];
      (window as unknown as { flyerFrames: typeof frames }).flyerFrames = frames;
      const tick = () => {
        const flyer = document.querySelector<HTMLElement>(".phone-flyer");
        if (flyer)
          frames.push({
            shown: flyer.dataset.shown !== undefined,
            opacity: Number(getComputedStyle(flyer).opacity),
            size: flyer.getBoundingClientRect().width,
            away: document.querySelector(".app")?.hasAttribute("data-dot-away") ?? false,
          });
        requestAnimationFrame(tick);
      };
      tick();
    });
  }
  const flyerFrames = (page: Page) =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            flyerFrames: { shown: boolean; opacity: number; size: number; away: boolean }[];
          }
        ).flyerFrames,
    );

  test("tucks into ⋯ by shrinking away, and comes out the same way", async ({ page, ui }) => {
    await ui.open("running");
    await expect(page.locator(".dot-strip .narrator-dot")).toBeVisible();
    await page.getByRole("button", { name: "Your dot" }).click();
    await recordFlyer(page);
    await page.getByRole("menuitem", { name: "Hide dot" }).click();
    await expect(page.locator(".phone-coach")).toBeVisible();
    const shown = (await flyerFrames(page)).filter((frame) => frame.shown);
    expect(shown.length).toBeGreaterThan(5);
    const last = shown.at(-1);
    expect(last?.opacity, "nothing of it is left to vanish").toBeLessThan(0.1);
    expect(last?.size).toBeLessThan(16);
  });

  test("dissolves into the real one where it lands", async ({ page, ui }) => {
    await ui.open("running");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "0");
    await page.waitForTimeout(900);
    await recordFlyer(page);
    await page.locator(".phone-row").first().click();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "1");
    await page.waitForTimeout(1100);
    const frames = await flyerFrames(page);
    const shown = frames.filter((frame) => frame.shown);
    if (shown.length === 0) return;
    const back = shown.findIndex((frame) => !frame.away);
    expect(back, "the real dot comes back under it").toBeGreaterThan(0);
    const after = shown.slice(back);
    expect(after.length, "for more than one frame").toBeGreaterThan(2);
    expect(after.at(-1)?.opacity).toBeLessThan(0.3);
  });
});

test("the picture lands bare, and its rim and time come up around it", async ({ page, ui }) => {
  await ui.open("running");
  await page.waitForTimeout(800);
  await page
    .getByRole("button", { name: /^Open the computer/ })
    .first()
    .click();
  await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "2");
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const frames: { gone: boolean; time: number; clip: string }[] = [];
    (window as unknown as { pictureFrames: typeof frames }).pictureFrames = frames;
    const tick = () => {
      const thumb = document.querySelector(".phone-thumb");
      const time = document.querySelector(".phone-thumb-rim");
      const picture = document.querySelector<HTMLElement>(".phone-picture");
      if (thumb && time && picture)
        frames.push({
          gone: thumb.hasAttribute("data-gone"),
          time: Number(getComputedStyle(time).opacity),
          clip: picture.style.overflow,
        });
      requestAnimationFrame(tick);
    };
    tick();
  });
  await page.getByRole("button", { name: "Back to the conversation" }).click();
  await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "1");
  await page.waitForTimeout(1000);
  const frames = await page.evaluate(
    () =>
      (window as unknown as { pictureFrames: { gone: boolean; time: number; clip: string }[] })
        .pictureFrames,
  );
  const flying = frames.filter((frame) => frame.gone);
  expect(flying.length).toBeGreaterThan(2);
  expect(flying.at(-1)?.clip, "with the corners it arrives with").toBe("hidden");
  const landed = frames.findIndex((frame, index) => index > 0 && !frame.gone);
  expect(frames[landed]?.time ?? 1, "no rim pops on").toBeLessThan(0.9);
  expect(frames.at(-1)?.time).toBe(1);
});
