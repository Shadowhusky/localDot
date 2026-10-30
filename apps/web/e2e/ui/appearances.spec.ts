import type { Page } from "@playwright/test";
import { SECTIONS } from "../../src/settings/sections.ts";
import { closeSettings, openSettings } from "../settings-ui.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// Every main view in each appearance, and System under both schemes of the device. The shots are
// for looking at (no baselines); the spec checks that the page is in the right appearance from its
// first frame and that System follows the device without a reload.
runAt("c14", "c39", "w39");

const CASES = [
  { name: "daylight", choice: "daylight", scheme: "dark", shows: "daylight", views: true },
  { name: "graphite", choice: "graphite", scheme: "light", shows: "graphite", views: true },
  { name: "midnight", choice: "midnight", scheme: "light", shows: "midnight", views: true },
  { name: "system-light", choice: "system", scheme: "light", shows: "daylight", views: false },
  { name: "system-dark", choice: "system", scheme: "dark", shows: "graphite", views: false },
] as const;

const WATCH = /^Watch replay \(\d+:\d\d\)$/;
const GALLERY = ["system", "dot", "stage", "overlays", "feedback", "activity"];

type Framed = Window & { firstFrame?: string };

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

// The browser chrome takes the void, and the browser's own controls the appearance's scheme.
async function chromeMatches(page: Page, scheme: "light" | "dark") {
  const chrome = await page.evaluate(() => ({
    tint: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "",
    scheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
    root: getComputedStyle(document.documentElement).colorScheme,
    void: getComputedStyle(document.body).backgroundColor,
  }));
  expect(hexToRgb(chrome.tint)).toBe(chrome.void);
  expect([chrome.scheme, chrome.root]).toEqual([scheme, scheme]);
}

for (const appearance of CASES)
  test.describe(appearance.name, () => {
    const scheme = appearance.shows === "daylight" ? "light" : "dark";
    test.use({ colorScheme: appearance.scheme });
    test.beforeEach(async ({ page }) => {
      // What the root holds on the first frame the stylesheet styles: anything else could be seen.
      await page.addInitScript((choice) => {
        localStorage.setItem("localdot.appearance.v1", choice);
        const frame = () => {
          const root = document.documentElement;
          if (root && getComputedStyle(root).getPropertyValue("--color-void"))
            (window as Framed).firstFrame = root.dataset.appearance ?? "none";
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, appearance.choice);
    });
    const shot = async (page: Page, name: string, fullPage = false) => {
      await page.waitForTimeout(150);
      await page.screenshot({
        path: test.info().outputPath(`${appearance.name}-${name}.png`),
        fullPage,
      });
    };
    const opensIn = async (page: Page) => {
      await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance.shows);
      await chromeMatches(page, scheme);
    };

    test("first run", async ({ page, ui }) => {
      await ui.open("first-run");
      await expect(page.getByRole("heading", { name: "Your computer is off" })).toBeVisible();
      expect(await page.evaluate(() => (window as Framed).firstFrame)).toBe(appearance.shows);
      await opensIn(page);
      await ui.settle();
      await shot(page, "first-run");
    });

    if (appearance.choice === "system")
      test("follows the device without a reload", async ({ page, ui }) => {
        await ui.open("ready");
        await opensIn(page);
        const other = appearance.scheme === "light" ? "dark" : "light";
        await page.emulateMedia({ colorScheme: other });
        const shown = other === "light" ? "daylight" : "graphite";
        await expect(page.locator("html")).toHaveAttribute("data-appearance", shown);
        await chromeMatches(page, other);
        await ui.settle();
        await ui.still();
        await shot(page, `then-${other}`);
      });

    if (!appearance.views) return;

    test("watch, chat and activity", async ({ page, ui }) => {
      const fixture = await ui.open("running");
      await opensIn(page);
      const handed = await page.request.post(
        `${fixture.origin}/__qa/files?count=5&recording=${fixture.seeded[0] ?? ""}`,
      );
      expect(handed.ok(), await handed.text()).toBe(true);
      const card = page.getByRole("region", { name: "Task result" }).last();
      await expect(card.getByRole("button", { name: WATCH })).toBeVisible();
      await ui.settle();
      await ui.still();
      await shot(page, "watch");
      const list = card.getByRole("list", { name: /^Files in result / });
      await list.getByRole("button", { name: "Show totals.csv" }).click();
      const revise = list.getByRole("button", { name: "Revise" });
      await revise.scrollIntoViewIfNeeded();
      // Revise sits inside its card: clear of the card's side and of the row line under it.
      const [face, row] = await Promise.all([
        revise.boundingBox(),
        list.getByRole("listitem", { name: "totals.csv" }).boundingBox(),
      ]);
      expect(face && row && face.x - row.x).toBeGreaterThanOrEqual(8);
      expect(face && row && row.y + row.height - (face.y + face.height)).toBeGreaterThanOrEqual(8);
      await shot(page, "chat-file-preview");
      await list.getByRole("button", { name: "Hide totals.csv" }).click();

      const message = page.getByRole("form", { name: "Message dot" });
      await message.getByRole("textbox", { name: "Message" }).fill("Make the chart bigger");
      await message.getByRole("button", { name: /^Model: / }).click();
      await shot(page, "composer-model-menu");
      await page.keyboard.press("Escape");
      const options = message.getByRole("button", { name: "Message options" });
      if (await options.isVisible()) {
        await options.click();
        await shot(page, "composer-options-menu");
        await page.keyboard.press("Escape");
      }

      if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
      else await page.locator(".rail-chat").getByRole("radio", { name: "Activity" }).click();
      const tabs = page.getByRole("tablist", { name: "Activity" });
      for (const tab of await tabs.getByRole("tab").all()) {
        const name = ((await tab.textContent()) ?? "").trim().split(/\s/)[0]?.toLowerCase();
        await tab.click();
        await shot(page, `activity-${name}`);
      }
      await tabs.getByRole("tab", { name: /^Files/ }).click();
      await page
        .getByRole("button", { name: /^summary\.md/ })
        .first()
        .click();
      await expect(page.locator(".diff-viewer").first()).toBeVisible();
      await shot(page, "activity-diff");
    });

    test("file viewer", async ({ page, ui }) => {
      await ui.open("image-output");
      await page.getByRole("button", { name: "Open summary.md", exact: true }).click();
      const viewer = page.getByRole("dialog", { name: "summary.md", exact: true });
      await expect(viewer.getByRole("heading", { name: "Monthly report (sample)" })).toBeVisible();
      await shot(page, "viewer-rendered");
      await viewer.getByRole("radio", { name: "Source", exact: true }).click();
      await expect(viewer.getByRole("region", { name: "Source of summary.md" })).toBeVisible();
      await shot(page, "viewer-source");
    });

    test("replay library", async ({ page, ui }) => {
      await ui.open("library", () => "/?replay=library");
      await opensIn(page);
      await expect(page.getByRole("button", { name: /^Compare the home insurance/ })).toBeVisible();
      await ui.settle();
      await shot(page, "replay-library");
      await page.getByRole("button", { name: "Select", exact: true }).click();
      await page.getByRole("button", { name: "Tidy the Downloads folder" }).first().click();
      await page.getByRole("button", { name: "Delete…" }).click();
      await expect(page.getByRole("alertdialog", { name: "Delete this recording?" })).toBeVisible();
      await shot(page, "replay-delete-dialog");
    });

    test("replay", async ({ page, ui }) => {
      await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=20000`);
      await opensIn(page);
      await expect(page.getByRole("slider", { name: "Replay timeline" })).toBeVisible();
      await ui.settle();
      await ui.still();
      await shot(page, "replay");
    });

    test("settings", async ({ page, ui }) => {
      await ui.open("ready");
      await opensIn(page);
      for (const section of SECTIONS) {
        const sheet = await openSettings(page, undefined, section.title);
        await expect(sheet).toBeVisible();
        await shot(page, `settings-${section.id}`);
        await closeSettings(page);
      }
    });

    test("decision", async ({ page, ui }) => {
      await ui.open("approval");
      await opensIn(page);
      const decision = page.getByRole("dialog", { name: "Send this email?" });
      await expect(decision.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
      await page.waitForTimeout(400);
      await ui.settle();
      await ui.still();
      await shot(page, "decision");
    });

    test("shared link", async ({ page, ui }) => {
      await page.route("**/api/whoami", (route) =>
        route.fulfill({ json: { ok: true, shared: true } }),
      );
      await page.route("**/api/remote-session", (route) =>
        route.fulfill({
          json: {
            id: "fixture",
            label: "Guest",
            model: { provider: "openai", model: "gpt-6.1-sol" },
            models: [],
            tasks: 0,
            maxTasks: 5,
            taskBudgetUSD: 2,
            expiresAt: null,
            settings: false,
            replay: false,
            chooseModel: false,
            ownedSessions: [],
          },
        }),
      );
      await ui.open("ready");
      await expect(page.getByRole("main")).toHaveClass("shared-app");
      await opensIn(page);
      await ui.settle();
      await shot(page, "shared-link");
    });

    test("gallery", async ({ page, ui }) => {
      for (const id of GALLERY) {
        await ui.gallery(id);
        await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance.shows);
        await page.clock.runFor(1000);
        await shot(page, `gallery-${id}`, true);
      }
    });
  });
