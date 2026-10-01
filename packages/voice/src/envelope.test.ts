import { describe, expect, it } from "vitest";
import { EnvelopeMeter, envelopeVisemes } from "./envelope.ts";

describe("EnvelopeMeter", () => {
  it("measures 10 ms hops across chunk boundaries, full scale at 0.2 RMS", () => {
    const meter = new EnvelopeMeter(24_000);
    expect(meter.push(new Float32Array(200).fill(0.1))).toEqual([]);
    const levels = meter.push(new Float32Array(280).fill(0.1));
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeCloseTo(0.5, 6);
    expect(meter.push(new Float32Array(240).fill(0.4))).toEqual([1]);
  });
});

describe("envelopeVisemes", () => {
  it("opens on loud audio, closes on quiet, and ignores small dips", () => {
    const levels = [0, 0, 0.5, 0.5, 0.08, 0.5, 0.02, 0.02];
    expect(envelopeVisemes(levels)).toEqual([
      { t: 20, shape: "A" },
      { t: 60, shape: "rest" },
    ]);
  });
});
