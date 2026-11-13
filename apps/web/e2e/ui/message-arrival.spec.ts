import { expect, runAt, test } from "./harness.ts";

// A message that arrives while dot works eases in, as a messenger's does, though the run it adds to
// stays below it at the end of the thread. The history a thread opens on appears as it is.
runAt("c14", "c39", "w39");

for (const view of ["chat", "studio"] as const)
  test.describe(view, () => {
    test.use({ viewStyle: view });

    test("dot's new message eases in above the run that goes on", async ({ page, ui }) => {
      const fixture = await ui.open("running");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await ui.settle();
      // The thread has drawn what it opened on, its earlier part included.
      await page.waitForTimeout(1000);
      await expect(page.locator(".thread-row[data-new]")).toHaveCount(0);
      // Its row eases in on the frame it arrives; data-new goes with the next drawing.
      await page.evaluate(() => {
        const eased: string[] = [];
        Object.defineProperty(window, "eased", { value: eased });
        new MutationObserver((records) => {
          for (const record of records)
            for (const node of record.addedNodes)
              if (node instanceof HTMLElement && node.matches(".thread-row[data-kind='message']"))
                requestAnimationFrame(() =>
                  eased.push(
                    `${node.textContent?.slice(0, 40)}: ${node
                      .getAnimations()
                      .map((motion) => (motion as CSSTransition).transitionProperty)
                      .sort()
                      .join(",")}`,
                  ),
                );
        }).observe(document.body, { childList: true, subtree: true });
      });
      await page.request.post(`${fixture.origin}/__qa/say?text=Checking%20the%20next%20part`);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { eased: string[] }).eased))
        .toContainEqual(expect.stringMatching(/Checking the next part.*: .*opacity/));
      // The run dot is at stays the thread's last row, under the new message.
      const last = page.locator(".thread-row").last();
      await expect(last).toHaveAttribute("data-kind", "work");
    });
  });
