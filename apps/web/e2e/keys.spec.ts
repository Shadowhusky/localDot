import { expect, test } from "@playwright/test";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

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
  await expect(sheet.getByText("No keys yet.")).toBeVisible();
  // The underlying computer cannot receive focus or input while keys are open.
  const start = page.getByRole("button", { name: "Turn on", includeHidden: true }).first();
  await start.evaluate((button: HTMLButtonElement) => button.focus());
  await expect(start).not.toBeFocused();

  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("keys-button")).toBeFocused();
  await page.getByTestId("keys-button").click();
  await expect(sheet.getByLabel("Key", { exact: true })).toHaveValue("");

  await sheet.getByRole("button", { name: "Web API" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("weather");
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
    await expect(sheet.getByLabel("Name", { exact: true })).toBeDisabled();
    await sheet.getByRole("button", { name: "Close keys" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(sheet.getByRole("button", { name: "Close keys" })).toBeFocused();
  } finally {
    release.resolve();
  }
  await expect(sheet.getByRole("status")).toHaveText("Saved weather.");
  await expect(sheet.getByLabel("Key", { exact: true })).toHaveValue("");
  await expect(sheet.getByText("api.weather.example · Authorization")).toBeVisible();
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
  await sheet.getByRole("button", { name: "Model provider" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("books");
  await sheet.getByLabel("Provider").selectOption("openai-compatible");
  await sheet.getByLabel("Base URL").fill("https://bücher.example/openai/v1");
  await sheet.getByLabel("Key", { exact: true }).fill(`${VALUE}-2`);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Saved books.");
  await expect(sheet.getByText("OpenAI-compatible · xn--bcher-kva.example")).toBeVisible();
  expect(posted).toHaveLength(2);
  expect(posted[1]).not.toContain(VALUE);
  await sheet.getByRole("button", { name: "Delete books" }).click();
  await sheet.getByRole("button", { name: "Confirm deleting books" }).click();

  await sheet.getByRole("button", { name: "Delete weather" }).click();
  await sheet.getByRole("button", { name: "Confirm deleting weather" }).click();
  await expect(sheet.getByText("No keys yet.")).toBeVisible();
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
  await sheet.getByLabel("Name", { exact: true }).fill(id);
  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("status")).toHaveText(`Saved ${id}.`);
  await expect(sheet).toHaveCSS("transform", "none");
  const bounds = await sheet.boundingBox();
  expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375).toBe(true);
  expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const remove = sheet.getByRole("button", { name: `Delete ${id}` });
  const removeBounds = await remove.boundingBox();
  expect(removeBounds && removeBounds.x >= 0 && removeBounds.x + removeBounds.width <= 375).toBe(
    true,
  );
  await page.screenshot({ path: "e2e/out/keys-narrow.png" });
  await remove.click();
  await sheet.getByRole("button", { name: `Confirm deleting ${id}` }).click();
  await expect(sheet.getByText("No keys yet.")).toBeVisible();
});

test("say the key layer is offline when keyd stops", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page.getByTestId("keys-button")).toHaveText("Keys");
  await daemon.keyd.stop();
  await expect(page.getByTestId("keys-button")).toHaveText("Key layer offline", {
    timeout: 15_000,
  });
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys" });
  await expect(sheet.getByRole("alert")).toContainText("The key layer is offline");
  await expect(sheet.getByRole("button", { name: "Save key" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Close keys" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "Close keys" })).toBeFocused();
  await expect(sheet).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "e2e/out/keys-offline.png" });
});
