import { expect, test } from "./harness.ts";

type Box = { x: number; y: number; width: number; height: number };
type Frame = {
  empty: Box;
  composer: Box;
  scrollTop: number;
  overflow: number;
};

declare global {
  interface Window {
    conversationLayoutFrames: Frame[];
  }
}

// Reduced motion hides the scroll-overflow bug caused by translating the whole thread.
// Sample actual frames: matching only the before/after positions misses the snap in between.
for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test.describe(`conversation layout with ${reducedMotion}`, () => {
    test.use({ fixedClock: false, reducedMotion });

    for (const scenario of ["continued", "conversations"] as const) {
      test(`new conversation stays in place after ${scenario}`, async ({ page, ui }) => {
        await ui.open(scenario);
        await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
        await expect(page.locator(".thread-message").first()).toBeVisible();
        await ui.settle();
        // The page entrance starts when data-entering is removed. Let that separate animation
        // finish before measuring the transition triggered by New conversation.
        await page
          .locator(".rail-panel")
          .first()
          .evaluate(async (element) => {
            await Promise.all(
              element.getAnimations().map((animation) => animation.finished.catch(() => {})),
            );
          });
        const mobile = (page.viewportSize()?.width ?? 0) < 700;
        if (mobile) await page.getByRole("button", { name: "More", exact: true }).click();
        const action = page.getByRole(mobile ? "menuitem" : "button", {
          name: "New conversation",
          exact: true,
        });
        await action.focus();
        await page.evaluate(() => {
          window.conversationLayoutFrames = [];
          const until = performance.now() + 1500;
          const tick = () => {
            const empty = document.querySelector<HTMLElement>(".thread-empty");
            const composer = document.querySelector<HTMLElement>(".composer-card");
            const scroll = document.querySelector<HTMLElement>(".thread-scroll");
            const box = (element: HTMLElement): Box => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            };
            if (empty && composer && scroll) {
              window.conversationLayoutFrames.push({
                empty: box(empty),
                composer: box(composer),
                scrollTop: scroll.scrollTop,
                overflow: scroll.scrollHeight - scroll.clientHeight,
              });
            }
            if (performance.now() < until) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await action.press("Enter");
        await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
        await page.waitForTimeout(1600);
        const frames = await page.evaluate(() => window.conversationLayoutFrames);
        await test.info().attach("layout-frames", {
          body: JSON.stringify(frames),
          contentType: "application/json",
        });
        expect(frames.length).toBeGreaterThan(10);
        for (const element of ["empty", "composer"] as const) {
          for (const dimension of ["x", "y", "width", "height"] as const) {
            const values = frames.map((frame) => frame[element][dimension]);
            expect(
              Math.max(...values) - Math.min(...values),
              `${element}.${dimension}`,
            ).toBeLessThan(1);
          }
        }
        expect(Math.max(...frames.map((frame) => Math.abs(frame.scrollTop)))).toBeLessThan(1);
        expect(Math.max(...frames.map((frame) => frame.overflow))).toBeLessThan(1);
      });
    }
  });
}
