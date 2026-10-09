import type { FileVersion } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { comparePair, findVersion, opensAtFirst } from "./versions.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const OTHER = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M";
const v = (label: number, over: Partial<FileVersion> = {}): FileVersion => ({
  sessionId: ID,
  version: label,
  label,
  bytes: 10,
  resultId: ID,
  tMs: 0,
  available: true,
  ...over,
});

describe("file versions on a card", () => {
  it("finds the version a card shows by its task and number", () => {
    const versions = [v(1, { sessionId: OTHER }), v(2)];
    expect(findVersion(versions, { sessionId: OTHER, version: 1 })?.label).toBe(1);
    expect(findVersion(versions, { sessionId: ID, version: 1 })).toBeUndefined();
  });
  it("compares the shown text version with the readable one before it", () => {
    const versions = [v(1), v(2, { available: false }), v(3)];
    expect(comparePair("totals.csv", versions, versions[2])?.map((x) => x.label)).toEqual([1, 3]);
    expect(comparePair("totals.csv", versions, versions[0])).toBeNull();
  });
  it("never compares pictures, documents or versions saved before numbering", () => {
    const versions = [v(1), v(2)];
    expect(comparePair("chart.png", versions, versions[1])).toBeNull();
    expect(comparePair("report.ods", versions, versions[1])).toBeNull();
    const legacy = [v(1, { version: null }), v(2)];
    expect(comparePair("a.txt", legacy, legacy[1])).toBeNull();
  });
  it("opens every preview of a short result and only the first previewable one of a long one", () => {
    expect([0, 1].map((i) => opensAtFirst(["a.png", "b.svg"], i))).toEqual([true, true]);
    const many = ["diagram.svg", "chart.png", "totals.csv", "notes.md", "page.html"];
    expect(many.map((_, i) => opensAtFirst(many, i))).toEqual([false, true, false, false, false]);
    const code = ["archive.zip", "clean.py", "chart.png", "notes.md"];
    expect(code.map((_, i) => opensAtFirst(code, i))).toEqual([false, true, false, false]);
  });
});
