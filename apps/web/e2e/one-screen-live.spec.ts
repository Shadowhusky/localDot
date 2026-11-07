import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { browserWindow, MENU_BAR_PX } from "../src/stage/composite.ts";
import { docker, type RunningDaemon, startDaemon } from "./daemon.ts";
import { skipSetup } from "./skip-setup.ts";

// The web browser composited on the desktop's screen, on real containers: both streams on the one
// stage, and input reaching the right one, read back from each container's own X server.
// LOCALDOT_DESKTOP_IMAGE and LOCALDOT_BROWSER_IMAGE choose the images; QA_ONE_SCREEN_OUT keeps shots.
test.skip(process.env.LOCALDOT_DOCKER_TESTS !== "1", "needs Docker, built images and Chrome");
test.setTimeout(420_000);

const OUT = process.env.QA_ONE_SCREEN_OUT;
const DESKTOP = { w: 2560, h: 1600 };
const WINDOW = browserWindow(DESKTOP);
let daemon: RunningDaemon;

test.beforeAll(async () => {
  daemon = await startDaemon();
});
test.afterAll(async () => {
  await daemon?.stop();
});

// The window's own minimise light, in its title bar, and the web browser's item in the dock.
const minimise = (page: Page) =>
  page
    .getByRole("group", { name: /window$/ })
    .getByRole("button", { name: "Minimise the web browser" });
const showBrowser = (page: Page) => page.getByRole("button", { name: /^Show the web browser/ });

const browserContainer = (cellId: string) =>
  docker("ps", "--filter", `label=localdot.parent=${cellId}`, "--format", "{{.Names}}")
    .split("\n")
    .find((name) => name.startsWith("localdot-browser-")) ?? "";

// Where a container's X pointer is, in its own screen's pixels.
function pointer(container: string): { x: number; y: number } {
  const out = docker(
    "exec",
    "-e",
    "DISPLAY=:1",
    container,
    "xdotool",
    "getmouselocation",
    "--shell",
  );
  const value = (name: string) => Number(out.match(new RegExp(`${name}=(\\d+)`))?.[1]);
  return { x: value("X"), y: value("Y") };
}

async function shoot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

test("both streams make one screen, and input reaches the screen under the pointer", async ({
  page,
  browser: browserApp,
}) => {
  await skipSetup(page);
  page.on("console", (message) => {
    if (message.type() === "error")
      console.log("page error:", message.location().url.slice(0, 80), message.text().slice(0, 120));
  });
  const created = await daemon.request("/api/cells", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scale: 2, force: true }),
  });
  expect(created.status).toBe(202);
  const cellId = ((await created.json()) as { id: string }).id;
  const desktop = `localdot-desktop-${cellId}`;
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  const canvas = page.locator("canvas.stage-canvas");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")), { timeout: 300_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const status = await daemon.request(`/api/cells/${cellId}/browser`);
        return ((await status.json()) as { state?: string }).state;
      },
      { timeout: 240_000 },
    )
    .toBe("ready");
  const browser = browserContainer(cellId);
  expect(browser).not.toBe("");

  // The user takes the computer with dot on the desktop, and brings the browser forward from its
  // dock item.
  const taken = await daemon.request(`/api/cells/${cellId}/takeover`, { method: "POST" });
  expect(taken.status).toBe(202);
  await expect(page.getByRole("button", { name: "Hand back" })).toBeEnabled({ timeout: 60_000 });
  const surface = page.locator(".manual-surface");
  await expect(surface).toHaveAttribute("data-live", "");
  const box = await surface.boundingBox();
  if (!box) throw new Error("The computer view is missing");
  const scale = box.width / DESKTOP.w;
  const onScreen = (x: number, y: number) => ({
    x: box.x + (WINDOW.x + x * WINDOW.scale) * scale,
    y: box.y + (WINDOW.y + y * WINDOW.scale) * scale,
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await showBrowser(page).click();
  await expect(page.locator('iframe.desktop-frame[src*="/browser/"]')).toHaveCount(1);
  await expect(surface).toHaveAttribute("data-live", "");
  await expect(minimise(page)).toBeVisible();
  await page.waitForTimeout(1500);
  await shoot(page, "desktop-browser-in-front");

  // A press on the browser's page lands on the browser's X server, at the browser's own pixels.
  const desktopBefore = pointer(desktop);
  const target = { x: 1400, y: 900 };
  const point = onScreen(target.x, target.y);
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(() => {
      const at = pointer(browser);
      return Math.abs(at.x - target.x) <= 3 && Math.abs(at.y - target.y) <= 3;
    })
    .toBe(true);
  expect(pointer(desktop), "the desktop's pointer stayed put").toEqual(desktopBefore);

  // Keys go to the browser in front: typing an address changes its title.
  await page.keyboard.press("Control+l");
  await page.keyboard.type("data:text/html,<title>one-screen-keys</title><h1>typed here</h1>");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      () =>
        docker("exec", "-e", "DISPLAY=:1", browser, "xdotool", "getactivewindow", "getwindowname"),
      { timeout: 20_000 },
    )
    .toContain("one-screen-keys");

  // The bar above the window is the desktop's: a press there lands on the desktop's X server.
  const browserBefore = pointer(browser);
  await page.mouse.click(box.x + box.width * 0.75, box.y + (MENU_BAR_PX * 2 * scale) / 2);
  await expect
    .poll(() => {
      const at = pointer(desktop);
      return Math.abs(at.x - DESKTOP.w * 0.75) <= 3 && at.y <= MENU_BAR_PX * 2;
    })
    .toBe(true);
  expect(pointer(browser), "the browser's pointer stayed put").toEqual(browserBefore);
  // That press brought the desktop forward; it shows, and keys now go there.
  await expect(showBrowser(page)).toBeVisible();
  await expect(page.getByLabel("Type on the computer")).toHaveAttribute(
    "aria-description",
    /^Keys go to the desktop\./,
  );
  await expect(surface).toHaveAttribute("data-live", "");
  await page.waitForTimeout(800);
  await shoot(page, "desktop-desktop-in-front");

  // Alt+Tab brings the browser back, its picture at once, and reaches neither screen; a hand-back
  // leaves dot's screen alone.
  await page.keyboard.press("Alt+Tab");
  await expect(minimise(page)).toBeVisible();
  await expect(surface).toHaveAttribute("data-live", "");
  await page.getByRole("button", { name: "Hand back" }).click();
  await expect(page.getByRole("button", { name: "Hand back" })).toHaveCount(0, { timeout: 30_000 });
  await expect(showBrowser(page)).toBeVisible();

  // The stage follows the task: the web browser opened for the user comes forward by itself.
  const signIn = await daemon.request(`/api/cells/${cellId}/accounts/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ site: "example.com" }),
  });
  expect(signIn.status).toBe(202);
  await expect(minimise(page)).toBeVisible({ timeout: 30_000 });
  await expect(surface).toHaveAttribute("data-live", "");
  const pointBack = onScreen(1000, 700);
  await page.mouse.click(pointBack.x, pointBack.y);
  await expect
    .poll(() => {
      const at = pointer(browser);
      return Math.abs(at.x - 1000) <= 3 && Math.abs(at.y - 700) <= 3;
    })
    .toBe(true);
  await page.getByRole("button", { name: "Hand back" }).click();
  await expect(page.getByRole("button", { name: "Hand back" })).toHaveCount(0, { timeout: 30_000 });
  await page.context().close();

  // A phone, in both appearances: a tap and its keyboard reach the screen in front.
  const taken2 = await daemon.request(`/api/cells/${cellId}/takeover`, { method: "POST" });
  expect(taken2.status).toBe(202);
  for (const colorScheme of ["light", "dark"] as const)
    for (const size of ["desktop", "phone"] as const) {
      const viewport =
        size === "phone"
          ? {
              viewport: { width: 390, height: 844 },
              deviceScaleFactor: 3,
              isMobile: true,
              hasTouch: true,
            }
          : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
      const context = await browserApp.newContext({ ...viewport, colorScheme });
      const shown = await context.newPage();
      await skipSetup(shown);
      if (colorScheme === "light")
        await shown.addInitScript(() => localStorage.setItem("localdot.appearance.v1", "daylight"));
      await shown.goto(`${daemon.origin}/#token=${daemon.token}`);
      await expect(shown.locator(".manual-surface")).toHaveAttribute("data-live", "", {
        timeout: 60_000,
      });
      const toBrowser = showBrowser(shown);
      const hit = size === "phone" ? () => toBrowser.tap() : () => toBrowser.click();
      await hit();
      await expect(shown.locator('iframe.desktop-frame[src*="/browser/"]')).toHaveCount(1);
      await expect(shown.locator(".manual-surface")).toHaveAttribute("data-live", "");
      await shown.waitForTimeout(1800);
      await shoot(shown, `${size}-${colorScheme}-browser`);
      if (size === "phone") {
        const area = await shown.locator(".manual-surface").boundingBox();
        if (!area) throw new Error("The computer view is missing");
        const k = area.width / DESKTOP.w;
        const spot = { x: 1600 + (colorScheme === "dark" ? 100 : 0), y: 1000 };
        await shown.touchscreen.tap(
          area.x + (WINDOW.x + spot.x * WINDOW.scale) * k,
          area.y + (WINDOW.y + spot.y * WINDOW.scale) * k,
        );
        await expect
          .poll(() => {
            const at = pointer(browser);
            return Math.abs(at.x - spot.x) <= 6 && Math.abs(at.y - spot.y) <= 6;
          })
          .toBe(true);
        await shown.getByRole("button", { name: "Keyboard" }).tap();
        await expect(shown.getByLabel("Type on the computer")).toBeFocused();
        await shown.keyboard.press("Control+l");
        const title = `one-screen-phone-${colorScheme}`;
        await shown.keyboard.type(`data:text/html,<title>${title}</title><h1>from a phone</h1>`);
        await shown.keyboard.press("Enter");
        await expect
          .poll(
            () =>
              docker(
                "exec",
                "-e",
                "DISPLAY=:1",
                browser,
                "xdotool",
                "getactivewindow",
                "getwindowname",
              ),
            { timeout: 20_000 },
          )
          .toContain(title);
      }
      const toDesktop = minimise(shown);
      await (size === "phone" ? toDesktop.tap() : toDesktop.click());
      await expect(showBrowser(shown)).toBeVisible();
      await expect(shown.locator(".manual-surface")).toHaveAttribute("data-live", "");
      await shown.waitForTimeout(800);
      await shoot(shown, `${size}-${colorScheme}-desktop`);
      await context.close();
    }
});
