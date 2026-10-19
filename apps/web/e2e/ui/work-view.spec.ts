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
  await expect(work.getByRole("button", { name: "Follow work" })).toBeVisible();
  await page.request.post(`${fixture.origin}/__qa/work?kind=browser`);
  await expect(output).toBeVisible();
  await work.getByRole("button", { name: "Follow work" }).click();
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
    await output.dispatchEvent("wheel", { deltaY: 1 });
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
  await page.getByRole("slider", { name: "Replay timeline" }).focus();
  await page.keyboard.press("Home");
  await expect(work).toHaveCount(0);
});
