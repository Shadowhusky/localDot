import { describe, expect, it } from "vitest";
import { clipSnippet, ftsMatch, hasCjk, likeSnippet, searchTerms } from "./query.ts";

describe("search query building", () => {
  it("builds quoted prefix terms and drops operators and punctuation", () => {
    expect(searchTerms('car "insurance" NEAR(x) -quote: *')).toEqual([
      "car",
      "insurance",
      "near",
      "x",
      "quote",
    ]);
    expect(ftsMatch(["car", "insurance"])).toBe('"car"* "insurance"*');
    expect(searchTerms("!!! ...")).toEqual([]);
  });
  it("caps terms at eight of 64 characters", () => {
    expect(searchTerms(Array.from({ length: 12 }, (_, i) => `t${i}`).join(" "))).toHaveLength(8);
    expect(searchTerms("x".repeat(100))[0]).toHaveLength(64);
  });
  it("detects CJK and marks LIKE snippets", () => {
    expect(hasCjk("保险")).toBe(true);
    expect(hasCjk("insurance")).toBe(false);
    expect(likeSnippet("续保汽车保险的报价", ["保险"])).toBe("续保汽车保险的报价");
  });
  it("clips long snippets and keeps markers balanced", () => {
    const long = `${"a".repeat(390)}${"b".repeat(200)}`;
    const clipped = clipSnippet(long);
    expect(clipped.length).toBeLessThanOrEqual(400);
    expect(clipped.split("").length).toBe(clipped.split("").length);
    expect(clipSnippet("short")).toBe("short");
  });
});
