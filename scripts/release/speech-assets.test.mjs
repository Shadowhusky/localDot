import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogProblems, pinArchive, sha256Of } from "./speech-assets.mjs";

const hash = "a".repeat(64);
const good = {
  engine: {
    version: "1",
    targets: {
      "darwin-arm64": {
        files: { "bin/x": { sha256: hash, bytes: 1 } },
        sources: [{ url: "https://example.test/a.tar.bz2", sha256: hash, bytes: 1, root: "a" }],
      },
    },
  },
  tiers: [
    {
      id: "light",
      files: { "m.onnx": { sha256: hash, bytes: 1 } },
      sources: [{ url: "https://example.test/m.tar.bz2", sha256: hash, bytes: 1, root: "m" }],
    },
  ],
};

describe("the speech pins", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "speech-assets-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes a fully pinned catalog", () => {
    expect(catalogProblems(good)).toEqual([]);
  });

  it("finds an unpinned, plain-http or sizeless source", () => {
    const bad = structuredClone(good);
    const source = bad.tiers[0].sources[0];
    source.url = "http://example.test/m.tar.bz2";
    source.sha256 = "";
    source.bytes = 0;
    bad.tiers[0].files["../up"] = { sha256: "", bytes: 0 };
    const problems = catalogProblems(bad).join("\n");
    expect(problems).toMatch(/isn't https/);
    expect(problems).toMatch(/no SHA-256/);
    expect(problems).toMatch(/no size/);
    expect(problems).toMatch(/bad path/);
  });

  it("refuses a catalog with no source for a bundle", () => {
    const bad = structuredClone(good);
    bad.engine.targets["darwin-arm64"].sources = [];
    expect(catalogProblems(bad).join()).toMatch(/no source/);
  });

  it("pins the files inside an archive and the archive itself", async () => {
    const root = join(dir, "pkg", "bin");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "tool"), "the program");
    const archive = join(dir, "pkg.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", dir, "pkg"]);
    const pinned = await pinArchive(archive, "https://example.test/pkg.tar.gz", "pkg", [
      "bin/tool",
    ]);
    expect(pinned.files["bin/tool"]).toEqual({
      sha256: await sha256Of(join(root, "tool")),
      bytes: 11,
    });
    expect(pinned.sources[0]).toMatchObject({
      url: "https://example.test/pkg.tar.gz",
      sha256: await sha256Of(archive),
      root: "pkg",
    });
  });
});
