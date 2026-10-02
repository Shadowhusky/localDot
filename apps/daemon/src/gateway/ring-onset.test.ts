import { describe, expect, it } from "vitest";
import { DEFAULT_ONSET_TABLE } from "./onset-table.ts";
import { keepPolicy, policyFromEnv, strictPolicy } from "./ring-onset.ts";

describe("ring onset policies", () => {
  it("keep: press plus the injector's per-scale p99", async () => {
    const keep = keepPolicy(DEFAULT_ONSET_TABLE);
    expect(keep.name).toBe("keep");
    expect(
      await keep.onset({ pressT: 1_000_000, injector: "xtest", kind: "click", scale: 2 }),
    ).toBe(1_023_100);
    expect(await keep.onset({ pressT: 1_000_000, injector: "xtest", kind: "key", scale: 1 })).toBe(
      1_019_100,
    );
  });

  it("strict: the first change at the point, capped by the p99 and never before the press", async () => {
    const strict = strictPolicy(DEFAULT_ONSET_TABLE);
    expect(
      await strict.onset({ pressT: 1_000_000, injector: "xtest", kind: "click", scale: 2 }),
    ).toBe(1_023_100);
    expect(
      await strict.onset({
        pressT: 1_000_000,
        injector: "xtest",
        kind: "click",
        scale: 2,
        changeAt: async () => 1_009_000,
      }),
    ).toBe(1_009_000);
    expect(
      await strict.onset({
        pressT: 1_000_000,
        injector: "xtest",
        kind: "click",
        scale: 2,
        changeAt: async () => 1_050_000,
      }),
    ).toBe(1_023_100);
    expect(
      await strict.onset({
        pressT: 1_000_000,
        injector: "xtest",
        kind: "click",
        scale: 2,
        changeAt: async () => 999_000,
      }),
    ).toBe(1_000_000);
  });

  it("is chosen by LOCALDOT_RING_ONSET, keep by default", () => {
    expect(policyFromEnv(DEFAULT_ONSET_TABLE, {}).name).toBe("keep");
    expect(policyFromEnv(DEFAULT_ONSET_TABLE, { LOCALDOT_RING_ONSET: "strict" }).name).toBe(
      "strict",
    );
    expect(() => policyFromEnv(DEFAULT_ONSET_TABLE, { LOCALDOT_RING_ONSET: "soon" })).toThrow(
      /LOCALDOT_RING_ONSET/,
    );
  });
});
