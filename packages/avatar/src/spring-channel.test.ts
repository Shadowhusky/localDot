import { describe, expect, it } from "vitest";
import { SpringChannel } from "./spring-channel.ts";

const P = { dampingRatio: 1, response: 0.35 };

describe("SpringChannel", () => {
  it("holds its initial value until retargeted", () => {
    const c = new SpringChannel(0.5, P);
    expect(c.value(0)).toBe(0.5);
    expect(c.value(10_000)).toBe(0.5);
  });

  it("starts from the current value and settles on the target", () => {
    const c = new SpringChannel(0, P);
    c.retarget(1, 0);
    expect(c.value(0)).toBe(0);
    expect(Math.abs(c.value(3000) - 1)).toBeLessThan(1e-3);
  });

  it("keeps value and velocity continuous when retargeted mid-flight", () => {
    const c = new SpringChannel(0, P);
    c.retarget(1, 0);
    const before = c.value(100);
    const velocityBefore = c.velocity(100);
    c.retarget(-1, 100);
    expect(c.value(100)).toBeCloseTo(before, 12);
    expect(Math.abs(c.velocity(100) - velocityBefore)).toBeLessThan(Math.abs(velocityBefore) * 0.1);
  });

  it("ignores retargets to the same or a non-finite target", () => {
    const c = new SpringChannel(0, P);
    c.retarget(1, 0);
    const at200 = c.value(200);
    c.retarget(1, 150);
    c.retarget(Number.NaN, 150);
    expect(c.value(200)).toBe(at200);
    expect(c.target).toBe(1);
  });
});
