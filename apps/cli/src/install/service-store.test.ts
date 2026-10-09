import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import {
  type InstallServiceSettings,
  prepareInstalledServices,
  reopenInstalledServices,
  runInstalledServiceCommand,
} from "./service-store.ts";

const hooks = vi.hoisted(() => ({
  read: vi.fn(),
  rename: vi.fn(),
  sync: vi.fn(),
  command: vi.fn(),
}));
vi.mock("./service-command.ts", () => ({ runServiceCommand: hooks.command }));
vi.mock("./promote-release.ts", () => ({ readInstalledRelease: hooks.read }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fd = await actual.open(...args),
        sync = fd.sync.bind(fd);
      fd.sync = async () => {
        await hooks.sync(String(args[0]));
        return sync();
      };
      return fd;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await hooks.rename(...args);
      return actual.rename(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  hooks.read.mockReset();
  hooks.rename.mockReset();
  hooks.sync.mockReset();
  hooks.command.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-service-store-")));
  roots.push(root);
  const state = join(root, "install"),
    home = join(root, "home");
  await mkdir(state, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const settings: InstallServiceSettings = {
    state,
    home,
    userHome: root,
    node: await realpath(process.execPath),
    dockerSocket: join(root, "fake.sock"),
    uid: process.getuid?.() ?? -1,
    port: 4750,
  };
  const manifest = ReleaseManifest.parse(sampleManifest());
  manifest.files["dist/daemon.mjs"] = "c".repeat(64);
  const identity = {
    version: manifest.version,
    packageSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  // This seam isolates filesystem publication; the actual installed-release verifier has its own
  // inventory, signature and anchor tests. No service, vault, Docker or registry is contacted here.
  hooks.read.mockResolvedValue({ manifest });
  return { root, settings, manifest, identity };
}

it("publishes complete private definitions, reopens from authority and preserves existing logs", async () => {
  const f = await fixture(),
    defs = await prepareInstalledServices(f.settings, f.identity, signal());
  const record = JSON.parse(await readFile(join(f.settings.state, "service-owner.json"), "utf8"));
  expect(record).toMatchObject({
    v: 1,
    state: f.settings.state,
    home: f.settings.home,
    uid: f.settings.uid,
  });
  expect(record.id).toMatch(/^[a-f0-9]{32}$/);
  expect(defs.daemon.ownerId).toBe(record.id);
  expect((await lstat(join(f.settings.state, "service-owner.json"))).mode & 0o777).toBe(0o600);
  expect((await readdir(dirname(defs.daemon.file))).sort()).toEqual(["daemon.plist", "keyd.plist"]);
  for (const role of ["daemon", "keyd"] as const) {
    expect(await readFile(defs[role].file, "utf8")).toBe(defs[role].contents);
    expect((await lstat(defs[role].file)).mode & 0o777).toBe(0o600);
  }
  const log = join(f.settings.state, "logs/daemon.log");
  await writeFile(log, "retain log");
  const before = await lstat(defs.daemon.file);
  expect(await prepareInstalledServices(f.settings, f.identity, signal())).toEqual(defs);
  expect((await lstat(defs.daemon.file)).ino).toBe(before.ino);
  expect(await readFile(log, "utf8")).toBe("retain log");
  expect(await reopenInstalledServices(f.settings, f.identity, signal())).toEqual(defs);
  expect(hooks.read).toHaveBeenCalledTimes(3);
});

it("changing runtime configuration creates another immutable directory with the same owner labels", async () => {
  const f = await fixture(),
    first = await prepareInstalledServices(f.settings, f.identity, signal());
  const settings = { ...f.settings, port: 4883 };
  const second = await prepareInstalledServices(settings, f.identity, signal());
  expect(second.daemon.target).toBe(first.daemon.target);
  expect(second.daemon.file).not.toBe(first.daemon.file);
  expect(await readFile(first.daemon.file, "utf8")).toBe(first.daemon.contents);
  expect(await reopenInstalledServices(f.settings, f.identity, signal())).toEqual(first);
  expect(await reopenInstalledServices(settings, f.identity, signal())).toEqual(second);
});

it.each(["bytes", "extra", "mode", "link", "hardlink", "missing"])(
  "refuses %s corruption without repairing an existing configuration",
  async (kind) => {
    const f = await fixture(),
      defs = await prepareInstalledServices(f.settings, f.identity, signal());
    const file = defs.daemon.file;
    if (kind === "bytes") await writeFile(file, "foreign");
    if (kind === "extra") await writeFile(join(dirname(file), "foreign.txt"), "retain");
    if (kind === "mode") await chmod(file, 0o644);
    if (kind === "link") {
      await unlink(file);
      await symlink(defs.keyd.file, file);
    }
    if (kind === "hardlink") await link(file, join(f.root, "retain.plist"));
    if (kind === "missing") await unlink(file);
    await expect(reopenInstalledServices(f.settings, f.identity, signal())).rejects.toThrow();
    await expect(prepareInstalledServices(f.settings, f.identity, signal())).rejects.toThrow();
    if (kind === "bytes") expect(await readFile(file, "utf8")).toBe("foreign");
    if (kind === "missing") await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "link") expect((await lstat(file)).isSymbolicLink()).toBe(true);
  },
);

it.each(["deleted", "foreign-home", "foreign-uid", "foreign-state", "mode", "corrupt"])(
  "refuses %s ownership evidence without replacing it",
  async (kind) => {
    const f = await fixture();
    await prepareInstalledServices(f.settings, f.identity, signal());
    const file = join(f.settings.state, "service-owner.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    if (kind === "deleted") await unlink(file);
    if (kind === "foreign-home") record.home += "-other";
    if (kind === "foreign-state") record.state += "-other";
    if (kind === "foreign-uid") record.uid++;
    if (kind.startsWith("foreign")) await writeFile(file, JSON.stringify(record));
    if (kind === "mode") await chmod(file, 0o644);
    if (kind === "corrupt") await writeFile(file, "{broken");
    await expect(prepareInstalledServices(f.settings, f.identity, signal())).rejects.toThrow();
    if (kind === "deleted") await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("read-only reopening never creates missing ownership or definitions", async () => {
  const f = await fixture();
  await expect(reopenInstalledServices(f.settings, f.identity, signal())).rejects.toThrow();
  expect(await readdir(f.settings.state)).toEqual([]);
});
it("untrusted releases and cancellation after verification produce no installation writes", async () => {
  const f = await fixture();
  hooks.read.mockRejectedValueOnce(new Error("not authenticated"));
  await expect(prepareInstalledServices(f.settings, f.identity, signal())).rejects.toThrow(
    "not authenticated",
  );
  expect(await readdir(f.settings.state)).toEqual([]);
  const controller = new AbortController();
  hooks.read.mockImplementation(async () => {
    controller.abort(new Error("cancel"));
    return { manifest: f.manifest };
  });
  await expect(prepareInstalledServices(f.settings, f.identity, controller.signal)).rejects.toThrow(
    "cancel",
  );
  expect(await readdir(f.settings.state)).toEqual([]);
});
it("refuses a different Node executable without running it", async () => {
  const f = await fixture(),
    node = join(f.root, "foreign-node");
  await writeFile(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await expect(
    prepareInstalledServices({ ...f.settings, node }, f.identity, signal()),
  ).rejects.toThrow();
  await expect(lstat(join(f.settings.state, "services"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses unsafe runtime log destinations without truncating or following them", async () => {
  const f = await fixture(),
    logs = join(f.settings.state, "logs"),
    foreign = join(f.root, "foreign");
  await mkdir(logs, { mode: 0o700 });
  await writeFile(foreign, "keep");
  await symlink(foreign, join(logs, "daemon.log"));
  await expect(prepareInstalledServices(f.settings, f.identity, signal())).rejects.toThrow();
  expect(await readFile(foreign, "utf8")).toBe("keep");
});
it("failed publication removes only its scratch directory and can retry from the same owner", async () => {
  const f = await fixture();
  hooks.rename.mockImplementation(async (_from: string, to: string) => {
    if (dirname(to).includes("/services/")) throw new Error("disk failure");
  });
  await expect(prepareInstalledServices(f.settings, f.identity, signal())).rejects.toThrow(
    "disk failure",
  );
  const owner = JSON.parse(await readFile(join(f.settings.state, "service-owner.json"), "utf8"));
  expect(await readdir(join(f.settings.state, "services", owner.id))).toEqual([]);
  hooks.rename.mockReset();
  const defs = await prepareInstalledServices(f.settings, f.identity, signal());
  expect(defs.daemon.ownerId).toBe(owner.id);
});
it("cancellation before publishing cannot leave a partially eligible definition", async () => {
  const f = await fixture(),
    controller = new AbortController();
  hooks.rename.mockImplementation(async (_from: string, to: string) => {
    if (dirname(to).includes("/services/")) {
      controller.abort(new Error("cancel"));
      throw controller.signal.reason;
    }
  });
  await expect(prepareInstalledServices(f.settings, f.identity, controller.signal)).rejects.toThrow(
    "cancel",
  );
  hooks.rename.mockReset();
  const defs = await prepareInstalledServices(f.settings, f.identity, signal());
  expect((await readdir(dirname(defs.daemon.file))).sort()).toEqual(["daemon.plist", "keyd.plist"]);
});

it("recovers a complete publication after failed parent sync and requires a successful resync", async () => {
  const f = await fixture();
  let publishedParent = "";
  hooks.rename.mockImplementation(async (_from: string, to: string) => {
    if (dirname(to).includes("/services/")) publishedParent = dirname(to);
  });
  hooks.sync.mockImplementation(async (path: string) => {
    if (path === publishedParent) throw new Error("parent sync");
  });
  await expect(prepareInstalledServices(f.settings, f.identity, signal())).rejects.toThrow(
    "parent sync",
  );
  const names = await readdir(publishedParent);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^[a-f0-9]{64}$/);
  await expect(prepareInstalledServices(f.settings, f.identity, signal())).rejects.toThrow(
    "parent sync",
  );
  hooks.sync.mockReset();
  const defs = await prepareInstalledServices(f.settings, f.identity, signal());
  expect(dirname(defs.daemon.file)).toBe(join(publishedParent, names[0] as string));
  expect(hooks.sync).toHaveBeenCalledWith(publishedParent);
});

it("authorizes only reverified owned definitions before invoking the fixed service transport", async () => {
  const f = await fixture(),
    defs = await prepareInstalledServices(f.settings, f.identity, signal());
  hooks.command.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  const requestSignal = signal();
  await expect(
    runInstalledServiceCommand(f.settings, f.identity, "daemon", "bootstrap", requestSignal),
  ).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
  expect(hooks.command).toHaveBeenCalledWith(defs.daemon, "bootstrap", requestSignal);
  hooks.command.mockClear();
  await writeFile(defs.keyd.file, "foreign");
  await expect(
    runInstalledServiceCommand(f.settings, f.identity, "daemon", "bootout", signal()),
  ).rejects.toThrow();
  expect(hooks.command).not.toHaveBeenCalled();
});

it("preserves a replaced temporary directory when publication fails", async () => {
  const f = await fixture();
  let replacement = "";
  hooks.rename.mockImplementation(async (from: string, to: string) => {
    if (!dirname(to).includes("/services/")) return;
    replacement = from;
    await rm(from, { recursive: true });
    await mkdir(from, { mode: 0o700 });
    await writeFile(join(from, "foreign"), "retain");
    throw new Error("publication failed");
  });
  await expect(prepareInstalledServices(f.settings, f.identity, signal())).rejects.toBeInstanceOf(
    AggregateError,
  );
  expect(await readFile(join(replacement, "foreign"), "utf8")).toBe("retain");
});
