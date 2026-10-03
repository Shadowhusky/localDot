import { describe, expect, it } from "vitest";
import { redactor } from "./redact.ts";

describe("stream redaction", () => {
  it("retains ordinary stdout/stderr attribution while joining secret fragments safely", () => {
    const secret = "abcdefghijklmno";
    const r = redactor([secret]);
    const stream = r.stream?.();
    if (!stream) throw new Error("missing redaction stream");
    const out = [
      ...stream.push({ stream: "stdout", chunk: "before abcde" }),
      ...stream.push({ stream: "stderr", chunk: "fghijklmno after" }),
      ...stream.finish(),
    ];
    expect(out).toEqual([
      { stream: "stdout", chunk: "before [redacted]" },
      { stream: "stderr", chunk: " after" },
    ]);
  });
  it("handles overlapping secrets at the retained boundary without exposing either prefix", () => {
    const first = "abcdefghijkl",
      second = "ijklmnop";
    const r = redactor([first, second]);
    const stream = r.stream?.();
    if (!stream) throw new Error("missing redaction stream");
    const out = [
      ...stream.push({ stream: "stdout", chunk: `abcdefghijklmnop${"x".repeat(46)}` }),
      ...stream.finish(),
    ];
    expect(out.map((c) => c.chunk).join("")).toBe(`[redacted]${"x".repeat(46)}`);
  });
  it("defers incomplete prefixes and redacts unknown surrogate tokens", () => {
    const r = redactor([]),
      s = r.stream?.();
    if (!s) throw new Error("missing redaction stream");
    expect(s.push({ stream: "stdout", chunk: "ld_llm_0123456789abcdefghijkl_" })).toEqual([]);
    expect(
      [...s.push({ stream: "stdout", chunk: "abcdef" }), ...s.finish()]
        .map((c) => c.chunk)
        .join(""),
    ).toBe("[redacted]");
  });
});
