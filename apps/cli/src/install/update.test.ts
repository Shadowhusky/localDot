import { afterEach, expect, it, vi } from "vitest";
import { serviceConfigurationId } from "./service-definition.ts";
import { compareReleaseVersions, runUpdate } from "./update.ts";

const mock = vi.hoisted(() => ({
  exists: vi.fn(),
  read: vi.fn(),
  helper: vi.fn(),
  lock: vi.fn(),
  host: vi.fn(),
  recover: vi.fn(),
  latest: vi.fn(),
  prepare: vi.fn(),
  activate: vi.fn(),
  open: vi.fn(),
  up: vi.fn(),
}));
vi.mock("./initialize-home.ts", () => ({ hasInstallState: mock.exists }));
vi.mock("./service-journal.ts", () => ({ serviceJournalStore: () => ({ read: mock.read }) }));
vi.mock("./promote-release.ts", () => ({ readInstalledLockHelper: mock.helper }));
vi.mock("./install-lock.ts", () => ({
  withInstallLock: mock.lock,
  keydLockAcquirer: () => undefined,
}));
vi.mock("./installed-update.ts", () => ({ installedUpdateHost: mock.host }));
vi.mock("./update-transaction.ts", () => ({ recoverUpdate: mock.recover }));
vi.mock("./registry-download.ts", () => ({ latestReleaseVersion: mock.latest }));
vi.mock("./prepare-release.ts", () => ({ withPreparedRelease: mock.prepare }));
vi.mock("./activate-release.ts", () => ({ activateInstalledRelease: mock.activate }));
vi.mock("../../../daemon/src/open-link.ts", () => ({ runOpenLink: mock.open }));
vi.mock("./up.ts", () => ({ runUp: mock.up }));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});
function fixture() {
  const home = "/private/test-home",
    signal = new AbortController();
  const settings = {
    home,
    state: `${home}/install`,
    uid: process.getuid?.() ?? -1,
    userHome: "/Users/fixture",
    node: "/recorded/node",
    dockerSocket: "/recorded/docker.sock",
    port: 4891,
    ownerId: "a".repeat(32),
  };
  const identity = (version: string) => ({
    version,
    packageSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  });
  const release = identity("1.0.0");
  const record = {
    configuration: { settings, release, configuration: serviceConfigurationId(settings, release) },
  };
  const update = {
    v: 1,
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    previous: null,
    candidate: release,
    phase: "committed",
  };
  const events: string[] = [],
    io = { out: vi.fn(), err: vi.fn() };
  let locked = false;
  const current = vi.fn(async () => structuredClone(record.configuration.release));
  const journal = vi.fn(async () => structuredClone(update));
  mock.exists.mockResolvedValue(true);
  mock.read.mockImplementation(async () => structuredClone(record));
  mock.helper.mockImplementation(async () => ({
    keydPath: "/verified/existing-helper",
    identity: structuredClone(record.configuration.release),
  }));
  mock.host.mockReturnValue({ current, read: journal });
  mock.lock.mockImplementation(async (_state, _signal, _acquire, work) => {
    locked = true;
    events.push("recovery-lock");
    try {
      return await work();
    } finally {
      locked = false;
      events.push("recovery-unlock");
    }
  });
  mock.recover.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("recover");
  });
  mock.latest.mockImplementation(async () => {
    expect(locked).toBe(false);
    events.push("latest");
    return "1.1.0";
  });
  mock.prepare.mockImplementation(async (_state, version, active, work) => {
    locked = true;
    events.push("prepare");
    try {
      return await work({ identity: identity(version) }, active, {
        keydPath: "/verified/new-helper",
      });
    } finally {
      locked = false;
      events.push("prepare-unlock");
    }
  });
  mock.activate.mockImplementation(async (effective, target, helper, active, progress) => {
    expect(locked).toBe(true);
    expect(effective).toEqual(settings);
    expect(helper).toBe("/verified/new-helper");
    expect(active).toBe(signal.signal);
    events.push("activate");
    progress({ role: "desktop", phase: "ready" });
    progress({ role: "desktop", phase: "ready" });
    return { configuration: { settings, release: target } };
  });
  mock.open.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("link");
    return 0;
  });
  mock.up.mockResolvedValue(0);
  return {
    signal,
    io,
    home,
    settings,
    record,
    update,
    events,
    current,
    journal,
    run: (version?: string) => runUpdate({ home, signal: signal.signal, version }, io),
  };
}
it("recovers offline then authenticates an exact latest candidate and activates inside its lock", async () => {
  const f = fixture();
  expect(await f.run()).toBe(0);
  expect(f.events).toEqual([
    "recovery-lock",
    "recover",
    "recovery-unlock",
    "latest",
    "prepare",
    "activate",
    "link",
    "prepare-unlock",
  ]);
  expect(mock.prepare).toHaveBeenCalledWith(
    f.settings.state,
    "1.1.0",
    f.signal.signal,
    expect.any(Function),
  );
  expect(mock.open).toHaveBeenCalledWith(
    { home: f.home, port: 4891, signal: f.signal.signal },
    f.io,
  );
  expect(f.io.out.mock.calls.filter(([s]) => s === "Preparing desktop: ready…")).toHaveLength(1);
  expect(JSON.stringify(f.io.out.mock.calls)).toContain("Updated to localDot 1.1.0");
});
it("allows an explicit release candidate without mutable-tag discovery", async () => {
  const f = fixture();
  expect(await f.run("1.1.0-rc.2")).toBe(0);
  expect(mock.latest).not.toHaveBeenCalled();
  expect(mock.prepare.mock.calls[0]?.[1]).toBe("1.1.0-rc.2");
});
it.each([0, 1])(
  "verifies readiness for an already-current release and propagates result %i",
  async (result) => {
    const f = fixture();
    mock.latest.mockResolvedValue("1.0.0");
    mock.up.mockResolvedValue(result);
    expect(await f.run()).toBe(result);
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.activate).not.toHaveBeenCalled();
    expect(JSON.stringify(f.io.out.mock.calls).includes("up to date and ready")).toBe(result === 0);
  },
);
it.each([
  "missing",
  "no-record",
  "missing-journal",
  "pending-journal",
  "wrong-selection",
  "bad-helper",
  "bad-target",
  "downgrade",
])("refuses %s before preparation", async (fault) => {
  const f = fixture();
  if (fault === "missing") mock.exists.mockResolvedValue(false);
  if (fault === "no-record") mock.read.mockResolvedValue(null);
  if (fault === "missing-journal") f.journal.mockResolvedValue(null as never);
  if (fault === "pending-journal") f.update.phase = "activating";
  if (fault === "wrong-selection")
    f.current.mockResolvedValue({ ...f.record.configuration.release, version: "9.0.0" });
  if (fault === "bad-helper") mock.helper.mockRejectedValue(new Error("private detail"));
  expect(
    await f.run(
      fault === "bad-target" ? "private-value" : fault === "downgrade" ? "0.9.0" : undefined,
    ),
  ).toBe(1);
  expect(mock.prepare).not.toHaveBeenCalled();
  expect(mock.activate).not.toHaveBeenCalled();
  expect(JSON.stringify(f.io.err.mock.calls)).not.toMatch(/private detail|private-value/);
});
it.each(["configuration", "journal", "selected", "candidate"])(
  "refuses concurrent %s changes between locks",
  async (fault) => {
    const f = fixture(),
      original = mock.prepare.getMockImplementation();
    mock.prepare.mockImplementation(async (...args) => {
      if (fault === "configuration") f.record.configuration.settings.port = 4892;
      if (fault === "journal") f.update.id = "11234567-89ab-4cde-8fab-0123456789ab";
      if (fault === "selected")
        f.current.mockResolvedValue({ ...f.record.configuration.release, version: "9.0.0" });
      if (fault === "candidate") args[1] = "9.0.0";
      return original?.(...args);
    });
    expect(await f.run()).toBe(1);
    expect(mock.activate).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
  },
);
it("waits for cancelled recovery to settle before releasing the lock", async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  mock.recover.mockImplementation(async () => {
    await new Promise<void>((done) => {
      release = done;
    });
  });
  const work = f.run();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.signal.abort();
  await Promise.resolve();
  expect(f.events).not.toContain("recovery-unlock");
  release?.();
  expect(await work).toBe(130);
  expect(mock.latest).not.toHaveBeenCalled();
  expect(mock.prepare).not.toHaveBeenCalled();
});
it("waits for failed activation/rollback before releasing preparation ownership", async () => {
  const f = fixture();
  let finish: (() => void) | undefined;
  mock.activate.mockImplementation(async () => {
    await new Promise<void>((done) => {
      finish = done;
    });
    throw new Error("private rollback detail");
  });
  const work = f.run();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.signal.abort();
  await Promise.resolve();
  expect(f.events).not.toContain("prepare-unlock");
  finish?.();
  expect(await work).toBe(130);
  expect(mock.open).not.toHaveBeenCalled();
  expect(JSON.stringify(f.io.err.mock.calls)).toContain("localdot up");
  expect(JSON.stringify(f.io.err.mock.calls)).not.toContain("private rollback");
});
it.each([
  ["1.2.3", "1.2.3", 0],
  ["1.2.3", "1.2.3-rc.99", 1],
  ["1.2.3-rc.10", "1.2.3-rc.2", 1],
  ["1.2.3-rc.0", "1.2.3", -1],
  ["1.10.0", "1.9.999", 1],
  ["0.9.9", "1.0.0", -1],
  ["9007199254740993.0.0", "9007199254740992.0.0", 1],
] as const)("orders %s against %s", (a, b, result) => {
  expect(compareReleaseVersions(a, b)).toBe(result);
});
