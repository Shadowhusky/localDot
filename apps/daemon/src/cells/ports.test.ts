import { describe, expect, it } from "vitest";
import { allocateKeydPort, KEYD_PORT_RANGE } from "./ports.ts";

describe("allocateKeydPort", () => {
  it("hands out the lowest free listener port in 4760-4789", () => {
    expect(allocateKeydPort([])).toBe(4760);
    expect(allocateKeydPort([4760, 4761])).toBe(4762);
    expect(allocateKeydPort([4760, 4762])).toBe(4761);
  });

  it("fails when the range is exhausted", () => {
    const all: number[] = [];
    for (let p = KEYD_PORT_RANGE.from; p <= KEYD_PORT_RANGE.to; p++) all.push(p);
    expect(() => allocateKeydPort(all)).toThrow("no free keyd listener port");
  });

  it("gives concurrent creates different ports when each reserves its port before awaiting", async () => {
    const saved = [4760];
    const reserved = new Set<number>();
    const create = async () => {
      const port = allocateKeydPort([...saved, ...reserved]);
      reserved.add(port);
      await Promise.resolve();
      return port;
    };
    expect(await Promise.all([create(), create()])).toEqual([4761, 4762]);
  });
});
