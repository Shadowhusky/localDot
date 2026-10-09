import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { assembledProcess } from "./fixtures/assembled-process.ts";
import { approveCurrent } from "./fixtures/safety-flow.ts";
import { roleCard, saveFixtureModel, search } from "./settings-ui.ts";

// Real daemon routes, keyd, Docker desktop/brain and browser UI; only the model script is synthetic.
test("approval card, atomic Pause, matching Resume and in-dialog Stop remain honest", async ({
  page,
}, info) => {
  const f = await assembledProcess(info, { pending: "shell" });
  const errors: string[] = [],
    answers: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/approvals/answer"))
      answers.push(JSON.parse(request.postData() ?? "null"));
  });
  const approvalLayout = async () => {
    const layout = await page.locator(".approval-card").evaluate((card) => {
      const overlay = card.parentElement as HTMLElement;
      const workspace = document.querySelector(".house") as HTMLElement;
      const withApproval = workspace.getBoundingClientRect();
      const display = overlay.style.display;
      overlay.style.display = "none";
      const withoutApproval = workspace.getBoundingClientRect();
      overlay.style.display = display;
      const buttons = [...card.querySelectorAll(".safety-actions button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      });
      const content = card.querySelector(".approval-content") as HTMLElement;
      return {
        workspaceWithApproval: { top: withApproval.top, height: withApproval.height },
        workspaceWithoutApproval: { top: withoutApproval.top, height: withoutApproval.height },
        buttons,
        viewport: { width: innerWidth, height: innerHeight },
        contentScrolls: content.scrollHeight > content.clientHeight,
      };
    });
    expect(layout.workspaceWithApproval).toEqual(layout.workspaceWithoutApproval);
    expect(layout.buttons).toHaveLength(3);
    for (const button of layout.buttons) {
      expect(button.top).toBeGreaterThanOrEqual(0);
      expect(button.bottom).toBeLessThanOrEqual(layout.viewport.height);
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(layout.viewport.width);
    }
    return layout;
  };
  const showPane = async (name: string) => {
    const tab = page.getByRole("tab", { name: new RegExp(`^${name}(?:,|$)`) });
    if (await tab.isVisible()) await tab.click();
  };
  try {
    await page.goto(f.url);
    await page.getByTestId("keys-button").click();
    const keys = page.getByRole("dialog", { name: "Keys", exact: true });
    await keys.getByLabel("Label (optional)", { exact: true }).fill("fixture");
    await search(page, keys.getByRole("combobox", { name: "Provider" }), "openai-compatible");
    await keys.getByLabel("Base URL", { exact: true }).fill("https://provider.example.test/v1");
    await keys.getByLabel("Key", { exact: true }).fill("task15-local-canary-never-real");
    await keys.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(keys).toContainText("Saved fixture.");
    await keys.getByRole("button", { name: "Close keys", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = await saveFixtureModel(page);
    await expect(
      settings
        .getByRole("radiogroup", { name: "Send as you" })
        .getByRole("radio", { name: "Ask me" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: info.outputPath("safety-settings.png"), fullPage: true });
    await settings.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Turn on", exact: true }).first().click();
    await showPane("Conversation");
    const task = page.getByRole("textbox", { name: "New task", exact: true });
    await expect(task).toBeEnabled({ timeout: 120000 });
    await task.fill("task14 assembled synthetic acceptance: local table and fake sign-in only.");
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    const card = page.locator(".approval-card");
    await expect(card).toBeVisible({ timeout: 30000 });
    await expect(card.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
    expect((await f.state())[0]?.provider).toHaveLength(2);
    const normalApprovalLayout = await approvalLayout();
    await page.screenshot({ path: info.outputPath("safety-approval.png"), fullPage: false });
    const originalViewport = page.viewportSize();
    if (!originalViewport) throw new Error("The approval layout needs a bounded viewport.");
    await page.setViewportSize({ ...originalViewport, height: 400 });
    const shortApprovalLayout = await approvalLayout();
    expect(shortApprovalLayout.contentScrolls).toBe(true);
    await card.locator(".approval-content").evaluate((content) => {
      content.scrollTop = content.scrollHeight;
    });
    await approvalLayout();
    await page.setViewportSize(originalViewport);
    await card.locator(".approval-content").evaluate((content) => {
      content.scrollTop = 0;
    });
    await approvalLayout();
    await approveCurrent(page, f); // synthetic HTML write
    await expect.poll(() => answers.length).toBe(1);
    await approveCurrent(page, f); // local browser launch
    await expect.poll(() => answers.length).toBe(2);
    await expect(
      page.getByText("Which synthetic table should I export?", { exact: true }).first(),
    ).toBeVisible({ timeout: 30000 });
    await page.getByText("The sample table", { exact: true }).click();
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await showPane("Computer");
    const take = page.getByRole("button", { name: "Take control", exact: true });
    await expect(take).toBeEnabled({ timeout: 30000 });
    await take.click();
    const handBack = page.getByRole("button", { name: "Hand back", exact: true });
    await expect(handBack).toBeEnabled();
    await handBack.click();
    const last = page.locator(".approval-card");
    await expect(last).toBeVisible({ timeout: 30000 });
    await last.getByRole("button", { name: "Approve once", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await f.state())[0]?.events.some(
            (e) => e.type === "tool.output" && String(e.data.chunk).includes("task14 waiting"),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Pause after this step", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Pause after this step", exact: true }).click();
    await expect(
      page.getByText(
        "Pausing after the current step. Its output can finish; the next step is held.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toBeDisabled();
    await expect.poll(async () => (await f.state())[0]?.provider.length).toBe(7);
    await expect(
      page.getByText("Paused at the next step. Your task and files are retained.", { exact: true }),
    ).toBeVisible({ timeout: 45000 });
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath("safety-paused.png"), fullPage: true });
    await page.reload();
    await showPane("Computer");
    await expect(page.locator("iframe.desktop-frame")).toHaveCount(1);
    await page
      .locator("iframe.desktop-frame")
      .evaluate((frame: HTMLIFrameElement) => frame.contentWindow?.focus());
    const resume = page.getByRole("button", { name: "Resume task", exact: true });
    await expect(resume).toBeVisible();
    await expect(resume).toBeDisabled();
    const box = await resume.boundingBox();
    if (!box) throw new Error("The Resume button is outside the panel.");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(resume).toBeEnabled();
    const resumeRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        /\/api\/agent\/sessions\/[^/]+\/resume$/.test(new URL(request.url()).pathname),
    );
    await page.mouse.up();
    const matchingResume = (await resumeRequest).postDataJSON();
    expect(matchingResume).toMatchObject({ revision: 1 });
    expect(matchingResume.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(page.locator(".approval-card")).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings).toBeVisible();
    await expect(page.locator(".approval-card")).toBeHidden();
    await roleCard(settings, "main").getByRole("combobox", { name: "Model", exact: true }).focus();
    const stop = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/sessions\/[^/]+\/stop$/.test(new URL(response.url()).pathname),
    );
    await page.keyboard.press("Control+Shift+.");
    const reply = await stop;
    expect(reply.status()).toBe(202);
    const outcome = await reply.json();
    expect(outcome.revoked).toBe(true);
    expect(outcome.paused || (outcome.closed && outcome.stopped)).toBe(true);
    await expect(settings).toContainText("paused");
    expect(errors).toEqual([]);
    expect(answers).toHaveLength(3);
    writeFileSync(
      info.outputPath("safety-ui-proof.json"),
      JSON.stringify(
        {
          project: info.project.name,
          normalApprovalLayout,
          shortApprovalLayout,
          exactApprovalRequests: answers.length,
          pausedAtBoundary: true,
          resumedExplicitly: true,
          viewerFocusPointerRecovery: true,
          matchingResume,
          stopChordInsideSettings: true,
          stopOutcome: outcome,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await f.close();
  }
});
