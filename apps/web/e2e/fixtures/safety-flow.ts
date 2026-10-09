import { expect, type Page } from "@playwright/test";
import { saveFixtureModel, search } from "../settings-ui.ts";
import type { assembledProcess } from "./assembled-process.ts";

export type Assembly = Awaited<ReturnType<typeof assembledProcess>>;
export async function showPane(page: Page, name: string) {
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}(?:,|$)`) });
  if (await tab.isVisible()) await tab.click();
}
export function fixtureRequest(page: Page, f: Assembly) {
  const origin = new URL(f.url).origin;
  const headers = {
    authorization: `Bearer ${new URL(f.url).hash.slice("#token=".length)}`,
    origin,
  };
  return (path: string, method = "GET", data?: unknown) =>
    page.request.fetch(origin + path, { method, headers, ...(data === undefined ? {} : { data }) });
}
export async function startSafetyTask(page: Page, f: Assembly) {
  await page.goto(f.url);
  await page.getByTestId("keys-button").click();
  const keys = page.getByRole("dialog", { name: "Keys", exact: true });
  await keys.getByLabel("Label (optional)", { exact: true }).fill("fixture");
  await search(page, keys.getByRole("combobox", { name: "Provider" }), "openai-compatible");
  await keys.getByLabel("Base URL", { exact: true }).fill("https://provider.example.test/v1");
  await keys.getByLabel("Key", { exact: true }).fill("task15-local-canary-never-real");
  await keys.getByRole("button", { name: "Save key", exact: true }).click();
  await expect(keys).toContainText("Saved fixture.");
  await expect(keys.getByLabel("Key", { exact: true })).toHaveValue("");
  await keys.getByRole("button", { name: "Close keys", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = await saveFixtureModel(page);
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Turn on", exact: true }).first().click();
  await showPane(page, "Conversation");
  const task = page.getByRole("textbox", { name: "New task", exact: true });
  await expect(task).toBeEnabled({ timeout: 120000 });
  await task.fill("task14 assembled synthetic safety acceptance: local samples only.");
  const started = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /^\/api\/cells\/[^/]+\/agent$/.test(new URL(r.url()).pathname),
  );
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  const reply = await started;
  expect(reply.status()).toBe(202);
  return (await reply.json()).sessionId as string;
}
export async function approveCurrent(page: Page, f: Assembly) {
  const card = page.locator(".decision");
  const button = card.locator('.decision-actions [data-variant="primary"]');
  // A real pointer returns focus to this panel after the desktop iframe takes it.
  await card.getByRole("heading").click();
  await expect(button).not.toHaveAttribute("aria-disabled", { timeout: 30000 });
  const label = await card.getAttribute("aria-labelledby");
  expect(label).toMatch(/^approval-.+/);
  const approvalId = label?.slice("approval-".length);
  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/approvals/answer"),
  );
  await button.click();
  const request = await sent;
  expect(request.postDataJSON()).toMatchObject({ approvalId, decision: "approve" });
  const owner = /\/sessions\/([^/]+)\/approvals\/answer$/.exec(
    new URL(request.url()).pathname,
  )?.[1];
  expect(owner).toBeTruthy();
  // The new feed epoch can abort this fetch after the server commits the decision.
  // Observe that exact owner's durable resolution before admitting the next card.
  await expect
    .poll(async () =>
      (await f.state(owner)).some(
        (s) =>
          s.sessionId === owner &&
          s.events.some(
            (e) =>
              e.type === "approval.resolve" &&
              e.data.approvalId === approvalId &&
              e.data.decision === "approve" &&
              e.data.by === "user",
          ),
      ),
    )
    .toBe(true);
  await expect(page.locator(`.decision[aria-labelledby="${label}"]`)).toHaveCount(0);
}
export async function answerTable(page: Page) {
  await showPane(page, "Conversation");
  await expect(
    page.getByText("Which synthetic table should I export?", { exact: true }).first(),
  ).toBeVisible({ timeout: 30000 });
  await page.getByText("The sample table", { exact: true }).click();
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await showPane(page, "Computer");
}
