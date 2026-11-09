import { writeFileSync } from "node:fs";
import type { Locator, Page, TestInfo, WebSocketRoute } from "@playwright/test";
import { SECTIONS } from "../../src/settings/sections.ts";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { closeSettings, openSettings } from "../settings-ui.ts";
import { type Audit, auditContrast } from "./contrast.ts";
import { composer, expect, type Harness, isPhone, openComposer, runAt, test } from "./harness.ts";

// Daylight's main states, measured: every word at 4.5:1 (3:1 when large), every icon, slider rail
// and field edge at 3:1, each against the pixels really drawn behind it. Nothing here compares
// pictures; the shots are for looking at.
runAt("c14", "c39", "w39");
test.use({ colorScheme: "light" });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("localdot.appearance.v1", "daylight"));
});

const seen: (Audit & { state: string })[] = [];

test.afterEach(async ({ page: _ }, info: TestInfo) => {
  writeFileSync(info.outputPath("contrast.json"), JSON.stringify(seen.splice(0)));
});

async function readable(page: Page, ui: Harness | null, state: string) {
  await page.waitForTimeout(150);
  // The gallery's clock is paused, so it has no frames to wait for.
  await ui?.settle();
  const audit = await auditContrast(page);
  seen.push({ state, ...audit });
  await page.screenshot({ path: test.info().outputPath(`${state}.png`) });
  expect
    .soft(
      audit.failures.map(
        (each) =>
          `${each.ratio}:1 < ${each.needs} ${each.kind} ${each.where} "${each.what}" ${each.fg} on ${each.bg}`,
      ),
      state,
    )
    .toEqual([]);
}

const qa = async (page: Page, origin: string, path: string) => {
  const reply = await page.request.post(`${origin}/__qa/${path}`);
  expect(reply.ok(), await reply.text()).toBe(true);
  return reply;
};

const press = (page: Page, target: Locator) => (isPhone(page) ? target.tap() : target.click());

async function openPanel(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else await page.locator(".rail-chat").getByRole("radio", { name: PANEL_NAME }).click();
  return page.getByRole("tablist", { name: PANEL_NAME });
}

async function moreMenu(page: Page) {
  await page.getByRole("button", { name: "More", exact: true }).last().click();
}

test("first run", async ({ page, ui }) => {
  await ui.open("first-run");
  await expect(page.getByRole("heading", { name: "Your computer is off" })).toBeVisible();
  await readable(page, ui, "first-run");
});

test("setup's steps", async ({ page, ui }) => {
  await page.addInitScript(() =>
    localStorage.setItem("localdot.onboarding.v1", JSON.stringify({ step: "thinks" })),
  );
  await ui.open("first-run");
  await expect(page.getByRole("heading", { name: "How should dot think?" })).toBeVisible();
  await readable(page, ui, "setup-thinks");
});

for (const scenario of [
  "starting",
  "reconnecting",
  "paused",
  "failed",
  "fenced",
  "fresh-start",
  "off",
  "budget",
  "takeover",
  "keys-locked",
  "fix-key",
  "fix-app",
  "fix-model",
  "fix-computer",
  "fix-computer-paused",
  "fix-runtime",
] as const)
  test(`computer state: ${scenario}`, async ({ page, ui }) => {
    await ui.open(scenario);
    await expect(page.locator(".app")).toBeVisible();
    await page.waitForTimeout(500);
    await readable(page, ui, scenario);
  });

test("saved logins in Keys, with an import's summary", async ({ page, ui }) => {
  const fixture = await ui.open("ready");
  expect((await page.request.post(`${fixture.origin}/__qa/logins`)).ok()).toBe(true);
  const sheet = await openSettings(page, undefined, "Keys");
  await sheet.getByRole("heading", { name: "Saved logins" }).scrollIntoViewIfNeeded();
  await expect(sheet.getByRole("list", { name: "Saved logins" })).toBeVisible();
  await readable(page, ui, "saved-logins");
  await sheet.locator("input[type=file]").setInputFiles({
    name: "passwords.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("url,username,password\nhttps://empty.example.com,a,\n"),
  });
  await sheet.locator(".saved-logins-summary").scrollIntoViewIfNeeded();
  await readable(page, ui, "saved-logins-import");
});

test("the composer, closed and open, with its menus", async ({ page, ui }) => {
  await ui.open("ready");
  const card = await composer(page);
  await expect(card).toBeVisible();
  await readable(page, ui, "composer-closed");
  await openComposer(page);
  await readable(page, ui, "composer-open");
  await card.getByRole("textbox").first().fill("Make the chart bigger");
  await readable(page, ui, "composer-typed");
  const trigger = card.getByRole("button", { name: /^Model:/ });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(panel).toBeVisible();
  await readable(page, ui, "model-menu");
  await panel.getByRole("combobox", { name: "Model", exact: true }).click();
  await expect(page.getByRole("option").first()).toBeVisible();
  await readable(page, ui, "model-picker");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const options = card.getByRole("button", { name: "Message options" });
  if (await options.isVisible()) {
    await options.click();
    await readable(page, ui, "message-options");
    await page.keyboard.press("Escape");
  }
});

test("chat while dot works, with its steps unfolded", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await expect(await composer(page)).toBeVisible();
  await readable(page, ui, "chat-running");
  const handed = await page.request.post(
    `${fixture.origin}/__qa/files?count=5&recording=${fixture.seeded[0] ?? ""}`,
  );
  expect(handed.ok(), await handed.text()).toBe(true);
  await expect(page.getByRole("region", { name: "Task result" }).last()).toBeVisible();
  await readable(page, ui, "chat-result");
  const list = page
    .getByRole("region", { name: "Task result" })
    .last()
    .getByRole("list", { name: /^Files in result / });
  await list.getByRole("button", { name: "Show totals.csv" }).click();
  await readable(page, ui, "chat-file-preview");
});

test("steps unfolded in the chat", async ({ page, ui }) => {
  await ui.open("image-output");
  const steps = page.locator(".thread-work-steps > .ui-disclosure-trigger:visible").last();
  await steps.click();
  await expect(page.locator(".thread-work-list").first()).toBeVisible();
  await readable(page, ui, "chat-steps");
  const row = page.locator(".thread-work-list").getByTestId("tool-row").first();
  await row.getByRole("button").first().click();
  await readable(page, ui, "chat-step-open");
});

test("an approval", async ({ page, ui }) => {
  await ui.open("approval");
  const decision = page.getByRole("dialog", { name: "Send this email?" });
  await expect(decision.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
  await readable(page, ui, "approval");
});

test("a quick question", async ({ page, ui }) => {
  await ui.open("ask");
  await page.waitForTimeout(400);
  await readable(page, ui, "ask");
});

for (const fields of ["setup", "login", "multichoice", "details", "file", "qr", "code"])
  test(`a question: ${fields}`, async ({ page, ui }) => {
    const fixture = await ui.open("running");
    await qa(page, fixture.origin, `ask?fields=${fields}`);
    await expect(page.locator("form.ask").last()).toBeVisible();
    await readable(page, ui, `question-${fields}`);
  });

test("the task list", async ({ page, ui }) => {
  await page.addInitScript(() =>
    localStorage.setItem("localdot.panels.v1", JSON.stringify({ sessions: true })),
  );
  await ui.open("conversations");
  if (isPhone(page))
    await page
      .getByRole("button", { name: /conversations/i })
      .first()
      .click();
  await page.waitForTimeout(300);
  await readable(page, ui, "task-list");
});

test("the Workspace panel and its tabs", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await qa(page, fixture.origin, `files?count=5&recording=${fixture.seeded[0] ?? ""}`);
  const tabs = await openPanel(page);
  for (const tab of await tabs.getByRole("tab").all()) {
    const name = ((await tab.textContent()) ?? "").trim().split(/\s/)[0]?.toLowerCase();
    await tab.click();
    await readable(page, ui, `panel-${name}`);
  }
  await tabs.getByRole("tab", { name: /^Files/ }).click();
  await page
    .getByRole("button", { name: /^summary\.md/ })
    .first()
    .click();
  await expect(page.locator(".diff-viewer").first()).toBeVisible();
  await readable(page, ui, "panel-diff");
});

test("file viewers", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await qa(page, fixture.origin, "files?count=1");
  await qa(page, fixture.origin, "computer-files");
  const chips = page.locator(".thread-bubble-files").last();
  await chips.scrollIntoViewIfNeeded();
  await readable(page, ui, "file-chips");
  await chips.getByRole("button", { name: "Open photo.png" }).click();
  const viewer = page.locator(".file-viewer");
  await expect(viewer.getByRole("img", { name: "photo.png" })).toBeVisible();
  await readable(page, ui, "viewer-picture");
  const next = () => viewer.getByRole("button", { name: "Next file" }).click();
  await next();
  await expect(viewer.locator(".viewer-page-canvas canvas").first()).toBeVisible();
  await readable(page, ui, "viewer-pdf");
  await next();
  await expect(viewer.locator(".viewer-table-scroll table")).toBeVisible();
  await readable(page, ui, "viewer-table");
  await viewer.getByRole("radio", { name: "Source" }).click();
  await readable(page, ui, "viewer-source");
  await next();
  await expect(viewer.getByRole("region", { name: "Contents of main.ts" })).toBeVisible();
  await readable(page, ui, "viewer-code");
  await next();
  await expect(viewer.locator(".ui-file-card")).toBeVisible();
  await readable(page, ui, "viewer-binary");
  await next();
  await expect(viewer.locator("audio")).toBeVisible();
  await readable(page, ui, "viewer-audio");
});

test("a deck", async ({ page, ui }) => {
  // The sample PDF turned on its side, which the viewer shows a slide at a time.
  await page.route(/brief\.pdf/, async (route) => {
    const reply = await route.fetch();
    const turned = (await reply.body())
      .toString("latin1")
      .replace(/MediaBox ?\[ ?0 0 (\d+) (\d+) ?\]/g, (box, width, height) =>
        box.replace(`${width} ${height}`, `${height} ${width}`),
      );
    await route.fulfill({ response: reply, body: Buffer.from(turned, "latin1") });
  });
  const fixture = await ui.open("running");
  await qa(page, fixture.origin, "files?count=1");
  await qa(page, fixture.origin, "computer-files");
  const chips = page.locator(".thread-bubble-files").last();
  await chips.scrollIntoViewIfNeeded();
  await chips.getByRole("button", { name: "Open photo.png" }).click();
  await page.locator(".file-viewer").getByRole("button", { name: "Next file" }).click();
  await expect(page.locator(".viewer-slides")).toBeVisible();
  await readable(page, ui, "viewer-slides");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".viewer-present")).toBeVisible();
  await readable(page, ui, "viewer-present");
});

test("a file's changes", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await qa(page, fixture.origin, "files?count=1");
  const put = await qa(page, fixture.origin, "computer-files");
  const placed = (await put.json()) as { changed: string[] };
  const tabs = await openPanel(page);
  await tabs.getByRole("tab", { name: /^Files/ }).click();
  const row = page
    .locator(".activity-rail")
    .getByTestId("change-row")
    .filter({ hasText: "server.ts" })
    .last();
  await row.locator(".activity-row-head").click();
  await readable(page, ui, "panel-changed-file");
  const server = placed.changed.find((path) => path.endsWith("server.ts")) ?? "";
  await row.getByRole("button", { name: `Open ${server}` }).click();
  const viewer = page.locator(".file-viewer");
  await expect(viewer.getByRole("region", { name: "Contents of server.ts" })).toBeVisible();
  await readable(page, ui, "viewer-server");
  await viewer.getByRole("radio", { name: "Changes" }).click();
  await expect(viewer.locator('[data-kind="add"]').first()).toBeVisible();
  await readable(page, ui, "viewer-changes");
  if (!isPhone(page)) {
    await viewer.getByRole("radio", { name: "Side by side" }).click();
    await readable(page, ui, "viewer-changes-split");
  }
  await viewer.getByRole("button", { name: "Previous file" }).click();
  await expect(viewer.getByRole("region", { name: "Rendered report.md" })).toBeVisible();
  await readable(page, ui, "viewer-markdown");
});

test("Replay and its timeline", async ({ page, ui }) => {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=20000`);
  const timeline = page.getByRole("slider", { name: "Replay timeline" });
  await expect(timeline).toBeVisible();
  await readable(page, ui, "replay");
  await page.getByRole("button", { name: "Export video" }).click();
  const panel = page.getByRole("dialog", { name: "Export video" });
  await expect(panel).toBeVisible();
  await readable(page, ui, "replay-export");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  if (!isPhone(page)) {
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await readable(page, ui, "replay-compare");
  }
});

test("Replay's recordings", async ({ page, ui }) => {
  await ui.open("library", () => "/?replay=library");
  await expect(page.getByRole("button", { name: /^Compare the home insurance/ })).toBeVisible();
  await readable(page, ui, "replay-library");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Tidy the Downloads folder" }).first().click();
  await readable(page, ui, "replay-library-select");
  await page.getByRole("button", { name: "Delete…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete this recording?" })).toBeVisible();
  await readable(page, ui, "replay-delete");
});

test("Routines", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await qa(page, fixture.origin, "routine/propose");
  const pending = page.getByRole("region", { name: /Routine waiting for you/ });
  await expect(pending).toBeVisible();
  await readable(page, ui, "routine-pending");
  await pending.getByRole("button", { name: "Edit" }).click();
  const sheet = page.getByRole("dialog", { name: "Save this routine" });
  await expect(sheet).toBeVisible();
  await readable(page, ui, "routine-editor");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await pending.getByRole("button", { name: "Save routine" }).click();
  await qa(page, fixture.origin, "routine/history");
  if (isPhone(page)) {
    await moreMenu(page);
    await page.getByRole("menuitem", { name: "Routines" }).click();
  } else await page.getByRole("radio", { name: "Routines" }).click();
  const row = page
    .locator(".routines-panel")
    .getByRole("button", { name: /Morning bills/ })
    .first();
  await expect(row).toBeVisible();
  await readable(page, ui, "routines");
  await press(page, row);
  await expect(page.getByRole("dialog", { name: "Morning bills" })).toBeVisible();
  await readable(page, ui, "routine-detail");
});

test("Settings, each page", async ({ page, ui }) => {
  test.setTimeout(240_000);
  await ui.open("ready");
  for (const section of SECTIONS) {
    const sheet = await openSettings(page, undefined, section.title);
    await expect(sheet).toBeVisible();
    await readable(page, ui, `settings-${section.id}`);
    await closeSettings(page);
  }
});

test("⌘K", async ({ page, ui }) => {
  await ui.open("running");
  await expect(await composer(page)).toBeVisible();
  if (isPhone(page)) {
    await moreMenu(page);
    await readable(page, ui, "more-menu");
    await page.getByRole("menuitem", { name: "Search actions" }).click();
  } else await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Search actions" })).toBeVisible();
  await readable(page, ui, "command-menu");
});

async function attention(page: Page) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/events$/, (socket) => {
    socket.connectToServer();
    sockets.push(socket);
  });
  return (item: Record<string, unknown>) => {
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: "attention.change", item, page: false }));
  };
}

test("a toast", async ({ page, ui }) => {
  const raise = await attention(page);
  const fixture = await ui.open("conversations");
  const listed = await page.request.get(`${fixture.origin}/api/conversations`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const { conversations } = (await listed.json()) as { conversations: { sessionId: string }[] };
  const toast = page.locator(".ui-toast:not([data-leaving])");
  await expect(async () => {
    raise({
      key: "toast",
      sessionId: conversations[1]?.sessionId,
      level: "done",
      reason: "done",
      task: "Pay the electricity bill",
      at: 1,
    });
    await expect(toast).toContainText("Pay the electricity bill", { timeout: 1_000 });
  }).toPass();
  await readable(page, ui, "toast");
});

test("signing in", async ({ page, ui }) => {
  await ui.open("ready", undefined, "");
  await expect(page.locator(".sign-in").first()).toBeVisible();
  await readable(page, ui, "sign-in");
});

test("slash commands", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await field.click();
  await field.pressSequentially("/");
  await expect(card.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await readable(page, ui, "slash-menu");
});

test("a conversation's menu", async ({ page, ui }) => {
  test.skip(isPhone(page), "A phone has no right click");
  await ui.open("conversations");
  const rail = page.getByRole("navigation", { name: "Conversations" });
  await rail.locator(".sessions-item").first().click({ button: "right" });
  await expect(page.getByRole("menu").first()).toBeVisible();
  await readable(page, ui, "conversation-menu");
});

for (const state of ["near", "limit"])
  test(`plan usage: ${state}`, async ({ page, ui }) => {
    const fixture = await ui.open("plan-usage");
    await qa(page, fixture.origin, `plan-usage/${state}`);
    const card = await openComposer(page);
    await card.getByRole("button", { name: /^Model:/ }).click();
    await expect(page.getByRole("dialog", { name: "Model and thinking" })).toBeVisible();
    await readable(page, ui, `plan-usage-${state}`);
  });

test("a task that stopped", async ({ page, ui }) => {
  await ui.open("done");
  await expect(await composer(page)).toBeVisible();
  await readable(page, ui, "done");
});

test("a long run in Workspace", async ({ page, ui }) => {
  await ui.open("long-run");
  await openPanel(page);
  await readable(page, ui, "long-run-panel");
});

for (const id of ["system", "overlays", "feedback", "activity", "stage"])
  test(`gallery: ${id}`, async ({ page, ui }) => {
    await ui.gallery(id);
    await page.clock.runFor(1000);
    await readable(page, null, `gallery-${id}`);
  });
