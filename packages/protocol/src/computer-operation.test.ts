import { describe, expect, it } from "vitest";
import { ComputerOperation } from "./computer-operation.ts";

const operation = {
  kind: "start",
  step: "desktop",
  startedAt: 1_780_000_000_000,
  elapsedMs: 4_250,
  expectedMs: 20_000,
};

describe("ComputerOperation", () => {
  it("reads the operation a computer summary carries", () => {
    expect(ComputerOperation.parse(operation)).toEqual(operation);
  });

  it("refuses anything but whole, known values", () => {
    for (const bad of [
      { ...operation, step: "booting" },
      { ...operation, kind: "wake" },
      { ...operation, elapsedMs: -1 },
      { ...operation, elapsedMs: 1.5 },
      { ...operation, expectedMs: 0 },
      { ...operation, note: "extra" },
    ])
      expect(ComputerOperation.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
