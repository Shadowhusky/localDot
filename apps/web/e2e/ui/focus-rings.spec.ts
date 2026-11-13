import type { Locator, Page } from "@playwright/test";
import { openSettings } from "../settings-ui.ts";
import { ringFaultsInEach } from "./focus-ring.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

// A row fills its group to the edges the group clips, so its focus ring must be drawn whole inside
// them. Rows on pages slid away under the one in view, or hidden, are left out.
const ROWS = [
  ".ui-radio-cards[data-layout='rows'] > .ui-radio-card > .ui-choice-input",
  ".ui-group button.ui-group-row",
]
  .map((rows) => `${rows}:not([inert] *)`)
  .join(", ");

const rowsIn = (where: Locator | Page) => where.locator(ROWS).filter({ visible: true });

const qa = async (page: Page, origin: string, path: string) => {
  const reply = await page.request.post(`${origin}/__qa/${path}`);
  expect(reply.ok(), await reply.text()).toBe(true);
};

test("Settings' grouped rows and choices", async ({ page, ui }) => {
  await ui.open("ready");
  const faults: string[] = [];
  const sections = ["Models", "Autonomy", "What dot knows", "Your computer"];
  // A phone lists the sections as rows, and opens each as a page over the list.
  const phone = isPhone(page);
  let sheet = await openSettings(page);
  if (phone) faults.push(...(await ringFaultsInEach(page, rowsIn(sheet), "settings")));
  for (const section of sections) {
    if (phone) {
      await page.goto(page.url());
      sheet = await openSettings(page, undefined, section);
    } else await sheet.getByRole("button", { name: section, exact: true }).click();
    const picture = `settings-${section.toLowerCase().replaceAll(" ", "-")}`;
    faults.push(...(await ringFaultsInEach(page, rowsIn(sheet), picture)));
  }
  expect(faults).toEqual([]);
});

test("the dot chooser's rows", async ({ page, ui }) => {
  const fixture = await ui.open("ready");
  await page.request.post(`${fixture.origin}/__qa/first-look`, { data: { title: "A poster" } });
  await page.getByRole("button", { name: "Your dot", exact: true }).click();
  await page.getByRole("menuitem", { name: "Change dot" }).click();
  const chooser = page.getByRole("dialog", { name: "Your dot" });
  await expect(chooser).toBeVisible();
  expect(await ringFaultsInEach(page, rowsIn(chooser), "dot-chooser")).toEqual([]);
});

test("a question's choices", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await qa(page, fixture.origin, "ask?fields=choice");
  const form = page.locator("form.ask").last();
  await expect(form).toBeVisible();
  expect(await ringFaultsInEach(page, rowsIn(form), "question")).toEqual([]);
});

test("a routine's choices", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await qa(page, fixture.origin, "routine/propose");
  await page
    .getByRole("region", { name: /Routine waiting for you/ })
    .getByRole("button", { name: "Edit" })
    .click();
  const sheet = page.getByRole("dialog", { name: "Save this routine" });
  await expect(sheet).toBeVisible();
  expect(await ringFaultsInEach(page, rowsIn(sheet), "routine")).toEqual([]);
});

test("Export's presets", async ({ page, ui }) => {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
  await page.getByRole("button", { name: "Export video" }).click();
  const panel = page.getByRole("dialog", { name: "Export video" });
  await expect(panel).toBeVisible();
  expect(await ringFaultsInEach(page, rowsIn(panel), "export")).toEqual([]);
});

for (const step of ["thinks", "permissions", "browser", "speech"])
  test(`first run's ${step} choices`, async ({ page, ui }) => {
    await page.addInitScript(
      (at) => localStorage.setItem("localdot.onboarding.v1", JSON.stringify({ step: at })),
      step,
    );
    await ui.open("first-run");
    const choices = page.locator(".onboarding-choices");
    await expect(choices).toBeVisible();
    expect(await ringFaultsInEach(page, rowsIn(page), `first-run-${step}`)).toEqual([]);
  });
