import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

const RELAY = `https://${"a1".repeat(16)}--dot.localdot.dev`;
const PAIR = `${RELAY}/_remote/pair#remote=${"b".repeat(64)}&code=${"c".repeat(43)}`;

runAt("c14", "c39", "w39");
test("another localDot can be edited in place, and a pasted sign-in link signs in there", async ({
  page,
  ui,
}) => {
  const saved: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/api/agent/settings"))
      saved.push(request.postDataJSON().localDots);
  });
  await ui.open("ready");
  await page.evaluate(() => {
    window.open = (url) => {
      document.documentElement.dataset.opened = String(url);
      return null;
    };
  });
  const sheet = await openSettings(page, undefined, "Your dot");
  const list = sheet.locator("div:has(> .ui-group-head:has-text('Your other localDots'))");
  await list.scrollIntoViewIfNeeded();
  const name = list.getByRole("textbox", { name: "Name" });
  const address = list.getByRole("textbox", { name: "Address" });
  await name.fill("Office PC");
  await address.fill("office-pc.example.ts.net:4750");
  await list.getByRole("button", { name: "Add" }).click();
  await expect(list).toContainText("office-pc.example.ts.net:4750");

  await address.fill(PAIR);
  await address.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-opened", PAIR);
  await expect(list).toContainText("Remote localDot");
  await expect(list).not.toContainText("#remote");

  await list.getByRole("button", { name: "Edit Office PC" }).click();
  await expect(name).toHaveValue("Office PC");
  await expect(address).toHaveValue("https://office-pc.example.ts.net:4750");
  await expect(list.getByText("Changing the address means signing in again there.")).toBeVisible();
  await name.fill("Studio");
  await address.fill("studio.example.ts.net:4750");
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("localdot-editing.png") });
  await list.getByRole("button", { name: "Save" }).click();
  await expect(list.getByRole("button", { name: "Edit Studio" })).toBeFocused();
  await expect(list).toContainText("studio.example.ts.net:4750");
  await expect(list).not.toContainText("office-pc.example.ts.net");

  await list.getByRole("button", { name: "Edit Remote localDot" }).click();
  await address.fill("studio.example.ts.net:4750");
  await address.press("Enter");
  await expect(list.getByText("That localDot is already in the list.")).toBeVisible();
  await address.press("Escape");
  await expect(sheet).toBeVisible();
  await expect(list.getByRole("button", { name: "Edit Remote localDot" })).toBeFocused();
  await expect
    .poll(() => saved.at(-1), { timeout: 10_000 })
    .toEqual([
      { name: "Studio", url: "https://studio.example.ts.net:4750" },
      { name: "Remote localDot", url: RELAY },
    ]);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("localdot-list.png") });
});
