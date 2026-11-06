import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

// What a thread shows after any scrolling and sending is what a fresh load of it shows.
runAt("c14", "w39");

test.use({ fixedClock: false });
test.setTimeout(120_000);

async function send(page: Page, text: string) {
  const form = page.getByRole("form", { name: "Message dot" });
  await form.getByRole("textbox", { name: /^(New task|Message)$/ }).fill(text);
  await form.getByRole("button", { name: /^(Start task|Send|Send follow-up|Send now)$/ }).click();
}

async function stopTask(page: Page) {
  await page.locator(".island").getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("Task stopped");
}

// Every row of the thread, oldest first, as a reader meets them: a walk up and back down its pages.
async function walkAll(list: Locator) {
  const seen: { key: string; text: string }[] = [];
  const known = new Set<string>();
  const read = () =>
    list.locator(".thread > .thread-row[data-row]").evaluateAll((rows) =>
      rows.map((row) => ({
        key: (row as HTMLElement).dataset.row ?? "",
        text:
          row.querySelector(".thread-bubble-text, .safe-markdown, .thread-divider")?.textContent ??
          "",
      })),
    );
  const scrollTo = (end: "top" | "bottom") =>
    list.evaluate((node, to) => {
      node.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: to === "top" ? -100 : 100,
          bubbles: true,
          cancelable: true,
        }),
      );
      node.scrollTop = to === "top" ? 0 : node.scrollHeight;
    }, end);
  // Up to the very first row.
  for (let tick = 0; tick < 200; tick++) {
    await scrollTo("top");
    await list.page().waitForTimeout(60);
    if (
      !(await list.locator(".thread-older").count()) &&
      (await list.evaluate((node) => node.scrollTop)) < 2
    )
      break;
  }
  await list.page().waitForTimeout(150);
  // Then down, a view at a time, collecting.
  for (let tick = 0; tick < 400; tick++) {
    for (const row of await read())
      if (!known.has(row.key)) {
        known.add(row.key);
        seen.push(row);
      }
    const done = await list.evaluate(
      (node) => node.scrollHeight - node.clientHeight - node.scrollTop < 2,
    );
    if (done && !(await list.locator(".thread-newer").count())) break;
    await list.evaluate((node) => {
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
      node.scrollTop += node.clientHeight * 0.8;
    });
    await list.page().waitForTimeout(60);
  }
  return seen;
}

test("tasks that follow one another stay in the thread, as a fresh load has them", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("long-thread");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const list = page.locator(".thread-scroll");
  await page.request.post(`${fixture.origin}/__qa/talk?turns=12`);
  await expect(list.locator(".thread-row").last()).toBeVisible({ timeout: 45_000 });
  // Each message to a stopped task starts the next one, with none of them read from the list.
  const replies = list.getByText("Sample reply: I received the task.");
  await stopTask(page);
  await send(page, "Second task please");
  await expect(replies).toHaveCount(1);
  await stopTask(page);
  await send(page, "Third task please");
  await expect(replies).toHaveCount(2);
  // Read up and down meanwhile, as a reader does.
  await list.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    node.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await stopTask(page);
  await page.waitForTimeout(500);
  const lived = await walkAll(list);
  expect(lived.map((row) => row.text)).toContain("Second task please");
  expect(lived.map((row) => row.text)).toContain("Third task please");
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await expect(list.locator(".thread-row").last()).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(300);
  const fresh = await walkAll(list);
  expect(lived).toEqual(fresh);
});

test("a picture that comes after its step was drawn shows without a refresh", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("long-thread");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const list = page.locator(".thread-scroll");
  await page.request.post(`${fixture.origin}/__qa/work?kind=shell`);
  await page.request.post(`${fixture.origin}/__qa/say?text=Looked%20at%20that`);
  await expect(list.getByText("Looked at that")).toBeVisible();
  await page.waitForTimeout(300);
  await page.request.post(`${fixture.origin}/__qa/work?kind=late-image`);
  const picture = list.locator('.thread-picture[aria-label^="Preview image"]').last();
  await expect(picture).toBeVisible();
  await expect
    .poll(() =>
      picture.evaluate((node) => (node.querySelector("img") as HTMLImageElement)?.naturalWidth),
    )
    .toBe(640);
});

test("a picture that failed to load comes back by itself, in a box that keeps its place", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("long-thread");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const list = page.locator(".thread-scroll");
  let refused = 0;
  await page.route("**/api/agent/sessions/*/files/step-image-*", (route) => {
    if (refused++ < 2) return route.abort();
    return route.fallback();
  });
  await page.request.post(`${fixture.origin}/__qa/work?kind=image`);
  await page.request.post(`${fixture.origin}/__qa/say?text=Saw%20the%20picture`);
  await expect(list.getByText("Saw the picture")).toBeVisible();
  const picture = list.locator('.thread-picture[aria-label^="Preview image"]').last();
  await expect(picture).toBeVisible();
  const box = await picture.boundingBox();
  await expect.poll(() => refused).toBeGreaterThan(0);
  expect(box?.height).toBeGreaterThan(40);
  await expect
    .poll(
      () =>
        picture.evaluate((node) => (node.querySelector("img") as HTMLImageElement)?.naturalWidth),
      { timeout: 15_000 },
    )
    .toBe(640);
  expect((await picture.boundingBox())?.height).toBe(box?.height);
  if (isPhone(page)) await page.screenshot({ path: test.info().outputPath("picture-phone.png") });
});
