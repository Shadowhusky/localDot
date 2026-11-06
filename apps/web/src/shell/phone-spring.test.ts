import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Spring, Velocity } from "./phone-spring.ts";

describe("Spring", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("settles on its target and says so", () => {
    const spring = new Spring(0);
    let done = false;
    spring.to(1, { response: 0.42, done: () => (done = true) });
    for (let frame = 0; frame < 240 && !done; frame++) spring.step(1 / 60);
    expect(spring.x).toBe(1);
    expect(done).toBe(true);
  });

  it("critically damped, never passes its target", () => {
    const spring = new Spring(0);
    spring.to(1, { response: 0.42, damping: 1 });
    let most = 0;
    for (let frame = 0; frame < 120; frame++) {
      spring.step(1 / 60);
      most = Math.max(most, spring.x);
    }
    expect(most).toBeLessThanOrEqual(1);
  });

  it("carries the finger's speed when it lets go", () => {
    const fast = new Spring(0.5);
    fast.to(0, { velocity: -3 });
    const slow = new Spring(0.5);
    slow.to(0, { velocity: 0 });
    fast.step(1 / 60);
    slow.step(1 / 60);
    expect(fast.x).toBeLessThan(slow.x);
  });
});

describe("Velocity", () => {
  it("reads nothing from a finger that stopped before lifting", () => {
    const velocity = new Velocity();
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(16);
    velocity.add(0);
    velocity.add(10);
    vi.spyOn(performance, "now").mockReturnValue(500);
    expect(velocity.get()).toBe(0);
    vi.restoreAllMocks();
  });
});
