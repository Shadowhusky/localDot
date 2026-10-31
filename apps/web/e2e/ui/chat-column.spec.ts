import type { Locator, Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { choose } from "../settings-ui.ts";
import { chatRail, composer, expect, type Harness, isPhone, runAt, test } from "./harness.ts";

// The chat column's details: the phone toolbar's buttons keep clear of the field, the dot that
// works a conversation wears this localDot's accessory, the model menu shows only the plan the
// chosen model spends, and a preview beside the chat closes on a click outside it.
runAt("c14", "w39");

const APPEARANCES = ["graphite", "midnight", "daylight"] as const;
type Appearance = (typeof APPEARANCES)[number];

async function appearance(page: Page, value: Appearance) {
  await page.evaluate((next) => {
    document.documentElement.dataset.appearance = next;
  }, value);
}

async function settings(page: Page, origin: string, change: Record<string, unknown>) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const saved = await (await page.request.get(`${origin}/api/agent/settings`, { headers })).json();
  const reply = await page.request.put(`${origin}/api/agent/settings`, {
    headers,
    data: { ...saved, ...change },
  });
  expect(reply.ok(), await reply.text()).toBe(true);
}

async function reload(page: Page, ui: Harness) {
  ui.leaving();
  await page.reload();
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
}

// How far a toolbar button's face is from the message field, and from the screen's edges.
function clearance(button: Locator) {
  return button.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const card = element.parentElement?.querySelector(".composer-card")?.getBoundingClientRect();
    if (!card) return null;
    return {
      field: Math.max(box.left - card.right, card.left - box.right),
      edge: Math.min(box.left, innerWidth - box.right),
    };
  });
}

async function face(button: Locator): Promise<string> {
  return button.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
}

test("the phone toolbar's buttons keep their hover and press faces clear of the field", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  // Chromium stands in for a narrow desktop window with a mouse; WebKit is a phone, which presses.
  const touch = isPhone(page);
  const toolbar = page.locator(".thread-toolbar");
  for (const width of touch ? [390, 320] : [600, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await ui.settle();
    for (const name of ["Activity", "More"]) {
      const button = toolbar.getByRole("button", { name, exact: true });
      await expect
        .poll(() => clearance(button), { message: `${name} at ${width}px` })
        .toEqual({ field: 8, edge: 4 });
    }
    for (const value of APPEARANCES) {
      await appearance(page, value);
      for (const name of ["Activity", "More"]) {
        const button = toolbar.getByRole("button", { name, exact: true });
        if (touch) await button.dispatchEvent("pointerdown", { button: 0, pointerType: "touch" });
        else await button.hover();
        await expect.poll(() => face(button)).not.toBe("rgba(0, 0, 0, 0)");
        const shown = await toolbar.boundingBox();
        if (!shown) throw new Error("The toolbar has no box");
        await page.screenshot({
          path: test.info().outputPath(`toolbar-${width}-${value}-${name.toLowerCase()}.png`),
          clip: { x: 0, y: shown.y - 16, width, height: shown.height + 16 },
        });
        if (touch) await button.dispatchEvent("pointercancel", { pointerType: "touch" });
        else await page.mouse.move(width / 2, 200);
      }
    }
    await appearance(page, "graphite");
  }
});

test("on a wide screen the narrowest chat column keeps every button's face clear of the next", async ({
  page,
  ui,
}) => {
  test.skip(isPhone(page), "The chat column is the rail of a wide screen");
  await page.addInitScript(() => localStorage.setItem("localdot.width.chat", "320"));
  await ui.open("done");
  const rail = await chatRail(page);
  await expect(page.getByRole("separator", { name: "Conversation width" })).toHaveAttribute(
    "aria-valuenow",
    "320",
  );
  const touching = await rail.evaluate((column) => {
    const shown = [...column.querySelectorAll<HTMLElement>(".ui-button, .ui-icon-button")].filter(
      (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 &&
          style.visibility !== "hidden" &&
          !element.closest("[inert], .thread-jump:not([data-shown])")
        );
      },
    );
    const card = column.querySelector(".composer-card")?.getBoundingClientRect();
    const out: string[] = [];
    const name = (element: HTMLElement) =>
      element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
    for (const [i, a] of shown.entries()) {
      const box = a.getBoundingClientRect();
      for (const b of shown.slice(i + 1)) {
        const other = b.getBoundingClientRect();
        const gap = Math.max(
          box.left - other.right,
          other.left - box.right,
          box.top - other.bottom,
          other.top - box.bottom,
        );
        if (gap <= 0) out.push(`${name(a)} touches ${name(b)}`);
      }
      if (card && !a.closest(".composer-card")) {
        const gap = Math.max(
          box.left - card.right,
          card.left - box.right,
          box.top - card.bottom,
          card.top - box.bottom,
        );
        if (gap <= 0) out.push(`${name(a)} touches the message field`);
      }
    }
    return out;
  });
  expect(touching).toEqual([]);
  for (const value of ["graphite", "daylight"] as const) {
    await appearance(page, value);
    await ui.settle();
    await ui.still();
    await rail.screenshot({ path: test.info().outputPath(`narrow-column-${value}.png`) });
  }
});

test("the dot in the chat and in the chooser wears this localDot's accessory", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready");
  await settings(page, fixture.origin, { persona: "coder", accessory: "cap", autoPersona: true });
  await reload(page, ui);
  // Auto has no answer in time, so the user's default dot, Coder, works the task.
  await page.request.post(`${fixture.origin}/__qa/first-look`, {
    data: { title: "Login page fix" },
  });
  const form = await composer(page);
  await form.getByRole("textbox", { name: /^(New task|Message)$/ }).fill("fix the login page");
  await form.getByRole("button", { name: /^(Start task|Send)$/ }).click();
  const rail = await chatRail(page);
  const line = rail.locator(".thread-dot");
  await expect(line).toContainText("Working as Coder, your default: Auto had no quick answer");
  await expect(line.locator('[data-wear="cap"]')).toHaveCount(1);
  await expect(line.locator('[data-wear="hoodie"]')).toHaveCount(1);
  await expect(
    rail.getByRole("article", { name: "dot" }).filter({ hasText: "Sample reply" }),
  ).toBeVisible();
  for (const value of ["graphite", "daylight"] as const) {
    await appearance(page, value);
    await ui.settle();
    await line.screenshot({ path: test.info().outputPath(`dot-line-${value}.png`) });
  }
  await appearance(page, "graphite");

  // Another dot, shown in the chooser, wears the cap in place of the hat it would wear.
  await page.getByRole("button", { name: /^Change your dot/ }).click();
  const chooser = page.getByRole("dialog", { name: "Your dot" });
  const worn = (name: string) =>
    chooser
      .locator(".ui-radio-card, label")
      .filter({ has: page.getByRole("radio", { name, exact: true }) })
      .first()
      .locator("[data-wear]")
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.wear).sort());
  await expect.poll(() => worn("Coder")).toEqual(["cap", "hoodie"]);
  await expect.poll(() => worn("Researcher")).toEqual(["cap", "round-glasses"]);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("dot-chooser.png") });
});

test("the model menu shows only the plan the chosen model spends", async ({ page, ui }) => {
  const fixture = await ui.open("plan-usage");
  const touch = isPhone(page);
  const chip = (await composer(page)).getByRole("button", { name: /^Model:/ });
  const panel = page.getByRole("dialog", { name: "Model and thinking" });
  const claude = panel.getByRole("region", { name: /^Claude plan/ });
  const chatgpt = panel.getByRole("region", { name: /^ChatGPT plan/ });
  const pick = (model: string | RegExp) =>
    choose(page, panel.getByRole("combobox", { name: "Model" }), model, { tap: touch });
  const close = () =>
    expect(async () => {
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden({ timeout: 1_000 });
    }).toPass();

  await chip.click();
  await expect(claude.getByRole("meter", { name: "5-hour limit" })).toHaveAttribute(
    "aria-valuetext",
    "42% used",
  );
  await expect(chatgpt).toHaveCount(0);
  await pick("Sample plan model");
  await expect(chatgpt.getByRole("meter", { name: "5-hour limit" })).toHaveAttribute(
    "aria-valuetext",
    "23% used",
  );
  await expect(claude).toHaveCount(0);
  await expect(page.locator(".ui-picker-popover, .ui-picker-sheet")).toHaveCount(0);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("menu-chatgpt-chosen.png") });
  await close();

  // The main model on a key billed by the call: neither signed-in plan says anything about it.
  await settings(page, fixture.origin, {
    main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic-main" },
  });
  await reload(page, ui);
  await expect(chip).toHaveAccessibleName("Model: Claude Sonnet 5.5");
  for (const value of ["graphite", "daylight"] as const) {
    await appearance(page, value);
    await chip.click();
    await expect(panel.getByRole("combobox", { name: "Model" })).toHaveText(/Claude Sonnet 5\.5/);
    await expect(panel.getByRole("region")).toHaveCount(0);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`menu-api-${value}.png`) });
    await close();
  }
  await chip.click();
  await pick(/^Claude Sonnet$/);
  await expect(claude.getByRole("heading")).toHaveText("Claude plan · Max");
  await expect(chatgpt).toHaveCount(0);
});

test("a preview beside the chat closes on a click outside it, and on Escape", async ({
  page,
  ui,
}) => {
  await ui.open("done");
  const rail = await chatRail(page);
  const thumb = rail.getByRole("button", { name: /^Preview screenshot/ }).first();
  const preview = page.getByRole("dialog", { name: "Step screenshot" });
  if (isPhone(page)) {
    // A phone shows it as a sheet over a dimmed page, which the dimmed page closes.
    await thumb.tap();
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("aria-modal", "true");
    await page.locator(".ui-scrim").tap({ position: { x: 20, y: 20 } });
    await expect(preview).toBeHidden();
    return;
  }
  await thumb.click();
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("aria-modal", "false");
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("preview-open.png") });

  // Its own controls, a selection dragged out of it and a drag of the chat's edge keep it.
  await preview.getByRole("radio", { name: "Actual size" }).click();
  const title = await preview.getByRole("heading", { name: "Step screenshot" }).boundingBox();
  const text = await rail.getByText("Report ready").boundingBox();
  if (!title || !text) throw new Error("Nothing to drag across");
  await page.mouse.move(title.x + 2, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(text.x + 40, text.y + text.height / 2, { steps: 8 });
  await page.mouse.up();
  // The splitter's part the preview leaves uncovered, between it and the chat.
  const handle = await page.getByRole("separator", { name: "Conversation width" }).boundingBox();
  const panel = await preview.boundingBox();
  if (!handle || !panel) throw new Error("No splitter beside the preview");
  const x = (panel.x + panel.width + handle.x + handle.width) / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 40, y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await preview.boundingBox())?.width ?? 0)
    .toBeLessThan(panel.width);
  await expect(preview).toBeVisible();

  await preview.getByRole("radio", { name: "Fit" }).focus();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();

  await thumb.click();
  await expect(preview).toBeVisible();
  await rail.getByText("Report ready").click();
  await expect(preview).toBeHidden();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("preview-closed.png") });

  // A file's full preview is modal, and its dimmed page closes it the same way.
  await rail.getByRole("button", { name: "Open summary.md" }).click();
  const viewer = page.getByRole("dialog", { name: "summary.md" });
  await expect(viewer).toHaveAttribute("aria-modal", "true");
  await page.mouse.click(40, 450);
  await expect(viewer).toBeHidden();
});
