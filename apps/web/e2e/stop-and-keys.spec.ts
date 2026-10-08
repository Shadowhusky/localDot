import { expect, test } from "@playwright/test";
import { desktopContainer, docker, type RunningDaemon, startDaemon } from "./daemon.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
let daemon: RunningDaemon;
let pageErrors: string[];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.stack ?? err.message));
});
test.afterEach(async ({ page }) => {
  if (pageErrors.length) await page.screenshot({ path: "e2e/out/paused-error.png" });
  expect(pageErrors).toEqual([]);
});

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images, Docker Desktop and the internet");

test.beforeAll(async () => {
  daemon = await startDaemon();
});

test.afterAll(async () => {
  await daemon?.stop();
});

test("a key's use shows in the steps; Stop freezes the computer and Resume thaws it", async ({
  page,
}) => {
  const auth = { authorization: `Bearer ${daemon.token}` };
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);

  // A web API key for postman-echo.com, sealed in the page as a user would add it. The value is a
  // stand-in: postman-echo answers anything.
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys" });
  await sheet.getByRole("button", { name: "Web API" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("echo");
  await sheet.getByLabel("Hosts", { exact: true }).fill("postman-echo.com");
  await sheet.getByLabel("Key", { exact: true }).fill(`e2e-${Date.now()}-echo-value`);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Saved echo.");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Turn on" }).first().click();
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });
  const cells = (await (await fetch(`${daemon.origin}/api/cells`, { headers: auth })).json()) as {
    id: string;
  }[];
  const cellId = cells[0]?.id ?? "";

  // The puppet types a request carrying the key's surrogate into a terminal, then waits so the
  // session is still live when Stop is pressed.
  const script = {
    v: 1,
    title: "Use a web API key",
    steps: [
      { do: "launch", app: "terminal", waitMs: 4000 },
      {
        do: "type",
        text: 'curl -s -o /dev/null -H "Authorization: Bearer $LOCALDOT_KEY_ECHO" https://postman-echo.com/get',
      },
      { do: "key", combo: ["Return"] },
      { do: "wait", ms: 30_000 },
    ],
  };
  const started = await fetch(`${daemon.origin}/api/cells/${cellId}/puppet`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(script),
  });
  expect(started.status).toBe(202);
  // An allowed use folds into the step it came with; unfolding the step lists it.
  const rail = page.getByRole("complementary", { name: "Plan and steps" });
  await expect(async () => {
    const head = rail.getByTestId("step-row").last().getByRole("button");
    if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
    await expect(rail.getByRole("list", { name: "Keys used" })).toContainText(
      "Used echo key → postman-echo.com",
      { timeout: 2000 },
    );
  }).toPass({ timeout: 90_000 });
  await page.screenshot({ path: "e2e/out/key-use.png" });

  // Stop: the session ends, keyd drops the computer's keys, and the computer freezes.
  const previousTicket = await page.locator("iframe.desktop-frame").getAttribute("src");
  await page.getByTestId("hud-stop-session").click();
  await expect(page.getByTestId("hud-status")).toHaveText("Paused", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Resume computer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop computer" })).toBeVisible();
  expect(docker("inspect", "--format", "{{.State.Paused}}", desktopContainer(cellId))).toBe("true");
  await expect(page.locator("iframe.desktop-frame")).toHaveCount(0);
  await expect(page.locator(".stage-veil.on")).toHaveCount(0);
  await expect(page.locator(".caption")).toContainText("programs dot started carry on");
  await expect(page.locator(".stage.frozen > canvas")).toHaveCSS("opacity", "0.55");
  await page.screenshot({ path: "e2e/out/paused.png" });
  await page.setViewportSize({ width: 375, height: 760 });
  for (const label of ["Resume computer", "Stop computer"]) {
    const bounds = await page.getByRole("button", { name: label }).boundingBox();
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375).toBe(true);
  }
  await page.screenshot({ path: "e2e/out/paused-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "Resume computer" }).click();
  await expect(page.getByTestId("hud-status")).not.toHaveText("Paused", { timeout: 20_000 });
  await expect(page.locator("iframe.desktop-frame")).not.toHaveAttribute(
    "src",
    previousTicket ?? "",
  );
  expect(docker("inspect", "--format", "{{.State.Paused}}", desktopContainer(cellId))).toBe(
    "false",
  );
  const canvas = page.locator("canvas.stage-canvas");
  const beforeFrames = Number(await canvas.getAttribute("data-frames"));
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")), { timeout: 30_000 })
    .toBeGreaterThan(beforeFrames);

  // A later Stop with keyd offline must stay paused and explain why Resume was refused.
  const second = await daemon.request(`/api/cells/${cellId}/puppet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, title: "Pause safely", steps: [{ do: "wait", ms: 30_000 }] }),
  });
  expect(second.status).toBe(202);
  await expect(page.getByTestId("hud-stop-session")).toBeVisible();
  await page.getByTestId("hud-stop-session").click();
  await expect(page.getByTestId("hud-status")).toHaveText("Paused", { timeout: 20_000 });
  await daemon.keyd.stop();
  await page.getByRole("button", { name: "Resume computer" }).click();
  await expect(page.locator(".caption")).toHaveText(
    /the key layer is offline: start keyd, then resume the computer/,
  );
  await expect(page.getByTestId("hud-status")).toHaveText("Paused", { timeout: 20_000 });
  expect(docker("inspect", "--format", "{{.State.Paused}}", desktopContainer(cellId))).toBe("true");
});
