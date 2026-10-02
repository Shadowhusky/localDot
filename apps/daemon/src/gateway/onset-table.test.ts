import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ONSET_TABLE, loadOnsetTable, onsetKind, onsetMs } from "./onset-table.ts";

describe("onset table", () => {
  it("defaults to the development Mac's first numbers when no calibration exists", () => {
    const table = loadOnsetTable(mkdtempSync(join(tmpdir(), "local dot's onset-")));
    expect(table.source).toBe("defaults");
    expect(onsetMs(table, "xtest", "click", 1)).toBe(19.6);
    expect(onsetMs(table, "xtest", "click", 2)).toBe(23.1);
    expect(onsetMs(table, "xtest", "key", 1)).toBe(19.1);
    expect(onsetMs(table, "xtest", "key", 2)).toBe(29.3);
    expect(onsetMs(table, "driver", "click", 2)).toBe(26.4);
    expect(onsetMs(table, "driver", "key", 2)).toBe(26.4);
    expect(DEFAULT_ONSET_TABLE.onsetMs.driver).toEqual({ click: { "1": 18.4, "2": 26.4 } });
  });

  it("loads a calibration file, keeping defaults for groups it lacks", () => {
    const home = mkdtempSync(join(tmpdir(), "local dot's onset-"));
    writeFileSync(
      join(home, "calibration.json"),
      JSON.stringify({
        v: 1,
        measuredAt: "2026-10-02T10:00:00.000Z",
        machine: "M3 Ultra",
        onsetMs: { xtest: { click: { "2": 24.4 } } },
      }),
    );
    const table = loadOnsetTable(home);
    expect(table.source).toBe("calibration");
    expect(onsetMs(table, "xtest", "click", 2)).toBe(24.4);
    expect(onsetMs(table, "xtest", "click", 1)).toBe(19.6);
  });

  it("ignores an unreadable calibration file", () => {
    const home = mkdtempSync(join(tmpdir(), "local dot's onset-"));
    writeFileSync(join(home, "calibration.json"), "{nope");
    expect(loadOnsetTable(home).source).toBe("defaults");
  });

  it("classifies inputs: keys and typing are keys, everything else a click", () => {
    expect(onsetKind({ kind: "type", chars: 3, masked: false })).toBe("key");
    expect(onsetKind({ kind: "key", combo: ["a"] })).toBe("key");
    expect(onsetKind({ kind: "click", button: "left", count: 1, at: { x: 0, y: 0 } })).toBe(
      "click",
    );
    expect(onsetKind({ kind: "scroll", at: { x: 0, y: 0 }, dx: 0, dy: 1 })).toBe("click");
  });
});
