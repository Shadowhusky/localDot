import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { docker, type RunningDaemon, startDaemon } from "./daemon.ts";
import { skipSetup } from "./skip-setup.ts";

// What the one screen costs this machine's Chrome, on real containers: a build's numbers go to
// QA_MEASURE_OUT as one JSON line per state, under QA_MEASURE_LABEL. Run it again with another
// build in apps/web/dist to compare; a build without the window control measures what it can.
test.skip(process.env.LOCALDOT_MEASURE !== "1", "opt in to the stream measurements");
test.setTimeout(1_200_000);

const LABEL = process.env.QA_MEASURE_LABEL ?? "build";
const OUT = process.env.QA_MEASURE_OUT ?? "e2e/out/one-screen-measure.jsonl";
const WINDOWS = 3;
const WINDOW_MS = 8000;
const MOVING =
  "data:text/html,<style>@keyframes a{to{transform:translateX(800px)}}div{width:400px;height:400px;background:red;animation:a 1s infinite alternate}</style><div></div>";
const STILL = "data:text/html,<h1>Still</h1>";
const SIZES = [
  { name: "desktop", options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
  {
    name: "phone",
    options: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  },
] as const;

let daemon: RunningDaemon;
test.beforeAll(async () => {
  daemon = await startDaemon();
});
test.afterAll(async () => {
  await daemon?.stop();
});

const seconds = (time: string) =>
  time
    .split(":")
    .map(Number)
    .reduce((sum, part) => sum * 60 + part, 0);
// This test's Chrome: its CPU seconds so far and its memory now.
function chrome(): { cpu: number; rssMiB: number } {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time=,rss=,comm="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .map((line) => {
      const [pid, ppid, time, rss, ...command] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        cpu: seconds(time ?? "0"),
        rss: Number(rss),
        command: command.join(" "),
      };
    });
  const owned = new Set([process.pid]);
  for (;;) {
    const before = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
    if (owned.size === before) break;
  }
  const mine = rows.filter((row) => owned.has(row.pid) && /Chrome/.test(row.command));
  return {
    cpu: mine.reduce((sum, row) => sum + row.cpu, 0),
    rssMiB: Math.round(mine.reduce((sum, row) => sum + row.rss, 0) / 1024),
  };
}
const containerCpu = (name: string) =>
  Number(docker("stats", "--no-stream", "--format", "{{.CPUPerc}}", name).replace("%", ""));
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function measure(
  page: Page,
  size: string,
  state: string,
  containers: { desktop: string; browser: string },
) {
  await page.waitForTimeout(4000);
  const cpu: number[] = [];
  const fps: number[] = [];
  for (let window = 0; window < WINDOWS; window++) {
    const start = chrome();
    const at = Date.now();
    await page.waitForTimeout(WINDOW_MS);
    cpu.push(((chrome().cpu - start.cpu) / ((Date.now() - at) / 1000)) * 100);
    fps.push(Number(await page.locator("canvas.stage-canvas").getAttribute("data-fps")));
  }
  const row = {
    label: LABEL,
    size,
    state,
    chromeCpuPercent: Math.round(median(cpu)),
    chromeRssMiB: chrome().rssMiB,
    fps: median(fps),
    clients: await page.locator("iframe.desktop-frame").count(),
    desktopCellCpu: containerCpu(containers.desktop),
    browserCellCpu: containerCpu(containers.browser),
  };
  console.log(JSON.stringify(row));
  mkdirSync(dirname(OUT), { recursive: true });
  appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

async function openOnComputer(browser: Browser, options: object): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await skipSetup(page);
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect
    .poll(
      async () => Number(await page.locator("canvas.stage-canvas").getAttribute("data-frames")),
      {
        timeout: 120_000,
      },
    )
    .toBeGreaterThan(0);
  return page;
}

test("the one screen's cost at both sizes", async ({ browser }) => {
  const created = await daemon.request("/api/cells", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scale: 2, force: true }),
  });
  expect(created.status).toBe(202);
  const cellId = ((await created.json()) as { id: string }).id;
  await expect
    .poll(
      async () => {
        const status = await daemon.request(`/api/cells/${cellId}/browser`);
        return ((await status.json()) as { state?: string }).state;
      },
      { timeout: 300_000 },
    )
    .toBe("ready");
  const containers = {
    desktop: `localdot-desktop-${cellId}`,
    browser:
      docker("ps", "--filter", `label=localdot.parent=${cellId}`, "--format", "{{.Names}}")
        .split("\n")
        .find((name) => name.startsWith("localdot-browser-")) ?? "",
  };

  for (const { name, options } of SIZES) {
    const page = await openOnComputer(browser, options);
    await measure(page, name, "desktop in front, still", containers);

    // The user holds the web browser, with dot's screen on it.
    const signIn = await daemon.request(`/api/cells/${cellId}/accounts/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: "example.com" }),
    });
    expect(signIn.status).toBe(202);
    const { sessionId, requestId } = (await signIn.json()) as {
      sessionId: string;
      requestId: string;
    };
    const send = async (input: unknown) => {
      const reply = await daemon.request(`/api/agent/sessions/${sessionId}/takeover/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, input }),
      });
      expect(reply.status).toBe(204);
    };
    const open = async (address: string) => {
      await send({ kind: "key", combo: ["ctrl", "l"] });
      await send({ kind: "text", text: address });
      await send({ kind: "key", combo: ["return"] });
    };
    await expect(page.locator(".manual-surface")).toHaveAttribute("data-live", "", {
      timeout: 60_000,
    });
    await open(STILL);
    await measure(page, name, "browser in front, still, in control", containers);
    await open(MOVING);
    await measure(page, name, "browser in front, moving, in control", containers);

    const composite = await page.getByRole("button", { name: /the desktop/ }).count();
    if (composite) {
      // The desktop moves too: the most both decoders are ever asked for.
      docker(
        "exec",
        "-d",
        "-u",
        "abc",
        "-e",
        "DISPLAY=:1",
        containers.desktop,
        "xfce4-terminal",
        "--maximize",
        "-x",
        "yes",
        "localdot",
      );
      await measure(page, name, "browser in front, both moving, in control", containers);
      docker("exec", containers.desktop, "pkill", "yes");
    }
    await page.getByRole("button", { name: "Hand back" }).click({ force: true });
    await expect(page.getByRole("button", { name: "Hand back" })).toHaveCount(0, {
      timeout: 30_000,
    });
    if (composite) {
      // Only watching now: the desktop under the window is a picture, and the browser still moves.
      await page.locator(".stage").first().hover({ force: true });
      await page.getByRole("button", { name: /the web browser/ }).click({ force: true });
      await expect(page.locator('iframe.desktop-frame[src*="/browser/"]')).toHaveCount(1);
      await measure(page, name, "browser in front, moving, watching", containers);
      await page.getByRole("button", { name: /the desktop/ }).click({ force: true });
      await measure(page, name, "desktop in front, browser covered", containers);
    }
    await page.context().close();
  }
});
