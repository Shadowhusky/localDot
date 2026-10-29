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
      window.sent=[];
      let paused=false;
      window.selkiesTransport={readyState:1,send(text){window.sent.push(text);if(text==='STOP_VIDEO')paused=true;if(text==='START_VIDEO')paused=false;},close(){this.readyState=3;}};
      video.srcObject=canvas.captureStream(10);video.play().catch(()=>{});
      let count=0;
      const timer=setInterval(()=>{
        if(paused)return;
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
  // Repeated background/foreground trips stop the viewer's video and keep its client, then
  // resume the same one.
  const client = page.frameLocator("iframe.desktop-frame").locator("body");
  const sent = () => client.evaluate(() => (window as unknown as { sent: string[] }).sent.slice());
  for (let n = 0; n < 4; n++) {
    await client.evaluate(() => {
      (window as unknown as { sent: string[] }).sent.length = 0;
    });
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(async () => (await sent()).at(-1)).toBe("STOP_VIDEO");
    await expect(page.locator("iframe.desktop-frame")).toHaveCount(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(sent).toContain("START_VIDEO");
    await expect(page.locator("iframe.desktop-frame")).toHaveCount(1);
    const previous = Number(await canvas.getAttribute("data-frames"));
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-frames")))
      .toBeGreaterThan(previous);
  }
  expect(loaded).toBe(2);
  await page.screenshot({ path: test.info().outputPath("recovered-stream.png") });
});
