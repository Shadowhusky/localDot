import { expect, finger, runAt, test } from "./harness.ts";

// The iPhone Duo open, in points: held upright, the conversation takes the whole width and the list
// slides over it, as an iPad's sidebar does held upright; held sideways, the list sits beside it.
const UPRIGHT = { width: 669, height: 951 };
const SIDEWAYS = { width: 951, height: 669 };

runAt("c39", "w39");
test.use({ viewStyle: "chat", deviceScaleFactor: 3, isMobile: true, hasTouch: true });

test.describe("the Duo held upright", () => {
  test.use({ viewport: UPRIGHT });

  test("keeps the conversation the whole width and slides the list over it", async ({
    page,
    ui,
  }) => {
    await ui.open("running");
    const stack = page.locator(".phone-stack");
    const chat = page.locator(".phone-chat");
    const list = page.locator(".phone-list");
    const scrim = page.locator(".phone-scrim");
    await expect(stack).toHaveAttribute("data-slide-over");
    await expect.poll(async () => Math.round((await chat.boundingBox())?.width ?? 0)).toBe(669);
    await expect(list).toHaveAttribute("inert");

    const toggle = page.getByRole("button", { name: "Show or hide the list" }).first();
    await toggle.click();
    await expect(list).not.toHaveAttribute("inert");
    await expect(chat).toHaveAttribute("inert");
    await expect.poll(async () => Math.round((await list.boundingBox())?.x ?? -1)).toBe(0);
    expect((await list.boundingBox())?.width ?? 0).toBeLessThanOrEqual(UPRIGHT.width - 72);
    await expect(scrim).toHaveCSS("opacity", "1");

    // A tap on the dimmed conversation puts it away, as Escape does.
    await scrim.click({ position: { x: UPRIGHT.width - 40, y: UPRIGHT.height / 2 } });
    await expect(list).toHaveAttribute("inert");
    await expect(scrim).toHaveCSS("opacity", "0");
    await toggle.click();
    await expect(list).not.toHaveAttribute("inert");
    await page.keyboard.press("Escape");
    await expect(list).toHaveAttribute("inert");

    // Choosing a conversation opens it and puts the list away.
    await toggle.click();
    await expect(list).not.toHaveAttribute("inert");
    await list.getByRole("button", { name: /^New conversation$/ }).click();
    await expect(list).toHaveAttribute("inert");
  });

  test("follows a finger in from the leading edge and back out", async ({ page, ui }) => {
    await ui.open("running");
    const list = page.locator(".phone-list");
    await expect(list).toHaveAttribute("inert");
    // The edge is the conversation's once the app has come in.
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const hand = await finger(page);
    await hand.drag(30, 420, 340, 424);
    await expect(list).not.toHaveAttribute("inert");
    await expect.poll(async () => Math.round((await list.boundingBox())?.x ?? -1)).toBe(0);
    await hand.drag(260, 420, 30, 424);
    await expect(list).toHaveAttribute("inert");
  });
});

test.describe("the Duo held sideways", () => {
  test.use({ viewport: SIDEWAYS });

  test("keeps the list beside the conversation", async ({ page, ui }) => {
    await ui.open("running");
    const stack = page.locator(".phone-stack");
    await expect(stack).toHaveAttribute("data-split");
    await expect(stack).not.toHaveAttribute("data-slide-over");
    const list = await page.locator(".phone-list").boundingBox();
    const chat = await page.locator(".phone-chat").boundingBox();
    expect(Math.round(list?.x ?? -1)).toBe(0);
    expect(Math.round(chat?.x ?? 0)).toBe(Math.round(list?.width ?? -1));
  });
});

// Studio held sideways: too short to stack the computer over the chat, so the computer sits beside
// the chat, as large as the height allows, and the list slides over the computer when wanted.
test.describe("Studio on the Duo held sideways", () => {
  test.use({ viewport: SIDEWAYS, viewStyle: "studio" });

  test("puts the computer beside the chat and slides the list over it", async ({ page, ui }) => {
    await ui.open("running");
    const stage = page.locator(".stage-col");
    const chat = page.locator(".rail-chat");
    const [stageBox, chatBox] = [await stage.boundingBox(), await chat.boundingBox()];
    expect((stageBox?.x ?? 0) + (stageBox?.width ?? 0)).toBeLessThanOrEqual(chatBox?.x ?? 0);
    expect(Math.round(chatBox?.y ?? -1)).toBeLessThan(20);
    expect(stageBox?.width ?? 0).toBeGreaterThan(SIDEWAYS.width / 2);

    const expand = page.getByRole("button", { name: "Expand conversations" });
    await expand.click();
    const rail = page.locator(".sessions");
    await expect(rail).toHaveAttribute("data-expanded");
    await expect(page.locator(".sessions-scrim")).toBeVisible();
    // Over the computer, which keeps its room.
    expect(await stage.boundingBox()).toEqual(stageBox);
    await expect.poll(async () => Math.round((await rail.boundingBox())?.width ?? 0)).toBe(256);

    await page.locator(".sessions-scrim").click({ position: { x: SIDEWAYS.width - 60, y: 300 } });
    await expect(rail).not.toHaveAttribute("data-expanded");
    await expect(page.locator(".sessions-scrim")).toHaveCount(0);
    await expand.click();
    await page.keyboard.press("Escape");
    await expect(rail).not.toHaveAttribute("data-expanded");
  });
});
