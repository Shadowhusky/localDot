import type { Locator, Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

// Counts, every frame from now on, how far the list sits from its end.
async function watch(list: Locator) {
  await list.evaluate((node) => {
    const seen: number[] = [];
    Object.assign(window, { distances: seen });
    const frame = () => {
      seen.push(node.scrollHeight - node.clientHeight - node.scrollTop);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// Once the reader has left the end, the list never went back to it on its own.
async function stayedBack(page: Page) {
  const seen = await page.evaluate(() => (window as unknown as { distances: number[] }).distances);
  const left = seen.findIndex((distance) => distance > 4);
  expect(left, "the reader left the end").toBeGreaterThanOrEqual(0);
  const back = seen.slice(left).findIndex((distance) => distance <= 4);
  expect(back, `snapped back to the end after ${back} frames: ${seen.join(" ")}`).toBe(-1);
  expect(seen.at(-1)).toBeGreaterThan(30);
}

async function atEnd(list: Locator) {
  await expect
    .poll(() => list.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThan(2);
}

// A wheel over the list. Playwright's mobile WebKit has no wheel, so there the wheel event and the
// scroll it makes are dispatched by hand.
async function wheel(page: Page, list: Locator, deltaY: number) {
  if (test.info().project.name !== "w39") return page.mouse.wheel(0, deltaY);
  await list.evaluate((node, delta) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, bubbles: true, cancelable: true }));
    node.scrollTop += delta;
  }, deltaY);
}

// Five small wheel steps back, a trackpad's, while `arrive` keeps adding to the list.
async function wheelBack(page: Page, list: Locator, arrive: () => Promise<unknown>) {
  const box = await list.boundingBox();
  if (!box) throw new Error("Missing list");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 5; step++) {
    await wheel(page, list, -8);
    await arrive();
    await page.waitForTimeout(80);
  }
}

// A finger drags the list back down in small moves while it grows, then lifts.
async function dragBack(page: Page, list: Locator, arrive: () => Promise<unknown>) {
  const box = await list.boundingBox();
  if (!box) throw new Error("Missing list");
  const x = box.x + box.width / 3;
  const y = box.y + box.height / 3;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + step * 8 }],
    });
    await arrive();
    await page.waitForTimeout(40);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("small wheel steps back from the end of a streaming chat stay where the reader left it", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?n=30&text=History%20message`);
  const thread = page.locator(".thread-scroll");
  await expect(thread.locator("article.thread-message").last()).toContainText("(30)");
  await atEnd(thread);
  await page.request.post(`${fixture.origin}/__qa/stream?ms=6000`);
  await expect(thread).toContainText("cell5");
  await watch(thread);
  await wheelBack(page, thread, () => page.waitForTimeout(40));
  await page.waitForTimeout(600);
  await stayedBack(page);
  await expect(page.locator(".thread-jump")).toHaveAttribute("data-shown");
});

test("small wheel steps back in the step list stay put while steps arrive", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/steps?n=40`);
  const work = page.locator(".thread-live .thread-work");
  await expect(work).toContainText("steps");
  await work.getByRole("button", { expanded: false }).click();
  const steps = work.getByRole("region", { name: "Work history" });
  await atEnd(steps);
  await watch(steps);
  await wheelBack(page, steps, () => page.request.post(`${fixture.origin}/__qa/steps?n=1`));
  await page.request.post(`${fixture.origin}/__qa/steps?n=2`);
  await page.waitForTimeout(600);
  await stayedBack(page);
});

test("a finger dragging a streaming chat or the step list back a little keeps it there", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(test.info().project.name === "c14", "Touch runs on the phone projects");
  test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?n=30&text=History%20message`);
  const thread = page.locator(".thread-scroll");
  await expect(thread.locator("article.thread-message").last()).toContainText("(30)");
  await atEnd(thread);
  await page.request.post(`${fixture.origin}/__qa/stream?ms=8000`);
  await expect(thread).toContainText("cell5");
  await watch(thread);
  await dragBack(page, thread, () => page.waitForTimeout(40));
  await page.waitForTimeout(800);
  await stayedBack(page);

  await page.request.post(`${fixture.origin}/__qa/steps?n=40`);
  const work = page.locator(".thread-live .thread-work");
  await work.getByRole("button", { expanded: false }).click();
  const steps = work.getByRole("region", { name: "Work history" });
  await atEnd(steps);
  await watch(steps);
  await dragBack(page, steps, () => page.request.post(`${fixture.origin}/__qa/steps?n=1`));
  await page.waitForTimeout(800);
  await stayedBack(page);
});

test("a wheel back down to the end follows the chat's stream again", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?n=30&text=History%20message`);
  const thread = page.locator(".thread-scroll");
  await expect(thread.locator("article.thread-message").last()).toContainText("(30)");
  await atEnd(thread);
  await page.request.post(`${fixture.origin}/__qa/stream?ms=6000`);
  await expect(thread).toContainText("cell5");
  await wheelBack(page, thread, () => page.waitForTimeout(40));
  await expect(page.locator(".thread-jump")).toHaveAttribute("data-shown");
  await wheel(page, thread, 400);
  await expect(page.locator(".thread-jump")).not.toHaveAttribute("data-shown");
  await page.waitForTimeout(500);
  await atEnd(thread);
});
