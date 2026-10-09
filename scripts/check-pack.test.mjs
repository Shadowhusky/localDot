import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPack, MAX_FILE_BYTES } from "./check-pack.mjs";

const BASE = {
  "package.json": JSON.stringify({ name: "localdot", version: "1.0.0" }),
  "README.md": "# localDot\n",
  LICENSE: "MIT\n",
  "THIRD-PARTY.md": "# Third party\n",
  "release.json": "{}\n",
  "npm-shrinkwrap.json": "{}\n",
  "bin/localdot.mjs": "#!/usr/bin/env node\n",
  "dist/cli.mjs": "export {};\n",
  "dist/daemon.mjs": "export {};\n",
  "dist/release-verification-worker.mjs": "export {};\n",
  "dist/browser-seccomp.json": "{}\n",
  "dist/canary-scan.py": "# scanner fixture\n",
  "dist/canary-worker.py": "# exercise fixture\n",
  "dist/sandbox-runtime/package.json": "{}\n",
  "dist/sandbox-runtime/LICENSE": "Apache-2.0\n",
  "dist/sandbox-runtime/NOTICE.md": "# Modified sandbox\n",
  "dist/sandbox-runtime/PATCH.txt": "fixture patch\n",
  "dist/sandbox-runtime/dist/cli.mjs": "export {};\n",
  "dist/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar": "fixture jar\n",
  "skills/office-files/SKILL.md": "# Office files\n",
  "web/dist/index.html": "<!doctype html>\n",
  "web/dist/assets/index-Ab12.js": "export {};\n",
  "web/dist/assets/licenses/mediabunny-1.61.0.txt": "Mozilla Public License Version 2.0\n",
  "web/vendor/selkies/LICENSE": "Mozilla Public License Version 2.0\n",
  "web/vendor/selkies/NOTICE.md": "# Selkies\n",
  "web/vendor/selkies/manifest.json": "{}\n",
};
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function pkg(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "localdot-package-audit-"));
  roots.push(dir);
  const files = [];
  for (const [path, content] of Object.entries({ ...BASE, ...extra })) {
    if (content === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    files.push({ path, size: Buffer.byteLength(content) });
  }
  return { dir, files, check: (options) => checkPack(dir, { files, ...options }) };
}

describe("shipping package inventory audit (without running npm)", () => {
  it.each([
    "dist/browser-seccomp.json",
    "dist/canary-scan.py",
    "dist/canary-worker.py",
    "skills/office-files/SKILL.md",
    "dist/sandbox-runtime/dist/cli.mjs",
    "dist/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar",
  ])("requires the installed runtime asset %s", (path) => {
    expect(pkg({ [path]: null }).check()).toContain(`${path}: missing`);
  });
  it("allows macOS system canonicalization but still rejects user homes and mounted checkout paths", () => {
    expect(pkg({ "dist/daemon.mjs": 'const path = "/System/Volumes/Data";' }).check()).toEqual([]);
    for (const path of [
      "/Volumes/external/project",
      "/Users/fixture/private",
      "/System/Volumes/Data/Users/fixture/private",
      "/System/Volumes/Data/Volumes/external/project",
    ]) {
      const problems = pkg({ "dist/daemon.mjs": JSON.stringify(path) }).check();
      expect(problems).toContain("dist/daemon.mjs: developer path");
      expect(problems.join("\n")).not.toContain(path);
    }
  });
  it("accepts a clean complete inventory with current build license and viewer manifest paths", () => {
    expect(pkg().check()).toEqual([]);
  });
  it("accepts the Home Screen app files at the web root and nothing else beside them", () => {
    expect(
      pkg({
        "web/dist/sw.js": "self.addEventListener('push', () => {});\n",
        "web/dist/manifest.webmanifest": '{"name":"localDot"}\n',
        "web/dist/icons/icon-192.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }).check(),
    ).toEqual([]);
    for (const path of [
      "web/dist/icons/notes.txt",
      "web/dist/icons/other.png",
      "web/dist/other.js",
    ])
      expect(
        pkg({ [path]: "x" })
          .check()
          .some((p) => p.includes("not in the allowlist")),
      ).toBe(true);
  });

  it("refuses a linked package root and a directory pretending to be a file", () => {
    const f = pkg(),
      alias = join(f.dir, "alias");
    symlinkSync(f.dir, alias);
    expect(checkPack(alias, { files: f.files })).toEqual(["package root is not a directory"]);
    const file = join(f.dir, "dist/cli.mjs");
    rmSync(file);
    mkdirSync(file);
    expect(f.check()).toContain("dist/cli.mjs: not a bounded regular file");
  });
  it.each([
    "dist/main.ts",
    "dist/cli.mjs.map",
    "dist/cli.test.mjs",
    "dist/.env",
    "web/src/App.tsx",
    "web/node_modules/x/index.js",
  ])("refuses a packed %s", (path) => {
    const f = pkg({ [path]: "private source" });
    expect(
      f
        .check()
        .some((p) => p.includes("not in the allowlist") || p.includes("invalid package inventory")),
    ).toBe(true);
  });
  it("finds private names in binary asset content and paths", () => {
    const f = pkg({
      "web/dist/assets/private-fixture.png": Buffer.from([0, 1, 2]),
      "web/dist/assets/a.png": Buffer.from("\0PRIVATE-FIXTURE"),
    });
    const problems = f.check({
      rules: [{ name: "private theme name", pattern: /private-fixture/gi }],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "[redacted package path]: private theme name",
        "web/dist/assets/a.png: private theme name",
      ]),
    );
    expect(problems.join("\n")).not.toContain("PRIVATE-FIXTURE");
  });
  it("finds key-shaped metadata after a binary NUL instead of skipping the file", () => {
    const secret = ["sk", "proj", "x".repeat(40)].join("-");
    const f = pkg({ "web/dist/assets/a.png": Buffer.from(`\0${secret}`) });
    const problems = f.check();
    expect(problems).toContain("web/dist/assets/a.png: OpenAI-style key");
    expect(problems.join("\n")).not.toContain(secret);
  });
  it("refuses an oversized actual file despite a small claimed size", () => {
    const f = pkg({ "web/dist/assets/a.png": Buffer.alloc(MAX_FILE_BYTES + 1) });
    f.files.find((file) => file.path.endsWith("a.png")).size = 1;
    expect(f.check()).toContain("web/dist/assets/a.png: not a bounded regular file");
  });
  it("detects an ordinary metadata size mismatch", () => {
    const f = pkg();
    f.files.find((file) => file.path === "dist/cli.mjs").size = 1;
    expect(f.check()).toContain("dist/cli.mjs: inventory size does not match file");
  });
  it.each(["file", "parent", "hardlink"])("refuses a %s link within the packed tree", (mode) => {
    const f = pkg(),
      file = join(f.dir, "dist/cli.mjs");
    if (mode === "file") {
      rmSync(file);
      symlinkSync(join(f.dir, "dist/daemon.mjs"), file);
    }
    if (mode === "hardlink") {
      rmSync(file);
      linkSync(join(f.dir, "dist/daemon.mjs"), file);
    }
    if (mode === "parent") {
      rmSync(join(f.dir, "dist"), { recursive: true });
      mkdirSync(join(f.dir, "other"));
      writeFileSync(join(f.dir, "other/cli.mjs"), "export {};\n");
      symlinkSync(join(f.dir, "other"), join(f.dir, "dist"));
    }
    expect(f.check()).toContain("dist/cli.mjs: not a bounded regular file");
  });
  it("rejects duplicate and case-colliding inventory names", () => {
    const f = pkg();
    f.files.push({ ...f.files[0] });
    expect(f.check()).toContain("package.json: duplicate inventory entry");
    const other = pkg();
    other.files.push({ path: "WEB/DIST/ASSETS/INDEX-AB12.JS", size: 0 });
    expect(other.check()).toContain("WEB/DIST/ASSETS/INDEX-AB12.JS: duplicate inventory entry");
  });
  it.each([
    null,
    {},
    { path: "../outside", size: 0 },
    { path: "dist/cli.mjs", size: -1 },
    { path: "dist/cli.mjs", size: NaN },
    { path: "bad\nname", size: 1 },
  ])("rejects malformed inventory entries without echoing them %#", (entry) => {
    const f = pkg();
    f.files.push(entry);
    expect(f.check()).toContain("invalid package inventory entry");
  });
  it("bounds inventory length and aggregate bytes", () => {
    const f = pkg();
    expect(checkPack(f.dir, { files: Array(4097).fill({ path: "a", size: 0 }) })).toEqual([
      "invalid package inventory",
    ]);
    const files = Array.from({ length: 17 }, (_, i) => ({
      path: `web/dist/assets/a${i}.png`,
      size: MAX_FILE_BYTES,
    }));
    expect(checkPack(f.dir, { files })).toContain("package exceeds byte limit");
  });
  it("requires all runtime and license outputs", () => {
    const f = pkg({
      "dist/daemon.mjs": null,
      "release.json": null,
      "npm-shrinkwrap.json": null,
      "web/dist/assets/licenses/mediabunny-1.61.0.txt": null,
      "web/vendor/selkies/NOTICE.md": null,
    });
    expect(f.check()).toEqual(
      expect.arrayContaining([
        "dist/daemon.mjs: missing",
        "release.json: missing",
        "npm-shrinkwrap.json: missing",
        "Mediabunny license notice: missing",
        "web/vendor/selkies/NOTICE.md: missing",
      ]),
    );
  });
  it("rejects invalid text and developer paths without printing contents", () => {
    const f = pkg({
      "dist/cli.mjs": Buffer.from([0, 255]),
      "dist/daemon.mjs": 'const p="/Volumes/PrivateDisk/project";',
    });
    expect(f.check()).toEqual(
      expect.arrayContaining([
        "dist/cli.mjs: invalid text encoding",
        "dist/daemon.mjs: developer path",
      ]),
    );
  });
});
