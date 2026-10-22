import type { Page, Request } from "@playwright/test";
import { composer, expect, runAt, test } from "./harness.ts";

// dot's questions answered in the thread beside a wide screen and in a phone's sheet: the user's
// own words for any choice, fields they may leave to dot, and a field that needs an answer.
runAt("c14", "c39", "w39");

// Every answer the page sends, in order.
function answers(page: Page) {
  const sent: unknown[] = [];
  page.on("request", (request: Request) => {
    if (request.method() === "POST" && request.url().endsWith("/answer"))
      sent.push(request.postDataJSON());
  });
  return sent;
}

async function recorded(page: Page, origin: string) {
  const state = (await (await page.request.get(`${origin}/__qa/state`)).json()) as {
    effects: string[];
  };
  return state.effects
    .filter((effect) => effect.startsWith("ask:"))
    .map((e) => JSON.parse(e.slice(4)));
}

test("own words for a choice and a multichoice, optional fields left blank, a missing answer", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const sent = answers(page);
  expect((await page.request.post(`${fixture.origin}/__qa/ask?fields=setup`)).ok()).toBe(true);
  const form = page.locator("form.ask");
  for (const label of ["Framework (optional)", "Extras (optional)", "Notes (optional)"])
    await expect(form.getByText(label, { exact: true })).toBeVisible();
  await expect(form.getByText("Project name", { exact: true })).toBeVisible();
  const next = form.getByRole("radio", { name: "Next.js" });
  await expect(next).not.toBeChecked();
  await expect(next).toHaveAccessibleDescription("Recommended");

  // Continue is never held back: pressed too soon, it says what is missing and goes there.
  const send = form.getByRole("button", { name: "Continue", exact: true });
  await expect(send).not.toHaveAttribute("aria-disabled", "true");
  await send.click();
  const name = form.getByRole("textbox", { name: "Project name", exact: true });
  await expect(name).toBeFocused();
  await expect(form.getByText("Fill this in")).toBeVisible();
  expect(sent).toEqual([]);

  await name.fill("Atlas");
  const other = form.getByRole("textbox", { name: "Other", exact: true });
  await other.nth(0).fill("SvelteKit");
  await expect(next).not.toBeChecked();
  await form.getByRole("checkbox", { name: "Tests", exact: true }).check();
  await other.nth(1).fill("Storybook");
  await other.nth(1).blur();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("own-words.png") });
  await send.click();
  await expect(form).toHaveCount(0);
  expect(sent).toEqual([
    {
      askId: expect.any(String),
      fields: {
        name: "Atlas",
        framework: "SvelteKit",
        extras: { selected: ["Tests"], other: "Storybook" },
      },
    },
  ]);
  expect(await recorded(page, fixture.origin)).toEqual([
    expect.objectContaining({
      by: "user",
      fields: {
        name: "Atlas",
        framework: { other: "SvelteKit" },
        extras: { selected: ["Tests"], other: "Storybook" },
      },
      skipped: ["notes"],
    }),
  ]);
  await expect(page.getByText(/Framework: SvelteKit/)).toBeVisible();
});

test("a quick choice the user leaves to dot", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const sent = answers(page);
  expect((await page.request.post(`${fixture.origin}/__qa/ask`)).ok()).toBe(true);
  const form = page.locator("form.ask");
  const markdown = form.getByRole("radio", { name: "Markdown" });
  await expect(markdown).toHaveAccessibleDescription("Recommended");
  await expect(markdown).not.toBeChecked();
  await expect(form.getByText("(optional)")).toHaveCount(0);
  await expect(form.getByRole("textbox", { name: "Other", exact: true })).toBeVisible();
  const decide = form.getByRole("button", { name: "Let dot decide", exact: true });
  await expect(decide).toBeVisible();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("let-dot-decide.png") });
  await markdown.check();
  await expect(form.getByRole("button", { name: "Send answer", exact: true })).toBeVisible();
  await form.getByRole("textbox", { name: "Other", exact: true }).fill("Word");
  await expect(markdown).not.toBeChecked();
  await form.getByRole("textbox", { name: "Other", exact: true }).fill("");
  await decide.click();
  await expect(form).toHaveCount(0);
  expect(sent).toEqual([{ askId: expect.any(String), fields: {} }]);
  expect(await recorded(page, fixture.origin)).toEqual([
    expect.objectContaining({ by: "user", fields: {}, skipped: ["answer"] }),
  ]);
  await expect(page.getByText("Let dot decide", { exact: true })).toBeVisible();
});

test("a message answers a lone question in the user's own words", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const sent = answers(page);
  expect((await page.request.post(`${fixture.origin}/__qa/ask`)).ok()).toBe(true);
  await expect(page.locator("form.ask")).toBeVisible();
  const card = await composer(page);
  await card.getByRole("textbox", { name: "Message" }).fill("Word, with tracked changes");
  await card.evaluate((element) => (element as HTMLFormElement).requestSubmit());
  await expect(page.locator("form.ask")).toHaveCount(0);
  expect(sent).toEqual([
    { askId: expect.any(String), fields: { answer: "Word, with tracked changes" } },
  ]);
  expect(await recorded(page, fixture.origin)).toEqual([
    expect.objectContaining({
      by: "user",
      fields: { answer: { other: "Word, with tracked changes" } },
    }),
  ]);
});
