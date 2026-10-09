import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadError, downloadFile } from "./download.ts";
import { OutputStore, outputPath } from "./output-store.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-download-version-"));
  homes.push(home);
  const id = ulid();
  const store = new OutputStore(home);
  store.saveBytes(id, "totals.csv", Buffer.from("v1"));
  store.saveBytes(id, "totals.csv", Buffer.from("v2"));
  return { home, id };
}
const signal = () => new AbortController().signal;
describe("downloading one version", () => {
  it("serves the bytes of the version asked for, and the newest by name", async () => {
    const f = fixture();
    expect(await downloadFile(f.home, f.id, "totals.csv", signal(), false, 1).text()).toBe("v1");
    expect(await downloadFile(f.home, f.id, "totals.csv", signal()).text()).toBe("v2");
  });
  it("refuses numbers outside 1–10000, missing versions and linked version files", () => {
    const f = fixture();
    for (const version of [0, -1, 1.5, 10_001, 3])
      expect(() => downloadFile(f.home, f.id, "totals.csv", signal(), false, version)).toThrow(
        DownloadError,
      );
    const outside = join(f.home, "outside.txt");
    writeFileSync(outside, "secret");
    rmSync(join(f.home, outputPath(f.id, "totals.csv", 2) as string));
    symlinkSync(outside, join(f.home, outputPath(f.id, "totals.csv", 2) as string));
    expect(() => downloadFile(f.home, f.id, "totals.csv", signal(), false, 2)).toThrow(
      DownloadError,
    );
  });
});
