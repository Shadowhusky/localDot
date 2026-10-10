import { composer, expect, test } from "./harness.ts";

test.use({ fixedClock: false, reducedMotion: "no-preference" });

for (const fallback of [false, true]) {
  test(`mobile input stays responsive with ${fallback ? "fallback" : "native"} sizing`, async ({
    page,
    ui,
    browserName,
  }) => {
    test.skip(!["c39", "w39"].includes(test.info().project.name));
    if (fallback)
      await page.addInitScript(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = ((property: string, value?: string) =>
          property === "field-sizing"
            ? false
            : value === undefined
              ? supports(property)
              : supports(property, value)) as typeof CSS.supports;
      });
    const fixture = await ui.open("running");
    const box = (await composer(page)).getByRole("textbox", { name: "Message" });
    if (fallback) await box.evaluate((field) => field.style.setProperty("field-sizing", "fixed"));
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering", "");
    await box.focus();
    // Browser automation has no software keyboard; exercise the app's reduced visual viewport.
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      Object.defineProperty(viewport, "height", {
        configurable: true,
        get: () => window.innerHeight - 300,
      });
      viewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator(".app")).toHaveAttribute("data-keyboard", "");
    const emptyHeight = await box.evaluate((field) => field.getBoundingClientRect().height);
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : undefined;
    await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await cdp?.send("Performance.enable");
    await page.request.post(`${fixture.origin}/__qa/stream?ms=30000`);
    await expect.poll(() => page.locator(".thread-scroll").innerText()).toContain("cell20");
    // Settle the large paste before measuring continuing input in a capped field.
    await box.fill("Please check the application and explain the result. ".repeat(25));
    await expect
      .poll(() => box.evaluate((field) => field.clientHeight))
      .toBeGreaterThan(emptyHeight * 2);
    await ui.settle();
    const before = await cdp?.send("Performance.getMetrics");
    await box.evaluate((field) => {
      const samples: number[] = [];
      const writes: string[] = [];
      Object.assign(window, { inputSamples: samples, inputWrites: writes });
      new MutationObserver((records) => {
        for (const record of records)
          if (record.attributeName === "style") writes.push((field as HTMLElement).style.height);
      }).observe(field, { attributes: true });
      field.addEventListener(
        "input",
        (event) => {
          const started = event.timeStamp;
          requestAnimationFrame(() => {
            field.getBoundingClientRect();
            samples.push(performance.now() - started);
          });
        },
        { capture: true },
      );
    });
    // Mobile keyboards can send input without a keydown. Include wrapping, deletion and a long draft.
    for (const word of ["hello", " world", "\n", "下一步", "检查页面"])
      await page.keyboard.insertText(word);
    await box.pressSequentially(" and keep the existing changes", { delay: 40 });
    await box.press("Backspace");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const after = await cdp?.send("Performance.getMetrics");
    const stats = await page.evaluate(() => {
      const { inputSamples, inputWrites } = window as unknown as {
        inputSamples: number[];
        inputWrites: string[];
      };
      const sorted = inputSamples.toSorted((a, b) => a - b);
      return {
        samples: sorted.length,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        max: sorted.at(-1),
        heightWrites: inputWrites.length,
        native: CSS.supports("field-sizing", "content"),
      };
    });
    const metrics = Object.fromEntries(
      (after?.metrics ?? [])
        .filter((m) => /Layout|RecalcStyle/.test(m.name))
        .map((m) => [
          m.name,
          m.value - (before?.metrics.find((v) => v.name === m.name)?.value ?? 0),
        ]),
    );
    test.info().annotations.push({
      type: "input to next frame",
      description: JSON.stringify({ ...stats, ...metrics }),
    });
    await test.info().attach("typing-metrics", {
      body: JSON.stringify({ ...stats, ...metrics }),
      contentType: "application/json",
    });
    await cdp?.detach();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(/下一步检查页面 and keep the existing change$/);
    expect(stats.samples).toBe(36);
    expect(stats.p95).toBeLessThan(150);
    // A full field must stay put while typing, rather than collapse and re-expand for every key.
    expect(stats.heightWrites).toBeLessThanOrEqual(2);
    await box.fill("");
    await expect
      .poll(() => box.evaluate((field) => field.getBoundingClientRect().height))
      .toBeCloseTo(emptyHeight, 0);
    // Our paste handler edits the DOM directly and prevents the browser's input event.
    await box.evaluate((field) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "First line\nSecond line\nThird line\nFourth line");
      field.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    });
    await expect(box).toHaveValue("First line\nSecond line\nThird line\nFourth line");
    await expect
      .poll(() => box.evaluate((field) => field.getBoundingClientRect().height))
      .toBeGreaterThan(emptyHeight * 2);
    await expect(box).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("mobile-draft.png") });
  });
}
