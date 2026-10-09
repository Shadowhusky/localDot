import { expect, test } from "@playwright/test";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { search } from "./settings-ui.ts";

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
  await expect(page.getByTestId("keys-button")).toHaveText("Keys");
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("No keys yet")).toBeVisible();

  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  await page.keyboard.press("Escape");
  await sheet.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("keys-button")).toBeFocused();
  await page.getByTestId("keys-button").click();
  await expect(sheet.getByLabel("Key", { exact: true })).toHaveValue("");

  await sheet.getByRole("radio", { name: "Web API" }).click();
  await sheet.getByLabel("Label (optional)", { exact: true }).fill("weather");
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
    await expect(sheet.getByLabel("Label (optional)", { exact: true })).toHaveAttribute(
      "readonly",
      "",
    );
  } finally {
    release.resolve();
  }
  await expect(sheet.getByRole("form", { name: "Add a key" }).getByRole("status")).toHaveText(
    "Saved weather.",
  );
  await expect(sheet.getByLabel("Key", { exact: true })).toHaveValue("");
  await expect(sheet.locator(".keys-row[data-id='weather']")).toContainText(
    "api.weather.example, Added",
  );
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
  await sheet.getByRole("radio", { name: "Model provider" }).click();
  await search(page, sheet.getByRole("combobox", { name: "Provider" }), "openai-compatible");
  await sheet.getByLabel("Label (optional)", { exact: true }).fill("books");
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
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("keys-button")).toBeFocused();
});

test("keeps the sheet usable at 375px with a long key name and reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys" });
  const id = "a".repeat(64);
  await sheet.getByLabel("Label (optional)", { exact: true }).fill(id);
  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("form", { name: "Add a key" }).getByRole("status")).toHaveText(
    `Saved ${id}.`,
  );
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

test("say key protection is off when keyd stops", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page.getByTestId("keys-button")).toHaveText("Keys");
  await daemon.keyd.stop();
  await expect(page.getByTestId("keys-button")).toHaveText("Key protection off", {
    timeout: 15_000,
  });
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys" });
  await expect(sheet.getByText("Keys can't be saved or used until it's back on.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save key" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(sheet.getByLabel("Key", { exact: true })).toHaveAttribute("readonly", "");
  await expect(sheet).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "e2e/out/keys-offline.png" });
});
