import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w14", "c39");

test("Work follows existing command events, yields to human input, and remembers the view", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const choices = page.getByRole("radiogroup", { name: "Screen view" });
  const work = page.getByRole("region", { name: "Live work" });
  await expect(choices).toBeVisible();
  await expect(work).toBeHidden();
  const canvas = page.locator(".stage > canvas");
  await expect(canvas).toHaveCount(1);
  const command = async (phase: string) => {
    const reply = await page.request.post(`${fixture.origin}/__qa/work/${phase}`);
    expect(reply.ok()).toBe(true);
  };
  await command("start");
  await expect(work).toBeVisible();
  await expect(work.getByRole("heading", { name: "pnpm test", exact: true })).toBeVisible();
  await expect(work.getByText("Waiting for output…")).toBeVisible();
  await command("output");
  await expect(work.getByText("✓ Application checks passed")).toBeVisible();
  await work.getByText("✓ Application checks passed").dblclick();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await command("finish");
  await expect(work.getByText("Exit 0").last()).toBeVisible();
  await expect(canvas).toHaveCount(1);
  const bounds = await choices.boundingBox();
  const stage = await page.locator(".stage").boundingBox();
  expect(
    bounds && stage && bounds.x >= stage.x && bounds.x + bounds.width <= stage.x + stage.width,
  ).toBe(true);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.screenshot({ path: test.info().outputPath("live-work.png") });
  await choices.getByRole("radio", { name: "Computer" }).click();
  await expect(work).toBeHidden();
  await page.reload();
  await expect(choices.getByRole("radio", { name: "Computer" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(work).toBeHidden();
  await choices.getByRole("radio", { name: "Work", exact: true }).click();
  await expect(work).toBeVisible();
  await ui.step("ask");
  await expect(work).toBeHidden();
  await expect(choices).toBeHidden();
});
