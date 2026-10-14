import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");

for (const height of [568, 680, 844]) {
  test(`the last step and usage footer remain reachable at ${height}px`, async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height });
    await ui.open("done");
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Activity" });
    const pane = sheet.locator('[role="tabpanel"]:not([aria-hidden]) .activity-scroll');
    const last = pane.locator(".activity-row").last();
    const usage = sheet.locator(".activity-usage");
    for (const detent of ["medium", "large"]) {
      if (detent === "large") {
        const handle = await sheet.locator(".ui-sheet-handle").boundingBox();
        if (!handle) throw new Error("Missing sheet handle");
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 10);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2, 24, { steps: 12 });
        await page.mouse.up();
      }
      await expect(sheet).toHaveAttribute("data-detent", detent);
      await pane.dispatchEvent("touchstart");
      await pane.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await ui.settle();
      const geometry = await pane.evaluate((node) => ({
        height: node.clientHeight,
        scroll: node.scrollTop,
        total: node.scrollHeight,
        bottom: node.getBoundingClientRect().bottom,
      }));
      const row = await last.boundingBox();
      const footer = await usage.boundingBox();
      await expect
        .poll(() =>
          last.evaluate((node) => {
            const head = node.querySelector(".activity-row-head") ?? node;
            const rect = head.getBoundingClientRect();
            return node.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
            );
          }),
        )
        .toBe(true);
      expect(row).not.toBeNull();
      expect(footer).not.toBeNull();
      expect(geometry.bottom).toBeLessThanOrEqual(height);
      expect(footer && footer.y + footer.height).toBeLessThanOrEqual(height);
      expect(row && row.y + row.height).toBeLessThanOrEqual(
        Math.min(geometry.bottom, footer?.y ?? height),
      );
      await page.screenshot({ path: test.info().outputPath(`activity-${height}-${detent}.png`) });
    }
  });
}
