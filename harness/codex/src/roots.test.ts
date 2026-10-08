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
import * as fs from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOwnedCodexDirectory,
  assertOwnedCodexRoots,
  CodexRootsError,
  codexInstallDirectory,
  createOwnedCodexDirectory,
  type OwnedCodexRoots,
  persistOwnedCodexProfile,
  prepareOwnedCodexRoots,
  publishOwnedCodexDirectory,
  removeOwnedCodexDirectory,
} from "./roots.ts";

const owned: string[] = [];
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
function fixture() {
  const top = mkdtempSync("/tmp/localdot-codex-roots-");
  owned.push(top);
  const realHome = join(top, "user");
  mkdirSync(realHome, { mode: 0o700 });
  const localdot = join(top, "app");
  return { top, realHome, localdot };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each(["profilesRoot", "workRoot", "runRoot", "binRoot"] as const)(
  "persists %s cleanup through the managed parents, including an absent-path retry",
  async (area) => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
      directory = createOwnedCodexDirectory(roots, area);
    const original = fs.open,
      synced: string[] = [],
      closed: string[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      expect(existsSync(directory.path)).toBe(false);
      const fd = await original(...args),
        sync = fd.sync.bind(fd),
        close = fd.close.bind(fd);
      fd.sync = async () => {
        await sync();
        synced.push(String(args[0]));
      };
      fd.close = async () => {
        await close();
        closed.push(String(args[0]));
      };
      return fd;
    });
    await removeOwnedCodexDirectory(directory);
    await removeOwnedCodexDirectory(directory);
    const expected = [roots[area], roots.root, realpathSync(f.localdot)];
    expect(synced).toEqual([...expected, ...expected]);
    expect(closed).toEqual(synced);
  },
);

it("does not acknowledge cleanup if a parent sync fails, closes the handle and permits a durable retry", async () => {
  const f = fixture(),
    roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
    profile = createOwnedCodexDirectory(roots, "profilesRoot");
  const original = fs.open,
    closed = vi.fn();
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await original(...args),
      close = fd.close.bind(fd);
    fd.sync = async () => {
      throw new Error("disk sync failed");
    };
    fd.close = async () => {
      await close();
      closed();
    };
    return fd;
  });
  await expect(removeOwnedCodexDirectory(profile)).rejects.toThrow(CodexRootsError);
  expect(closed).toHaveBeenCalledOnce();
  expect(existsSync(profile.path)).toBe(false);
  spy.mockRestore();
  await removeOwnedCodexDirectory(profile);
});

it("rejects a parent replacement during removal without deleting from the replacement", async () => {
  const f = fixture(),
    roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
    profile = createOwnedCodexDirectory(roots, "profilesRoot"),
    original = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    await original(...args);
    renameSync(roots.profilesRoot, `${roots.profilesRoot}-retained`);
    mkdirSync(roots.profilesRoot, { mode: 0o700 });
    mkdirSync(profile.path, { mode: 0o700 });
    writeFileSync(join(profile.path, "keep"), "replacement");
  });
  await expect(removeOwnedCodexDirectory(profile)).rejects.toThrow(CodexRootsError);
  expect(readFileSync(join(profile.path, "keep"), "utf8")).toBe("replacement");
});

it("flushes a staged bin before rename and all managed parents before publication resolves", async () => {
  const f = fixture(),
    roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
    staging = createOwnedCodexDirectory(roots, "binRoot"),
    target = codexInstallDirectory(roots, `0.154.0-${"a".repeat(64)}`);
  const original = fs.open,
    synced: string[] = [],
    closed: string[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await original(...args),
      sync = fd.sync.bind(fd),
      close = fd.close.bind(fd);
    fd.sync = async () => {
      expect(existsSync(target)).toBe(String(args[0]) !== staging.path);
      await sync();
      synced.push(String(args[0]));
    };
    fd.close = async () => {
      await close();
      closed.push(String(args[0]));
    };
    return fd;
  });
  await publishOwnedCodexDirectory(staging, target);
  expect(synced).toEqual([staging.path, roots.binRoot, roots.root, realpathSync(f.localdot)]);
  expect(closed).toEqual(synced);
  expect(existsSync(staging.path)).toBe(false);
  expect(existsSync(target)).toBe(true);
});

it.each(["before", "after"])(
  "reports sync failure %s rename and preserves the remaining inode",
  async (when) => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
      staging = createOwnedCodexDirectory(roots, "binRoot"),
      target = codexInstallDirectory(roots, `0.154.0-${"a".repeat(64)}`);
    writeFileSync(join(staging.path, "keep"), "verified fixture");
    const inode = lstatSync(staging.path).ino,
      original = fs.open,
      closed: string[] = [];
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const fd = await original(...args),
        sync = fd.sync.bind(fd),
        close = fd.close.bind(fd);
      fd.sync = async () => {
        if (String(args[0]) === (when === "before" ? staging.path : roots.binRoot))
          throw new Error("disk sync failed");
        await sync();
      };
      fd.close = async () => {
        await close();
        closed.push(String(args[0]));
      };
      return fd;
    });
    await expect(publishOwnedCodexDirectory(staging, target)).rejects.toThrow();
    expect(existsSync(target)).toBe(when === "after");
    const retained = when === "before" ? staging.path : target;
    expect(lstatSync(retained).ino).toBe(inode);
    expect(readFileSync(join(retained, "keep"), "utf8")).toBe("verified fixture");
    expect(closed).toContain(when === "before" ? staging.path : roots.binRoot);
    spy.mockRestore();
    await removeOwnedCodexDirectory(staging);
    expect(existsSync(target)).toBe(when === "after");
  },
);

it.each(["before", "after"])(
  "settles cancellation %s the publication point without undoing a rename",
  async (when) => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
      staging = createOwnedCodexDirectory(roots, "binRoot"),
      target = codexInstallDirectory(roots, `0.154.0-${"a".repeat(64)}`),
      controller = new AbortController(),
      original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const fd = await original(...args),
        sync = fd.sync.bind(fd);
      fd.sync = async () => {
        await sync();
        if (String(args[0]) === (when === "before" ? staging.path : roots.binRoot))
          controller.abort(new Error("cancelled"));
      };
      return fd;
    });
    const publish = publishOwnedCodexDirectory(staging, target, controller.signal);
    if (when === "before") await expect(publish).rejects.toThrow("cancelled");
    else await publish;
    expect(existsSync(target)).toBe(when === "after");
  },
);

it("persists the protected launch breadcrumb and each managed parent before returning", async () => {
  const f = fixture(),
    roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
    profile = createOwnedCodexDirectory(roots, "profilesRoot");
  const original = fs.open,
    synced: string[] = [],
    closed: string[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await original(...args),
      sync = fd.sync.bind(fd),
      close = fd.close.bind(fd);
    fd.sync = async () => {
      await sync();
      synced.push(String(args[0]));
    };
    fd.close = async () => {
      await close();
      closed.push(String(args[0]));
    };
    return fd;
  });
  await persistOwnedCodexProfile(roots, profile);
  expect(synced).toEqual([profile.path, roots.profilesRoot, roots.root, realpathSync(f.localdot)]);
  expect(closed).toEqual(synced);
});

it("retains the breadcrumb and closes its descriptor on durability failure", async () => {
  const f = fixture(),
    roots = prepareOwnedCodexRoots(f.localdot, f.realHome),
    profile = createOwnedCodexDirectory(roots, "profilesRoot");
  const original = fs.open,
    closed = vi.fn();
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await original(...args),
      close = fd.close.bind(fd);
    fd.sync = async () => {
      throw new Error("private filesystem detail");
    };
    fd.close = async () => {
      await close();
      closed();
    };
    return fd;
  });
  await expect(persistOwnedCodexProfile(roots, profile)).rejects.toThrow(CodexRootsError);
  expect(closed).toHaveBeenCalledOnce();
  expect(existsSync(profile.path)).toBe(true);
});

it.each(["copy", "wrong-area", "replaced", "public"])(
  "refuses %s profile ownership before persistence",
  async (fault) => {
    const f = fixture(),
      roots = prepareOwnedCodexRoots(f.localdot, f.realHome);
    let profile = createOwnedCodexDirectory(
      roots,
      fault === "wrong-area" ? "workRoot" : "profilesRoot",
    );
    if (fault === "copy") profile = { ...profile };
    if (fault === "replaced") {
      renameSync(profile.path, `${profile.path}-old`);
      mkdirSync(profile.path, { mode: 0o700 });
    }
    if (fault === "public") chmodSync(profile.path, 0o755);
    await expect(persistOwnedCodexProfile(roots, profile)).rejects.toThrow(CodexRootsError);
  },
);

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
