import type { Locator, Page } from "@playwright/test";
import { attachFiles } from "./attach.ts";
import { composer, expect, runAt, test } from "./harness.ts";

// A message sent while dot works: it waits at the end of the thread, Edit takes it back into the
// composer with its files, Stop leaves it unsent for Edit to take back, and the files a message
// carried sit atop its bubble.
runAt("c14", "c39", "w39");

// Rows that arrive ease in; the picture waits until they have.
async function shot(page: Page, name: string) {
  await page.locator(".thread").evaluate((thread) =>
    Promise.all(
      thread
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

// Like Attach, Send can be held off for a moment: a press it held off is made again, one that went
// through is not.
async function queue(page: Page, card: Locator, text: string) {
  await card.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  const sent = page.locator(".thread-pending, .thread-message").filter({ hasText: text });
  await expect(async () => {
    if (!(await sent.count()))
      await card.getByRole("button", { name: "Queue message" }).click({ timeout: 2000 });
    await expect(sent).not.toHaveCount(0, { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
}

// The thread's rows top to bottom: a message by its words, anything else by its kind.
const order = (page: Page) =>
  page
    .locator(".thread > .thread-row")
    .evaluateAll((rows) =>
      rows.map((row) =>
        row.getAttribute("data-kind") === "message"
          ? row.querySelector(".thread-bubble-text, .safe-markdown")?.textContent
          : row.getAttribute("data-kind"),
      ),
    );

const yours = (page: Page, text: string) =>
  page.getByRole("article", { name: "You", exact: true }).filter({ hasText: text });

test("a queued message stays at the end while dot works, then sits where dot received it", async ({
  page,
  ui,
  browserName,
}) => {
  const fixture = await ui.open("running");
  const card = await composer(page);
  // Held on its way, it waits drawn as its row will be.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/agent/sessions/*/messages", async (route) => {
    await held;
    await route.continue();
  });
  await queue(page, card, "Then tidy up the sheet");
  const waiting = page.locator(".thread-pending .thread-bubble");
  await expect(waiting).toBeVisible();
  await expect(page.locator(".thread-pending .thread-queue")).toContainText("After this task");
  await ui.settle();
  const before = await waiting.boundingBox();
  release();
  const row = yours(page, "Then tidy up the sheet");
  await expect(row.getByRole("button", { name: "Steer now" })).toBeEnabled();
  await expect(page.locator(".thread-pending")).toHaveCount(0);
  await ui.settle();
  const after = await row.locator(".thread-bubble").boundingBox();
  if (!before || !after) throw new Error("Missing bubble");
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);

  for (const text of ["February's net total checks out.", "Now checking March."]) {
    const said = await page.request.post(
      `${fixture.origin}/__qa/say?text=${encodeURIComponent(text)}`,
    );
    expect(said.ok()).toBe(true);
    await expect(page.locator(".thread .safe-markdown").filter({ hasText: text })).toHaveCount(1);
  }
  expect((await order(page)).slice(-3)).toEqual([
    "February's net total checks out.",
    "Now checking March.",
    "Then tidy up the sheet",
  ]);
  await expect(row.getByText("After this task")).toBeVisible();
  await ui.settle();
  await ui.still();
  await shot(page, "12-queued");

  // The task finishes and dot receives it: it follows the result, and starts a turn of its own.
  expect((await page.request.post(`${fixture.origin}/__qa/finish`)).ok()).toBe(true);
  await expect(row.getByText("After this task")).toHaveCount(0);
  const settled = async () => {
    const rows = await order(page);
    const at = rows.indexOf("Then tidy up the sheet");
    return { last: rows.at(-1), before: rows.slice(0, at).includes("Now checking March.") };
  };
  await expect.poll(settled).toEqual({ last: "Then tidy up the sheet", before: true });
  const rows = await order(page);
  const result = rows.indexOf("result");
  expect(result).toBeGreaterThan(rows.indexOf("Now checking March."));
  expect(rows.indexOf("Then tidy up the sheet")).toBeGreaterThan(result);
  await ui.settle();
  await ui.still();
  await shot(page, "12-delivered");
  // Read again from the task's history, the thread is the same. WebKit reports the status check a
  // reload cuts short as a page error, so the history is read again in Chromium.
  if (browserName === "webkit") return;
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(yours(page, "Then tidy up the sheet")).toHaveCount(1);
  await expect.poll(() => order(page)).toEqual(rows);
});

test("Edit takes a queued message back into the composer with its files", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await attachFiles(page, card, ["monthly-sales-figures-final.csv", "notes.txt"]);
  await queue(page, card, "Use both files for the summary");
  const queued = yours(page, "Use both files for the summary");
  await expect(queued.getByText("After this task")).toBeVisible();
  await expect(card.getByRole("list", { name: "Attached files" })).toBeHidden();
  await field.fill("My existing draft");
  await queued.getByRole("button", { name: "Edit", exact: true }).click();

  await expect(queued).toHaveCount(0);
  await expect(field).toHaveValue("My existing draft\n\nUse both files for the summary");
  await expect(field).toBeFocused();
  expect(await field.evaluate((box: HTMLTextAreaElement) => box.selectionStart)).toBe(
    "My existing draft\n\nUse both files for the summary".length,
  );
  const chips = card.getByRole("list", { name: "Attached files" });
  await expect(chips.getByRole("listitem")).toHaveCount(2);
  await expect(chips.getByText("Uploaded to Downloads")).toHaveCount(2);
  await expect(chips).toContainText("notes.txt");
  await ui.settle();
  await ui.still();
  await shot(page, "08-after-edit");

  // Removing a file it brought back leaves the file on the computer.
  const removed: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE") removed.push(request.url());
  });
  await chips.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(chips.getByRole("listitem")).toHaveCount(1);
  await queue(page, card, "Use the sales file for the summary");
  const resent = yours(page, "Use the sales file for the summary");
  await expect(resent.getByText("After this task")).toBeVisible();
  await expect(resent.getByRole("list", { name: "Attached files" })).toHaveText(
    /monthly-sales-figur.*inal\.csv/,
  );
  await expect(field).toHaveValue("");
  expect(removed).toEqual([]);
});

test("a message Stop left unsent waits for Edit to take it back", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await attachFiles(page, card, ["notes.txt"]);
  await queue(page, card, "Then tidy up the sheet");
  const queued = yours(page, "Then tidy up the sheet");
  await expect(queued.getByText("After this task")).toBeVisible();
  await card.getByRole("button", { name: "Stop task" }).click();
  await expect(card.getByRole("button", { name: "Stop task" })).toHaveCount(0);
  await expect(queued.getByText("Not sent")).toBeVisible();
  await expect(queued.getByRole("list", { name: "Attached files" })).toHaveText(/notes\.txt/);
  expect((await order(page)).at(-1)).toBe("Then tidy up the sheet");
  await shot(page, "stop-unsent");
  await queued.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(queued).toHaveCount(0);
  await expect(field).toHaveValue("Then tidy up the sheet");
  await expect(field).toBeFocused();
  const chips = card.getByRole("list", { name: "Attached files" });
  await expect(chips.getByText("Uploaded to Downloads")).toHaveCount(1);
  await expect(chips).toContainText("notes.txt");
});

test("the files a message carried sit atop its bubble on one line that scrolls", async ({
  page,
  ui,
  browserName,
}) => {
  await ui.open("running");
  const card = await composer(page);
  await attachFiles(page, card, [
    "monthly-sales-figures-final-version-2.csv",
    "notes.txt",
    "quarterly-board-deck-summary.pdf",
    "receipt-scan-0042.png",
  ]);
  await queue(page, card, "Use these files");
  const bubble = yours(page, "Use these files").locator(".thread-bubble");
  const files = bubble.getByRole("list", { name: "Attached files" });
  await expect(files.getByRole("listitem")).toHaveCount(4);
  await ui.settle();
  const layout = await bubble.evaluate((element) => {
    const list = element.querySelector<HTMLElement>(".thread-bubble-files");
    const text = element.querySelector<HTMLElement>(".thread-bubble-text");
    if (!list || !text) throw new Error("Missing bubble parts");
    const box = element.getBoundingClientRect();
    const chips = [...list.children].map((chip) => chip.getBoundingClientRect());
    const words = document.createRange();
    words.selectNodeContents(text);
    return {
      firstChild: element.firstElementChild === list,
      tops: chips.map((chip) => Math.round(chip.top)),
      // Chips keep their whole width, inside a row that scrolls to the bubble's edge.
      kept: [...list.children].every(
        (chip) => chip.getBoundingClientRect().width >= chip.scrollWidth - 0.5,
      ),
      scrolls: list.scrollWidth > list.clientWidth,
      focusable: list.tabIndex === 0,
      edges: [
        list.getBoundingClientRect().left - box.left,
        box.right - list.getBoundingClientRect().right,
      ],
      aligned: Math.abs((chips[0]?.left ?? 0) - words.getBoundingClientRect().left),
      above: (chips[0]?.bottom ?? 0) <= text.getBoundingClientRect().top,
      bubbleWidth: box.width,
      thread: element.closest(".thread")?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(layout.firstChild).toBe(true);
  expect(new Set(layout.tops).size).toBe(1);
  expect(layout.kept).toBe(true);
  expect(layout.scrolls).toBe(true);
  expect(layout.focusable).toBe(true);
  expect(layout.edges.map((edge) => Math.round(edge))).toEqual([0, 0]);
  expect(layout.aligned).toBeLessThan(1);
  expect(layout.above).toBe(true);
  expect(layout.bubbleWidth).toBeLessThanOrEqual(layout.thread * 0.86 + 1);
  await ui.still();
  await shot(page, "18-files");
  // The keys scroll the row once it has focus; Playwright's WebKit scrolls no focused box by key.
  if (browserName !== "chromium") return;
  await files.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => files.evaluate((list) => list.scrollLeft)).toBeGreaterThan(0);
  await shot(page, "18-files-scrolled");
});
