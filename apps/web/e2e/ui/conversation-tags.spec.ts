import type { Page } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

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
  await page.getByRole("button", { name: "Sort into tags" }).click();
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
  await page.getByRole("button", { name: "Sort into tags" }).click();
  const auto = dialog.getByRole("switch", { name: /^Tag new conversations as they finish/ });
  await auto.check();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Sort into tags" }).click();
  await expect(auto).toBeChecked();
});

// A sort says how far it has come, and hidden it goes on in a toast that becomes its result.
test("a sort shows its progress, and goes on in a toast once hidden", async ({ page, ui }) => {
  await ui.open("conversations");
  await page.getByRole("button", { name: "Sort into tags" }).click();
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

// A dozen conversations, each with a tag of its own: more than a line holds.
async function manyTags(page: Page, name = (at: number) => `Topic ${at + 1}`) {
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const listed = await reply.json();
    const colours = ["red", "orange", "yellow", "green", "blue", "purple"];
    const first = listed.conversations[0];
    const conversations = Array.from({ length: 12 }, (_, at) => ({
      ...first,
      sessionId: `01HZ00000000000000000000${String(at + 10).padStart(2, "0")}`,
      sessions: [`01HZ00000000000000000000${String(at + 10).padStart(2, "0")}`],
      title: `Topic task ${at + 1}`,
      tags: [
        {
          id: `01HZ0000000000000000000T${String(at + 1).padStart(2, "0")}`,
          color: colours[at % colours.length],
          name: name(at),
        },
      ],
    }));
    await route.fulfill({ json: { ...listed, conversations } });
  });
}

// The tags keep to one line that scrolls sideways, with no bar, under an All that stays put and
// unfolds every tag in place, with a search and the sort.
test("many tags keep to one line under a pinned All, which unfolds them all in place", async ({
  page,
  ui,
}) => {
  await manyTags(page);
  await ui.open("conversations");
  const row = filters(page);
  const all = page.getByRole("button", { name: "All tags · 12" });
  await expect(all).toBeVisible();
  const tops = await row
    .locator(".conversations-tag")
    .evaluateAll((chips) => chips.map((chip) => Math.round(chip.getBoundingClientRect().top)));
  expect(tops).toHaveLength(12);
  expect(new Set(tops).size).toBe(1);
  await expect(row).toHaveCSS("flex-wrap", "nowrap");
  await expect(row).toHaveCSS("overflow-x", "auto");
  await expect(row).toHaveCSS("scrollbar-width", "none");
  expect(await row.evaluate((strip) => strip.scrollWidth > strip.clientWidth)).toBe(true);
  const pinned = await all.boundingBox();
  await row.evaluate((strip) => {
    strip.scrollLeft = strip.scrollWidth;
  });
  expect(await all.boundingBox()).toEqual(pinned);

  await all.click();
  await expect(all).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("region", { name: "All tags" });
  await expect(list.getByRole("button", { name: "Sort into tags" })).toBeVisible();
  // It unfolds under the line, not over it.
  const [listBox, allBox] = [await list.boundingBox(), await all.boundingBox()];
  expect(listBox?.y ?? 0).toBeGreaterThanOrEqual((allBox?.y ?? 0) + (allBox?.height ?? 0));
  await list.getByRole("textbox", { name: "Find a tag" }).fill("Topic 12");
  await list.getByRole("button", { name: /^Topic 12/ }).click();
  await expect(all).toHaveAttribute("aria-expanded", "false");
  const chosen = row.getByRole("button", { name: "Topic 12" });
  await expect(chosen).toHaveAttribute("aria-pressed", "true");
  await expect(chosen).toBeInViewport({ ratio: 0.9 });
  await expect(page.locator(".phone-row-wrap")).toHaveCount(1);
});

// Studio's list beside the screen: the same line of tags over the names once they show, each one
// showing only the conversations with it; folded to its marks, it lets the tag go.
test.describe("Studio's list", () => {
  test.use({ viewStyle: "studio", phoneList: false });

  test("shows the tags over the names, and only the conversations with the one chosen", async ({
    page,
    ui,
  }) => {
    test.skip(isPhone(page), "A phone has no list beside the screen");
    await manyTags(page);
    await ui.open("conversations");
    const rail = page.locator(".sessions");
    await page.getByRole("button", { name: "Expand conversations" }).click();
    await expect(rail).toHaveAttribute("data-expanded");
    const row = rail.getByRole("group", { name: "Show only a tag" });
    const tops = await row
      .locator(".conversations-tag")
      .evaluateAll((chips) => chips.map((chip) => Math.round(chip.getBoundingClientRect().top)));
    expect(tops).toHaveLength(12);
    expect(new Set(tops).size).toBe(1);
    await expect(rail.getByRole("button", { name: "All tags · 12" })).toBeVisible();
    await row.getByRole("button", { name: "Topic 3", exact: true }).click();
    await expect(rail.locator(".sessions-item")).toHaveCount(1);
    await expect(rail.locator(".sessions-item")).toContainText("Topic task 3");
    await row.getByRole("button", { name: "Topic 3", exact: true }).click();
    await expect(rail.locator(".sessions-item")).toHaveCount(12);
    await row.getByRole("button", { name: "Topic 5", exact: true }).click();
    await page.getByRole("button", { name: "Collapse conversations" }).click();
    await expect(row).toHaveCount(0);
    await expect(rail.locator(".sessions-item")).toHaveCount(12);
  });
});

// A name too long for its row slides to show the rest of itself, and wraps under reduced motion.
test.describe("a long tag name", () => {
  const LONG = "Household paperwork and tax form";
  const longName = (at: number) => (at === 0 ? LONG : `Topic ${at + 1}`);

  test("wraps under reduced motion, so the whole name shows", async ({ page, ui }) => {
    await manyTags(page, longName);
    await ui.open("conversations");
    await page.getByRole("button", { name: /^All tags/ }).click();
    const name = page.getByRole("region", { name: "All tags" }).locator(".ui-marquee").first();
    await name.evaluate((box) => {
      (box as HTMLElement).style.maxWidth = "80px";
    });
    await expect(name).toHaveAttribute("data-wrap");
    await expect(name).toHaveText(LONG);
    expect(await name.evaluate((box) => box.scrollWidth <= box.clientWidth + 1)).toBe(true);
  });

  test.describe("in motion", () => {
    test.use({ reducedMotion: "no-preference" });
    test("slides to show the rest of itself", async ({ page, ui }) => {
      await manyTags(page, longName);
      await ui.open("conversations");
      await page.getByRole("button", { name: /^All tags/ }).click();
      const name = page.getByRole("region", { name: "All tags" }).locator(".ui-marquee").first();
      await name.evaluate((box) => {
        (box as HTMLElement).style.maxWidth = "80px";
      });
      await expect(name).toHaveAttribute("data-over");
      await expect
        .poll(() =>
          name
            .locator(".ui-marquee-text")
            .evaluate(
              (text) => text.getAnimations().filter((a) => a.playState === "running").length,
            ),
        )
        .toBe(1);
    });
  });
});
