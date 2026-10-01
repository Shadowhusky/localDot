import { describe, expect, it } from "vitest";
import { SHEET_POSES } from "./sheet-poses.ts";

describe("SHEET_POSES", () => {
  it("covers every head corner, eye state, mouth shape and expression", () => {
    const labels = SHEET_POSES.map((p) => p.label);
    for (const x of [-1, 0, 1])
      for (const y of [-1, 0, 1]) expect(labels).toContain(`head ${x},${y}`);
    for (const eye of ["eyes open", "eyes half", "eyes closed", "eyes smile", "wink"])
      expect(labels).toContain(eye);
    for (const m of ["A", "I", "U", "E", "O", "N", "smile", "rest"])
      expect(labels).toContain(`mouth ${m}`);
    for (const e of [
      "smug",
      "annoyed",
      "blush",
      "surprised",
      "worried",
      "lean left",
      "lean right",
      "breath in",
    ])
      expect(labels).toContain(e);
  });

  it("has unique labels", () => {
    const labels = SHEET_POSES.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
