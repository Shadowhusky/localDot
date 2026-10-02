import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { desktopContainer, docker, type RunningDaemon, startDaemon } from "./daemon.ts";

test.skip(process.env.LOCALDOT_COMPOSITOR !== "1", "opt in to the compositor measurements");
const spike = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../spikes/${name}`, import.meta.url)), "utf8");
let daemon: RunningDaemon;
test.beforeAll(async () => {
  daemon = await startDaemon();
});
test.afterAll(async () => {
  await daemon?.stop();
});

test("compositor latency and tearing at 2x and 1x", async ({ page }) => {
  const results = [];
  for (const scale of [2, 1]) {
    const created = await daemon.request("/api/cells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scale }),
    });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    await page.goto(`${daemon.origin}/#token=${daemon.token}`);
    // A fragment-only navigation does not reload the Theatre after an externally created cell.
    await page.reload();
    await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });
    await expect(page.locator("canvas.stage-canvas")).toHaveAttribute(
      "data-size",
      `${1280 * scale}x${800 * scale}`,
    );
    const container = desktopContainer(id);
    const vblank = docker(
      "exec",
      "-u",
      "abc",
      container,
      "xfconf-query",
      "-c",
      "xfwm4",
      "-p",
      "/general/vblank_mode",
    );
    expect(vblank).toBe("off");
    const loadPage = async (name: string, html: string) => {
      execFileSync("docker", ["exec", "-i", container, "tee", `/tmp/${name}.html`], {
        input: html,
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
        `file:///tmp/${name}.html`,
      );
      await sleep(3000);
    };
    await loadPage("flash", spike("s6-timing/flash.html"));
    await page.evaluate(() => {
      const iframe = document.querySelector("iframe.desktop-frame");
      if (iframe) iframe.id = "desktop";
      const stats = document.createElement("span");
      stats.id = "stats";
      stats.hidden = true;
      document.body.append(stats);
    });
    await expect
      .poll(() =>
        page.evaluate(
          `Boolean(document.getElementById('desktop')?.contentDocument?.getElementById('videoStream')?.srcObject?.getVideoTracks?.()[0])`,
        ),
      )
      .toBe(true);
    await page.evaluate(spike("s8-hosted-client/recorder.js"));
    const input = spawn(
      "docker",
      ["exec", "-i", "-u", "abc", "-e", "DISPLAY=:1", container, "xdotool", "-"],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let inputError = "";
    input.stderr.on("data", (data: Buffer) => {
      inputError += data.toString();
    });
    const exit = new Promise<number | null>((resolve) => input.once("exit", resolve));
    const sent = [];
    try {
      await sleep(700);
      input.stdin.write("key space\n");
      await sleep(700);
      for (let i = 0; i < 60; i++) {
        sent.push(Date.now());
        input.stdin.write("key space\n");
        await sleep(600 + (i % 7) * 2.5);
      }
      input.stdin.end();
      expect(await exit, inputError).toBe(0);
      await sleep(700);
    } finally {
      if (input.exitCode === null) input.kill("SIGTERM");
    }
    const latency = (await page.evaluate(`ldLatency(${JSON.stringify(sent)})`)) as {
      n: number;
      missing: number;
      p50: number;
      p95: number;
      max: number;
    };
    expect(latency.n).toBe(60);
    expect(latency.missing).toBe(0);
    await page.evaluate("ldRec.stop()");

    await loadPage("motion", spike("s8-hosted-client/motion.html"));
    await page.evaluate(spike("s8-hosted-client/tearing.js"));
    await sleep(10_000);
    const tearing = (await page.evaluate("ldTear.summary()")) as {
      frames: number;
      withBar: number;
      moving: number;
      torn: number;
    };
    await page.evaluate("ldTear.stop()");
    results.push({ scale, vblank, latency, tearing });
    // Save evidence before assertions so a failed capture remains inspectable.
    writeFileSync("e2e/out/compositor.json", `${JSON.stringify(results, null, 2)}\n`);
    await page.screenshot({ path: `e2e/out/compositor-${scale}x.png` });
    expect(tearing.frames).toBeGreaterThan(450);
    expect(tearing.withBar / tearing.frames).toBeGreaterThan(0.9);
    expect(tearing.moving / tearing.frames).toBeGreaterThan(0.8);
    expect(tearing.torn).toBe(0);
    expect((await daemon.request(`/api/cells/${id}?purge=1`, { method: "DELETE" })).status).toBe(
      204,
    );
  }
  console.log(JSON.stringify(results, null, 2));
});
