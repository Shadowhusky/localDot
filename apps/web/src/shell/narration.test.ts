import { describe, expect, it } from "vitest";
import { lastSentence, narrationLine } from "./narration.ts";

const said = (text: string, open = false) => ({ from: "message" as const, text, open });

describe("the narrator's line", () => {
  it("speaks dot's own latest sentence while it works, and the caption when it has said nothing", () => {
    const words = said("I'll open the report first. Then I'll check February's net total.");
    expect(narrationLine("acting", "Select the Net total cell", words)).toBe(
      "Then I'll check February's net total.",
    );
    expect(narrationLine("thinking", "Thinking…", null)).toBe("Thinking…");
    expect(narrationLine("thinking", "Thinking…", said("Still going", true))).toBe("Thinking…");
  });

  it("keeps the caption where it is dot's question or turn, not its work", () => {
    const words = said("Checking the totals.");
    expect(narrationLine("question", "Which format should I use?", words)).toBe(
      "Which format should I use?",
    );
    expect(narrationLine("control", "Your turn.", words)).toBe("Your turn.");
  });

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

  it("cuts a long sentence at a word, with an ellipsis", () => {
    const line = lastSentence(
      "I'm going to compare every month's net figure against revenue minus returns, starting with February and working down the sheet.",
      true,
    );
    expect(line).toBe(
      "I'm going to compare every month's net figure against revenue minus returns…",
    );
    expect(line.length).toBeLessThanOrEqual(81);
  });
});
