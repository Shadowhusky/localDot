import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStatic } from "./static-files.ts";

describe("readStatic", () => {
  const dir = mkdtempSync(join(tmpdir(), "local dot's static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>hi</html>");
  writeFileSync(join(dir, "assets", "a.js"), "export {}");
  writeFileSync(join(tmpdir(), "ld-outside.txt"), "secret");

  it("serves files under the directory with their media type", () => {
    expect(readStatic(dir, "/index.html")).toEqual({
      body: Buffer.from("<html>hi</html>"),
      type: "text/html; charset=utf-8",
    });
    expect(readStatic(dir, "assets/a.js")?.type).toBe("text/javascript; charset=utf-8");
  });

  it("refuses paths that escape the directory, directories and missing files", () => {
    expect(readStatic(dir, "/../ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets/../../ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets")).toBeUndefined();
    expect(readStatic(dir, "/nope.js")).toBeUndefined();
  });
});
