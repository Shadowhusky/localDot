import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { desktopContainer, docker, type RunningDaemon, startDaemon } from "./daemon.ts";

test.skip(process.env.LOCALDOT_MEASURE !== "1", "opt in to the stream measurements");
const fullcolor = process.env.LOCALDOT_STREAM_FULLCOLOR === "1";
let daemon: RunningDaemon;
test.beforeAll(async () => {
  daemon = await startDaemon({ LOCALDOT_STREAM_FULLCOLOR: fullcolor ? "1" : "0" });
});
test.afterAll(async () => {
  await daemon?.stop();
});

const cpuSample = (container: string) =>
  Number(docker("stats", "--no-stream", "--format", "{{.CPUPerc}}", container).replace("%", ""));
const chromeCpu = () => {
  const processes = execFileSync("ps", ["-A", "-o", "pid=,ppid=,%cpu=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => {
      const [pid, ppid, cpu, ...command] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), command: command.join(" ") };
    });
  const owned = new Set([process.pid]);
  for (;;) {
    const before = owned.size;
    for (const child of processes) if (owned.has(child.ppid)) owned.add(child.pid);
    if (owned.size === before) break;
  }
  return processes
    .filter((child) => owned.has(child.pid) && /Google Chrome/.test(child.command))
    .reduce((sum, child) => sum + child.cpu, 0);
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

test("measure fps and CPU at 2x", async ({ page }) => {
  const media = await page.context().newCDPSession(page);
  const decoder: Record<string, string> = {};
  media.on("Media.playerPropertiesChanged", ({ properties }) => {
    for (const { name, value } of properties)
      if (/decoder|codec/i.test(name)) decoder[name] = value;
  });
  await media.send("Media.enable");
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  const created = page.waitForResponse(
    (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/cells",
  );
  await page.getByRole("button", { name: "Turn on" }).first().click();
  const cellId = ((await (await created).json()) as { id: string }).id;
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });
  const canvas = page.locator("canvas.stage-canvas");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")), { timeout: 60_000 })
    .toBeGreaterThan(0);
  const container = desktopContainer(cellId);
  expect(container).toBe(`localdot-desktop-${cellId}`);

  const idle = { cpu: [] as number[], chrome: [] as number[] };
  for (let i = 0; i < 5; i++) {
    idle.cpu.push(cpuSample(container));
    idle.chrome.push(chromeCpu());
  }

  // A repeatable offline, continuous load. It never reaches a page's bottom and turns idle.
  const motionPage = `<!doctype html><meta charset="utf-8"><title>localDot stream measurement</title>
<style>body{margin:0;font:24px system-ui;background:#fafafa;color:#222}header{padding:24px;background:#eee}
section{height:5000px;background:repeating-linear-gradient(#fafafa 0 80px,#ddd 80px 82px);padding:24px}
article{margin:48px 0;max-width:1000px}</style><header>localDot · continuous scroll measurement</header><section></section>
<script>const s=document.querySelector('section');for(let i=0;i<24;i++){const a=document.createElement('article');a.textContent='Line '+i+' — The live desktop is drawn through the daemon and a worker. Text, panels and the cursor stay sharp at twice the resolution.';s.append(a)}
const start=performance.now();function tick(t){scrollTo(0,1400+1300*Math.sin((t-start)/1600));requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`;
  execFileSync("docker", ["exec", "-i", container, "tee", "/tmp/localdot-motion.html"], {
    input: motionPage,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 30_000,
  });
  docker(
    "exec",
    "-d",
    "-u",
    "abc",
    "-e",
    "DISPLAY=:1",
    container,
    "chromium",
    "--start-maximized",
    "file:///tmp/localdot-motion.html",
  );
  await page.waitForTimeout(5000);
  const moving = { fps: [] as number[], cpu: [] as number[], chrome: [] as number[] };
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    moving.fps.push(Number(await canvas.getAttribute("data-fps")));
    moving.cpu.push(cpuSample(container));
    moving.chrome.push(chromeCpu());
  }
  const frame = page.frames().find((f) => f.url().includes(`/cells/${cellId}/desktop/`));
  const videoStats = await frame?.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("#videoStream");
    const quality = video?.getVideoPlaybackQuality();
    return { decoded: quality?.totalVideoFrames, dropped: quality?.droppedVideoFrames };
  });
  const result = {
    date: new Date().toISOString(),
    fullcolor,
    size: await canvas.getAttribute("data-size"),
    idle: { containerCpuMedian: median(idle.cpu), chromeCpuMedian: median(idle.chrome) },
    moving: {
      fpsMedian: median(moving.fps),
      fpsMin: Math.min(...moving.fps),
      containerCpuMedian: median(moving.cpu),
      containerCpuPeak: Math.max(...moving.cpu),
      chromeCpuMedian: median(moving.chrome),
    },
    videoStats,
    decoder,
    samples: { idle, moving },
  };
  writeFileSync(
    `e2e/out/measure-${fullcolor ? "444" : "420"}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await page.screenshot({ path: `e2e/out/measure-${fullcolor ? "444" : "420"}.png` });
  console.log(JSON.stringify(result, null, 2));
  expect(result.moving.fpsMedian).toBeGreaterThan(20);
});
