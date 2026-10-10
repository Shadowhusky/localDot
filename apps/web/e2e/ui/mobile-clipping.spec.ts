import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");

test("settings sections keep their controls inside a narrow phone sheet", async ({ page, ui }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ui.open("ready");
  const sheet = await openSettings(page);
  for (const name of [
    "Models",
    "Autonomy",
    "Always allow",
    "Spending",
    "Appearance",
    "Voice",
    "Notifications",
    "What dot knows",
    "Accounts",
    "Connectors",
    "Keys",
    "Your computer",
  ]) {
    await sheet.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    const current = sheet.locator(".ui-sheet-page:not([inert])").last();
    await sheet.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await ui.settle();
    const clipped = await current
      .locator("button:visible, input:visible, textarea:visible")
      .evaluateAll((controls) =>
        controls.flatMap((control) => {
          const box = control.getBoundingClientRect();
          return box.left < -1 || box.right > innerWidth + 1
            ? [control.getAttribute("aria-label") ?? control.textContent ?? control.tagName]
            : [];
        }),
      );
    await page.screenshot({ path: test.info().outputPath(`settings-${name}.png`) });
    expect(clipped, name).toEqual([]);
    await current.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(sheet.locator(".ui-sheet-page[data-leaving]")).toHaveCount(0);
  }
});

for (const scenario of [
  "model-ready",
  "starting",
  "failed",
  "fenced",
  "fresh-start",
  "off",
] as const) {
  test(`${scenario} keeps recovery content and actions inside the mobile curtain`, async ({
    page,
    ui,
  }) => {
    await ui.open(scenario);
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const curtain = page.locator(".curtain");
    await expect(curtain).toBeVisible();
    for (const viewport of [
      { width: 320, height: 568, fontSize: 16 },
      { width: 390, height: 664, fontSize: 16 },
      { width: 430, height: 844, fontSize: 16 },
      { width: 844, height: 390, fontSize: 16 },
      { width: 320, height: 568, fontSize: 24 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, viewport.fontSize);
      await ui.settle();
      const clipped = await curtain.evaluate((panel) => {
        const frame = panel.getBoundingClientRect();
        return [
          ...panel.querySelectorAll<HTMLElement>(".curtain-title, .curtain-sub, .curtain-button"),
        ]
          .filter((element) => getComputedStyle(element).visibility !== "hidden")
          .flatMap((element) => {
            const box = element.getBoundingClientRect();
            const failures = [];
            if (
              box.left < frame.left ||
              box.right > frame.right ||
              box.top < frame.top ||
              box.bottom > frame.bottom
            )
              failures.push(`${element.className}: outside panel`);
            if (element.scrollWidth > element.clientWidth + 1)
              failures.push(`${element.className}: horizontal overflow`);
            if (element.tagName === "BUTTON") {
              for (const y of [box.top + 4, box.bottom - 4]) {
                const hit = document.elementFromPoint(box.left + box.width / 2, y);
                if (!hit || !element.contains(hit))
                  failures.push(`${element.textContent}: clipped tap target`);
              }
            }
            return failures;
          });
      });
      expect(
        clipped,
        `${scenario} at ${viewport.width} × ${viewport.height}, ${viewport.fontSize}px text`,
      ).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath(`${scenario}-${viewport.width}-${viewport.fontSize}.png`),
      });
    }
  });
}

for (const scenario of ["running", "approval", "ask", "takeover", "budget", "done"] as const) {
  test(`${scenario} keeps mobile task controls within their visible containers`, async ({
    page,
    ui,
  }) => {
    await ui.open(scenario);
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 664 });
      await ui.settle();
      const problems = await page
        .locator(".thread-toolbar button:visible, .island button:visible")
        .evaluateAll((buttons) => {
          const problems: string[] = [];
          for (const button of buttons) {
            const box = button.getBoundingClientRect();
            const name = button.getAttribute("aria-label") ?? button.textContent;
            if (
              box.left < -1 ||
              box.top < -1 ||
              box.right > innerWidth + 1 ||
              box.bottom > innerHeight + 1
            )
              problems.push(`${name}: outside viewport`);
            for (let parent = button.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              const bounds = parent.getBoundingClientRect();
              if (
                /hidden|clip/.test(style.overflowX) &&
                (box.left < bounds.left - 1 || box.right > bounds.right + 1)
              )
                problems.push(`${name}: clipped horizontally by ${parent.className}`);
              if (
                /hidden|clip/.test(style.overflowY) &&
                (box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1)
              )
                problems.push(`${name}: clipped vertically by ${parent.className}`);
            }
          }
          return problems;
        });
      expect(problems, `${scenario} at ${width}px`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`${scenario}-${width}.png`) });
    }
  });
}

test("larger text does not turn an empty narrow composer into a tall column", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
  });
  const field = page.getByRole("textbox", { name: "Message", exact: true });
  await ui.settle();
  expect((await field.boundingBox())?.height).toBeLessThan(64);
  await field.fill("First line\nSecond line\nThird line");
  await ui.settle();
  expect((await field.boundingBox())?.height).toBeGreaterThan(64);
  await field.fill("");
  await ui.settle();
  expect((await field.boundingBox())?.height).toBeLessThan(64);
  const band = await page.locator(".stage-band").boundingBox();
  const narration = await page.locator(".narration-line").boundingBox();
  expect(narration && band && narration.y + narration.height <= band.y + band.height).toBe(true);
  await page.screenshot({ path: test.info().outputPath("large-text-composer.png") });
});
