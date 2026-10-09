import { describe, expect, it } from "vitest";
import { centreRoom } from "./layout.ts";

describe("centreRoom", () => {
  it("leaves the island the bar's middle, between its right group and its mirror", () => {
    // 1440 wide: a 1024 bar beside the rail, Watch | Replay, Settings and Keys taking 208.
    expect(centreRoom({ content: 1024, right: 208, gap: 16 })).toBe(576);
    // 1100 wide: too narrow for a 490 island in control.
    expect(centreRoom({ content: 684, right: 208, gap: 16 })).toBeLessThan(490);
  });

  it("has nothing for a bar that is not shown", () => {
    expect(centreRoom({ content: 0, right: 0, gap: 0 })).toBe(0);
    expect(centreRoom({ content: 300, right: 208, gap: 16 })).toBe(0);
  });
});
