import type { Page } from "@playwright/test";
import { type FakeDotsEffects, MEMORY_ADVICE_TEXT } from "../fixtures/fake-dots.ts";
import { closeSettings, openSettings } from "../settings-ui.ts";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

const effectsOf = async (page: Page, origin: string): Promise<FakeDotsEffects> =>
  (await (await page.request.get(`${origin}/__qa/dots`)).json()).effects;

function dotsGroup(page: Page) {
  return page.locator("div:has(> .ui-group-head:has-text('Dots on this computer'))");
}

// The localDot menu on a wide screen; More on a phone, which has no top bar.
async function switchTo(page: Page, ui: Harness, name: string, state: "Running" | "Stopped") {
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    const item = page.getByRole("menuitem", { name: `Switch to ${name}` });
    await expect(item).toBeVisible();
    ui.leaving();
    await item.click();
    return;
  }
  await page.getByRole("button", { name: /Switch localDot/ }).click();
  const here = page.getByRole("group", { name: "On this computer" });
  await expect(here.getByRole("menuitemradio", { name: "Main" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const item = here.getByRole("menuitem", { name: new RegExp(`^${name}`) });
  await expect(item).toContainText(state);
  ui.leaving();
  await item.click();
}

test("a dot is added from Your computer, chooses its own passphrase, and opens", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready");
  await page.request.post(`${fixture.origin}/__qa/dots/passphrase`);
  await openSettings(page, undefined, "Your computer");
  const group = dotsGroup(page);
  await group.scrollIntoViewIfNeeded();
  await expect(group).toContainText("This dot");
  await expect(group).toContainText("Stopped");
  await group.getByRole("button", { name: /Add a dot on this computer/ }).click();

  const sheet = page.getByRole("dialog", { name: "Add a dot on this computer" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(
    "Claude Code's sign-in is shared by every dot on this computer.",
  );
  await sheet.getByRole("button", { name: "Add dot" }).click();
  await expect(sheet.getByText("Give the new dot a name.")).toBeVisible();
  await sheet.getByRole("textbox", { name: "Name" }).fill("Lab");
  await sheet.getByRole("button", { name: /Advanced: what to copy/ }).click();
  const box = (label: string) => sheet.getByRole("checkbox", { name: label, exact: true });
  for (const on of ["Settings", "Keys", "Memory", "Skills", "Connectors"])
    await expect(box(on)).toBeChecked();
  for (const off of ["Conversations", "dot's computer", "Browser sign-ins"])
    await expect(box(off)).not.toBeChecked();
  await box("Conversations").click();
  await expect(box("Conversations")).toBeChecked();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("add-dot.png") });
  await sheet.getByRole("button", { name: "Add dot" }).click();

  const pass = sheet.getByLabel("New passphrase");
  await expect(pass).toBeVisible();
  await pass.fill("correct horse battery");
  await sheet.getByLabel("Type it again").fill("correct horse batter");
  await sheet.getByRole("button", { name: "Continue" }).click();
  await expect(sheet.getByText("The passphrases don't match.")).toBeVisible();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("dot-passphrase.png") });
  await sheet.getByLabel("Type it again").fill("correct horse battery");
  await sheet.getByRole("button", { name: "Continue" }).click();
  await expect(sheet.getByText("Lab is ready at its own address.")).toBeVisible();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("dot-added.png") });

  const effects = await effectsOf(page, fixture.origin);
  expect(effects.added).toEqual([
    {
      name: "Lab",
      from: "main",
      copy: ["settings", "keys", "memory", "skills", "connectors", "conversations"],
    },
  ]);
  expect(effects.passphrases).toBe(1);
  ui.leaving();
  await sheet.getByRole("button", { name: "Open Lab" }).click();
  await expect(page).toHaveURL(/\/__qa\/switched\?dot=lab#code=/);
  expect((await effectsOf(page, fixture.origin)).signIns).toEqual(["lab"]);
});

test("leaving while a new dot waits for its passphrase gives up on it", async ({ page, ui }) => {
  const fixture = await ui.open("ready");
  await page.request.post(`${fixture.origin}/__qa/dots/passphrase`);
  await openSettings(page, undefined, "Your computer");
  const group = dotsGroup(page);
  await group.scrollIntoViewIfNeeded();
  await group.getByRole("button", { name: /Add a dot on this computer/ }).click();
  const sheet = page.getByRole("dialog", { name: "Add a dot on this computer" });
  await sheet.getByRole("textbox", { name: "Name" }).fill("Lab");
  await sheet.getByRole("button", { name: "Add dot" }).click();
  await expect(sheet.getByLabel("New passphrase")).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => (await effectsOf(page, fixture.origin)).cancelled).toBe(1);
});

test("the switcher starts a stopped dot on this computer and signs in there", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready");
  await switchTo(page, ui, "Work", "Stopped");
  await expect(page).toHaveURL(/\/__qa\/switched\?dot=work#code=/);
  const effects = await effectsOf(page, fixture.origin);
  expect(effects.started).toEqual(["work"]);
  expect(effects.signIns).toEqual(["work"]);
});

test("a dot started from Settings is switched to directly, and stops only once asked", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready");
  await openSettings(page, undefined, "Your computer");
  const group = dotsGroup(page);
  await group.scrollIntoViewIfNeeded();
  await group.getByRole("button", { name: "Start Work" }).click();
  await expect(group.getByRole("button", { name: "Stop Work" })).toBeVisible();
  await expect(group).toContainText("Running");

  await group.getByRole("button", { name: "Stop Work" }).click();
  const ask = page.getByRole("alertdialog", { name: "Stop Work?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toBeHidden();
  expect((await effectsOf(page, fixture.origin)).stopped).toEqual([]);

  await closeSettings(page);
  await switchTo(page, ui, "Work", "Running");
  await expect(page).toHaveURL(/\/__qa\/switched\?dot=work#code=/);
  const effects = await effectsOf(page, fixture.origin);
  expect(effects.started).toEqual(["work"]);
  expect(effects.signIns).toEqual(["work"]);
});

test("removing this dot asks first, can delete its data, and goes to another dot", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready");
  await page.request.post(`${fixture.origin}/__qa/dots/self/work`);
  await openSettings(page, undefined, "Your computer");
  const group = dotsGroup(page);
  await group.scrollIntoViewIfNeeded();
  await group.getByRole("button", { name: "Remove…" }).click();
  const ask = page.getByRole("alertdialog", { name: "Remove Work?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Its data folder is kept unless you tick the box.");
  await ask.getByRole("checkbox", { name: "Also delete its data" }).click();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("remove-dot.png") });
  ui.leaving();
  await ask.getByRole("button", { name: "Remove Work" }).click();
  await expect(page).toHaveURL(/\/__qa\/switched\?dot=main#code=/);
  expect((await effectsOf(page, fixture.origin)).removed).toEqual([
    { id: "work", deleteData: true },
  ]);
});

test("Docker's memory advice comes before another computer starts, which can start anyway", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("off");
  await page.request.post(`${fixture.origin}/__qa/dots/memory`);
  const curtain = page.locator(".curtain");
  await curtain.getByRole("button", { name: "Turn on" }).click();
  await expect(curtain.getByText(MEMORY_ADVICE_TEXT)).toBeVisible();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("memory-advice.png") });
  await curtain.getByRole("button", { name: "Start anyway" }).click();
  await expect(curtain.getByRole("heading", { name: "Starting your computer" })).toBeVisible();
  await expect(curtain).toBeHidden({ timeout: 20_000 });
  expect((await effectsOf(page, fixture.origin)).memoryWarnings).toBe(1);
});
