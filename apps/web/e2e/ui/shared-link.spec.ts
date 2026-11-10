import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

const MODELS = [
  { provider: "anthropic", model: "claude-sonnet-5-5" },
  { provider: "openai", model: "gpt-6.1-sol" },
];
const LINKS = {
  "Replay off": {},
  "Replay on": { replay: true },
  "the owner's apps, keys and browser": { apps: true },
  "chat settings and model switching": { settings: true, chooseModel: true, models: MODELS },
  "everything a link can have": {
    settings: true,
    chooseModel: true,
    replay: true,
    apps: true,
    models: MODELS,
  },
};
type Choice = { provider: string; model: string };
type Setting = {
  replay?: boolean;
  apps?: boolean;
  settings?: boolean;
  chooseModel?: boolean;
  maxTasks?: number;
  model?: Choice;
  models?: Choice[];
};

interface Conversation {
  sessionId: string;
  title: string;
}

// The owner's conversations, through the daemon's own routes; one of the past ones archived.
async function ownerSide(page: Page, fixture: UiFixture) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const list = async (archived = false) =>
    (
      await (
        await page.request.get(
          `${fixture.origin}/api/conversations${archived ? "?archived=1" : ""}`,
          { headers },
        )
      ).json()
    ).conversations as Conversation[];
  const past = (await list()).filter((each) => each.sessionId !== fixture.sessionId);
  const archived = past.find((each) => each.title.startsWith("Find a plumber"));
  if (!archived) throw new Error("The fixture has no past conversations");
  const reply = await page.request.post(
    `${fixture.origin}/api/conversations/${archived.sessionId}/archive`,
    { headers, data: { archived: true } },
  );
  expect(reply.status()).toBe(204);
  expect((await list(true)).map((each) => each.sessionId)).toEqual([archived.sessionId]);
  const shown = await (
    await page.request.get(`${fixture.origin}/api/conversation`, { headers })
  ).json();
  expect(shown.sessions.at(-1)).toBe(fixture.sessionId);
  expect(shown.sessions.length).toBeGreaterThan(1);
  return {
    shown: shown.sessions as string[],
    others: past.map((each) => each.sessionId),
  };
}

// A guest's page on a new link: what it was refused, what it asked for, and what its console said.
async function openAsGuest(page: Page, ui: Harness, setting: Setting) {
  await recordStyles(page);
  const fixture = await ui.open("shared-links", undefined, "");
  const owner = await ownerSide(page, fixture);
  const { token, id } = await (
    await page.request.post(`${fixture.origin}/__qa/link`, { data: setting })
  ).json();
  const refused: string[] = [];
  const asked: string[] = [];
  const errors: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 403) refused.push(new URL(response.url()).pathname);
  });
  page.on("request", (request) => asked.push(new URL(request.url()).pathname));
  page.on("websocket", (socket) => asked.push(new URL(socket.url()).pathname));
  page.on("console", (message) => {
    // A task at rest has no live status and the fixture daemon no runtime check: both answer 404,
    // for the owner's page too.
    if (message.type() === "error" && !message.text().includes("status of 404"))
      errors.push(message.text());
  });
  await page.goto(`${fixture.origin}/#token=${token}`);
  await expect(page.locator(".app[data-guest]")).toBeVisible();
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  // Before any screenshot: the page alone has nothing the policy refuses.
  expect(errors).toEqual([]);
  const guest = (path: string) =>
    page.request.get(`${fixture.origin}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  return { fixture, owner, token, id, guest, refused, asked, errors };
}

// The page policy refuses inline styles, and the app adds none. In WebKit Playwright itself adds an
// empty one (`body {}`) to the head for each screenshot, which the console reports as refused: every
// style element that reached the document is on record, so each report is matched to one of those.
const PLAYWRIGHT_STYLE = "body {}";
const REFUSED_STYLE = /^Refused to apply a stylesheet/;
declare global {
  interface Window {
    stylesAdded?: string[];
  }
}
function recordStyles(page: Page) {
  return page.addInitScript(() => {
    const added: string[] = [];
    window.stylesAdded = added;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeName === "STYLE") added.push(node.textContent ?? "");
    }).observe(document, { childList: true, subtree: true });
  });
}
async function expectCleanConsole(page: Page, errors: readonly string[]) {
  const styles = await page.evaluate(() => window.stylesAdded ?? []);
  expect(
    styles.filter((text) => text !== PLAYWRIGHT_STYLE),
    "style elements the page added",
  ).toEqual([]);
  expect(
    errors.filter((text) => !REFUSED_STYLE.test(text)),
    "what the page's console reported",
  ).toEqual([]);
  expect(
    errors.filter((text) => REFUSED_STYLE.test(text)).length,
    "refused stylesheets that were not a screenshot's",
  ).toBeLessThanOrEqual(styles.length);
}

async function shot(page: Page, ui: Harness, name: string) {
  // A sheet or menu just opened has finished coming in.
  await page.waitForTimeout(300);
  await ui.settle();
  await ui.still();
  const project = test.info().project.name;
  const dir = process.env.QA_GUEST_SHOTS;
  if (dir) mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: dir ? `${dir}/${project}-${name}.png` : test.info().outputPath(`${name}.png`),
  });
}

const thread = (page: Page) => page.getByRole("complementary", { name: "Conversation" });

const messageBox = (page: Page) =>
  page.getByRole("form", { name: "Message dot" }).getByRole("textbox");

async function send(page: Page, text: string) {
  await messageBox(page).fill(text);
  await page
    .getByRole("form", { name: "Message dot" })
    .getByRole("button", { name: /^(Send|Start task)$/ })
    .click();
}

// The list of conversations: beside the conversation on a wide screen, under it on a phone.
async function openList(page: Page) {
  if (isPhone(page)) {
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "0");
  }
  return page.getByRole("region", { name: "Conversations" });
}

async function ownerShows(page: Page, origin: string) {
  const reply = await page.request.get(`${origin}/api/conversation`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return (await reply.json()).sessions as string[];
}

for (const [name, setting] of Object.entries(LINKS) as [string, Setting][])
  test(`a guest has the app with its own conversations, and only what the link allows (${name})`, async ({
    page,
    ui,
  }) => {
    const { fixture, owner, guest, refused, asked, errors } = await openAsGuest(page, ui, setting);
    const chat = thread(page);
    const slug = name.replaceAll(/[^a-z]+/gi, "-").toLowerCase();
    // A link with no task yet lands in a new conversation: the owner's is not on show.
    await expect(chat.getByRole("heading", { name: "What should we do?" })).toBeVisible();
    await expect(page.getByText(/^Summarise the sample sales table/)).toHaveCount(0);
    await shot(page, ui, `guest-${slug}`);

    // The owner's side of the app is not on the page.
    for (const owners of ["Settings", "Keys", "Attach files", "Add", "Select"])
      await expect(page.getByRole("button", { name: owners, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /this computer and app settings$/ })).toHaveCount(
      0,
    );

    for (const path of ["/api/conversations", "/api/conversations?archived=1"]) {
      const listed = await guest(path);
      expect(listed.status(), path).toBe(200);
      expect((await listed.json()).conversations, path).toEqual([]);
    }
    expect(owner.others.length).toBeGreaterThan(4);
    for (const sessionId of [...owner.others, ...owner.shown]) {
      for (const part of ["stream", "clock"])
        expect((await guest(`/api/sessions/${sessionId}/${part}`)).status(), part).toBe(403);
      expect((await guest(`/api/agent/sessions/${sessionId}`)).status()).toBe(403);
      for (const part of ["events", "history"])
        expect((await guest(`/api/sessions/${sessionId}/${part}`)).status(), part).toBe(
          setting.replay ? 200 : 403,
        );
      if (!setting.replay)
        expect((await guest(`/api/sessions/${sessionId}/card`)).status()).toBe(403);
    }

    await send(page, "Water the plants on Friday");
    await expect(chat.getByText("Sample reply: I received the task.")).toBeVisible();
    await expect(chat.getByText("Water the plants on Friday")).toBeVisible();
    const { ownedSessions } = await (await guest("/api/remote-session")).json();
    expect(ownedSessions).toHaveLength(1);
    expect((await guest(`/api/sessions/${ownedSessions[0]}/history`)).status()).toBe(200);
    expect((await guest(`/api/agent/sessions/${ownedSessions[0]}`)).status()).toBe(200);
    // The guest's task is a conversation of its own: the owner's app still shows theirs.
    expect(await ownerShows(page, fixture.origin)).toEqual(owner.shown);
    const listed = await (await guest("/api/conversations")).json();
    expect(listed.conversations.map((each: { sessionId: string }) => each.sessionId)).toEqual(
      ownedSessions,
    );

    await page.getByRole("button", { name: "More", exact: true }).click();
    const menu = page.getByRole("menu", { name: "More" });
    const items = menu.getByRole("menuitem");
    await expect(items.filter({ hasText: "New conversation" })).toHaveCount(1);
    await expect(items.filter({ hasText: /^Model: / })).toHaveCount(1);
    await expect(items.filter({ hasText: /^Replay$/ })).toHaveCount(setting.replay ? 1 : 0);
    await expect(items.filter({ hasText: "Chat settings" })).toHaveCount(setting.settings ? 1 : 0);
    for (const owners of [
      /^Pin/,
      /^Rename/,
      /^Workspace/,
      /^Search actions/,
      /^Switch to/,
      /^Research/,
    ])
      await expect(items.filter({ hasText: owners })).toHaveCount(0);
    await shot(page, ui, `guest-${slug}-menu`);
    await page.keyboard.press("Escape");

    // The web browser is signed in as the owner: only a link with their apps watches it.
    await page
      .getByRole("button", { name: /^Open the computer/ })
      .first()
      .click();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "2");
    await ui.picture(page.locator(".phone-computer .stage"));
    const moved = await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
    expect(moved.ok()).toBe(true);
    const browser = () =>
      asked.some((path) => /browser-stream-ticket|\/api\/browsers\//.test(path));
    if (setting.apps) await expect.poll(browser).toBe(true);
    else {
      await page.waitForTimeout(1500);
      expect(browser()).toBe(false);
    }
    await shot(page, ui, `guest-${slug}-computer`);
    await page.getByRole("button", { name: "Back to the conversation" }).click();
    await expect(page.locator(".phone-stack")).not.toHaveAttribute("data-level", "2");

    if (setting.replay) {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Replay", exact: true }).click();
      await expect(page.locator(".app")).toHaveAttribute("data-replaying", "");
      await ui.settle();
      await shot(page, ui, `guest-${slug}-replay`);
      // A recording plays; deleting, exporting and its files stay the owner's.
      for (const owners of ["Select", "Free up space", "Continue"])
        await expect(page.getByRole("button", { name: owners, exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^(Export|Delete)/ })).toHaveCount(0);
      await page.goBack();
      await expect(page.locator(".app")).not.toHaveAttribute("data-replaying");
    }
    if (setting.settings) {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Chat settings", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "Chat settings" });
      await expect(sheet.getByText("1 of 5 used")).toBeVisible();
      await expect(sheet.getByText("Claude Sonnet 5.5")).toBeVisible();
      await shot(page, ui, `guest-${slug}-settings`);
      await page.keyboard.press("Escape");
    }
    const field = await messageBox(page).boundingBox();
    expect(
      field && field.x >= 0 && field.x + field.width <= (page.viewportSize()?.width ?? 0),
    ).toBe(true);
    expect(refused, "requests the guest's page made that were refused").toEqual([]);
    await expectCleanConsole(page, errors);
  });

test("a guest's list holds the conversations it started; switching and New chat leave the owner's alone", async ({
  page,
  ui,
}) => {
  const { fixture, owner, refused, errors } = await openAsGuest(page, ui, { replay: true });
  const chat = thread(page);
  await send(page, "Water the plants on Friday");
  await expect(chat.getByText("Sample reply: I received the task.")).toBeVisible();
  // The computer takes one task at a time: this one ends before the next starts.
  expect((await page.request.post(`${fixture.origin}/__qa/finish?done=1`)).ok()).toBe(true);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "New conversation", exact: true }).click();
  await expect(chat.getByRole("heading", { name: "What should we do?" })).toBeVisible();
  expect(await ownerShows(page, fixture.origin)).toEqual(owner.shown);
  await send(page, "Book a table for Saturday");
  await expect(chat.getByText("Sample reply: I received the task.")).toBeVisible();
  await expect(chat.getByText("Water the plants on Friday")).toHaveCount(0);
  expect(await ownerShows(page, fixture.origin)).toEqual(owner.shown);

  const list = await openList(page);
  const rows = list.locator("[data-conversation]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Book a table for Saturday");
  await expect(rows.nth(1)).toContainText("Water the plants on Friday");
  await expect(list.getByText(/Summarise the sample sales table|Find a plumber/)).toHaveCount(0);
  // Organizing is the owner's: no actions, swipes or Select.
  await expect(list.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  await shot(page, ui, "guest-list");

  expect((await page.request.post(`${fixture.origin}/__qa/finish?done=1`)).ok()).toBe(true);
  await rows.nth(1).getByRole("button").first().click();
  if (isPhone(page)) await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "1");
  await expect(chat.getByText("Water the plants on Friday")).toBeVisible();
  await expect(chat.getByText("Book a table for Saturday")).toHaveCount(0);
  expect(await ownerShows(page, fixture.origin)).toEqual(owner.shown);
  // A message continues the guest's own conversation, not the owner's.
  await send(page, "And the ferns");
  await expect(chat.getByText("And the ferns")).toBeVisible();
  expect(await ownerShows(page, fixture.origin)).toEqual(owner.shown);
  expect(refused).toEqual([]);
  await expectCleanConsole(page, errors);
});

for (const switching of [true, false])
  test(`the composer's own model menu offers ${switching ? "the link's models by name" : "the link's model alone"}`, async ({
    page,
    ui,
  }) => {
    // As a link made before rc.44 reads back: a plan's "default" and another model.
    const models = [
      { provider: "claude-code", model: "default" },
      { provider: "deepseek", model: "deepseek-flash" },
    ];
    const { guest, refused, errors } = await openAsGuest(page, ui, {
      settings: true,
      replay: true,
      model: models[0],
      ...(switching ? { chooseModel: true, models } : {}),
    });
    const chip = page
      .getByRole("form", { name: "Message dot" })
      .getByRole("button", { name: /^Model: / });
    await messageBox(page).focus();
    await expect(chip).toHaveAccessibleName("Model: Default · Claude Code");
    if (!switching) {
      await expect(chip).toHaveAttribute("aria-disabled", "true");
      await expect(chip).toHaveAccessibleDescription("This link sets the model");
      await shot(page, ui, "guest-model-fixed");
      expect(refused).toEqual([]);
      await expectCleanConsole(page, errors);
      return;
    }
    await chip.click();
    const panel = page.getByRole("dialog", { name: "Model and thinking" });
    await expect(panel.getByRole("button", { name: "Manage models…" })).toHaveCount(0);
    await panel.getByRole("combobox", { name: "Model" }).click();
    const options = page.getByRole("option");
    await expect(options.filter({ hasText: "Default · Claude Code" })).toHaveCount(1);
    await expect(options.filter({ hasText: "deepseek-flash" })).toHaveCount(1);
    await shot(page, ui, "guest-model-menu");
    await options.filter({ hasText: "deepseek-flash" }).click();
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect
      .poll(async () => (await (await guest("/api/remote-session")).json()).model)
      .toEqual(models[1]);
    await expect(chip).toHaveAccessibleName("Model: deepseek-flash");
    expect(refused).toEqual([]);
    await expectCleanConsole(page, errors);
  });

test("the last thing dot said shows whole, and the thread scrolls", async ({ page, ui }) => {
  const { fixture, refused, errors } = await openAsGuest(page, ui, {});
  const chat = thread(page);
  await send(page, "Summarise the sample sales table");
  await expect(chat.getByText("Sample reply: I received the task.")).toBeVisible();
  expect((await page.request.post(`${fixture.origin}/__qa/finish?done=1&markdown=1`)).ok()).toBe(
    true,
  );
  const scroller = chat.locator(".thread-scroll");
  const report = chat
    .locator(".thread-message, .thread-bubble")
    .filter({ hasText: "Report ready" });
  await expect(report).toContainText("monthly total is 12,480");
  await expect(report).toBeInViewport({ ratio: 1 });
  const summary = report;
  const composer = messageBox(page);
  const [last, box, view] = [
    await summary.boundingBox(),
    await composer.boundingBox(),
    await scroller.boundingBox(),
  ];
  if (!last || !box || !view) throw new Error("The thread is not laid out");
  expect(last.y + last.height).toBeLessThanOrEqual(box.y);
  expect(view.y + view.height).toBeLessThanOrEqual(box.y + 1);

  const range = () =>
    scroller.evaluate((el) => ({ at: el.scrollTop, most: el.scrollHeight - el.clientHeight }));
  const end = await range();
  expect(end.at).toBeGreaterThan(end.most - 4);
  if (end.most > 0) {
    await scroller.evaluate((el) => el.scrollTo(0, 0));
    await expect.poll(async () => (await range()).at).toBe(0);
    await expect(chat.getByText("Summarise the sample sales table")).toBeInViewport();
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  }
  await expect(summary).toBeInViewport({ ratio: 1 });

  // The screen's own bar stays clear of its picture.
  await page
    .getByRole("button", { name: /^Open the computer/ })
    .first()
    .click();
  await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "2");
  const picture = page.locator(".phone-computer .stage");
  await ui.picture(picture);
  const frame = await picture.boundingBox();
  const back = await page.getByRole("button", { name: "Back to the conversation" }).boundingBox();
  if (!frame || !back) throw new Error("The computer screen is not laid out");
  expect(back.y + back.height).toBeLessThanOrEqual(frame.y);
  expect(frame.width).toBeGreaterThan(
    (page.viewportSize()?.width ?? 0) * (isPhone(page) ? 0.9 : 0.4),
  );
  expect(refused).toEqual([]);
  await expectCleanConsole(page, errors);
});

test("a link that is used up says so, and one the owner ends leaves the app", async ({
  page,
  ui,
}) => {
  const { fixture, id, refused } = await openAsGuest(page, ui, { maxTasks: 1 });
  const chat = thread(page);
  await send(page, "Water the plants on Friday");
  await expect(chat.getByText("Sample reply: I received the task.")).toBeVisible();
  // Its own task still takes messages; a new conversation would need a task the link has not got.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "New conversation", exact: true }).click();
  await expect(chat.getByText("Water the plants on Friday")).toHaveCount(0);
  await messageBox(page).fill("And the ferns");
  const sendButton = page
    .getByRole("form", { name: "Message dot" })
    .getByRole("button", { name: "Start task" });
  await expect(sendButton).toHaveAttribute("aria-disabled", "true");
  await expect(sendButton).toHaveAccessibleDescription(/used all its tasks/);
  await shot(page, ui, "guest-used-up");
  expect(refused).toEqual([]);

  ui.leaving();
  expect((await page.request.post(`${fixture.origin}/__qa/link/revoke?id=${id}`)).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "This link has ended" })).toBeVisible();
  await expect(page.getByText("localdot open")).toHaveCount(0);
  await shot(page, ui, "guest-ended");
  expect(refused).toEqual([]);
});

for (const appearance of ["graphite", "daylight"] as const)
  test(`the guest's page while dot works and asks, in ${appearance}`, async ({ page, ui }) => {
    await page.addInitScript((value) => {
      localStorage.setItem("localdot.appearance.v1", value);
    }, appearance);
    const { fixture, refused, errors } = await openAsGuest(page, ui, { apps: true });
    const chat = thread(page);
    await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
    await page.request.post(`${fixture.origin}/__qa/reply?ms=60000`);
    await send(page, "Water the plants on Friday");
    await expect(chat.getByText("Water the plants on Friday")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop task", exact: true })).toBeVisible();
    await shot(page, ui, `guest-working-${appearance}`);

    // dot asks the link's own task: the guest answers it in the thread.
    expect((await page.request.post(`${fixture.origin}/__qa/ask`)).ok()).toBe(true);
    await expect(chat.locator(".thread-question, .question-card").first()).toBeVisible();
    await shot(page, ui, `guest-question-${appearance}`);
    expect(refused).toEqual([]);
    await expectCleanConsole(page, errors);
  });
