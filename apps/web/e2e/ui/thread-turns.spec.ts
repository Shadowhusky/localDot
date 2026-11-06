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
  const viewer = page.locator(".file-viewer .viewer-pane:not([data-aside]) img");
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

// How far each steps row's head stands below what it follows, as painted: its hover, press and
// focus fill that head's box, so this is the gap they keep. A focused head is measured with its ring.
const headGaps = (page: Page) =>
  page.locator(".thread > .thread-row[data-kind='work']").evaluateAll((all) =>
    all.flatMap((row) => {
      const head = row.querySelector<HTMLElement>(".thread-work-steps > .ui-disclosure-trigger");
      const before = row.previousElementSibling;
      if (!head || !before?.classList.contains("thread-row")) return [];
      let above = Number.NEGATIVE_INFINITY;
      for (const part of [before, ...before.querySelectorAll("*")]) {
        const box = part.getBoundingClientRect();
        if (box.width && box.height && getComputedStyle(part).visibility !== "hidden")
          above = Math.max(above, box.bottom);
      }
      const style = getComputedStyle(head);
      const ring = head.matches(":focus-visible")
        ? Math.max(
            0,
            Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth),
          )
        : 0;
      return [
        {
          after: before.getAttribute("data-kind"),
          gap: Math.round((head.getBoundingClientRect().top - ring - above) * 10) / 10,
        },
      ];
    }),
  );

const spacing = (page: Page) =>
  page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--spacing")),
  );

for (const style of ["chat", "studio"] as const)
  test.describe(`in ${style}`, () => {
    test.use({ viewStyle: style });

    test("a steps row lights up a step clear of the reply or card it follows", async ({
      page,
      ui,
      browserName,
    }) => {
      await ui.open("narrated");
      const unit = await spacing(page);
      const heads = page.locator(".thread-work-steps > .ui-disclosure-trigger:visible");
      await expect(heads.first()).toBeVisible();
      const gaps = await headGaps(page);
      expect(gaps.length).toBeGreaterThan(0);
      for (const { gap } of gaps) expect(gap).toBeGreaterThanOrEqual(unit);
      // Open, and focused from the keyboard (WebKit, as Safari, shows no ring on a button there).
      const head = heads.last();
      await head.click();
      await expect(head).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Shift");
      await head.focus();
      if (browserName === "chromium")
        expect(await head.evaluate((node) => node.matches(":focus-visible"))).toBe(true);
      for (const { gap } of await headGaps(page)) expect(gap).toBeGreaterThanOrEqual(unit);
    });

    test("a steps row lights up a step clear of dot's words", async ({ page, ui }) => {
      await ui.open("long-thread");
      const unit = await spacing(page);
      await expect(
        page.locator(".thread-work-steps > .ui-disclosure-trigger").first(),
      ).toBeVisible();
      const gaps = (await headGaps(page)).filter((gap) => gap.after === "message");
      expect(gaps.length).toBeGreaterThan(0);
      for (const { gap } of gaps) expect(gap).toBeGreaterThanOrEqual(unit);
      // The same gap under every reply.
      expect(new Set(gaps.map(({ gap }) => gap)).size).toBe(1);
    });
  });
