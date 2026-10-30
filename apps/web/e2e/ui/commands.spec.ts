import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { composer, expect, isPhone, runAt, test } from "./harness.ts";

// The composer's slash commands, a side question only the user sees, and the action palette, at
// both widths and in both appearances.
runAt("c14", "c39", "w39");

// Kept where Playwright's own output, emptied on every run, is not.
const SHOTS = new URL("../out/commands/", import.meta.url).pathname;
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  // Layers fade in, rows ease in: the picture waits until they have.
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

async function look(page: Page, appearance: "graphite" | "midnight") {
  await page.addInitScript((value) => {
    localStorage.setItem("localdot.appearance.v1", value);
  }, appearance);
}

// Mod+K on a keyboard; a phone's More menu offers the same palette.
async function openPalette(page: Page) {
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Search actions" }).click();
  } else await page.keyboard.press("ControlOrMeta+k");
  return page.getByRole("dialog", { name: "Search actions" });
}

async function send(page: Page, card: Locator) {
  // A phone's Return starts a new line; its Send button runs the command.
  if (isPhone(page)) await card.getByRole("button", { name: /^Run \// }).click();
  else await page.keyboard.press("Enter");
}

for (const appearance of ["graphite", "midnight"] as const)
  test(`slash commands and a side question, in ${appearance}`, async ({ page, ui }) => {
    await look(page, appearance);
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/messages$|\/agent$/.test(request.url()))
        sent.push(request.postData() ?? "");
    });
    await ui.open("running");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
    const card = await composer(page);
    const field = card.getByRole("textbox", { name: "Message", exact: true });
    await field.click();
    await field.pressSequentially("/");
    const menu = card.getByRole("listbox", { name: "Commands" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option").first()).toContainText("/btw");
    await expect(field).toHaveAttribute("aria-controls", (await menu.getAttribute("id")) ?? "");
    await ui.still();
    await ui.settle();
    await shot(page, `${appearance}-menu`);

    await field.pressSequentially("re");
    await expect(menu.getByRole("option")).toHaveText([
      /^\/resume/,
      /^\/rename/,
      /^\/replay/,
      /^\/research/,
      /^\/remember/,
      /^\/report/,
    ]);
    if (!isPhone(page)) {
      await page.keyboard.press("ArrowDown");
      await expect(field).toHaveAttribute(
        "aria-activedescendant",
        (await menu.getByRole("option").nth(1).getAttribute("id")) ?? "",
      );
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }

    await field.fill("");
    await field.pressSequentially("/btw Has dot booked anything yet?");
    await send(page, card);
    const note = page.getByRole("region", { name: "Side question" });
    await expect(note).toContainText("Open the sample spreadsheet");
    await expect(note).toContainText("Only you see this");
    await expect(field).toHaveValue("");
    await expect(page.locator(".thread").getByText("Has dot booked anything yet?")).toHaveCount(1);
    expect(sent).toEqual([]);
    await ui.still();
    await ui.settle();
    await shot(page, `${appearance}-side-answer`);

    const palette = await openPalette(page);
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("group", { name: "Suggested" })).toContainText("Stop the task");
    await ui.settle();
    await shot(page, `${appearance}-palette`);
    const search = palette.getByRole("combobox");
    await search.fill("midnight");
    await expect(palette.getByRole("option").first()).toContainText("Midnight");
    await ui.settle();
    await shot(page, `${appearance}-palette-search`);
    await search.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "midnight");
  });

test("the palette runs actions from the keyboard and gives focus back", async ({ page, ui }) => {
  test.skip(isPhone(page), "A keyboard flow");
  await ui.open("running");
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await field.click();
  let palette = await openPalette(page);
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("activity");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByRole("radio", { name: "Activity" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  palette = await openPalette(page);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+?");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toContainText("Search actions");
  await ui.settle();
  await shot(page, "shortcuts");
  await page.keyboard.press("Escape");
  await expect(shortcuts).toBeHidden();
});
