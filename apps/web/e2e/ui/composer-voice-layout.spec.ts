import { composer, expect, runAt, test } from "./harness.ts";

runAt("c14", "w14", "c39", "w39");

for (const width of [320, 390, 1440]) {
  test(`compact long-press voice input at ${width}px`, async ({ page, ui }) => {
    await page.setViewportSize({ width, height: 900 });
    // Exercise real composer transitions without recording the tester's microphone.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        value: { brands: [{ brand: "Google Chrome" }] },
      });
      class Recognition {
        static async available() {
          return "available";
        }
        onstart: (() => void) | null = null;
        onspeechstart: (() => void) | null = null;
        onspeechend: (() => void) | null = null;
        constructor() {
          window.addEventListener("test-speech-start", () => this.onspeechstart?.());
          window.addEventListener("test-speech-end", () => this.onspeechend?.());
        }
        onend: (() => void) | null = null;
        start() {
          queueMicrotask(() => this.onstart?.());
        }
        stop() {
          window.addEventListener("finish-test-speech", () => this.onend?.(), { once: true });
        }
        abort() {
          this.onend?.();
        }
      }
      Object.defineProperty(window, "SpeechRecognition", {
        value: Recognition,
        configurable: true,
        writable: true,
      });
    });
    await ui.open("running");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const card = await composer(page);
    const send = card.locator(".composer-send");
    await expect(card.locator(".voice-mic")).toHaveCount(0);
    await expect(card.getByText("Hold to speak", { exact: true })).toBeVisible();
    const idle = await card.boundingBox();
    expect(idle?.height).toBeLessThanOrEqual(110);
    const initialLabel = await send.getAttribute("aria-label");
    await page.screenshot({ path: test.info().outputPath("idle.png") });
    // A real pointer sequence includes the synthesized click on release.
    const target = await send.boundingBox();
    if (!target) throw new Error("Missing Send button");
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await expect(send).toHaveAccessibleName("Finish speaking");
    await page.mouse.up();
    await expect(send).toHaveAccessibleName("Finish speaking");
    const recording = await card.boundingBox();
    expect(recording?.height).toBe(idle?.height);
    await expect(card.locator(".composer-model")).toBeHidden();
    const waveform = card.locator(".voice-strip");
    await expect(waveform).toHaveAttribute("data-phase", "listening");
    const wave = await waveform.boundingBox();
    const finish = await send.boundingBox();
    expect(wave && finish && wave.x + wave.width <= finish.x).toBe(true);
    expect(
      await send.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
    ).toBe(true);
    // Inspect the newest bar, not a finishing animation or an old history sample.
    const newestBar = () =>
      waveform.locator("canvas").evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const ctx = canvas.getContext("2d")!;
        const ratio = window.devicePixelRatio || 1;
        const x = Math.floor((Math.floor(canvas.clientWidth / 5) - 1) * 5 * ratio);
        const pixels = ctx.getImageData(x, 0, Math.max(1, Math.floor(3 * ratio)), canvas.height);
        let rows = 0;
        for (let y = 0; y < pixels.height; y++) {
          if (
            Array.from(
              { length: pixels.width },
              (_, x) => pixels.data[(y * pixels.width + x) * 4 + 3],
            ).some((alpha) => alpha! > 0)
          )
            rows++;
        }
        return rows / ratio;
      });
    await page.evaluate(() => window.dispatchEvent(new Event("test-speech-start")));
    await expect.poll(newestBar).toBeGreaterThan(6);
    await page.screenshot({ path: test.info().outputPath("recording.png") });
    await page.evaluate(() => window.dispatchEvent(new Event("test-speech-end")));
    await expect.poll(newestBar).toBeLessThanOrEqual(4);
    await send.click();
    await expect(send).toHaveAccessibleName("Transcribing speech");
    await page.evaluate(() => window.dispatchEvent(new Event("finish-test-speech")));
    await expect(send).toHaveAccessibleName(initialLabel ?? "Stop");
    await expect(card.locator(".composer-model")).toBeHidden(); // Empty speech notice occupies the row.
    await card.getByRole("button", { name: "Dismiss voice notice" }).click();
    await expect(card.locator(".composer-model")).toBeVisible();
    expect((await card.boundingBox())?.height).toBe(idle?.height);
  });
}
