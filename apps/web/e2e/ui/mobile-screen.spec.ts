import { composer, expect, finger, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test("minimize gives the conversation room and restores the same computer", async ({
  page,
  ui,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await ui.open("running");
  const chat = page.locator(".rail-chat");
  const stage = page.locator(".stage").first();
  const original = await stage.elementHandle();
  const before = await chat.evaluate((n) => n.clientHeight);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Minimize screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show screen", exact: true })).toBeVisible();
  await expect.poll(() => chat.evaluate((n) => n.clientHeight)).toBeGreaterThan(before + 200);
  const field = await composer(page);
  const bottom = await field.boundingBox();
  if (!bottom) throw new Error("Composer is not visible");
  expect(bottom.y + bottom.height).toBeLessThanOrEqual(844);
  await expect(page.getByRole("menu")).toBeHidden();
  // Still live, small in a corner, and the conversation's text starts below it.
  await expect(stage).toHaveAttribute("data-floating");
  const tucked = page.getByRole("button", { name: "Show screen", exact: true });
  await expect.poll(async () => (await tucked.boundingBox())?.width ?? 999).toBeLessThan(390 / 2);
  await expect(async () => {
    const corner = await tucked.boundingBox();
    const text = await page.locator(".rail-chat .thread-scroll").boundingBox();
    expect(text?.y ?? 0).toBeGreaterThanOrEqual((corner?.y ?? 0) + (corner?.height ?? 0));
  }).toPass();
  await page.screenshot({ path: test.info().outputPath("conversation-expanded.png") });
  await page.getByRole("button", { name: "Show screen", exact: true }).click();
  await expect.poll(() => chat.evaluate((n) => n.clientHeight)).toBe(before);
  expect(await stage.evaluate((n, first) => n === first, original)).toBe(true);
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
});

test("Replay opens its picture when Watch is minimized and keeps the live preference", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("done");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Minimize screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show screen", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Replay", exact: true }).click();
  const library = page.getByRole("main", { name: "Replay" });
  await library.getByRole("button", { name: /^Earlier sample task 1/ }).click();
  const picture = page.locator(".replay-main .stage");
  await expect(page.locator(".replay-opening")).toBeHidden();
  await expect(picture).toBeVisible();
  await expect.poll(async () => (await picture.boundingBox())?.height ?? 0).toBeGreaterThan(100);
  await expect(page.locator(".app")).not.toHaveAttribute("data-screen-minimized");
  expect(await page.evaluate(() => localStorage.getItem("localdot.mobile-screen-minimized"))).toBe(
    "true",
  );
  await page.screenshot({ path: test.info().outputPath("replay-from-collapsed.png") });
  await page.getByRole("navigation").getByRole("button", { name: "Replay" }).click();
  await page
    .getByRole("navigation", { name: "Replay" })
    .getByRole("button", { name: "Watch" })
    .click();
  await expect(page.getByRole("button", { name: "Show screen", exact: true })).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute("data-screen-minimized");
  // Reloading a replay link must also ignore the saved live-screen preference.
  await page.goto(`${fixture.origin}/?replay=${fixture.seeded[0]}&t=20000`);
  await expect(page.locator(".replay-opening")).toBeHidden();
  await ui.picture(page.locator(".replay-main .stage"));
  await expect(page.locator(".replay-main .stage")).toBeVisible();
});

test("the island never runs under the buttons in its corners, at any phone width or length of status", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const status = page.getByTestId("hud-status");
  await expect(status).toHaveText("Select the Net total cell");
  const long = "Checking February's net total against revenue minus returns, row by row";
  const overlap = (a: DOMRect, b: DOMRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  for (const width of [320, 344, 360, 375, 390, 414, 430]) {
    await page.setViewportSize({ width, height: 800 });
    for (const words of ["Thinking", long]) {
      await status.evaluate((element, text) => {
        const shown = element.querySelector(".island-text-current");
        if (shown) shown.textContent = text;
      }, words);
      // The glass follows the row a moment after it changes.
      await expect(async () => {
        const fits = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector(selector)?.getBoundingClientRect().toJSON();
          return {
            plate: rect(".island-plate"),
            row: rect(".island-row"),
            left: rect(".island-conversations"),
            right: rect(".island-new"),
          };
        });
        for (const key of ["plate", "row"] as const) {
          const box = fits[key] as DOMRect;
          const left = fits.left as DOMRect;
          const right = fits.right as DOMRect | undefined;
          expect(overlap(box, left), `${key} over Conversations at ${width}`).toBe(false);
          if (right) expect(overlap(box, right), `${key} over New at ${width}`).toBe(false);
          expect(box.left - left.right, `${key}'s gap at ${width}`).toBeGreaterThanOrEqual(8);
          if (right)
            expect(right.left - box.right, `${key}'s gap at ${width}`).toBeGreaterThanOrEqual(8);
        }
        // The controls stay whole, on the island; the label shortens.
        const take = await page.getByRole("button", { name: "Take control" }).boundingBox();
        expect((take?.x ?? 0) + (take?.width ?? 0)).toBeLessThanOrEqual(
          (fits.plate as DOMRect).right,
        );
        await expect(page.getByTestId("hud-stop-session")).toBeVisible();
        const label = await status.boundingBox();
        expect(label?.width ?? 0).toBeGreaterThanOrEqual(50);
      }).toPass({ timeout: 5_000 });
    }
    await page.screenshot({
      path: test.info().outputPath(`island-${width}.png`),
      clip: { x: 0, y: 0, width, height: 120 },
    });
  }
});

test("reading back through the conversation tucks the screen into a corner, clear of the text", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const app = page.locator(".app");
  await expect(app).not.toHaveAttribute("data-entering");
  const chat = page.locator(".rail-chat");
  const thread = chat.locator(".thread-scroll");
  const before = await chat.evaluate((n) => n.clientHeight);
  const area = await thread.boundingBox();
  if (!area) throw new Error("No conversation");
  const x = area.x + area.width / 2;
  const y = area.y + 40;
  // Once the screen has come through the curtain; there is nothing to tuck away before.
  await expect(async () => {
    if (test.info().project.name.startsWith("c")) await (await finger(page)).drag(x, y, x, y + 120);
    else
      await thread.evaluate((element) =>
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true })),
      );
    await expect(app).toHaveAttribute("data-screen-minimized", { timeout: 1_000 });
  }).toPass();
  await expect.poll(() => chat.evaluate((n) => n.clientHeight)).toBeGreaterThan(before + 200);

  // In the top corner under the island, and the conversation's text starts below it.
  const tucked = page.getByRole("button", { name: "Show screen", exact: true });
  const width = page.viewportSize()?.width ?? 0;
  const height = page.viewportSize()?.height ?? 0;
  const corner = await tucked.boundingBox();
  const island = await page.locator(".island").boundingBox();
  if (!corner || !island) throw new Error("No picture");
  expect(corner.width).toBeLessThan(width / 2);
  expect(corner.x + corner.width).toBeGreaterThan(width - 24);
  expect(corner.y).toBeGreaterThanOrEqual(island.y + island.height);
  expect((await thread.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(corner.y + corner.height);

  // A finger takes it to the corner it is let go nearest, and the text makes room there instead.
  await (await finger(page)).drag(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2,
    80,
    height - 220,
  );
  await expect(app).toHaveAttribute("data-pip", "bottom-left");
  await expect(app).toHaveAttribute("data-screen-minimized");
  await expect.poll(async () => Math.round((await tucked.boundingBox())?.x ?? 0)).toBe(12);
  const low = await tucked.boundingBox();
  const foot = await chat.locator(".thread-foot").boundingBox();
  const text = await thread.boundingBox();
  if (!low || !foot || !text) throw new Error("No picture");
  expect(low.y + low.height).toBeLessThanOrEqual(foot.y);
  expect(text.y + text.height).toBeLessThanOrEqual(low.y);
  expect(text.y).toBeLessThan(corner.y + corner.height);
  await page.screenshot({ path: test.info().outputPath("tucked-low.png") });

  // A tap brings it back where it was.
  await tucked.click();
  await expect(app).not.toHaveAttribute("data-screen-minimized");
  await expect(app).not.toHaveAttribute("data-pip");
  await expect.poll(() => chat.evaluate((n) => n.clientHeight)).toBe(before);
});
