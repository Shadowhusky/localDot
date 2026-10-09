import { describe, expect, it } from "vitest";
import { INDEX_REDACTED, redactForIndex } from "./redact-index.ts";

const key = () => `sk-ant-api03-${"a".repeat(95)}`;
describe("index redaction", () => {
  it("replaces key-shaped tokens and keeps the prose", () => {
    expect(redactForIndex(`use ${key()} for the quote`)).toBe(
      `use ${INDEX_REDACTED} for the quote`,
    );
  });
  it("finds keys on both sides of an 8000-character chunk boundary", () => {
    const text = `${"word ".repeat(1599)}${key()} ${"more ".repeat(10)}${key()}`;
    expect(redactForIndex(text)).not.toContain("sk-ant");
  });
  it("redacts a whole chunk that holds more than sixteen keys", () => {
    const text = Array.from({ length: 17 }, key).join(" ");
    expect(redactForIndex(text)).toBe(INDEX_REDACTED);
  });
  it("replaces tokens of 256 or more key characters and strips match markers", () => {
    expect(redactForIndex(`${"b".repeat(300)} ok x`)).toBe(`${INDEX_REDACTED} ok  x `);
  });
});
