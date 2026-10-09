import { describe, expect, it } from "vitest";
import { family, highlight, type Span } from "./highlight.ts";

const tones = (spans: Span[]) => spans.filter((s) => s.tone).map((s) => `${s.tone}:${s.text}`);

describe("code colouring", () => {
  it("picks a family by extension", () => {
    expect(["a.ts", "a.py", "a.sh", "a.sql", "a.html", "a.json", "a.txt"].map(family)).toEqual([
      "c",
      "python",
      "hash",
      "sql",
      "markup",
      "json",
      "plain",
    ]);
  });

  it("marks keywords, strings, numbers and comments, keeping every character", () => {
    const line = 'const total = sum("a // b", 42); // done';
    const [spans = []] = highlight([line], "c");
    expect(spans.map((s) => s.text).join("")).toBe(line);
    expect(tones(spans)).toEqual([
      "keyword:const",
      'string:"a // b"',
      "number:42",
      "comment:// done",
    ]);
  });

  it("carries a block comment and a Python docstring across lines", () => {
    expect(highlight(["a /* one", "two */ b"], "c").map(tones)).toEqual([
      ["comment:/* one"],
      ["comment:two */"],
    ]);
    expect(
      highlight(["def f():", '    """Doc', '    more"""', "    return 1"], "python").map(tones),
    ).toEqual([
      ["keyword:def"],
      ['string:"""Doc'],
      ['string:    more"""'],
      ["keyword:return", "number:1"],
    ]);
  });

  it("colours markup tags, attributes and values, and a JSON key apart from its value", () => {
    const [markup = []] = highlight(['<img src="a.png" alt=x>'], "markup");
    expect(tones(markup)).toEqual([
      "tag:<img",
      "attribute:src",
      'string:"a.png"',
      "attribute:alt",
      "attribute:x",
      "tag:>",
    ]);
    const [json = []] = highlight(['{"n": 1, "s": "v", "b": true}'], "json");
    expect(tones(json)).toEqual([
      'attribute:"n"',
      "number:1",
      'attribute:"s"',
      'string:"v"',
      'attribute:"b"',
      "keyword:true",
    ]);
  });

  it("keeps plain text whole", () => {
    expect(highlight(["2026-10-09 INFO copied", ""], "plain")).toEqual([
      [{ text: "2026-10-09 INFO copied" }],
      [],
    ]);
  });

  it("leaves a word inside another word alone", () => {
    expect(tones(highlight(["constant1 x2"], "c")[0] ?? [])).toEqual([]);
  });
});
