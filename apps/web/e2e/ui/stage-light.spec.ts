import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("dot's light and colour hold through each turn dot takes and an approval it waits on", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await expect(page.locator(".stage-frame")).toHaveAttribute("data-light", "dot");
  await expect(page.locator(".app")).toHaveClass(/\bcontrol\b/);
  // Every value the light and dot's colour take from here on, as the page draws them.
  await page.evaluate(() => {
    const frame = document.querySelector(".stage-frame");
    const app = document.querySelector(".app");
    if (!frame || !app) throw new Error("No stage");
    const seen: string[] = [];
    Object.assign(window, { seenLight: seen });
    const note = () =>
      seen.push(`${frame.getAttribute("data-light")} ${app.classList.contains("control")}`);
    const watch = new MutationObserver(note);
    watch.observe(frame, { attributes: true, attributeFilter: ["data-light"] });
    watch.observe(app, { attributes: true, attributeFilter: ["class"] });
  });
  const turns = await page.request.post(`${fixture.origin}/__qa/turns?n=8`);
  expect(turns.ok(), await turns.text()).toBe(true);
  await ui.step("approval");
  await expect(page.getByTestId("hud-status")).toHaveText("Needs your OK");
  const seen = await page.evaluate(() => (window as unknown as { seenLight: string[] }).seenLight);
  expect(seen.filter((value) => value !== "dot true")).toEqual([]);
});

test("the rim holds a moment before it goes out, but never when the computer changes hands", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const frame = page.locator(".stage-frame");
  await expect(frame).toHaveAttribute("data-light", "dot");
  const rim = page.locator('.stage-rim > [data-light="dot"]');
  await expect.poll(() => rim.evaluate((light) => getComputedStyle(light).opacity)).toBe("1");
  // Each light, the rim's and the spill's, waits only on its way out to the hairline.
  const holds = await frame.evaluate((stage) => {
    const lights = [...stage.querySelectorAll(".stage-rim > i, .stage-spill > i")];
    const holdIn = (light: string) => {
      stage.setAttribute("data-light", light);
      return [...new Set(lights.map((i) => getComputedStyle(i).transitionDelay))];
    };
    return { none: holdIn("none"), you: holdIn("you"), dot: holdIn("dot") };
  });
  expect(holds).toEqual({ none: ["0.8s"], you: ["0s"], dot: ["0s"] });
  // Out for half a second and back: the rim never dims.
  const lowest = await frame.evaluate(async (stage) => {
    const light = stage.querySelector('.stage-rim > [data-light="dot"]') as Element;
    const until = performance.now() + 500;
    let lowest = 1;
    stage.setAttribute("data-light", "none");
    for (;;) {
      await new Promise(requestAnimationFrame);
      if (performance.now() >= until) break;
      lowest = Math.min(lowest, Number(getComputedStyle(light).opacity));
    }
    stage.setAttribute("data-light", "dot");
    return lowest;
  });
  expect(lowest).toBe(1);
  // Out for good, it goes out.
  await frame.evaluate((stage) => stage.setAttribute("data-light", "none"));
  await expect.poll(() => rim.evaluate((light) => getComputedStyle(light).opacity)).toBe("0");
  await frame.evaluate((stage) => stage.setAttribute("data-light", "dot"));
});
