// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { placeElement, registerPlace } from "./places.ts";

describe("dot's places", () => {
  it("gives a place back to the box under it when the box over it goes", () => {
    const watch = document.createElement("span");
    const replay = document.createElement("span");
    const leaveWatch = registerPlace("dock", watch);
    const leaveReplay = registerPlace("dock", replay);
    expect(placeElement("dock")).toBe(replay);
    leaveReplay();
    expect(placeElement("dock")).toBe(watch);
    leaveWatch();
    expect(placeElement("dock")).toBeNull();
  });

  it("keeps the newer box when an older one leaves first", () => {
    const first = document.createElement("span");
    const second = document.createElement("span");
    const leaveFirst = registerPlace("stage", first);
    const leaveSecond = registerPlace("stage", second);
    leaveFirst();
    expect(placeElement("stage")).toBe(second);
    leaveSecond();
    expect(placeElement("stage")).toBeNull();
  });
});
