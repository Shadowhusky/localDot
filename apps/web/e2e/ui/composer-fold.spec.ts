import type { Locator, Page } from "@playwright/test";
import { composer, expect, isPhone, runAt, test } from "./harness.ts";

// Unfocused with nothing written the composer is one row, and the chat has the room; focus opens the
// rest of its controls, and Attach, Voice and Send never move.
runAt("c14", "c39", "w14", "w39");

const places = async (card: Locator) => {
  const place = async (name: RegExp | string) => {
    const box = await card.getByRole("button", { name }).first().boundingBox();
    return box && { x: Math.round(box.x), y: Math.round(box.y) };
  };
  return {
    attach: await place("Attach files"),
    mic: await place("Start voice input"),
    send: await card
      .locator(".composer-send")
      .boundingBox()
      .then((box) => box && { x: Math.round(box.x), y: Math.round(box.y) }),
  };
};

// Somewhere that takes focus from the field without being in the composer.
async function leave(page: Page) {
  await page.locator(".thread-scroll").click({ position: { x: 20, y: 20 } });
}

test("one row at rest, the rest on focus, and Attach, Voice and Send stay put", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const card = await composer(page);
  const model = card.locator(".composer-model");
  const permissions = card.getByRole("button", { name: /^Permission mode:/ });
  await ui.settle();
  await expect(card).toHaveAttribute("data-compact", "");
  await expect(model).toBeHidden();
  await expect(permissions).toBeHidden();
  const rest = await card.boundingBox();
  expect(rest?.height).toBeLessThanOrEqual(isPhone(page) ? 54 : 50);
  const before = await places(card);
  const field = card.getByRole("textbox").first();
  await page.screenshot({ path: test.info().outputPath("rest.png") });
  // All on one line.
  const box = await field.boundingBox();
  const send = await card.locator(".composer-send").boundingBox();
  expect(
    Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - ((send?.y ?? 0) + (send?.height ?? 0) / 2)),
  ).toBeLessThanOrEqual(2);

  await field.click();
  await expect(card).not.toHaveAttribute("data-compact");
  await expect(model).toBeVisible();
  await expect(permissions).toBeVisible();
  await ui.settle();
  const open = await card.boundingBox();
  expect(open?.height).toBeGreaterThan((rest?.height ?? 0) + 24);
  expect(await places(card)).toEqual(before);
  await page.screenshot({ path: test.info().outputPath("focused.png") });

  await leave(page);
  await expect(card).toHaveAttribute("data-compact", "");
  await ui.settle();
  expect(await places(card)).toEqual(before);
  await expect.poll(async () => (await card.boundingBox())?.height).toBe(rest?.height);
});

test("a draft keeps it open, and so does a popover from its row", async ({ page, ui }) => {
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const card = await composer(page);
  const field = card.getByRole("textbox").first();
  const permissions = card.getByRole("button", { name: /^Permission mode:/ });

  await field.click();
  await permissions.click();
  const menu = page.getByRole("menu", { name: "Permission mode" });
  await expect(menu).toBeVisible();
  await page.waitForTimeout(100);
  await expect(card).not.toHaveAttribute("data-compact");
  await expect(permissions).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(permissions).toBeFocused();
  await expect(card).not.toHaveAttribute("data-compact");

  await card.locator(".composer-model").click();
  const panel = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(panel).toBeVisible();
  await page.waitForTimeout(100);
  await expect(card).not.toHaveAttribute("data-compact");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await leave(page);
  await expect(card).toHaveAttribute("data-compact", "");

  await field.click();
  await field.fill("A draft");
  await leave(page);
  await page.waitForTimeout(100);
  await expect(card).not.toHaveAttribute("data-compact");
  await field.fill("");
  await expect(card).not.toHaveAttribute("data-compact");
  await leave(page);
  await expect(card).toHaveAttribute("data-compact", "");
});

test("Attach and Voice at rest leave the row folded", async ({ page, ui }) => {
  await ui.open("running");
  const card = await composer(page);
  await expect(card).toHaveAttribute("data-compact", "");
  await card.getByRole("button", { name: "Attach files" }).focus();
  await page.waitForTimeout(100);
  await expect(card).toHaveAttribute("data-compact", "");
});

test("a press in the thread lands, and only then does the card fold", async ({ page, ui }) => {
  await ui.open("image-output");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const card = await composer(page);
  const steps = page.locator(".thread-work-steps > .ui-disclosure-trigger:visible").last();
  await expect(steps).toHaveAttribute("aria-expanded", "false");
  await card.getByRole("textbox").first().click();
  await expect(card).not.toHaveAttribute("data-compact");
  await ui.settle();
  if (isPhone(page)) await steps.tap();
  else {
    const box = await steps.boundingBox();
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 8);
    await page.mouse.down();
    await ui.settle();
    expect(await steps.boundingBox()).toEqual(box);
    await expect(card).not.toHaveAttribute("data-compact");
    await page.mouse.up();
  }
  await expect(steps).toHaveAttribute("aria-expanded", "true");
  await expect(card).toHaveAttribute("data-compact", "");
});

test.describe("in motion", () => {
  test.use({ reducedMotion: "no-preference", fixedClock: false });

  // Where the end of the thread and the card's top are, each frame, while `act` happens.
  async function frames(page: Page, act: () => Promise<unknown>) {
    await page.evaluate(() => {
      const end = document.querySelector(".thread-end");
      const scroller = document.querySelector(".thread-scroll");
      const card = document.querySelector(".composer-card");
      const seen: { end: number; top: number; height: number; scroll: number }[] = [];
      (window as unknown as { seen: typeof seen }).seen = seen;
      const look = () => {
        seen.push({
          end: end?.getBoundingClientRect().bottom ?? 0,
          top: card?.getBoundingClientRect().top ?? 0,
          height: card?.getBoundingClientRect().height ?? 0,
          scroll: scroller?.getBoundingClientRect().height ?? 0,
        });
        (window as unknown as { looking: number }).looking = requestAnimationFrame(look);
      };
      look();
    });
    await act();
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      cancelAnimationFrame((window as unknown as { looking: number }).looking);
      return (
        window as unknown as {
          seen: { end: number; top: number; height: number; scroll: number }[];
        }
      ).seen;
    });
  }

  const steps = (values: number[]) =>
    values.slice(1).map((value, index) => value - (values[index] ?? value));

  test("the card eases and the chat goes with it, frame by frame", async ({ page, ui }) => {
    await ui.open("running");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const card = await composer(page);
    const field = card.getByRole("textbox").first();
    await ui.settle();
    await page.waitForTimeout(700);
    const opening = await frames(page, () => field.click());
    const closing = await frames(page, () => leave(page));
    const grew = (opening.at(-1)?.height ?? 0) - (opening[0]?.height ?? 0);
    expect(grew).toBeGreaterThan(24);
    for (const [name, seen] of [
      ["opening", opening],
      ["closing", closing],
    ] as const) {
      const heights = seen.map((frame) => frame.height);
      // Eased over more than one frame, never all at once, and only one way.
      const moving = steps(heights).filter((step) => Math.abs(step) > 0.25);
      expect(moving.length, `${name}: frames the card moved in`).toBeGreaterThan(2);
      expect(Math.max(...moving.map(Math.abs)), `${name}: largest step`).toBeLessThan(grew);
      expect(new Set(moving.map(Math.sign)).size, `${name}: one direction`).toBe(1);
      // The chat's end stays on the card, where the thread follows it, or holds still.
      const ends = seen.map((frame) => frame.end);
      expect(Math.max(...steps(ends).map(Math.abs)), `${name}: chat jump`).toBeLessThan(grew);
    }
  });

  test("a reader scrolled back sees nothing move", async ({ page, ui }) => {
    const fixture = await ui.open("running");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    await page.request.post(`${fixture.origin}/__qa/say?n=40&text=Checking%20the%20next%20part`);
    await expect(
      page.locator(".thread").getByText("Checking the next part (40)", { exact: true }),
    ).toBeAttached();
    await page.locator(".thread-scroll").evaluate((element) => element.scrollTo({ top: 200 }));
    const card = await composer(page);
    // Reading back can read more in above, whenever it likes, which keeps the rows in view where
    // they are: one row is followed by name, since its place in the list and the scroll top change.
    const key = await page.locator(".thread .thread-row").nth(4).getAttribute("data-row");
    const first = page.locator(`.thread .thread-row[data-row="${key}"]`);
    let before = await first.boundingBox();
    await expect(async () => {
      const was = before?.y;
      await page.waitForTimeout(400);
      before = await first.boundingBox();
      expect(before?.y).toBe(was);
    }).toPass();
    await card.getByRole("textbox").first().focus();
    await page.waitForTimeout(600);
    // Rows read in ease up by 6 px as they land.
    expect(Math.abs(((await first.boundingBox())?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(7);
  });
});

test("reduced motion: no glide at all", async ({ page, ui }) => {
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  const card = await composer(page);
  await card.getByRole("textbox").first().focus();
  expect(
    await card.evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter((motion) => !(motion instanceof CSSTransition)).length,
    ),
  ).toBe(0);
});
