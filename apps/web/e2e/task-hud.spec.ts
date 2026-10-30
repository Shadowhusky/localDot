import { expect, type Page, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

test.setTimeout(60_000);

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function open(page: Page, env: Record<string, string> = {}) {
  fixture = await startUiFixture(env);
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  return fixture;
}
const status = (page: Page) => page.getByTestId("hud-status");
const island = (page: Page) => page.locator(".watch .island");
const control = (page: Page) => page.locator(".app.control");
const qa = (page: Page, path: string) => page.request.post(`${fixture?.origin}/__qa/${path}`);
const replayLabel = (page: Page) => page.locator(".replay-main .island-label-text");
const replayLit = (page: Page) => page.locator(".replay-main .stage-frame[data-light='dot']");

// While a task waits, the island keeps its slots: the label, the time waited and Stop.
async function expectWaiting(page: Page, label: string, dotKeeps = false) {
  await expect(status(page)).toHaveText(label);
  await expect(page.getByTestId("hud-stop-session")).toBeVisible();
  await expect(page.getByTestId("hud-elapsed")).toHaveCount(1);
  await expect(control(page)).toHaveCount(dotKeeps ? 1 : 0);
}

test("a running task names its action and gives dot control", async ({ page }) => {
  await open(page);
  await expect(status(page)).toHaveText("Select the Net total cell");
  await expect(page.getByTestId("hud-stop-session")).toBeVisible();
  await expect(control(page)).toHaveCount(1);
});

test("a finished task says Done, with no clock and the computer's own control", async ({
  page,
}) => {
  await open(page, { QA_PHASE: "finished" });
  await expect(status(page)).toHaveText("Done");
  await expect(island(page).getByRole("button").first()).toHaveAccessibleName("Take control");
  await expect(page.getByTestId("hud-stop-session")).toHaveCount(0);
  // The thread sums the finished turn up; nothing is live under it.
  await expect(
    page.getByRole("region", { name: "Conversation history" }).getByRole("button", {
      name: /Worked for/,
    }),
  ).toBeVisible();
  await expect(island(page).getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  await page.waitForTimeout(2500);
  await expect(status(page)).toHaveText("Done");
  await expect(page.getByTestId("hud-elapsed")).toHaveCount(0);
  await expect(control(page)).toHaveCount(0);
});

test("Pause reads Paused, and Continue hands control back to dot", async ({ page }) => {
  await open(page);
  await expect(control(page)).toHaveCount(1);
  await island(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expectWaiting(page, "Paused");
  await expect(page.getByRole("region", { name: "Task recovery" })).toHaveCount(0);
  await island(page).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(status(page)).toHaveText("Select the Net total cell");
  await expect(control(page)).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Task recovery" })).toHaveCount(0);
});

test("a Pause the computer cannot confirm says so", async ({ page }) => {
  await open(page);
  await island(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expectWaiting(page, "Paused");
  await qa(page, "pause-uncertain");
  await expectWaiting(page, "Pause not confirmed");
  await expect(island(page).getByRole("button", { name: "Continue", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

// dot keeps the computer while it waits on an OK, so its rim keeps its light.
test("an approval puts the decision first and the thread says dot waits for you", async ({
  page,
}) => {
  await open(page);
  await expect(control(page)).toHaveCount(1);
  await qa(page, "approval");
  await expectWaiting(page, "Needs your OK", true);
  await expect(page.locator(".thread-work[data-live]")).toContainText("Waiting for you");
});

test("after Send, dot has control again and a quiet task still warns", async ({ page }) => {
  await open(page);
  await qa(page, "approval?risk=medium");
  await expectWaiting(page, "Needs your OK", true);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(status(page)).toHaveText("Select the Net total cell");
  await expect(control(page)).toHaveCount(1);
  await qa(page, "heartbeat");
  await expect(
    page.getByText("This is taking longer than usual. Stop me if it looks stuck."),
  ).toBeVisible();
});

test("Replay after Send shows dot back at work, not still waiting", async ({ page }) => {
  const { origin } = await open(page);
  await qa(page, "approval?risk=medium");
  await expectWaiting(page, "Needs your OK", true);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(status(page)).toHaveText("Select the Net total cell");
  const { sessionId } = await (await page.request.get(`${origin}/__qa/state`)).json();
  await page.goto(`${origin}/?replay=${sessionId}#token=${TOKEN}`);
  const replay = page.getByRole("main", { name: "Replay" });
  await expect(replay).toBeVisible();
  const time = replay.getByRole("status", { name: "Replay time" });
  const length = replay.locator(".replay-length");
  await expect(length).not.toHaveText("0:00");
  // Jump to the end of the recording, which is after the approval.
  await expect(async () => {
    await page.keyboard.press("l");
    expect(await time.textContent()).toBe(await length.textContent());
  }).toPass();
  // The readout shows whole seconds, so one more 10 s step lands on the very end.
  await page.keyboard.press("l");
  await expect(replayLabel(page)).toHaveText(/^(Working|Select the Net total cell)$/);
  await expect(replayLit(page)).toHaveCount(1);
});

test("Replay reads a Pause as pausing until the step it waits on ends, as live does", async ({
  page,
}) => {
  const { origin } = await open(page, { QA_PAUSE: "step" });
  await island(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(status(page)).toHaveText("Pausing after this step");
  await expect(control(page)).toHaveCount(1);
  await page.waitForTimeout(1000);
  await qa(page, "step-end");
  await expectWaiting(page, "Paused");
  const { sessionId } = await (await page.request.get(`${origin}/__qa/state`)).json();
  const log = await page.request.get(`${origin}/api/sessions/${sessionId}/events?fromSeq=0`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const events: { type: string; t: number; data: { state?: string } }[] = await log.json();
  const pausedMs = (events.find((e) => e.data.state === "paused")?.t ?? 0) / 1000;
  const endedMs = (events.findLast((e) => e.type === "step.end")?.t ?? 0) / 1000;
  expect(endedMs - pausedMs).toBeGreaterThan(500);
  const replay = page.getByRole("main", { name: "Replay" });
  const at = async (tMs: number) => {
    await page.goto(`${origin}/?replay=${sessionId}&t=${Math.ceil(tMs)}#token=${TOKEN}`);
    await expect(replay).toBeVisible();
  };
  await at((pausedMs + endedMs) / 2);
  await expect(replayLabel(page)).toHaveText("Pausing after this step");
  await expect(replayLit(page)).toHaveCount(1);
  await at(endedMs + 1);
  await expect(replayLabel(page)).toHaveText("Paused");
  await expect(replayLit(page)).toHaveCount(0);
});

test("a question puts the question first", async ({ page }) => {
  await open(page);
  await qa(page, "ask");
  await expectWaiting(page, "Needs your answer", true);
  await expect(page.locator(".narration")).toContainText("Which report format should I use?");
});

test("a budget pause names the limit", async ({ page }) => {
  await open(page);
  await qa(page, "budget");
  await expectWaiting(page, "Spending limit reached");
  await expect(page.getByRole("region", { name: "Task recovery" })).toBeVisible();
});

test("after Stop and Resume, the live computer keeps the stopped verdict", async ({ page }) => {
  await open(page);
  await page.getByTestId("hud-stop-session").click();
  await island(page).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(status(page)).toHaveText("Task stopped");
  await expect(island(page)).toHaveAttribute("data-shape", "ready");
  await expect(island(page).getByRole("button").first()).toHaveAccessibleName("Take control");
  await expect(control(page)).toHaveCount(0);
  await expect(page.locator(".thread .thread-work").last()).toContainText("Stopped after");
});
