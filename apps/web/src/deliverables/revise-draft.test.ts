import { describe, expect, it, vi } from "vitest";
import { linkFor, onReviseRequest, prefill, requestRevise } from "./revise-draft.ts";

const link = { sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", name: "totals.csv", version: 1 };
describe("revise draft", () => {
  it("reaches the composer that is listening, and says when none is", () => {
    const draft = { link, label: 1, newest: true };
    expect(requestRevise(draft)).toBe(false);
    const heard = vi.fn();
    const stop = onReviseRequest(heard);
    expect(requestRevise(draft)).toBe(true);
    expect(heard).toHaveBeenCalledWith(draft);
    stop();
    expect(requestRevise(draft)).toBe(false);
  });
  it("prefills without losing what the user already typed", () => {
    expect(prefill("", "totals.csv")).toBe("Revise totals.csv: ");
    expect(prefill("make it bigger", "totals.csv")).toBe("Revise totals.csv: make it bigger");
    expect(prefill("Revise chart.png: brighter", "totals.csv")).toBe("Revise totals.csv: brighter");
    expect(prefill("Revise totals.csv: add a row", "totals.csv")).toBe(
      "Revise totals.csv: add a row",
    );
  });
  it("links the message only while it still names the file", () => {
    const draft = { link, label: 1, newest: true };
    expect(linkFor("Revise totals.csv: add a total row", draft)).toEqual(link);
    expect(linkFor("Something else entirely", draft)).toBeUndefined();
    expect(linkFor("Revise totals.csv: x", null)).toBeUndefined();
  });
});
