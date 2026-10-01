import { describe, expect, it } from "vitest";
import { parsePort } from "./port.ts";

describe("parsePort", () => {
  it("defaults to 4750 when unset", () => {
    expect(parsePort(undefined)).toBe(4750);
  });

  it.each([
    ["1", 1],
    ["4751", 4751],
    ["65535", 65535],
  ])("accepts %s", (value, port) => {
    expect(parsePort(value)).toBe(port);
  });

  it.each(["", "0", "65536", "-1", "4750.5", "1e3", " 4750", "4750abc", "0x12a6", "abc"])(
    "refuses %j",
    (value) => {
      expect(() => parsePort(value)).toThrow("expected an integer from 1 to 65535");
    },
  );
});
