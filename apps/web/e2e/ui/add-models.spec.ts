import type { Locator, Page } from "@playwright/test";
import { openSettings, search } from "../settings-ui.ts";
import { expect, finger, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

// The page as it stands in light and dark, for looking at.
async function shots(page: Page, ui: Harness, name: string) {
  for (const appearance of ["daylight", "graphite"]) {
    await page.evaluate((shown) => {
      document.documentElement.dataset.appearance = shown;
    }, appearance);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
}

async function addModels(page: Page, open?: Locator): Promise<Locator> {
  const settings = open ?? (await openSettings(page, undefined, "Models"));
  const section = settings.getByRole("region", { name: "Your models" });
  await section.getByRole("button", { name: "Add models" }).click();
  const sheet = page.getByRole("dialog", { name: "Add models" });
  await expect(sheet).toBeVisible();
  return sheet;
}

const from = (sheet: Locator) => sheet.getByRole("combobox", { name: "From", exact: true });

// A finger taps on a phone, a mouse clicks elsewhere.
const press = (page: Page, target: Locator) => (isPhone(page) ? target.tap() : target.click());

async function chooseFrom(page: Page, sheet: Locator, name: string | RegExp) {
  await press(page, from(sheet));
  await press(page, page.getByRole("option", { name }));
}

const keyField = (sheet: Locator) => sheet.getByRole("textbox", { name: "Key", exact: true });

// The key's field never takes the keys by itself: focus stays where the user left it.
async function keyFieldLeftAlone(page: Page, sheet: Locator) {
  await expect(keyField(sheet)).toBeVisible();
  await page.waitForTimeout(400);
  expect(await keyField(sheet).evaluate((field) => field === document.activeElement)).toBe(false);
}

// Whether all of `row` shows inside what scrolls it.
async function shownIn(row: Locator, scroller: Locator) {
  const [r, s] = await Promise.all([row.boundingBox(), scroller.boundingBox()]);
  return !!r && !!s && r.y >= s.y - 1 && r.y + r.height <= s.y + s.height + 1;
}

// Wheels on a desktop; on Chromium's phone a finger drags the list up, as a thumb does. Playwright's
// phone WebKit has neither a wheel nor touch moves, so there the keyboard reaches the row instead.
async function scrollTo(page: Page, row: Locator, scroller: Locator) {
  const project = test.info().project.name;
  if (project === "w39") {
    await row.getByRole("checkbox").focus();
    return;
  }
  const box = await scroller.boundingBox();
  if (!box) throw new Error("Nothing scrolls");
  const x = box.x + box.width / 2;
  const touch = project === "c39" ? await finger(page) : null;
  if (!touch) await page.mouse.move(x, box.y + box.height / 2);
  for (let turn = 0; turn < 30 && !(await shownIn(row, scroller)); turn++) {
    if (touch) await touch.drag(x, box.y + box.height * 0.8, x, box.y + box.height * 0.3);
    else await page.mouse.wheel(0, 300);
    await page.waitForTimeout(60);
  }
}

test("a long list of models flows in the sheet, which scrolls to its last model", async ({
  page,
  ui,
}) => {
  const { origin } = await ui.open("ready");
  await page.request.post(`${origin}/__qa/own-endpoint?models=40`);
  const sheet = await addModels(page);
  await chooseFrom(page, sheet, /relay\.example/);
  const list = sheet.getByRole("group", { name: "Models", exact: true });
  await expect(list.getByRole("checkbox")).toHaveCount(40);
  const body = sheet.locator(".ui-sheet-body");
  await shots(page, ui, "long-list-top");

  // One scroller: the list has nothing hidden of its own, and runs on past the bottom of the sheet
  // rather than stopping short over an empty half.
  expect(await list.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(
    1,
  );
  const [listBox, bodyBox] = await Promise.all([list.boundingBox(), body.boundingBox()]);
  expect((listBox?.y ?? 0) + (listBox?.height ?? 0)).toBeGreaterThan(
    (bodyBox?.y ?? 0) + (bodyBox?.height ?? 0),
  );

  const last = list.locator("label", { hasText: "relay-model-40" });
  await scrollTo(page, last, body);
  expect(await shownIn(last, body), "the last model scrolled into view").toBe(true);
  // Search stays in reach at the top of what scrolls.
  const search = sheet.getByRole("textbox", { name: "Search", exact: true });
  expect(await shownIn(search, body), "Search stays at the top").toBe(true);
  await shots(page, ui, "long-list-end");
  await last.click();
  await expect(last.getByRole("checkbox")).toBeChecked();
});

test("From lists every provider, the ready ones first and the rest to set up", async ({
  page,
  ui,
}) => {
  await ui.open("ready");
  const sheet = await addModels(page);
  await expect(sheet).toContainText("From any provider or plan");
  await expect(from(sheet)).toContainText("Anthropic");
  await press(page, from(sheet));
  const ready = page.getByRole("group", { name: "Ready", exact: true });
  const toSetUp = page.getByRole("group", { name: "Not set up yet", exact: true });
  await expect(ready.getByRole("option")).toHaveText([
    /^Anthropic/,
    /^OpenAI/,
    /^LM Studio/,
    /^Ollama/,
  ]);
  for (const name of ["Google Gemini", "Groq", "Together", "Custom endpoint", "ChatGPT plan"])
    await expect(toSetUp.getByRole("option", { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(toSetUp.getByRole("option", { name: /^Groq/ })).toContainText("Add an API key");
  await expect(toSetUp.getByRole("option", { name: /^Anthropic/ })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Not available here", exact: true })).toBeAttached();
  await shots(page, ui, "from-list");
});

test("a provider set up in the sheet lists its models there at once", async ({ page, ui }) => {
  const { origin } = await ui.open("ready");
  const sheet = await addModels(page);
  // Chosen by typing on a keyboard, so keys were pressed just before its key field came up.
  if (isPhone(page)) await chooseFrom(page, sheet, /^Groq/);
  else await search(page, from(sheet), "Groq");
  await expect(from(sheet)).toContainText("Groq");
  await keyFieldLeftAlone(page, sheet);
  // A private field: drawn as dots, kept from autofill and password managers.
  await expect(keyField(sheet)).toHaveAttribute("type", "text");
  await expect(keyField(sheet)).toHaveAttribute("autocomplete", "off");
  await expect(keyField(sheet)).toHaveAttribute("data-1p-ignore", "true");
  await expect(sheet.getByRole("link", { name: "Get a key from Groq" })).toHaveAttribute(
    "href",
    "https://console.groq.com/keys",
  );
  await expect(sheet.getByRole("group", { name: "Models", exact: true })).toHaveCount(0);
  const add = sheet.getByRole("button", { name: "Add model", exact: true });
  await expect(add).toHaveAttribute("aria-disabled", "true");
  await shots(page, ui, "set-up-key");

  // Words typed by mistake are refused before anything is saved.
  await keyField(sheet).fill("my groq key");
  await press(page, sheet.getByRole("button", { name: "Save key", exact: true }));
  await expect(sheet).toContainText("A key has no spaces");

  const secret = `gsk_${"7".repeat(40)}`;
  await keyField(sheet).fill(secret);
  await sheet.getByRole("button", { name: "Save key", exact: true }).click();
  const models = sheet.getByRole("group", { name: "Models", exact: true });
  await expect(models.getByRole("checkbox")).toHaveCount(2);
  await expect(keyField(sheet)).toHaveCount(0);
  await expect(from(sheet)).toContainText("Groq");
  await expect(sheet.getByRole("status").filter({ hasText: "Groq is set up" })).toBeVisible();
  expect(await page.content()).not.toContain(secret);
  const saved = await page.request.get(`${origin}/api/keys`, {
    headers: { authorization: `Bearer ${"a".repeat(43)}` },
  });
  expect((await saved.json()).keys).toContainEqual(
    expect.objectContaining({ id: "groq", provider: "groq" }),
  );
  await shots(page, ui, "set-up-models");

  await models.locator("label", { hasText: "GPT OSS 120B" }).click();
  await add.click();
  await expect(sheet).toBeHidden();
  const section = page.getByRole("region", { name: "Your models" });
  await expect(section.locator(".settings-model-group", { hasText: "Groq" })).toContainText(
    "GPT OSS 120B",
  );
});

test("with no keys at all, the sheet sets one up instead of sending the user away", async ({
  page,
  ui,
}) => {
  await ui.open("first-run");
  const sheet = await addModels(page);
  await expect(sheet).not.toContainText("Add a key first");
  await expect(from(sheet)).toContainText("Choose a provider");
  await expect(sheet).toContainText("Choose an API provider, a plan you already have");
  await expect(sheet.getByRole("button", { name: "Add model", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await shots(page, ui, "no-keys");
  await press(page, from(sheet));
  await expect(
    page.getByRole("group", { name: "Ready", exact: true }).getByRole("option"),
  ).toHaveText([/^LM Studio/, /^Ollama/]);
  await press(page, page.getByRole("option", { name: /^Anthropic/ }));
  await keyFieldLeftAlone(page, sheet);
  await expect(sheet).toContainText("Starts with sk-ant-api");
  await keyField(sheet).fill(`sk-ant-api03-${"x".repeat(40)}`);
  await sheet.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(
    sheet.getByRole("group", { name: "Models", exact: true }).getByText("Claude Sonnet 5.5"),
  ).toBeVisible();
});

test("a plan set up in the sheet lists its models once it is ready", async ({ page, ui }) => {
  const { origin } = await ui.open("plan-usage");
  const settings = await openSettings(page, undefined, "Models");
  // Signed out of Claude Code since, as Settings' own card finds when it checks again.
  await page.request.post(`${origin}/__qa/claude-code/signed_out`);
  const card = settings.locator("#models-claude-code");
  await card.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(card).toContainText("Sign in to Claude Code, then check again.");
  const sheet = await addModels(page, settings);
  await chooseFrom(page, sheet, /^Claude Code \(your plan\)/);
  const check = sheet.getByRole("button", { name: "Check again", exact: true });
  await expect(check).toBeVisible();
  await expect(sheet).toContainText("Sign in to Claude Code, then check again.");
  if (!isPhone(page)) await shots(page, ui, "set-up-plan");
  await page.request.post(`${origin}/__qa/claude-code/signed_in`);
  await check.click();
  const models = sheet.getByRole("group", { name: "Models", exact: true });
  await expect(models.getByRole("checkbox")).toHaveCount(2);
  await expect(models).toContainText("Claude Opus");
});

test("an endpoint set up in the sheet keeps its format and lists what it serves", async ({
  page,
  ui,
}) => {
  await ui.open("ready");
  const sheet = await addModels(page);
  await chooseFrom(page, sheet, /^Custom endpoint/);
  await press(page, sheet.getByRole("combobox", { name: "API format", exact: true }));
  await press(page, page.getByRole("option", { name: /^OpenAI Responses/ }));
  await sheet
    .getByRole("textbox", { name: "Base URL", exact: true })
    .fill("https://own.example/v1");
  await keyFieldLeftAlone(page, sheet);
  await keyField(sheet).fill(`sk-${"q".repeat(40)}`);
  await sheet.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(from(sheet)).toContainText("own.example");
  await expect(sheet.getByRole("combobox", { name: "API format", exact: true })).toContainText(
    "OpenAI Responses",
  );
  await expect(
    sheet.getByRole("group", { name: "Models", exact: true }).getByRole("checkbox"),
  ).toHaveCount(2);
  await expect(sheet.getByRole("textbox", { name: "Add by ID", exact: true })).toBeVisible();
});

test("with saved keys locked, the sheet unlocks them first, then takes the key", async ({
  page,
  ui,
}) => {
  const { origin } = await ui.open("ready");
  expect((await page.request.post(`${origin}/__qa/keyd/locked`)).ok()).toBe(true);
  const sheet = await addModels(page);
  await chooseFrom(page, sheet, /^Groq/);
  const unlock = sheet.getByRole("form", { name: "Unlock saved keys" });
  await expect(unlock).toBeVisible();
  const save = sheet.getByRole("button", { name: "Save key", exact: true });
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await unlock.getByLabel("Passphrase", { exact: true }).fill("correct horse battery");
  await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(unlock).toBeHidden();
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
  await keyField(sheet).fill(`gsk_${"5".repeat(40)}`);
  await save.click();
  await expect(
    sheet.getByRole("group", { name: "Models", exact: true }).getByRole("checkbox"),
  ).toHaveCount(2);
});
