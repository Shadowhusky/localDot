import { describe, expect, it } from "vitest";
import { allocateKeydPort, KEYD_PORT_RANGE, parsePortRange } from "./ports.ts";

describe("allocateKeydPort", () => {
  it("hands out the lowest free listener port in 4760-4789", () => {
    expect(allocateKeydPort([])).toBe(4760);
    expect(allocateKeydPort([4760, 4761])).toBe(4762);
    expect(allocateKeydPort([4760, 4762])).toBe(4761);
  });

  it("serves keyd on 4760-4789 and hands out 4789 once it is the only free port", () => {
    expect(KEYD_PORT_RANGE).toEqual({ from: 4760, to: 4789 });
    const taken = Array.from({ length: 29 }, (_, i) => 4760 + i);
    expect(allocateKeydPort(taken)).toBe(4789);
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

describe("keyd port ranges other than keyd's own", () => {
  it("allocates inside another range, such as a test keyd's", () => {
    expect(allocateKeydPort([4791], { from: 4791, to: 4797 })).toBe(4792);
    expect(() => allocateKeydPort([4791], { from: 4791, to: 4791 })).toThrow("4791-4791");
  });

  it("reads LOCALDOT_KEYD_PORTS and defaults to keyd's own range", () => {
    expect(parsePortRange(undefined)).toEqual(KEYD_PORT_RANGE);
    expect(parsePortRange("")).toEqual(KEYD_PORT_RANGE);
    expect(parsePortRange("4791-4797")).toEqual({ from: 4791, to: 4797 });
    for (const bad of ["4797-4791", "80-90", "4760", "4760-70000", " 4760-4789"]) {
      expect(() => parsePortRange(bad), bad).toThrow(RangeError);
    }
  });
});
