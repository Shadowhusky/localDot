import { expect, isPhone, runAt, test } from "./harness.ts";

// The conversations rail, expanded, is resized by the same handle as the chat panel.
runAt("c14", "w14", "c39");

const PANELS = "localdot.panels.v1";
const SESSIONS = "localdot.width.sessions";

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

test("a phone has no handle to size the conversations", async ({ page, ui }) => {
  test.skip(!isPhone(page), "Only a phone");
  await ui.open("conversations");
  await expect(page.getByRole("button", { name: /Conversations/ }).first()).toBeVisible();
  await expect(page.locator(".rail-resize-sessions")).toHaveCount(0);
});
