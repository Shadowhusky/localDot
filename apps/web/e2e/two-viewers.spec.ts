import { spawnSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
let daemon: RunningDaemon;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images and Docker Desktop");

test.beforeAll(async () => {
  daemon = await startDaemon();
});

test.afterAll(async () => {
  await daemon?.stop();
});

// A patch of noise redrawn on every animation frame: nothing in it compresses, so the stream runs
// at a high rate and a viewer that stops reading backs up within seconds.
const NOISE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>noise</title>
<style>html, body { margin: 0; height: 100%; background: #000; } canvas { position: fixed; left: 50%; top: 50%; width: 160px; height: 100px; transform: translate(-50%, -50%); }</style>
</head><body><canvas width="320" height="200"></canvas><script>
  const g = document.querySelector("canvas").getContext("2d");
  const img = g.createImageData(320, 200);
  const px = new Uint32Array(img.data.buffer);
  const step = () => {
    for (let i = 0; i < px.length; i++) px[i] = (Math.random() * 0x1000000) | 0xff000000;
    g.putImageData(img, 0, 0);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
</script></body></html>
`;

function docker(args: string[], input?: string): string {
  const r = spawnSync("docker", args, { encoding: "utf8", input });
  expect(r.status, `docker ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

// The largest send queue of any established TCP socket in the cell's desktop, in bytes. A frozen
// viewer's backlog ends up there (Selkies → nginx → the gate) once the relay pauses its upstream.
function largestSendQueue(desktop: string): number {
  const tables = docker([
    "exec",
    desktop,
    "sh",
    "-c",
    "cat /proc/net/tcp; cat /proc/net/tcp6 2>/dev/null; true",
  ]);
  let largest = 0;
  for (const line of tables.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[3] === "01") largest = Math.max(largest, Number.parseInt(f[4]?.split(":")[0] ?? "0", 16));
  }
  return largest;
}

const framesOf = async (page: Page) =>
  Number(await page.locator("canvas.stage-canvas").getAttribute("data-frames"));

// Frames the page's stage presented per second over `ms`.
async function rate(page: Page, ms: number): Promise<number> {
  const before = await framesOf(page);
  await page.waitForTimeout(ms);
  return ((await framesOf(page)) - before) / (ms / 1000);
}

// P3-C6: the relay may pause a slow viewer's upstream only because each viewer has its own, and
// only if Selkies keeps serving its other clients meanwhile.
test("a frozen viewer never stalls another viewer", async ({ browser }) => {
  test.setTimeout(600_000);
  const a = await (await browser.newContext()).newPage();
  await a.goto(`${daemon.origin}/#token=${daemon.token}`);
  const created = a.waitForResponse(
    (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/cells",
  );
  await a.getByRole("button", { name: "Start computer" }).click();
  const cellId = ((await (await created).json()) as { id: string }).id;
  await expect(a.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });

  const desktop = desktopContainer(cellId);
  docker(["exec", "-i", "-u", "abc", desktop, "sh", "-c", "cat > /tmp/noise.html"], NOISE);
  docker([
    "exec",
    "-d",
    "-u",
    "abc",
    "-e",
    "DISPLAY=:1",
    desktop,
    "/usr/local/bin/localdot-chromium",
    "--new-window",
    "file:///tmp/noise.html",
  ]);

  const b = await (await browser.newContext()).newPage();
  await b.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(b.getByTestId("hud-status")).toHaveText("Live", { timeout: 120_000 });
  await expect.poll(() => rate(b, 2000), { timeout: 90_000 }).toBeGreaterThan(10);
  const steady = await rate(b, 5000);
  const aBefore = await framesOf(a);

  // Frozen, viewer A's page stops reading its socket: the browser's buffers fill, then the relay's
  // high-water mark pauses A's upstream, and A's backlog piles up inside the cell.
  const cdp = await a.context().newCDPSession(a);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  let backedUp = 0;
  for (let n = 1; n <= 6; n++) {
    const r = await rate(b, 5000);
    backedUp = Math.max(backedUp, largestSendQueue(desktop));
    expect(
      r,
      `viewer B's frames per second in window ${n} of A's freeze (steady ${steady.toFixed(1)})`,
    ).toBeGreaterThan(steady / 2);
    await expect(b.getByTestId("hud-status")).toHaveText("Live");
  }
  expect(
    backedUp,
    "viewer A's freeze never backed up into the cell, so B's rate proves nothing",
  ).toBeGreaterThan(128 * 1024);

  // Thawed, viewer A drains its backlog and the relay resumes its upstream.
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await a.bringToFront();
  await expect.poll(() => framesOf(a), { timeout: 60_000 }).toBeGreaterThan(aBefore);

  await a.getByRole("button", { name: "Stop computer" }).click();
  await expect(a.getByTestId("hud-status")).toHaveText("Stopped", { timeout: 60_000 });
});
