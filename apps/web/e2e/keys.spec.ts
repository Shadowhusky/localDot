import { expect, test } from "@playwright/test";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { closeSettings, nestedKeys, search, settingsSheet } from "./settings-ui.ts";
import { skipSetup } from "./skip-setup.ts";

declare global {
  interface Window {
    keyCspErrors: {
      directive: string;
      blockedURI: string;
      sourceFile: string;
      lineNumber: number;
      columnNumber: number;
      sample: string;
    }[];
  }
}

// The key form end to end: Chrome seals the key with WebCrypto to keyd's boot key, the daemon
// relays ciphertext, keyd stores it. No Docker: keys are keyd's alone.
const VALUE = `e2e-${Math.random().toString(36).slice(2)}-key-value`;
let daemon: RunningDaemon;

test.beforeEach(async ({ page }) => {
  await skipSetup(page);
  await page.addInitScript(() => {
    const target = window;
    target.keyCspErrors = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      target.keyCspErrors.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        columnNumber: event.columnNumber,
        sample: event.sample,
      });
    });
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.keyCspErrors)).toEqual([]);
});

test.beforeAll(async () => {
  daemon = await startDaemon();
});

test.afterAll(async () => {
  await daemon?.stop();
});

test("save a web API key sealed in the page, list it, remove it", async ({ page }) => {
  const posted: string[] = [];
  const leaks: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(VALUE) || r.postData()?.includes(VALUE))
      leaks.push(`${r.method()} ${new URL(r.url()).pathname}`);
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/keys")
      posted.push(r.postData() ?? "");
  });
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page.getByTestId("keys-button")).toHaveAccessibleName(/^Keys/);
  await page.getByTestId("keys-button").click();
  // Keys is a section of Settings, which the top bar's key opens at it.
  const sheet = nestedKeys(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("No keys yet")).toBeVisible();

  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  await page.keyboard.press("Escape");
  await settingsSheet(page).getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("keys-button")).toBeFocused();
  await page.getByTestId("keys-button").click();
  await expect(sheet.getByLabel("Key", { exact: true })).toHaveValue("");

  await sheet.getByRole("radio", { name: "Custom service" }).click();
  await sheet.getByLabel("Key ID (optional)", { exact: true }).fill("weather");
  await sheet.getByLabel("Hosts", { exact: true }).fill("api.weather.example");
  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/keys", async (route) => {
    if (route.request().method() === "POST") {
      waiting.resolve();
      await release.promise;
    }
    await route.continue();
  });
  await sheet.getByRole("button", { name: "Save key" }).click();
  await waiting.promise;
  try {
    await expect(sheet.getByLabel("Key", { exact: true })).toHaveValue("");
    await expect(sheet.getByLabel("Key ID (optional)", { exact: true })).toHaveAttribute(
      "readonly",
      "",
    );
  } finally {
    release.resolve();
  }
  // The first key folds the form into the list, where its row lights up.
  const weather = sheet.locator(".keys-row[data-id='weather']");
  await expect(weather).toContainText("api.weather.example, Added");
  await expect(weather).toHaveAttribute("data-fresh", "");
  await expect(sheet.getByRole("form", { name: "Add a key" })).toHaveCount(0);
  await page.unroute("**/api/keys");
  await expect(sheet).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "e2e/out/keys-sheet.png" });

  expect(posted).toHaveLength(1);
  expect(posted[0]).not.toContain(VALUE);
  const body = JSON.parse(posted[0] ?? "{}") as {
    binding: unknown;
    sealed: { v: number; ct: string };
  };
  expect(body.binding).toEqual({
    id: "weather",
    kind: "http",
    hosts: ["api.weather.example"],
    header: "Authorization",
    format: "bearer",
  });
  expect(body.sealed.v).toBe(1);
  expect(Object.keys(body).sort()).toEqual(["binding", "sealed"]);

  // A base URL with non-ASCII text goes as the URL parser writes it, so the binding Chrome seals
  // is byte for byte the one keyd rebuilds.
  await sheet.getByRole("button", { name: /^Add (a )?key$/ }).click();
  await sheet.getByRole("radio", { name: "Model & service" }).click();
  await search(page, sheet.getByRole("combobox", { name: "Provider" }), "openai-compatible");
  await sheet.getByLabel("Key ID (optional)", { exact: true }).fill("books");
  await sheet.getByLabel("Base URL").fill("https://bücher.example/openai/v1");
  await sheet.getByLabel("Key", { exact: true }).fill(`${VALUE}-2`);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("form", { name: "Add a key" }).getByRole("status")).toHaveText(
    "Saved books.",
  );
  await expect(sheet.locator(".keys-row[data-id='books']")).toContainText(
    "OpenAI-compatible, xn--bcher-kva.example",
  );
  expect(posted).toHaveLength(2);
  expect(posted[1]).not.toContain(VALUE);
  await sheet.getByRole("button", { name: "Remove books" }).click();
  await sheet.getByRole("button", { name: "Confirm remove books" }).click();

  await sheet.getByRole("button", { name: "Remove weather" }).click();
  await sheet.getByRole("button", { name: "Confirm remove weather" }).click();
  await expect(sheet.getByText("No keys yet")).toBeVisible();
  const keys = await (
    await fetch(`${daemon.origin}/api/keys`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    })
  ).json();
  expect(keys).toEqual({ keys: [] });
  expect(leaks).toEqual([]);
  expect(
    await page.evaluate(
      (value) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value),
      VALUE,
    ),
  ).toBe(false);

  await page.keyboard.press("Escape");
  await expect(settingsSheet(page)).toBeHidden();
  await expect(page.getByTestId("keys-button")).toBeFocused();
});

test("keeps the sheet usable at 375px with a long key name and reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  // A phone has no top bar: Keys is in More, as a page of Settings' sheet.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Keys", exact: true }).click();
  const sheet = settingsSheet(page);
  const id = "a".repeat(64);
  await sheet.getByLabel("Key ID (optional)", { exact: true }).fill(id);
  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.locator(`.keys-row[data-id='${id}']`)).toHaveAttribute("data-fresh", "");
  const bounds = await sheet.boundingBox();
  expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375).toBe(true);
  expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const remove = sheet.getByRole("button", { name: `Remove ${id}` });
  const removeBounds = await remove.boundingBox();
  expect(removeBounds && removeBounds.x >= 0 && removeBounds.x + removeBounds.width <= 375).toBe(
    true,
  );
  await page.screenshot({ path: "e2e/out/keys-narrow.png" });
  await remove.click();
  await sheet.getByRole("button", { name: `Confirm remove ${id}` }).click();
  await expect(sheet.getByText("No keys yet")).toBeVisible();
});

test("describe and edit a custom key without re-entering its value", async ({ page }) => {
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await page.getByTestId("keys-button").click();
  const sheet = nestedKeys(page);
  if (await sheet.getByRole("button", { name: /^Add (a )?key$/ }).isVisible())
    await sheet.getByRole("button", { name: /^Add (a )?key$/ }).click();
  await sheet.getByRole("radio", { name: "Custom service" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("Research catalog");
  await sheet.getByLabel("Service (optional)", { exact: true }).fill("Example API");
  await sheet
    .getByLabel("Use for (optional)", { exact: true })
    .fill("Search the product catalog and retrieve product files");
  await sheet.getByLabel("Key ID (optional)", { exact: true }).fill("catalog");
  await sheet.getByLabel("Hosts", { exact: true }).fill("api.example.test");
  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  await sheet.getByRole("button", { name: "Save key" }).click();
  const row = sheet.locator('.keys-row[data-id="catalog"]');
  await expect(row).toContainText("Research catalog");
  await expect(row).toContainText("Search the product catalog");
  let result = await (await daemon.request("/api/keys")).json();
  const before = result.keys.find((k: { id: string }) => k.id === "catalog");
  expect(before.metadata.service).toBe("Example API");
  expect(before.usage.hosts).toEqual(["api.example.test"]);
  await sheet.getByRole("button", { name: "Edit details for catalog" }).click();
  const editor = sheet.getByRole("form", { name: "Details for catalog" });
  await editor.getByLabel("Name", { exact: true }).fill("Catalog tools");
  await editor.getByRole("button", { name: "Save details" }).click();
  await expect(editor).toHaveCount(0);
  await expect(row).toContainText("Catalog tools");
  result = await (await daemon.request("/api/keys")).json();
  const after = result.keys.find((k: { id: string }) => k.id === "catalog");
  expect(after.hosts).toEqual(before.hosts);
  expect(after.header).toBe(before.header);
  expect(after.metadata.label).toBe("Catalog tools");
  expect(JSON.stringify(result)).not.toContain(VALUE);
  await row.scrollIntoViewIfNeeded();
  await expect(sheet).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "e2e/out/service-keys-desktop.png" });
  await closeSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Keys", exact: true }).click();
  await expect(row).toHaveCount(1);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  await page.screenshot({ path: "e2e/out/service-keys-phone.png" });
  // Buttons intentionally extend their invisible touch targets into the sheet padding.
  // Check the actual phone sheet and visible controls, not those hit-target pseudo-elements.
  expect(await settingsSheet(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
    true,
  );
  const removeBounds = await sheet.getByRole("button", { name: "Remove catalog" }).boundingBox();
  expect(removeBounds && removeBounds.x >= 0 && removeBounds.x + removeBounds.width <= 390).toBe(
    true,
  );
  await sheet.getByRole("button", { name: "Remove catalog" }).click();
  await sheet.getByRole("button", { name: "Confirm remove catalog" }).click();
});

test("say key protection is off when keyd stops", async ({ page }) => {
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page.getByTestId("keys-button")).toHaveAccessibleName(/^Keys/);
  await daemon.keyd.stop();
  await expect(page.getByTestId("keys-button")).toHaveAccessibleName("Key protection off", {
    timeout: 15_000,
  });
  await page.getByTestId("keys-button").click();
  const sheet = nestedKeys(page);
  await expect(sheet.getByText("Keys can't be saved or used until it's back on.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save key" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(sheet.getByLabel("Key", { exact: true })).toHaveAttribute("readonly", "");
  await expect(sheet).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "e2e/out/keys-offline.png" });
});
