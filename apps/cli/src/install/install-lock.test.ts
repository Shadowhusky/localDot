import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  type InstallLockLifetime,
  keydLockAcquirer,
  keydServiceLeaseAcquirer,
  ServiceLeaseBusy,
  withInstallLock,
  withServiceLease,
} from "./install-lock.ts";
import { buildTestKeyd } from "./testing/keyd-fixture.ts";

// Local test build, not a Developer ID release/signature verification.
let binary: Awaited<ReturnType<typeof buildTestKeyd>> | undefined;
let helper: ReturnType<typeof keydLockAcquirer>;
beforeAll(async () => {
  binary = await buildTestKeyd();
  helper = keydLockAcquirer(binary.path);
}, 65_000);
afterAll(() => binary?.dispose());
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-installer-lock-")));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
it("retains the real kernel lock after the keyd helper exits and releases without unlinking", async () => {
  const root = await fixture();
  let firstInode: number | undefined;
  const result = await withInstallLock(root, signal(), helper, async () => {
    firstInode = (await stat(join(root, "install.lock"))).ino;
    await expect(
      withInstallLock(root, signal(), helper, async () => "must not run"),
    ).rejects.toThrow("Another installation operation");
    expect(await readdir(root)).toEqual(["install.lock"]);
    return "completed";
  });
  expect(result).toBe("completed");
  await withInstallLock(root, signal(), helper, async () => {
    expect((await stat(join(root, "install.lock"))).ino).toBe(firstInode);
  });
  expect(await readFile(join(root, "install.lock"), "utf8")).toBe("");
});
it("holds ownership during cancellation cleanup and releases after a failed operation drains", async () => {
  const root = await fixture(),
    controller = new AbortController();
  await expect(
    withInstallLock(root, controller.signal, helper, async () => {
      controller.abort();
      await expect(withInstallLock(root, signal(), helper, async () => undefined)).rejects.toThrow(
        "Another installation operation",
      );
      throw new Error("operation failed");
    }),
  ).rejects.toThrow("operation failed");
  await expect(withInstallLock(root, signal(), helper, async () => true)).resolves.toBe(true);
});
it.each([false, true])(
  "expires the inherited descriptor capability after callback exit (failure=%s)",
  async (failure) => {
    const root = await fixture();
    let captured: InstallLockLifetime | undefined;
    const run = withInstallLock(root, signal(), helper, async (lifetime) => {
      captured = lifetime;
      expect(lifetime.directory).toBe(root);
      expect(lifetime.inheritDescriptor()).toBeGreaterThanOrEqual(0);
      expect(Object.isFrozen(lifetime)).toBe(true);
      if (failure) throw new Error("callback failed");
    });
    if (failure) await expect(run).rejects.toThrow("callback failed");
    else await run;
    expect(() => captured?.inheritDescriptor()).toThrow("unsafe");
    await withInstallLock(root, signal(), helper, async () => {
      expect(() => captured?.inheritDescriptor()).toThrow("unsafe");
    });
  },
);
it.each(["symlink", "hardlink", "mode", "directory", "content", "parent-mode"])(
  "refuses a %s lock before dispatching work",
  async (kind) => {
    const root = await fixture(),
      file = join(root, "install.lock");
    if (kind === "symlink" || kind === "hardlink") {
      const target = join(root, "target");
      await writeFile(target, "", { mode: 0o600 });
      await (kind === "symlink" ? symlink : link)(target, file);
    } else if (kind === "directory") await mkdir(file);
    else if (kind === "parent-mode") await chmod(root, 0o755);
    else
      await writeFile(file, kind === "content" ? "foreign" : "", {
        mode: kind === "mode" ? 0o644 : 0o600,
      });
    let ran = false;
    await expect(
      withInstallLock(root, signal(), helper, async () => {
        ran = true;
      }),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  },
);
it("does not create a lock after pre-cancellation", async () => {
  const root = await fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(
    withInstallLock(root, controller.signal, helper, async () => undefined),
  ).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});
it("does not dispatch work if helper acquisition fails and leaves the inode reusable", async () => {
  const root = await fixture();
  let ran = false;
  const absent = keydLockAcquirer(join(root, "missing-keyd"));
  await expect(
    withInstallLock(root, signal(), absent, async () => {
      ran = true;
    }),
  ).rejects.toThrow("unsafe");
  expect(ran).toBe(false);
  await expect(withInstallLock(root, signal(), helper, async () => true)).resolves.toBe(true);
});

it("keeps service leases separate from the installer mutex and each other", async () => {
  const root = await fixture(),
    home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const owner = { v: 1, id: "a".repeat(32), state: root, home, uid: process.getuid?.() ?? -1 };
  await writeFile(join(root, "service-owner.json"), JSON.stringify(owner), { mode: 0o600 });
  const daemon = { state: root, home, ownerId: owner.id, role: "daemon" as const };
  const keyd = { ...daemon, role: "keyd" as const };
  if (!binary) throw new Error("test helper missing");
  const daemonAcquire = keydServiceLeaseAcquirer(binary.path, daemon),
    keydAcquire = keydServiceLeaseAcquirer(binary.path, keyd);
  await withInstallLock(root, signal(), helper, async () => {
    await withServiceLease(daemon, signal(), daemonAcquire, async () => {
      await expect(
        withServiceLease(daemon, signal(), daemonAcquire, async () => undefined),
      ).rejects.toBeInstanceOf(ServiceLeaseBusy);
      await expect(
        withServiceLease(keyd, signal(), keydAcquire, async () => "separate"),
      ).resolves.toBe("separate");
    });
    await expect(
      withServiceLease(daemon, signal(), daemonAcquire, async () => "retired"),
    ).resolves.toBe("retired");
  });
  expect(await readFile(join(root, `service-${owner.id}-daemon.lock`), "utf8")).toBe("");
});

it("refuses a service lease for an unowned home without starting the callback", async () => {
  const root = await fixture(),
    home = join(root, "home"),
    other = join(root, "other");
  await mkdir(home, { mode: 0o700 });
  await mkdir(other, { mode: 0o700 });
  const owner = { v: 1, id: "a".repeat(32), state: root, home, uid: process.getuid?.() ?? -1 };
  await writeFile(join(root, "service-owner.json"), JSON.stringify(owner), { mode: 0o600 });
  const scope = { state: root, home: other, ownerId: owner.id, role: "daemon" as const };
  if (!binary) throw new Error("test helper missing");
  let ran = false;
  await expect(
    withServiceLease(scope, signal(), keydServiceLeaseAcquirer(binary.path, scope), async () => {
      ran = true;
    }),
  ).rejects.toThrow("unsafe");
  expect(ran).toBe(false);
});
