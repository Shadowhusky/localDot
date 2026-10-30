import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("background work is readable, pinnable, bounded and yields to the actual browser", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const work = page.getByRole("region", { name: "Work display" });
  await expect(work.getByRole("combobox", { name: "Display view" })).toBeVisible();
  const stage = page.locator(".watch .stage canvas").first();
  const original = await stage.elementHandle();
  await page.request.post(`${fixture.origin}/__qa/work`);
  const output = work.getByLabel("Work output");
  await expect(output).toContainText("Checking the project");
  await page.request.post(
    `${fixture.origin}/__qa/work?kind=output&text=${encodeURIComponent("line\n".repeat(2000) + "LAST LINE")}`,
  );
  await expect(output).toContainText("LAST LINE");
  expect((await output.textContent())?.length).toBeLessThan(6500);
  await output.dispatchEvent("wheel", { deltaY: 100 });
  await output.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await expect(work.getByRole("combobox", { name: "Display view" })).toContainText("Work");
  if ((page.viewportSize()?.width ?? 0) < 700) {
    const box = await work.locator(".work-controls").boundingBox();
    expect(box?.height).toBe(44);
    const follow = await work.getByRole("button", { name: "Follow work" }).boundingBox();
    expect(follow?.height).toBe(44);
  }
  await page.request.post(`${fixture.origin}/__qa/work?kind=browser`);
  await expect(output).toBeVisible();
  await work.getByRole("combobox", { name: "Display view" }).click();
  await page.getByRole("option", { name: "Auto", exact: true }).click();
  await expect(output).toHaveCount(0);
  expect(await original?.evaluate((e) => e.isConnected)).toBe(true);
  await page.request.post(`${fixture.origin}/__qa/work?kind=files`);
  await expect(output).toContainText("report.csv");
  await expect(output).toContainText("+total,24");
  expect(await output.evaluate((e) => e.getBoundingClientRect().right <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath("work-files.png") });
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await expect(output).toContainText("report.csv");
  await expect(work.getByRole("combobox", { name: "Display view" })).toHaveCount(0);
  await page.getByRole("button", { name: "Stream settings", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Stream settings" });
  await expect(menu.getByRole("group", { name: "Display view" })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Stream quality" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("fullscreen-settings.png") });
  await menu.getByRole("menuitemradio", { name: "Screen Watch the computer", exact: true }).click();
  await expect(output).toHaveCount(0);
  await page.getByRole("button", { name: "Stream settings", exact: true }).click();
  await menu
    .getByRole("group", { name: "Display view" })
    .getByRole("menuitemradio", { name: /^Auto/ })
    .click();
  await expect(output).toContainText("report.csv");
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await expect(output).toContainText("report.csv");

  await work.getByRole("combobox", { name: "Display view" }).click();
  await page.getByRole("option", { name: "Screen", exact: true }).click();
  await expect(output).toHaveCount(0);
  await page.request.post(`${fixture.origin}/__qa/work`);
  await expect(output).toHaveCount(0);
});

for (const scenario of ["ask", "approval", "takeover"] as const) {
  test(`work display yields to ${scenario} even when pinned`, async ({ page, ui }) => {
    const fixture = await ui.open("running");
    await page.request.post(`${fixture.origin}/__qa/work`);
    const output = page.getByLabel("Work output");
    await expect(output).toBeVisible();
    await output.press("PageDown");
    await expect(page.getByRole("button", { name: "Follow work" })).toBeVisible();
    await ui.step(scenario);
    await expect(page.getByLabel("Work display")).toHaveCount(0);
  });
}

test("previews a saved image without refetching it when switching back from Screen", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("image-output");
  const downloads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/files/step-image-")) downloads.push(request.url());
  });
  await page.request.post(`${fixture.origin}/__qa/work?kind=image`);
  const work = page.getByLabel("Work display");
  const image = work.getByRole("img", { name: "Saved work preview" });
  await expect(image).toBeVisible();
  expect(await image.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(640);
  // The preview uses the scroll viewport rather than a fixed thumbnail cap. Keep the image
  // above the controls; the text remains reachable below it without resizing the actual screen.
  const checkImageFit = async () => {
    const metrics = await image.evaluate((e) => {
      const output = e.closest(".work-content") as HTMLElement;
      const style = getComputedStyle(output);
      const available =
        output.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const bounds = e.getBoundingClientRect();
      const img = e as HTMLImageElement;
      const expected = Math.min(available, (bounds.width * img.naturalHeight) / img.naturalWidth);
      return {
        height: bounds.height,
        expected,
        available,
        width: bounds.width,
        outputWidth: output.clientWidth,
      };
    });
    expect(metrics.height).toBeGreaterThan(0);
    expect(Math.abs(metrics.height - metrics.expected)).toBeLessThan(2);
    expect(metrics.width).toBeLessThanOrEqual(metrics.outputWidth);
    return metrics.height;
  };
  await checkImageFit();
  await page.screenshot({ path: test.info().outputPath("work-image.png") });
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await checkImageFit();
  if (test.info().project.name === "c14") expect(await checkImageFit()).toBeGreaterThan(200);
  await page.screenshot({ path: test.info().outputPath("work-image-full.png") });
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await checkImageFit();
  const count = downloads.length;
  await work.getByRole("combobox", { name: "Display view" }).click();
  await page.getByRole("option", { name: "Screen", exact: true }).click();
  await expect(image).toHaveCount(0);
  await work.getByRole("combobox", { name: "Display view" }).click();
  await page.getByRole("option", { name: "Auto", exact: true }).click();
  await expect(image).toBeVisible();
  expect(downloads).toHaveLength(count);
});

test("replay shows recorded work at the end and removes it when seeking before the work", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/work?kind=files`);
  await expect(page.getByLabel("Work output")).toContainText("report.csv");
  await page.goto(`${fixture.origin}/?replay=${fixture.sessionId}&t=999999`);
  const work = page.locator(".replay").getByLabel("Work output");
  await expect(work).toContainText("report.csv");
  const picker = page.getByRole("combobox", { name: "Recording view" });
  await expect(picker).toHaveCount(1);
  await expect(picker).toContainText("Work");
  await expect(page.locator(".replay .work-controls")).toHaveCount(0);
  const timeline = page.getByRole("slider", { name: "Replay timeline" });
  const time = await timeline.getAttribute("aria-valuenow");
  const canvas = await page.locator(".replay .stage canvas").first().elementHandle();
  await picker.click();
  const options = page.getByRole("listbox", { name: "Recording view" });
  await expect(options.getByRole("option")).toHaveCount(2);
  await options.getByRole("option", { name: "Screen Show the active screen", exact: true }).click();
  await expect(work).toHaveCount(0);
  await expect(timeline).toHaveAttribute("aria-valuenow", time ?? "");
  await picker.click();
  await page
    .getByRole("option", { name: "Work Follow work and screen changes", exact: true })
    .click();
  await expect(work).toContainText("report.csv");
  await expect(timeline).toHaveAttribute("aria-valuenow", time ?? "");
  expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true);
  await picker.click();
  await ui.settle();
  await expect(page.locator(".ui-picker").filter({ has: options })).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: test.info().outputPath("recording-view-menu.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await timeline.focus();
  await page.keyboard.press("Home");
  await expect(work).toHaveCount(0);
});

test("refresh waits for slow history and reveals the restored work without a desktop flash", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/work`);
  await expect(page.getByLabel("Work output")).toContainText("Checking the project");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/*/history", async (route) => {
    await held;
    await route.continue();
  });
  await page.addInitScript(() => {
    const samples: string[] = [];
    (window as unknown as { restorationSamples: string[] }).restorationSamples = samples;
    const sample = () => {
      const watch = document.querySelector(".watch");
      if (watch && !watch.hasAttribute("hidden") && !watch.querySelector(".curtain")) {
        samples.push(watch.querySelector(".work-content")?.textContent ?? "SCREEN");
      }
      if (samples.length < 120) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.reload();
  await expect(page.locator(".curtain")).toBeVisible();
  // The old two-second escape hatch used to reveal the wrong screen here.
  await page.waitForTimeout(2500);
  await expect(page.locator(".curtain")).toBeVisible();
  release();
  await expect(page.locator(".curtain")).toHaveCount(0);
  await expect(page.getByLabel("Work output")).toContainText("Checking the project");
  const samples = await page.evaluate(
    () => (window as unknown as { restorationSamples: string[] }).restorationSamples,
  );
  expect(samples.length).toBeGreaterThan(0);
  expect(
    samples.every((text) => text.includes("Checking the project")),
    JSON.stringify(samples),
  ).toBe(true);
});

test("returning to the app retains work and never announces an off computer", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await ui.picture();
  await page.request.post(`${fixture.origin}/__qa/work`);
  await expect(page.getByLabel("Work output")).toContainText("Checking the project");
  const canvas = await page.locator(".watch .stage canvas").first().elementHandle();
  for (let turn = 0; turn < 3; turn++) {
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByLabel("Work output")).toContainText("Checking the project");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByText("Your computer is off", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Work output")).toContainText("Checking the project");
    expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true);
  }
});

test("missing Docker shows a prerequisite and follows recovery instead of a starting spinner", async ({
  page,
  ui,
}) => {
  let runtime = { docker: "unavailable", startup: "waiting" };
  await page.route("**/api/runtime", (route) => route.fulfill({ json: runtime }));
  await ui.open("starting");
  await expect(page.getByRole("heading", { name: "Docker isn't available" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Starting your computer" })).toHaveCount(0);
  runtime = { docker: "ready", startup: "recovering" };
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("heading", { name: "Restoring your computer" })).toBeVisible();
  runtime = { docker: "ready", startup: "ready" };
  await page.getByRole("button", { name: "Check again" }).click();
  await ui.step("ready");
  await expect(page.locator(".curtain")).toHaveCount(0);
});

test("fullscreen settings stay reachable on landscape phones", async ({ page, ui }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 700, "Phone rotation");
  await ui.open("running");
  await ui.picture();
  await ui.settle();
  // Phones enter focus automatically when rotated, without requesting native fullscreen.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".app")).toHaveAttribute("data-focus", "");
  await page.getByRole("button", { name: "Stream settings", exact: true }).tap();
  const menu = page.getByRole("menu", { name: "Stream settings" });
  const bounds = await menu.boundingBox();
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect(bounds && bounds.y + bounds.height).toBeLessThanOrEqual(390);
  const quality = menu.getByRole("menuitemradio", {
    name: "Smooth Keep motion fluid",
    exact: true,
  });
  await quality.scrollIntoViewIfNeeded();
  await quality.tap();
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "Stream settings", exact: true }).tap();
  await expect(
    menu.getByRole("menuitemradio", { name: "Smooth Keep motion fluid", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(menu).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: test.info().outputPath("fullscreen-landscape-settings.png"),
    animations: "disabled",
  });
});
