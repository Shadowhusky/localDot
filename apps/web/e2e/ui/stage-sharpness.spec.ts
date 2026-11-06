import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, runAt, test } from "./harness.ts";

// What the stage shows of a real capture: QA_SHARP_STREAM names a raw H.264 file and its frame sizes
// (stream.h264, stream.json). The client decodes it as Selkies' does and keeps showing its last
// frame. Screenshots of the stage at this project's size land in QA_SHARP_OUT for comparison with
// the capture's framebuffer.
const STREAM = process.env.QA_SHARP_STREAM;
const OUT = process.env.QA_SHARP_OUT;
const DPR = Number(process.env.QA_SHARP_DPR || 2);

runAt("c14", "c39");
test.skip(!STREAM || !OUT, "opt in with QA_SHARP_STREAM and QA_SHARP_OUT");
test.use({
  fixedClock: false,
  deviceScaleFactor: DPR,
  launchOptions: async ({ browserName }, use) =>
    use(browserName === "chromium" ? { args: ["--enable-gpu"] } : {}),
});

function captureClient(sizes: number[]) {
  const view = window as unknown as {
    videoChunksReceived: number;
    selkiesTransport: { readyState: number; send(text: string): void; close(): void };
    MediaStreamTrackGenerator: new (init: {
      kind: "video";
    }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
  };
  view.videoChunksReceived = 0;
  view.selkiesTransport = { readyState: 1, send() {}, close() {} };
  const video = document.getElementById("videoStream") as HTMLVideoElement;
  const track = new view.MediaStreamTrackGenerator({ kind: "video" });
  const writer = track.writable.getWriter();
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});
  let last: VideoFrame | null = null;
  let n = 0;
  void fetch("/qa-sharp.h264")
    .then((res) => res.arrayBuffer())
    .then(async (bytes) => {
      const decoder = new VideoDecoder({
        output: (frame) => {
          last?.close();
          last = frame;
        },
        error: (error) => console.error(error),
      });
      decoder.configure({ codec: "avc1.42E033", hardwareAcceleration: "prefer-hardware" });
      let at = 0;
      for (const [i, size] of sizes.entries()) {
        decoder.decode(
          new EncodedVideoChunk({
            type: i === 0 ? "key" : "delta",
            timestamp: i * 1000,
            data: new Uint8Array(bytes, at, size),
          }),
        );
        at += size;
      }
      await decoder.flush();
      setInterval(() => {
        if (!last) return;
        n++;
        view.videoChunksReceived++;
        void writer.write(new VideoFrame(last, { timestamp: n * 100_000 })).catch(() => {});
      }, 100);
    });
}

test("the stage's picture of a real capture", async ({ page, ui }) => {
  test.setTimeout(120_000);
  const sizes = (JSON.parse(readFileSync(`${STREAM}.json`, "utf8")) as { n: number }[]).map(
    (frame) => frame.n - 12,
  );
  await page.route("**/qa-sharp.h264", (route) =>
    route.fulfill({ contentType: "video/h264", body: readFileSync(`${STREAM}.h264`) }),
  );
  await page.route("**/owned-preview.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `(${captureClient.toString()})(${JSON.stringify(sizes)});`,
    }),
  );
  await ui.open("ready");
  await ui.picture();
  const canvas = page.locator("canvas.stage-canvas");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")))
    .toBeGreaterThan(3);
  await page.waitForTimeout(1500);
  const project = test.info().project.name;
  const shoot = async (name: string) => {
    const box = await canvas.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const worker = await canvas.getAttribute("data-size");
    await page.screenshot({
      path: join(OUT as string, `${project}-dpr${DPR}-${name}.png`),
      clip: box,
    });
    writeFileSync(
      join(OUT as string, `${project}-dpr${DPR}-${name}.json`),
      JSON.stringify({ box, dpr: DPR, frame: worker }),
    );
  };
  await shoot("stage");
  if (project === "c14") {
    const enter = page.locator(".stage-expand").getByRole("button", { name: "Full screen" });
    await enter.focus();
    await enter.press("Enter");
    await expect
      .poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width))
      .toBeGreaterThan(1100);
    await page.waitForTimeout(1500);
    await shoot("full");
  }
});
