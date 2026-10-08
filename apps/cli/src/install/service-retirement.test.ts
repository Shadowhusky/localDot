import { afterEach, expect, it, vi } from "vitest";
import type {
  ServiceConfiguration,
  ServiceJournal,
} from "../../../../packages/protocol/src/install-services.ts";
import { ServiceLeaseBusy } from "./install-lock.ts";
import { serviceConfigurationId } from "./service-definition.ts";
import { installedServiceRetirement, withStoppedServiceLeases } from "./service-retirement.ts";

const mock = vi.hoisted(() => ({
  owner: vi.fn(),
  read: vi.fn(),
  observe: vi.fn(),
  command: vi.fn(),
  lease: vi.fn(),
  acquire: vi.fn(),
  contain: vi.fn(),
  native: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("./service-journal.ts", () => ({
  verifyServiceOwner: mock.owner,
  serviceJournalStore: () => ({ read: mock.read }),
}));
vi.mock("./service-observation.ts", () => ({ observeServiceJob: mock.observe }));
vi.mock("./service-command.ts", () => ({ runServiceCommand: mock.command }));
vi.mock("./container-containment.ts", () => ({ containInstalledContainers: mock.contain }));
vi.mock("./native-retirement.ts", () => ({ assertNativeRetired: mock.native }));
vi.mock("./native-recovery.ts", () => ({ recoverNativeRetiredWithLease: mock.recover }));
vi.mock("./install-lock.ts", async (original) => ({
  ...(await original<typeof import("./install-lock.ts")>()),
  withServiceLease: mock.lease,
  keydServiceLeaseAcquirer: mock.acquire,
}));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
  vi.useRealTimers();
});
function fixture() {
  const settings = {
    state: "/private/tmp/state",
    home: "/private/tmp/home",
    userHome: "/Users/fixture",
    node: "/usr/bin/node",
    dockerSocket: "/private/tmp/docker.sock",
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
  const record: ServiceJournal = {
    v: 1,
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    configuration: config,
    previous: null,
    phase: "stopping",
    jobs: { daemon: { phase: "removing", pid: null }, keyd: { phase: "running", pid: 123 } },
  };
  const held = new Set<string>(),
    controller = new AbortController();
  mock.owner.mockImplementation(async (c) => structuredClone(c));
  mock.read.mockImplementation(async () => structuredClone(record));
  mock.observe.mockResolvedValue(null);
  mock.command.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  mock.lease.mockImplementation(async (scope, signal, _acquire, work) => {
    signal.throwIfAborted();
    held.add(scope.role);
    try {
      return await work();
    } finally {
      held.delete(scope.role);
    }
  });
  mock.contain.mockImplementation(async () => {
    expect([...held].sort()).toEqual(["daemon", "keyd"]);
  });
  mock.native.mockImplementation(async () => {
    expect([...held].sort()).toEqual(["daemon", "keyd"]);
  });
  mock.recover.mockImplementation(async () => {
    expect([...held].sort()).toEqual(["daemon", "keyd"]);
  });
  const api = installedServiceRetirement("/verified/bootstrap/keyd");
  return {
    config,
    record,
    held,
    controller,
    api,
    remove: () => api.remove(config, "daemon", 9999, controller.signal),
    contain: () => api.contain(config, controller.signal),
  };
}
it.each(["success", "nonzero", "lost-reply"])(
  "resolves %s bootout only through absence and the lifetime lease",
  async (kind) => {
    const f = fixture();
    mock.observe.mockResolvedValueOnce({ pid: 321 });
    if (kind === "nonzero")
      mock.command.mockResolvedValue({ code: 5, stdout: "", stderr: "unknown" });
    if (kind === "lost-reply") mock.command.mockRejectedValue(new Error("lost reply"));
    await f.remove();
    expect(mock.command).toHaveBeenCalledOnce();
    expect(mock.command.mock.calls[0]?.[1]).toBe("bootout");
    expect(mock.command.mock.calls[0]?.[0].target).toContain(f.config.settings.ownerId);
    expect(mock.acquire).toHaveBeenCalledWith(
      "/verified/bootstrap/keyd",
      expect.objectContaining({ role: "daemon" }),
    );
    expect(f.held.size).toBe(0);
  },
);
it("does not bootout an absent job but still acquires its process lease", async () => {
  const f = fixture();
  await f.remove();
  expect(mock.command).not.toHaveBeenCalled();
  expect(mock.lease).toHaveBeenCalledOnce();
});
it("waits for an actual process to exit after the job has disappeared", async () => {
  vi.useFakeTimers();
  const f = fixture();
  mock.lease.mockRejectedValueOnce(new ServiceLeaseBusy());
  let settled = false;
  const promise = f.remove().then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(99);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await promise;
  expect(mock.lease).toHaveBeenCalledTimes(2);
});
it("waits for delayed job removal without repeatedly dispatching bootout", async () => {
  vi.useFakeTimers();
  const f = fixture();
  mock.observe.mockResolvedValueOnce({ pid: 321 }).mockResolvedValueOnce({ pid: null });
  const promise = f.remove();
  await vi.advanceTimersByTimeAsync(100);
  await promise;
  expect(mock.command).toHaveBeenCalledOnce();
});
it("uses ownership for best-effort removal after a failed stopping write, but refuses completion", async () => {
  const f = fixture();
  mock.read.mockRejectedValue(new Error("disk"));
  mock.observe.mockResolvedValueOnce({ pid: 321 });
  await expect(f.remove()).rejects.toThrow();
  expect(mock.command).toHaveBeenCalledOnce();
  expect(f.held.size).toBe(0);
});
it.each(["wrong-config", "new-attempt", "running", "reappeared", "owner-lost", "unsafe-lease"])(
  "refuses final %s evidence",
  async (kind) => {
    const f = fixture();
    if (kind === "wrong-config")
      f.record.configuration = { ...f.config, configuration: "d".repeat(64) };
    if (kind === "new-attempt")
      mock.read.mockResolvedValueOnce(structuredClone(f.record)).mockImplementation(async () => ({
        ...structuredClone(f.record),
        id: "11234567-89ab-4cde-8fab-0123456789ab",
      }));
    if (kind === "running") f.record.phase = "running";
    if (kind === "reappeared")
      mock.observe
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ pid: 42 });
    if (kind === "owner-lost")
      mock.owner.mockResolvedValueOnce(f.config).mockRejectedValue(new Error("owner"));
    if (kind === "unsafe-lease") mock.lease.mockRejectedValue(new Error("unsafe"));
    await expect(f.remove()).rejects.toThrow();
    expect(f.held.size).toBe(0);
  },
);
it("drains a cancelled command before returning and never interprets cancellation as absence", async () => {
  const f = fixture();
  mock.observe.mockResolvedValueOnce({ pid: 321 });
  let close!: () => void;
  mock.command.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      close = resolve;
    });
    throw new Error("closed");
  });
  let settled = false;
  const promise = f
    .remove()
    .catch((e) => e)
    .finally(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(mock.command).toHaveBeenCalledOnce());
  f.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  close();
  expect(await promise).toBeInstanceOf(Error);
  expect(mock.lease).not.toHaveBeenCalled();
});
it("holds both leases through containment and final verification", async () => {
  const f = fixture();
  await f.contain();
  expect(mock.contain).toHaveBeenCalledOnce();
  expect(mock.recover).toHaveBeenCalledOnce();
  expect(mock.contain.mock.invocationCallOrder[0]).toBeLessThan(
    mock.recover.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mock.recover.mock.invocationCallOrder[0]).toBeLessThan(
    mock.native.mock.invocationCallOrder[0] ?? 0,
  );
  expect(f.held.size).toBe(0);
});
it.each(["busy", "job-present", "not-stopping"])(
  "does not start Docker containment while %s",
  async (kind) => {
    const f = fixture();
    if (kind === "busy") mock.lease.mockRejectedValue(new ServiceLeaseBusy());
    if (kind === "job-present") mock.observe.mockResolvedValue({ pid: 321 });
    if (kind === "not-stopping") f.record.phase = "running";
    await expect(f.contain()).rejects.toThrow();
    expect(mock.contain).not.toHaveBeenCalled();
    expect(mock.recover).not.toHaveBeenCalled();
    expect(f.held.size).toBe(0);
  },
);
it("rejects late job reappearance after Docker containment", async () => {
  const f = fixture();
  mock.observe
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ pid: 321 });
  await expect(f.contain()).rejects.toThrow();
  expect(mock.contain).toHaveBeenCalledOnce();
  expect(mock.recover).not.toHaveBeenCalled();
  expect(f.held.size).toBe(0);
});

it("contains containers before refusing uncertain recovery, without claiming native retirement", async () => {
  const f = fixture();
  mock.recover.mockRejectedValue(new Error("recovery uncertain"));
  await expect(f.contain()).rejects.toThrow("recovery uncertain");
  expect(mock.contain).toHaveBeenCalledOnce();
  expect(mock.native).not.toHaveBeenCalled();
  expect(f.held.size).toBe(0);
});

it("does not start stopped work if recovery fails", async () => {
  const f = fixture();
  f.record.phase = "stopped";
  f.record.jobs = { daemon: { phase: "absent" }, keyd: { phase: "absent" } };
  mock.recover.mockRejectedValue(new Error("recovery uncertain"));
  const work = vi.fn();
  await expect(
    withStoppedServiceLeases(f.config, "/verified/bootstrap/keyd", f.controller.signal, work),
  ).rejects.toThrow("recovery uncertain");
  expect(work).not.toHaveBeenCalled();
  expect(mock.native).not.toHaveBeenCalled();
  expect(f.held.size).toBe(0);
});

it("contains containers but refuses stopped completion when native retirement is uncertain", async () => {
  const f = fixture();
  mock.native.mockRejectedValue(new Error("native retirement unknown"));
  await expect(f.contain()).rejects.toThrow("native retirement unknown");
  expect(mock.contain).toHaveBeenCalledOnce();
  expect(mock.native).toHaveBeenCalledWith(f.config.settings.home, expect.any(AbortSignal));
  expect(mock.contain.mock.invocationCallOrder[0]).toBeLessThan(
    mock.native.mock.invocationCallOrder[0] ?? 0,
  );
  expect(f.held.size).toBe(0);
});

it.each(["before", "after"])(
  "rejects %s-work native retirement uncertainty under stopped leases",
  async (when) => {
    const f = fixture();
    f.record.phase = "stopped";
    f.record.jobs = { daemon: { phase: "absent" }, keyd: { phase: "absent" } };
    if (when === "before") mock.native.mockRejectedValue(new Error("native"));
    const work = vi.fn(async () => {
      mock.native.mockRejectedValue(new Error("native"));
    });
    await expect(
      withStoppedServiceLeases(f.config, "/verified/bootstrap/keyd", f.controller.signal, work),
    ).rejects.toThrow("native");
    expect(work).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    expect(f.held.size).toBe(0);
  },
);

it("holds both stopped-service leases through work and rechecks, then expires the callback", async () => {
  const f = fixture();
  f.record.phase = "stopped";
  f.record.jobs = { daemon: { phase: "absent" }, keyd: { phase: "absent" } };
  let stale: (() => Promise<void>) | undefined;
  const result = await withStoppedServiceLeases(
    f.config,
    "/verified/bootstrap/keyd",
    f.controller.signal,
    async (recheck) => {
      expect([...f.held].sort()).toEqual(["daemon", "keyd"]);
      await recheck();
      stale = recheck;
      return "prepared";
    },
  );
  expect(result).toBe("prepared");
  expect(mock.recover).toHaveBeenCalledOnce();
  expect(mock.native).toHaveBeenCalledTimes(3);
  expect(f.held.size).toBe(0);
  if (!stale) throw new Error("fixture callback missing");
  await expect(stale()).rejects.toThrow("confirmed stopped");
});

it.each(["stopping", "job-not-absent", "busy", "job-present", "changed-attempt"])(
  "refuses stopped work for %s",
  async (fault) => {
    const f = fixture();
    f.record.phase = "stopped";
    f.record.jobs = { daemon: { phase: "absent" }, keyd: { phase: "absent" } };
    if (fault === "stopping") f.record.phase = "stopping";
    if (fault === "job-not-absent") f.record.jobs.keyd = { phase: "running", pid: 123 };
    if (fault === "busy") mock.lease.mockRejectedValue(new ServiceLeaseBusy());
    if (fault === "job-present") mock.observe.mockResolvedValue({ pid: 42 });
    if (fault === "changed-attempt")
      mock.read.mockResolvedValueOnce(structuredClone(f.record)).mockImplementation(async () => ({
        ...f.record,
        id: "11234567-89ab-4cde-8fab-0123456789ab",
      }));
    const work = vi.fn();
    await expect(
      withStoppedServiceLeases(f.config, "/verified/bootstrap/keyd", f.controller.signal, work),
    ).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(mock.recover).not.toHaveBeenCalled();
    expect(f.held.size).toBe(0);
  },
);

it("does not release leases on cancellation before in-flight work settles", async () => {
  const f = fixture();
  f.record.phase = "stopped";
  f.record.jobs = { daemon: { phase: "absent" }, keyd: { phase: "absent" } };
  let finish: (() => void) | undefined,
    entered = false,
    settled = false;
  const promise = withStoppedServiceLeases(
    f.config,
    "/verified/bootstrap/keyd",
    f.controller.signal,
    async () => {
      entered = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  )
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(entered).toBe(true));
  f.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.held.size).toBe(2);
  if (!finish) throw new Error("fixture pending work missing");
  finish();
  expect(await promise).toBeInstanceOf(Error);
  expect(f.held.size).toBe(0);
});
