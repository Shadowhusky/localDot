import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tar } from "./tar.ts";

let temporary: string | undefined;
afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

describe("tar", () => {
  it("writes an archive the system tar extracts byte for byte, with the modes given", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const big = "x".repeat(1500);
    const binary = Buffer.from([0, 128, 255, 192, 10]);
    const archive = tar([
      { name: "ca.pem", data: pem },
      { name: "proxy-token", data: "j6CLzsRw79yMKkRwPznckks1fdcXOOnPN3DYp3Al_gk", mode: 0o640 },
      { name: "big.txt", data: big },
      { name: "empty", data: "" },
      { name: "binary", data: binary },
      { name: "utf8", data: "你好 — hello" },
      { name: "x".repeat(100), data: "full name" },
    ]);
    expect(archive.length % 512).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "local dot's tar-"));
    temporary = dir;
    const file = join(dir, "a.tar");
    writeFileSync(file, archive);
    const listing = execFileSync("tar", ["-tvf", file], { encoding: "utf8" });
    expect(listing).toMatch(/-rw-r--r--.*ca\.pem/);
    expect(listing).toMatch(/-rw-r-----.*proxy-token/);
    execFileSync("tar", ["-xf", file, "-C", dir]);
    expect(readFileSync(join(dir, "ca.pem"), "utf8")).toBe(pem);
    expect(readFileSync(join(dir, "big.txt"), "utf8")).toBe(big);
    expect(statSync(join(dir, "empty")).size).toBe(0);
    expect(readFileSync(join(dir, "binary"))).toEqual(binary);
    expect(readFileSync(join(dir, "utf8"), "utf8")).toBe("你好 — hello");
    expect(readFileSync(join(dir, "x".repeat(100)), "utf8")).toBe("full name");
    expect(statSync(join(dir, "proxy-token")).mode & 0o777).toBe(0o640);
  });

  it("refuses names that are paths, empty, too long or not plain", () => {
    for (const name of [
      "../x",
      "a/b",
      "",
      ".",
      "..",
      "x".repeat(101),
      "a b",
      "é",
      "a\\b",
      "a\u0000b",
      "a\nb",
    ]) {
      expect(() => tar([{ name, data: "x" }]), name).toThrow(RangeError);
    }
  });

  it("rejects duplicate files and invalid numeric header fields", () => {
    expect(() =>
      tar([
        { name: "token", data: "a" },
        { name: "token", data: "b" },
      ]),
    ).toThrow(RangeError);
    for (const mode of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 0o4755, 0o1000]) {
      expect(() => tar([{ name: "token", data: "a", mode }])).toThrow(RangeError);
    }
    for (const mtime of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 8 ** 11]) {
      expect(() => tar([{ name: "token", data: "a" }], mtime)).toThrow(RangeError);
    }
  });
});
