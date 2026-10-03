import { describe, expect, it } from "vitest";
import { KEY_SCAN_CHARS, KEY_SCAN_MATCHES, keyLikePresent, scanKeyLike } from "./key-like.ts";

// Synthetic shapes only; no existing environment, credential file or account is read.
const shapes = [
  [`sk-ant-api03-${"a".repeat(95)}`, "Anthropic"],
  [`sk-ant-admin01-${"b".repeat(95)}`, "Anthropic"],
  [`sk-proj-${"c".repeat(156)}`, "OpenAI"],
  [`sk-svcacct-${"d".repeat(156)}`, "OpenAI"],
  [`sk-admin-${"e".repeat(156)}`, "OpenAI"],
  [`AIza${"f".repeat(35)}`, "Google"],
  [`AQ.${"g".repeat(128)}`, "Google"],
  [`gsk_${"h".repeat(52)}`, "Groq"],
  [`sk-or-v1-${"i".repeat(64)}`, "OpenRouter"],
  [`xai-${"j".repeat(64)}`, "xAI"],
  [`pplx-${"k".repeat(48)}`, "Perplexity"],
  [`sk-${"a".repeat(32)}`, "API key"],
] as const;
describe("bounded key-shaped text recognition", () => {
  it.each(shapes.map(([key, hint], index) => ({ key, hint, index })))(
    "finds synthetic $hint candidate $index inside multilingual prose without returning credential text",
    ({ key, hint }) => {
      const text = `前面\nuse '${key}' please.\n后面`;
      const scan = scanKeyLike(text);
      expect(scan).toMatchObject({
        overflow: false,
        matches: [{ start: text.indexOf(key), end: text.indexOf(key) + key.length, hint }],
      });
      expect(JSON.stringify(scan)).not.toContain(key);
      expect(keyLikePresent(text)).toBe(true);
      expect(scanKeyLike(text)).toEqual(scan); // No global cursor leaks between calls.
    },
  );
  it("recognises keys next to punctuation while preserving exact provider spans", () => {
    for (const [key] of shapes.filter(([key]) => !key.startsWith("AQ."))) {
      const text = `(${key}.example),后面`;
      const scan = scanKeyLike(text);
      expect(scan.matches).toHaveLength(1);
      expect(text.slice(scan.matches[0]?.start, scan.matches[0]?.end)).toBe(key);
    }
    expect(keyLikePresent(`note.AQ.${"a".repeat(128)}`)).toBe(true);
  });
  it("keeps independent spans for multiple candidates and exact generic-provider ambiguity", () => {
    const text = shapes.map(([key]) => key).join("\n");
    const scan = scanKeyLike(text);
    expect(scan.matches).toHaveLength(shapes.length);
    expect(scan.matches.at(-1)?.provider).toBeUndefined();
    for (const [index, match] of scan.matches.entries())
      expect(text.slice(match.start, match.end)).toBe(shapes[index]?.[0]);
  });
  it("permits ordinary identifiers, hashes, UUIDs, short examples and near-prefix strings", () => {
    for (const text of [
      "a".repeat(64),
      "deadbeef".repeat(8),
      "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      "550e8400-e29b-41d4-a716-446655440000",
      "sk-proj-EXAMPLE",
      ["sk", "ant", "api03", "placeholder"].join("-"),
      `use_sk-${"a".repeat(48)}`,
      `aiza${"b".repeat(35)}`,
      `gsk_${"h".repeat(31)}`,
      "AQ.short",
      "please calculate 12,480",
    ])
      expect(keyLikePresent(text), text).toBe(false);
  });
  it("has finite input and result limits, with overflow refusing instead of falsely permitting", () => {
    expect(scanKeyLike("-".repeat(KEY_SCAN_CHARS))).toEqual({ matches: [], overflow: false });
    expect(scanKeyLike("x".repeat(KEY_SCAN_CHARS + 1))).toEqual({ matches: [], overflow: true });
    const scan = scanKeyLike(
      Array(KEY_SCAN_MATCHES + 1)
        .fill(shapes[5]?.[0])
        .join(" "),
    );
    expect(scan.matches).toHaveLength(KEY_SCAN_MATCHES);
    expect(scan.overflow).toBe(true);
    expect(keyLikePresent("x".repeat(KEY_SCAN_CHARS + 1))).toBe(true);
  });
});
