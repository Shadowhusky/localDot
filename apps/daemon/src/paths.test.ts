import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localdotHome, secureHome } from "./paths.ts";

describe("localdotHome", () => {
  it("honours LOCALDOT_HOME", () => {
    expect(localdotHome({ LOCALDOT_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  it("treats an unset or empty LOCALDOT_HOME as ~/.localdot", () => {
    expect(localdotHome({})).toBe(join(homedir(), ".localdot"));
    expect(localdotHome({ LOCALDOT_HOME: "" })).toBe(join(homedir(), ".localdot"));
  });
});

describe("secureHome", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "ld-home-"));
    made.push(dir);
    return dir;
  };

  it("creates a missing home that only its owner can open", () => {
    const home = join(scratch(), "home");
    expect(secureHome(home)).toEqual({ tightened: false });
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("removes group and other access from an existing home", () => {
    const home = scratch();
    chmodSync(home, 0o755);
    expect(secureHome(home)).toEqual({ tightened: true });
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("leaves a private home as it is", () => {
    const home = scratch();
    chmodSync(home, 0o700);
    expect(secureHome(home)).toEqual({ tightened: false });
  });

  it("refuses a symlink or a file", () => {
    const base = scratch();
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(base, "link"));
    expect(() => secureHome(join(base, "link"))).toThrow(/not a directory you own/);
    writeFileSync(join(base, "file"), "");
    expect(() => secureHome(join(base, "file"))).toThrow(/not a directory you own/);
  });
});
