import type { Locator, Page } from "@playwright/test";
import { openSettings, settingsSheet } from "../settings-ui.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// Trying to leave Settings with a field that needs the user takes them to it.
runAt("c14", "w14", "c39", "w39");

// In view, inside what scrolls, and what's there at its middle is the field itself: no header or
// save bar is over it.
async function expectUncovered(field: Locator) {
  await expect
    .poll(() =>
      field.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const scroller = element.closest(".ui-sheet-body")?.getBoundingClientRect();
        const atMiddle = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return (
          !!scroller &&
          box.top >= scroller.top &&
          box.bottom <= scroller.bottom &&
          !!atMiddle &&
          (element === atMiddle || element.contains(atMiddle) || atMiddle.contains(element))
        );
      }),
    )
    .toBe(true);
}

const leave = (page: Page, sheet: Locator) =>
  isPhone(page)
    ? sheet
        .locator(".ui-sheet-page:not([inert])")
        .getByRole("button", { name: "Done", exact: true })
        .click()
    : sheet.getByRole("button", { name: "Close settings", exact: true }).click();

test("a field left wrong far down the page is scrolled to, focused, lit and says why", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({
    width: page.viewportSize()?.width ?? 1440,
    height: isPhone(page) ? 560 : 520,
  });
  await ui.open("ready");
  await ui.picture();
  const sheet = await openSettings(page, undefined, "Autonomy");
  const field = sheet.getByRole("textbox", { name: "Read up to" });
  await field.fill("");
  await expect(sheet.getByText("Before this can be saved:")).toBeVisible();
  // Nothing says so against the field while it is being filled in.
  await expect(sheet.locator(".ui-field-error")).toHaveCount(0);
  await field.blur();
  await field.evaluate((element) => {
    const body = element.closest(".ui-sheet-body");
    if (body) body.scrollTop = 0;
  });
  await expect(field).not.toBeInViewport();

  await leave(page, sheet);
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(sheet.locator(".ui-field-error")).toContainText("Research reads 3 to 100 sources");
  await expect(
    field.locator("xpath=ancestor::*[contains(@class,'ui-field-box')][1]"),
  ).toHaveAttribute("data-reveal", "");
  await expectUncovered(field);
  await page.screenshot({ path: test.info().outputPath("revealed.png") });

  await field.fill("20");
  await expect(sheet.locator(".ui-field-error")).toHaveCount(0);
});

test("a check-in out of range opens its own section and says so at the field", async ({
  page,
  ui,
}) => {
  await ui.open("ready");
  await ui.picture();
  const sheet = await openSettings(page, undefined, "Autonomy");
  await sheet.getByRole("switch", { name: "Stop after a number of actions" }).click();
  const field = sheet.getByRole("textbox", { name: "Actions" });
  await field.fill("3");
  await expect(sheet.getByText("Before this can be saved:")).toBeVisible();
  if (!isPhone(page)) await sheet.getByRole("button", { name: "Appearance", exact: true }).click();
  await leave(page, sheet);
  await expect(field).toBeFocused();
  await expect(settingsSheet(page).locator(".ui-field-error")).toContainText(
    "Stop after 10 to 100,000 actions",
  );
  await expectUncovered(field);
});

test("a new app's form and a new key's go to what they still need", async ({ page, ui }) => {
  await ui.open("ready");
  await ui.picture();
  const sheet = await openSettings(page, undefined, "Connectors");
  const another = sheet.getByRole("listitem").filter({ hasText: "Another app" });
  await another.getByRole("button", { name: "Add", exact: true }).click();
  await another.getByRole("button", { name: "Add app", exact: true }).click();
  const name = another.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(another.locator(".ui-field-error").first()).toBeVisible();
  await expectUncovered(name);
  await page.screenshot({ path: test.info().outputPath("new-app.png") });

  if (isPhone(page)) {
    await sheet
      .locator(".ui-sheet-page:not([inert])")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await sheet.getByRole("button", { name: /^Keys/ }).click();
  } else await sheet.getByRole("button", { name: "Keys", exact: true }).click();
  await sheet.getByRole("button", { name: /^Add (a )?key$/ }).click();
  await sheet.getByRole("button", { name: "Save key" }).click();
  const key = sheet.getByLabel("Key", { exact: true });
  await expect(key).toBeFocused();
  await expect(key).toHaveAttribute("aria-invalid", "true");
  await expectUncovered(key);
});
