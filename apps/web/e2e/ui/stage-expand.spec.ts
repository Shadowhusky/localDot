import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("fullscreen affordance fades, wakes on the picture, and remains available to keyboards", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await ui.picture();
  const expand = page.locator(".stage-expand");
  const button = expand.getByRole("button", { name: "Full screen" });
  const picture = page.locator(".stage");
  const effects: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/"))
      effects.push(new URL(request.url()).pathname);
  });
  await expect(expand).toHaveCSS("opacity", "0");
  await expect(expand).toHaveCSS("pointer-events", "none");
  await picture.click({ position: { x: 30, y: 30 } });
  await expect(expand).toHaveCSS("opacity", "1");
  await expect(page.locator(".app")).not.toHaveAttribute("data-focus");
  await expect(expand).toHaveCSS("opacity", "0");
  // Pointer motion wakes it again even when the pointer never leaves the picture.
  await picture.hover({ position: { x: 50, y: 50 } });
  await expect(expand).toHaveCSS("opacity", "1");
  await expect(expand).toHaveCSS("opacity", "0");
  await page.keyboard.press("Tab");
  await button.focus();
  await expect(expand).toHaveCSS("opacity", "1");
  await expect(expand).toHaveAttribute("data-still", "true");
  await expect(expand).toHaveCSS("opacity", "1");
  expect(effects, "revealing fullscreen must not take control or restart the stream").toEqual([]);
  await page.screenshot({ path: test.info().outputPath("keyboard-focus.png") });
});
