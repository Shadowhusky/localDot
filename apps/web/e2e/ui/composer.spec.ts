import type { Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

// The composer in each of its states.
runAt("c14", "w39");

const KEY = `sk-ant-api03-${"z".repeat(40)}`;

async function composer(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 1100) {
    // The phone opens on the computer until the task has loaded, so the tab is chosen once it has.
    const tab = page.getByRole("tab", { name: /^Conversation/ });
    await expect(async () => {
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
    }).toPass();
    await expect(page.locator(".thread-row").first()).toBeVisible();
  }
  return page.getByRole("form", { name: "Message dot" });
}

test("composer, at rest", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  await expect(card.getByRole("button", { name: "Stop task" })).toBeVisible();
  if (test.info().project.name === "c14")
    expect((await card.boundingBox())?.height).toBeLessThanOrEqual(140);
  await ui.settle();
});

test("composer, with files", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  await page.route("**/upload?**", (route) => {
    const name = new URL(route.request().url()).searchParams.get("name");
    return route.fulfill({ status: 201, json: { path: `~/Downloads/${name}` } });
  });
  const attach = card.getByRole("button", { name: "Attach files" });
  await expect(attach).toBeEnabled();
  const chooser = page.waitForEvent("filechooser");
  await attach.click();
  await (await chooser).setFiles([
    { name: "monthly-sales-figures-final.csv", mimeType: "text/csv", buffer: Buffer.from("a,b") },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
  ]);
  await expect(card.getByText("Uploaded to Downloads")).toHaveCount(2);
  await card.getByRole("textbox", { name: "Message" }).fill("Use both files for the summary");
  await page.mouse.move(0, 0);
  await ui.settle();
});

test("composer, a key taken out", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  await card.getByRole("textbox", { name: "Message" }).fill(`token ${KEY} please`);
  const notice = card.getByRole("region", { name: "Key safeguard" });
  await expect(notice.getByRole("button", { name: "Move to Keys" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Send now" })).toBeDisabled();
  await ui.settle();
});

test("composer, not sure dot got it", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  await page.route("**/messages", (route) => route.abort());
  const box = card.getByRole("textbox", { name: "Message" });
  await box.fill("Also add a chart of the monthly totals");
  const send = card.getByRole("button", { name: "Send now" });
  await expect(send).toBeEnabled();
  await send.click();
  const rail = page.getByRole("complementary", { name: "Conversation" });
  const waiting = rail.getByRole("region", { name: "Message delivery" });
  await expect(waiting).toContainText("Not sure dot got that.");
  await expect(waiting.getByRole("button", { name: "Send again" })).toBeVisible();
  await expect(box).toHaveValue("Also add a chart of the monthly totals");
  await page.mouse.move(0, 0);
  await ui.settle();
  await ui.still();
});

test("a lost reply that reached dot settles once the thread shows it", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  // The daemon takes the message, but its reply never reaches the page.
  let posts = 0;
  await page.route("**/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts += 1;
    await route.fetch();
    await route.abort();
  });
  const box = card.getByRole("textbox", { name: "Message" });
  await box.fill("Also add a chart of the monthly totals");
  await card.getByRole("button", { name: "Send now" }).click();
  const rail = page.getByRole("complementary", { name: "Conversation" });
  await expect(
    rail.getByRole("article", { name: "You" }).filter({ hasText: "Also add a chart" }),
  ).toHaveCount(1);
  await expect(rail.getByRole("region", { name: "Message delivery" })).toHaveCount(0);
  await expect(box).toHaveValue("");
  await expect(card.getByRole("button", { name: "Send now" })).toHaveAccessibleDescription(
    "Write a message first.",
  );
  expect(posts).toBe(1);
});

test("sending from far back brings the message's place at the end into view", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const card = await composer(page);
  const rail = page.getByRole("complementary", { name: "Conversation" });
  // More than the thread mounts at once, so reading back moves it to an earlier page.
  const said = await page.request.post(
    `${fixture.origin}/__qa/say?n=240&text=Checking%20that%20each%20month%20adds%20up`,
  );
  expect(said.ok()).toBe(true);
  await expect(rail.getByText("Checking that each month adds up (240)")).toBeAttached();
  const scroller = rail.locator(".thread-scroll");
  await expect(async () => {
    await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(rail.getByText("Loading later…")).toBeAttached({ timeout: 500 });
  }).toPass();
  await page.route("**/messages", (route) =>
    route.request().method() === "POST" ? route.abort() : route.fallback(),
  );
  await card.getByRole("textbox", { name: "Message" }).fill("Also add a chart");
  await card.getByRole("button", { name: "Send now" }).click();
  const waiting = rail.getByRole("region", { name: "Message delivery" });
  const again = waiting.getByRole("button", { name: "Send again" });
  await expect(waiting).toContainText("Not sure dot got that.");
  await expect(again).toBeInViewport();
  // Read back again, and the jump button leads to the choice still waiting there.
  await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(again).not.toBeInViewport();
  await rail.getByRole("button", { name: "Check your last message" }).click();
  await expect(again).toBeInViewport();
  await expect(again).toBeFocused();
});

test("a sent message holds its place as its own row takes over", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  await page.route("**/messages", async (route) => {
    await new Promise((done) => setTimeout(done, 300));
    await route.fallback();
  });
  await page.evaluate(() => {
    const frames: { top: number; bottom: number; pending: boolean }[] = [];
    (window as unknown as { sentFrames: typeof frames }).sentFrames = frames;
    const tick = () => {
      const bubbles = document.querySelectorAll(".thread-message[data-role=user] .thread-bubble");
      const last = bubbles[bubbles.length - 1];
      const box = last?.getBoundingClientRect();
      if (box && last?.textContent === "Add a chart of the totals")
        frames.push({
          top: box.top,
          bottom: box.bottom,
          pending: !!last.closest(".thread-pending"),
        });
      if (frames.length < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const box = card.getByRole("textbox", { name: "Message" });
  await box.fill("Add a chart of the totals");
  const send = card.getByRole("button", { name: "Send now" });
  await expect(send).toBeEnabled();
  await send.click();
  const rail = page.getByRole("complementary", { name: "Conversation" });
  await expect(rail.locator(".thread-pending")).toHaveCount(0);
  await expect(
    rail.getByRole("article", { name: "You" }).filter({ hasText: "Add a chart of the totals" }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  const frames = await page.evaluate(
    () =>
      (window as unknown as { sentFrames: { top: number; bottom: number; pending: boolean }[] })
        .sentFrames,
  );
  const handoff = frames.findIndex((frame, index) => index > 0 && !frame.pending);
  expect(frames[0]?.pending).toBe(true);
  expect(handoff).toBeGreaterThan(0);
  // The row draws where its stand-in was, to the pixel; before that the stand-in only eases in.
  const before = frames[handoff - 1],
    after = frames[handoff];
  expect(Math.abs((after?.top ?? 0) - (before?.top ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((after?.bottom ?? 0) - (before?.bottom ?? 0))).toBeLessThanOrEqual(1);
  for (const [index, frame] of frames.entries())
    if (index) expect(Math.abs(frame.top - (frames[index - 1]?.top ?? 0))).toBeLessThanOrEqual(3);
});

test("slash starts a message from anywhere outside a field", async ({ page, ui }) => {
  test.skip(test.info().project.name !== "c14", "A keyboard shortcut, checked on the desktop");
  await ui.open("running");
  const card = await composer(page);
  const box = card.getByRole("textbox", { name: "Message" });
  await expect(box).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("/");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("");
  await page.keyboard.type("/plan");
  await expect(box).toHaveValue("/plan");
});
