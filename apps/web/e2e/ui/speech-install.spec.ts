import type { Page, TestInfo } from "@playwright/test";
import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

// One-click speech on the computer: the optional setup step and Settings, in every stage the
// computer can be in, in light and dark, on wide screens and phones.
runAt("c14", "w14", "c39", "w39");

const MB = 1024 ** 2;

for (const [scheme, appearance] of [
  ["light", "daylight"],
  ["dark", "midnight"],
] as const) {
  test.describe(`in ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (name) => localStorage.setItem("localdot.appearance.v1", name),
        appearance,
      );
    });

    const shot = (page: Page, info: TestInfo, name: string) =>
      page.screenshot({ path: info.outputPath(`${name}-${scheme}.png`) });

    test("setup's Talk to dot: preselected, skippable, and it downloads only when pressed", async ({
      page,
      ui,
    }, info) => {
      await page.addInitScript(() =>
        localStorage.setItem("localdot.onboarding.v1", JSON.stringify({ step: "speech" })),
      );
      const fixture = await ui.open("first-run");
      const started: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/api/voice/install"))
          started.push(request.url());
      });
      await expect(page.getByRole("heading", { name: "Talk to dot" })).toBeVisible();
      const balanced = page.getByRole("radio", { name: /^Balanced/ });
      await expect(balanced).toBeChecked();
      await expect(page.getByRole("button", { name: "Skip for now" })).toBeVisible();
      await expect(page.getByText(/Tight on this computer's 8 GB/)).toBeVisible();
      if (page.viewportSize()?.width === 390)
        await expect(page.getByText(/Your Mac does the download, not this phone/)).toBeVisible();
      await ui.settle();
      await shot(page, info, "setup-choose");
      expect(started).toEqual([]);

      await page.getByRole("button", { name: "Skip for now" }).click();
      await expect(page.getByRole("heading", { name: "You're all set." })).toBeVisible();
      expect(started).toEqual([]);
      await expect(page.getByRole("button", { name: "Change talk to dot" })).toBeVisible();
      const row = page.locator(".ui-group-row", { hasText: "Talk to dot" });
      await expect(row).toContainText("Not set up");

      await page.getByRole("button", { name: "Change talk to dot" }).click();
      await expect(page.getByRole("heading", { name: "Talk to dot" })).toBeVisible();
      await page.getByRole("button", { name: "Download and continue" }).click();
      await expect(page.getByRole("heading", { name: "You're all set." })).toBeVisible();
      expect(started).toHaveLength(1);

      // The download carries on while setup finishes, and shows on the summary.
      const moved = await page.request.post(`${fixture.origin}/__qa/speech`, {
        data: { job: { stage: "model", doneBytes: 75 * MB } },
      });
      expect(moved.ok()).toBe(true);
      await expect(row).toContainText("Balanced, 50%");
      await ui.settle();
      await shot(page, info, "setup-summary");
    });

    test("Settings: install, every stage, failure and Retry, then installed and removed", async ({
      page,
      ui,
    }, info) => {
      const fixture = await ui.open("ready");
      const set = async (data: unknown) => {
        const moved = await page.request.post(`${fixture.origin}/__qa/speech`, { data });
        expect(moved.ok()).toBe(true);
      };
      await openSettings(page, undefined, "Voice");
      await expect(page.getByText("Speech model on your Mac")).toBeVisible();
      await expect(page.getByRole("radio", { name: /^Balanced/ })).toBeChecked();
      await ui.settle();
      await shot(page, info, "settings-offer");

      await page.getByRole("button", { name: /Install Balanced/ }).click();
      await expect(page.getByText("Installing Balanced on your Mac…")).toBeVisible();
      await expect(page.getByRole("radiogroup", { name: "Speech model" })).toHaveCount(0);

      for (const [stage, doneBytes] of [
        ["program", 8 * MB],
        ["model", 75 * MB],
        ["unpacking", 150 * MB],
        ["testing", 150 * MB],
      ] as const) {
        await set({ job: { stage, doneBytes } });
        const steps = page.getByRole("list", { name: "Install steps" });
        const names = {
          program: "Download the speech program",
          model: "Download the speech model",
          unpacking: "Check and unpack the files",
          testing: "Try it once",
        };
        await expect(steps.getByRole("listitem").filter({ hasText: names[stage] })).toHaveAttribute(
          "data-state",
          "doing",
          { timeout: 4000 },
        );
        if (stage === "model") await expect(page.getByText("75 MB of 150 MB")).toBeVisible();
        await ui.settle();
        await shot(page, info, `settings-${stage}`);
      }

      await set({
        job: {
          state: "failed",
          stage: "model",
          problem: "network",
          doneBytes: 75 * MB,
          message:
            "The speech model couldn't be downloaded. Check your connection, then Retry. What came through is kept.",
        },
      });
      await expect(page.getByRole("alert").getByText(/Check your connection/)).toBeVisible({
        timeout: 4000,
      });
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await ui.settle();
      await shot(page, info, "settings-failed");

      // A reload, or a second device, finds the same place.
      await page.reload();
      await openSettings(page, undefined, "Voice");
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

      await set({
        job: null,
        using: "installed",
        installed: { tier: "balanced", name: "Balanced", diskBytes: 197 * MB, damaged: false },
      });
      await page.reload();
      await openSettings(page, undefined, "Voice");
      await expect(page.getByText(/Installed by localDot · 197 MB/)).toBeVisible();
      await expect(page.getByText("On your Mac", { exact: true }).last()).toBeVisible();
      await ui.settle();
      await shot(page, info, "settings-installed");

      await page.getByRole("button", { name: "Remove" }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: "Remove" }).click();
      await expect(page.getByText("Not installed")).toBeVisible();
      await expect(page.getByRole("radiogroup", { name: "Speech model" })).toBeVisible();
    });

    test("Settings keeps a hand-installed Whisper as it is", async ({ page, ui }, info) => {
      const fixture = await ui.open("ready");
      await page.request.post(`${fixture.origin}/__qa/speech`, {
        data: {
          handInstalled: { model: "ggml-base.bin", englishOnly: false },
          using: "hand-installed",
        },
      });
      await openSettings(page, undefined, "Voice");
      await expect(page.getByText("Your own Whisper")).toBeVisible();
      await expect(page.getByText(/never changes or removes it/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
      await ui.settle();
      await shot(page, info, "settings-hand-installed");
    });

    test("setup passes over the step when speech is already here", async ({ page, ui }) => {
      await page.addInitScript(() =>
        localStorage.setItem("localdot.onboarding.v1", JSON.stringify({ step: "view" })),
      );
      const fixture = await ui.open("first-run");
      await expect(page.getByRole("heading", { name: /see dot/ })).toBeVisible();
      await page.request.post(`${fixture.origin}/__qa/speech`, {
        data: {
          handInstalled: { model: "ggml-base.bin", englishOnly: false },
          using: "hand-installed",
        },
      });
      await page.reload();
      await expect(page.getByRole("heading", { name: /see dot/ })).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { name: /web browser/ })).toBeVisible();
      await page.getByRole("button", { name: /continue/i }).click();
      await expect(page.getByRole("heading", { name: "You're all set." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Talk to dot" })).toHaveCount(0);
    });
  });
}

test("a Linux computer isn't called a Mac, and a system with no program skips the step", async ({
  page,
  ui,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("localdot.onboarding.v1", JSON.stringify({ step: "speech" })),
  );
  const fixture = await ui.open("first-run");
  await expect(page.getByRole("heading", { name: "Talk to dot" })).toBeVisible();
  await page.request.post(`${fixture.origin}/__qa/speech`, {
    data: { host: { computer: "computer", memoryBytes: 8 * 1024 ** 3, cpus: 4, arch: "x64" } },
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Talk to dot" })).toBeVisible();
  await expect(page.getByText(/turn into text on your computer/)).toBeVisible();
  await expect(page.getByText(/on your Mac/)).toHaveCount(0);
});

test("a shared link's guest gets no speech install", async ({ page, ui }) => {
  const fixture = await ui.open("ready");
  const status = await page.request.get(`${fixture.origin}/api/voice/install`, {
    headers: { authorization: `Bearer ${"g".repeat(43)}` },
  });
  expect(status.status()).toBe(401);
});
