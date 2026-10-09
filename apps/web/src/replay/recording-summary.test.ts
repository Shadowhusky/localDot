import { describe, expect, it } from "vitest";
import type { ThreadItem } from "../agent/thread.ts";
import { plainLine, summarise } from "./recording-summary.ts";

const said = (text: string, role: "user" | "assistant" = "assistant"): ThreadItem => ({
  kind: "message",
  key: text,
  speaker: role === "user" ? "user" : "dot",
  message: { id: text, role, text, final: true },
});

describe("a recording's summary", () => {
  it("reads dot's Markdown as one plain line", () => {
    expect(plainLine("## Monthly totals: checked\n\nAll **12** months match.")).toBe(
      "Monthly totals: checked",
    );
    expect(plainLine("Done. The *totals* check out, see [the sheet](https://x.test).")).toBe(
      "Done. The totals check out, see the sheet.",
    );
    expect(plainLine("```\ncode\n```\n\nThen `sum` it.")).toBe("Then sum it.");
    expect(plainLine("word ".repeat(60)).length).toBeLessThanOrEqual(140);
  });

  it("takes dot's last words, every file it made once and what the task cost", () => {
    const items: ThreadItem[] = [
      said("Check the totals", "user"),
      said("Opening the sheet."),
      {
        kind: "result",
        key: "r1",
        speaker: "dot",
        result: {
          id: "r1",
          summary: "Checked",
          files: [{ name: "summary.md", path: "/home/summary.md", bytes: 2048 }],
        },
      },
      {
        kind: "work",
        key: "w1",
        speaker: "dot",
        turn: "t1",
        steps: [],
        startMs: 0,
        spend: { usd: 0.21, estimated: false },
      },
      said("Done. The totals check out."),
      {
        kind: "result",
        key: "r2",
        speaker: "dot",
        result: {
          id: "r2",
          summary: "Checked again",
          files: [{ name: "summary.md", path: "/home/summary.md", bytes: 2100 }],
        },
      },
    ];
    expect(summarise(items)).toEqual({
      line: "Done. The totals check out.",
      files: [{ name: "summary.md", path: "/home/summary.md", bytes: 2100 }],
      spend: "$0.21",
    });
    expect(summarise([items[0] as ThreadItem]).spend).toBeNull();
  });
});
