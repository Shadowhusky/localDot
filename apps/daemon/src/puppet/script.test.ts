import { describe, expect, it } from "vitest";
import { parsePuppetScript } from "./script.ts";

describe("parsePuppetScript", () => {
  it("accepts the demo shapes", () => {
    const s = parsePuppetScript({
      v: 1,
      title: "demo",
      steps: [
        { do: "launch", app: "calc", waitMs: 8000 },
        { do: "click", find: { name: "Name Box" }, label: "Click the Name Box" },
        { do: "type", text: "B2" },
        { do: "key", combo: ["Return"] },
        { do: "click", x: 155, y: 238, button: "right", count: 2, speed: "instant" },
        { do: "scroll", x: 640, y: 400, dx: 0, dy: 3 },
        { do: "wait", ms: 500 },
      ],
    });
    expect(s.steps).toHaveLength(7);
  });

  it("rejects model coordinates outside 1280x800, unknown verbs, and empty scripts", () => {
    expect(() =>
      parsePuppetScript({ v: 1, title: "t", steps: [{ do: "click", x: 1280, y: 0 }] }),
    ).toThrow();
    expect(() => parsePuppetScript({ v: 1, title: "t", steps: [{ do: "teleport" }] })).toThrow();
    expect(() => parsePuppetScript({ v: 1, title: "t", steps: [] })).toThrow();
    expect(() => parsePuppetScript({ v: 1, title: "t", steps: [{ do: "click" }] })).toThrow(
      /point or find/,
    );
  });
});
