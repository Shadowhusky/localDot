import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  catalogProblems,
  check,
  MIRROR_BASE,
  mirror,
  pinArchive,
  sha256Of,
} from "./speech-assets.mjs";

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

  describe("against what's served", () => {
    afterEach(() => vi.unstubAllGlobals());

    async function served() {
      const src = join(dir, "src", "pkg", "bin");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "tool"), "the program");
      writeFileSync(join(src, "extra"), "not wanted");
      const archive = join(dir, "pkg.tar.gz");
      execFileSync("tar", ["-czf", archive, "-C", join(dir, "src"), "pkg"]);
      const url = "https://upstream.test/pkg.tar.gz";
      const pinned = await pinArchive(archive, url, "pkg", ["bin/tool"]);
      const bytes = readFileSync(archive);
      vi.stubGlobal("fetch", async (_url, init) =>
        init?.headers?.range
          ? new Response(bytes.subarray(0, 1), {
              status: 206,
              headers: { "content-range": `bytes 0-0/${bytes.length}` },
            })
          : new Response(bytes),
      );
      return {
        engine: { version: "1", targets: { "darwin-arm64": pinned } },
        tiers: [],
      };
    }

    it("repacks the same files as a .tar.gz our own release can hold", async () => {
      const catalog = await served();
      const out = join(dir, "mirror");
      const entries = await mirror(catalog, out);
      const entry = entries["engine-1-darwin-arm64"];
      expect(entry.url).toBe(`${MIRROR_BASE}/engine-1-darwin-arm64.tar.gz`);
      const repacked = join(out, "engine-1-darwin-arm64.tar.gz");
      expect(entry.sha256).toBe(await sha256Of(repacked));
      const again = await pinArchive(repacked, entry.url, entry.root, ["bin/tool"]);
      expect(again.files).toEqual(catalog.engine.targets["darwin-arm64"].files);
      expect(execFileSync("tar", ["-tzf", repacked], { encoding: "utf8" })).not.toContain("extra");
      expect(existsSync(join(out, "THIRD-PARTY.md"))).toBe(true);
    });

    it("refuses to mirror bytes that don't match their pin", async () => {
      const catalog = await served();
      catalog.engine.targets["darwin-arm64"].sources[0].sha256 = "b".repeat(64);
      await expect(mirror(catalog, join(dir, "bad"))).rejects.toThrow(/SHA-256/);
    });

    it("confirms sizes and, on request, every byte", async () => {
      const catalog = await served();
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await check(catalog, false)).toEqual([]);
      expect(await check(catalog, true)).toEqual([]);
      catalog.engine.targets["darwin-arm64"].files["bin/tool"].sha256 = "c".repeat(64);
      expect((await check(catalog, true)).join()).toMatch(/doesn't match/);
      catalog.engine.targets["darwin-arm64"].sources[0].bytes = 1;
      expect((await check(catalog, false)).join()).toMatch(/answers 206/);
    });
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
