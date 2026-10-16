import { describe, expect, it } from "vitest";
import {
  claudePlanToken,
  KEY_SCAN_CHARS,
  KEY_SCAN_MATCHES,
  keyLikeMatches,
  keyLikePresent,
  scanKeyLike,
} from "./key-like.ts";

// Synthetic shapes only; no existing environment, credential file or account is read.
const shapes = [
  [`sk-ant-api03-${"a".repeat(95)}`, "Anthropic"],
  [`sk-ant-admin01-${"b".repeat(95)}`, "Anthropic"],
  [`sk-ant-oat01-${"l".repeat(95)}`, "Claude plan token"],
  [`sk-ant-ort01-${"m".repeat(95)}`, "Claude plan token"],
  [`sk-ant-sid01-${"n".repeat(95)}`, "Claude plan token"],
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
// Service tokens a user's files or command output can hold, as synthetic as the shapes above.
const tokens = [
  [`ghp_${"a".repeat(36)}`, "GitHub"],
  [`gho_${"b".repeat(36)}`, "GitHub"],
  [`github_pat_${"C".repeat(22)}_${"d".repeat(59)}`, "GitHub"],
  [`glpat-${"e".repeat(20)}`, "GitLab"],
  [`AKIA${"F".repeat(16)}`, "AWS"],
  [`xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"g".repeat(24)}`, "Slack"],
  [`sk_live_${"h".repeat(24)}`, "Stripe"],
  [`rk_live_${"i".repeat(99)}`, "Stripe"],
] as const;
describe("service token recognition", () => {
  it.each(tokens.map(([key, hint]) => ({ key, hint })))(
    "finds a synthetic $hint token by its prefix and shape",
    ({ key, hint }) => {
      const text = `前面 token: "${key}".`;
      expect(scanKeyLike(text)).toEqual({
        overflow: false,
        matches: [{ start: text.indexOf(key), end: text.indexOf(key) + key.length, hint }],
      });
    },
  );
  it("permits ordinary words that only share a token's prefix", () => {
    for (const text of [
      "ghp_ and github_pat_ are GitHub prefixes",
      `ghp_${"a".repeat(35)}`,
      `my_ghp_${"a".repeat(36)}`,
      `AKIA${"F".repeat(15)}`,
      `AKIA${"f".repeat(16)}`,
      "xoxo-hugs",
      ["xoxp", "and-some-long-hyphenated-words"].join("-"),
      `sk_test_${"h".repeat(24)}`,
      "glpat-short",
    ])
      expect(keyLikePresent(text), text).toBe(false);
  });
  it("finds every key in text of any length, for masking", () => {
    const [key] = tokens[0];
    const text = `${"word ".repeat(KEY_SCAN_CHARS)}${Array(KEY_SCAN_MATCHES + 4)
      .fill(key)
      .join(" ")}`;
    const matches = [...keyLikeMatches(text)];
    expect(matches).toHaveLength(KEY_SCAN_MATCHES + 4);
    for (const match of matches) expect(text.slice(match.start, match.end)).toBe(key);
  });
});
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
  it("names a Claude plan token with no provider to store it under, and keeps API keys Anthropic's", () => {
    const [plan, api, admin] = [
      `sk-ant-oat01-${"a".repeat(95)}`,
      `sk-ant-api03-${"a".repeat(95)}`,
      `sk-ant-admin01-${"a".repeat(95)}`,
    ].map((key) => scanKeyLike(key).matches);
    expect(plan).toEqual([{ start: 0, end: 108, hint: "Claude plan token" }]);
    expect(api).toEqual([{ start: 0, end: 108, hint: "Anthropic", provider: "anthropic" }]);
    expect(admin).toEqual([{ start: 0, end: 110, hint: "Anthropic", provider: "anthropic" }]);
    expect(keyLikePresent(`claude setup-token gave me sk-ant-oat01-${"Z9_-".repeat(20)}`)).toBe(
      true,
    );
    expect(keyLikePresent(["sk", "ant", "oat01", "short"].join("-"))).toBe(false);
  });
  it("finds a Claude plan, refresh or session token wherever it sits", () => {
    const token = `sk-ant-oat01-${"a".repeat(95)}`;
    for (const value of [
      token,
      `export CLAUDE_CODE_OAUTH_TOKEN=${token}`,
      `"${token}"`,
      `Bearer ${token}`,
      `abc${token}`,
      `sk-ant-ort01-${"b".repeat(95)}`,
      `sk-ant-sid01-${"c".repeat(95)}`,
    ]) {
      expect(claudePlanToken(value), value).toBe(true);
      expect(scanKeyLike(value).matches.map((m) => m.hint)).toEqual(["Claude plan token"]);
    }
    for (const value of [
      `sk-ant-api03-${"a".repeat(95)}`,
      `sk-ant-admin01-${"a".repeat(95)}`,
      "sk-ant-oat",
      "",
    ])
      expect(claudePlanToken(value), value).toBe(false);
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
