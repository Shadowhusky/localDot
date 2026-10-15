import { describe, expect, it } from "vitest";
import { LINEUP_SCRIPT, SCRIPT } from "./script.ts";

describe("the film's scripts", () => {
  it("come in time order, as the stage plays them", () => {
    for (const script of [SCRIPT, LINEUP_SCRIPT]) {
      const times = script.map(([at]) => at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });
});
