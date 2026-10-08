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
const hudButton = (page: Page) => page.locator(".task-bar .hud button.a").first();
const control = (page: Page) => page.locator(".app.control");
const qa = (page: Page, path: string) => page.request.post(`${fixture?.origin}/__qa/${path}`);

async function expectWaiting(page: Page, label: string) {
  await expect(status(page)).toHaveText(label);
  await expect(page.getByTestId("hud-stop-session")).toBeVisible();
  await expect(page.getByTestId("hud-elapsed")).toHaveCount(0);
  await expect(control(page)).toHaveCount(0);
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
  await expect(hudButton(page)).toHaveText("Stop computer");
  await expect(page.getByTestId("hud-stop-session")).toHaveCount(0);
  await expect(page.locator(".task-connection")).toHaveText("Ready for follow-up");
  await expect(page.getByRole("button", { name: "Pause after this step" })).toHaveCount(0);
  await page.waitForTimeout(2500);
  await expect(status(page)).toHaveText("Done");
  await expect(page.getByTestId("hud-elapsed")).toHaveCount(0);
  await expect(control(page)).toHaveCount(0);
});

test("Pause after this step reads Paused, and Resume hands control back to dot", async ({
  page,
}) => {
  await open(page);
  await expect(control(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Pause after this step" }).click();
  await expectWaiting(page, "Paused");
  await expect(page.getByRole("region", { name: "Task recovery" })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume task" }).click();
  await expect(status(page)).toHaveText("Select the Net total cell");
  await expect(control(page)).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Task recovery" })).toHaveCount(0);
});

test("a Pause the computer cannot confirm says so", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Pause after this step" }).click();
  await expectWaiting(page, "Paused");
  await qa(page, "pause-uncertain");
  await expectWaiting(page, "Pause unconfirmed");
  await expect(page.getByRole("button", { name: "Resume task" })).toBeDisabled();
});

test("an approval puts the decision first and takes control from dot", async ({ page }) => {
  await open(page);
  await expect(control(page)).toHaveCount(1);
  await qa(page, "approval");
  await expectWaiting(page, "Needs your OK");
  await expect(page.locator(".task-connection")).toHaveText("Waiting for you");
});

test("after Approve once, dot has control again and a late heartbeat still warns", async ({
  page,
}) => {
  await open(page);
  await qa(page, "approval?risk=medium");
  await expectWaiting(page, "Needs your OK");
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(status(page)).toHaveText("Select the Net total cell");
  await expect(control(page)).toHaveCount(1);
  await qa(page, "heartbeat");
  await expect(
    page.getByText("The task heartbeat is late. You can use Stop if you want to contain it."),
  ).toBeVisible();
});

test("a question puts the question first", async ({ page }) => {
  await open(page);
  await qa(page, "ask");
  await expectWaiting(page, "Has a question");
  await expect(page.locator(".caption")).toContainText("Which report format should I use?");
});

test("a budget pause names the limit", async ({ page }) => {
  await open(page);
  await qa(page, "budget");
  await expectWaiting(page, "Paused · Limit reached");
  await expect(page.getByRole("region", { name: "Task recovery" })).toBeVisible();
});

test("after Stop and Resume computer, the live computer keeps the stopped verdict", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("hud-stop-session").click();
  await page.getByRole("button", { name: "Resume computer" }).click();
  await expect(status(page)).toHaveText("Task stopped");
  await expect(hudButton(page)).toHaveText("Stop computer");
  await expect(page.locator(".live")).toHaveText("Live");
  await expect(control(page)).toHaveCount(0);
  await expect(page.locator(".task-connection")).toHaveCount(0);
});
