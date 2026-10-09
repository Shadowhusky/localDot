import { describe, expect, it } from "vitest";
import { frameRateOf } from "./source-rate.ts";

// Runs of pictures `every` ms apart, with a still stretch of `still` ms between runs.
function bursts(every: number, runs: number, length: number, still: number, jitter = 0): number[] {
  const times: number[] = [];
  let t = 500;
  for (let run = 0; run < runs; run++) {
    for (let index = 0; index < length; index++) {
      times.push(t + jitter * Math.sin(index * 12.9898 + run * 78.233));
      t += every;
    }
    t += still;
  }
  return times;
}

describe("a recording's frame rate", () => {
  it("is the pace of its runs of change, not the average over its still stretches", () => {
    expect(frameRateOf(bursts(1000 / 60, 12, 24, 7000))).toBe(60);
    expect(frameRateOf(bursts(1000 / 60, 12, 24, 7000, 3))).toBe(60);
    expect(frameRateOf(bursts(1000 / 30, 12, 24, 4000))).toBe(30);
    expect(frameRateOf(bursts(1000 / 24, 4, 30, 2000))).toBe(24);
  });

  it("is unknown with too few pictures to tell", () => {
    expect(frameRateOf([])).toBeNull();
    expect(frameRateOf([0, 1000, 2000, 3000, 4000])).toBeNull();
    expect(frameRateOf(bursts(16, 1, 5, 0))).toBeNull();
  });
});
