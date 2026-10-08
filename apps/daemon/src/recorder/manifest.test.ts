import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { capActivity, readManifest, writeManifest } from "./manifest.ts";

const roots: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "recording-manifest-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("manifest storage", () => {
  it("distinguishes absent, invalid, and valid manifests", () => {
    const dir = setup();
    expect(readManifest(dir)).toBeNull();
    writeFileSync(join(dir, "manifest.json"), "{");
    expect(readManifest(dir)?.ok).toBe(false);
    writeManifest(dir, emptyManifest("none"));
    expect(readManifest(dir)).toEqual({ ok: true, manifest: emptyManifest("none") });
  });
  it("atomically replaces a private file and leaves no temporary files", () => {
    const dir = setup();
    writeManifest(dir, emptyManifest("none"));
    writeManifest(dir, emptyManifest("complete"));
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).state).toBe("complete");
    expect(statSync(join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });
  it("rejects future formats and capped schema violations without accepting them as absence", () => {
    const dir = setup();
    for (const data of [
      { ...emptyManifest("none"), v: 2 },
      {
        ...emptyManifest("none"),
        gaps: Array(10_001).fill({ from: 0, to: null, reason: "stream-lost" }),
      },
    ]) {
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(data));
      expect(readManifest(dir)?.ok).toBe(false);
    }
  });
  it("coalesces old activity while preserving input coverage and immutability", () => {
    const source = Array.from({ length: 50 }, (_, i) => ({ from: i * 20, to: i * 20 + 10 }));
    const before = structuredClone(source);
    const out = capActivity(source, 4);
    expect(out).toHaveLength(4);
    expect(source).toEqual(before);
    for (const s of source) expect(out.some((v) => v.from <= s.from && v.to >= s.to)).toBe(true);
    expect(() => capActivity(source, 0)).toThrow();
  });
});
