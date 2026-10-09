import type { Locator } from "@playwright/test";
import { expect, isPhone, test } from "./harness.ts";

// The rail is named once on screen, by its segmented header, or on a phone by the title of the
// sheet Activity opens in: the view it shows never repeats that name as a title of its own, and
// screen readers still get it.
test.beforeEach(() => {
  test.skip(!["c14", "w39"].includes(test.info().project.name), "One check per engine");
});

// How many times `text` is drawn inside `scope` where the eye can find it: a copy kept for screen
// readers only is clipped out of sight, so the point at its middle hits something else.
async function drawn(scope: Locator, text: string) {
  return scope.evaluate((root, text) => {
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      if (!owner || node.textContent?.trim() !== text) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      if (hit && owner.contains(hit)) count++;
    }
    return count;
  }, text);
}

test("the rail's header names its view, and the view never names itself again", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
  const rail = page.getByRole("complementary", { name: "Conversation" });
  if (isPhone(page)) {
    await expect(rail.getByRole("radiogroup", { name: "Show" })).toHaveCount(0);
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Activity" });
    await expect(sheet.getByRole("complementary", { name: "Plan and steps" })).toBeVisible();
    expect(await drawn(sheet, "Activity"), "Activity drawn once, as the sheet's title").toBe(1);
    return;
  }
  for (const name of ["Activity", "Chat"]) {
    const view = rail.getByRole("radio", { name, exact: true });
    await view.click();
    await expect(view).toHaveAttribute("aria-checked", "true");
    expect(await drawn(rail, name), `${name} drawn once, in the header`).toBe(1);
  }
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toHaveCount(1);
});

test("New conversation sits in the rail's header, or in More on a phone, and opens a fresh one", async ({
  page,
  ui,
}) => {
  await ui.open("continued");
  await expect(page.getByTestId("hud-status")).toHaveText("Done");
  const rail = page.getByRole("complementary", { name: "Conversation" });
  if (isPhone(page)) {
    await rail.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "New conversation" }).click();
  } else {
    // From another view of the rail too, which goes back to the chat.
    await rail.getByRole("radio", { name: "Activity", exact: true }).click();
    const start = rail.getByRole("button", { name: "New conversation" });
    await expect(start).toHaveCount(1);
    await start.click();
    await expect(rail.getByRole("radio", { name: "Chat", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  }
  await expect(rail.getByRole("heading", { name: "What should we do?" })).toBeVisible();
});
