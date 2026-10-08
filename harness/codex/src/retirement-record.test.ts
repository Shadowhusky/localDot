import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  NativeRetirementRecord,
  persistNativeRetirement,
  prepareNativeRetirement,
} from "./retirement-record.ts";
import { createOwnedCodexDirectory, prepareOwnedCodexRoots } from "./roots.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
const owned: string[] = [];
function fixture() {
  const top = mkdtempSync("/tmp/localdot-native-retirement-record-");
  owned.push(top);
  const user = join(top, "user");
  mkdirSync(user, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(top, "app"), user);
  const resources = {
    profile: createOwnedCodexDirectory(roots, "profilesRoot"),
    work: createOwnedCodexDirectory(roots, "workRoot"),
    bridge: createOwnedCodexDirectory(roots, "runRoot"),
  };
  for (const directory of Object.values(resources))
    writeFileSync(join(directory.path, "keep"), "retained fixture", { mode: 0o600 });
  return { top, roots, resources };
}
function intact(f: ReturnType<typeof fixture>) {
  for (const directory of Object.values(f.resources))
    expect(readFileSync(join(directory.path, "keep"), "utf8")).toBe("retained fixture");
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("captures before spawn without writing and persists after an independently closed bridge", async () => {
  const f = fixture(),
    prepared = await prepareNativeRetirement(f.roots, f.resources);
  expect(readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retir"))).toEqual([]);
  const bridge = lstatSync(f.resources.bridge.path, { bigint: true });
  rmSync(f.resources.bridge.path, { recursive: true });
  const receipt = await prepared.persist(Promise.resolve());
  expect(receipt.record.bridge?.identity.ino).toBe(String(bridge.ino));
  expect(existsSync(join(f.roots.profilesRoot, receipt.name))).toBe(true);
});

it("refuses a bridge replacement after capture even though native retirement succeeded", async () => {
  const f = fixture(),
    prepared = await prepareNativeRetirement(f.roots, f.resources);
  renameSync(f.resources.bridge.path, `${f.resources.bridge.path}-old`);
  mkdirSync(f.resources.bridge.path, { mode: 0o700 });
  await expect(prepared.persist(Promise.resolve())).rejects.toThrow();
  expect(readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retir"))).toEqual([]);
});

it("shares one publication promise and writes nothing while retirement is pending", async () => {
  const f = fixture(),
    prepared = await prepareNativeRetirement(f.roots, f.resources);
  let retire!: () => void;
  const closed = new Promise<void>((resolve) => {
    retire = resolve;
  });
  const first = prepared.persist(closed),
    second = prepared.persist(closed);
  expect(first).toBe(second);
  await Promise.resolve();
  expect(readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retir"))).toEqual([]);
  retire();
  const receipt = await first;
  expect(readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retir"))).toEqual([
    receipt.name,
  ]);
});

it("never publishes prepared evidence after failed native retirement", async () => {
  const f = fixture(),
    prepared = await prepareNativeRetirement(f.roots, f.resources);
  await expect(prepared.persist(Promise.reject(new Error("unconfirmed")))).rejects.toThrow();
  expect(readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retir"))).toEqual([]);
  intact(f);
});

it.each(["profile", "work", "bridge"] as const)(
  "retains the receipt while %s cleanup remains",
  async (keep) => {
    const f = fixture(),
      receipt = await (await prepareNativeRetirement(f.roots, f.resources)).persist(
        Promise.resolve(),
      );
    for (const [key, value] of Object.entries(f.resources))
      if (key !== keep) rmSync(value.path, { recursive: true });
    await expect(receipt.finish()).rejects.toThrow();
    expect(existsSync(join(f.roots.profilesRoot, receipt.name))).toBe(true);
    expect(readFileSync(join(f.resources[keep].path, "keep"), "utf8")).toBe("retained fixture");
  },
);

it("persists all resource removals before clearing a normal receipt, then persists the clear", async () => {
  const f = fixture(),
    receipt = await (await prepareNativeRetirement(f.roots, f.resources)).persist(
      Promise.resolve(),
    );
  for (const value of Object.values(f.resources)) rmSync(value.path, { recursive: true });
  const original = fs.open,
    synced: string[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await original(...args),
      sync = fd.sync.bind(fd);
    fd.sync = async () => {
      await sync();
      synced.push(String(args[0]));
    };
    return fd;
  });
  await receipt.finish();
  expect(synced).toEqual([
    f.roots.workRoot,
    f.roots.runRoot,
    f.roots.profilesRoot,
    f.roots.root,
    join(f.roots.root, ".."),
    f.roots.profilesRoot,
    f.roots.root,
    join(f.roots.root, ".."),
  ]);
  expect(readdirSync(f.roots.profilesRoot)).toEqual([]);
  await receipt.finish();
  expect(synced).toHaveLength(8);
});

it("retains the receipt if a resource namespace cannot be synced before clearing", async () => {
  const f = fixture(),
    receipt = await (await prepareNativeRetirement(f.roots, f.resources)).persist(
      Promise.resolve(),
    );
  for (const value of Object.values(f.resources)) rmSync(value.path, { recursive: true });
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await original(...args);
    if (String(args[0]) === f.roots.workRoot)
      fd.sync = async () => {
        throw new Error("sync");
      };
    return fd;
  });
  await expect(receipt.finish()).rejects.toThrow();
  expect(existsSync(join(f.roots.profilesRoot, receipt.name))).toBe(true);
});

it("does not let a caller's returned record mutation change cleanup authority", async () => {
  const f = fixture(),
    receipt = await (await prepareNativeRetirement(f.roots, f.resources)).persist(
      Promise.resolve(),
    );
  receipt.record.parents.work.ino = "0";
  receipt.record.work.name = ".owned-ABC123";
  for (const value of Object.values(f.resources)) rmSync(value.path, { recursive: true });
  await receipt.finish();
  expect(readdirSync(f.roots.profilesRoot)).toEqual([]);
});

it("will not clear a substituted receipt", async () => {
  const f = fixture(),
    receipt = await (await prepareNativeRetirement(f.roots, f.resources)).persist(
      Promise.resolve(),
    );
  for (const value of Object.values(f.resources)) rmSync(value.path, { recursive: true });
  const path = join(f.roots.profilesRoot, receipt.name);
  renameSync(path, join(f.top, "saved"));
  writeFileSync(path, JSON.stringify(receipt.record), { mode: 0o600 });
  await expect(receipt.finish()).rejects.toThrow();
  expect(existsSync(path)).toBe(true);
});

it("writes nothing until retirement settles, then persists a private receipt outside all resources", async () => {
  const f = fixture();
  let retire!: () => void;
  const closed = new Promise<void>((resolve) => {
    retire = resolve;
  });
  const before = readdirSync(f.roots.profilesRoot);
  const pending = persistNativeRetirement(f.roots, f.resources, closed);
  await Promise.resolve();
  expect(readdirSync(f.roots.profilesRoot)).toEqual(before);
  retire();
  const receipt = await pending;
  const path = join(f.roots.profilesRoot, receipt.name);
  expect(receipt.name).toBe(`.retired-${receipt.record.nonce}.json`);
  expect(NativeRetirementRecord.parse(JSON.parse(readFileSync(path, "utf8")))).toEqual(
    receipt.record,
  );
  const info = lstatSync(path);
  expect(info.mode & 0o7777).toBe(0o600);
  expect(info.nlink).toBe(1);
  expect(info.size).toBeLessThan(8192);
  expect(readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retiring-"))).toEqual(
    [],
  );
  for (const key of ["profile", "work", "bridge"] as const) {
    const directory = lstatSync(f.resources[key].path, { bigint: true });
    expect(receipt.record[key]?.identity).toEqual({
      dev: String(directory.dev),
      ino: String(directory.ino),
      birthtimeNs: String(directory.birthtimeNs),
    });
  }
  intact(f);
});

it("records account launches without a bridge", async () => {
  const f = fixture();
  const { record } = await persistNativeRetirement(
    f.roots,
    {
      profile: f.resources.profile,
      work: f.resources.work,
    },
    Promise.resolve(),
  );
  expect(record.bridge).toBeNull();
  intact(f);
});

it("never writes a receipt for failed retirement and hides underlying errors", async () => {
  const f = fixture();
  const before = readdirSync(f.roots.profilesRoot);
  await expect(
    persistNativeRetirement(f.roots, f.resources, Promise.reject(new Error("private-detail"))),
  ).rejects.toThrow(/^Native retirement evidence could not be persisted\.$/);
  expect(readdirSync(f.roots.profilesRoot)).toEqual(before);
  intact(f);
});

it("captures resources before awaiting retirement instead of following caller mutation", async () => {
  const f = fixture(),
    replacement = createOwnedCodexDirectory(f.roots, "workRoot");
  let retire!: () => void;
  const closed = new Promise<void>((resolve) => {
    retire = resolve;
  });
  const pending = persistNativeRetirement(f.roots, f.resources, closed);
  const original = f.resources.work;
  f.resources.work = replacement;
  retire();
  expect((await pending).record.work.name).toBe(original.path.split("/").at(-1));
});

it.each(["profile", "work", "bridge"] as const)("rejects forged %s ownership", async (key) => {
  const f = fixture();
  await expect(
    persistNativeRetirement(
      f.roots,
      {
        ...f.resources,
        [key]: { ...f.resources[key] },
      },
      Promise.resolve(),
    ),
  ).rejects.toThrow();
  expect(readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retir"))).toEqual([]);
  intact(f);
});

it("rejects a real capability from the wrong area", async () => {
  const f = fixture();
  await expect(
    persistNativeRetirement(
      f.roots,
      {
        ...f.resources,
        work: f.resources.profile,
      },
      Promise.resolve(),
    ),
  ).rejects.toThrow();
  intact(f);
});

it("rechecks opaque ownership after asynchronous identity reads", async () => {
  const f = fixture(),
    path = f.resources.work.path,
    original = fs.lstat;
  let changed = false;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (!changed && String(args[0]) === path) {
      changed = true;
      renameSync(path, `${path}-old`);
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "keep"), "replacement");
    }
    return original(...args);
  });
  await expect(persistNativeRetirement(f.roots, f.resources, Promise.resolve())).rejects.toThrow();
  expect(changed).toBe(true);
  expect(readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retir"))).toEqual([]);
  expect(readFileSync(join(path, "keep"), "utf8")).toBe("replacement");
  expect(readFileSync(join(`${path}-old`, "keep"), "utf8")).toBe("retained fixture");
});

it.each(["replaced", "symlink", "public"] as const)(
  "rejects %s resources without deleting them",
  async (kind) => {
    const f = fixture(),
      path = f.resources.work.path;
    if (kind === "public") chmodSync(path, 0o755);
    else {
      renameSync(path, `${path}-old`);
      if (kind === "symlink") symlinkSync(`${path}-old`, path);
      else {
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "keep"), "replacement");
      }
    }
    await expect(
      persistNativeRetirement(f.roots, f.resources, Promise.resolve()),
    ).rejects.toThrow();
    expect(readFileSync(join(path, "keep"), "utf8")).toBe(
      kind === "replaced" ? "replacement" : "retained fixture",
    );
  },
);

it("flushes the complete file before publication and the namespace afterward", async () => {
  const f = fixture(),
    original = fs.open,
    events: string[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const fd = await original(...args),
      sync = fd.sync.bind(fd),
      close = fd.close.bind(fd);
    const path = String(args[0]);
    fd.sync = async () => {
      events.push(`sync:${path}`);
      if (path.endsWith(".tmp")) {
        expect(
          NativeRetirementRecord.safeParse(JSON.parse(readFileSync(path, "utf8"))).success,
        ).toBe(true);
        expect(readdirSync(f.roots.profilesRoot).some((name) => name.startsWith(".retired-"))).toBe(
          false,
        );
      } else
        expect(readdirSync(f.roots.profilesRoot).some((name) => name.startsWith(".retired-"))).toBe(
          true,
        );
      await sync();
    };
    fd.close = async () => {
      await close();
      events.push(`close:${path}`);
    };
    return fd;
  });
  const receipt = await persistNativeRetirement(f.roots, f.resources, Promise.resolve());
  const temporary = join(f.roots.profilesRoot, `.retiring-${receipt.record.nonce}.tmp`);
  expect(events).toEqual(
    [
      temporary,
      f.resources.profile.path,
      f.roots.profilesRoot,
      f.roots.root,
      join(f.roots.root, ".."),
    ].flatMap((path) => [`sync:${path}`, `close:${path}`]),
  );
});

it.each(["write", "file-sync", "namespace-sync", "rename"] as const)(
  "preserves resources when %s fails",
  async (operation) => {
    const f = fixture(),
      original = fs.open,
      closed: string[] = [],
      opened: string[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const fd = await original(...args),
        sync = fd.sync.bind(fd),
        close = fd.close.bind(fd);
      const path = String(args[0]);
      opened.push(path);
      if (operation === "write" && path.endsWith(".tmp"))
        fd.writeFile = async () => {
          throw new Error("private-detail");
        };
      fd.sync = async () => {
        if (
          (operation === "file-sync" && path.endsWith(".tmp")) ||
          (operation === "namespace-sync" && path === f.roots.profilesRoot)
        )
          throw new Error("private-detail");
        await sync();
      };
      fd.close = async () => {
        await close();
        closed.push(path);
      };
      return fd;
    });
    if (operation === "rename")
      vi.spyOn(fs, "rename").mockRejectedValue(new Error("private-detail"));
    await expect(persistNativeRetirement(f.roots, f.resources, Promise.resolve())).rejects.toThrow(
      /^Native retirement evidence could not be persisted\.$/,
    );
    expect(closed).toEqual(opened);
    const leftovers = readdirSync(f.roots.profilesRoot).filter((name) => name.startsWith(".retir"));
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]?.endsWith(".json")).toBe(operation === "namespace-sync");
    intact(f);
  },
);

it.each(["resource", "parent"] as const)(
  "refuses a %s replacement during publication",
  async (kind) => {
    const f = fixture(),
      original = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await original(...args);
      const path = kind === "resource" ? f.resources.work.path : f.roots.workRoot;
      renameSync(path, `${path}-old`);
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "replacement"), "keep");
    });
    await expect(
      persistNativeRetirement(f.roots, f.resources, Promise.resolve()),
    ).rejects.toThrow();
    const path = kind === "resource" ? f.resources.work.path : f.roots.workRoot;
    expect(readFileSync(join(path, "replacement"), "utf8")).toBe("keep");
    expect(existsSync(f.resources.profile.path)).toBe(true);
  },
);

it("rejects unbounded and path-bearing record fields", async () => {
  const f = fixture();
  const { record } = await persistNativeRetirement(f.roots, f.resources, Promise.resolve());
  for (const value of [
    { ...record, v: 2 },
    { ...record, phase: "running" },
    { ...record, pid: process.pid },
    { ...record, nonce: "a".repeat(33) },
    { ...record, work: { ...record.work, name: "../work" } },
    { ...record, bridge: { ...record.bridge, name: "/tmp/anything" } },
    {
      ...record,
      profile: { ...record.profile, identity: { ...record.profile.identity, ino: "-1" } },
    },
    {
      ...record,
      profile: { ...record.profile, identity: { ...record.profile.identity, dev: "1".repeat(26) } },
    },
  ])
    expect(NativeRetirementRecord.safeParse(value).success).toBe(false);
});
