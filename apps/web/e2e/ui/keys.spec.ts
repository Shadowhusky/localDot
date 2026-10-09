import type { Locator, Page } from "@playwright/test";
import { expect, type Harness, runAt, test } from "./harness.ts";

// The Keys sheet beside the page at 1440, and as a sheet over it on a phone.
runAt("c14", "w39");

// Opens Keys from the top bar; `then` gets the fixture's origin once the sheet shows.
async function keys(page: Page, ui: Harness, then?: (origin: string) => Promise<void>) {
  const fixture = await ui.open("ready");
  await ui.picture();
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys", exact: true });
  await expect(sheet.getByText("Key isolation", { exact: true })).toBeVisible();
  await then?.(fixture.origin);
  return sheet;
}

const rows = (sheet: Locator) =>
  sheet.locator(".keys-row").evaluateAll((items) =>
    items.map((item) => {
      const { x, y, width, height } = item.getBoundingClientRect();
      return [x, y, width, height].map(Math.round);
    }),
  );

test("keys, empty", async ({ page, ui }) => {
  const sheet = await keys(page, ui);
  for (const id of ["anthropic-main", "openai-fast", "weather"]) {
    await sheet.getByRole("button", { name: `Remove ${id}`, exact: true }).click();
    await sheet.getByRole("button", { name: `Confirm remove ${id}`, exact: true }).click();
    await expect(sheet.locator(`.keys-row[data-id='${id}']`)).toHaveCount(0);
  }
  await expect(sheet.getByText("No keys yet", { exact: true })).toBeVisible();
});

test("keys, list", async ({ page, ui }) => {
  const sheet = await keys(page, ui);
  await expect(sheet.getByText("openai-fast", { exact: true })).toBeVisible();
});

test("keys, held while the audit log fails", async ({ page, ui }) => {
  const sheet = await keys(page, ui, async (origin) => {
    await page.request.post(`${origin}/__qa/keyd/audit`);
  });
  // Keys looks at key protection every 5 s.
  await expect(sheet.getByText("Paused — keys held", { exact: true })).toBeVisible({
    timeout: 8000,
  });
  await expect(sheet.getByRole("button", { name: "Save key" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("keys, a problem shown as the key field takes focus", async ({ page, ui }) => {
  const sheet = await keys(page, ui);
  await sheet.getByRole("radio", { name: "Web API" }).click();
  await sheet.getByLabel("Hosts", { exact: true }).fill("https://api.weather.example/v1");
  const key = sheet.getByLabel("Key", { exact: true });
  await key.scrollIntoViewIfNeeded();
  await key.focus();
  await expect(sheet.getByText(/is not a host name/)).toBeVisible();
  await expect(sheet.getByLabel("Hosts", { exact: true })).toHaveAttribute("aria-invalid", "true");
});

test("the Web API fields pair up when wide and stack with even gaps on a phone", async ({
  page,
  ui,
}) => {
  const sheet = await keys(page, ui);
  await sheet.getByRole("radio", { name: "Web API" }).click();
  // Each field from its label's top to the bottom of what it shows: an empty message line counts
  // as space between fields, which is what must stay even.
  const field = async (label: string) => {
    const name = page.locator(".ui-field-label").getByText(label, { exact: true });
    return sheet.locator(".ui-field", { has: name }).evaluate((element) => {
      const parts = [
        ...element.querySelectorAll(".ui-field-label, .ui-field-box, .ui-field-message > *"),
      ]
        .map((part) => part.getBoundingClientRect())
        .filter((box) => box.height > 0);
      return {
        top: Math.min(...parts.map((box) => box.top)),
        bottom: Math.max(...parts.map((box) => box.bottom)),
      };
    });
  };
  const hosts = await field("Hosts");
  const header = await field("Header");
  const format = await field("Sent as");
  const label = await field("Label (optional)");
  if (header.top === format.top) return;
  const gaps = [
    header.top - hosts.bottom,
    format.top - header.bottom,
    label.top - format.bottom,
  ].map(Math.round);
  expect(new Set(gaps).size, `gaps ${gaps}`).toBe(1);
});

test("arming Remove, and its running out, move nothing in the list", async ({ page, ui }) => {
  const sheet = await keys(page, ui);
  await expect(sheet.getByText("weather", { exact: true })).toBeVisible();
  await ui.settle();
  const before = await rows(sheet);
  await sheet.getByRole("button", { name: "Remove weather" }).click();
  await expect(sheet.getByRole("button", { name: "Confirm remove weather" })).toBeVisible();
  expect(await rows(sheet)).toEqual(before);
  await expect(sheet.getByRole("button", { name: "Remove weather" })).toBeVisible({
    timeout: 6000,
  });
  expect(await rows(sheet)).toEqual(before);
});

test("a saved key folds into the list and a removed one folds away", async ({ page, ui }) => {
  const sheet = await keys(page, ui);
  await sheet.getByLabel("Key", { exact: true }).fill("sk-ant-api03-fixture-value-for-ui");
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("form", { name: "Add a key" }).getByRole("status")).toHaveText(
    "Saved anthropic.",
  );
  const added = sheet.locator(".keys-row[data-id='anthropic']");
  await expect(added).toBeVisible();
  await expect(added).toHaveAttribute("data-fresh", "");
  await sheet.getByRole("button", { name: "Remove anthropic", exact: true }).click();
  await sheet.getByRole("button", { name: "Confirm remove anthropic", exact: true }).click();
  await expect(added).toHaveCount(0);
  await expect(sheet.locator(".keys-row")).toHaveCount(3);
});
