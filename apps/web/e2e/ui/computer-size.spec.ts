import type { Locator, Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { openSettings } from "../settings-ui.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// The computer's memory and CPUs: two stepped sliders in Settings › Your computer and one row on
// setup's last step. Shots are for looking at: everything in Graphite and Daylight, and Settings
// in Midnight too. Setup's layout is also measured at c12, in a short 1280×720 window.
runAt("c14", "c12", "c39", "w39");

const GIB = 1024 ** 3;
const APPEARANCES = ["graphite", "daylight", "midnight"] as const;

const sizeGroup = (page: Page) =>
  page.locator("div:has(> .ui-group-head:has-text('Memory and CPUs'))");

async function sizeOf(page: Page, origin: string) {
  const reply = await page.request.get(`${origin}/api/computer-size`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return ((await reply.json()) as { size: { memoryBytes: number; cpus: number } }).size;
}

// The page and, beside it, the part that matters at full size: the tip opens above its trigger.
async function shoot(page: Page, part: Locator, name: string) {
  await page.waitForTimeout(200);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const box = await part.boundingBox();
  if (box)
    await page.screenshot({
      path: test.info().outputPath(`${name}-detail.png`),
      clip: {
        x: Math.max(0, box.x - 16),
        y: Math.max(0, box.y - 64),
        width: box.width + 32,
        height: box.height + 80,
      },
    });
}

// The column's foot room, calc(var(--spacing) * 6), between the last step's note and its buttons.
const FOOT_ROOM = 24;

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not laid out");
  return found;
}
const centre = (found: { x: number; width: number }) => found.x + found.width / 2;

// Setup's last step shares one centre with the page and keeps its buttons clear of the note,
// scrolled to its end, collapsed or open. Returns what it measured, for the report.
async function balanced(page: Page, panel?: Locator) {
  const middle = (page.viewportSize()?.width ?? 0) / 2;
  const card = await box(page.locator(".onboarding-content > .ui-group"));
  const heading = await box(page.getByRole("heading", { name: "You're all set." }));
  await page.locator(".onboarding-scroll").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  const note = await box(page.locator(".onboarding-note"));
  const buttons = await box(
    page.locator(isPhone(page) ? ".onboarding-foot" : ".onboarding-footer"),
  );
  const inside = panel && (await box(panel));
  const measured = {
    middle,
    card: centre(card),
    heading: centre(heading),
    buttons: centre(buttons),
    gap: Math.round(buttons.y - (note.y + note.height)),
    ...(inside && {
      insets: [
        Math.round(inside.x - card.x),
        Math.round(card.x + card.width - (inside.x + inside.width)),
      ],
    }),
  };
  console.log(`${test.info().project.name} ${test.info().title}: ${JSON.stringify(measured)}`);
  for (const at of [measured.card, measured.heading, measured.buttons])
    expect(Math.abs(at - middle)).toBeLessThanOrEqual(1);
  expect(measured.gap).toBeGreaterThanOrEqual(FOOT_ROOM);
  if (inside)
    expect(
      Math.abs(inside.x - card.x - (card.x + card.width - inside.x - inside.width)),
    ).toBeLessThanOrEqual(1);
  return card;
}

async function noSideScroll(page: Page) {
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll(".ui-sheet-body")].every(
        (body) => body.scrollWidth <= body.clientWidth,
      ),
    ),
  ).toBe(true);
}

for (const appearance of APPEARANCES)
  test.describe(appearance, () => {
    test.beforeEach(async ({ page }) => {
      const { title, project } = test.info();
      test.skip(
        appearance === "midnight" && !title.startsWith("Settings"),
        "Midnight shares Graphite's roles; its shot is of Settings",
      );
      test.skip(project.name === "c12" && !title.startsWith("setup"), "c12 measures setup");
      if (project.name === "c12") await page.setViewportSize({ width: 1280, height: 720 });
      await page.addInitScript((choice) => {
        localStorage.setItem("localdot.appearance.v1", choice);
      }, appearance);
    });

    test("Settings sizes the computer with stepped sliders that stop where Docker does", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("ready");
      // A 16 GB Docker Desktop, with another dot's computer running at today's size.
      await page.request.post(`${fixture.origin}/__qa/docker?memory=15.6`);
      await page.request.post(`${fixture.origin}/__qa/docker/others?memory=4&cpus=4`);
      await openSettings(page, undefined, "Your computer");
      const group = sizeGroup(page);
      await group.scrollIntoViewIfNeeded();
      const memory = group.getByRole("slider", { name: "Memory" });
      const cpus = group.getByRole("slider", { name: "CPUs" });
      await expect(memory).toHaveAttribute("aria-valuetext", "4 GB");
      await expect(cpus).toHaveAttribute("aria-valuetext", "4 CPUs");
      for (const key of ["0.9 GB in use", "Other dots hold 4 GB", "2 GB kept free"])
        await expect(memory).toHaveAccessibleDescription(new RegExp(key));
      for (const key of [/CPUs in use/, /Other dots hold 4 CPUs/])
        await expect(cpus).toHaveAccessibleDescription(key);
      await expect(group).toContainText(
        "The web browser runs beside the desktop with 3 GB and 2 CPUs of its own.",
      );

      // Keys: Home and End stop where the user may go, and pushing on says why.
      await memory.focus();
      await page.keyboard.press("End");
      await expect(memory).toHaveAttribute("aria-valuetext", "9.5 GB");
      await page.keyboard.press("ArrowRight");
      await expect(group.locator(".ui-step-slider-reason").first()).toHaveText(
        "That's all Docker can hold for it: other dots hold 4 GB and 2 GB stays free for the web browser and Docker.",
      );
      await expect(memory).toHaveAccessibleDescription(/That's all Docker can hold for it/);
      await page.keyboard.press("Home");
      await expect(memory).toHaveAttribute("aria-valuetext", "2 GB");
      for (let step = 0; step < 8; step++) await page.keyboard.press("ArrowRight");
      await expect(memory).toHaveAttribute("aria-valuetext", "6 GB");
      await cpus.focus();
      await page.keyboard.press("PageUp");
      await expect(cpus).toHaveAttribute("aria-valuetext", "6 CPUs");
      await expect
        .poll(() => sizeOf(page, fixture.origin))
        .toEqual({ memoryBytes: 6 * GIB, cpus: 6 });
      const applied = await (await page.request.get(`${fixture.origin}/__qa/docker`)).json();
      expect(Object.values(applied)).toContainEqual({
        Memory: 6 * GIB,
        MemorySwap: 6 * GIB + 256 * 1024 ** 2,
        NanoCpus: 6e9,
      });
      await expect(group).toContainText(
        "with 4.5 GB and 3 CPUs of its own. Changes apply at once.",
      );

      // A drag past the end stops at what Docker can hold.
      if (!isPhone(page)) {
        const track = await memory.boundingBox();
        if (!track) throw new Error("no track");
        await page.mouse.move(track.x + track.width * 0.4, track.y + track.height / 2);
        await page.mouse.down();
        await page.mouse.move(track.x + track.width - 2, track.y + track.height / 2, { steps: 6 });
        await page.mouse.up();
        await expect(memory).toHaveAttribute("aria-valuetext", "9.5 GB");
        for (let step = 0; step < 7; step++) await page.keyboard.press("ArrowLeft");
        await expect(memory).toHaveAttribute("aria-valuetext", "6 GB");
      }

      // The tip on Docker's limit, by hover on a desktop and by a tap on a phone.
      const limit = group.getByRole("button", { name: "Memory limit: 15.6 GB" });
      await expect(limit).toHaveAccessibleDescription(
        "Docker gives localDot 15.6 GB. Raise it in Docker Desktop → Settings → Resources.",
      );
      if (isPhone(page)) await limit.tap();
      else await limit.hover();
      await expect(page.locator(".ui-tooltip:not([data-closing])")).toHaveText(
        "Docker gives localDot 15.6 GB. Raise it in Docker Desktop → Settings → Resources.",
      );
      await noSideScroll(page);
      await ui.settle();
      await shoot(page, group, `settings-${appearance}`);
    });

    test("less memory than the computer uses waits for its next start", async ({ page, ui }) => {
      const fixture = await ui.open("ready");
      await page.request.post(`${fixture.origin}/__qa/docker/used?memory=3.2`);
      await openSettings(page, undefined, "Your computer");
      const group = sizeGroup(page);
      await group.scrollIntoViewIfNeeded();
      const memory = group.getByRole("slider", { name: "Memory" });
      await memory.focus();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await expect(group).toContainText(
        "Saved. The computer is using more memory than that right now, so the smaller size applies when it next starts.",
      );
      expect((await sizeOf(page, fixture.origin)).memoryBytes).toBe(3 * GIB);
      const applied = await (await page.request.get(`${fixture.origin}/__qa/docker`)).json();
      expect(Object.values(applied)).toContainEqual(
        expect.objectContaining({ Memory: 4 * GIB, NanoCpus: 4e9 }),
      );
      if (appearance === "graphite") {
        await ui.settle();
        await shoot(page, group, "settings-pending");
      }
    });

    test("setup recommends a size Docker can hold and gives it to the computer it turns on", async ({
      page,
      ui,
    }) => {
      await page.addInitScript(() =>
        localStorage.setItem("localdot.onboarding.v1", JSON.stringify({ step: "turn-on" })),
      );
      const fixture = await ui.open("model-ready");
      // A 9 GB Docker with another dot's computer running: today's 4 GB doesn't fit beside it.
      await page.request.post(`${fixture.origin}/__qa/docker?memory=9&cpus=8`);
      await page.request.post(`${fixture.origin}/__qa/docker/others?memory=4&cpus=4`);
      // Opened again on Docker as it is now; the first page's requests are cut off by it.
      ui.leaving();
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      await expect(page.getByRole("heading", { name: "You're all set." })).toBeVisible();
      const row = page.locator(".ui-group-row", { hasText: "Computer size" });
      await expect(row).toContainText("3 GB · 4 CPUs");
      await expect(row).toContainText("Recommended");
      await ui.settle();
      await ui.still();
      await balanced(page);
      await page.screenshot({ path: test.info().outputPath(`setup-${appearance}.png`) });

      await row.getByRole("button", { name: "Change computer size" }).click();
      const memory = row.getByRole("slider", { name: "Memory" });
      await expect(memory).toHaveAttribute("aria-valuetext", "3 GB");
      await ui.settle();
      const card = await balanced(page, row.locator(".onboarding-size"));
      const limit = row.getByRole("button", { name: "Memory limit: 9 GB" });
      await limit.scrollIntoViewIfNeeded();
      if (isPhone(page)) await limit.tap();
      else await limit.hover();
      const tip = page.locator(".ui-tooltip:not([data-closing])");
      await expect(tip).toHaveText(
        "Docker gives localDot 9 GB. Raise it in Docker Desktop → Settings → Resources.",
      );
      // The tip ends where the slider does, inside the card, rather than spilling past it.
      await expect
        .poll(async () => {
          const at = await box(tip);
          const end = await box(limit);
          return [
            Math.round(at.x + at.width - (end.x + end.width)),
            at.x >= card.x && at.x + at.width <= card.x + card.width,
          ];
        })
        .toEqual([0, true]);
      await ui.settle();
      await ui.still();
      await shoot(page, row, `setup-open-${appearance}`);
      await page.mouse.click(1, 1);

      await page.getByRole("button", { name: "Turn on your computer" }).click();
      await expect
        .poll(() => sizeOf(page, fixture.origin))
        .toEqual({ memoryBytes: 3 * GIB, cpus: 4 });
      await expect(page.getByRole("heading", { name: "You're all set." })).toHaveCount(0);
    });

    test("setup says plainly when Docker can't hold dot's computer", async ({ page, ui }) => {
      await page.addInitScript(() =>
        localStorage.setItem("localdot.onboarding.v1", JSON.stringify({ step: "turn-on" })),
      );
      const fixture = await ui.open("model-ready");
      await page.request.post(`${fixture.origin}/__qa/docker/others?memory=4&cpus=4`);
      // Opened again on Docker as it is now; the first page's requests are cut off by it.
      ui.leaving();
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      const row = page.locator(".ui-group-row", { hasText: "Computer size" });
      await expect(row.getByRole("alert")).toHaveText(
        "Docker can't hold dot's computer beside what else runs: it needs at least 2 GB. Docker gives localDot 7.6 GB. Raise it in Docker Desktop → Settings → Resources.",
      );
      await expect(page.getByRole("button", { name: "Turn on your computer" })).toBeVisible();
      await balanced(page);
      if (appearance === "graphite") {
        await ui.settle();
        await ui.still();
        await page.screenshot({ path: test.info().outputPath("setup-too-small.png") });
      }
    });
  });
