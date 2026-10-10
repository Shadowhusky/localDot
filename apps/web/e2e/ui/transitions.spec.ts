import type { Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

// Moving between states: the page's entrance, a new conversation and the list of conversations,
// each without a frame of what is about to go away.
runAt("c14", "c39");

interface Frame {
  t: number;
  setup: boolean;
  messages: string;
}

// Records what every frame shows, from the first paint on.
async function recordFrames(page: Page) {
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    (window as unknown as { frames_: Frame[] }).frames_ = frames;
    const start = performance.now();
    const tick = () => {
      frames.push({
        t: Math.round(performance.now() - start),
        setup: !!document.querySelector(".setup"),
        messages: [...document.querySelectorAll(".thread-message")]
          .map((message) => message.textContent)
          .join("|"),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => (window as unknown as { frames_: Frame[] }).frames_.splice(0));
}

async function capture(page: Page, name: string, count: number, everyMs: number) {
  for (let n = 0; n < count; n++) {
    await page.screenshot({ path: test.info().outputPath(`${name}-${n}.png`) });
    await page.waitForTimeout(everyMs);
  }
}

test("the page comes in without ever showing setup steps that are done", async ({ page, ui }) => {
  const frames = await recordFrames(page);
  await ui.open("slow-keys");
  await capture(page, "load", 8, 250);
  await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const seen = await frames();
  expect(seen.length).toBeGreaterThan(30);
  expect(seen.filter((frame) => frame.setup)).toEqual([]);
});

test("New conversation clears the thread at once", async ({ page, ui }) => {
  const frames = await recordFrames(page);
  await ui.open("conversations");
  const thread = page.getByRole("region", { name: "Conversation history" });
  await expect(thread.locator(".thread-message").first()).toBeVisible();
  await ui.settle();
  await frames();
  if (test.info().project.name === "c39") {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "New conversation" }).click();
  } else await page.getByRole("button", { name: "New conversation" }).click();
  await capture(page, "new", 4, 120);
  await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
  const after = await frames();
  // The first frames may still be the press itself; from the first cleared frame on, the old
  // conversation never comes back.
  const cleared = after.findIndex((frame) => frame.messages === "");
  expect(cleared).toBeGreaterThanOrEqual(0);
  expect(after.slice(cleared).filter((frame) => frame.messages !== "")).toEqual([]);
});

test("the list of conversations, by day, takes one up", async ({ page, ui }) => {
  await ui.open("conversations");
  const thread = page.getByRole("region", { name: "Conversation history" });
  await expect(thread.locator(".thread-message").first()).toBeVisible();
  if (test.info().project.name === "c39") {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Conversations" }).click();
  } else await page.getByRole("button", { name: "Conversations" }).click();
  const list = page.getByRole("grid", { name: "Recent conversations" });
  await expect(list.getByRole("row")).toHaveCount(7);
  await expect(list.getByRole("rowgroup")).toHaveCount(3);
  await ui.settle();
  await ui.still();
  await page.screenshot({ path: test.info().outputPath("list.png") });
  const search = page.getByRole("combobox", { name: "Search conversations" });
  await search.fill("lisbon");
  await expect(list.getByRole("row")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("list-search.png") });
  await search.press("Enter");
  await expect(list).toBeHidden();
  await expect(thread).toContainText("Book the 9:40 one");
  await expect(thread).not.toContainText("Find last month's sales table");
});
