import { BALANCED_AUTONOMY, CAREFUL_AUTONOMY } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { autonomyValue, countValue, SPY_LINE, sectionInView, spendingValue } from "./sections.ts";

describe("settings sections", () => {
  const tops = [
    { id: "models" as const, top: 0 },
    { id: "autonomy" as const, top: 600 },
    { id: "keys" as const, top: 1400 },
  ];
  const scroll = (top: number) => ({ top, height: 700, content: 1900 });

  it("lights the last section whose top has reached the reading line", () => {
    expect(sectionInView(tops, scroll(0))).toBe("models");
    expect(sectionInView(tops, scroll(600 - SPY_LINE - 1))).toBe("models");
    expect(sectionInView(tops, scroll(600 - SPY_LINE))).toBe("autonomy");
    expect(sectionInView(tops, scroll(900))).toBe("autonomy");
  });

  it("lights the last section once the scroll can go no further, though its top never got there", () => {
    expect(sectionInView(tops, scroll(1200))).toBe("keys");
    expect(sectionInView(tops, { top: 0, height: 700, content: 700 })).toBe("models");
    expect(sectionInView([], scroll(0))).toBeUndefined();
  });

  it("says what each section holds in the phone's list", () => {
    expect(autonomyValue(BALANCED_AUTONOMY)).toBe("Balanced");
    expect(autonomyValue(CAREFUL_AUTONOMY)).toBe("Careful");
    expect(autonomyValue({ ...BALANCED_AUTONOMY, purchase: "handoff" })).toBe("Your own mix");
    expect(spendingValue({ on: false, task: "5", day: "" }, false)).toBe("No limit");
    expect(spendingValue({ on: true, task: "5", day: "20.5" }, false)).toBe(
      "$5 a task · $20.50 a day",
    );
    expect(spendingValue({ on: true, task: "", day: "" }, false)).toBe("No limit");
    expect(spendingValue({ on: true, task: "5", day: "" }, true)).toBe("Your plan");
    expect(countValue(0)).toBe("");
    expect(countValue(3)).toBe("3");
  });
});
