import { describe, expect, it } from "vitest";
import { InstallCodes } from "./install-codes.ts";

const TOKEN = "t".repeat(43),
  PORT = 4750;
function fixture() {
  let now = 1000;
  const codes = new InstallCodes(TOKEN, PORT, () => now);
  return {
    codes,
    setTime(value: number) {
      now = value;
    },
  };
}

describe("one-use install codes", () => {
  it("issues unpredictable URL-safe codes and consumes each once", () => {
    const { codes } = fixture();
    const first = codes.issue(),
      second = codes.issue();
    expect(first.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.code).not.toBe(second.code);
    expect(first.code).not.toBe(TOKEN);
    expect(first.expiresAt).toBe(61000);
    expect(codes.consume(first.code)).toBe(TOKEN);
    expect(codes.consume(first.code)).toBeUndefined();
    expect(codes.consume(second.code)).toBe(TOKEN);
    expect(JSON.stringify(codes)).not.toContain(TOKEN);
    expect(JSON.stringify(codes)).not.toContain(first.code);
  });
  it("refuses the TTL boundary and clears codes on restart", () => {
    const f = fixture(),
      first = f.codes.issue();
    f.setTime(60999);
    expect(f.codes.consume(first.code)).toBe(TOKEN);
    const next = f.codes.issue();
    f.setTime(next.expiresAt);
    expect(f.codes.consume(next.code)).toBeUndefined();
    const another = f.codes.issue();
    expect(new InstallCodes(TOKEN, PORT).consume(another.code)).toBeUndefined();
  });
  it("invalidates outstanding codes after a clock rollback", () => {
    const f = fixture(),
      first = f.codes.issue();
    f.setTime(999);
    expect(f.codes.consume(first.code)).toBeUndefined();
    f.setTime(1001);
    expect(f.codes.consume(first.code)).toBeUndefined();
  });
  it("preserves pending codes at capacity and retains used tombstones until expiry", () => {
    const f = fixture(),
      issued = Array.from({ length: 32 }, () => f.codes.issue());
    expect(() => f.codes.issue()).toThrow();
    for (const entry of issued) expect(f.codes.consume(entry.code)).toBe(TOKEN);
    expect(() => f.codes.issue()).toThrow();
    const first = issued[0];
    if (!first) throw new Error("expected an issued code");
    expect(f.codes.consume(first.code)).toBeUndefined();
    f.setTime(61000);
    expect(f.codes.issue().code).toHaveLength(43);
  });
  it.each(["", TOKEN, "short", "a".repeat(44), "a".repeat(42), "!".repeat(43)])(
    "refuses an unknown or malformed code without affecting a pending link %#",
    (code) => {
      const f = fixture(),
        issued = f.codes.issue();
      expect(f.codes.consume(code)).toBeUndefined();
      expect(f.codes.consume(issued.code)).toBe(TOKEN);
    },
  );
  it("binds its authority to one token and daemon port", () => {
    const { codes } = fixture();
    expect(codes.belongsTo(TOKEN, PORT)).toBe(true);
    expect(codes.belongsTo("x".repeat(43), PORT)).toBe(false);
    expect(codes.belongsTo(TOKEN, PORT + 1)).toBe(false);
  });
});
