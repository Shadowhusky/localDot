import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
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
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { persistNativeRetirement } from "../../../../harness/codex/src/retirement-record.ts";
import {
  createOwnedCodexDirectory,
  prepareOwnedCodexRoots,
} from "../../../../harness/codex/src/roots.ts";
import { recoverNativeRetired } from "./native-recovery.ts";
import { assertNativeRetired } from "./native-retirement.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
const owned: string[] = [];
const signal = () => new AbortController().signal;
async function fixture(bridge = true) {
  const top = realpathSync(mkdtempSync("/tmp/localdot-native-recovery-"));
  owned.push(top);
  const user = join(top, "user");
  mkdirSync(user, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(top, "app"), user);
  const resources = {
    profile: createOwnedCodexDirectory(roots, "profilesRoot"),
    work: createOwnedCodexDirectory(roots, "workRoot"),
    ...(bridge ? { bridge: createOwnedCodexDirectory(roots, "runRoot") } : {}),
  };
  for (const resource of Object.values(resources))
    writeFileSync(join(resource.path, "keep"), "retained");
  const receipt = await persistNativeRetirement(roots, resources, Promise.resolve());
  return {
    top,
    roots,
    resources,
    receipt,
    home: dirname(roots.root),
    path: join(roots.profilesRoot, receipt.name),
  };
}
function intact(f: Awaited<ReturnType<typeof fixture>>) {
  expect(existsSync(f.path)).toBe(true);
  for (const resource of Object.values(f.resources))
    expect(readFileSync(join(resource.path, "keep"), "utf8")).toBe("retained");
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each([true, false])(
  "recovers a persisted exact receipt, with bridge=%s, and is repeatable",
  async (bridge) => {
    const f = await fixture(bridge);
    writeFileSync(join(f.roots.home, "credential-fixture"), "leave alone", { mode: 0o600 });
    await expect(assertNativeRetired(f.home, signal())).rejects.toThrow();
    await recoverNativeRetired(f.home, signal());
    await assertNativeRetired(f.home, signal());
    await recoverNativeRetired(f.home, signal());
    expect(readFileSync(join(f.roots.home, "credential-fixture"), "utf8")).toBe("leave alone");
    for (const resource of Object.values(f.resources))
      expect(existsSync(resource.path)).toBe(false);
    expect(existsSync(f.path)).toBe(false);
  },
);

it.each(["profile", "work", "bridge"] as const)(
  "retries when %s removal completed before the crash",
  async (key) => {
    const f = await fixture(),
      resource = f.resources[key];
    if (!resource) throw new Error("fixture");
    rmSync(resource.path, { recursive: true });
    await recoverNativeRetired(f.home, signal());
    await assertNativeRetired(f.home, signal());
  },
);

it.each(["profilesRoot", "workRoot", "runRoot"] as const)(
  "refuses an unclaimed %s entry before any deletion",
  async (area) => {
    const f = await fixture();
    createOwnedCodexDirectory(f.roots, area);
    const remove = vi.spyOn(fs, "rm");
    await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow("Native task recovery");
    expect(remove).not.toHaveBeenCalled();
    intact(f);
  },
);

it.each([
  "truncated",
  "version",
  "nonce",
  "absolute",
  "parent",
  "identity",
  "too-large",
  "utf8",
] as const)("refuses %s evidence before cleanup", async (kind) => {
  const f = await fixture(),
    record = structuredClone(f.receipt.record);
  let bytes: string | Buffer = "{";
  if (kind === "version") bytes = JSON.stringify({ ...record, v: 2 });
  if (kind === "nonce") bytes = JSON.stringify({ ...record, nonce: "b".repeat(32) });
  if (kind === "absolute")
    bytes = JSON.stringify({ ...record, work: { ...record.work, name: f.resources.work.path } });
  if (kind === "parent") {
    record.parents.work.ino = "0";
    bytes = JSON.stringify(record);
  }
  if (kind === "identity") {
    record.work.identity.birthtimeNs = "0";
    bytes = JSON.stringify(record);
  }
  if (kind === "too-large") bytes = " ".repeat(8193);
  if (kind === "utf8") bytes = Buffer.from([0xff]);
  writeFileSync(f.path, bytes);
  const remove = vi.spyOn(fs, "rm");
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  expect(remove).not.toHaveBeenCalled();
  intact(f);
});

it.each(["symlink", "hardlink", "public"] as const)("refuses a %s receipt", async (kind) => {
  const f = await fixture();
  if (kind === "public") chmodSync(f.path, 0o644);
  else {
    renameSync(f.path, join(f.top, "saved"));
    if (kind === "symlink") symlinkSync(join(f.top, "saved"), f.path);
    else linkSync(join(f.top, "saved"), f.path);
  }
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  intact(f);
});

it.each(["replaced", "symlink", "dangling", "public"] as const)(
  "refuses a %s resource and retains retirement evidence",
  async (kind) => {
    const f = await fixture(),
      path = f.resources.work.path;
    if (kind === "public") chmodSync(path, 0o755);
    else {
      renameSync(path, join(f.top, "saved"));
      if (kind === "replaced") mkdirSync(path, { mode: 0o700 });
      else symlinkSync(join(f.top, kind === "dangling" ? "absent" : "saved"), path);
    }
    const remove = vi.spyOn(fs, "rm");
    await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(true);
    expect(readFileSync(join(f.resources.profile.path, "keep"), "utf8")).toBe("retained");
  },
);

it("refuses duplicate resource claims without retiring either receipt", async () => {
  const f = await fixture(),
    duplicate = structuredClone(f.receipt.record);
  duplicate.nonce = "b".repeat(32);
  writeFileSync(
    join(f.roots.profilesRoot, `.retired-${duplicate.nonce}.json`),
    JSON.stringify(duplicate),
    { mode: 0o600 },
  );
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  intact(f);
});

it("refuses the same physical resource claimed under different names, including an absent alias", async () => {
  const f = await fixture(),
    other = {
      profile: createOwnedCodexDirectory(f.roots, "profilesRoot"),
      work: createOwnedCodexDirectory(f.roots, "workRoot"),
    };
  const duplicate = await persistNativeRetirement(f.roots, other, Promise.resolve());
  duplicate.record.work.identity = structuredClone(f.receipt.record.work.identity);
  writeFileSync(join(f.roots.profilesRoot, duplicate.name), JSON.stringify(duplicate.record));
  rmSync(other.work.path, { recursive: true });
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  intact(f);
  expect(existsSync(other.profile.path)).toBe(true);
});

it("does not follow links inside an exactly retired work directory", async () => {
  const f = await fixture(),
    elsewhere = join(f.top, "outside");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "keep"), "foreign");
  symlinkSync(elsewhere, join(f.resources.work.path, "alias"));
  await recoverNativeRetired(f.home, signal());
  expect(readFileSync(join(elsewhere, "keep"), "utf8")).toBe("foreign");
});

it("retains the receipt after a partial removal and completes on retry", async () => {
  const f = await fixture(),
    original = fs.rm;
  const spy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (String(args[0]) === f.resources.work.path) {
      await original(join(f.resources.work.path, "keep"));
      throw new Error("interrupted");
    }
    return original(...args);
  });
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  expect(existsSync(f.path)).toBe(true);
  expect(existsSync(f.resources.work.path)).toBe(true);
  spy.mockRestore();
  await recoverNativeRetired(f.home, signal());
  await assertNativeRetired(f.home, signal());
});

it("syncs removed resource namespaces before unlinking the receipt and closes all handles", async () => {
  const f = await fixture(),
    originalOpen = fs.open,
    originalUnlink = fs.unlink;
  const events: string[] = [],
    opened: string[] = [],
    closed: string[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await originalOpen(...args),
      sync = fd.sync.bind(fd),
      close = fd.close.bind(fd),
      path = String(args[0]);
    opened.push(path);
    fd.sync = async () => {
      await sync();
      events.push(path);
    };
    fd.close = async () => {
      await close();
      closed.push(path);
    };
    return fd;
  });
  vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
    for (const resource of Object.values(f.resources))
      expect(existsSync(resource.path)).toBe(false);
    expect(events).toEqual([
      f.roots.workRoot,
      f.roots.runRoot,
      f.roots.profilesRoot,
      f.roots.root,
      f.home,
    ]);
    return originalUnlink(...args);
  });
  await recoverNativeRetired(f.home, signal());
  expect(closed).toEqual(opened);
  expect(events.slice(-3)).toEqual([f.roots.profilesRoot, f.roots.root, f.home]);
});

it("does not discard evidence after a directory sync failure", async () => {
  const f = await fixture(),
    original = fs.open;
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await original(...args);
    if (String(args[0]) === f.roots.workRoot)
      fd.sync = async () => {
        throw new Error("sync failed");
      };
    return fd;
  });
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  expect(existsSync(f.path)).toBe(true);
  expect(existsSync(f.resources.work.path)).toBe(false);
  spy.mockRestore();
  await recoverNativeRetired(f.home, signal());
  await assertNativeRetired(f.home, signal());
});

it("does not mutate on pre-cancellation, and keeps evidence if cancellation arrives during removal", async () => {
  const f = await fixture(),
    original = fs.rm,
    controller = new AbortController();
  await expect(recoverNativeRetired(f.home, AbortSignal.abort())).rejects.toThrow();
  intact(f);
  const spy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    await original(...args);
    controller.abort();
  });
  await expect(recoverNativeRetired(f.home, controller.signal)).rejects.toThrow();
  expect(existsSync(f.path)).toBe(true);
  spy.mockRestore();
  await recoverNativeRetired(f.home, signal());
  await assertNativeRetired(f.home, signal());
});

it("refuses an incomplete temporary receipt even beside a valid retirement", async () => {
  const f = await fixture();
  writeFileSync(join(f.roots.profilesRoot, `.retiring-${"a".repeat(32)}.tmp`), "{}", {
    mode: 0o600,
  });
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  intact(f);
});

it("allows a fresh home without creating a native namespace", async () => {
  const top = realpathSync(mkdtempSync("/tmp/localdot-native-recovery-empty-"));
  owned.push(top);
  await recoverNativeRetired(top, signal());
  expect(readdirSync(top)).toEqual([]);
});

it("recovers persisted evidence in a fresh Node process without in-memory ownership maps", async () => {
  const f = await fixture();
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m = await import(process.argv[1]); await m.recoverNativeRetired(process.argv[2], new AbortController().signal);",
      new URL("./native-recovery.ts", import.meta.url).href,
      f.home,
    ],
    { env: { PATH: dirname(process.execPath), HOME: f.top }, timeout: 10_000, maxBuffer: 4096 },
  );
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  await assertNativeRetired(f.home, signal());
});

it("does not acknowledge a parent replacement during cleanup", async () => {
  const f = await fixture(),
    original = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    await original(...args);
    if (String(args[0]) === f.resources.work.path) {
      renameSync(f.roots.workRoot, join(f.top, "saved-work"));
      mkdirSync(f.roots.workRoot, { mode: 0o700 });
      writeFileSync(join(f.roots.workRoot, "foreign"), "keep");
    }
  });
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  expect(existsSync(f.path)).toBe(true);
  expect(readFileSync(join(f.roots.workRoot, "foreign"), "utf8")).toBe("keep");
  expect(existsSync(f.resources.profile.path)).toBe(true);
});

it("refuses a receipt substituted between lstat and open, closing the file", async () => {
  const f = await fixture(),
    original = fs.open,
    closed = vi.fn();
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === f.path) {
      renameSync(f.path, join(f.top, "saved-receipt"));
      writeFileSync(f.path, JSON.stringify(f.receipt.record), { mode: 0o600 });
    }
    const fd = await original(...args),
      close = fd.close.bind(fd);
    fd.close = async () => {
      await close();
      closed();
    };
    return fd;
  });
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  expect(closed).toHaveBeenCalledOnce();
  intact(f);
});

it("keeps the receipt after an unlink failure and retries absent resources", async () => {
  const f = await fixture();
  const spy = vi.spyOn(fs, "unlink").mockRejectedValue(new Error("interrupted"));
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  expect(existsSync(f.path)).toBe(true);
  for (const resource of Object.values(f.resources)) expect(existsSync(resource.path)).toBe(false);
  spy.mockRestore();
  await recoverNativeRetired(f.home, signal());
  await assertNativeRetired(f.home, signal());
});

it("refuses an overfull inventory before any deletion and closes its iterator", async () => {
  const f = await fixture(),
    original = fs.opendir,
    closed = vi.fn();
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const dir = await original(...args),
      close = dir.close.bind(dir);
    if (String(args[0]) === f.roots.profilesRoot) {
      const entry = await dir.read();
      if (!entry) throw new Error("fixture");
      dir.read = (() => Promise.resolve(entry)) as typeof dir.read;
    }
    dir.close = (() =>
      close().then(() => {
        closed();
      })) as typeof dir.close;
    return dir;
  });
  const remove = vi.spyOn(fs, "rm");
  await expect(recoverNativeRetired(f.home, signal())).rejects.toThrow();
  expect(remove).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledOnce();
  intact(f);
});
