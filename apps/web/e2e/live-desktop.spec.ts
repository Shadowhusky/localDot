import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import { desktopContainer, docker, type RunningDaemon, startDaemon } from "./daemon.ts";

test.skip(process.env.LOCALDOT_DOCKER_TESTS !== "1", "needs Docker, built images and Chrome");
let daemon: RunningDaemon;
test.beforeAll(async () => {
  daemon = await startDaemon();
});
test.afterAll(async () => {
  await daemon?.stop();
});

async function expectFrames(page: Page) {
  const canvas = page.locator("canvas.stage-canvas");
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute("data-size", "2560x1600");
  const png = await canvas.screenshot();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  let sum = 0;
  let sumSq = 0;
  const pixels = info.width * info.height;
  for (let i = 0; i < pixels; i++) {
    const luma =
      0.2126 * (data[i * info.channels] ?? 0) +
      0.7152 * (data[i * info.channels + 1] ?? 0) +
      0.0722 * (data[i * info.channels + 2] ?? 0);
    if (luma > 30) bright++;
    sum += luma;
    sumSq += luma * luma;
  }
  expect(bright / pixels, "the stage contains a visible desktop").toBeGreaterThan(0.05);
  expect(
    Math.sqrt(sumSq / pixels - (sum / pixels) ** 2),
    "the desktop has structure",
  ).toBeGreaterThan(10);
  await expect(page.locator(".stage.lit")).toBeVisible();
  await expect(page.locator(".stage-veil.on")).toHaveCount(0);
}

test("live 2x desktop survives Stop/Start and a daemon restart", async ({ page }) => {
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page).toHaveURL(`${daemon.origin}/`);
  await expect(page.getByTestId("hud-status")).toHaveText("No computer");
  await page.screenshot({ path: "e2e/out/01-empty.png" });
  const created = page.waitForResponse(
    (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/cells",
  );
  await page.getByRole("button", { name: "Start computer" }).click();
  const cellId = ((await (await created).json()) as { id: string }).id;
  await expectFrames(page);
  await page.screenshot({ path: "e2e/out/02-theatre-live.png" });

  const desktop = desktopContainer(cellId);
  expect(desktop).toBe(`localdot-desktop-${cellId}`);
  const xfconf = (prop: string) =>
    docker("exec", "-u", "abc", desktop, "xfconf-query", "-c", "xsettings", "-p", prop);
  expect(xfconf("/Gdk/WindowScalingFactor")).toBe("2");
  expect(xfconf("/Xft/DPI")).toBe("96");

  await page.getByRole("button", { name: "Stop computer" }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("Stopped", { timeout: 60_000 });
  await page.getByRole("button", { name: "Start computer" }).click();
  await expectFrames(page);
  const previousTicket = await page.locator("iframe.desktop-frame").getAttribute("src");
  await daemon.restart();
  await expect(page.locator("iframe.desktop-frame")).not.toHaveAttribute(
    "src",
    previousTicket ?? "",
  );
  await expectFrames(page);
  await page.screenshot({ path: "e2e/out/03-restarted.png" });

  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(page.getByRole("complementary", { name: "Conversation" })).toBeHidden();
  const hud = await page.locator(".hud").boundingBox();
  const stage = await page.locator(".stage").boundingBox();
  expect(hud && stage && hud.x >= stage.x && hud.x + hud.width <= stage.x + stage.width).toBe(true);
  await page.screenshot({ path: "e2e/out/04-narrow.png" });

  // A cell-controlled client cannot embed the Theatre or replace its stored token.
  const frame = page.frames().find((f) => f.url().includes(`/cells/${cellId}/desktop/`));
  expect(frame).toBeDefined();
  await frame?.goto(`${daemon.origin}/#token=${"z".repeat(43)}`).catch(() => {});
  await expect.poll(() => frame?.locator("#root").count()).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("localdot.token"))).toBe(daemon.token);

  // Removal during a lost status connection must recover to No computer, not reconnect forever.
  await page.context().setOffline(true);
  const removed = await daemon.request(`/api/cells/${cellId}?purge=1`, { method: "DELETE" });
  expect(removed.status).toBe(204);
  await page.context().setOffline(false);
  await expect(page.getByTestId("hud-status")).toHaveText("No computer", { timeout: 30_000 });
});
