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
// A conversation carries one tag: a colour given after it takes its place.
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
  const home = chooser.getByRole("button", { name: "Home", exact: true });
  await expect(home).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();

  const row = rowOf(page, /^Clean up my Downloads/);
  // The row draws its tag as a colour at its edge, and says its name.
  await expect(row.locator(".ui-tag-name")).toHaveCount(0);
  await expect(row.locator(".ui-tag-mark")).toBeVisible();
  await expect(
    row.getByRole("button", { name: /^Clean up my Downloads folder, Home tag\./ }),
  ).toBeVisible();
  await filters(page).getByRole("button", { name: "Home" }).click();
  await expect(page.locator(".phone-row-wrap")).toHaveCount(1);
  await filters(page).getByRole("button", { name: "Home" }).click();
  await expect(page.locator(".phone-row-wrap")).not.toHaveCount(1);

  // A colour given takes the named tag's place.
  await (await menuOf(page, title)).getByRole("menuitemradio", { name: "Blue" }).click();
  await expect(row.locator(".ui-tag-mark")).toHaveAttribute("data-tag", "blue");
  await expect(filters(page).getByRole("button", { name: "Home" })).toHaveCount(0);

  // Renamed and deleted where it was made.
  await (await menuOf(page, title)).getByRole("menuitem", { name: "Tags…" }).click();
  await expect(home).toHaveAttribute("aria-pressed", "false");
  await chooser.getByRole("button", { name: "Edit Home" }).click();
  await chooser.getByRole("button", { name: "Delete tag" }).click();
  await chooser.getByRole("button", { name: "Delete tag" }).click();
  await expect(home).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(row.locator(".ui-tag-mark")).toHaveAttribute("data-tag", "blue");
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
  await expect(
    rowOf(page, /^Summarise the Q3/).getByRole("button", { name: /, Reports tag\./ }),
  ).toBeVisible();
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(filters(page).getByRole("button", { name: "Errands" })).toHaveCount(0);
  await expect(page.locator(".phone-row-wrap .ui-tag-mark")).toHaveCount(0);

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
    const first = listed.conversations[0];
    // A dozen conversations, each with a tag of its own.
    const conversations = Array.from({ length: 12 }, (_, at) => ({
      ...first,
      sessionId: `01HZ00000000000000000000${String(at + 10).padStart(2, "0")}`,
      sessions: [`01HZ00000000000000000000${String(at + 10).padStart(2, "0")}`],
      title: `Topic task ${at + 1}`,
      tags: [
        {
          id: `01HZ0000000000000000000T${String(at + 1).padStart(2, "0")}`,
          color: colours[at % colours.length],
          name: `Topic ${at + 1}`,
        },
      ],
    }));
    await route.fulfill({ json: { ...listed, conversations } });
  });
  await ui.open("conversations");
  const row = filters(page);
  await expect(row.getByRole("button", { name: /^All tags · \d+$/ })).toBeVisible();
  expect(await row.locator(".conversations-tag .ui-tag-dot").count()).toBeLessThanOrEqual(8);
  // Nothing in the row scrolls, sideways or up and down: it wraps.
  await expect(row).toHaveCSS("overflow-x", "visible");
  await expect(row).toHaveCSS("overflow-y", "visible");
  await expect(row).toHaveCSS("flex-wrap", "wrap");
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
