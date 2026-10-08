import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { RecordingInfo } from "@localdot/protocol";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";
import { runPuppet, waitForSessionEnd } from "./puppet.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
let daemon: RunningDaemon;
let frozenBrowser: Browser | undefined;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images and Docker Desktop");

test.beforeEach(async () => {
  daemon = await startDaemon();
});

test.afterEach(async () => {
  try {
    await frozenBrowser?.close();
  } finally {
    frozenBrowser = undefined;
    await daemon?.stop();
  }
});

// A patch of noise redrawn on every animation frame: nothing in it compresses, so the stream runs
// at a high rate and a viewer that stops reading backs up within seconds.
const NOISE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>noise</title>
<style>html, body { margin: 0; height: 100%; background: #000; } canvas { position: fixed; left: 50%; top: 50%; width: 1280px; height: 800px; transform: translate(-50%, -50%); }</style>
</head><body><canvas width="2560" height="1600"></canvas><script>
  const g = document.querySelector("canvas").getContext("2d");
  const img = g.createImageData(2560, 1600);
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
async function checkViewers(browser: Browser, recordingEnabled: boolean) {
  test.setTimeout(600_000);
  // Independent processes also give each viewer independent renderer lifecycle scheduling.
  frozenBrowser = await chromium.launch({ channel: "chrome" });
  const a = await (await frozenBrowser.newContext()).newPage();
  await a.goto(`${daemon.origin}/#token=${daemon.token}`);
  const created = a.waitForResponse(
    (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/cells",
  );
  await expect(a.getByTestId("hud-status")).toHaveText("No computer");
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
  await expect.poll(() => rate(a, 2000), { timeout: 60_000 }).toBeGreaterThan(10);

  const b = await (await browser.newContext()).newPage();
  await b.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(b.getByTestId("hud-status")).toHaveText("Live", { timeout: 120_000 });
  await expect
    .poll(
      async () => {
        const fps = await rate(b, 2000);
        console.log(`viewer B before recording: ${fps.toFixed(1)} fps`);
        return fps;
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThan(10);
  const sessionId = recordingEnabled
    ? await runPuppet(daemon, cellId, {
        v: 1,
        title: "Recorder and viewer isolation",
        steps: Array.from({ length: 4 }, () => ({
          do: "wait",
          ms: 60_000,
          label: "Recording with two viewers",
        })),
      })
    : undefined;
  const recordingOf = async () => {
    if (!sessionId) throw new Error("No recording session was started.");
    const response = await daemon.request(`/api/sessions/${sessionId}/recording`);
    expect(response.ok).toBe(true);
    return RecordingInfo.parse(await response.json());
  };
  if (recordingEnabled)
    await expect
      .poll(async () => (await recordingOf()).manifest.fragments, { timeout: 30_000 })
      .toBeGreaterThan(0);
  const beforeFreeze = recordingEnabled ? await recordingOf() : undefined;
  if (beforeFreeze) {
    expect(beforeFreeze.manifest.state).toBe("recording");
    expect(beforeFreeze.manifest.gaps).toEqual([]);
  }
  const steady = await rate(b, 5000);

  await expect
    .poll(async () => (await (await daemon.request(`/api/cells/${cellId}`)).json()).stream.viewers)
    .toBe(2);
  // Frozen, viewer A's page stops reading its socket: the browser's buffers fill, then the relay's
  // high-water mark pauses A's upstream, and A's backlog piles up inside the cell.
  const cdp = await a.context().newCDPSession(a);
  // Playwright forces pages to stay focused. That override prevents Chromium's real
  // hidden → frozen lifecycle, so disable it for the viewer whose reads we suspend.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  let backedUp = 0;
  const windows: { fps: number; fragments: number; bytes: number; lastMicros: number | null }[] =
    [];

  for (let n = 1; n <= 6; n++) {
    const r = await rate(b, 5000);
    backedUp = Math.max(backedUp, largestSendQueue(desktop));
    console.log(`freeze ${n}: B=${r.toFixed(1)} fps, largest cell send queue=${backedUp} bytes`);
    expect(
      r,
      `viewer B's frames per second in window ${n} of A's freeze (steady ${steady.toFixed(1)})`,
    ).toBeGreaterThan(steady / 2);
    await expect(b.getByTestId("hud-status")).toHaveText(
      recordingEnabled ? "Recording with two viewers" : "Live",
    );
    const summary = await (await daemon.request(`/api/cells/${cellId}`)).json();
    expect(summary.stream.viewers).toBe(2);
    if (beforeFreeze) {
      const recording = await recordingOf();
      expect(recording.manifest.state).toBe("recording");
      expect(recording.manifest.gaps).toEqual([]);
      expect(recording.manifest.fragments).toBeGreaterThan(
        windows.at(-1)?.fragments ?? beforeFreeze.manifest.fragments,
      );
      expect(recording.manifest.bytes).toBeGreaterThan(
        windows.at(-1)?.bytes ?? beforeFreeze.manifest.bytes,
      );
      windows.push({
        fps: r,
        fragments: recording.manifest.fragments,
        bytes: recording.manifest.bytes,
        lastMicros: recording.manifest.lastMicros,
      });
    }
  }
  expect(backedUp, "the frozen viewer never backed up its cell socket").toBeGreaterThan(128 * 1024);

  // Thawed, viewer A reconnects to the current desktop rather than replaying its backlog.
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await a.bringToFront();
  let recoveredFps = 0;
  await expect
    .poll(
      async () => {
        recoveredFps = await rate(a, 2000);
        return recoveredFps;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(recordingEnabled ? steady / 2 : 10);

  if (sessionId) {
    await a.getByTestId("hud-stop-session").click({ timeout: 10_000 });
    const events = await waitForSessionEnd(daemon, sessionId);
    expect(events.findLast((event) => event.type === "session.end")?.data.reason).toBe("stopped");
    await expect.poll(async () => (await recordingOf()).manifest.state).toBe("complete");
  }
  const ended = recordingEnabled ? await recordingOf() : undefined;
  await a.getByRole("button", { name: "Stop computer" }).click({ timeout: 10_000 });
  await expect(a.getByTestId("hud-status")).toHaveText("Stopped", { timeout: 60_000 });
  mkdirSync("e2e/out", { recursive: true });
  writeFileSync(
    `e2e/out/two-viewers-${recordingEnabled ? "recording" : "live"}.json`,
    JSON.stringify({ beforeFreeze, steady, recoveredFps, backedUp, windows, ended }, null, 2),
  );
}

for (const recordingEnabled of [false, true])
  test(
    recordingEnabled
      ? "a frozen viewer never stalls another viewer or the active recorder"
      : "a frozen viewer never stalls another viewer",
    async ({ browser }) => checkViewers(browser, recordingEnabled),
  );
