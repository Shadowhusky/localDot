import type { Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { nestedKeys } from "../settings-ui.ts";
import { chatRail, expect, runAt, test } from "./harness.ts";

// Saved keys locked behind their passphrase: the chat's Unlock card, Keys lit up from it, and a
// link straight there, at desktop and phone widths in both appearances.
runAt("c14", "c39", "w39");

const PASSPHRASE = "correct horse battery";
const APPEARANCES = ["graphite", "midnight"] as const;

async function appearance(page: Page, value: (typeof APPEARANCES)[number]) {
  await page.evaluate((name) => {
    document.documentElement.dataset.appearance = name;
  }, value);
}

async function effects(page: Page, origin: string): Promise<string[]> {
  return ((await (await page.request.get(`${origin}/__qa/state`)).json()) as { effects: string[] })
    .effects;
}

test("the chat asks for the passphrase in a card, says when it's wrong, and goes once it opens", async ({
  page,
  ui,
}, testInfo) => {
  const fixture = await ui.open("keys-locked");
  const rail = await chatRail(page);
  const card = rail.getByRole("region", { name: "Unlock your saved keys" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("dot carries on by itself");
  for (const look of APPEARANCES) {
    await appearance(page, look);
    await ui.settle();
    await ui.still();
    await page.screenshot({ path: testInfo.outputPath(`unlock-chat-${look}.png`) });
    await card.screenshot({ path: testInfo.outputPath(`unlock-card-${look}.png`) });
  }
  await appearance(page, "graphite");
  const field = card.getByLabel("Passphrase", { exact: true });
  await field.fill("not the passphrase");
  await card.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(card.getByText("That passphrase doesn't unlock your saved keys.")).toBeVisible();
  await expect(field).toHaveValue("");
  await card.screenshot({ path: testInfo.outputPath("unlock-card-wrong.png") });
  await field.fill(PASSPHRASE);
  await card.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(card).toBeHidden();
  expect(await effects(page, fixture.origin)).toEqual(
    expect.arrayContaining(["unlock:wrong", "unlock:open"]),
  );
  // The passphrase lives only in the field it was typed into: not the page, not the task's log.
  expect(await page.content()).not.toContain(PASSPHRASE);
  const auth = { authorization: `Bearer ${TOKEN}` };
  const sessions = (await (
    await page.request.get(`${fixture.origin}/api/sessions`, { headers: auth })
  ).json()) as { id: string }[];
  for (const { id } of sessions) {
    const log = await page.request.get(`${fixture.origin}/api/sessions/${id}/events`, {
      headers: auth,
    });
    expect(await log.text()).not.toContain(PASSPHRASE);
  }
});

test("Open Keys lights the unlock form in Settings", async ({ page, ui }, testInfo) => {
  await ui.open("keys-locked");
  const rail = await chatRail(page);
  await rail.getByRole("button", { name: "Open Keys", exact: true }).click();
  const keys = nestedKeys(page);
  const form = keys.getByRole("form", { name: "Unlock saved keys" });
  await expect(form).toBeVisible();
  const tip = keys.locator("#keys-unlock");
  await expect(tip).toHaveAttribute("data-tip", "");
  await expect(tip).toContainText("lock each time the computer running localDot restarts");
  await expect(keys.getByText("Saved keys are locked. Unlock them above")).toBeVisible();
  await expect(tip).toBeInViewport();
  for (const look of APPEARANCES) {
    await appearance(page, look);
    await ui.settle();
    await page.screenshot({ path: testInfo.outputPath(`unlock-keys-${look}.png`) });
  }
  await appearance(page, "graphite");
  await form.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await form.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(form).toBeHidden();
  await expect(keys.getByText("Unlocked", { exact: true })).toBeVisible();
});

test("a link opens Keys at the unlock form", async ({ page, ui }) => {
  const fixture = await ui.open("ready");
  expect((await page.request.post(`${fixture.origin}/__qa/keyd/locked`)).ok()).toBe(true);
  await page.evaluate(() => {
    window.location.hash = "settings=keys&tip=unlock";
  });
  const keys = nestedKeys(page);
  await expect(keys.locator("#keys-unlock")).toHaveAttribute("data-tip", "");
  await expect(page).not.toHaveURL(/settings=/);
});

test("a vault with no passphrase yet asks for one twice", async ({ page, ui }, testInfo) => {
  const fixture = await ui.open("running");
  expect((await page.request.post(`${fixture.origin}/__qa/keys-locked?setup=1`)).ok()).toBe(true);
  const rail = await chatRail(page);
  const card = rail.getByRole("region", { name: "Choose a passphrase for your saved keys" });
  await expect(card).toBeVisible();
  await card.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
  await card.getByLabel("Type it again", { exact: true }).fill(`${PASSPHRASE}!`);
  await card.getByRole("button", { name: "Save passphrase", exact: true }).click();
  await expect(card.getByText("The passphrases don't match.")).toBeVisible();
  for (const look of APPEARANCES) {
    await appearance(page, look);
    await ui.settle();
    await card.screenshot({ path: testInfo.outputPath(`unlock-setup-${look}.png`) });
  }
  await card.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
  await card.getByLabel("Type it again", { exact: true }).fill(PASSPHRASE);
  await card.getByRole("button", { name: "Save passphrase", exact: true }).click();
  await expect(card).toBeHidden();
  expect(await effects(page, fixture.origin)).toContain("unlock:open");
});

// The same pattern for the key service gone offline: the recovery card's one fix opens Keys with
// what is wrong there lit up.
test("a task stopped by the key service offline opens Keys at its protection", async ({
  page,
  ui,
}, testInfo) => {
  const fixture = await ui.open("running");
  expect((await page.request.post(`${fixture.origin}/__qa/stall/keyd`)).ok()).toBe(true);
  const recovery = (await chatRail(page)).getByRole("region", { name: "Task recovery" });
  await expect(recovery.getByRole("heading", { name: "I can't reach your keys" })).toBeVisible();
  await recovery.getByRole("button", { name: "Open Keys", exact: true }).click();
  const keys = nestedKeys(page);
  const protection = keys.locator("#keys-protection");
  await expect(protection).toHaveAttribute("data-tip", "");
  await expect(keys.getByText("Off", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("keyd-offline-keys.png") });
});
