import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39");
test.use({ fixedClock: false });

test("a silent connected viewer recovers without restarting the computer or accumulating clients", async ({
  page,
  ui,
}) => {
  let loaded = 0;
  await page.route("**/owned-preview.js", async (route) => {
    const first = ++loaded === 1;
    await route.fulfill({
      contentType: "text/javascript",
      body: `
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=800;
      const ctx=canvas.getContext('2d');
      const video=document.getElementById('videoStream');
      window.videoChunksReceived=0;
      window.selkiesTransport={readyState:1,send(){},close(){this.readyState=3;}};
      video.srcObject=canvas.captureStream(10);video.play().catch(()=>{});
      let count=0;
      const timer=setInterval(()=>{
        ctx.fillStyle=count++%2?'#125677':'#135778';ctx.fillRect(0,0,1280,800);ctx.fillStyle='#eeeeee';ctx.fillRect(0,0,640,800);
        window.videoChunksReceived++;
        if(${first}&&count===8)clearInterval(timer);
      },100);
    `,
    });
  });
  await ui.open("ready");
  await ui.picture();
  const canvas = page.locator("canvas.stage-canvas");
  await expect.poll(() => loaded, { timeout: 20_000 }).toBe(2);
  await expect(page.locator("iframe.desktop-frame")).toHaveCount(1);
  const before = Number(await canvas.getAttribute("data-frames"));
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")))
    .toBeGreaterThan(before + 5);
  // Repeated background/foreground trips should release each viewer, then restore one.
  for (let n = 0; n < 4; n++) {
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("iframe.desktop-frame")).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("iframe.desktop-frame")).toHaveCount(1);
    const previous = Number(await canvas.getAttribute("data-frames"));
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-frames")))
      .toBeGreaterThan(previous);
  }
  await page.screenshot({ path: test.info().outputPath("recovered-stream.png") });
});
