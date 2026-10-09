import { expect, type Locator, type Page } from "@playwright/test";

const ROLE_TITLES = { main: "Main model", fast: "Fast model", local: "Local model" } as const;

export function settingsSheet(page: Page): Locator {
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

// Keys: on a phone its own page slid over Settings, at desktop width a section of Settings' one page.
export function nestedKeys(page: Page): Locator {
  return page
    .getByRole("dialog", { name: "Keys", exact: true })
    .locator("[data-page='keys']")
    .or(settingsSheet(page).getByRole("region", { name: "Keys", exact: true }));
}

// Settings opens from the top bar's gear, or from More on a phone, which has no top bar and lists
// the sections, so it goes into `section` there. The sheet is found by its body: on a phone its
// title is the section shown.
export async function openSettings(
  page: Page,
  press: (target: Locator) => Promise<void> = (target) => target.click(),
  section?: string,
): Promise<Locator> {
  const gear = page.getByRole("button", { name: "Settings", exact: true });
  const more = page.getByRole("button", { name: "More", exact: true });
  await expect(gear.or(more).first()).toBeVisible();
  const sheet = page.getByRole("dialog").filter({ has: page.locator("#settings-sheet-body") });
  if (await gear.isVisible()) {
    await press(gear);
    return sheet;
  }
  await press(more);
  await press(page.getByRole("menuitem", { name: "Settings", exact: true }));
  if (section) await press(sheet.getByRole("button", { name: new RegExp(`^${section}`) }));
  return sheet;
}

export function roleCard(scope: Page | Locator, role: keyof typeof ROLE_TITLES): Locator {
  return scope.getByRole("region", { name: ROLE_TITLES[role], exact: true });
}

// A picker's name is its field's label.
function nameOf(picker: Locator): Promise<string> {
  return picker.evaluate(
    (element) =>
      document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent ??
      element.getAttribute("aria-label") ??
      "",
  );
}

// Opens a searchable picker, types the search and takes the first row it leaves.
export async function search(page: Page, picker: Locator, text: string): Promise<void> {
  const name = await nameOf(picker);
  await picker.click();
  const field = page.getByRole("combobox", { name: `Search: ${name}`, exact: true });
  await expect(field).toBeVisible();
  await field.fill(text);
  await field.press("Enter");
  await expect(picker).toHaveAttribute("aria-expanded", "false");
}

// Opens a picker and chooses the first row that holds the given text, by tap on a touch screen.
export async function choose(
  page: Page,
  picker: Locator,
  text: string | RegExp,
  { tap = false } = {},
): Promise<void> {
  const name = await nameOf(picker);
  await (tap ? picker.tap() : picker.click());
  const list = page.getByRole("listbox", { name, exact: true });
  await expect(list).toBeVisible();
  const row = list.getByRole("option").filter({ hasText: text }).first();
  await (tap ? row.tap() : row.click());
  await expect(picker).toHaveAttribute("aria-expanded", "false");
}

// The assembled fixture's model on its OpenAI-compatible key, priced by hand, with a five-cent
// limit per task, saved; Settings stays open.
export async function saveFixtureModel(page: Page): Promise<Locator> {
  const sheet = settingsSheet(page);
  const main = roleCard(sheet, "main");
  await search(
    page,
    main.getByRole("combobox", { name: "Provider", exact: true }),
    "openai-compatible",
  );
  await search(
    page,
    main.getByRole("combobox", { name: "Model", exact: true }),
    "fixture-assembled-v1",
  );
  await choose(page, main.getByRole("combobox", { name: "Key", exact: true }), "fixture");
  await main.getByRole("textbox", { name: "Input price", exact: true }).fill("1");
  await main.getByRole("textbox", { name: "Output price", exact: true }).fill("1");
  await sheet.getByRole("switch", { name: "Spending limit", exact: true }).check();
  await sheet.getByRole("textbox", { name: "Per task", exact: true }).fill("0.05");
  await sheet
    .getByRole("radiogroup", { name: "Work in its computer" })
    .getByRole("radio", { name: "Ask me" })
    .click();
  const save = sheet.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(sheet.getByText(/^(Saved|All changes saved)$/)).toBeVisible();
  return sheet;
}
