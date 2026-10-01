import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findViolations, readTextFile } from "./check-hygiene.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tempDir = () => mkdtempSync(join(tmpdir(), "local dot's hygiene-"));
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

describe("readTextFile", () => {
  it("returns null for a file that no longer exists", () => {
    const missing = join(here, "missing.txt");
    expect(readTextFile(missing)).toBeNull();
  });

  it("returns null for a path that is a directory", () => {
    expect(readTextFile(tempDir())).toBeNull();
  });

  it("returns null for a path beneath a file", () => {
    const file = join(tempDir(), "file.txt");
    writeFileSync(file, "text");
    expect(readTextFile(join(file, "child"))).toBeNull();
  });

  it("rethrows any other read error", () => {
    expect(() => readTextFile(join(tempDir(), "x".repeat(300)))).toThrow("ENAMETOOLONG");
  });
});

describe("running the script", () => {
  it.each(["directly", "through a symlink"])("scans the repository when run %s", (how) => {
    const root = tempDir();
    const script = join(root, "repo", "scripts", "check-hygiene.mjs");
    mkdirSync(dirname(script), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: join(root, "repo") });
    copyFileSync(join(here, "check-hygiene.mjs"), script);
    writeFileSync(join(root, "repo", "leak.txt"), ["sk", "proj", "x".repeat(40)].join("-"));
    const entry = how === "directly" ? script : join(root, "check.mjs");
    if (entry !== script) symlinkSync(script, entry);
    const run = spawnSync(process.execPath, [entry], { encoding: "utf8" });
    expect(run.stderr).toContain("hygiene: OpenAI-style key in content of leak.txt");
    expect(run.status).toBe(1);
  });
});
