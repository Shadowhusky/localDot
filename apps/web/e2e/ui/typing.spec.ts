import type { Page } from "@playwright/test";
import { composer, expect, test } from "./harness.ts";

// Real frames and timers, and Chromium draws a frame as soon as it has one to draw, so what is
// measured is the page's own time, not the wait for the display's next refresh.
test.use({
  fixedClock: false,
  launchOptions: async ({ browserName }, use) =>
    use(
      browserName === "chromium"
        ? { args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"] }
        : {},
    ),
});

interface Typing {
  typing: number[];
}

// From each key press, as the system stamped it before it waited behind the page's other work, to
// the frame that shows its character, laid out, less the time the page sat idle waiting for that
// frame. Chrome holds other tasks until that frame; elsewhere a ping chain counts what runs in
// between.
function trackTyping() {
  const typing: number[] = [];
  (window as unknown as Typing).typing = typing;
  let pressed = 0;
  window.addEventListener(
    "keydown",
    (event) => {
      pressed = event.timeStamp;
    },
    true,
  );
  window.addEventListener("input", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement)) return;
    queueMicrotask(() => {
      const handled = performance.now();
      let last = handled;
      let busy = 0;
      let pinged = false;
      let framed = false;
      const ping = new MessageChannel();
      ping.port1.onmessage = () => {
        if (framed) return;
        const now = performance.now();
        if (now - last > 1.5) busy += now - last;
        pinged = true;
        last = now;
        ping.port2.postMessage(null);
      };
      ping.port2.postMessage(null);
      requestAnimationFrame((began) => {
        framed = true;
        ping.port1.close();
        field.getBoundingClientRect();
        const frame = pinged ? last : Math.max(handled, began);
        typing.push(handled - pressed + busy + (performance.now() - frame));
      });
    });
  });
}

// The last word dot has streamed into the thread.
const streamed = (page: Page) =>
  page
    .locator(".thread-scroll")
    .evaluate((thread) =>
      Math.max(
        0,
        ...[...(thread.textContent ?? "").matchAll(/cell(\d+)/g)].map((m) => Number(m[1])),
      ),
    );

test("typing paints within a frame while dot streams", async ({ page, ui }) => {
  const project = test.info().project.name;
  test.skip(!["c14", "w39"].includes(project), "Measured in Chrome at 1440 and WebKit at 390");
  const fixture = await ui.open("running");
  const card = await composer(page);
  const box = card.getByRole("textbox", { name: "Message" });
  await box.focus();
  // QA_CPU_THROTTLE=6 slows Chrome to a phone's CPU.
  const cdp = project === "c14" ? await page.context().newCDPSession(page) : undefined;
  if (process.env.QA_CPU_THROTTLE)
    await cdp?.send("Emulation.setCPUThrottlingRate", {
      rate: Number(process.env.QA_CPU_THROTTLE),
    });
  await page.evaluate(trackTyping);
  const stream = await page.request.post(`${fixture.origin}/__qa/stream?ms=30000`);
  expect(stream.ok()).toBe(true);
  await expect.poll(() => streamed(page)).toBeGreaterThan(20);
  const before = await streamed(page);
  const text = "make the totals row bold and add a chart for each month of the year ";
  await box.pressSequentially(text, { delay: 40 });
  await expect(box).toHaveValue(text);
  expect(await streamed(page), "dot streamed while you typed").toBeGreaterThan(before + 40);
  await cdp?.detach();
  const delays = await page.evaluate(() => (window as unknown as Typing).typing);
  expect(delays).toHaveLength(text.length);
  const sorted = delays.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.ceil(sorted.length * q) - 1] ?? Number.POSITIVE_INFINITY;
  test.info().annotations.push({
    type: "key press to paint",
    description: `p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${at(1).toFixed(1)} ms`,
  });
  expect(at(0.95)).toBeLessThan(16);
});
