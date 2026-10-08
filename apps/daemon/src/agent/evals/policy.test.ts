import { describe, expect, it } from "vitest";
import type { OracleView } from "./oracle.ts";
import { click, colourExtent, ellipse, findBlock, scripted, stroke } from "./policy.ts";
import { capabilityLanded, noopPolicy, TASKS } from "./tasks.ts";

const view = (over: Partial<OracleView> = {}): OracleView => ({
  turn: 0,
  frame: undefined,
  results: [],
  windows: [],
  handoffs: 0,
  ...over,
});
const ok = { name: "computer", ok: true, text: "" };
const failed = { name: "computer", ok: false, text: "Failed: the target changed" };

describe("scripted", () => {
  it("acts each step once, then finishes", async () => {
    const policy = scripted(
      [
        { name: "a", act: () => [click(1, 1)] },
        { name: "b", act: () => [click(2, 2)] },
      ],
      "all done",
    );
    expect(await policy(view())).toEqual([click(1, 1)]);
    expect(await policy(view({ results: [ok] }))).toEqual([click(2, 2)]);
    expect(await policy(view({ results: [ok] }))).toEqual([["done", { summary: "all done" }]]);
  });

  it("waits until a step is ready", async () => {
    let ready = false;
    const policy = scripted([{ name: "a", ready: () => ready, act: () => [click(1, 1)] }], "x");
    expect(await policy(view())).toEqual([["computer", { action: "wait", duration: 1 }]]);
    ready = true;
    expect(await policy(view())).toEqual([click(1, 1)]);
  });

  it("repeats a failed step, then gives up after three tries", async () => {
    const policy = scripted([{ name: "press", act: () => [click(1, 1)] }], "x");
    expect(await policy(view())).toEqual([click(1, 1)]);
    expect(await policy(view({ results: [failed] }))).toEqual([click(1, 1)]);
    expect(await policy(view({ results: [failed] }))).toEqual([click(1, 1)]);
    expect(await policy(view({ results: [failed] }))).toEqual([
      ["done", { summary: "Stopped: press did not work." }],
    ]);
  });

  it("counts a failed input the user completed on hand-off as done", async () => {
    const policy = scripted(
      [
        { name: "type", act: () => [click(1, 1)] },
        { name: "next", act: () => [click(2, 2)] },
      ],
      "x",
    );
    await policy(view());
    expect(await policy(view({ results: [failed], handoffs: 1 }))).toEqual([click(2, 2)]);
  });

  it("looks again before acting again when a check does not hold yet", async () => {
    let done = false;
    const policy = scripted([{ name: "a", act: () => [click(1, 1)], done: () => done }], "x");
    await policy(view());
    const look = [["computer", { action: "wait", duration: 1 }]];
    expect(await policy(view({ results: [ok] }))).toEqual(look);
    expect(await policy(view({ results: [ok] }))).toEqual(look);
    expect(await policy(view({ results: [ok] }))).toEqual(look);
    expect(await policy(view({ results: [ok] }))).toEqual([click(1, 1)]);
    done = true;
    expect(await policy(view({ results: [ok] }))).toEqual([["done", { summary: "x" }]]);
  });

  it("reads a handed-over step's check from a fresh screenshot", async () => {
    let saved = false;
    const policy = scripted([{ name: "save", act: () => [click(1, 1)], done: () => saved }], "x");
    await policy(view());
    expect(await policy(view({ results: [failed], handoffs: 1 }))).toEqual([
      ["computer", { action: "wait", duration: 1 }],
    ]);
    saved = true;
    expect(await policy(view({ results: [ok], handoffs: 1 }))).toEqual([
      ["done", { summary: "x" }],
    ]);
  });
});

describe("frame helpers", () => {
  const frame = (() => {
    const width = 40;
    const height = 30;
    const data = new Uint8Array(width * height * 4).fill(255);
    for (let y = 10; y < 20; y++)
      for (let x = 5; x < 25; x++) data.set([0, 0, 0, 255], (y * width + x) * 4);
    return { width, height, data };
  })();

  it("finds a block of colour and its extent", () => {
    expect(findBlock(frame, [0, 0, 0], { x: 0, y: 0, w: 40, h: 30 }, 4)).toEqual({ x: 5, y: 10 });
    expect(colourExtent(frame, { x: 8, y: 12 }, [0, 0, 0])).toEqual({ x: 5, y: 10, w: 20, h: 10 });
    expect(findBlock(frame, [255, 0, 0], { x: 0, y: 0, w: 40, h: 30 }, 4)).toBeUndefined();
  });

  it("draws a closed stroke: press, every point, release", () => {
    const points = ellipse({ x: 100, y: 100 }, 50, 20, 8);
    expect(points[0]).toEqual(points.at(-1));
    const calls = stroke(points);
    expect(calls.map(([, input]) => input.action)).toEqual([
      "mouse_move",
      "left_mouse_down",
      ...Array(8).fill("mouse_move"),
      "left_mouse_up",
    ]);
  });
});

describe("tasks", () => {
  it("runs the drag and modifier-click tasks as expected failures until the brain accepts them", () => {
    expect(capabilityLanded("drag")).toBe(false);
    expect(capabilityLanded("modifier_click")).toBe(false);
    expect(TASKS.filter((t) => t.requires.length).map((t) => t.id)).toEqual([
      "gimp-draw-shape",
      "files-drag-drop",
      "files-multi-select",
    ]);
  });

  it("has a no-op policy that only finishes", async () => {
    expect(await noopPolicy(view())).toEqual([["done", { summary: "Nothing to do." }]]);
  });
});
