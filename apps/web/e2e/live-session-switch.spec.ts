import { expect, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

test.setTimeout(90_000);

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

test("a new task after Stop asks for no images from the stopped task", async ({ page }) => {
  fixture = await startUiFixture();
  const missing: string[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && /\/(frames|thumbs)\//.test(path)) missing.push(path);
  });
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
  await page.getByTestId("hud-stop-session").click();
  await expect(page.getByText("Stopped. Your computer is paused.")).toBeVisible();
  await page.getByRole("button", { name: "Resume computer" }).first().click();
  const task = page.getByRole("textbox", { name: "New task" });
  await expect(task).toBeEnabled();
  await task.fill("Make a new sample report");
  await task.press("Enter");
  await expect(page.getByText("Sample reply: I received the task.").first()).toBeVisible();
  await page.waitForTimeout(1500);
  expect(missing).toEqual([]);
});
