import type { Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { attachFiles } from "./attach.ts";
import { composer, expect, runAt, sendAfterThisTask, test } from "./harness.ts";

// Stop gives back what dot had not acted on yet: it leaves the thread for the composer of the device
// that stopped, ahead of anything written there since, with its files. What dot acted on stays.
runAt("c14", "c39", "w39");

const yours = (page: Page, text: string) =>
  page.getByRole("article", { name: "You", exact: true }).filter({ hasText: text });
// The Stop shortcut, which stops the task whatever the composer's button offers.
const stop = (page: Page) => page.keyboard.press("ControlOrMeta+Shift+Period");

test("a new task's message dot has not answered comes back, and no empty conversation is left", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready");
  // dot takes its time to answer, so nothing it does comes before Stop.
  expect((await page.request.post(`${fixture.origin}/__qa/reply?ms=600000`)).ok()).toBe(true);
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: /^(New task|Message)$/ });
  await attachFiles(page, card, ["notes.txt"]);
  await field.fill("Draw a dog");
  await card.getByRole("button", { name: /^(Start task|Send)$/ }).click();
  await expect(yours(page, "Draw a dog")).toHaveCount(1);
  await expect(field).toHaveValue("");
  const { sessionId: task } = (await (
    await page.request.get(`${fixture.origin}/__qa/state`)
  ).json()) as { sessionId: string };
  await field.fill("and make it brown");
  await stop(page);

  await expect(field).toHaveValue("Draw a dog\n\nand make it brown");
  await expect(yours(page, "Draw a dog")).toHaveCount(0);
  const chips = card.getByRole("list", { name: "Attached files" });
  await expect(chips).toContainText("notes.txt");
  await expect(chips.getByText("Uploaded to Downloads")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
  // Nothing was carried out, so nothing is left to clean up: no conversation and no task.
  const read = async (path: string) =>
    (
      await page.request.get(`${fixture.origin}${path}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json();
  expect(await read("/api/conversation")).toEqual({ sessions: [], more: false });
  expect(
    ((await read("/api/session-index")) as { sessions: { id: string }[] }).sessions.map(
      (listed) => listed.id,
    ),
  ).not.toContain(task);
});

for (const how of ["sent as it works", "queued"] as const)
  test(`a message dot acted on stays; only what came after it comes back: ${how}`, async ({
    page,
    ui,
  }) => {
    await ui.open("running");
    const card = await composer(page);
    const field = card.getByRole("textbox", { name: "Message", exact: true });
    await field.fill("Then tidy up the sheet");
    if (how === "queued") await sendAfterThisTask(page);
    else await card.getByRole("button", { name: "Send now" }).click();
    await expect(
      yours(page, "Then tidy up the sheet").getByText(
        how === "queued" ? "After this task" : "Sent while working",
      ),
    ).toBeVisible();
    await expect(field).toHaveValue("");
    await card.getByRole("button", { name: "Stop task" }).click();

    await expect(field).toHaveValue("Then tidy up the sheet");
    await expect(yours(page, "Then tidy up the sheet")).toHaveCount(0);
    await expect(yours(page, "Summarise the sample sales table")).toBeVisible();
    await expect(page.getByText("Not sent")).toHaveCount(0);
  });

test("a message dot went on to answer stays when Stop comes after", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: "Message", exact: true });
  await field.fill("Use the blue palette");
  await card.getByRole("button", { name: "Send now" }).click();
  const sent = yours(page, "Use the blue palette");
  await expect(sent.getByText("Sent while working")).toBeVisible();
  const said = await page.request.post(`${fixture.origin}/__qa/say?text=Switching%20to%20blue.`);
  expect(said.ok()).toBe(true);
  await expect(page.locator(".thread .safe-markdown").filter({ hasText: "Switching" })).toHaveCount(
    1,
  );
  await card.getByRole("button", { name: "Stop task" }).click();

  await expect(card.getByRole("button", { name: "Stop task" })).toHaveCount(0);
  await expect(field).toHaveValue("");
  await expect(sent).toHaveCount(1);
});
