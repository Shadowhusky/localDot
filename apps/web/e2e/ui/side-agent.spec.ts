import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { composer, expect, isPhone, runAt, test } from "./harness.ts";

// A side question's steps, sources and spending, with the real side agent reading the fixture's own
// log and frames and only its models scripted, at both widths, in both browsers and in light and dark.
runAt("c14", "c39", "w14", "w39");

const SHOTS = new URL("../out/side-agent/", import.meta.url).pathname;
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await page.screenshot({ path: `${SHOTS}${test.info().project.name}-${name}.png` });
}
const look = (page: Page, appearance: string) =>
  page.addInitScript((value) => {
    localStorage.setItem("localdot.appearance.v1", value);
  }, appearance);

async function ask(page: Page, card: Locator, question: string) {
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await field.click();
  await field.fill("");
  await field.pressSequentially(`/btw ${question}`);
  if (isPhone(page)) await card.getByRole("button", { name: /^Run \// }).click();
  else await page.keyboard.press("Enter");
  await expect(field).toHaveValue("");
  return page.getByRole("region", { name: "Side question" });
}
async function noSideways(page: Page, note: Locator) {
  const fits = await note.evaluate((element) => {
    const room = document.documentElement.clientWidth;
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= room && element.scrollWidth <= element.clientWidth + 1;
  });
  expect(fits).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

for (const appearance of ["daylight", "midnight"] as const) {
  test(`shows its steps, then an answer from the terminal output, in ${appearance}`, async ({
    page,
    ui,
  }) => {
    await look(page, appearance);
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/messages$|\/agent$/.test(request.url()))
        sent.push(request.postData() ?? "");
    });
    await ui.open("running");
    const card = await composer(page);
    const note = await ask(page, card, "What did the terminal command print, slowly?");
    await expect(note.getByRole("status")).toHaveText("Checking the terminal output…");
    await expect(note.getByRole("button", { name: "Stop" })).toBeVisible();
    await noSideways(page, note);
    await ui.still();
    await ui.settle();
    await shot(page, `${appearance}-working`);

    // What came back is the fixture log's real output, which nothing in the record holds.
    await expect(note).toContainText("The command printed:", { timeout: 15_000 });
    await expect(note).toContainText("Total: 12,480");
    await expect(note).toContainText("From the terminal output.");
    await expect(note).toContainText("Not counted in the task's budget.");
    await expect(note).toContainText("Only you see this");
    await expect(note.getByRole("button", { name: "Stop" })).toBeHidden();
    await noSideways(page, note);
    expect(sent).toEqual([]);
    await ui.still();
    await ui.settle();
    await shot(page, `${appearance}-answer`);
  });

  test(`hands over to the main model by itself, in ${appearance}`, async ({ page, ui }) => {
    await look(page, appearance);
    await ui.open("running");
    const card = await composer(page);
    const note = await ask(page, card, "Where is the receipt?");
    await expect(note).toContainText("there is no receipt", { timeout: 15_000 });
    await expect(note).toContainText(/after .* couldn't find it/);
    await expect(note.getByRole("button", { name: /Ask with/ })).toHaveCount(0);
    await noSideways(page, note);
    await ui.still();
    await ui.settle();
    await shot(page, `${appearance}-handed-over`);
  });
}

test("looks at the screen dot last saw, and says so", async ({ page, ui }) => {
  await ui.open("running");
  const note = await ask(page, await composer(page), "What's on the screen?");
  await expect(note).toContainText("The screen shows the sample spreadsheet.");
  await expect(note).toContainText("From the screen.");
});

test("answers from the record alone with no step at all", async ({ page, ui }) => {
  await ui.open("running");
  const note = await ask(page, await composer(page), "Has dot booked anything yet?");
  await expect(note).toContainText("Open the sample spreadsheet");
  await expect(note).toContainText("From what was said in the task.");
});

test("stops when asked, and can ask again", async ({ page, ui }) => {
  await ui.open("running");
  const note = await ask(
    page,
    await composer(page),
    "What did the terminal command print, slowly?",
  );
  await expect(note.getByRole("status")).toHaveText("Checking the terminal output…");
  await note.getByRole("button", { name: "Stop" }).click();
  await expect(note.getByRole("status")).toHaveText("Stopped.");
  await note.getByRole("button", { name: "Ask again" }).click();
  await expect(note).toContainText("The command printed:", { timeout: 15_000 });
});

test("its description says what it can look at", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await field.click();
  await field.pressSequentially("/bt");
  await expect(
    card.getByRole("listbox", { name: "Commands" }).getByRole("option").first(),
  ).toContainText("/btw");
  await expect(card.getByRole("listbox", { name: "Commands" })).toContainText(
    "log, screen and files",
  );
});
