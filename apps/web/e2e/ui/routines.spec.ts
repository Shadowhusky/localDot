import type { Locator, Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { chatRail, expect, isPhone, runAt, test } from "./harness.ts";

// A routine dot drafted waits above the composer until it is answered, the editor says what a
// schedule means as it is built, and a routine's runs read as one conversation.
runAt("c14", "c39", "w14", "w39");

const LONG = Array.from(
  { length: 40 },
  (_, n) =>
    `Line ${n + 1} of what dot says after it drafted the routine, which goes on for a while.`,
).join("\n\n");

const qa = async (page: Page, origin: string, path: string) => {
  const reply = await page.request.post(`${origin}/__qa/${path}`);
  expect(reply.ok(), await reply.text()).toBe(true);
  return reply;
};
// In the dark and the light appearance, for looking at by eye.
async function shot(page: Page, name: string) {
  for (const appearance of ["graphite", "daylight"]) {
    await page.evaluate((shown) => {
      document.documentElement.dataset.appearance = shown;
    }, appearance);
    // Colours ease from one appearance to the other.
    await page.waitForTimeout(500);
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "graphite";
  });
}
// A press on a phone is a tap: a mouse press opens a picker under the pointer.
const press = (page: Page, target: Locator) => (isPhone(page) ? target.tap() : target.click());
// Whether it lies within the thread's scroller, as a reader sees it.
const shownInThread = (target: Locator) =>
  target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const view = element.closest(".thread-scroll")?.getBoundingClientRect();
    return !!view && box.top < view.bottom && box.bottom > view.top;
  });

test("a drafted routine stays above the composer however much dot says after it", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await chatRail(page);
  await qa(page, fixture.origin, "routine/propose");
  const pending = page.getByRole("region", { name: /Routine waiting for you/ });
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("Weekdays at 8:30");
  await expect(pending.getByRole("button", { name: "Save routine" })).toBeVisible();

  await qa(page, fixture.origin, `say?text=${encodeURIComponent(LONG)}`);
  const said = page
    .getByRole("region", { name: "Conversation history" })
    .getByText("Line 40 of what dot says");
  await expect(said).toBeVisible();
  await expect.poll(() => shownInThread(said)).toBe(true);
  // Above the composer, all of it, with the composer still in its place under it.
  const held = await pending.boundingBox();
  const field = await page.getByRole("textbox", { name: "Message", exact: true }).boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(held && field && held.y + held.height <= field.y).toBe(true);
  expect(held && held.y >= 0 && held.y + held.height <= height).toBe(true);
  // The card where dot drafted it has scrolled away and says only that it waits.
  const card = page.getByRole("article", { name: "Routine: Morning bills" });
  await expect(card).toContainText("Waiting for your answer");
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect.poll(() => shownInThread(card)).toBe(false);
  await shot(page, "pending-after-summary");

  await pending.getByRole("button", { name: "Save routine" }).click();
  await expect(pending).toBeHidden();
  await expect(card).toContainText("Saved · Next");
});

test("Discard answers it, and it comes back after a reload until then", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await chatRail(page);
  await qa(page, fixture.origin, "routine/propose");
  const pending = page.getByRole("region", { name: /Routine waiting for you/ });
  await expect(pending).toBeVisible();
  ui.leaving();
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await expect(pending).toBeVisible();
  await pending.getByRole("button", { name: "Discard" }).click();
  await expect(pending).toBeHidden();
  await expect(page.getByRole("article", { name: "Routine: Morning bills" })).toContainText(
    "Discarded",
  );
});

test("the editor builds several schedules and says when they run", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await chatRail(page);
  await qa(page, fixture.origin, "routine/propose");
  const pending = page.getByRole("region", { name: /Routine waiting for you/ });
  await pending.getByRole("button", { name: "Edit" }).click();
  const sheet = page.getByRole("dialog", { name: "Save this routine" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("status")).toHaveText("Weekdays at 8:30 · London time");
  await expect(sheet.getByRole("list", { name: "Next runs" }).getByRole("listitem")).toHaveCount(5);

  await sheet.getByRole("button", { name: "Add time" }).click();
  await sheet.getByRole("textbox", { name: "Time 2" }).fill("17:00");
  await expect(sheet.getByRole("status")).toHaveText("Weekdays at 8:30 and 17:00 · London time");
  await sheet.getByRole("button", { name: "Add another schedule" }).click();
  const second = sheet.locator(".routine-schedule").nth(1);
  await second.getByRole("textbox", { name: "How many" }).fill("2");
  await press(page, second.getByRole("combobox", { name: "Period" }));
  await press(page, page.getByRole("option", { name: "months" }));
  await second.getByRole("button", { name: "Day 1", exact: true }).click();
  await second.getByRole("button", { name: "The last day of the month" }).click();
  await expect(sheet.getByRole("status")).toHaveText(
    "Weekdays at 8:30 and 17:00; Every 2 months on the last day at 9:00 · London time",
  );
  await shot(page, "editor-two-schedules");
  await second.scrollIntoViewIfNeeded();
  await shot(page, "editor-month-days");
  await sheet.getByRole("list", { name: "Next runs" }).scrollIntoViewIfNeeded();
  await shot(page, "editor-next-runs");
  await sheet.getByRole("button", { name: "Save routine" }).click();
  await expect(sheet).toBeHidden();
  await expect(pending).toBeHidden();
  await expect(page.getByRole("article", { name: "Routine: Morning bills" })).toContainText(
    "Weekdays at 8:30 and 17:00; Every 2 months on the last day",
  );
});

test("a routine's runs read as one conversation, one divider per run", async ({ page, ui }) => {
  const fixture = await ui.open("first-run");
  const reply = await qa(page, fixture.origin, "routine/runs");
  const { runs } = (await reply.json()) as { runs: string[] };
  ui.leaving();
  // A notification about the first run opens the conversation, not its recording.
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await page.evaluate((id) => {
    window.location.hash = `session=${id}`;
  }, runs[0]);
  const rail = await chatRail(page);
  await expect(rail.getByText("1 new statement saved to Bills")).toBeVisible();
  await expect(rail.getByText("3 new statements saved to Bills")).toBeAttached();
  await expect(page.locator(".thread-divider").filter({ hasText: "Routine run" })).toHaveCount(3);
  await expect(page.getByRole("article", { name: "You" })).toHaveCount(3);
  await shot(page, "one-conversation");
});

test("a routine's sheet lists its schedule and opens its conversation", async ({ page, ui }) => {
  const fixture = await ui.open("first-run");
  await qa(page, fixture.origin, "routine/runs");
  await qa(page, fixture.origin, "routine/history");
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).last().tap();
    await page.getByRole("menuitem", { name: "Routines" }).tap();
  } else await page.getByRole("radio", { name: "Routines" }).click();
  const row = page
    .locator(".routines-panel")
    .getByRole("button", { name: /Morning bills/ })
    .first();
  await expect(row).toBeVisible();
  await shot(page, "routines-list");
  await press(page, row);
  const sheet = page.getByRole("dialog", { name: "Morning bills" });
  await expect(sheet.getByText("Weekdays at 8:30 · London time")).toBeVisible();
  await shot(page, "routine-detail");
  await press(page, sheet.getByRole("button", { name: "Open conversation" }));
  await expect(sheet).toBeHidden();
  const rail = await chatRail(page);
  await expect(rail.getByText("1 new statement saved to Bills")).toBeVisible();
});
