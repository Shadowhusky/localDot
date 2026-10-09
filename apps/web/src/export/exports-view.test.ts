import { describe, expect, it } from "vitest";
import { hostExport } from "../testing/host-export.ts";
import { exportGlyph, exportMeta, exportPercent } from "./exports-view.ts";

const NOW = new Date(2026, 9, 9, 18, 0);

describe("an exported video's row", () => {
  it("counts a video being made up to its frames, never past them", () => {
    expect(exportPercent({ done: 0, total: 0 })).toBe(0);
    expect(exportPercent({ done: 757, total: 1800 })).toBe(42);
    expect(exportPercent({ done: 1900, total: 1800 })).toBe(100);
  });

  it("says where each video is in plain words", () => {
    expect(exportMeta(hostExport({ phase: "queued" }), NOW)).toBe("Waiting to start");
    expect(exportMeta(hostExport({ total: 0 }), NOW)).toBe("Getting the recording ready");
    expect(exportMeta(hostExport({ done: 757, total: 1800, leftMs: null }), NOW)).toBe(
      "42% · working out the time left",
    );
    expect(exportMeta(hostExport({ done: 757, total: 1800, leftMs: 4200 }), NOW)).toBe(
      "42% · about 0:04 left",
    );
    const made = new Date(2026, 9, 9, 15, 4).getTime();
    expect(
      exportMeta(
        hostExport({ phase: "done", bytes: 13_996_125, durationS: 120, createdAt: made }),
        NOW,
      ),
    ).toBe("13 MB · 2:00 · Today 15:04");
    expect(exportMeta(hostExport({ phase: "failed", error: "It broke." }), NOW)).toBe("It broke.");
  });

  it("marks each phase with its glyph", () => {
    expect(exportGlyph({ phase: "making" })).toEqual({ state: "doing", label: "Making" });
    expect(exportGlyph({ phase: "done" })).toEqual({ state: "done", label: "Ready" });
  });
});
