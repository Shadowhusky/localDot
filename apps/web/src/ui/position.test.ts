import { describe, expect, it } from "vitest";
import { place } from "./position.ts";

const viewport = { width: 1440, height: 900 };
const size = { width: 200, height: 160 };

describe("place", () => {
  it("opens below its anchor, lined up with its start, and grows from the anchor's middle", () => {
    const found = place({
      anchor: { top: 100, left: 300, width: 28, height: 28 },
      size,
      viewport,
      side: "bottom",
      align: "start",
    });
    expect(found).toMatchObject({ top: 136, left: 300, side: "bottom", originX: 14, originY: 0 });
    expect(found.maxHeight).toBe(900 - 128 - 8 - 8);
  });

  it("flips above when there is too little room below and more above", () => {
    const found = place({
      anchor: { top: 820, left: 300, width: 80, height: 32 },
      size,
      viewport,
      side: "bottom",
      align: "center",
    });
    expect(found.side).toBe("top");
    expect(found.top).toBe(820 - 8 - 160);
    expect(found.left).toBe(240);
    expect(found.originY).toBe(160);
  });

  it("stays on the asked side when the other has even less room, and scrolls inside", () => {
    const found = place({
      anchor: { top: 60, left: 300, width: 80, height: 32 },
      size: { width: 200, height: 900 },
      viewport,
      side: "bottom",
      align: "start",
    });
    expect(found.side).toBe("bottom");
    expect(found.maxHeight).toBe(900 - 92 - 16);
  });

  it("slides along its anchor to keep 8 px from the screen edge", () => {
    const end = place({
      anchor: { top: 100, left: 1420, width: 16, height: 16 },
      size,
      viewport,
      side: "bottom",
      align: "start",
    });
    expect(end.left).toBe(1440 - 8 - 200);
    expect(end.originX).toBe(1428 - end.left);
    const start = place({
      anchor: { top: 100, left: 2, width: 16, height: 16 },
      size,
      viewport,
      side: "bottom",
      align: "end",
    });
    expect(start.left).toBe(8);
  });

  it("opens beside its anchor on a horizontal side", () => {
    const found = place({
      anchor: { top: 400, left: 1300, width: 100, height: 40 },
      size,
      viewport,
      side: "right",
      align: "start",
    });
    expect(found).toMatchObject({ side: "left", left: 1300 - 8 - 200, top: 400, originX: 200 });
  });
});
