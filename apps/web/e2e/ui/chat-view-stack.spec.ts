import type { Page } from "@playwright/test";
import { expect, finger, type Harness, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ viewStyle: "chat" });

const real = () => test.info().project.name.startsWith("c");

async function shot(page: Page, ui: Harness, name: string) {
  await ui.settle();
  await ui.still();
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

const stack = (page: Page) => page.locator(".phone-stack");
const chatX = (page: Page) =>
  page.locator(".phone-chat").evaluate((element) => element.getBoundingClientRect().left);

test.describe("the stack", () => {
  test.use({ phoneList: true });

  test("list, conversation and computer are each a browser history entry", async ({ page, ui }) => {
    await ui.open("running");
    await page.locator(".phone-row").first().click();
    await expect(page).toHaveURL(/#\/c\/[0-9A-Z]+$/);
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await page
      .getByRole("button", { name: /^Open the computer/ })
      .first()
      .click();
    await expect(page).toHaveURL(/#\/c\/[0-9A-Z]+\/computer$/);
    await expect(stack(page)).toHaveAttribute("data-level", "2");
    await page.goBack();
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await page.goBack();
    await expect(stack(page)).toHaveAttribute("data-level", "0");
    await expect(page.getByRole("heading", { name: "Conversations" })).toBeInViewport();
    await page.goForward();
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(stack(page)).toHaveAttribute("data-level", "0");
    await expect(page).not.toHaveURL(/#/);
  });

  test("a link opens with the stack built under it, and Back stays in the app", async ({
    page,
    ui,
  }) => {
    const opened = await ui.open("running");
    await page.locator(".phone-row").first().click();
    await expect(page).toHaveURL(/#\/c\//);
    const id = /#\/c\/([0-9A-Z]+)/.exec(page.url())?.[1];
    await page.goto(`${opened.origin}/#/c/${id}/computer`);
    await expect(stack(page)).toHaveAttribute("data-level", "2");
    await expect(page.getByRole("region", { name: "Computer" })).toBeInViewport();
    await page.goBack();
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await page.goBack();
    await expect(stack(page)).toHaveAttribute("data-level", "0");
  });

  test("new conversation starts one and comes back to the list", async ({ page, ui }) => {
    await ui.open("running");
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page).toHaveURL(/#\/c\/new$/);
    await expect(page.getByText("What should we do?")).toBeVisible();
  });
});

test.describe("the swipe back", () => {
  test.beforeEach(({ page }) => page.emulateMedia({ reducedMotion: "no-preference" }));

  test("follows the finger 1:1 from anywhere, springs back if let go short", async ({
    page,
    ui,
  }) => {
    test.skip(!real(), "Playwright's WebKit sends no touch moves");
    await ui.open("done");
    await expect(page.getByRole("button", { name: "Back to conversations" })).toBeVisible();
    await page.waitForTimeout(600);
    const hand = await finger(page);
    await hand.drag(60, 400, 220, 404, false);
    await expect.poll(() => chatX(page)).toBeGreaterThan(120);
    expect(await chatX(page)).toBeLessThan(200);
    await shot(page, ui, "swipe-mid");
    await hand.lift();
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await expect.poll(() => chatX(page)).toBeLessThan(1);
    // Dragged past the middle, it goes.
    await hand.drag(40, 400, 340, 404);
    await expect(stack(page)).toHaveAttribute("data-level", "0");
    await expect(page.getByRole("heading", { name: "Conversations" })).toBeInViewport();
  });

  test("leaves the page's edge to Safari's own swipe in a browser tab", async ({ page, ui }) => {
    test.skip(!real(), "Playwright's WebKit sends no touch moves");
    await ui.open("done");
    await page.waitForTimeout(600);
    const hand = await finger(page);
    await hand.drag(10, 400, 300, 404);
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await expect.poll(() => chatX(page)).toBeLessThan(1);
  });

  test("leaves a sideways table to the table", async ({ page, ui }) => {
    test.skip(!real(), "Playwright's WebKit sends no touch moves");
    await page.route("**/api/**", (route) => route.continue());
    await ui.open("done");
    await expect(page.getByRole("button", { name: "Back to conversations" })).toBeVisible();
    await page
      .locator(".thread-message")
      .first()
      .evaluate((message) => {
        const table = document.createElement("div");
        table.className = "md-table";
        table.style.overflowX = "auto";
        const wide = document.createElement("div");
        wide.style.width = "1200px";
        wide.style.height = "60px";
        table.append(wide);
        message.append(table);
        table.scrollIntoView();
      });
    await page.waitForTimeout(100);
    const box = await page.locator(".md-table").first().boundingBox();
    if (!box) throw new Error("No table");
    const hand = await finger(page);
    await hand.drag(box.x + 40, box.y + 20, box.x + 240, box.y + 22);
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await expect.poll(() => chatX(page)).toBeLessThan(1);
  });
});

test.describe("the thread", () => {
  test("is bubbles, with steps behind a caption that unfolds them", async ({ page, ui }) => {
    await ui.open("done");
    const caption = page.locator(".chat-steps .ui-disclosure-trigger").last();
    await expect(caption).toContainText(/\d+:\d+ · \d+ steps/);
    await expect(page.locator(".thread-work-list")).toHaveCount(0);
    await caption.click();
    await expect(page.locator(".thread-work-list")).toBeVisible();
    await expect(caption).toHaveAttribute("aria-expanded", "true");
    await shot(page, ui, "steps-open");
  });

  test("a held reply offers its menu, and Select text a sheet to select in", async ({
    page,
    ui,
  }) => {
    await ui.open("done");
    const reply = page.locator('.thread-message[data-role="dot"]').last();
    await expect(reply).toBeVisible();
    const hand = await finger(page);
    await hand.hold(reply);
    const menu = page.getByRole("menu", { name: "Message actions" });
    await expect(menu).toBeVisible();
    for (const name of ["Copy", "Select text", "Show steps", "Watch this part", "Share"])
      await expect(menu.getByRole("menuitem", { name })).toBeVisible();
    await shot(page, ui, "hold-reply");
    await hand.lift();
    await page.waitForTimeout(100);
    await menu.getByRole("menuitem", { name: "Select text" }).click();
    const sheet = page.getByRole("dialog", { name: "Select text" });
    await expect(sheet).toBeVisible();
    const userSelect = await sheet
      .locator(".bubble-select p")
      .first()
      .evaluate((element) => getComputedStyle(element).userSelect);
    expect(userSelect).toBe("text");
  });

  test("your own message offers Copy and Edit and send again, which fills the composer", async ({
    page,
    ui,
  }) => {
    await ui.open("done");
    const mine = page.locator('.thread-message[data-role="user"] .thread-bubble').last();
    const said = await mine.innerText();
    const hand = await finger(page);
    await hand.hold(mine);
    const menu = page.getByRole("menu", { name: "Message actions" });
    await expect(menu.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    await hand.lift();
    await page.waitForTimeout(100);
    await menu.getByRole("menuitem", { name: "Edit and send again" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(said);
  });

  test("a question takes one tap on a chip", async ({ page, ui }) => {
    const opened = await ui.open("ask");
    await expect(page.getByText("Which report format should I use?").first()).toBeVisible();
    await page.getByRole("button", { name: "PDF" }).tap();
    await expect(page.locator(".ask-quick")).toHaveCount(0);
    const state = await (await page.request.get(`${opened.origin}/__qa/state`)).json();
    expect(JSON.stringify(state.effects)).toContain("PDF");
  });

  test("an approval docks above the composer with what it must show, until it is answered", async ({
    page,
    ui,
  }) => {
    await ui.open("approval");
    const decision = page.locator(".phone-decision");
    await expect(decision.getByRole("heading", { name: "Send this email?" })).toBeVisible();
    await expect(decision.getByText("team@example.test")).toBeVisible();
    await expect(decision.getByText("Sending as you always needs your OK.")).toBeVisible();
    const box = await decision.boundingBox();
    const field = await page.getByRole("form", { name: "Message dot" }).boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((field?.y ?? 0) + 1);
    await shot(page, ui, "approval");
    await decision.getByRole("button", { name: "Don't send" }).click();
    await expect(decision).toHaveCount(0);
  });
});

test.describe("the computer", () => {
  test("zooms out of the thumbnail and back, the same picture all the way", async ({
    page,
    ui,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await ui.open("running");
    const thumb = page.getByRole("button", { name: "Open the computer", exact: true }).last();
    await expect(page.locator(".phone-thumb")).toBeVisible();
    await ui.picture();
    await expect(page.locator(".phone-lamp-host")).toHaveAttribute("data-lamp");
    const picture = await page.locator(".phone-picture").elementHandle();
    await page.locator(".phone-thumb").click();
    await expect(stack(page)).toHaveAttribute("data-level", "2");
    await expect(page.locator(".phone-picture")).toHaveAttribute("data-place", "open");
    expect(await page.locator(".phone-picture").evaluate((n, was) => n === was, picture)).toBe(
      true,
    );
    await expect(page.getByRole("button", { name: "Take control" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByTestId("hud-stop-session")).toBeVisible();
    await expect(page.getByRole("region", { name: "Latest steps" })).toBeVisible();
    await expect(page.getByPlaceholder("Steer dot")).toBeVisible();
    await page.waitForTimeout(700);
    await shot(page, ui, "computer");
    await page.getByRole("button", { name: "Back to the conversation" }).click();
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await expect(page.locator(".phone-picture")).toHaveAttribute("data-place", "thumb");
    await expect(page.getByPlaceholder("Message dot")).toBeVisible();
    await expect(thumb).toBeVisible();
  });

  test("a drag down or to the right puts it back", async ({ page, ui }) => {
    test.skip(!real(), "Playwright's WebKit sends no touch moves");
    await ui.open("running");
    await expect(page.locator(".phone-thumb")).toBeVisible();
    await ui.picture();
    await page.locator(".phone-thumb").click();
    await expect(stack(page)).toHaveAttribute("data-level", "2");
    await expect(page.locator(".phone-picture")).toHaveAttribute("data-place", "open");
    const hand = await finger(page);
    await hand.drag(200, 200, 200, 620);
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await page.locator(".phone-thumb").click();
    await expect(stack(page)).toHaveAttribute("data-level", "2");
    await hand.drag(100, 200, 360, 210);
    await expect(stack(page)).toHaveAttribute("data-level", "1");
  });

  test("taking control brings the tools, and Hand back gives it back", async ({ page, ui }) => {
    await ui.open("running");
    await page.locator(".phone-thumb").click();
    await page.getByRole("button", { name: "Take control" }).click();
    await expect(page.getByRole("toolbar", { name: "Computer controls" })).toBeVisible();
    for (const name of ["Keyboard", "Right-click the next tap", "Type text"])
      await expect(page.getByRole("button", { name })).toBeVisible();
    await shot(page, ui, "yours");
    await page.getByRole("button", { name: "Hand back" }).click();
    await expect(page.getByRole("button", { name: "Take control" })).toBeVisible();
  });

  test("a task that hands over goes to the computer on Take control", async ({ page, ui }) => {
    await ui.open("takeover");
    await expect(page.getByText("dot needs your help")).toBeVisible();
    await shot(page, ui, "handed-over");
  });

  test("fills a phone's height when it is held sideways", async ({ page, ui }) => {
    await ui.open("running");
    await page.locator(".phone-thumb").click();
    await expect(stack(page)).toHaveAttribute("data-level", "2");
    await page.setViewportSize({ width: 844, height: 390 });
    const box = page.locator(".phone-picture .stage-box");
    await expect.poll(async () => (await box.boundingBox())?.height ?? 0).toBeGreaterThan(320);
    await shot(page, ui, "landscape");
    await expect(page.getByRole("button", { name: "Take control" })).toBeInViewport();
    await page.setViewportSize({ width: 390, height: 844 });
  });
});

test.describe("minimal mode", () => {
  test("Hide dot tucks it into ⋯, with a tip, and Show dot brings it back, across a reload", async ({
    page,
    ui,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await ui.open("running");
    await expect(page.locator(".dot-strip .narrator-dot")).toBeVisible();
    await page.getByRole("button", { name: "Your dot" }).click();
    await page.getByRole("menuitem", { name: "Hide dot" }).click();
    const tip = page.locator(".phone-coach");
    await expect(tip).toContainText("dot is tucked away");
    await expect(tip).toContainText("Bring it back any time from this menu.");
    await shot(page, ui, "tucked");
    // A task at work still says so above the composer, in a typing bubble in dot's place.
    await expect(page.locator(".dot-strip")).toHaveAttribute("data-typing");
    await expect(page.locator(".dot-strip .dot-typing")).toHaveText(/\S/);
    await expect(page.locator(".dot-strip .narrator-dot")).toHaveCount(0);
    await expect(page.locator(".phone-chat-bar .phone-title-sub-in")).toBeVisible();
    await page.mouse.click(180, 500);
    await expect(tip).toHaveCount(0);

    await page.reload();
    await expect(page.locator(".dot-strip")).toHaveAttribute("data-typing");
    // The list's dots stay.
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(page.locator(".phone-row .conversation-avatar").first()).toBeVisible();
    await page.locator(".phone-row").first().click();

    // Still sliding in, a press would scroll the stack to it first, and it would go from the finger.
    const more = page.getByRole("button", { name: "More", exact: true }).first();
    await expect(more).toBeInViewport({ ratio: 1 });
    await more.click();
    await page.getByRole("menuitem", { name: "Show dot" }).click();
    await expect(page.locator(".dot-strip")).not.toHaveAttribute("data-typing");
    await expect(page.locator(".presence-frame[data-shown]")).toBeVisible();
  });

  test("under reduced motion the dot just goes", async ({ page, ui }) => {
    await ui.open("running");
    await page.getByRole("button", { name: "Your dot" }).click();
    await page.getByRole("menuitem", { name: "Hide dot" }).click();
    await expect(page.locator(".phone-coach")).toBeVisible();
    await expect(page.locator(".phone-flyer[data-shown]")).toHaveCount(0);
  });
});

test.describe("keeping working", () => {
  test("the computer pill holds Routines, Replay, Settings, Keys and Stop everything", async ({
    page,
    ui,
  }) => {
    await ui.open("running");
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await page.getByRole("button", { name: /this computer and app settings$/ }).click();
    for (const name of ["Routines", "Replay", "Settings", "Keys", "Stop everything"])
      await expect(page.getByRole("menuitem", { name })).toBeVisible();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  test("⋯ opens the Workspace as a sheet and Replay", async ({ page, ui }) => {
    await ui.open("done");
    await page.getByRole("button", { name: "More", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Workspace" }).click();
    await expect(page.getByRole("dialog", { name: "Workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "More", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Replay" }).click();
    await expect(page).toHaveURL(/replay=/);
  });

  test("the name opens the details, which rename it", async ({ page, ui }) => {
    await ui.open("done");
    await page.getByRole("button", { name: /Conversation details$/ }).click();
    const sheet = page.getByRole("dialog", { name: "Details" });
    await expect(sheet.getByRole("button", { name: "Rename" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Replay" })).toBeVisible();
    await shot(page, ui, "details");
  });

  test("a session link opens the conversation over the list", async ({ page, ui }) => {
    await ui.open("running");
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(stack(page)).toHaveAttribute("data-level", "0");
    const id = await page.locator(".phone-row-wrap").first().getAttribute("data-conversation");
    await page.evaluate((task) => {
      window.location.hash = `#session=${task}`;
    }, id);
    await expect(stack(page)).toHaveAttribute("data-level", "1");
    await expect(page).toHaveURL(/#\/c\//);
  });
});

test.describe("the keyboard", () => {
  test("the app fits what it leaves: the composer rides on it and the thread keeps its end", async ({
    page,
    ui,
  }) => {
    await ui.open("done");
    const field = page.getByRole("textbox", { name: "Message" });
    await expect(field).toBeVisible();
    await field.focus();
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForTimeout(300);
    const composer = await page.getByRole("form", { name: "Message dot" }).boundingBox();
    expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(500);
    expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeGreaterThan(460);
    const atEnd = await page.locator(".thread-scroll").evaluate((element) => {
      return element.scrollHeight - element.scrollTop - element.clientHeight;
    });
    expect(atEnd).toBeLessThan(4);
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("a tap on the thread drops it", async ({ page, ui }) => {
    await ui.open("done");
    const field = page.getByRole("textbox", { name: "Message" });
    await field.focus();
    await expect(field).toBeFocused();
    await page.locator(".thread-time").first().tap();
    await expect(field).not.toBeFocused();
  });

  test("the slash menu sits above the dot", async ({ page, ui }) => {
    await ui.open("done");
    const field = page.getByRole("textbox", { name: "Message" });
    await field.focus();
    await field.fill("/");
    const menu = page.getByRole("listbox").first();
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    if (!box) throw new Error("No menu");
    const onTop = await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest('[role="listbox"]'),
      [box.x + 30, box.y + box.height - 12] as const,
    );
    expect(onTop).toBe(true);
    await shot(page, ui, "slash");
  });
});

test("at the end of the thread, the last words rest above the fade over dot's line", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?n=14&text=History%20message`);
  const strip = page.locator(".dot-strip[data-live]");
  await expect(strip).toBeVisible();
  const view = page.locator(".thread-scroll");
  await view.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await ui.settle();
  const gap = await strip.evaluate((node) => {
    const fade = Number.parseFloat(getComputedStyle(node, "::before").height);
    const top = node.getBoundingClientRect().top;
    const above = [...document.querySelectorAll<HTMLElement>(".phone-thread .thread-message")]
      .map((message) => message.getBoundingClientRect().bottom)
      .filter((bottom) => bottom <= top + 1);
    return { fade, clear: top - Math.max(...above) };
  });
  expect(gap.fade).toBeGreaterThan(0);
  expect(gap.clear).toBeGreaterThanOrEqual(gap.fade);
});
