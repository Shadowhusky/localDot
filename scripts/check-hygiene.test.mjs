import { describe, expect, it } from "vitest";
import { findViolations } from "./check-hygiene.mjs";

const repo = (map) => ({ list: Object.keys(map), read: (file) => map[file] ?? null });

describe("findViolations", () => {
  it("passes clean files", () => {
    const r = repo({ "src/a.ts": "export const a = 1;" });
    expect(findViolations(r.list, r.read)).toEqual([]);
  });

  it("flags private theme names in content and in paths", () => {
    const name = ["Ku", "risu"].join("");
    const r = repo({
      "src/a.ts": `const who = "${name}";`,
      [`themes/${name.toLowerCase()}/theme.json`]: "{}",
    });
    const hits = findViolations(r.list, r.read).map((v) => `${v.file}:${v.where}`);
    expect(hits).toContain("src/a.ts:content");
    expect(hits).toContain(`themes/${name.toLowerCase()}/theme.json:path`);
  });

  it("flags key-shaped secrets", () => {
    const key = ["sk", "proj", "x".repeat(40)].join("-");
    const r = repo({ "config.json": `{"key":"${key}"}` });
    expect(findViolations(r.list, r.read)[0]?.rule).toBe("OpenAI-style key");
  });

  it("skips binary files", () => {
    expect(findViolations(["img.png"], () => null)).toEqual([]);
  });
});
