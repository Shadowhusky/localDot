/** Record reviewed excerpts from actual localDot task replays. No synthetic screen fixtures.
 * Usage: ... capture-demos.ts /absolute/path/to/private-demo-capture.json [work|research|play]
 * Configuration and raw recordings belong in ignored qa/, never public/.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "../../web/node_modules/@playwright/test/index.mjs";
import sharp from "../../web/node_modules/sharp/dist/index.mjs";

type Demo = {
  id: "work" | "research" | "play";
  sessionId: string;
  cellId: string;
  title: string;
  reviewed: true;
  segments: { from: number; seconds: number }[];
};
type Config = { origin: string; tokenFile: string; demos: Demo[] };
if (!process.argv[2])
  throw new Error(
    "Provide a private capture configuration containing reviewed real task sessions.",
  );
const config: Config = JSON.parse(await readFile(process.argv[2], "utf8"));
const origin = new URL(config.origin);
if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
  throw new Error("Capture must use the local daemon.");
const token = (await readFile(config.tokenFile, "utf8")).trim();
const out = fileURLToPath(new URL("../public/demos/", import.meta.url));
const temp = fileURLToPath(new URL("../qa/real-capture/", import.meta.url));
await mkdir(temp, { recursive: true });
const browser = await chromium.launch();
try {
  for (const demo of config.demos.filter((d) => !process.argv[3] || d.id === process.argv[3])) {
    if (demo.reviewed !== true || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(demo.sessionId))
      throw new Error("Review the task recording before publication.");
    const infoResponse = await fetch(`${origin.origin}/api/sessions/${demo.sessionId}/recording`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!infoResponse.ok) throw new Error("Recording unavailable");
    const info = await infoResponse.json();
    if (info.live || !info.manifest.finalized || !info.servedBytes)
      throw new Error("Finish the real task recording before capture.");
    await Promise.all(
      [false, true].map(async (mobile) => {
        const name = demo.id + (mobile ? "-mobile" : "");
        const size = mobile ? { width: 390, height: 500 } : { width: 1440, height: 900 };
        const clips: string[] = [];
        for (let i = 0; i < demo.segments.length; i++) {
          const segment = demo.segments[i];
          const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            recordVideo: { dir: temp, size },
            colorScheme: "dark",
            ...(mobile ? { isMobile: true, hasTouch: true } : {}),
          });
          try {
            const began = Date.now();
            const page = await context.newPage();
            await page.addInitScript(
              ({ token }) => {
                localStorage.setItem("localdot.token", token);
                localStorage.setItem(
                  "localdot.onboarding.v1",
                  JSON.stringify({ dismissed: true, step: "welcome" }),
                );
              },
              { token },
            );
            // Limit the capture to its one public demo. All steps, pixels and timing stay real.
            await page.route("**/api/cells", async (route) => {
              const r = await route.fetch();
              await route.fulfill({
                json: (await r.json()).filter((c: { id: string }) => c.id === demo.cellId),
              });
            });
            await page.route("**/api/conversation", (route) =>
              route.fulfill({ json: { sessions: [demo.sessionId], more: false } }),
            );
            await page.route("**/api/conversations", (route) =>
              route.fulfill({ json: { conversations: [] } }),
            );
            // The editorial title is short; no task content, tool result or screen is changed.
            await page.route(`**/api/sessions/${demo.sessionId}/card`, async (route) => {
              const r = await route.fetch();
              await route.fulfill({ json: { ...(await r.json()), title: demo.title } });
            });
            await page.goto(`${origin.origin}/?replay=${demo.sessionId}&t=${segment.from * 1000}`);
            const play = page.getByRole("button", { name: "Play replay", exact: true });
            await expect(play).toBeEnabled({ timeout: 30000 });
            const idle = page.getByRole("button", { name: "Skip idle", exact: true });
            await expect(idle).toBeVisible();
            if ((await idle.getAttribute("aria-pressed")) === "true") await idle.click();
            await page.setViewportSize(size);
            await page.mouse.move(size.width - 2, size.height - 2);
            await page.waitForTimeout(1500);
            if (i === 0) await page.screenshot({ path: `${temp}/${name}-poster.png` });
            const screenBox = await page.locator(".replay canvas.stage-canvas").boundingBox();
            if (!screenBox || screenBox.width < 100) throw new Error("Replay screen missing");
            await writeFile(`${temp}/${name}-${i}-screen.json`, JSON.stringify(screenBox));
            const trim = (Date.now() - began) / 1000;
            await play.click();
            // Remove focus from the transport so the app can fade its controls naturally.
            await page.mouse.click(size.width - 2, size.height - 2);
            await page.mouse.move(size.width - 2, size.height - 2);
            await page.waitForTimeout(segment.seconds * 1000);
            await page.screenshot({ path: `${temp}/${name}-${i}-end.png` });
            const video = page.video();
            if (!video) throw new Error("Browser recording did not start");
            await context.close();
            const clip = `${temp}/${name}-${i}.mp4`;
            clips.push(clip);
            execFileSync(
              "ffmpeg",
              [
                "-y",
                "-i",
                await video.path(),
                "-ss",
                String(trim),
                "-t",
                String(segment.seconds),
                "-an",
                "-vf",
                "setpts=(PTS-STARTPTS)/2,fps=30",
                "-c:v",
                "libx264",
                "-preset",
                "slow",
                "-crf",
                "22",
                "-pix_fmt",
                "yuv420p",
                clip,
              ],
              { stdio: "ignore" },
            );
          } finally {
            await context.close();
          }
        }
        const list = `${temp}/${name}.txt`;
        await writeFile(list, clips.map((p) => `file '${p}'`).join("\n"));
        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            `${out}/${name}.mp4`,
          ],
          { stdio: "ignore" },
        );
        await sharp(`${temp}/${name}-${demo.segments.length - 1}-end.png`)
          .webp({ quality: 90 })
          .toFile(`${out}/${name}-poster.webp`);
        await writeFile(
          `${temp}/${name}-provenance.json`,
          JSON.stringify(
            {
              sessionId: demo.sessionId,
              segments: demo.segments,
              speed: 2,
              source: "actual localDot task replay",
              size,
            },
            null,
            2,
          ),
        );
        console.log(`${name}: recorded actual task excerpts at 2x`);
      }),
    );
  }
} finally {
  await browser.close();
}
