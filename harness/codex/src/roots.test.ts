import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnedCodexDirectory,
  assertOwnedCodexRoots,
  CodexRootsError,
  codexInstallDirectory,
  createOwnedCodexDirectory,
  type OwnedCodexRoots,
  prepareOwnedCodexRoots,
  publishOwnedCodexDirectory,
  removeOwnedCodexDirectory,
} from "./roots.ts";

const owned: string[] = [];
function fixture() {
  const top = mkdtempSync("/tmp/localdot-codex-roots-");
  owned.push(top);
  const realHome = join(top, "user");
  mkdirSync(realHome, { mode: 0o700 });
  const localdot = join(top, "app");
  return { top, realHome, localdot };
}
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("canonical owned Codex roots", () => {
  it("refuses a dangling protected .codex alias before creating its target", () => {
    const f = fixture(),
      target = join(f.top, "relocated-codex");
    symlinkSync(target, join(f.realHome, ".codex"));
    expect(() => prepareOwnedCodexRoots(target, f.realHome)).toThrow(CodexRootsError);
    expect(existsSync(target)).toBe(false);
    expect(() => prepareOwnedCodexRoots(f.localdot, f.realHome)).toThrow(CodexRootsError);
    expect(existsSync(f.localdot)).toBe(false);
  });
  it.runIf(process.platform === "darwin")(
    "protects missing .codex and normalizes safe future paths through data-volume aliases",
    () => {
      const f = fixture(),
        aliasHome = `/System/Volumes/Data${realpathSync(f.realHome)}`;
      const original = lstatSync(f.realHome),
        alternate = lstatSync(aliasHome);
      expect([alternate.dev, alternate.ino]).toEqual([original.dev, original.ino]);
      expect(() => prepareOwnedCodexRoots(join(aliasHome, ".codex"), f.realHome)).toThrow(
        CodexRootsError,
      );
      expect(existsSync(join(f.realHome, ".codex"))).toBe(false);
      const roots = prepareOwnedCodexRoots(join(aliasHome, ".localdot"), aliasHome);
      expect(roots.root).toBe(join(realpathSync(f.realHome), ".localdot/codex"));
      assertOwnedCodexRoots(roots);
    },
  );
  it.each([0o777, 0o775, 0o770, 0o1777])(
    "refuses replaceable ancestor mode %i before any managed creation",
    (mode) => {
      const f = fixture(),
        shared = join(f.top, "shared");
      mkdirSync(shared, { mode: 0o700 });
      chmodSync(shared, mode);
      const container = join(shared, "private-container");
      mkdirSync(container, { mode: 0o700 });
      const anchor = join(container, "app");
      expect(() => prepareOwnedCodexRoots(anchor, f.realHome)).toThrow(CodexRootsError);
      expect(existsSync(anchor)).toBe(false);
    },
  );
  it("normalizes the OS tmp alias and creates nonoverlapping private owned roots", () => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome);
    expect(roots.root).toBe(join(realpathSync(f.top), "app/codex"));
    expect(new Set(Object.values(roots)).size).toBe(6);
    for (const path of Object.values(roots)) expect(lstatSync(path).mode & 0o777).toBe(0o700);
    assertOwnedCodexRoots(roots);
  });
  it.each(["equal", "ancestor", "user-codex", "user-codex-child"])(
    "rejects %s before creating anything",
    (which) => {
      const f = fixture();
      const target =
        which === "equal"
          ? f.realHome
          : which === "ancestor"
            ? f.top
            : join(f.realHome, ".codex", ...(which === "user-codex-child" ? ["child"] : []));
      expect(() => prepareOwnedCodexRoots(target, f.realHome)).toThrow(CodexRootsError);
      expect(existsSync(join(f.realHome, ".codex"))).toBe(false);
      expect(existsSync(join(f.top, "codex"))).toBe(false);
    },
  );
  it.each(["ancestor", "final", "managed-home", "managed-bin"])(
    "refuses a %s symlink with no outside mutation",
    (where) => {
      const f = fixture(),
        foreign = join(f.top, "foreign");
      mkdirSync(foreign, { mode: 0o700 });
      let path = f.localdot;
      if (where === "ancestor") {
        symlinkSync(foreign, path);
        path = join(path, "nested");
      } else if (where === "final") symlinkSync(foreign, path);
      else {
        mkdirSync(join(path, "codex"), { recursive: true, mode: 0o700 });
        symlinkSync(foreign, join(path, "codex", where === "managed-home" ? "home" : "bin"));
      }
      expect(() => prepareOwnedCodexRoots(path, f.realHome)).toThrow(CodexRootsError);
      expect(readdirSync(foreign)).toEqual([]);
    },
  );
  it("protects a user .codex target through its existing alias", () => {
    const f = fixture(),
      target = join(f.top, "auth-data");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(f.realHome, ".codex"));
    expect(() => prepareOwnedCodexRoots(target, f.realHome)).toThrow(CodexRootsError);
    expect(readdirSync(target)).toEqual([]);
  });
  it.each([0o777, 0o770, 0o755])(
    "refuses a managed directory mode %s without creating siblings",
    (mode) => {
      const f = fixture();
      mkdirSync(join(f.localdot, "codex"), { recursive: true, mode: 0o700 });
      mkdirSync(join(f.localdot, "codex/bin"), { mode: 0o700 });
      chmodSync(join(f.localdot, "codex/bin"), mode);
      expect(() => prepareOwnedCodexRoots(f.localdot, f.realHome)).toThrow(CodexRootsError);
      expect(existsSync(join(f.localdot, "codex/home"))).toBe(false);
    },
  );
  it("refuses a managed regular file before creating any other managed root", () => {
    const f = fixture();
    mkdirSync(join(f.localdot, "codex"), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.localdot, "codex/home"), "owned existing data", { mode: 0o600 });
    expect(() => prepareOwnedCodexRoots(f.localdot, f.realHome)).toThrow(CodexRootsError);
    expect(readFileSync(join(f.localdot, "codex/home"), "utf8")).toBe("owned existing data");
    expect(existsSync(join(f.localdot, "codex/bin"))).toBe(false);
  });
  it("refuses forged/cloned roots and arbitrary target names", () => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome);
    expect(() => assertOwnedCodexRoots({ ...roots } as OwnedCodexRoots)).toThrow(CodexRootsError);
    expect(() => codexInstallDirectory(roots, "../outside")).toThrow(CodexRootsError);
  });
  it("rechecks managed roots and cannot remove a staged directory through a swapped parent", async () => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
      staging = createOwnedCodexDirectory(roots, "binRoot");
    renameSync(roots.binRoot, `${roots.binRoot}-saved`);
    mkdirSync(join(f.top, "foreign"), { mode: 0o700 });
    symlinkSync(join(f.top, "foreign"), roots.binRoot);
    await expect(removeOwnedCodexDirectory(staging)).rejects.toThrow(CodexRootsError);
    expect(readdirSync(join(f.top, "foreign"))).toEqual([]);
    expect(
      existsSync(join(`${roots.binRoot}-saved`, staging.path.split("/").at(-1) as string)),
    ).toBe(true);
  });
  it("keeps foreign replacements and symlink targets when a staging receipt is stale", async () => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
      staging = createOwnedCodexDirectory(roots, "binRoot");
    renameSync(staging.path, `${staging.path}-saved`);
    mkdirSync(staging.path, { mode: 0o700 });
    await expect(removeOwnedCodexDirectory(staging)).rejects.toThrow(CodexRootsError);
    rmSync(staging.path, { recursive: true });
    symlinkSync(`${staging.path}-saved`, staging.path);
    await expect(removeOwnedCodexDirectory(staging)).rejects.toThrow(CodexRootsError);
    expect(existsSync(`${staging.path}-saved`)).toBe(true);
  });
  it("publishes only an owned bin staging and never replaces an existing installation", async () => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
      staging = createOwnedCodexDirectory(roots, "binRoot");
    const target = codexInstallDirectory(roots, `0.154.0-${"a".repeat(64)}`);
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, "marker"), "keep");
    await expect(publishOwnedCodexDirectory(staging, target)).rejects.toThrow(CodexRootsError);
    expect(readFileSync(join(target, "marker"), "utf8")).toBe("keep");
    await removeOwnedCodexDirectory(staging);
    expect(existsSync(staging.path)).toBe(false);
    await expect(removeOwnedCodexDirectory({ path: target })).rejects.toThrow(CodexRootsError);
  });
});

it("gives run capabilities 128 random bits while preserving opaque ownership and exact cleanup", async () => {
  const f = fixture(),
    roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
    first = createOwnedCodexDirectory(roots, "runRoot"),
    second = createOwnedCodexDirectory(roots, "runRoot");
  expect(basename(first.path)).toMatch(/^[a-f0-9]{32}$/);
  expect(basename(second.path)).toMatch(/^[a-f0-9]{32}$/);
  expect(second.path).not.toBe(first.path);
  expect(lstatSync(first.path).mode & 0o777).toBe(0o700);
  assertOwnedCodexDirectory(roots, first, "runRoot");
  expect(() => assertOwnedCodexDirectory(roots, { ...first }, "runRoot")).toThrow(CodexRootsError);
  await removeOwnedCodexDirectory(first);
  expect(existsSync(second.path)).toBe(true);
  expect(existsSync(roots.home)).toBe(true);
  await removeOwnedCodexDirectory(second);
});
