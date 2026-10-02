import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { type CellRef, createReadyCell, removeCell } from "./cells.ts";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";
import { runPuppet, sessionEvents, waitForSessionEnd } from "./puppet.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
const SCRIPT = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../daemon/puppet/demo-multiapp.json", import.meta.url)),
    "utf8",
  ),
);
let daemon: RunningDaemon;
let cell: CellRef;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images and Docker Desktop");
test.beforeAll(async () => {
  daemon = await startDaemon();
  cell = await createReadyCell(daemon, 2);
});
test.afterAll(async () => {
  if (cell) await removeCell(daemon, cell.id);
  await daemon?.stop();
});

test("the puppet runs a multi-app sequence live in the Theatre with the overlays", async ({
  page,
}) => {
  page.on("pageerror", (error) => console.error(`Theatre error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`Theatre console: ${message.text()}`);
  });
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 120_000 });
  await expect
    .poll(
      async () => Number(await page.locator("canvas.stage-canvas").getAttribute("data-frames")),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const backing = await page
    .locator("canvas.stage-canvas")
    .evaluate((canvas: HTMLCanvasElement) => ({
      actual: canvas.width,
      expected: Math.round(canvas.getBoundingClientRect().width * devicePixelRatio),
    }));
  expect(backing.actual).toBe(backing.expected);
  const sessionId = await runPuppet(daemon, cell.id, SCRIPT);
  await expect(page.getByTestId("hud-status")).toHaveText("Opening calc", { timeout: 15_000 });
  await expect(page.locator(".stage.control")).toBeVisible();
  await expect(page.getByTestId("hud-stop-session")).toBeVisible();
  await expect(page.getByTestId("hud-status")).toHaveText('Clicking "Name Box"', {
    timeout: 30_000,
  });
  await page.screenshot({ path: "e2e/out/10-click-name-box.png" });
  await expect(page.getByTestId("hud-status")).toHaveText('Typing "Q3 revenue"', {
    timeout: 30_000,
  });
  await page.screenshot({ path: "e2e/out/11-typing.png" });
  // Review Focus 1 on the real path (P3-C11): pause this cell's desktop (never another cell on this
  // Docker) during the script's dedicated 10 s wait step, never mid-input, so the test exercises
  // reconnection rather than desktopd's /input and /observe client timeouts; the HUD reports the
  // stall and the session completes after unpause.
  await expect(page.getByTestId("hud-status")).toHaveText("Waiting for the sheet", {
    timeout: 30_000,
  });
  const container = desktopContainer(cell.id);
  expect(container).toBe(`localdot-desktop-${cell.id}`);
  execFileSync("docker", ["pause", container]);
  await expect(page.locator(".stage-veil.on")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  execFileSync("docker", ["unpause", container]);
  await expect(page.locator(".stage-veil.on")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("hud-status")).toHaveText('Clicking "Page two"', {
    timeout: 120_000,
  });
  await page.screenshot({ path: "e2e/out/12-chromium-link.png" });
  const events = await waitForSessionEnd(daemon, sessionId, 240_000);
  expect(events.at(-1)?.data.reason).toBe("done");
  expect(events.filter((e) => e.type === "action.cancel")).toEqual([]);
  await expect(page.getByTestId("hud-status")).toHaveText("Done", { timeout: 15_000 });
  await expect(page.locator(".stage.control")).toHaveCount(0);
  const rows = page.getByTestId("step-row");
  await expect(rows).toHaveCount(SCRIPT.steps.length);
  await expect(rows.first().locator("img")).toHaveAttribute("src", /^blob:/);
  await page.screenshot({ path: "e2e/out/13-done.png" });

  const order = [
    "action.intent",
    "action.target",
    "action.dispatch",
    "screen.settle",
    "observe",
    "action.result",
  ];
  const nameBoxStep = events.find(
    (e) => e.type === "action.intent" && e.data.label === 'Click "Name Box"',
  )?.step;
  const stepEvents = (await sessionEvents(daemon, sessionId))
    .filter((e) => e.step === nameBoxStep && order.includes(e.type))
    .map((e) => e.type);
  expect(stepEvents).toEqual(order);
});
