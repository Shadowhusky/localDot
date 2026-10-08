import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ServiceJournal } from "../../../../packages/protocol/src/install-services.ts";
import { runDown } from "./down.ts";
import { serviceConfigurationId } from "./service-definition.ts";
import { serviceJournalStore } from "./service-journal.ts";

const mock = vi.hoisted(() => ({
  helper: vi.fn(),
  lock: vi.fn(),
  acquire: vi.fn(),
  remove: vi.fn(),
  contain: vi.fn(),
}));
vi.mock("./promote-release.ts", () => ({ readInstalledLockHelper: mock.helper }));
vi.mock("./install-lock.ts", () => ({
  withInstallLock: mock.lock,
  keydLockAcquirer: mock.acquire,
}));
vi.mock("./service-retirement.ts", () => ({
  installedServiceRetirement: () => ({ remove: mock.remove, contain: mock.contain }),
}));
const roots: string[] = [];
afterEach(async () => {
  for (const fn of Object.values(mock)) fn.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdot-down-")));
  roots.push(home);
  await chmod(home, 0o700);
  const state = join(home, "install");
  await mkdir(state, { mode: 0o700 });
  const settings = {
    state,
    home,
    userHome: home,
    node: "/recorded/node",
    dockerSocket: "/recorded/docker.sock",
    uid: process.getuid?.() ?? -1,
    port: 4888,
    ownerId: "a".repeat(32),
  };
  const release = {
    version: "1.2.3",
    packageSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  };
  const record: ServiceJournal = {
    v: 1,
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    configuration: { settings, release, configuration: serviceConfigurationId(settings, release) },
    previous: null,
    phase: "running",
    jobs: { keyd: { phase: "running", pid: 41 }, daemon: { phase: "running", pid: 42 } },
  };
  await writeFile(
    join(state, "service-owner.json"),
    JSON.stringify({ v: 1, id: settings.ownerId, state, home, uid: settings.uid }),
    { mode: 0o600 },
  );
  const store = serviceJournalStore(settings);
  await store.save(record);
  await writeFile(join(home, "user-data"), "preserve");
  // An interrupted update is preserved. down must not roll back by starting either release.
  await writeFile(join(state, "update.json"), "preserve pending update");
  const io = { out: vi.fn(), err: vi.fn() },
    controller = new AbortController();
  let held = false;
  mock.helper.mockImplementation(async () => ({ keydPath: "/verified/keyd", identity: release }));
  mock.lock.mockImplementation(async (_state, signal, _acquire, work) => {
    signal.throwIfAborted();
    held = true;
    try {
      return await work();
    } finally {
      held = false;
    }
  });
  mock.remove.mockImplementation(async (config) => {
    expect(held).toBe(true);
    expect(config).toEqual(record.configuration);
    expect((await store.read())?.phase).toBe("stopping");
  });
  mock.contain.mockImplementation(async () => {
    expect(held).toBe(true);
  });
  return {
    home,
    state,
    record,
    store,
    io,
    controller,
    run: () => runDown({ home, signal: controller.signal }, io),
  };
}
it("down uses recorded settings, drains retirement and reports success only after stopped persistence", async () => {
  const f = await fixture();
  expect(await f.run()).toBe(0);
  expect(mock.helper).toHaveBeenCalledTimes(2);
  expect(mock.remove.mock.calls.map((c) => c[1])).toEqual(["daemon", "keyd"]);
  expect((await f.store.read())?.phase).toBe("stopped");
  expect(mock.contain).toHaveBeenCalledOnce();
  expect(f.io.out).toHaveBeenLastCalledWith("localDot is down. Computer data has been preserved.");
  expect(await readdir(f.home)).toContain("user-data");
  expect(await readdir(f.state)).toContain("update.json");
});
it.each([
  "missing-helper",
  "changed-release",
  "second-verification",
  "remove",
  "contain",
  "missing-journal",
])("does not report success after %s failure", async (kind) => {
  const f = await fixture();
  if (kind === "missing-helper") mock.helper.mockRejectedValue(new Error("private details"));
  if (kind === "changed-release")
    mock.helper.mockResolvedValue({
      keydPath: "/verified/keyd",
      identity: { ...f.record.configuration.release, version: "9.9.9" },
    });
  if (kind === "second-verification")
    mock.helper
      .mockResolvedValueOnce({
        keydPath: "/verified/keyd",
        identity: f.record.configuration.release,
      })
      .mockRejectedValue(new Error("private details"));
  if (kind === "remove") mock.remove.mockRejectedValue(new Error("private details"));
  if (kind === "contain") mock.contain.mockRejectedValue(new Error("private details"));
  if (kind === "missing-journal") await rm(join(f.state, "service-journal.json"));
  expect(await f.run()).toBe(1);
  expect(JSON.stringify(f.io)).not.toContain("private details");
  expect(f.io.out).not.toHaveBeenCalledWith("localDot is down. Computer data has been preserved.");
  if (
    ["missing-helper", "changed-release", "second-verification", "missing-journal"].includes(kind)
  )
    expect(mock.remove).not.toHaveBeenCalled();
  else expect((await f.store.read())?.phase).toBe("stopping");
});
it("waits for cancellation cleanup to drain before releasing the lock", async () => {
  const f = await fixture();
  let close!: () => void,
    returned = false;
  mock.remove.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      close = resolve;
    });
    throw new Error("cancelled");
  });
  const result = f.run().finally(() => {
    returned = true;
  });
  await vi.waitFor(() => expect(mock.remove).toHaveBeenCalledOnce());
  f.controller.abort();
  await Promise.resolve();
  expect(returned).toBe(false);
  close();
  expect(await result).toBe(130);
  expect((await f.store.read())?.phase).toBe("stopping");
});
it("does no verification or mutation after pre-cancellation", async () => {
  const f = await fixture();
  f.controller.abort();
  expect(await f.run()).toBe(130);
  expect(mock.helper).not.toHaveBeenCalled();
  expect(mock.lock).not.toHaveBeenCalled();
});
it("rechecks physical shutdown even when the stored journal already says stopped", async () => {
  const f = await fixture();
  await f.store.save({
    ...f.record,
    phase: "stopped",
    jobs: { daemon: { phase: "absent" }, keyd: { phase: "absent" } },
  });
  mock.contain.mockRejectedValue(new Error("computer restarted outside the app"));
  expect(await f.run()).toBe(1);
  expect(mock.remove).toHaveBeenCalledTimes(2);
  expect(mock.contain).toHaveBeenCalledOnce();
  expect((await f.store.read())?.phase).toBe("stopping");
});
