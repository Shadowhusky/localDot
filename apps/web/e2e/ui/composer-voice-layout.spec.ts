import { composer, expect, runAt, test } from "./harness.ts";

runAt("c14", "w14", "c39", "w39");

for (const width of [320, 390, 1440]) {
  test(`microphone and Send stay separate through recording at ${width}px`, async ({
    page,
    ui,
  }) => {
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
    const mic = card.locator(".voice-mic > button");
    const send = card.locator(".composer-send");
    const separate = async () => {
      const m = await mic.boundingBox();
      const s = await send.boundingBox();
      expect(m && s && Math.max(s.x - m.x - m.width, s.y - m.y - m.height)).toBeGreaterThanOrEqual(
        8,
      );
      for (const button of [mic, send]) {
        expect(
          await button.evaluate((element) => {
            const r = element.getBoundingClientRect();
            return [0.1, 0.5, 0.9].every((x) =>
              element.contains(document.elementFromPoint(r.x + r.width * x, r.y + r.height / 2)),
            );
          }),
        ).toBe(true);
      }
      const halo = await card.locator(".voice-mic-halo").boundingBox();
      expect(halo && s && (halo.x + halo.width <= s.x || halo.y + halo.height <= s.y)).toBe(true);
    };
    await expect(mic).not.toHaveAttribute("aria-disabled", "true");
    await mic.hover();
    await page.screenshot({ path: test.info().outputPath("idle.png") });

    await separate();
    await mic.click();
    await expect(card.locator(".voice-mic")).toHaveAttribute("data-voice", "listening");
    await expect(mic).toHaveAccessibleName("Tap to finish");
    await separate();
    await page.screenshot({ path: test.info().outputPath("recording.png") });
    await mic.click();
    await expect(card.locator(".voice-mic")).toHaveAttribute("data-voice", "finishing");
    await separate();
    await page.evaluate(() => window.dispatchEvent(new Event("finish-test-speech")));
    await expect(card.locator(".voice-mic")).not.toHaveAttribute("data-voice");
    await separate();
  });
}
