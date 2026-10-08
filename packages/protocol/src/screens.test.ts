import { describe, expect, it } from "vitest";
import { ScreenGeometry, ScreenSwitchData, SwitchScreenInput } from "./screens.ts";

describe("signed-in browser screen contracts", () => {
  it("has exactly two named screens without implicit coercion or extra capabilities", () => {
    for (const screen of ["desktop", "browser"])
      expect(SwitchScreenInput.parse({ screen })).toEqual({ screen });
    for (const value of [
      { screen: "Browser" },
      { screen: "browser", eval: "cookies" },
      { screen: "host" },
      { screen: "../browser" },
      { screen: 1 },
      {},
    ])
      expect(SwitchScreenInput.safeParse(value).success).toBe(false);
  });

  it("bounds geometry before allocation and allows both supported scales", () => {
    for (const scale of [1, 2])
      expect(ScreenGeometry.parse({ w: 1920, h: 1200, scale })).toEqual({
        w: 1920,
        h: 1200,
        scale,
      });
    for (const changes of [{ w: 0 }, { w: 8193 }, { h: -1 }, { h: 1.2 }, { scale: 3 }])
      expect(ScreenGeometry.safeParse({ w: 1920, h: 1200, scale: 1, ...changes }).success).toBe(
        false,
      );
  });

  it("requires physical cell identity and an ordered screen revision", () => {
    const event = {
      screen: "browser",
      cellId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      geometry: { w: 1920, h: 1200, scale: 1 },
      by: "agent",
      revision: 1,
    };
    expect(ScreenSwitchData.parse(event)).toEqual(event);
    for (const changes of [{ cellId: "" }, { by: "page" }, { revision: 0 }, { url: "private" }])
      expect(ScreenSwitchData.safeParse({ ...event, ...changes }).success).toBe(false);
  });
});
