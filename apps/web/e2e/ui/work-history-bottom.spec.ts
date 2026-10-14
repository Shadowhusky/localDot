import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
for (const height of [568, 680, 844]) {
  test(`Working disclosure reaches the entire final step at ${height}px`, async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height });
    const fixture = await ui.open("running");
    const added = await page.request.post(
      `${fixture.origin}/__qa/steps?n=110&label=${encodeURIComponent("Checking the final multiline step stays fully visible above the composer")}`,
    );
    expect(added.ok(), await added.text()).toBe(true);
    const working = page.locator(".thread-live .ui-disclosure-summary");
    await expect(working).toContainText("Working");
    await working.click();
    const pane = page.locator(".thread-live .thread-work-scroll");
    await expect(pane).toBeVisible();
    await expect(pane.locator(".thread-work-step")).toHaveCount(116);
    await pane.dispatchEvent("touchstart");
    await pane.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await ui.settle();
    const last = pane.locator(".thread-work-step").last();
    expect(
      await last
        .locator(".thread-work-title")
        .evaluate(
          (node) =>
            node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight),
        ),
    ).toBeGreaterThan(1);
    const geometry = await last.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const clips = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          clips.push({
            name: parent.className,
            bottom: parent.getBoundingClientRect().bottom,
            top: parent.getBoundingClientRect().top,
          });
        }
      }
      return {
        bottom: r.bottom,
        clips,
        hit: node.contains(document.elementFromPoint(r.x + r.width / 2, r.bottom - 2)),
      };
    });
    expect(geometry.hit, JSON.stringify(geometry)).toBe(true);
    for (const clip of geometry.clips)
      expect(geometry.bottom, clip.name).toBeLessThanOrEqual(clip.bottom);
    const toolbar = await page.locator(".thread-toolbar").boundingBox();
    expect(geometry.bottom).toBeLessThanOrEqual(toolbar?.y ?? height);
    await page.screenshot({ path: test.info().outputPath("work-history-bottom.png") });
  });
}
