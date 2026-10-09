import { emptyModel, type SessionModel } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import {
  dragEdge,
  edgeLimits,
  filmstrip,
  fitTrim,
  frameAt,
  MIN_TRIM_MS,
  moveEdge,
  nudgeEdge,
  parseTrimTime,
  shortcutOf,
  snapTo,
  stepEdges,
  stepSpans,
  tileCount,
  timeAtX,
  trimTimeLabel,
} from "./trim.ts";

const WHOLE = { fromMs: 0, toMs: 180_000 };

function withSteps(starts: number[], endMs = 180_000): SessionModel {
  const model = emptyModel();
  model.startT = 0;
  model.ended = { t: endMs, reason: "done" };
  model.steps = starts.map((startT, index) => ({
    id: `s${index}`,
    kind: "gui",
    startT,
    endT: starts[index + 1] ?? endMs,
    status: "ok",
  }));
  return model;
}

function withFrames(times: number[]): SessionModel {
  const model = emptyModel();
  model.startT = 0;
  model.observes = times.map((t, index) => ({ t, frameId: `f${index}` }));
  return model;
}

describe("trim handles", () => {
  it("move one end and keep the other, inside the recording", () => {
    const range = { fromMs: 10_000, toMs: 90_000 };
    expect(moveEdge(range, WHOLE, "from", 20_000.4)).toEqual({ fromMs: 20_000, toMs: 90_000 });
    expect(moveEdge(range, WHOLE, "to", 120_000)).toEqual({ fromMs: 10_000, toMs: 120_000 });
    expect(moveEdge(range, WHOLE, "from", -5_000)).toEqual({ fromMs: 0, toMs: 90_000 });
    expect(moveEdge(range, WHOLE, "to", 999_999)).toEqual({ fromMs: 10_000, toMs: 180_000 });
  });

  it("never cross or come nearer each other than the shortest trim", () => {
    const range = { fromMs: 10_000, toMs: 90_000 };
    expect(moveEdge(range, WHOLE, "from", 95_000)).toEqual({
      fromMs: 90_000 - MIN_TRIM_MS,
      toMs: 90_000,
    });
    expect(moveEdge(range, WHOLE, "to", 0)).toEqual({ fromMs: 10_000, toMs: 10_000 + MIN_TRIM_MS });
    expect(edgeLimits(range, WHOLE, "from")).toEqual({ min: 0, max: 89_500 });
    expect(edgeLimits(range, WHOLE, "to")).toEqual({ min: 10_500, max: 180_000 });
  });

  it("keep all of a recording shorter than the shortest trim", () => {
    const tiny = { fromMs: 1_000, toMs: 1_300 };
    expect(fitTrim({ fromMs: 1_100, toMs: 1_200 }, tiny)).toEqual(tiny);
    expect(moveEdge(tiny, tiny, "from", 1_250)).toEqual(tiny);
  });

  it("fit a step or marked stretch into the recording, at least the shortest trim long", () => {
    expect(fitTrim({ fromMs: -40, toMs: 200_000 }, WHOLE)).toEqual(WHOLE);
    expect(fitTrim({ fromMs: 15_000, toMs: 15_000 }, WHOLE)).toEqual({
      fromMs: 15_000,
      toMs: 15_000 + MIN_TRIM_MS,
    });
    expect(fitTrim({ fromMs: 179_900, toMs: 179_950 }, WHOLE)).toEqual({
      fromMs: 180_000 - MIN_TRIM_MS,
      toMs: 180_000,
    });
    expect(fitTrim({ fromMs: 15_000.6, toMs: 17_499.4 }, WHOLE)).toEqual({
      fromMs: 15_001,
      toMs: 17_499,
    });
  });
});

describe("dragging a handle", () => {
  const track = { left: 100, width: 600 };

  it("tracks the pointer across the strip, one pixel to its share of the recording", () => {
    expect(timeAtX(100, track, WHOLE)).toBe(0);
    expect(timeAtX(400, track, WHOLE)).toBe(90_000);
    expect(timeAtX(700, track, WHOLE)).toBe(180_000);
    expect(timeAtX(40, track, WHOLE)).toBe(0);
    expect(timeAtX(900, track, WHOLE)).toBe(180_000);
    expect(timeAtX(101, track, { fromMs: 30_000, toMs: 90_000 })).toBe(30_100);
  });

  it("moves in tenths of a second when nothing is near to snap to", () => {
    const range = { fromMs: 0, toMs: 180_000 };
    expect(dragEdge(range, WHOLE, "from", 12_345, null)).toEqual({
      range: { fromMs: 12_300, toMs: 180_000 },
      snapped: null,
    });
    expect(dragEdge(range, WHOLE, "to", 99_951, { edges: [50_000], reachMs: 2_400 })).toEqual({
      range: { fromMs: 0, toMs: 100_000 },
      snapped: null,
    });
  });

  it("stops on a step's edge within reach, and only while snapping is on", () => {
    const range = { fromMs: 0, toMs: 180_000 };
    const snap = { edges: [15_500, 23_004, 30_500], reachMs: 2_400 };
    expect(dragEdge(range, WHOLE, "from", 21_000, snap)).toEqual({
      range: { fromMs: 23_004, toMs: 180_000 },
      snapped: 23_004,
    });
    expect(dragEdge(range, WHOLE, "from", 21_000, null).range.fromMs).toBe(21_000);
    expect(dragEdge(range, WHOLE, "from", 19_000, snap).snapped).toBe(null);
  });

  it("says no snap when the edge it reached is past where the handle may go", () => {
    const range = { fromMs: 10_000, toMs: 23_200 };
    const result = dragEdge(range, WHOLE, "from", 23_000, { edges: [23_004], reachMs: 2_400 });
    expect(result.range.fromMs).toBe(23_200 - MIN_TRIM_MS);
    expect(result.snapped).toBe(null);
  });

  it("picks the nearest edge in reach", () => {
    expect(snapTo(20_000, [17_000, 21_000, 22_000], 2_500)).toBe(21_000);
    expect(snapTo(20_000, [17_000, 23_000], 2_500)).toBe(null);
    expect(snapTo(20_000, [], 2_500)).toBe(null);
  });

  it("finds each step's edges inside the recording once", () => {
    const model = withSteps([0, 15_500, 23_000, 30_500], 40_000);
    const whole = { fromMs: 0, toMs: 40_000 };
    expect(stepEdges(stepSpans(model, whole), whole)).toEqual([15_500, 23_000, 30_500]);
    const part = { fromMs: 16_000, toMs: 30_500 };
    expect(stepSpans(model, part)).toEqual([
      { fromMs: 16_000, toMs: 23_000 },
      { fromMs: 23_000, toMs: 30_500 },
    ]);
    expect(stepEdges(stepSpans(model, part), part)).toEqual([23_000]);
    model.steps[1] = { id: "s1", kind: "gui", startT: 15_500, endT: 17_000, status: "ok" };
    expect(stepEdges(stepSpans(model, whole), whole)).toEqual([15_500, 17_000, 23_000, 30_500]);
  });
});

describe("keyboard nudging", () => {
  const range = { fromMs: 10_000, toMs: 90_000 };
  const edges = [15_500, 23_000, 30_500];

  it("moves a tenth with the arrows, a second with Shift and ten with the page keys", () => {
    expect(nudgeEdge(range, WHOLE, "from", { key: "ArrowRight" }, edges)?.fromMs).toBe(10_100);
    expect(nudgeEdge(range, WHOLE, "from", { key: "ArrowLeft" }, edges)?.fromMs).toBe(9_900);
    expect(nudgeEdge(range, WHOLE, "to", { key: "ArrowUp", shiftKey: true }, edges)?.toMs).toBe(
      91_000,
    );
    expect(nudgeEdge(range, WHOLE, "to", { key: "PageDown" }, edges)?.toMs).toBe(80_000);
    expect(nudgeEdge(range, WHOLE, "from", { key: "PageUp" }, edges)?.fromMs).toBe(20_000);
  });

  it("jumps to the next or previous step edge with Option", () => {
    expect(nudgeEdge(range, WHOLE, "from", { key: "ArrowRight", altKey: true }, edges)).toEqual({
      fromMs: 15_500,
      toMs: 90_000,
    });
    const onEdge = { fromMs: 23_000, toMs: 90_000 };
    expect(
      nudgeEdge(onEdge, WHOLE, "from", { key: "ArrowLeft", altKey: true }, edges)?.fromMs,
    ).toBe(15_500);
    expect(nudgeEdge(range, WHOLE, "from", { key: "ArrowLeft", altKey: true }, edges)?.fromMs).toBe(
      0,
    );
    expect(nudgeEdge(range, WHOLE, "to", { key: "ArrowRight", altKey: true }, edges)?.toMs).toBe(
      180_000,
    );
  });

  it("goes as far as it may with Home and End, and ignores other keys", () => {
    expect(nudgeEdge(range, WHOLE, "from", { key: "End" }, edges)?.fromMs).toBe(89_500);
    expect(nudgeEdge(range, WHOLE, "to", { key: "Home" }, edges)?.toMs).toBe(10_500);
    expect(nudgeEdge(range, WHOLE, "from", { key: "a" }, edges)).toBe(null);
    expect(nudgeEdge(range, WHOLE, "from", { key: "ArrowLeft" }, edges)?.toMs).toBe(90_000);
  });
});

describe("typed times", () => {
  it.each([
    ["1:05", 65_000],
    ["1:05.3", 65_300],
    [" 0:07,25 ", 7_300],
    ["12.24", 12_200],
    ["65", 65_000],
    ["65.3 s", 65_300],
    ["1:02:03", 3_723_000],
    ["0:00", 0],
  ])("reads %j as %i ms, on the tenth of a second the handles show", (text, ms) => {
    expect(parseTrimTime(text)).toBe(ms);
  });

  it.each(["", "abc", "1:", "1:75", "1:61:00", "-3", "1.2.3"])("refuses %j", (text) => {
    expect(parseTrimTime(text)).toBe(null);
  });

  it("shows tenths of a second, as the handles move", () => {
    expect(trimTimeLabel(0)).toBe("0:00.0");
    expect(trimTimeLabel(65_300)).toBe("1:05.3");
    expect(trimTimeLabel(12_399)).toBe("0:12.3");
    expect(trimTimeLabel(3_723_000)).toBe("1:02:03.0");
    expect(parseTrimTime(trimTimeLabel(89_500))).toBe(89_500);
  });
});

describe("shortcuts and the filmstrip", () => {
  it("names the shortcut the handles hold", () => {
    const shortcuts = {
      whole: WHOLE,
      chapter: { fromMs: 15_000, toMs: 15_200 },
      selection: { fromMs: 5_000, toMs: 35_000 },
    };
    expect(shortcutOf(WHOLE, shortcuts, WHOLE)).toBe("whole");
    expect(shortcutOf({ fromMs: 15_000, toMs: 15_500 }, shortcuts, WHOLE)).toBe("chapter");
    expect(shortcutOf({ fromMs: 5_000, toMs: 35_000 }, shortcuts, WHOLE)).toBe("selection");
    expect(shortcutOf({ fromMs: 5_000, toMs: 35_100 }, shortcuts, WHOLE)).toBe(null);
    expect(
      shortcutOf({ fromMs: 5_000, toMs: 35_000 }, { ...shortcuts, selection: null }, WHOLE),
    ).toBe(null);
  });

  it("fills the strip with tiles of the picture's proportion", () => {
    expect(tileCount(552, 48)).toBe(8);
    expect(tileCount(310, 56)).toBe(4);
    expect(tileCount(0, 48)).toBe(0);
  });

  it("shows on each tile the key frame on the screen at its middle", () => {
    const model = withFrames([1_000, 40_000, 100_000, 170_000]);
    // Tiles' middles: 0:15, 0:45, 1:15, 1:45, 2:15 and 2:45.
    expect(filmstrip(model, WHOLE, "desktop", 6)).toEqual(["f0", "f1", "f1", "f2", "f2", "f2"]);
    // Before the first key frame, a tile shows the first one recorded.
    expect(filmstrip(model, { fromMs: 0, toMs: 1_500 }, "desktop", 3)).toEqual(["f0", "f0", "f0"]);
    expect(filmstrip(emptyModel(), WHOLE, "desktop", 2)).toEqual([null, null]);
    expect(filmstrip(model, WHOLE, "browser", 1)).toEqual([null]);
  });

  it("previews the picture at a handle, or the first one in the range", () => {
    const model = withFrames([1_000, 40_000, 100_000]);
    expect(frameAt(model, 45_000, { fromMs: 0, toMs: 90_000 }, "desktop")).toBe("f1");
    expect(frameAt(model, 120_000, { fromMs: 0, toMs: 90_000 }, "desktop")).toBe("f1");
    expect(frameAt(model, 0, { fromMs: 0, toMs: 90_000 }, "desktop")).toBe("f0");
  });
});
