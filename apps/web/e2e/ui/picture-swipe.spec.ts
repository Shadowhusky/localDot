import type { CDPSession, Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

// Real touches, which only Chromium can inject, and real motion on a running clock.
runAt("c39");
test.use({ fixedClock: false, reducedMotion: "no-preference" });

async function open(page: Page, ui: { open(name: "image-output"): Promise<{ origin: string }> }) {
  const fixture = await ui.open("image-output");
  for (const [alt, colour] of [
    ["First picture", "c8553d"],
    ["Second picture", "3d7ac8"],
    ["Third picture", "4fa36b"],
    ["Fourth picture", "b04fc8"],
  ]) {
    const read = await page.request.post(
      `${fixture.origin}/__qa/work?kind=image&alt=${encodeURIComponent(alt as string)}&colour=${colour}`,
    );
    expect(read.ok(), await read.text()).toBe(true);
  }
  const pictures = page.getByRole("list", { name: "Pictures" }).last();
  await pictures.getByRole("button", { name: /^Show \d+ more pictures$/ }).click();
  await pictures.getByRole("button", { name: "Preview image: First picture" }).click();
  const sheet = page.locator(".file-viewer");
  await expect(page.getByRole("dialog", { name: "First picture" })).toBeVisible();
  const canvas = sheet.locator(".viewer-pane:not([data-aside]) .viewer-canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  // Risen all the way: a touch where it is still on its way would land off the screen.
  const top = () => sheet.evaluate((node) => node.getBoundingClientRect().top);
  await expect.poll(top).toBeLessThan(100);
  await sheet.evaluate((node) =>
    Promise.all(node.getAnimations().map((motion) => motion.finished.catch(() => {}))),
  );
  return sheet;
}

const left = (sheet: ReturnType<Page["locator"]>, selector: string) =>
  sheet.locator(selector).evaluate((element) => element.getBoundingClientRect().left);
const CURRENT = ".viewer-pane:not([data-aside])";

async function drag(
  cdp: CDPSession,
  from: { x: number; y: number },
  by: { x: number; y: number },
  steps = 10,
) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, ...from }],
  });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ id: 1, x: from.x + (by.x * i) / steps, y: from.y + (by.y * i) / steps }],
    });
    await new Promise((done) => setTimeout(done, 16));
  }
}
const lift = (cdp: CDPSession) =>
  cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

test("a swipe carries the next picture in under the finger and settles on it", async ({
  page,
  ui,
}) => {
  const sheet = await open(page, ui);
  const cdp = await page.context().newCDPSession(page);
  const box = await sheet.locator(`${CURRENT} .viewer-picture`).boundingBox();
  if (!box) throw new Error("No stage");
  const at = { x: box.x + box.width * 0.7, y: box.y + box.height / 2 };
  const start = await left(sheet, CURRENT);

  await drag(cdp, at, { x: -160, y: 0 });
  const held = await left(sheet, CURRENT);
  // Follows the finger, less the slop before it counted as a swipe.
  expect(start - held).toBeGreaterThan(130);
  expect(start - held).toBeLessThanOrEqual(160);
  const neighbour = await sheet
    .locator(".viewer-pane[data-aside]")
    .last()
    .evaluate((pane) => pane.getBoundingClientRect().left);
  expect(neighbour - held).toBeCloseTo(box.width + 24, 0);
  await page.screenshot({ path: test.info().outputPath("mid-swipe.png") });
  await drag(cdp, { x: at.x - 160, y: at.y }, { x: -60, y: 0 }, 4);
  await lift(cdp);
  await expect(page.getByRole("dialog", { name: "Second picture" })).toBeVisible();
  // It lands where a picture rests, by a spring rather than at once.
  const during = await left(sheet, CURRENT);
  await expect.poll(() => left(sheet, CURRENT), { timeout: 3000 }).toBeCloseTo(start, 0);
  expect(Math.abs(during - start)).toBeGreaterThan(0);
  await expect.poll(() => sheet.locator(CURRENT).evaluate((pane) => pane.style.transform)).toBe("");
  await cdp.detach();
});

test("a short drag goes back, and the first picture resists rather than wraps", async ({
  page,
  ui,
}) => {
  const sheet = await open(page, ui);
  const cdp = await page.context().newCDPSession(page);
  const box = await sheet.locator(`${CURRENT} .viewer-picture`).boundingBox();
  if (!box) throw new Error("No stage");
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const start = await left(sheet, CURRENT);

  // Past the first picture the drag gives less and less.
  await drag(cdp, at, { x: 170, y: 0 });
  const pulled = (await left(sheet, CURRENT)) - start;
  expect(pulled).toBeGreaterThan(20);
  expect(pulled).toBeLessThan(120);
  await lift(cdp);
  await expect.poll(() => left(sheet, CURRENT), { timeout: 3000 }).toBeCloseTo(start, 0);
  await expect(sheet.locator(".viewer-count")).toContainText("1 of ");

  // Slowly, and not far: it stays.
  await drag(cdp, at, { x: -40, y: 0 }, 20);
  await page.waitForTimeout(200);
  await drag(cdp, { x: at.x - 40, y: at.y }, { x: -1, y: 0 }, 2);
  await lift(cdp);
  await expect.poll(() => left(sheet, CURRENT), { timeout: 3000 }).toBeCloseTo(start, 0);
  await expect(sheet.locator(".viewer-count")).toContainText("1 of ");

  // Straight down neither turns nor moves it.
  await drag(cdp, at, { x: 0, y: 120 });
  expect(await left(sheet, CURRENT)).toBeCloseTo(start, 0);
  await lift(cdp);
  await expect(sheet.locator(".viewer-count")).toContainText("1 of ");
  await cdp.detach();
});

test("a pinch after a swipe that went back still zooms, and a zoomed picture pans", async ({
  page,
  ui,
}) => {
  const sheet = await open(page, ui);
  const cdp = await page.context().newCDPSession(page);
  const box = await sheet.locator(`${CURRENT} .viewer-picture`).boundingBox();
  if (!box) throw new Error("No stage");
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await drag(cdp, at, { x: 80, y: 0 });
  await lift(cdp);
  await page.waitForTimeout(600);
  const canvas = sheet.locator(`${CURRENT} .viewer-canvas`);
  const scale = () => canvas.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a);
  const fitted = await scale();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, x: at.x - 30, y: at.y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: at.x - 30, y: at.y },
      { id: 2, x: at.x + 30, y: at.y },
    ],
  });
  for (let i = 1; i <= 8; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { id: 1, x: at.x - 30 - i * 9, y: at.y },
        { id: 2, x: at.x + 30 + i * 9, y: at.y },
      ],
    });
  await expect.poll(scale).toBeGreaterThan(fitted * 1.5);
  await lift(cdp);
  await expect(sheet.locator(".viewer-count")).toContainText("1 of ");

  // Zoomed, one finger moves the picture and the row stays where it is.
  const start = await left(sheet, CURRENT);
  await drag(cdp, at, { x: -120, y: 0 });
  await lift(cdp);
  expect(await left(sheet, CURRENT)).toBeCloseTo(start, 0);
  await expect(sheet.locator(".viewer-count")).toContainText("1 of ");
  await cdp.detach();
});
