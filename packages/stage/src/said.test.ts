import { describe, expect, it } from "vitest";
import { lastSentence, plainText } from "./said.ts";

describe("dot's last sentence", () => {
  it("waits for a streaming sentence to reach its stop, but takes the last one once the words end", () => {
    expect(lastSentence("Opening the sheet. Now checking the", false)).toBe("Opening the sheet.");
    expect(lastSentence("Now checking the", false)).toBe("");
    expect(lastSentence("Now checking the totals", true)).toBe("Now checking the totals");
    expect(lastSentence("A list:\n- Open the report\n", false)).toBe("Open the report");
    expect(lastSentence("Read the totals.Checking F3 next.", false)).toBe("Checking F3 next.");
    expect(lastSentence("Saved report.ods to Node.JS docs.", true)).toBe(
      "Saved report.ods to Node.JS docs.",
    );
  });

  it("reads Markdown as plain words on one line, leaving code and tables out", () => {
    expect(
      lastSentence(
        "## Plan\n\nI'll read **row 15** in [the sheet](https://x.test).\n\n```sh\nls -la\n```\n| a | b |",
        true,
      ),
    ).toBe("I'll read row 15 in the sheet.");
    expect(lastSentence("Checking `F3`\nagainst the _total_.", true)).toBe("against the total.");
  });

  it("keeps a long sentence whole, for the band to fit to the width it has", () => {
    const sentence =
      "I'm going to compare every month's net figure against revenue minus returns, starting with February and working down the sheet.";
    expect(lastSentence(sentence, true)).toBe(sentence);
  });

  it("cuts only a runaway sentence, at a word, with an ellipsis", () => {
    const line = lastSentence(
      `I'm going to compare every month's net figure against revenue minus returns, ${"then the next month, ".repeat(12)}and so on down the sheet.`,
      true,
    );
    expect(line).toMatch(/^I'm going to compare every month's net figure .* then the next…$/);
    expect(line.length).toBeLessThanOrEqual(241);
  });
});

describe("a line dot gave", () => {
  it("reads as plain words on one line", () => {
    expect(plainText("Saving **report.ods** to `~/Documents`\nnow")).toBe(
      "Saving report.ods to ~/Documents now",
    );
  });
});
