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
    await page.screenshot({ path: test.info().outputPath("recording.png") });
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
