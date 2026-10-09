import { describe, expect, it } from "vitest";
import { qrModules } from "../../../packages/protocol/src/qr.ts";
import { terminalQr } from "./terminal-qr.ts";

// Reads the printed lines back into module rows: a half block's foreground is the upper row and
// its background the lower one.
function readBack(lines: readonly string[]): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of lines) {
    const upper: boolean[] = [];
    const lower: boolean[] = [];
    // Every run starts with an escape that sets both colours; the line ends with a reset.
    for (const run of line.split(String.fromCharCode(27)).slice(1)) {
      if (run === "[0m") continue;
      const [, fg, bg, blocks = ""] = /^\[38;5;(\d+);48;5;(\d+)m(.*)$/u.exec(run) ?? [];
      for (const char of blocks) {
        expect(char).toBe("▀");
        upper.push(fg === "16");
        lower.push(bg === "16");
      }
    }
    rows.push(upper, lower);
  }
  return rows;
}

describe("terminalQr", () => {
  it("prints every module with a four-module light margin", () => {
    const link = `https://box.example.ts.net:4750/#code=${"c".repeat(43)}`;
    const modules = qrModules(link) as boolean[][];
    const lines = terminalQr(link) as string[];
    const size = modules.length + 8;
    expect(lines).toHaveLength(Math.ceil(size / 2));
    const rows = readBack(lines);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) expect(rows[y]?.[x]).toBe(modules[y - 4]?.[x - 4] === true);
    expect(rows[size]?.every((dark) => !dark)).toBe(true);
    expect(lines.every((line) => line.endsWith("\x1b[0m"))).toBe(true);
  });

  it("returns null for text too long for a code", () => {
    expect(terminalQr("x".repeat(3000))).toBeNull();
  });
});
