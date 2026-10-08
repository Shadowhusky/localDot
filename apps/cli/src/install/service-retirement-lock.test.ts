import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { persistNativeRetirement } from "../../../../harness/codex/src/retirement-record.ts";
import {
  createOwnedCodexDirectory,
  prepareOwnedCodexRoots,
} from "../../../../harness/codex/src/roots.ts";
import type {
  ServiceConfiguration,
  ServiceJournal,
} from "../../../../packages/protocol/src/install-services.ts";
import {
  keydLockAcquirer,
  keydServiceLeaseAcquirer,
  ServiceLeaseBusy,
  withInstallLock,
  withServiceLease,
} from "./install-lock.ts";
import { assertNativeRetired } from "./native-retirement.ts";
import { serviceConfigurationId, serviceLocation } from "./service-definition.ts";
import { serviceJournalStore, verifyServiceOwner } from "./service-journal.ts";
import { stopServiceLifecycle } from "./service-lifecycle.ts";
import { installedServiceRetirement } from "./service-retirement.ts";
import { buildTestKeyd } from "./testing/keyd-fixture.ts";

// Real private records, atomic journal transitions and kernel locks; launchd/Docker effects are
// explicit fixture seams. This is not a signed-helper or live service acceptance test.
const mock = vi.hoisted(() => ({ observe: vi.fn(), command: vi.fn(), contain: vi.fn() }));
vi.mock("./service-observation.ts", () => ({ observeServiceJob: mock.observe }));
vi.mock("./service-command.ts", () => ({ runServiceCommand: mock.command }));
vi.mock("./container-containment.ts", () => ({ containInstalledContainers: mock.contain }));
let helper: Awaited<ReturnType<typeof buildTestKeyd>>;
beforeAll(async () => {
  helper = await buildTestKeyd();
}, 65_000);
afterAll(() => helper?.dispose());
const roots: string[] = [];
afterEach(async () => {
  for (const fn of Object.values(mock)) fn.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("persists stopped only after both real leases and container checks complete despite lost replies", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-retirement-lock-")));
  roots.push(root);
  await chmod(root, 0o700);
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const settings = {
    state: root,
    home,
    userHome: root,
    node: await realpath(process.execPath),
    dockerSocket: join(root, "docker.sock"),
    uid: process.getuid?.() ?? -1,
    port: 4750,
    ownerId: "a".repeat(32),
  };
  const release = {
    version: "1.2.3",
    packageSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  };
  const config: ServiceConfiguration = {
    settings,
    release,
    configuration: serviceConfigurationId(settings, release),
  };
  const native = prepareOwnedCodexRoots(home, root),
    resources = {
      profile: createOwnedCodexDirectory(native, "profilesRoot"),
      work: createOwnedCodexDirectory(native, "workRoot"),
      bridge: createOwnedCodexDirectory(native, "runRoot"),
    };
  await persistNativeRetirement(native, resources, Promise.resolve());
  // Simulate a crash after native retirement and work removal but before bridge/profile cleanup.
  await rm(resources.work.path, { recursive: true });
  await writeFile(
    join(root, "service-owner.json"),
    JSON.stringify({ v: 1, id: settings.ownerId, state: root, home, uid: settings.uid }),
    { mode: 0o600 },
  );
  const records = serviceJournalStore(settings),
    signal = new AbortController().signal;
  const journal: ServiceJournal = {
    v: 1,
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    configuration: config,
    previous: null,
    phase: "running",
    jobs: { daemon: { phase: "running", pid: 11 }, keyd: { phase: "running", pid: 12 } },
  };
  const locations = serviceLocation(
    root,
    home,
    settings.uid,
    settings.ownerId,
    config.configuration,
  );
  const jobs = new Map([
      [locations.daemon.label, 11],
      [locations.keyd.label, 12],
      ["foreign", 13],
    ]),
    effects: string[] = [];
  mock.observe.mockImplementation(async (target) =>
    jobs.has(target.label) ? { pid: jobs.get(target.label) } : null,
  );
  mock.command.mockImplementation(async (target, operation) => {
    expect(operation).toBe("bootout");
    expect((await records.read())?.phase).toBe("stopping");
    jobs.delete(target.label);
    effects.push(target.role);
    if (target.role === "daemon") throw new Error("lost bootout reply");
    return { code: 5, stdout: "", stderr: "uncertain reply" };
  });
  mock.contain.mockImplementation(async () => {
    await expect(assertNativeRetired(home, signal)).rejects.toThrow();
    expect((await records.read())?.phase).toBe("stopping");
    expect(jobs.has(locations.daemon.label) || jobs.has(locations.keyd.label)).toBe(false);
    for (const role of ["daemon", "keyd"] as const) {
      const scope = { state: root, home, ownerId: settings.ownerId, role };
      await expect(
        withServiceLease(
          scope,
          signal,
          keydServiceLeaseAcquirer(helper.path, scope),
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(ServiceLeaseBusy);
    }
    await expect(
      withInstallLock(root, signal, keydLockAcquirer(helper.path), async () => undefined),
    ).rejects.toThrow("Another installation");
    effects.push("containers");
  });
  await withInstallLock(root, signal, keydLockAcquirer(helper.path), async () => {
    await records.save(journal);
    const retirement = installedServiceRetirement(helper.path);
    const notStarting = async () => {
      throw new Error("unexpected startup during retirement");
    };
    const stopped = await stopServiceLifecycle(
      {
        ...records,
        ...retirement,
        authorizeRetirement: async (c) => {
          await verifyServiceOwner(c);
        },
        bootstrap: notStarting,
        start: notStarting,
        healthy: notStarting,
        verify: notStarting,
      },
      signal,
    );
    expect(stopped?.phase).toBe("stopped");
    await assertNativeRetired(home, signal);
    expect((await records.read())?.jobs).toEqual({
      keyd: { phase: "absent" },
      daemon: { phase: "absent" },
    });
  });
  expect(effects).toEqual(["daemon", "keyd", "containers"]);
  expect([...jobs.keys()]).toEqual(["foreign"]);
});
