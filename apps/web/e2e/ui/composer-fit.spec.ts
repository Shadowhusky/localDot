import type { Locator, Page } from "@playwright/test";
import sharp from "sharp";
import { expect, runAt, test } from "./harness.ts";

// How the composer's words sit in the card and how its controls' faces clear the card's edge, read
// from what is drawn rather than from boxes: a line box can be centred with its words looking low.
runAt("c14", "c39", "w14", "w39");
test.use({ deviceScaleFactor: 3 });

type Clip = { x: number; y: number; width: number; height: number };

// What a part of the page has drawn in it, top to bottom, against its own background; null if nothing.
async function readInk(page: Page, clip: Clip) {
  const shot = await page.screenshot({ clip });
  const { data, info } = await sharp(shot).grayscale().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / clip.width;
  const paper = data[info.width - 1] ?? 0;
  const inkAt = (x: number, y: number) => Math.abs((data[y * info.width + x] ?? 0) - paper);
  let strongest = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) strongest = Math.max(strongest, inkAt(x, y));
  if (!strongest) return null;
  let first = -1;
  let last = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (inkAt(x, y) > strongest / 2) {
        if (first < 0) first = y;
        last = y;
        break;
      }
  return { top: clip.y + first / scale, bottom: clip.y + (last + 1) / scale };
}

// A field's placeholder can be painted a moment after the field.
async function inkRows(page: Page, clip: Clip) {
  await expect.poll(() => readInk(page, clip)).not.toBeNull();
  const ink = await readInk(page, clip);
  if (!ink) throw new Error("Nothing drawn there");
  return ink;
}

// The space over a capital and under its baseline, with `band` the card's measure from its top.
async function capitalRoom(page: Page, card: Locator, field: Locator, band: number) {
  await card.evaluate((form) => {
    (form as HTMLElement).style.boxShadow = "none";
  });
  // The first line alone: nearer the field's top its corner can run under the card's rounded one.
  const clip = await field.evaluate((input) => {
    (input as HTMLElement).style.caretColor = "transparent";
    const style = getComputedStyle(input);
    const box = input.getBoundingClientRect();
    const size = Number.parseFloat(style.fontSize);
    const line =
      box.y + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
    return {
      x: Math.round(
        box.x + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth),
      ),
      y: Math.floor(line),
      width: Math.round(size * 0.8),
      height: Math.ceil(Number.parseFloat(style.lineHeight)),
    };
  });
  const top = (await card.boundingBox())?.y ?? 0;
  const capital = await inkRows(page, clip);
  await card.evaluate((form) => {
    (form as HTMLElement).style.removeProperty("box-shadow");
  });
  return { above: capital.top - top, below: band - (capital.bottom - top) };
}

// Where the row's icons and the model's name are centred, by their boxes, from the card's top.
const rowCentres = (card: Locator) =>
  card.evaluate((form) => {
    const top = form.getBoundingClientRect().top;
    const centre = (part: Element) => {
      const box = part.getBoundingClientRect();
      return box.width ? box.top + box.height / 2 - top : null;
    };
    const icons = [...form.querySelectorAll(".composer-bar button > svg")].flatMap((icon) => {
      const at = centre(icon);
      return at === null ? [] : [at];
    });
    const model = form.querySelector(".composer-model .ui-middle");
    const name = model?.getBoundingClientRect();
    return {
      icons,
      name: model && centre(model),
      nameBox: name && { x: name.x, y: name.y, width: name.width, height: name.height },
      iconsTop: Math.min(
        ...[...form.querySelectorAll(".composer-bar button > svg")].flatMap((icon) => {
          const box = icon.getBoundingClientRect();
          return box.width ? [box.top - top] : [];
        }),
      ),
    };
  });

// A capital reads as centred at or a little above the middle: the lowercase hangs under its middle.
const expectCentred = (room: { above: number; below: number }) => {
  expect(room.below - room.above).toBeGreaterThanOrEqual(-0.5);
  expect(room.below - room.above).toBeLessThanOrEqual(3);
};

// How far each visible control's face, drawn or not until it is pressed, keeps inside the card's
// rounded edge at its closest.
const faceClearances = (card: Locator) =>
  card.evaluate((form) => {
    const edge = form.getBoundingClientRect();
    const round = Number.parseFloat(getComputedStyle(form).borderTopLeftRadius);
    const outside = (x: number, y: number) => {
      const qx = Math.abs(x - edge.x - edge.width / 2) - (edge.width / 2 - round);
      const qy = Math.abs(y - edge.y - edge.height / 2) - (edge.height / 2 - round);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - round;
    };
    return [...form.querySelectorAll<HTMLElement>(".composer-bar button")]
      .filter((button) => button.getBoundingClientRect().width > 0)
      .map((button) => {
        const box = button.getBoundingClientRect();
        const own = getComputedStyle(button);
        const face = getComputedStyle(button, "::before");
        const drawn = face.content !== "none";
        const inset = (side: "top" | "right" | "bottom" | "left", border: string) =>
          drawn ? Number.parseFloat(face[side]) + Number.parseFloat(border) : 0;
        const left = box.left + inset("left", own.borderLeftWidth);
        const right = box.right - inset("right", own.borderRightWidth);
        const top = box.top + inset("top", own.borderTopWidth);
        const bottom = box.bottom - inset("bottom", own.borderBottomWidth);
        const radius = Math.min(
          Number.parseFloat(drawn ? face.borderTopLeftRadius : own.borderTopLeftRadius),
          (right - left) / 2,
          (bottom - top) / 2,
        );
        let closest = Number.POSITIVE_INFINITY;
        for (const [cx, cy, sx, sy] of [
          [left + radius, top + radius, -1, -1],
          [right - radius, top + radius, 1, -1],
          [left + radius, bottom - radius, -1, 1],
          [right - radius, bottom - radius, 1, 1],
        ] as const)
          for (let angle = 0; angle <= 90; angle += 3) {
            const a = (angle * Math.PI) / 180;
            closest = Math.min(
              closest,
              -outside(cx + sx * radius * Math.cos(a), cy + sy * radius * Math.sin(a)),
            );
          }
        return { name: button.getAttribute("aria-label") ?? "", clear: closest };
      });
  });

for (const view of ["chat", "studio"] as const)
  test.describe(`${view} view`, () => {
    test.use({ viewStyle: view });

    test("the words are centred at rest and open, the row shares a line, and every face clears the card", async ({
      page,
      ui,
    }) => {
      await ui.open("running");
      await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
      const card = page.getByRole("form", { name: "Message dot" });
      const field = card.getByRole("textbox", { name: "Message", exact: true });
      await ui.settle();
      await expect(card).toHaveAttribute("data-compact", "");
      const height = async () => (await card.boundingBox())?.height ?? 0;
      expectCentred(await capitalRoom(page, card, field, await height()));

      await field.click();
      await expect(card).not.toHaveAttribute("data-compact");
      await ui.settle();
      const pill = (await card.getAttribute("data-layout")) === "pill";
      const row = await rowCentres(card);
      // In the one-line pill the row shows only its icons and the name; a wider card's controls have
      // faces of their own, up to Send's top.
      const under = pill
        ? row.iconsTop
        : await card.evaluate((form) => {
            const send = form.querySelector(".composer-send")?.getBoundingClientRect();
            return (send?.top ?? 0) - form.getBoundingClientRect().top;
          });
      const open = await capitalRoom(page, card, field, under);
      expect(open.above, "room over the words").toBeGreaterThanOrEqual(16);
      expect(Math.abs(open.below - open.above), "room over and under").toBeLessThanOrEqual(3);

      for (const icon of row.icons) expect(Math.abs(icon - (row.icons[0] ?? 0))).toBeLessThan(1);
      const line = row.icons[0] ?? 0;
      expect(
        Math.abs((row.name ?? 0) - line),
        "the name's box on the icons' line",
      ).toBeLessThanOrEqual(1);
      if (!row.nameBox) throw new Error("Missing the model's name");
      const nameInk = await inkRows(page, {
        x: Math.floor(row.nameBox.x),
        y: Math.floor(row.nameBox.y),
        width: Math.ceil(row.nameBox.width),
        height: Math.ceil(row.nameBox.height),
      });
      const cardTop = (await card.boundingBox())?.y ?? 0;
      const nameMiddle = (nameInk.top + nameInk.bottom) / 2 - cardTop;
      expect(nameMiddle - line, "the name's capitals at or just over the line").toBeLessThanOrEqual(
        0.25,
      );
      expect(
        nameMiddle - line,
        "the name's capitals at or just over the line",
      ).toBeGreaterThanOrEqual(-1.5);

      for (const { name, clear } of await faceClearances(card))
        expect(clear, `${name} clear of the card`).toBeGreaterThanOrEqual(3.5);
      await page.screenshot({ path: test.info().outputPath(`${view}-open.png`) });

      await field.fill("Message");
      await ui.settle();
      const typed = await capitalRoom(page, card, field, under);
      expect(Math.abs(typed.below - typed.above), "room over and under").toBeLessThanOrEqual(3);
    });
  });
