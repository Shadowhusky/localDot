import { composer, expect, runAt, test } from "./harness.ts";

runAt("c14", "w14", "c39", "w39");

for (const width of [320, 390, 1440]) {
  test(`separate voice controls at ${width}px`, async ({ page, ui }) => {
    await page.setViewportSize({ width, height: 900 });
    // Exercise real composer transitions without recording the tester's microphone.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        value: { brands: [{ brand: "Google Chrome" }] },
      });
      let active: Recognition | null = null;
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
          window.addEventListener("test-speech-words", (event) => {
            if (active === this)
              this.onresult?.({
                results: [[{ transcript: (event as CustomEvent<string>).detail }]],
              });
          });
        }
        onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          // Model the exclusive audio service: a finished recognizer must release it before
          // another session can hear. Each emitted phrase goes through the real app adapter.
          if (active && active !== this) return;
          active = this;
          queueMicrotask(() => this.onstart?.());
        }
        stop() {
          window.addEventListener(
            "finish-test-speech",
            (event) => {
              const text = (event as CustomEvent<string>).detail || "Check the finished video";
              this.onresult?.({ results: [[{ transcript: text }]] });
              this.onend?.();
            },
            { once: true },
          );
        }
        abort() {
          if (active === this) active = null;
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
    const mic = card.getByRole("button", { name: "Start voice input" });
    await expect(mic).toBeVisible();
    const idle = await card.boundingBox();
    expect(idle?.height).toBeLessThanOrEqual(110);
    const initialLabel = await send.getAttribute("aria-label");
    const permissions = await card.locator(".composer-permissions").boundingBox();
    const micBox = await mic.boundingBox();
    const sendBox = await send.boundingBox();
    expect(permissions && micBox && permissions.x + permissions.width <= micBox.x).toBe(true);
    expect(micBox && sendBox && micBox.x + micBox.width <= sendBox.x).toBe(true);
    await page.screenshot({ path: test.info().outputPath("idle.png") });
    await mic.click();
    const stop = card.getByRole("button", { name: "Stop recording" });
    await expect(stop).toBeVisible();
    await expect(send).toHaveAccessibleName("Send voice message");
    expect((await card.boundingBox())?.height).toBe(idle?.height);
    await expect(card.locator(".composer-model")).toBeHidden();
    const waveform = card.locator(".voice-strip");
    await expect(waveform).toHaveAttribute("data-phase", "listening");
    const cancel = card.getByRole("button", { name: "Cancel recording" });
    const controls = [cancel, stop, send];
    for (const button of controls) {
      expect(
        await button.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const card = node.closest(".composer-card")?.getBoundingClientRect();
          if (!card) return false;
          return (
            r.x >= card.x &&
            r.right <= card.right &&
            node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          );
        }),
      ).toBe(true);
    }
    const wave = await waveform.boundingBox();
    const stopBox = await stop.boundingBox();
    expect(wave && stopBox && wave.x + wave.width <= stopBox.x).toBe(true);
    // Inspect the newest bar, not a finishing animation or an old history sample.
    const newestBar = () =>
      waveform.locator("canvas").evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Missing waveform context");
        const ratio = window.devicePixelRatio || 1;
        const x = Math.floor((Math.floor(canvas.clientWidth / 5) - 1) * 5 * ratio);
        const pixels = ctx.getImageData(x, 0, Math.max(1, Math.floor(3 * ratio)), canvas.height);
        let rows = 0;
        for (let y = 0; y < pixels.height; y++) {
          if (
            Array.from(
              { length: pixels.width },
              (_, x) => pixels.data[(y * pixels.width + x) * 4 + 3],
            ).some((alpha) => (alpha ?? 0) > 0)
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
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("test-speech-words", { detail: "Check" })),
    );
    await expect(card.getByRole("textbox")).toHaveValue("Check");
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("test-speech-words", { detail: "Check the finished video" }),
      ),
    );
    await expect(card.getByRole("textbox")).toHaveValue("Check the finished video");
    await stop.click();
    await expect(card.getByText("Transcribing…", { exact: true })).toBeVisible();
    await expect(card.locator(".voice-spinner")).toBeVisible();
    expect(
      await card.locator(".voice-status").evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await expect(card.locator(".voice-wave")).toHaveCount(0);
    await expect(send).toHaveAccessibleName("Send voice message");
    await page.screenshot({ path: test.info().outputPath("transcribing.png") });
    await page.evaluate(() => window.dispatchEvent(new Event("finish-test-speech")));
    await expect(mic).toBeVisible();
    await expect(card.getByRole("textbox")).toHaveValue("Check the finished video");
    await expect(send).not.toHaveAccessibleName(initialLabel ?? "Stop task");
    await expect(card.locator(".composer-model")).toBeVisible();
    // Final words may wrap onto a second line on the narrowest phone.
    expect((await card.boundingBox())?.height).toBeLessThanOrEqual((idle?.height ?? 0) + 24);
    // A second recording can be discarded without damaging that draft.
    await mic.click();
    await expect(stop).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("test-speech-words", { detail: "discard these words" })),
    );
    await expect(card.getByRole("textbox")).toHaveValue(
      "Check the finished video discard these words",
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("test-speech-words", {
          detail: "Long dictation keeps the newest words visible. ".repeat(30),
        }),
      ),
    );
    await expect
      .poll(() =>
        card.getByRole("textbox").evaluate((node) => {
          const field = node as HTMLTextAreaElement;
          return (
            field.scrollHeight > field.clientHeight &&
            field.scrollHeight - field.clientHeight - field.scrollTop <= 2
          );
        }),
      )
      .toBe(true);
    await cancel.click();
    await expect(mic).toBeVisible();
    await expect(card.getByRole("textbox")).toHaveValue("Check the finished video");
    await mic.click();
    await expect(stop).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("test-speech-words", { detail: "and" })),
    );
    await expect(card.getByRole("textbox")).toHaveValue("Check the finished video and");
    await page.screenshot({ path: test.info().outputPath("live-transcript.png") });
    await stop.click();
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("finish-test-speech", { detail: "and its sound" })),
    );
    await expect(mic).toBeVisible();
    await expect(card.getByRole("textbox")).toHaveValue("Check the finished video and its sound");
  });
}
