import type { Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w39");
test.use({ viewStyle: "chat", phoneList: true });

const filters = (page: Page) => page.getByRole("group", { name: "Show only a tag" });
const rowOf = (page: Page, title: RegExp) =>
  page.locator(".phone-row-wrap").filter({ has: page.getByRole("button", { name: title }) });

async function menuOf(page: Page, title: string) {
  await page.getByRole("button", { name: `Actions for ${title}` }).focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Conversation actions" });
  await expect(menu).toBeVisible();
  return menu;
}

// A tag the user names, made where it is given, then a way to show only the conversations with it.
test("a row's menu makes a tag and gives it, and the list shows only those with it", async ({
  page,
  ui,
}) => {
  await ui.open("conversations");
  const title = "Clean up my Downloads folder";
  const menu = await menuOf(page, title);
  await menu.getByRole("menuitem", { name: "Tags…" }).click();
  const chooser = page.getByRole("dialog", { name: "Tags" });
  await expect(chooser).toBeVisible();
  await chooser.getByRole("textbox", { name: "Find or make a tag" }).fill("Home");
  await chooser.getByRole("button", { name: "Make the tag “Home”" }).click();
  await expect(chooser.getByRole("checkbox", { name: "Home" })).toBeChecked();
  await chooser.getByRole("checkbox", { name: "Blue" }).click();
  await expect(chooser.getByRole("checkbox", { name: "Blue" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();

  const row = rowOf(page, /^Clean up my Downloads/);
  await expect(row.locator(".ui-tag-name")).toHaveText("Home");
  await expect(row.locator(".ui-tag-mark")).toHaveAttribute("data-tag", "blue");
  await filters(page).getByRole("button", { name: "Home" }).click();
  await expect(page.locator(".phone-row-wrap")).toHaveCount(1);
  await filters(page).getByRole("button", { name: "Home" }).click();
  await expect(page.locator(".phone-row-wrap")).not.toHaveCount(1);

  // Renamed and deleted where it was made; deleting takes it off every conversation.
  await (await menuOf(page, title)).getByRole("menuitem", { name: "Tags…" }).click();
  await chooser.getByRole("button", { name: "Edit Home" }).click();
  await chooser.getByRole("button", { name: "Delete tag" }).click();
  await chooser.getByRole("button", { name: "Delete tag" }).click();
  await expect(chooser.getByRole("checkbox", { name: "Home" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(row.locator(".ui-tag-name")).toHaveCount(0);
  await expect(filters(page).getByRole("button", { name: "Home" })).toHaveCount(0);
});

// The user's model sorts the conversations at once, as finely as asked; Undo takes the sort back.
test("Sort into tags tags every conversation with the user's model, and Undo takes it back", async ({
  page,
  ui,
}) => {
  await ui.open("conversations");
  await filters(page).getByRole("button", { name: "Sort into tags" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Sort into tags" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: /^Detailed/ }).check();
  await expect(dialog.getByRole("checkbox", { name: /^Make new tags/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Sort", exact: true }).click();
  await expect(dialog).toBeHidden();
  const toast = page.locator(".ui-toast").filter({ hasText: /^Tagged \d+ conversations/ });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("New tags: Reports, Errands");
  await expect(filters(page).getByRole("button", { name: "Reports" })).toBeVisible();
  await expect(filters(page).getByRole("button", { name: "Errands" })).toBeVisible();
  await expect(rowOf(page, /^Summarise the Q3/).locator(".ui-tag-name")).toHaveText("Reports");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(filters(page).getByRole("button", { name: "Errands" })).toHaveCount(0);
  await expect(page.locator(".phone-row-wrap .ui-tag-name")).toHaveCount(0);

  // Auto tagging is kept as soon as it is switched.
  await filters(page).getByRole("button", { name: "Sort into tags" }).click();
  const auto = dialog.getByRole("switch", { name: /^Tag new conversations as they finish/ });
  await auto.check();
  await page.getByRole("button", { name: "Cancel" }).click();
  await filters(page).getByRole("button", { name: "Sort into tags" }).click();
  await expect(auto).toBeChecked();
});

// A sort says how far it has come, and hidden it goes on in a toast that becomes its result.
test("a sort shows its progress, and goes on in a toast once hidden", async ({ page, ui }) => {
  await ui.open("conversations");
  await filters(page).getByRole("button", { name: "Sort into tags" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Sort into tags" });
  await dialog.getByRole("button", { name: "Sort", exact: true }).click();
  await expect(dialog.getByRole("progressbar", { name: "Sorting" })).toBeVisible();
  await expect(dialog).toContainText("Your model is reading your conversations…");
  await dialog.getByRole("button", { name: "Hide" }).click();
  await expect(dialog).toBeHidden();
  const toast = page.locator(".ui-toast").last();
  await expect(toast).toContainText(/Your model is reading|Tagged \d+ conversations/);
  await expect(
    page.locator(".ui-toast").filter({ hasText: /^Tagged \d+ conversations/ }),
  ).toBeVisible();
});

// Past a row's worth of tags, the rest are a search away, the row never scrolling sideways.
test("many tags keep to a row, the rest found under All tags", async ({ page, ui }) => {
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const listed = await reply.json();
    const colours = ["red", "orange", "yellow", "green", "blue", "purple"];
    let n = 0;
    const named = (count: number) =>
      Array.from({ length: count }, () => {
        n += 1;
        return {
          id: `01HZ0000000000000000000T${String(n).padStart(2, "0")}`,
          color: colours[n % colours.length],
          name: `Topic ${n}`,
        };
      });
    await route.fulfill({
      json: {
        ...listed,
        conversations: listed.conversations.map((entry: object) => ({ ...entry, tags: named(2) })),
      },
    });
  });
  await ui.open("conversations");
  const row = filters(page);
  await expect(row.getByRole("button", { name: /^All tags · \d+$/ })).toBeVisible();
  expect(await row.locator(".conversations-tag .ui-tag-dot").count()).toBeLessThanOrEqual(8);
  // Nothing in the row scrolls, sideways or up and down.
  expect(
    await row.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  await row.getByRole("button", { name: /^All tags/ }).click();
  const all = page.getByRole("dialog", { name: "All tags" });
  await all.getByRole("textbox", { name: "Find a tag" }).fill("Topic 12");
  await all.getByRole("button", { name: /^Topic 12/ }).click();
  await expect(all).toBeHidden();
  await expect(row.getByRole("button", { name: "Topic 12" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".phone-row-wrap")).toHaveCount(1);
});
