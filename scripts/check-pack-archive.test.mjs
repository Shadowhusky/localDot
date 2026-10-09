import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleManifest } from "../packages/protocol/src/testing/sample-release.ts";
import { checkPack, packFiles } from "./check-pack.mjs";
import { checkPackArchive } from "./check-pack-archive.mjs";

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "localdot-npm-archive-"));
  roots.push(root);
  const dir = join(root, "pkg"),
    out = join(root, "out"),
    cache = join(root, "cache");
  for (const path of [dir, out, cache]) mkdirSync(path);
  vi.stubEnv("npm_config_cache", cache);
  const files = {
    "package.json": JSON.stringify({
      name: "localdot",
      version: "1.0.0",
      private: true,
      type: "module",
      bin: { localdot: "bin/localdot.mjs" },
      files: [
        "bin/",
        "dist/",
        "web/",
        "skills/",
        "release.json",
        "THIRD-PARTY.md",
        "npm-shrinkwrap.json",
      ],
      scripts: {
        prepack: 'node -e "process.exit(17)"',
        prepare: 'node -e "process.exit(18)"',
        postpack: 'node -e "process.exit(19)"',
      },
    }),
    "README.md": "# localDot test package\n",
    LICENSE: "MIT\n",
    "THIRD-PARTY.md": "# Test license inventory\n",
    "npm-shrinkwrap.json": JSON.stringify({
      name: "localdot",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "localdot", version: "1.0.0" } },
    }),
    "bin/localdot.mjs": "#!/usr/bin/env node\nexport {};\n",
    "dist/cli.mjs": "export {};\n",
    "dist/daemon.mjs": "export {};\n",
    "dist/quiet-page-worker.mjs": "export {};\n",
    "dist/release-verification-worker.mjs": "export {};\n",
    "dist/canary-scan.py": "# fixture scanner\n",
    "dist/canary-worker.py": "# fixture worker\n",
    "dist/sandbox-runtime/package.json": "{}\n",
    "dist/sandbox-runtime/LICENSE": "Apache-2.0\n",
    "dist/sandbox-runtime/NOTICE.md": "# Modified sandbox\n",
    "dist/sandbox-runtime/PATCH.txt": "fixture patch\n",
    "dist/sandbox-runtime/dist/cli.mjs": "export {};\n",
    "dist/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar": "fixture jar\n",
    "dist/browser-seccomp.json": "{}\n",
    "skills/office-files/SKILL.md": "# Office files\n",
    "web/dist/index.html": "<!doctype html>\n",
    "web/dist/export.html": "<!doctype html>\n",
    "web/dist/assets/index-Ab12.js": "export {};\n",
    "web/dist/assets/licenses/mediabunny-1.61.0.txt": "Mozilla Public License Version 2.0\n",
    "web/vendor/selkies/LICENSE": "Mozilla Public License Version 2.0\n",
    "web/vendor/selkies/NOTICE.md": "# Selkies\n",
    "web/vendor/selkies/manifest.json": "{}\n",
    ...extra,
  };
  const manifest = sampleManifest();
  manifest.files = Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => path !== "package.json")
      .map(([path, data]) => [path, createHash("sha256").update(data).digest("hex")]),
  );
  files["release.json"] = JSON.stringify(manifest);
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  chmodSync(join(dir, "bin/localdot.mjs"), 0o755);
  const pack = () => {
    const text = execFileSync(
      "npm",
      ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", out],
      {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        env: {
          ...process.env,
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      },
    );
    const [receipt] = JSON.parse(text);
    return { receipt, archive: join(out, receipt.filename) };
  };
  return { root, dir, files, out, pack };
}

describe("actual offline npm archive acceptance", () => {
  it("packs without lifecycle scripts and audits the exact npm tarball and integrity", () => {
    const f = fixture(),
      { receipt, archive } = f.pack();
    const before = readdirSync(f.root).sort();
    const result = checkPackArchive(archive, { temporaryParent: f.root });
    expect(result.problems).toEqual([]);
    expect(result.integrity).toBe(receipt.integrity);
    expect(result.files.map((file) => file.path).sort()).toEqual(
      receipt.files.map((file) => file.path).sort(),
    );
    for (const file of result.files) {
      expect(file.sha256).toBe(createHash("sha256").update(f.files[file.path]).digest("hex"));
    }
    expect(result.files.find((file) => file.path === "bin/localdot.mjs").mode & 0o111).not.toBe(0);
    expect(readdirSync(f.root).sort()).toEqual(before);
    // The directory adapter also invokes real npm offline with lifecycle scripts disabled.
    expect(checkPack(f.dir, { files: packFiles(f.dir) })).toEqual([]);
  });
  it("rejects a source map still in the archive after it disappears from the original directory", () => {
    const f = fixture({ "dist/cli.mjs.map": "{}\n" }),
      { archive } = f.pack();
    rmSync(join(f.dir, "dist/cli.mjs.map"));
    expect(checkPack(f.dir, { files: packFiles(f.dir) })).toEqual([]);
    expect(checkPackArchive(archive).problems).toContain("dist/cli.mjs.map: not in the allowlist");
  });
  it("rejects an archive whose launcher lost its executable permission", () => {
    const f = fixture();
    chmodSync(join(f.dir, "bin/localdot.mjs"), 0o644);
    const { archive } = f.pack();
    expect(checkPackArchive(archive).problems).toContain(
      "bin/localdot.mjs: launcher is not executable",
    );
  });
  it("finds binary secret-like content in the archive even after the source file is replaced", () => {
    const secret = ["sk", "proj", "z".repeat(40)].join("-");
    const f = fixture({ "web/dist/assets/image.png": Buffer.from(`\0${secret}`) }),
      { archive } = f.pack();
    writeFileSync(join(f.dir, "web/dist/assets/image.png"), "clean now");
    const result = checkPackArchive(archive);
    expect(result.problems).toContain("web/dist/assets/image.png: OpenAI-style key");
    expect(result.problems.join("\n")).not.toContain(secret);
  });
  it("detects forbidden metadata while preserving a clean archive's member contents", () => {
    const f = fixture(),
      { archive } = f.pack();
    const altered = join(f.out, "metadata.tgz");
    const secret = ["sk", "proj", "z".repeat(40)].join("-");
    const code = `import gzip,io,json,sys,tarfile
s,d,secret=json.loads(sys.stdin.read())
raw=io.BytesIO()
with tarfile.open(s,"r:gz") as old,tarfile.open(fileobj=raw,mode="w",format=tarfile.PAX_FORMAT) as new:
 for i,m in enumerate(old):
  if i==0:m.pax_headers={**m.pax_headers,"comment":secret}
  new.addfile(m,old.extractfile(m))
with open(d,"wb") as out:out.write(gzip.compress(raw.getvalue(),mtime=0))
`;
    execFileSync("python3", ["-I", "-S", "-c", code], {
      input: JSON.stringify([archive, altered, secret]),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    const result = checkPackArchive(altered);
    expect(result.problems).toContain("archive metadata: OpenAI-style key");
    expect(result.problems.join("\n")).not.toContain(secret);
  });
  it("cleans its private tree after a malformed archive and reports no source path", () => {
    const f = fixture(),
      archive = join(f.out, "broken.tgz");
    writeFileSync(archive, "not gzip");
    const before = readdirSync(f.root).sort();
    expect(checkPackArchive(archive, { temporaryParent: f.root }).problems).toEqual([
      "archive could not be verified",
    ]);
    expect(readdirSync(f.root).sort()).toEqual(before);
    expect(
      checkPackArchive(archive, { temporaryParent: join(f.root, "missing") }).problems,
    ).toEqual(["archive could not be verified"]);
  });
});
