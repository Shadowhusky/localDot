import { expect, isPhone, runAt, test } from "./harness.ts";

// The conversations rail, expanded, is resized by the same handle as the chat panel.
runAt("c14", "w14", "c39");

const PANELS = "localdot.panels.v1";
const SESSIONS = "localdot.width.sessions";
const CHAT = "localdot.width.chat";

test("the conversations rail resizes by its edge and by keys, and keeps its width", async ({
  page,
  ui,
}) => {
  test.skip(isPhone(page), "A phone has no rail");
  await page.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [PANELS, JSON.stringify({ sessions: true })] as const,
  );
  await ui.open("conversations");
  const rail = page.getByRole("navigation", { name: "Conversations" });
  const edge = page.getByRole("separator", { name: "Conversations width" });
  await expect(rail).toBeVisible();
  const width = async () => (await rail.boundingBox())?.width ?? 0;
  await expect.poll(width).toBe(256);
  const stage = page.locator(".stage").first();
  const stageBefore = (await stage.boundingBox())?.width ?? 0;
  await expect(page.getByRole("separator", { name: "Conversation width" })).toBeVisible();

  const box = await edge.boundingBox();
  if (!box) throw new Error("The rail's edge is not on screen");
  // In the gap beside the rail, never over its rows.
  expect(Math.abs(box.x - 256)).toBeLessThanOrEqual(1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 64, box.y + box.height / 2, { steps: 4 });
  await expect.poll(width).toBe(320);
  await page.mouse.up();
  await expect(edge).toHaveAttribute("aria-valuenow", "320");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SESSIONS)).toBe("320");
  await expect.poll(async () => (await stage.boundingBox())?.width ?? 0).toBeLessThan(stageBefore);

  await edge.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBe(336);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(width).toBe(272);
  await page.screenshot({ path: test.info().outputPath("resized.png"), animations: "disabled" });

  await page.mouse.move(box.x + box.width / 2 + 16, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1200, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(edge).toHaveAttribute("aria-valuenow", "420");
  await expect.poll(width).toBe(420);

  await page.reload();
  await expect.poll(width).toBe(420);

  await edge.dblclick();
  await expect.poll(width).toBe(256);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SESSIONS)).toBeNull();

  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(edge).toHaveCount(0);
});

// The stage's column at its narrowest, and the page's insets beside it.
const STAGE_ROOM = 536;
const FOLDED_RAIL = 56;

test("the chat grows until the stage reaches its minimum, and keeps its width through a smaller window", async ({
  page,
  ui,
}) => {
  test.skip(isPhone(page), "A phone has no rail");
  await ui.open("running");
  await ui.picture();
  const edge = page.getByRole("separator", { name: "Conversation width" });
  const chat = page.locator(".rail-chat");
  const stage = page.locator(".stage-col");
  await expect(edge).toHaveAttribute("aria-valuenow", "368");
  const wide = 1440 - STAGE_ROOM - FOLDED_RAIL;
  const width = async () => Math.round((await chat.boundingBox())?.width ?? 0);
  const saved = () => page.evaluate((key) => localStorage.getItem(key), CHAT);

  const box = await edge.boundingBox();
  if (!box) throw new Error("The chat's edge is not on screen");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(40, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(width).toBe(wide);
  await expect(edge).toHaveAttribute("aria-valuemax", String(wide));
  await expect.poll(saved).toBe(String(wide));

  // What the stage holds at its narrowest still fits in its column.
  await expect
    .poll(async () => (await stage.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(520);
  const column = await stage.boundingBox();
  const island = await page.locator(".island-plate").boundingBox();
  const brand = await page.locator(".bar-brand").boundingBox();
  const controls = await page.locator(".bar-r").boundingBox();
  if (!column || !island || !brand || !controls) throw new Error("The stage is not whole");
  expect(island.x).toBeGreaterThanOrEqual(column.x);
  expect(island.x + island.width).toBeLessThanOrEqual(column.x + column.width);
  expect(brand.x + brand.width).toBeLessThanOrEqual(controls.x);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("widest.png"), animations: "disabled" });

  await edge.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBe(wide);
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBe(wide - 16);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBe(wide);

  // A smaller window takes what it must and hands it back: what was saved stands.
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect.poll(width).toBe(1200 - STAGE_ROOM - FOLDED_RAIL);
  await expect(edge).toHaveAttribute("aria-valuemax", String(1200 - STAGE_ROOM - FOLDED_RAIL));
  expect(await saved()).toBe(String(wide));
  // A press that moves nothing doesn't make the smaller width the saved one.
  const narrower = await edge.boundingBox();
  if (!narrower) throw new Error("The chat's edge is not on screen");
  await page.mouse.click(narrower.x + narrower.width / 2, narrower.y + narrower.height / 2);
  expect(await saved()).toBe(String(wide));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(width).toBe(wide);

  // The conversations opening take their room from the chat, not from the stage's minimum.
  await page.getByRole("button", { name: "Expand conversations" }).click();
  await expect.poll(width).toBe(1440 - STAGE_ROOM - 256);
  await expect
    .poll(async () => (await stage.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(520);
  await page.getByRole("button", { name: "Collapse conversations" }).click();
  await expect.poll(width).toBe(wide);

  // Double-click goes back to where it started, and forgets the width.
  await edge.dblclick();
  await expect.poll(width).toBe(368);
  await expect.poll(saved).toBeNull();
});

test("a phone has no handle to size the conversations", async ({ page, ui }) => {
  test.skip(!isPhone(page), "Only a phone");
  await ui.open("conversations");
  await expect(page.getByRole("button", { name: /Conversations/ }).first()).toBeVisible();
  await expect(page.locator(".rail-resize-sessions")).toHaveCount(0);
});
