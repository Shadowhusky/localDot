import { afterEach, expect, it, vi } from "vitest";
import type { ServiceJournal } from "../../../../packages/protocol/src/install-services.ts";
import { serviceConfigurationId } from "./service-definition.ts";
import { runUp } from "./up.ts";

const mock = vi.hoisted(() => ({
  directory: vi.fn(),
  read: vi.fn(),
  helper: vi.fn(),
  lock: vi.fn(),
  selected: vi.fn(),
  update: vi.fn(),
  host: vi.fn(),
  retire: vi.fn(),
  recover: vi.fn(),
  start: vi.fn(),
  isolation: vi.fn(),
  open: vi.fn(),
  verify: vi.fn(),
  updateHost: vi.fn(),
  recoverUpdate: vi.fn(),
  runtimes: vi.fn(),
  sync: vi.fn(),
  save: vi.fn(),
  docker: vi.fn(),
}));
vi.mock("./login-agent.ts", () => ({
  syncLoginAgent: mock.sync,
  startAtLoginStore: () => ({ save: mock.save, read: async () => null }),
  nodeLoginAgentHost: () => ({ fake: true }),
}));
vi.mock("./host-docker-facts.ts", () => ({ readHostDockerFacts: mock.docker }));
vi.mock("./copy-inventory.ts", () => ({ privateDirectory: mock.directory }));
vi.mock("./service-journal.ts", () => ({ serviceJournalStore: () => ({ read: mock.read }) }));
vi.mock("./promote-release.ts", () => ({
  readInstalledLockHelper: mock.helper,
  installedReleaseVerifier: () => mock.verify,
}));
vi.mock("./install-lock.ts", () => ({
  withInstallLock: mock.lock,
  keydLockAcquirer: () => undefined,
}));
vi.mock("./release-layout.ts", () => ({ releaseLayout: () => ({ current: mock.selected }) }));
vi.mock("./update-journal.ts", () => ({ updateJournalStore: () => ({ read: mock.update }) }));
vi.mock("./installed-update.ts", () => ({ installedUpdateHost: mock.updateHost }));
vi.mock("./update-transaction.ts", () => ({ recoverUpdate: mock.recoverUpdate }));
vi.mock("./service-host.ts", () => ({ installedServiceHost: mock.host }));
vi.mock("./service-retirement.ts", () => ({ installedServiceRetirement: mock.retire }));
vi.mock("./service-lifecycle.ts", () => ({
  recoverServiceLifecycle: mock.recover,
  startServiceLifecycle: mock.start,
}));
vi.mock("./service-isolation.ts", () => ({ verifyInstalledIsolation: mock.isolation }));
vi.mock("./prepare-runtimes.ts", () => ({ prepareInstalledRuntimes: mock.runtimes }));
vi.mock("../../../daemon/src/open-link.ts", () => ({ runOpenLink: mock.open }));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});
function fixture() {
  const settings = {
    state: "/private/tmp/home/install",
    home: "/private/tmp/home",
    userHome: "/Users/fixture",
    node: "/recorded/node",
    dockerSocket: "/recorded/docker.sock",
    uid: process.getuid?.() ?? -1,
    port: 4891,
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
    phase: "stopped",
    jobs: { daemon: { phase: "absent" }, keyd: { phase: "absent" } },
  };
  const events: string[] = [],
    controller = new AbortController(),
    io = { out: vi.fn(), err: vi.fn() };
  let locked = false;
  mock.read.mockImplementation(async () => structuredClone(record));
  mock.helper.mockResolvedValue({ keydPath: "/verified/keyd", identity: release });
  mock.selected.mockResolvedValue(release);
  mock.update.mockResolvedValue({ phase: "committed", candidate: release, previous: null });
  mock.lock.mockImplementation(async (_state, signal, _acquire, work) => {
    signal.throwIfAborted();
    locked = true;
    try {
      return await work();
    } finally {
      locked = false;
    }
  });
  mock.host.mockReturnValue({ verify: mock.verify });
  mock.retire.mockReturnValue({ remove: "actual-adapter", contain: "actual-adapter" });
  mock.recover.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("recover");
    return structuredClone(record);
  });
  mock.recoverUpdate.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("recover-update");
  });
  mock.verify.mockImplementation(async () => {
    events.push("verify");
  });
  mock.isolation.mockImplementation(async () => {
    events.push("isolation");
  });
  mock.start.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("start");
    return { ...record, phase: "running" };
  });
  mock.runtimes.mockImplementation(async () => {
    expect(locked).toBe(true);
  });
  mock.open.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("link");
    return 0;
  });
  mock.sync.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("sync");
    return "off";
  });
  mock.save.mockImplementation(async (record: { enabled: boolean }) => {
    expect(locked).toBe(true);
    events.push(`save:${record.enabled}`);
  });
  return {
    record,
    release,
    events,
    controller,
    io,
    run: () => runUp({ home: settings.home, signal: controller.signal }, io),
    runWith: (options: Parameters<typeof runUp>[2]) =>
      runUp({ home: settings.home, signal: controller.signal }, io, options),
  };
}
it("starts only the recorded selected release after recovery, verification and isolation", async () => {
  const f = fixture();
  expect(await f.run()).toBe(0);
  expect(f.events).toEqual([
    "recover-update",
    "recover",
    "verify",
    "isolation",
    "start",
    "sync",
    "link",
  ]);
  expect(mock.host).toHaveBeenCalledWith(
    expect.objectContaining({ home: f.record.configuration.settings.home }),
    { remove: "actual-adapter", contain: "actual-adapter", isolation: mock.isolation },
  );
  expect(mock.open).toHaveBeenCalledWith(
    { home: f.record.configuration.settings.home, port: 4891, signal: f.controller.signal },
    f.io,
  );
  expect(mock.helper).toHaveBeenCalledTimes(2);
  expect(mock.runtimes).toHaveBeenCalledWith(
    f.record.configuration,
    expect.any(String),
    f.controller.signal,
  );
  expect(mock.runtimes.mock.invocationCallOrder[0]).toBeLessThan(
    mock.start.mock.invocationCallOrder[0] ?? 0,
  );
});
it("withholds service startup and sign-in after runtime preparation fails", async () => {
  const f = fixture();
  mock.runtimes.mockRejectedValue(new Error("retained computer needs recovery"));
  expect(await f.run()).toBe(1);
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.open).not.toHaveBeenCalled();
});
it("reuses a freshly verified running service without kickstarting it again", async () => {
  const f = fixture();
  mock.recover.mockResolvedValue({ ...f.record, phase: "running" });
  expect(await f.run()).toBe(0);
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.open).toHaveBeenCalledOnce();
});
it.each([
  "missing-update",
  "pending-update",
  "update-recovery",
  "selection",
  "changed-release",
  "recovery",
  "verify",
  "isolation",
  "start",
])("does not print ready or create a sign-in link after %s failure", async (kind) => {
  const f = fixture();
  if (kind === "missing-update") mock.update.mockResolvedValue(null);
  if (kind === "pending-update")
    mock.update.mockResolvedValue({ phase: "activating", candidate: f.release });
  if (kind === "update-recovery") mock.recoverUpdate.mockRejectedValue(new Error("private detail"));
  if (kind === "selection") mock.selected.mockResolvedValue(null);
  if (kind === "changed-release")
    mock.helper.mockResolvedValue({
      keydPath: "/verified/keyd",
      identity: { ...f.release, version: "9.9.9" },
    });
  if (["recovery", "verify", "isolation", "start"].includes(kind))
    mock[
      kind === "recovery" ? "recover" : (kind as "verify" | "isolation" | "start")
    ].mockRejectedValue(new Error("private detail"));
  expect(await f.run()).toBe(1);
  expect(mock.open).not.toHaveBeenCalled();
  expect(f.io.out).not.toHaveBeenCalledWith("localDot is ready.");
  expect(JSON.stringify(f.io.err.mock.calls)).not.toContain("private detail");
  if (["pending-update", "missing-update", "selection", "changed-release"].includes(kind))
    expect(mock.recover).not.toHaveBeenCalled();
});
it("uses the restored release's recorded port after interrupted update recovery", async () => {
  const f = fixture();
  const previous = structuredClone(f.record);
  previous.configuration.release.version = "1.2.2";
  previous.configuration.settings.port = 4892;
  previous.configuration.configuration = serviceConfigurationId(
    previous.configuration.settings,
    previous.configuration.release,
  );
  mock.recoverUpdate.mockImplementation(async () => {
    mock.read.mockResolvedValue(previous);
    mock.recover.mockResolvedValue({ ...previous, phase: "running" });
    mock.selected.mockResolvedValue(previous.configuration.release);
    mock.update.mockResolvedValue({
      phase: "rolled-back",
      previous: previous.configuration.release,
    });
  });
  expect(await f.run()).toBe(0);
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.open).toHaveBeenCalledWith(expect.objectContaining({ port: 4892 }), f.io);
});
it("drains update recovery after cancellation before releasing the lock", async () => {
  const f = fixture();
  let close!: () => void,
    settled = false;
  mock.recoverUpdate.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      close = resolve;
    });
  });
  const result = f.run().finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(mock.recoverUpdate).toHaveBeenCalledOnce());
  f.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  close();
  expect(await result).toBe(130);
  expect(mock.recover).not.toHaveBeenCalled();
  expect(mock.open).not.toHaveBeenCalled();
});
it("does not launch after cancellation during recovery and waits for its cleanup", async () => {
  const f = fixture();
  let close!: () => void,
    settled = false;
  mock.recover.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      close = resolve;
    });
    return f.record;
  });
  const result = f.run().finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(mock.recover).toHaveBeenCalledOnce());
  f.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  close();
  expect(await result).toBe(130);
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.open).not.toHaveBeenCalled();
});
it("from login: waits for Docker, starts through the journaled lifecycle, prints no link", async () => {
  const f = fixture();
  const dockerReady = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const sleep = vi.fn(async () => {});
  expect(await f.runWith({ fromLogin: true, dockerReady, sleep })).toBe(0);
  expect(dockerReady).toHaveBeenNthCalledWith(1, "/recorded/docker.sock", f.controller.signal);
  expect(sleep).toHaveBeenCalledWith(10_000, f.controller.signal);
  expect(f.events).toEqual(["recover-update", "recover", "verify", "isolation", "start", "sync"]);
  expect(mock.open).not.toHaveBeenCalled();
});
it("from login: gives up quietly when Docker never comes, without the lock or a start", async () => {
  const f = fixture();
  expect(
    await f.runWith({
      fromLogin: true,
      dockerReady: async () => false,
      sleep: async () => {},
      dockerWaitMs: 0,
    }),
  ).toBe(0);
  expect(mock.lock).not.toHaveBeenCalled();
  expect(f.io.out).toHaveBeenCalledWith(expect.stringContaining("Docker Desktop is not running"));
});
it("--at-login records the choice under the lock, syncs the agent, then prints the link", async () => {
  const f = fixture();
  expect(await f.runWith({ atLogin: true })).toBe(0);
  expect(f.events).toEqual([
    "recover-update",
    "recover",
    "verify",
    "isolation",
    "start",
    "save:true",
    "sync",
    "link",
  ]);
});
it("--at-login fails loudly when the agent cannot be written", async () => {
  const f = fixture();
  mock.sync.mockRejectedValueOnce(new Error("Start at login could not be changed safely."));
  expect(await f.runWith({ atLogin: true })).toBe(1);
  expect(mock.open).not.toHaveBeenCalled();
  expect(f.io.err).toHaveBeenCalledWith(
    "localDot started, but start at login could not be turned on. Run localdot start-at-login on to try again.",
  );
});
it("plain up still succeeds when the agent sync fails, and says so", async () => {
  const f = fixture();
  mock.sync.mockRejectedValueOnce(new Error("Start at login could not be changed safely."));
  expect(await f.run()).toBe(0);
  expect(f.io.err).toHaveBeenCalledWith(expect.stringContaining("localdot start-at-login status"));
});
