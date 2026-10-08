import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  decodeImage,
  ellipseVerdict,
  fillVerdict,
  jsonVerdict,
  placementVerdict,
  tableVerdict,
  textVerdict,
} from "./checks.ts";

const W = 640;
const H = 400;
const svg = (body: string) =>
  decodeImage(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${body}</svg>`,
    ),
  );
const pngOf = async (body: string) =>
  decodeImage(
    await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`,
      ),
    )
      .png()
      .toBuffer(),
  );
const ring = (extra = "") =>
  `<ellipse cx="320" cy="200" rx="192" ry="120" fill="none" stroke="#000" stroke-width="40" ${extra}/>`;
// The same ellipse traced every half degree, leaving out `gap` degrees around `at`.
const openRing = (gap: number, width: number, at = 0) => {
  const points: string[] = [];
  for (let d = gap / 2; d <= 360 - gap / 2; d += 0.5) {
    const t = ((at + d) * Math.PI) / 180;
    points.push(`${(320 + 192 * Math.cos(t)).toFixed(2)},${(200 + 120 * Math.sin(t)).toFixed(2)}`);
  }
  return `<polyline points="${points.join(" ")}" fill="none" stroke="#000" stroke-width="${width}"/>`;
};

describe("ellipseVerdict", () => {
  it("accepts a closed ellipse outline drawn with a thick soft brush", async () => {
    expect(ellipseVerdict(await svg(ring()))).toEqual({ ok: true, reasons: [] });
  });

  it("accepts an ellipse painted in GIMP with its default soft brush", async () => {
    const painted = readFileSync(new URL("./fixtures/gimp-ellipse.png", import.meta.url));
    expect(ellipseVerdict(await decodeImage(painted))).toEqual({ ok: true, reasons: [] });
  });

  it("rejects the untouched canvas", async () => {
    expect(ellipseVerdict(await svg("")).ok).toBe(false);
  });

  it("rejects a filled ellipse", async () => {
    const v = ellipseVerdict(await svg(`<ellipse cx="320" cy="200" rx="192" ry="120"/>`));
    expect(v.reasons).toContain("the shape is filled, not an outline");
  });

  it("rejects an outline with a gap", async () => {
    const circumference = 2 * Math.PI * Math.sqrt((192 ** 2 + 120 ** 2) / 2);
    const v = ellipseVerdict(
      await svg(ring(`stroke-dasharray="${circumference * 0.8} ${circumference}"`)),
    );
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/open/);
  });

  it("rejects outlines left open by 5 or 10 degrees, whatever the brush", async () => {
    for (const width of [10, 20, 40])
      for (const gap of [5, 10])
        for (const at of [0, 45, 90, 180]) {
          const v = ellipseVerdict(await svg(openRing(gap, width, at)));
          expect(v.reasons.join(), `${gap}° gap at ${at}°, ${width} px`).toMatch(/open/);
        }
  });

  it("accepts the traced outline when nothing is left out", async () => {
    for (const width of [10, 20, 40])
      expect(ellipseVerdict(await svg(openRing(0, width))), `${width} px`).toEqual({
        ok: true,
        reasons: [],
      });
  });

  it("rejects a rectangle outline and a small dot", async () => {
    expect(
      ellipseVerdict(
        await svg(
          `<rect x="128" y="80" width="384" height="240" fill="none" stroke="#000" stroke-width="40"/>`,
        ),
      ).ok,
    ).toBe(false);
    expect(ellipseVerdict(await svg(`<circle cx="320" cy="200" r="30"/>`)).ok).toBe(false);
  });
});

describe("fillVerdict", () => {
  it("accepts a canvas filled with the colour", async () => {
    expect(
      fillVerdict(await svg(`<rect width="${W}" height="${H}" fill="#a9743e"/>`), "#A9743E").ok,
    ).toBe(true);
  });

  it("rejects the untouched canvas, a near colour and a half fill", async () => {
    expect(fillVerdict(await svg(""), "#A9743E").reasons[0]).toMatch(/centre is #ffffff/);
    expect(
      fillVerdict(await svg(`<rect width="${W}" height="${H}" fill="#b07a44"/>`), "#A9743E").ok,
    ).toBe(false);
    expect(
      fillVerdict(await svg(`<rect width="${W / 2}" height="${H}" fill="#a9743e"/>`), "#A9743E").ok,
    ).toBe(false);
  });

  it("rejects a transparent export", async () => {
    expect(
      fillVerdict(
        await pngOf(`<rect width="${W}" height="${H}" fill="#a9743e" fill-opacity="0"/>`),
        "#A9743E",
      ).ok,
    ).toBe(false);
  });
});

describe("tableVerdict", () => {
  const table = [
    ["Item", "Qty", "Price"],
    ["Pen", "4", "1.5"],
  ];

  it("accepts the same cells, numbers by value", () => {
    expect(
      tableVerdict(
        [
          ["Item", "Qty", "Price"],
          ["Pen", "4.0", "1.50"],
        ],
        table,
      ).ok,
    ).toBe(true);
  });

  it("rejects an empty sheet, a wrong cell and an extra cell", () => {
    expect(tableVerdict([], table).reasons).toHaveLength(6);
    expect(
      tableVerdict(
        [
          ["Item", "Qty", "Price"],
          ["Pen", "5", "1.5"],
        ],
        table,
      ).reasons,
    ).toEqual(['B2 is "5", expected "4"']);
    expect(
      tableVerdict(
        [
          ["Item", "Qty", "Price", "x"],
          ["Pen", "4", "1.5"],
        ],
        table,
      ).ok,
    ).toBe(false);
  });
});

describe("jsonVerdict", () => {
  const expected = { name: "Robin Hale", packingOrder: ["Cheese", "Apples"] };

  it("accepts the submitted answer", () => {
    expect(jsonVerdict(JSON.stringify({ ...expected, extra: 1 }), expected).ok).toBe(true);
  });

  it("rejects no submission, broken JSON and a wrong order", () => {
    expect(jsonVerdict(undefined, expected).ok).toBe(false);
    expect(jsonVerdict("{", expected).ok).toBe(false);
    expect(
      jsonVerdict(JSON.stringify({ ...expected, packingOrder: ["Apples", "Cheese"] }), expected).ok,
    ).toBe(false);
  });
});

describe("placementVerdict", () => {
  const expected = [
    { dir: "desk/archive", has: ["report.txt"], lacks: [] },
    { dir: "desk", has: ["archive"], lacks: ["report.txt"] },
  ];

  it("accepts the moved file", () => {
    expect(
      placementVerdict({ "desk/archive": ["report.txt"], desk: ["archive"] }, expected).ok,
    ).toBe(true);
  });

  it("rejects the untouched folders, a copy and a missing folder", () => {
    expect(
      placementVerdict({ "desk/archive": [], desk: ["archive", "report.txt"] }, expected).ok,
    ).toBe(false);
    expect(
      placementVerdict(
        { "desk/archive": ["report.txt"], desk: ["archive", "report.txt"] },
        expected,
      ).reasons,
    ).toEqual(["desk still has report.txt"]);
    expect(placementVerdict({ desk: ["archive"] }, expected).reasons).toContain(
      "desk/archive is missing",
    );
  });
});

describe("textVerdict", () => {
  it("accepts the exact text and rejects the seed or a missing file", () => {
    expect(textVerdict("a cat\n", "a cat\n").ok).toBe(true);
    expect(textVerdict("a fox\n", "a cat\n").ok).toBe(false);
    expect(textVerdict(undefined, "a cat\n").ok).toBe(false);
  });
});
