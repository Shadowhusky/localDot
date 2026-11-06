import type { Page } from "@playwright/test";
import {
  otherView,
  switchViewLabel,
  VIEW_NAMES,
  VIEW_STYLE_KEY,
  VIEW_STYLES,
  VIEWS_TRIED_KEY,
} from "../../src/shell/view-style.ts";
import { closeSettings, openSettings } from "../settings-ui.ts";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

const app = (page: Page) => page.locator(".app");
const stack = (page: Page) => page.locator(".phone-stack");
const field = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });
const more = (page: Page) => page.getByRole("button", { name: "More", exact: true }).first();

test.describe("with nothing chosen on this device", () => {
  test.use({ viewStyle: null, phoneList: true });

  test("a phone has Chat and anything else Studio", async ({ page, ui }) => {
    runAtOnly("c39", "c14", "w14");
    await ui.open("done");
    await expect(app(page)).toHaveAttribute("data-view", isPhone(page) ? "chat" : "studio");
  });

  test("a desktop window as narrow as a phone stays Studio", async ({ page, ui }) => {
    runAtOnly("c14");
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open("done");
    await expect(app(page)).toHaveAttribute("data-view", "studio");
  });
});

function runAtOnly(...projects: string[]) {
  test.skip(!projects.includes(test.info().project.name), `Runs at ${projects.join(" and ")}`);
}

test.describe("on a phone", () => {
  runAt("c39", "w39");

  test.describe("in Chat", () => {
    test.use({ viewStyle: "chat" });

    test("the ⋯ menu moves to Studio and back, keeping the task, the draft and the choice", async ({
      page,
      ui,
    }) => {
      await ui.open("done");
      await expect(stack(page)).toHaveAttribute("data-level", "1");
      await field(page).fill("Keep this draft");
      const said = await page.locator(".thread-message").first().innerText();
      await more(page).click();
      await page.getByRole("menuitem", { name: "Switch to Studio view" }).click();
      await expect(app(page)).toHaveAttribute("data-view", "studio");
      await expect(stack(page)).toHaveCount(0);
      await expect(page.locator(".stage-col")).toBeVisible();
      await expect(field(page)).toHaveValue("Keep this draft");
      await expect(page.locator(".thread-message").first()).toContainText(
        said.split("\n")[0] ?? "",
      );
      expect(await page.evaluate(() => window.location.hash)).toBe("");
      await page.screenshot({ path: test.info().outputPath("studio-on-phone.png") });

      await page.reload();
      await expect(app(page)).toHaveAttribute("data-view", "studio");

      await more(page).click();
      await page.getByRole("menuitem", { name: "Switch to Chat view" }).click();
      await expect(app(page)).toHaveAttribute("data-view", "chat");
      await expect(stack(page)).toHaveAttribute("data-level", "1");
      await expect(field(page)).toHaveValue("Keep this draft");
      await ui.settle();
      await page.screenshot({ path: test.info().outputPath("chat-on-phone.png") });
      await page.goBack();
      await expect(stack(page)).toHaveAttribute("data-level", "0");
    });

    test("the computer pill over the list moves to Studio too", async ({ page, ui }) => {
      await ui.open("done");
      await page.getByRole("button", { name: "Back to conversations" }).click();
      await page.getByRole("button", { name: /this computer and app settings$/ }).click();
      await page.getByRole("menuitem", { name: "Switch to Studio view" }).click();
      await expect(app(page)).toHaveAttribute("data-view", "studio");
    });
  });
});

test.describe("on a wider screen", () => {
  runAt("c14", "w14");

  test("Studio's More moves to Chat, with the list beside the conversation", async ({
    page,
    ui,
  }) => {
    await ui.open("done");
    await expect(app(page)).not.toHaveAttribute("data-entering");
    await more(page).click();
    await page.getByRole("menuitem", { name: "Switch to Chat view" }).click();
    await expect(stack(page)).toHaveAttribute("data-split");
    await expect(page.locator(".phone-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to conversations" })).toHaveCount(0);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath("chat-wide.png") });
    const thread = await page.locator(".phone-thread .thread-message").first().boundingBox();
    const chat = await page.locator(".phone-chat").boundingBox();
    if (!thread || !chat) throw new Error("Nothing to measure");
    expect(thread.width).toBeLessThanOrEqual(760);
    expect(Math.abs(thread.x + thread.width / 2 - (chat.x + chat.width / 2))).toBeLessThan(40);

    await more(page).click();
    await page.getByRole("menuitem", { name: "Switch to Studio view" }).click();
    await expect(app(page)).toHaveAttribute("data-view", "studio");
    await expect(page.locator(".stage-col")).toBeVisible();
  });

  test("the command palette switches", async ({ page, ui }) => {
    await ui.open("done");
    await expect(app(page)).not.toHaveAttribute("data-entering");
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Search actions" });
    await palette.getByRole("combobox").fill("chat view");
    await palette.getByText("Switch to Chat view").click();
    await expect(app(page)).toHaveAttribute("data-view", "chat");
  });

  test("Settings sets it beside the theme, for this device", async ({ page, ui }) => {
    await ui.open("done");
    const sheet = await openSettings(page, undefined, "Appearance");
    const view = sheet.getByRole("radiogroup", { name: "View" });
    await expect(view.getByRole("radio", { name: /^Studio/ })).toBeChecked();
    await ui.settle();
    await sheet.screenshot({ path: test.info().outputPath("settings.png") });
    await view.getByRole("radio", { name: /^Chat/ }).check({ force: true });
    await expect(app(page)).toHaveAttribute("data-view", "chat");
    expect(await page.evaluate((key) => localStorage.getItem(key), VIEW_STYLE_KEY)).toBe("chat");
  });
});

test.describe("the task and the draft stay", () => {
  runAt("c14", "c39", "w14", "w39");
  for (const from of VIEW_STYLES) {
    const to = otherView(from);
    const named = new RegExp(`^${VIEW_NAMES[to]}`);

    test.describe(`from ${VIEW_NAMES[from]}`, () => {
      test.use({ viewStyle: from });

      const start = async (page: Page, ui: Harness) => {
        await ui.open("done");
        await expect(app(page)).not.toHaveAttribute("data-entering");
        await field(page).fill("Keep this draft");
        return (await page.locator(".thread-message").first().innerText()).split("\n")[0] ?? "";
      };
      const kept = async (page: Page, said: string) => {
        await expect(app(page)).toHaveAttribute("data-view", to);
        await expect(field(page)).toHaveValue("Keep this draft");
        await expect(page.locator(".thread-message").first()).toContainText(said);
      };

      test("from More", async ({ page, ui }) => {
        const said = await start(page, ui);
        await more(page).click();
        await page.getByRole("menuitem", { name: switchViewLabel(from) }).click();
        await kept(page, said);
      });

      test("from Settings, once it closes", async ({ page, ui }) => {
        const said = await start(page, ui);
        const sheet = await openSettings(page, undefined, "Appearance");
        await sheet
          .getByRole("radiogroup", { name: "View" })
          .getByRole("radio", { name: named })
          .check({ force: true });
        await expect(app(page)).toHaveAttribute("data-view", to);
        await closeSettings(page);
        await kept(page, said);
      });

      test("from the command palette", async ({ page, ui }) => {
        test.skip(isPhone(page), "A phone has no ⌘K");
        const said = await start(page, ui);
        await page.keyboard.press("ControlOrMeta+k");
        const palette = page.getByRole("dialog", { name: "Search actions" });
        await palette.getByRole("combobox").fill(`${VIEW_NAMES[to]} view`);
        await palette.getByText(switchViewLabel(from)).click();
        await kept(page, said);
      });
    });
  }
});

test.describe("the change itself", () => {
  runAt("c14");
  const counting = (page: Page) =>
    page.addInitScript(() => {
      const start = document.startViewTransition?.bind(document);
      if (!start) return;
      const held = window as { fades?: number };
      held.fades = 0;
      document.startViewTransition = ((update: () => void) => {
        held.fades = (held.fades ?? 0) + 1;
        return start(update);
      }) as typeof document.startViewTransition;
    });
  const switchOnce = async (page: Page) => {
    await more(page).click();
    await page.getByRole("menuitem", { name: "Switch to Chat view" }).click();
    await expect(app(page)).toHaveAttribute("data-view", "chat");
    return page.evaluate(() => (window as { fades?: number }).fades);
  };

  test("is a fade", async ({ page, ui }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await counting(page);
    await ui.open("done");
    expect(await switchOnce(page)).toBe(1);
  });

  test("is at once with reduced motion", async ({ page, ui }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await counting(page);
    await ui.open("done");
    expect(await switchOnce(page)).toBe(0);
  });
});

test.describe("dot's line", () => {
  runAt("c39", "c14");
  const tipFirst = (page: Page) =>
    page.addInitScript(() => {
      const others = [
        "take-control",
        "routine",
        "passwords",
        "full-screen",
        "replay-export",
        "files",
        "stop-key",
        "memory",
        "purpose-check",
        "showcase",
        "slash",
        "stop-everything",
        "phone",
        "open-at-login",
        "setup",
        "start-fresh",
        "update",
      ];
      localStorage.setItem("localdot.tips.v1", JSON.stringify(others));
    });

  test("suggests the other style at rest, switches on the spot, then stops", async ({
    page,
    ui,
  }) => {
    test.setTimeout(90_000);
    await tipFirst(page);
    await ui.open("done");
    const line = page.getByText("Prefer texting me? Try Chat view.");
    await expect(line).toBeVisible({ timeout: 45_000 });
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath("tip.png") });
    await page.getByRole("button", { name: "Try it" }).click();
    await expect(app(page)).toHaveAttribute("data-view", "chat");
    expect(await page.evaluate((key) => localStorage.getItem(key), VIEWS_TRIED_KEY)).toBe("on");
  });

  test.describe("in Chat", () => {
    test.use({ viewStyle: "chat" });
    test("shows it at the foot of the thread", async ({ page, ui }) => {
      test.setTimeout(90_000);
      await tipFirst(page);
      await ui.open("done");
      const line = page.locator(".dot-strip").getByText(/Try Studio view\./);
      await expect(line).toBeVisible({ timeout: 45_000 });
      await ui.settle();
      await page.screenshot({ path: test.info().outputPath("tip-chat.png") });
    });
  });
});

test.describe("first run", () => {
  runAt("c39", "c14");
  test.use({ viewStyle: null });

  test("setup asks which view, recommends the device's own and offers the change again", async ({
    page,
    ui,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("localdot.onboarding.v1", JSON.stringify({ step: "view" })),
    );
    await ui.open("model-ready");
    const view = page.getByRole("radiogroup", { name: "View" });
    await expect(view).toBeVisible();
    const phone = isPhone(page);
    const recommended = view.locator("label", { hasText: "Recommended" });
    await expect(recommended).toContainText(phone ? "Chat" : "Studio");
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath("setup.png") });
    await view.getByRole("radio", { name: phone ? /^Studio/ : /^Chat/ }).check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Which web browser should dot use?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "You're all set." })).toBeVisible();
    await expect(page.getByText(phone ? "Studio" : "Chat", { exact: true })).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), VIEWS_TRIED_KEY)).toBeNull();
  });
});
