import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathError, resolveInHome } from "./home.ts";

let root: string;
let home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "local dot's home-")));
  home = join(root, "home");
  mkdirSync(join(home, "Documents"), { recursive: true });
  mkdirSync(join(root, "outside"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveInHome", () => {
  it("accepts home, relative, tilde, absolute and new descendants", () => {
    for (const [raw, expected] of [
      ["", home],
      ["~", home],
      ["Documents", join(home, "Documents")],
      ["~/Documents/new/a.txt", join(home, "Documents/new/a.txt")],
      [join(home, "new.md"), join(home, "new.md")],
      ["..foo", join(home, "..foo")],
      ["Documents/../a.txt", join(home, "a.txt")],
    ]) {
      expect(resolveInHome(home, raw ?? ""), raw).toBe(expected);
    }
  });

  it("refuses traversal, absolute outsiders, sibling prefixes and NUL", () => {
    for (const raw of [
      "../outside/x",
      join(root, "outside"),
      `${home}-other/file`,
      "Documents/../../outside",
      "../home/Documents",
      "a\0b",
    ]) {
      expect(() => resolveInHome(home, raw), raw).toThrow(PathError);
    }
  });

  it("rejects a symlink escape at the leaf or any existing ancestor", () => {
    symlinkSync(join(root, "outside"), join(home, "escape"));
    symlinkSync("../../outside", join(home, "Documents/escape"));
    for (const raw of ["escape", "escape/new/child", "Documents/escape/new/child"]) {
      expect(() => resolveInHome(home, raw), raw).toThrow(PathError);
    }
  });

  it("does not normalize away an escaping symlink or traversal", () => {
    symlinkSync(join(root, "outside"), join(home, "escape"));
    for (const raw of ["escape/../home/Documents", "escape/../Documents", `${home}/escape/../x`]) {
      expect(() => resolveInHome(home, raw), raw).toThrow(PathError);
    }
  });

  it("resolves links inside the home and applies .. to the real parent", () => {
    mkdirSync(join(home, "Documents/nested"));
    symlinkSync("Documents/nested", join(home, "alias"));
    expect(resolveInHome(home, "alias/new/a")).toBe(join(home, "Documents/nested/new/a"));
    expect(resolveInHome(home, "alias/../a")).toBe(join(home, "Documents/a"));
  });

  it("refuses dangling and cyclic links instead of treating them as new folders", () => {
    symlinkSync(join(root, "outside/missing"), join(home, "dangling"));
    symlinkSync("cycle", join(home, "cycle"));
    for (const raw of ["dangling", "dangling/new/file", "cycle/new/file"]) {
      expect(() => resolveInHome(home, raw), raw).toThrow(PathError);
    }
  });

  it("refuses an existing non-directory ancestor", () => {
    writeFileSync(join(home, "file"), "fixture");
    expect(() => resolveInHome(home, "file/child")).toThrow(PathError);
    expect(() => resolveInHome(home, "file/../a")).toThrow(PathError);
  });

  it("accepts the configured and canonical spelling of a symlinked home", () => {
    const alias = join(root, "home-alias");
    symlinkSync(home, alias);
    expect(resolveInHome(alias, `${alias}/new`)).toBe(join(home, "new"));
    expect(resolveInHome(alias, `${home}/new`)).toBe(join(home, "new"));
  });

  it("reports an unavailable or non-directory home as PathError", () => {
    writeFileSync(join(root, "file"), "fixture");
    expect(() => resolveInHome(join(root, "missing"), "a")).toThrow(PathError);
    expect(() => resolveInHome(join(root, "file"), "a")).toThrow(PathError);
  });
});
