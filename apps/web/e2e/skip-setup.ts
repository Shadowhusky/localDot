import type { Page } from "@playwright/test";

// First-run setup covers the app until a model is chosen; flows that test what is under it start
// with setup put off, as Finish later leaves it.
export async function skipSetup(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!localStorage.getItem("localdot.onboarding.v1"))
      localStorage.setItem(
        "localdot.onboarding.v1",
        JSON.stringify({ step: "welcome", dismissed: true }),
      );
  });
}
