import { expect, runAt, test } from "./harness.ts";

// A new version: the island says so once, its Update stops the computer and the curtain covers the
// stage until the computer is back on the new version.
runAt("c14", "w39");

test("update, from the notice through the curtain and back", async ({ page, ui }) => {
  const fixture = await ui.open("ready");
  await ui.picture();
  const ready = await page.request.post(`${fixture.origin}/__qa/update`);
  expect(ready.ok(), await ready.text()).toBe(true);

  const notice = page
    .getByRole("listitem")
    .filter({ hasText: "A new version of your computer is ready" });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Update" }).click();

  const curtain = page.getByRole("region", { name: "Updating your computer" });
  await expect(curtain).toBeVisible();
  await expect(curtain.getByText("Your files and sign-ins stay.")).toBeVisible();
  await expect(notice).toBeHidden();

  await expect(curtain).toBeHidden({ timeout: 10_000 });
  await ui.picture();
});
