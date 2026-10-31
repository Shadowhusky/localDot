import type { Page } from "@playwright/test";
import { chatRail, composer, expect, type Harness, isPhone, runAt, test } from "./harness.ts";

// A new conversation gets dot's own name and, with Auto on, the dot that fits it, both from one
// quick request beside the task. The user can switch that dot for the task and rename the
// conversation, and Replay calls it by the same name.
runAt("c14", "c39");

const TITLE = "Kyoto autumn trip";
const RENAMED = "Mum's Kyoto trip";

async function shot(page: Page, ui: Harness, name: string) {
  for (const appearance of ["graphite", "midnight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await ui.settle();
    await ui.still();
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
}

async function conversations(page: Page) {
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Conversations", exact: true }).click();
  } else await page.getByRole("button", { name: "Conversations", exact: true }).click();
  return page.getByRole("grid", { name: "Recent conversations" });
}

test("Auto picks the dot and dot names the conversation; the user changes both", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready");
  await page.request.post(`${fixture.origin}/__qa/first-look`, {
    data: { title: TITLE, persona: "research", reason: "Needs sources, dates and prices" },
  });

  await page.getByRole("button", { name: /^Change your dot/ }).click();
  const chooser = page.getByRole("dialog", { name: "Your dot" });
  const auto = chooser.getByRole("switch", { name: "Auto" });
  await expect(auto).not.toBeChecked();
  await expect(chooser).toContainText("A new task may wait up to 4 seconds for it.");
  await auto.click();
  await expect(auto).toBeChecked();
  await expect(chooser).toContainText("When Auto can't pick in time");
  await shot(page, ui, "dot-chooser-auto");
  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();

  const form = await composer(page);
  await form
    .getByRole("textbox", { name: /^(New task|Message)$/ })
    .fill("plan 3 autumn days in kyoto, temples + food, not too pricey");
  await form.getByRole("button", { name: /^(Start task|Send)$/ }).click();
  const rail = await chatRail(page);
  const line = rail.locator(".thread-dot");
  await expect(line).toContainText("Auto chose Researcher · Needs sources, dates and prices");
  // The fixture's first reply lands in a moment; the thread holds still once it has.
  await expect(
    rail.getByRole("article", { name: "dot" }).filter({ hasText: "Sample reply" }),
  ).toBeVisible();
  if (!isPhone(page)) await expect(page.locator(".bar-title")).toHaveText(TITLE);
  await shot(page, ui, "thread-auto-dot");

  await line.getByRole("button", { name: "Change" }).click();
  const menu = page.getByRole("menu", { name: "Dot for this task" });
  await expect(menu.getByRole("menuitemradio", { name: "Researcher" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await shot(page, ui, "thread-change-dot");
  await menu.getByRole("menuitemradio", { name: "Designer" }).click();
  await expect(rail.locator(".thread-dot").last()).toContainText(
    "You chose Designer for this conversation",
  );

  const list = await conversations(page);
  // On a phone the conversation under way is a card above the list, and is renamed in it.
  const named = isPhone(page)
    ? page.getByRole("region", { name: /^Under way/ }).getByRole("listitem")
    : list.getByRole("row");
  const row = named.filter({ hasText: TITLE });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: `Actions for ${TITLE}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `New name for ${TITLE}` });
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu", { name: "Conversation actions" })).toBeHidden();
  await field.fill(RENAMED);
  await shot(page, ui, "conversations-rename");
  await field.press("Enter");
  await expect(named.filter({ hasText: RENAMED })).toHaveCount(1);
  await shot(page, ui, "conversations-renamed");
  if (!isPhone(page)) await expect(page.locator(".bar-title")).toHaveText(RENAMED);

  await page.getByRole("button", { name: "See all in Replay" }).click();
  await expect(page.locator(".replay-library")).toContainText(RENAMED);
  await shot(page, ui, "replay-library-renamed");
});
