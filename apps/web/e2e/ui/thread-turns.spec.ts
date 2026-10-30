import type { Page } from "@playwright/test";
import { chatRail, expect, isPhone, runAt, test } from "./harness.ts";

// A turn reads as it happened: dot's words, the steps after them with the pictures they showed,
// and its answer last.
runAt("c14", "c39", "w39");

// Each row of the thread, as a reader meets it.
const rows = (page: Page) =>
  page.locator(".thread > .thread-row").evaluateAll((all) =>
    all.map((row) => {
      const kind = row.getAttribute("data-kind");
      if (kind === "work")
        return `steps: ${row.querySelector(".ui-disclosure-summary, .activity-row-title, .thread-work-status")?.textContent}`;
      if (kind === "message")
        return `${row.querySelector("[data-narration]") ? "narrates" : row.getAttribute("data-speaker")}: ${row.querySelector(".thread-bubble-text, .safe-markdown")?.textContent?.slice(0, 24)}`;
      return kind;
    }),
  );

test("a turn puts its steps and pictures between dot's words, and ends on the answer", async ({
  page,
  ui,
}) => {
  await ui.open("narrated");
  const rail = await chatRail(page);
  await expect(rail.getByRole("region", { name: "Task result" })).toBeVisible();
  expect(await rows(page)).toEqual([
    "user: Summarise the sample sal",
    "narrates: I'll open the spreadshee",
    "steps: Worked for 0:05 · 2 steps",
    "narrates: The table is open and th",
    "steps: Worked for 0:07 · 3 steps · 1 failed",
    "narrates: There's no schema file t",
    "steps: Writing the short report",
    "dot: Report readyThe monthly ",
    "result",
    "meta",
  ]);
  // Finished runs fold; what failed stays in sight on the fold.
  const heads = rail.locator(".thread-work-steps > .ui-disclosure-trigger");
  await expect(heads).toHaveCount(2);
  for (const head of await heads.all())
    await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(rail.locator(".thread-work-failed")).toHaveText("1 failed");
  // The narration reads quieter than the answer.
  const colour = (selector: string) =>
    rail
      .locator(selector)
      .first()
      .evaluate((node) => getComputedStyle(node).color);
  expect(await colour("[data-narration]")).not.toBe(
    await colour(".thread-message[data-role=dot]:not([data-narration])"),
  );

  // The screen the first run left opens large, and gives the focus back once closed.
  const screenshot = rail.getByRole("button", {
    name: "Preview screenshot: Adding up the net total for each month",
  });
  await screenshot.scrollIntoViewIfNeeded();
  await expect(screenshot.locator("img")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("turn.png") });
  await screenshot.click();
  const dialog = page.getByRole("dialog", { name: "Step screenshot", exact: true });
  await expect(dialog.getByRole("img", { name: "Step screenshot" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(screenshot).toBeFocused();

  // The image a tool read opens in the files viewer.
  const picture = rail.getByRole("button", {
    name: "Preview image: ~/flower-poster/assets/hero1.jpg",
  });
  await picture.scrollIntoViewIfNeeded();
  await picture.click();
  const viewer = page.locator(".file-viewer img");
  await expect
    .poll(() => viewer.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(640);
  await page.locator(".file-viewer").getByRole("button", { name: "Close", exact: true }).click();

  // A run opens in place by keyboard; Escape folds it again.
  const failed = heads.nth(1);
  await failed.focus();
  await page.keyboard.press("Enter");
  await expect(failed).toHaveAttribute("aria-expanded", "true");
  const list = rail.getByRole("list", { name: "Steps" });
  await expect(
    list.getByTestId("tool-row").filter({ hasText: "Validate report schema" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(failed).toHaveAttribute("aria-expanded", "false");
  await expect(failed).toBeFocused();
});

test("a long run streams its steps open in the thread, and folds each run once dot speaks", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("long-run");
  const rail = await chatRail(page);
  const live = rail.locator(".thread-work[data-live]");
  await expect(live.locator(".ui-disclosure-summary")).toContainText(
    "Working · 8 steps · 2 failed",
  );
  await expect(live.locator(".thread-work-steps > .ui-disclosure-trigger")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(live.getByRole("region", { name: "Work history" })).toContainText(
    "Fill the tail with brown",
  );
  // Earlier runs are folded under the words that started them.
  const folded = rail.locator(
    ".thread-work:not([data-live]) .thread-work-steps > .ui-disclosure-trigger",
  );
  await expect(folded).toHaveCount(3);
  for (const head of await folded.all())
    await expect(head).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: test.info().outputPath("live.png") });

  // dot speaks and moves on: the run it left folds, and the next streams under its words.
  const said = await page.request.post(
    `${fixture.origin}/__qa/say?text=${encodeURIComponent("The body is brown. Now the ears and the tail.")}`,
  );
  expect(said.ok()).toBe(true);
  await page.request.post(`${fixture.origin}/__qa/steps?n=2`);
  await expect(live.locator(".ui-disclosure-summary")).toContainText("Working · 2 steps");
  await expect(live).toContainText("Fill area 2 with brown");
  await expect(folded).toHaveCount(4);
  const [left, words, now] = (await rows(page)).slice(-3);
  expect(left).toMatch(/^steps: Worked for \d+:\d\d · 8 steps · 2 failed$/);
  expect(words).toBe("narrates: The body is brown. Now t");
  expect(now).toMatch(/^steps: Working · 2 steps · \d+:\d\d$/);
  // The thread follows the run dot is at.
  await expect(live.locator(".activity-row").last()).toBeInViewport();
  if (isPhone(page)) await expect(page.locator(".thread-toolbar")).toBeInViewport();
});
