import { describe, expect, it } from "vitest";
import { JUMP, SWAP, spinFrom, spinJump } from "./jump.ts";

describe("spinJump", () => {
  it("rests before it starts and after it has settled", () => {
    expect(spinJump(-0.1)).toEqual({ spin: 0, lift: 0, squash: 0, swapped: false });
    const after = spinJump(JUMP);
    expect(after.spin).toBeCloseTo(Math.PI * 2, 1);
    expect(after.lift).toBe(0);
    expect(Math.abs(after.squash)).toBeLessThan(0.01);
  });

  it("crouches, then leaves the ground", () => {
    expect(spinJump(0.05).squash).toBeGreaterThan(0.08);
    expect(spinJump(0.3).lift).toBeGreaterThan(0.3);
  });

  it("swaps outfit facing away, halfway round", () => {
    expect(spinJump(SWAP).spin).toBeCloseTo(Math.PI, 1);
    expect(spinJump(SWAP - 0.01).swapped).toBe(false);
    expect(spinJump(SWAP + 0.01).swapped).toBe(true);
  });

  it("carries past a full turn and springs back, then lands with a squash", () => {
    const most = Math.max(...Array.from({ length: 80 }, (_, i) => spinJump(i / 80).spin));
    expect(most).toBeGreaterThan(Math.PI * 2 + 0.1);
    expect(spinJump(0.53).squash).toBeGreaterThan(0.08);
  });
});

describe("spinFrom", () => {
  const TURN = Math.PI * 2;
  const front = (spin: number) => Math.min(spin % TURN, TURN - (spin % TURN));

  it("is a plain spin-jump from the front", () => {
    for (const turn of [0, 1, Math.PI, TURN]) expect(spinFrom(0, turn)).toBeCloseTo(turn, 9);
  });

  it("ends facing the front whatever turn the last jump was cut off at", () => {
    for (const from of [0.3, Math.PI * 0.9, Math.PI * 1.3, TURN - 0.1])
      expect(front(spinFrom(from, TURN))).toBeCloseTo(0, 9);
  });

  it("still turns at least half a turn, so the new outfit goes on facing away", () => {
    for (const from of [0.3, Math.PI * 1.3, TURN - 0.1])
      expect(spinFrom(from, TURN) - from).toBeGreaterThanOrEqual(Math.PI);
  });
});
