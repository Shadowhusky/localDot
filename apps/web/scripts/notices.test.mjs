import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeNotices } from "./notices.mjs";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(webDir, "../..");
const temporary = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), "localdot-notices-"));
  temporary.push(path);
  return path;
};
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fakePackage(patch = {}, license = "test license\n") {
  const web = dir();
  writeFileSync(join(web, "package.json"), '{"name":"notice-test"}\n');
  const pkg = join(web, "node_modules/mediabunny");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "dist/main.cjs"), "module.exports = {};\n");
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "mediabunny",
      version: "1.61.0",
      license: "MPL-2.0",
      exports: { ".": "./dist/main.cjs" },
      ...patch,
    }),
  );
  if (license !== null) writeFileSync(join(pkg, "LICENSE"), license);
  return web;
}

describe("build license notices", () => {
  it("writes the actual license text, exact version and source locations", () => {
    const outDir = dir();
    const receipt = writeNotices({ webDir, outDir });
    expect(receipt.files).toEqual(["licenses/mediabunny-1.61.0.txt"]);
    const text = readFileSync(join(outDir, receipt.files[0]), "utf8");
    expect(text).toContain("Mozilla Public License Version 2.0");
    expect(text).toContain("mediabunny 1.61.0");
    expect(text).toContain("https://github.com/Vanilagy/mediabunny");
    expect(text).toContain("https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz");
    const entry = createRequire(join(webDir, "package.json")).resolve("mediabunny");
    let pkg = dirname(entry);
    while (!readable(join(pkg, "LICENSE"))) pkg = dirname(pkg);
    expect(text.endsWith(readFileSync(join(pkg, "LICENSE"), "utf8"))).toBe(true);
  });

  it("preserves license bytes and produces reproducible notices without timestamps", () => {
    const web = fakePackage({}, "License bytes\r\n  Preserve spaces.\n");
    const first = dir();
    const second = dir();
    writeNotices({ webDir: web, outDir: first });
    writeNotices({ webDir: web, outDir: second });
    const a = readFileSync(join(first, "licenses/mediabunny-1.61.0.txt"));
    const b = readFileSync(join(second, "licenses/mediabunny-1.61.0.txt"));
    expect(a.equals(b)).toBe(true);
    expect(a.subarray(-35).toString()).toContain("Preserve spaces.\n");
    expect(a.toString().endsWith("License bytes\r\n  Preserve spaces.\n")).toBe(true);
  });

  it.each([{ license: "MIT" }, { version: "1.62.0" }])(
    "refuses incompatible package metadata %j before writing a notice",
    (patch) => {
      const outDir = dir();
      expect(() => writeNotices({ webDir: fakePackage(patch), outDir })).toThrow();
      expect(readable(join(outDir, "licenses/mediabunny-1.61.0.txt"))).toBe(false);
    },
  );

  it("refuses a missing license instead of shipping a header alone", () => {
    expect(() => writeNotices({ webDir: fakePackage({}, null), outDir: dir() })).toThrow();
  });

  it("pins both uses exactly and has no mediabunny patch or second locked version", () => {
    for (const path of [join(webDir, "package.json"), join(root, "apps/daemon/package.json")]) {
      expect(JSON.parse(readFileSync(path, "utf8")).dependencies.mediabunny).toBe("1.61.0");
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(
      Object.keys(pkg.pnpm?.patchedDependencies ?? {}).some((x) => x.includes("mediabunny")),
    ).toBe(false);
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toMatch(/mediabunny/);
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const versions = [...lock.matchAll(/^ {2}mediabunny@([^:]+):/gm)].map((x) => x[1]);
    expect([...new Set(versions)]).toEqual(["1.61.0"]);
  });
});

function readable(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
