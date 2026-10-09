import type { APIRequestContext, Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { expect, test } from "./harness.ts";

// The conversation outlives the page, the task and the daemon: a refresh, a Stop or a daemon that
// went away reopens it, and the next message continues it. Only New conversation starts another.
test.beforeEach(() => {
  test.skip(!["c14", "w39"].includes(test.info().project.name), "One run per engine");
});

const EARLIER = "Find last month's sales table";
const LATEST = /^Summarise the sample sales table/;

// The rail, on its chat.
async function chat(page: Page) {
  const view = page.getByRole("radio", { name: "Chat" });
  if ((await view.getAttribute("aria-checked")) !== "true") await view.click();
  return page.getByRole("complementary", { name: "Conversation" });
}

// WebKit reports a request that a reload cuts off as a page error, so the page settles first.
async function refresh(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.reload();
}

async function send(page: Page, text: string) {
  const form = (await chat(page)).getByRole("form", { name: "Message dot" });
  await form.getByRole("textbox", { name: /^(New task|Message)$/ }).fill(text);
  await form.getByRole("button", { name: /^(Start task|Send|Send follow-up)$/ }).click();
}

// The task the computer runs now, and the one its session.start says it continues.
async function latestTask(request: APIRequestContext, origin: string, after: string) {
  let id = "";
  await expect
    .poll(async () => {
      id = ((await (await request.get(`${origin}/__qa/state`)).json()) as { sessionId: string })
        .sessionId;
      return id;
    })
    .not.toBe(after);
  const log = await request.get(`${origin}/api/sessions/${id}/events`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/x-ndjson" },
  });
  const start = (await log.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data: { continues?: string } })
    .find((event) => event.type === "session.start");
  return { id, continues: start?.data.continues };
}

const shownTask = async (request: APIRequestContext, origin: string) =>
  ((await (await request.get(`${origin}/__qa/state`)).json()) as { sessionId: string }).sessionId;

test("a refresh reopens the conversation, its earlier task included", async ({ page, ui }) => {
  await ui.open("continued");
  let rail = await chat(page);
  await expect(rail.getByText(EARLIER)).toBeVisible();
  await expect(rail.getByText(LATEST)).toBeVisible();
  await refresh(page);
  rail = await chat(page);
  await expect(rail.getByText(EARLIER)).toBeVisible();
  await expect(rail.getByText(LATEST)).toBeVisible();
  await expect(rail.getByRole("heading", { name: "What should we do?" })).toHaveCount(0);
});

test("after Stop and Resume, the next message continues the conversation", async ({
  page,
  ui,
  request,
}) => {
  const fixture = await ui.open("running");
  const stopped = await shownTask(request, fixture.origin);
  await page.getByRole("button", { name: "Stop", exact: true }).first().click();
  await page.getByRole("button", { name: "Resume computer" }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("Task stopped");
  const rail = await chat(page);
  await expect(rail.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "placeholder",
    "Message dot…",
  );
  await send(page, "Now make the chart blue");
  const next = await latestTask(request, fixture.origin, stopped);
  expect(next.continues).toBe(stopped);
  await expect(rail.getByText(LATEST)).toBeVisible();
  await expect(rail.getByText("Now make the chart blue")).toBeVisible();
});

test("the conversation stays while the computer is off and after it is turned on", async ({
  page,
  ui,
  request,
}) => {
  const fixture = await ui.open("continued");
  const done = await shownTask(request, fixture.origin);
  await expect(page.getByTestId("hud-status")).toHaveText("Done");
  await ui.step("off");
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  await refresh(page);
  let rail = await chat(page);
  await expect(rail.getByText(EARLIER)).toBeVisible();
  await expect(rail.getByText(LATEST)).toBeVisible();
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("Done");
  rail = await chat(page);
  await send(page, "And add a chart");
  expect((await latestTask(request, fixture.origin, done)).continues).toBe(done);
  await expect(rail.getByText("And add a chart")).toBeVisible();
  await expect(rail.getByText(EARLIER)).toBeVisible();
});

test("a daemon that went away under a task leaves the conversation to continue", async ({
  page,
  ui,
  request,
}) => {
  const fixture = await ui.open("running");
  const lost = await shownTask(request, fixture.origin);
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
  expect((await request.post(`${fixture.origin}/__qa/crash`)).ok()).toBe(true);
  // Without a reload, the page finds that no computer runs the task any more.
  await expect(page.getByTestId("hud-status")).toHaveText("Task stopped", { timeout: 15_000 });
  await refresh(page);
  const rail = await chat(page);
  await expect(rail.getByText(LATEST)).toBeVisible();
  await expect(page.getByTestId("hud-status")).toHaveText("Task stopped");
  await send(page, "Try that again");
  expect((await latestTask(request, fixture.origin, lost)).continues).toBe(lost);
});

test("New conversation starts afresh and stays new after a refresh", async ({
  page,
  ui,
  request,
}) => {
  const fixture = await ui.open("continued");
  const old = await shownTask(request, fixture.origin);
  let rail = await chat(page);
  // In the rail's header; on a phone, first in More.
  if ((page.viewportSize()?.width ?? 0) < 700) {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "New conversation" }).click();
  } else await page.getByRole("button", { name: "New conversation" }).click();
  await expect(rail.getByRole("heading", { name: "What should we do?" })).toBeVisible();
  await expect(rail.getByText(LATEST)).toHaveCount(0);
  await refresh(page);
  rail = await chat(page);
  await expect(rail.getByRole("heading", { name: "What should we do?" })).toBeVisible();
  await expect(rail.getByText(EARLIER)).toHaveCount(0);
  await send(page, "Plan a picnic");
  const fresh = await latestTask(request, fixture.origin, old);
  expect(fresh.continues).toBeUndefined();
  await expect(rail.getByText("Plan a picnic")).toBeVisible();
  await expect(rail.getByText(LATEST)).toHaveCount(0);
});

test("New conversation waits while dot works", async ({ page, ui }) => {
  await ui.open("running");
  await chat(page);
  await expect(page.getByRole("button", { name: "New conversation" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Continue on an older task in Replay makes its conversation current", async ({
  page,
  ui,
  request,
}) => {
  const fixture = await ui.open("done");
  const latest = await shownTask(request, fixture.origin);
  const older = (
    (await (await request.post(`${fixture.origin}/__qa/older-task`)).json()) as {
      sessionId: string;
    }
  ).sessionId;
  await page.waitForLoadState("networkidle");
  const known = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === "/api/conversation" && reply.ok(),
  );
  await page.goto(`${fixture.origin}/?replay=${older}#token=${TOKEN}`);
  await known;
  const proceed = page.getByRole("button", { name: "Continue conversation" });
  await expect(proceed).not.toHaveAttribute("aria-disabled", "true");
  await proceed.click();
  await expect(page).not.toHaveURL(/replay=/);
  let rail = await chat(page);
  await expect(rail.getByText("Plan the team offsite")).toBeVisible();
  await expect(rail.getByText(LATEST)).toHaveCount(0);
  await refresh(page);
  rail = await chat(page);
  await expect(rail.getByText("Plan the team offsite")).toBeVisible();
  await send(page, "Book the flights too");
  expect((await latestTask(request, fixture.origin, latest)).continues).toBe(older);
  await expect(rail.getByText("Plan the team offsite")).toBeVisible();
});
