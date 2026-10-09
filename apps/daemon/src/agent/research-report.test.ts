import { describe, expect, it } from "vitest";
import { buildReport, citation, maskKeys, reportName } from "./research-report.ts";

const sources = [
  { n: 1, url: "https://one.example.org/a", title: "One", passages: [] },
  {
    n: 2,
    url: "https://www.two.example.org/b",
    title: "Two [draft]",
    passages: ["Heat pumps   reach a COP of 3.1 in winter."],
  },
  { n: 3, url: "https://three.example.org/c", title: "Three", passages: ["A", "B"] },
  { n: 4, url: "https://four.example.org/d", title: "Four", passages: [] },
];
const date = new Date("2026-10-09T12:00:00Z");

describe("citations", () => {
  it("reads as one bracket of sorted numbers, with runs of three or more as a range", () => {
    expect(citation([1])).toBe("[1]");
    expect(citation([3, 1, 3])).toBe("[1, 3]");
    expect(citation([2, 3, 4, 7])).toBe("[2–4, 7]");
    expect(citation([5, 6])).toBe("[5, 6]");
  });
  it("are renumbered in the order the report first cites them, summary first", () => {
    const built = buildReport({
      title: "Heat pumps",
      summary: "They work in cold climates [3].",
      body: "## Cost\nInstallation is costly [2, 3]. Running costs vary [2-4][9].",
      sources,
      date,
    });
    expect(built.cited).toEqual([3, 2, 4]);
    expect(built.unknown).toEqual([9]);
    expect(built.markdown).toContain("They work in cold climates [1].");
    expect(built.markdown).toContain("Installation is costly [1, 2].");
    expect(built.markdown).toContain("Running costs vary [1–3].");
    expect(built.markdown).not.toContain("[9]");
  });
  it("leave code, links and footnotes alone", () => {
    const built = buildReport({
      title: "T",
      summary: "S [4].",
      body: "Use `arr[2]` and [2](https://x.example.org) or [^2].\n```\nx = a[3]\n```\nThen [2].",
      sources,
      date,
    });
    expect(built.markdown).toContain("`arr[2]`");
    expect(built.markdown).toContain("[2](https://x.example.org)");
    expect(built.markdown).toContain("[^2]");
    expect(built.markdown).toContain("x = a[3]");
    expect(built.markdown).toContain("Then [2].");
    expect(built.cited).toEqual([4, 2]);
  });
});

describe("the report", () => {
  it("has the title, a dated line, the summary up top, the body and a numbered sources section", () => {
    const built = buildReport({
      title: "Heat pumps in cold climates",
      summary: "Yes, with caveats [2].",
      body: "# Heat pumps\n\n## Efficiency\nThe COP stays above 2 [2][3].\n\n## Sources\n1. made up",
      sources,
      date,
    });
    expect(built.markdown).toBe(`# Heat pumps in cold climates

*9 October 2026 · 2 sources cited*

## Summary

Yes, with caveats [1].

## Efficiency
The COP stays above 2 [1][2].

## Sources

1. [Two \\[draft\\]](<https://www.two.example.org/b>) · two.example.org

   > “Heat pumps reach a COP of 3.1 in winter.”

2. [Three](<https://three.example.org/c>) · three.example.org

   > “A”

   > “B”

## Also read

- [One](<https://one.example.org/a>) · one.example.org
- [Four](<https://four.example.org/d>) · four.example.org
`);
  });
  it("never carries a key, a token or a secret the task knows", () => {
    const key = `sk-proj-${"a".repeat(40)}`;
    const built = buildReport(
      {
        title: "Notes",
        summary: `The key ${key} was on the page [1].`,
        body: "The password hunter2secret was shown [1].",
        sources: [{ ...sources[0], passages: [`quote ${key}`] } as (typeof sources)[number]],
        date,
      },
      (text) => text.replaceAll("hunter2secret", "[redacted]"),
    );
    expect(built.markdown).not.toContain(key);
    expect(built.markdown).not.toContain("hunter2secret");
    expect(built.markdown).toContain("The key [redacted] was on the page [1].");
  });
  it("names its file in lowercase words, safe for the shell", () => {
    expect(reportName("Heat pumps: are they worth it in 2026?")).toBe(
      "heat-pumps-are-they-worth-it-in-2026",
    );
    expect(reportName("Café prices.md")).toBe("cafe-prices");
    expect(reportName("'; rm -rf ~ #")).toBe("rm-rf");
    expect(reportName("---")).toBe("research-report");
    expect(reportName("word ".repeat(40)).length).toBeLessThanOrEqual(60);
  });
  it("masks keys on long lines too", () => {
    const key = `gsk_${"b".repeat(40)}`;
    const long = `${"word ".repeat(2000)}${key} ${"tail ".repeat(10)}`;
    expect(maskKeys(long)).not.toContain(key);
    expect(maskKeys(`a\n${key}\nb`)).toBe("a\n[redacted]\nb");
  });
});
