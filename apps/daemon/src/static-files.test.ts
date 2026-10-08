import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readStatic } from "./static-files.ts";

describe("readStatic", () => {
  // dir sits inside top, beside a file no lookup may reach.
  const top = mkdtempSync(join(tmpdir(), "local dot's static-"));
  const dir = join(top, "dir");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html>hi</html>");
  writeFileSync(join(dir, "assets", "a.js"), "export {}");
  writeFileSync(join(dir, "assets", "body-48.webp"), "RIFF");
  writeFileSync(join(top, "ld-outside.txt"), "secret");
  afterAll(() => rmSync(top, { recursive: true, force: true }));

  it("serves files under the directory with their media type", () => {
    expect(readStatic(dir, "/index.html")).toEqual({
      body: Buffer.from("<html>hi</html>"),
      type: "text/html; charset=utf-8",
    });
    expect(readStatic(dir, "assets/a.js")?.type).toBe("text/javascript; charset=utf-8");
    expect(readStatic(dir, "/assets/body-48.webp")?.type).toBe("image/webp");
  });

  it("refuses paths that escape the directory, directories and missing files", () => {
    expect(readStatic(dir, "/../ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets/../../ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets")).toBeUndefined();
    expect(readStatic(dir, "/nope.js")).toBeUndefined();
    expect(readStatic(join(top, "missing"), "/index.html")).toBeUndefined();
  });

  it("refuses symlinks that lead outside the directory, wherever they sit on the path", () => {
    symlinkSync(join(top, "ld-outside.txt"), join(dir, "assets", "leak.js"));
    symlinkSync(top, join(dir, "up"));
    symlinkSync(join(dir, "index.html"), join(dir, "assets", "home.html"));
    expect(readStatic(dir, "/assets/leak.js")).toBeUndefined();
    expect(readStatic(dir, "/up/ld-outside.txt")).toBeUndefined();
    expect(readStatic(dir, "/assets/home.html")?.type).toBe("text/html; charset=utf-8");
  });

  it("serves from a directory that is itself reached through a symlink", () => {
    const linked = join(top, "linked-dir");
    symlinkSync(dir, linked);
    expect(readStatic(linked, "/assets/a.js")?.type).toBe("text/javascript; charset=utf-8");
  });
});
