import type { Locator } from "@playwright/test";
import { expect, test } from "./harness.ts";

// Each pane is named once on screen: by its tab where tabs show, by its column's label where they
// don't. A pane never repeats that name as a title of its own, and screen readers still get it.
test.beforeEach(() => {
  test.skip(!["c14", "w39"].includes(test.info().project.name), "One check per engine");
});

const PANES = ["Conversation", "Computer", "Activity"] as const;

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

test("a pane under its tab leaves its name to the tab", async ({ page, ui }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1180, "Tabs show below 1180 px");
  await ui.open("running");
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
  for (const name of PANES) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const panel = page.getByRole("tabpanel", { name, exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id")) ?? "");
    expect(await drawn(panel, name), `${name} drawn again under its tab`).toBe(0);
  }
  await page.getByRole("tab", { name: "Conversation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toHaveCount(1);
});

test("each column names itself once, and the task bar doesn't name it again", async ({
  page,
  ui,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1180, "Columns show from 1180 px");
  await ui.open("running");
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
  await expect(page.locator(".thread-row").first()).toBeVisible();
  for (const name of ["Conversation", "Activity"]) {
    const panel = page.getByRole("tabpanel", { name, exact: true });
    expect(await drawn(panel, name), `${name} labels its column`).toBe(1);
  }
  await expect(page.locator(".task-bar")).not.toContainText(/activity/i);
});

test("on a phone, New conversation sits in the top bar and opens the fresh conversation", async ({
  page,
  ui,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1180, "Tabs show below 1180 px");
  await ui.open("continued");
  await expect(page.getByTestId("hud-status")).toHaveText("Done");
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const start = page.getByRole("banner").getByRole("button", { name: "New conversation" });
  await expect(start).toHaveCount(1);
  await expect(page.getByRole("button", { name: "New conversation" })).toHaveCount(1);
  await start.click();
  await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page
      .getByRole("complementary", { name: "Conversation" })
      .getByRole("heading", { name: "What would you like done?" }),
  ).toBeVisible();
});
