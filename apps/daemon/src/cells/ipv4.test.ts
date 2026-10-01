import { describe, expect, it } from "vitest";
import { hostAddress } from "./ipv4.ts";

describe("hostAddress", () => {
  it("adds an offset to the network address", () => {
    expect(hostAddress("172.24.0.0/16", 10)).toBe("172.24.0.10");
    expect(hostAddress("10.1.2.0/24", 11)).toBe("10.1.2.11");
    expect(hostAddress("172.24.0.0/16", 300)).toBe("172.24.1.44");
  });

  it("rejects offsets outside the host range and malformed inputs", () => {
    expect(() => hostAddress("10.1.2.0/24", 255)).toThrow(RangeError);
    expect(() => hostAddress("10.1.2.0/24", 0)).toThrow(RangeError);
    expect(() => hostAddress("10.1.2.0", 1)).toThrow(RangeError);
    expect(() => hostAddress("10.1.2.300/24", 1)).toThrow(RangeError);
    expect(() => hostAddress("fd00::/64", 1)).toThrow(RangeError);
  });
});
