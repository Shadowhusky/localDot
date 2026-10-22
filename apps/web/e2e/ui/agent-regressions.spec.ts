import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

test("phone composer icons share a center on the last line", async ({ page, ui }) => {
  test.skip(!isPhone(page), "Phone pill layout");
  await ui.open("running");
  const form = page.getByRole("form", { name: "Message dot" });
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const draft of ["", "Please check this", "First line\nSecond line\nThird line"]) {
      await form.getByRole("textbox", { name: "Message" }).fill(draft);
      await ui.settle();
      const centers = await form.evaluate((element) => {
        return [
          ".composer-bar > .ui-icon-button:first-child > svg",
          ".composer-permissions > svg",
          ...(element.querySelector("textarea")?.value ? [] : [".voice-mic > button > svg"]),
          ".composer-send > svg",
        ].map((selector) => {
          const icon = element.querySelector(selector);
          if (!icon) throw new Error(`Missing icon: ${selector}`);
          const box = icon.getBoundingClientRect();
          return box.top + box.height / 2;
        });
      });
      expect(Math.max(...centers) - Math.min(...centers), `${width}px, ${draft}`).toBeLessThan(1);
    }
    await page.screenshot({ path: test.info().outputPath(`phone-composer-${width}.png`) });
  }
  await form.getByRole("button", { name: /^Permission mode:/ }).click();
  await expect(page.getByRole("menuitemradio", { name: /^Auto/ })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Screen view" })).toHaveCount(0);
});

test("the composer keeps controls inside a narrow panel", async ({ page, ui }) => {
  await ui.open("running");
  const form = page.getByRole("form", { name: "Message dot" });
  await expect(form.getByRole("button", { name: "Stop task", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "Pause task", exact: true })).toHaveCount(0);
  if (!isPhone(page)) {
    const handle = await page.locator(".rail-resize-chat").boundingBox();
    if (!handle) throw new Error("Missing resize handle");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 40);
    await page.mouse.down();
    await page.mouse.move(handle.x + 450, handle.y + 40, { steps: 10 });
    await page.mouse.up();
  }
  await ui.settle();
  const outside = await form.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return [...element.querySelectorAll(".composer-bar button")]
      .filter((button) => {
        const b = button.getBoundingClientRect();
        return b.width && (b.left < box.left - 1 || b.right > box.right + 1);
      })
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
  });
  expect(outside).toEqual([]);
  const field = await form.locator(".composer-field").boundingBox();
  expect(field?.width).toBeGreaterThan(80);
  expect(field?.height).toBeLessThan(100);
  const primary = await form.locator(".composer-send").boundingBox();
  const permission = await form.locator(".composer-permissions").boundingBox();
  expect(Math.abs((primary?.y ?? 0) - (permission?.y ?? 0))).toBeLessThan(12);
  await form.getByRole("button", { name: /^Permission mode:/ }).click();
  await expect(page.getByRole("menuitemradio", { name: /^Auto/ })).toBeVisible();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("permission-menu.png") });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: test.info().outputPath("narrow-composer.png") });
});

test("history opens while desktop control stays with the user", async ({ page, ui }) => {
  await ui.open("conversations");
  await ui.step("takeover");
  await expect(page.getByTestId("hud-status")).toHaveText("You're in control");
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/conversation/"))
      mutations.push(request.url());
  });
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Conversations", exact: true }).click();
  } else await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: /^Actions for Compare flights to Lisbon/ }).click();
  await expect(page.getByRole("menuitem", { name: "Delete conversation" })).toBeVisible();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("conversation-actions.png") });
  await page.keyboard.press("Escape");
  const search = page.getByRole("combobox", { name: "Search conversations" });
  await search.fill("lisbon");
  await expect(page.getByRole("row", { name: /Compare flights to Lisbon/ })).toBeVisible();
  await search.press("Enter");
  const thread = page.getByRole("region", { name: "Conversation history" });
  await expect(thread).toContainText("Book the 9:40 one");
  await page.waitForTimeout(5500);
  await expect(thread).toContainText("Book the 9:40 one");
  await expect(page.getByTestId("hud-status")).toHaveText("You're in control");
  expect(mutations).toEqual([]);
});

for (const state of ["running", "done"] as const) {
  test(`composer controls and labels fit every panel width (${state})`, async ({ page, ui }) => {
    await ui.open(state);
    const composer = page.locator(".composer");
    const failures: unknown[] = [];
    for (const draft of ["", "A thought. ".repeat(690)]) {
      await composer.locator("textarea").fill(draft);
      await composer.locator(".composer-model .ui-middle").evaluateAll((labels) => {
        for (const label of labels) {
          if (label.children[0])
            label.children[0].textContent = "Provider / A very long configured model name ";
          if (label.children[1]) label.children[1].textContent = "version-with-a-long-suffix";
        }
      });

      if (!isPhone(page))
        await expect(composer.locator(".composer-model .ui-middle")).toContainText(
          "A very long configured model name",
        );
      for (const width of [220, 240, 260, 280, 300, 320, 360, 400, 420, 480, 600]) {
        await composer.evaluate((element, width) => {
          element.style.width = `${width}px`;
        }, width);
        await ui.settle();
        const problems = await composer.evaluate((element) => {
          const form = element.querySelector("form")?.getBoundingClientRect();
          if (!form) throw new Error("Missing composer form");
          const buttons = [...element.querySelectorAll<HTMLButtonElement>(".composer-bar button")]
            .map((button) => ({ button, box: button.getBoundingClientRect() }))
            .filter(({ button, box }) => box.width && box.height && !button.closest("[inert]"));
          const problems: string[] = [];
          for (const { button, box } of buttons) {
            const name = button.getAttribute("aria-label") || button.textContent;
            if (box.left < form.left - 1 || box.right > form.right + 1)
              problems.push(`outside: ${name}`);
            const primary = element.querySelector(".composer-send")?.getBoundingClientRect();
            if (primary && Math.abs(box.bottom - primary.bottom) > 12)
              problems.push(`wrapped: ${name}`);
            const center = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            // Widths larger than the real phone slot deliberately exercise the
            // composer's own sizing, but its neighboring toolbar still sits there.
            const slotRight = element.parentElement?.getBoundingClientRect().right ?? innerWidth;
            if (box.right <= Math.min(innerWidth, slotRight) && center && !button.contains(center))
              problems.push(`covered: ${name}`);
            const content = button.querySelector(".ui-button-content");
            if (content && content.getBoundingClientRect().width > box.width + 1)
              problems.push(`content escapes: ${name}`);
            for (const other of buttons) {
              if (other.button === button) break;
              const horizontal =
                Math.min(box.right, other.box.right) - Math.max(box.left, other.box.left);
              const vertical =
                Math.min(box.bottom, other.box.bottom) - Math.max(box.top, other.box.top);
              if (horizontal > 1 && vertical > 1) problems.push(`overlap: ${name}`);
            }
          }
          return problems;
        });
        if (problems.length) failures.push({ width, problems });
      }
    }
    expect(failures).toEqual([]);
    await composer.evaluate((element) => {
      element.style.width = "280px";
    });
    await composer.locator("textarea").fill("Keep going");
    await ui.settle();
    await composer.screenshot({ path: test.info().outputPath("compact-composer.png") });
    if (!isPhone(page))
      await expect(composer.getByRole("button", { name: "Research", exact: true })).toBeVisible();
    if (!isPhone(page) && state === "running") {
      await composer.evaluate((element) => {
        element.style.width = "420px";
      });
      await ui.settle();
      await composer.getByRole("button", { name: "Message options" }).click();
      await expect(page.getByRole("menuitem", { name: "Send now" })).toBeVisible();
      await expect(page.getByRole("menuitemradio", { name: "Research" })).toHaveCount(0);
    }
  });
}

test.describe("touch panel", () => {
  test.use({ hasTouch: true });
  test("keeps the model target usable beside the fixed controls", async ({ page, ui }) => {
    test.skip(isPhone(page), "The phone uses its separate model picker");
    await ui.open("running");
    const composer = page.locator(".composer");
    await expect(composer).toBeVisible();
    for (const width of [220, 280, 340, 400]) {
      await composer.evaluate((element, width) => {
        element.style.width = `${width}px`;
      }, width);
      await ui.settle();
      const model = await composer.locator(".composer-model").boundingBox();
      expect(model?.width).toBeGreaterThanOrEqual(44);
      expect(model?.height).toBeGreaterThanOrEqual(44);
      const outside = await composer.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll(".composer-bar button")]
          .filter((button) => {
            const b = button.getBoundingClientRect();
            return b.width && (b.left < box.left - 1 || b.right > box.right + 1);
          })
          .map((button) => button.getAttribute("aria-label"));
      });
      expect(outside).toEqual([]);
    }
  });
});

test("Send queues, Steer now promotes once, and Stop frees New conversation", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const form = page.getByRole("form", { name: "Message dot" });
  const field = form.getByRole("textbox", { name: "Message" });
  await field.fill("Queue this next task");
  await expect(form.getByRole("button", { name: "Stop task" })).toHaveCount(0);
  await form.getByRole("button", { name: "Queue message" }).click();
  const row = page
    .getByRole("article", { name: "You", exact: true })
    .filter({ hasText: "Queue this next task" });
  await expect(row).toHaveCount(1);
  await expect(row.getByText("After this task")).toBeVisible();
  await row.getByRole("button", { name: "Steer now" }).click();
  await expect(row.getByText("Sent while working")).toBeVisible();
  await expect(row.getByRole("button", { name: "Steer now" })).toHaveCount(0);
  await expect(row).toHaveCount(1);
  await form.getByRole("button", { name: "Stop task" }).click();
  await expect(form.getByRole("button", { name: "Stop task" })).toHaveCount(0);
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "New conversation" }).click();
  } else await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
});

test("Stop releases user control and allows New conversation without Hand back", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await ui.step("takeover");
  await expect(page.getByTestId("hud-status")).toHaveText("You're in control");
  const form = page.getByRole("form", { name: "Message dot" });
  const response = page.waitForResponse(
    (reply) =>
      reply.request().method() === "POST" &&
      /\/api\/agent\/sessions\/[^/]+\/stop$/.test(reply.url()),
  );
  if (isPhone(page)) await page.getByTestId("hud-stop-session").click();
  else await form.getByRole("button", { name: "Stop task", exact: true }).click();
  expect((await response).status()).toBe(204);
  await expect(form.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0);
  await expect(page.getByText("Couldn't confirm Stop. Check the task and try again.")).toHaveCount(
    0,
  );
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "New conversation" }).click();
  } else await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
});

for (const screen of ["desktop", "browser"] as const) {
  test(`restored history from a retired ${screen} still connects the current computer`, async ({
    page,
    ui,
  }) => {
    const fixture = await ui.open("running");
    await expect(page.getByRole("form", { name: "Message dot" })).toBeVisible();
    await ui.picture();
    const retired = await page.request.post(`${fixture.origin}/__qa/screen?retired=${screen}`);
    expect(retired.status()).toBe(200);
    // WebKit reports requests interrupted by reload as page errors.
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(page.getByRole("article", { name: "You", exact: true })).not.toHaveCount(0);
    const frame = page.locator("iframe.desktop-frame");
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute("src", /\/desktop\//);
    await ui.picture();
  });
}

test("queued Edit moves the message into the draft and resends the edited message once", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const form = page.getByRole("form", { name: "Message dot" });
  const field = form.getByRole("textbox", { name: "Message", exact: true });
  await field.fill("Original queued request");
  await form.getByRole("button", { name: "Queue message" }).click();
  const original = page
    .getByRole("article", { name: "You", exact: true })
    .filter({ hasText: "Original queued request" });
  await expect(original.getByText("After this task")).toBeVisible();
  await field.fill("My existing draft");
  await original.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(field).toHaveValue("My existing draft\n\nOriginal queued request");
  await expect(field).toBeFocused();
  await expect(original).toHaveCount(0);
  await field.fill("Revised queued request");
  await form.getByRole("button", { name: "Queue message" }).click();
  const revised = page
    .getByRole("article", { name: "You", exact: true })
    .filter({ hasText: "Revised queued request" });
  await expect(revised).toHaveCount(1);
  await expect(revised.getByText("After this task")).toBeVisible();
  await expect(field).toHaveValue("");
});
