import type { Page } from "@playwright/test";
import { composer, expect, runAt, test } from "./harness.ts";

// However the run moves, what the user is typing keeps its focus, caret and every key.
runAt("c14", "c39", "w14", "w39");

// Keys pressed one after another for as long as the steps take, with every frame watched for the
// field losing focus.
async function typeThrough(page: Page, origin: string, steps: readonly string[]) {
  const box = (await composer(page)).getByRole("textbox").first();
  await box.click();
  await page.evaluate(() => {
    const field = document.querySelector("textarea.composer-field");
    const lost: string[] = [];
    (window as unknown as { lost: string[] }).lost = lost;
    const watch = () => {
      const active = document.activeElement;
      if (active !== field) lost.push(`${active?.tagName}.${active?.className}`);
      requestAnimationFrame(watch);
    };
    watch();
  });
  let typed = "";
  let typing = true;
  const keys = (async () => {
    for (let n = 0; typing; n++) {
      const key = "abcdefghij"[n % 10] ?? "";
      await page.keyboard.type(key);
      typed += key;
      await page.waitForTimeout(25);
    }
  })();
  for (const step of steps) {
    const reply = await page.request.post(`${origin}/__qa/${step}`);
    expect(reply.ok(), `${step}: ${await reply.text()}`).toBe(true);
    await page.waitForTimeout(500);
    await expect(box, step).toBeFocused();
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.readOnly), step).toBe(false);
    await page.screenshot({
      path: test.info().outputPath(`${step.replace(/\W+/g, "-")}.png`),
    });
  }
  typing = false;
  await keys;
  await expect(box).toHaveValue(typed);
  expect(
    await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([typed.length, typed.length]);
  expect(await page.evaluate(() => (window as unknown as { lost: string[] }).lost)).toEqual([]);
}

test("typing runs through thinking, acting, a new screen, a question, an approval and done", async ({
  page,
  ui,
}) => {
  test.setTimeout(120_000);
  const fixture = await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await typeThrough(page, fixture.origin, [
    "think",
    "steps",
    "stream?ms=800",
    "say?n=4",
    "screen?to=browser",
    "picture/drop",
    "picture/resume",
    "browser/restart",
    "screen",
    "heartbeat",
    "ask",
    "scenario/approval",
    "finish?done=1",
  ]);
});

test("typing runs through a stall, a lost computer and a crash", async ({ page, ui }) => {
  test.setTimeout(120_000);
  const fixture = await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await typeThrough(page, fixture.origin, [
    "stall/model-busy",
    "stall/model-refused",
    "budget",
    "keys-locked",
    "takeover",
    "cell/reconnecting",
    "cell/live",
    "cell/paused",
    "cell/live",
    "cell/fenced",
    "cell/live",
    "crash",
  ]);
});
