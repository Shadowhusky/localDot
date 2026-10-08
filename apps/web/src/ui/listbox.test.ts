import { describe, expect, it } from "vitest";
import {
  buildSections,
  flatten,
  highlight,
  matches,
  openingIndex,
  searchTerms,
  typeahead,
} from "./listbox.ts";

const GROUPS = [
  {
    label: "Hosted",
    items: [
      { value: "anthropic", label: "Anthropic" },
      { value: "azure", label: "Azure OpenAI", disabledReason: "Needs a deployment" },
      { value: "deepseek", label: "DeepSeek" },
    ],
  },
  {
    label: "On this Mac",
    items: [
      { value: "lmstudio", label: "LM Studio" },
      { value: "ollama", label: "Ollama", keywords: "llama local" },
    ],
  },
];

describe("buildSections", () => {
  it("numbers the rows across groups and drops a group with nothing left", () => {
    const sections = buildSections(undefined, GROUPS, (item) => item.value !== "lmstudio");
    expect(sections.map((section) => section.label)).toEqual(["Hosted", "On this Mac"]);
    expect(flatten(sections).map((option) => option.index)).toEqual([0, 1, 2, 3]);
    expect(buildSections(undefined, GROUPS, (item) => item.label.startsWith("A"))).toHaveLength(1);
  });
});

describe("searching", () => {
  it("matches every word against the label, the keywords and the value", () => {
    const ollama = { value: "ollama", label: "Ollama", keywords: "llama local" };
    expect(matches(ollama, searchTerms("  LOCAL  olla "))).toBe(true);
    expect(matches(ollama, searchTerms("local studio"))).toBe(false);
    expect(matches({ value: "claude-sonnet-4-5", label: "Sonnet 4.5" }, ["claude"])).toBe(true);
  });

  it("marks each matched run in the label", () => {
    expect(highlight("Claude Sonnet 4.5", ["son", "4"])).toEqual([
      { start: 0, text: "Claude ", match: false },
      { start: 7, text: "Son", match: true },
      { start: 10, text: "net ", match: false },
      { start: 14, text: "4", match: true },
      { start: 15, text: ".5", match: false },
    ]);
  });
});

describe("opening and typing", () => {
  const options = flatten(buildSections(undefined, GROUPS));

  it("opens on the chosen row, else on the first that can be chosen", () => {
    expect(openingIndex(options, "deepseek")).toBe(2);
    expect(openingIndex(options, "")).toBe(0);
    const first = [
      { value: "azure", label: "Azure OpenAI", disabledReason: "Needs a deployment" },
      { value: "deepseek", label: "DeepSeek" },
    ];
    expect(openingIndex(flatten(buildSections(first, undefined)), "")).toBe(1);
  });

  it("jumps to the next label that starts with what was typed", () => {
    expect(typeahead(options, "o", 0)).toBe(4);
    expect(typeahead(options, "de", 0)).toBe(2);
    expect(typeahead(options, "x", 0)).toBeUndefined();
  });

  it("cycles through labels that share a letter when the letter repeats", () => {
    expect(typeahead(options, "a", 0)).toBe(1);
    expect(typeahead(options, "aa", 1)).toBe(0);
  });
});
