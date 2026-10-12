import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("an invitation code is answered in place without takeover or truncation", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  expect((await page.request.post(`${fixture.origin}/__qa/ask?fields=invitation`)).ok()).toBe(true);
  const field = page
    .getByRole("textbox", { name: "Invitation code", exact: true })
    .filter({ visible: true })
    .first();
  await expect(field).toBeVisible();
  const code = "Invite-Abc.123-XYZ";
  await field.fill(code);
  await expect(field).toHaveValue(code);
  await expect(field).toHaveAttribute("autocapitalize", "none");
  await field.scrollIntoViewIfNeeded();
  await expect(field).toBeInViewport();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("invitation-form.png") });
  const form = field.locator("xpath=ancestor::form");
  await form.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(page.getByText(code, { exact: false })).toHaveCount(0);
});
