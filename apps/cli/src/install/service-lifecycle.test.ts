import { afterEach, expect, it, vi } from "vitest";
import {
  type ServiceConfiguration,
  ServiceJournal,
} from "../../../../packages/protocol/src/install-services.ts";
import { serviceConfigurationId } from "./service-definition.ts";
import {
  configurationForRelease,
  recoverServiceLifecycle,
  type ServiceLifecycleHost,
  startServiceLifecycle,
  stopServiceLifecycle,
} from "./service-lifecycle.ts";

afterEach(() => vi.restoreAllMocks());
const signal = () => new AbortController().signal;
function configuration(version = "1.2.3", port = 4750): ServiceConfiguration {
  const settings = {
    state: "/private/test/install",
    home: "/private/test/home",
    userHome: "/Users/test",
    node: "/usr/local/bin/node",
    dockerSocket: "/private/test/docker.sock",
    uid: 501,
    port,
    ownerId: "e".repeat(32),
  };
  const release = { version, packageSha256: "a".repeat(64), manifestSha256: "b".repeat(64) };
  return { settings, release, configuration: serviceConfigurationId(settings, release) };
}
function fixture() {
  let stored: ServiceJournal | null = null;
  const events: string[] = [],
    config = configuration();
  const host: ServiceLifecycleHost = {
    read: vi.fn(async () => structuredClone(stored)),
    save: vi.fn(async (record) => {
      stored = structuredClone(record);
      events.push(`save:${record.phase}`);
    }),
    verify: vi.fn(async () => {
      events.push("verify");
    }),
    authorizeRetirement: vi.fn(async () => {}),
    bootstrap: vi.fn<ServiceLifecycleHost["bootstrap"]>(async (_c, role) => {
      expect(stored?.jobs[role].phase).toBe("bootstrapping");
      events.push(`bootstrap:${role}`);
    }),
    start: vi.fn<ServiceLifecycleHost["start"]>(async (_c, role) => {
      expect(stored?.jobs[role].phase).toBe("starting");
      events.push(`start:${role}`);
      return role === "keyd" ? 41 : 42;
    }),
    remove: vi.fn(async (_c, role) => {
      events.push(`remove:${role}`);
    }),
    contain: vi.fn(async () => {
      events.push("contain");
    }),
    healthy: vi.fn(async (_c, pids) => {
      expect(pids).toEqual({ keyd: 41, daemon: 42 });
      events.push("healthy");
    }),
  };
  return {
    config,
    host,
    events,
    get: () => structuredClone(stored),
    set: (record: ServiceJournal | null) => {
      stored = structuredClone(record);
    },
  };
}
it("persists intents before effects, starts keyd first, and commits only after readiness/isolation", async () => {
  const f = fixture();
  const result = await startServiceLifecycle(f.host, f.config, signal());
  expect(result.phase).toBe("running");
  expect(f.get()).toEqual(result);
  expect(f.events.filter((e) => !e.startsWith("save:"))).toEqual([
    "verify",
    "bootstrap:keyd",
    "start:keyd",
    "bootstrap:daemon",
    "start:daemon",
    "healthy",
  ]);
  expect(f.events.slice(-2)).toEqual(["healthy", "save:running"]);
  result.configuration.settings.port++;
  expect(f.get()?.configuration.settings.port).toBe(4750);
});
it("retains the old port/engine/runtime for rollback even after a candidate start", async () => {
  const f = fixture();
  await startServiceLifecycle(f.host, f.config, signal());
  await stopServiceLifecycle(f.host, signal());
  const next = configuration("1.2.4", 4850);
  const record = await startServiceLifecycle(f.host, next, signal());
  expect(record.previous).toEqual(f.config);
  expect(configurationForRelease(record, f.config.release)).toEqual(f.config);
  expect(configurationForRelease(record, next.release)).toEqual(next);
  expect(() => configurationForRelease(record, configuration("9.0.0").release)).toThrow();
});
it.each([
  "bootstrap-keyd",
  "start-keyd",
  "bootstrap-daemon",
  "start-daemon",
  "healthy",
  "invalid-pid",
  "same-pid",
])("retires every owned role and containers after %s failure", async (kind) => {
  const f = fixture();
  for (const role of ["keyd", "daemon"] as const) {
    if (kind === `bootstrap-${role}`)
      vi.mocked(f.host.bootstrap).mockImplementation(async (_c, current) => {
        if (current === role) throw new Error("lost reply");
      });
    if (kind === `start-${role}`)
      vi.mocked(f.host.start).mockImplementation(async (_c, current) => {
        if (current === role) throw new Error("lost reply");
        return 41;
      });
  }
  if (kind === "healthy")
    vi.mocked(f.host.healthy).mockRejectedValue(new Error("isolation failed"));
  if (kind === "invalid-pid") vi.mocked(f.host.start).mockResolvedValue(0);
  if (kind === "same-pid") vi.mocked(f.host.start).mockResolvedValue(41);
  await expect(startServiceLifecycle(f.host, f.config, signal())).rejects.toThrow("was stopped");
  expect(f.events.filter((e) => e.startsWith("remove:") || e === "contain")).toEqual([
    "remove:daemon",
    "remove:keyd",
    "contain",
  ]);
  expect(f.get()?.phase).toBe("stopped");
});
it("does not repeat a possibly executed start after a lost reply and caller cancellation", async () => {
  const f = fixture(),
    caller = new AbortController();
  vi.mocked(f.host.start).mockImplementation(async () => {
    caller.abort();
    throw new Error("lost reply");
  });
  vi.mocked(f.host.remove).mockImplementation(async (_c, _role, _pid, cleanup) => {
    expect(cleanup.aborted).toBe(false);
  });
  await expect(startServiceLifecycle(f.host, f.config, caller.signal)).rejects.toThrow(
    "was stopped",
  );
  expect(f.host.start).toHaveBeenCalledTimes(1);
  expect(f.get()?.phase).toBe("stopped");
});
it.each(["before", "after"])(
  "a %s-rename initial save failure has no service effects",
  async (when) => {
    const f = fixture();
    vi.mocked(f.host.save).mockImplementationOnce(async (record) => {
      if (when === "after") f.set(record);
      throw new Error("disk");
    });
    await expect(startServiceLifecycle(f.host, f.config, signal())).rejects.toThrow();
    expect(f.host.bootstrap).not.toHaveBeenCalled();
    expect(f.host.remove).not.toHaveBeenCalled();
    expect(f.get()?.phase ?? null).toBe(when === "after" ? "starting" : null);
  },
);
it("a lost final commit acknowledgement rereads storage without stopping the healthy service", async () => {
  const f = fixture();
  vi.mocked(f.host.save).mockImplementation(async (record) => {
    f.set(record);
    if (record.phase === "running") throw new Error("lost acknowledgement");
  });
  expect((await startServiceLifecycle(f.host, f.config, signal())).phase).toBe("running");
  expect(f.host.remove).not.toHaveBeenCalled();
});
it.each(
  Array.from({ length: 10 }, (_, i) => i + 2).flatMap((write) => [
    { write, persisted: false },
    { write, persisted: true },
  ]),
)(
  "recovers interruption at journal write $write, persisted=$persisted",
  async ({ write, persisted }) => {
    const f = fixture();
    let writes = 0;
    vi.mocked(f.host.save).mockImplementation(async (record) => {
      if (++writes === write) {
        if (persisted) f.set(record);
        throw new Error("uncertain journal write");
      }
      f.set(record);
    });
    const pending = startServiceLifecycle(f.host, f.config, signal());
    if (write === 11 && persisted) {
      expect((await pending).phase).toBe("running");
      expect(f.host.remove).not.toHaveBeenCalled();
    } else {
      await expect(pending).rejects.toThrow("was stopped");
      expect(f.get()?.phase).toBe("stopped");
      expect(f.host.remove).toHaveBeenCalledTimes(2);
      expect(f.host.contain).toHaveBeenCalledOnce();
    }
  },
);
it("snapshots caller configuration before async verification and isolates effect arguments", async () => {
  const f = fixture(),
    barrier = Promise.withResolvers<void>();
  vi.mocked(f.host.verify).mockImplementationOnce(async (config) => {
    config.settings.port = 9999;
    await barrier.promise;
  });
  const pending = startServiceLifecycle(f.host, f.config, signal());
  f.config.settings.port = 8888;
  barrier.resolve();
  const result = await pending;
  expect(result.configuration.settings.port).toBe(4750);
  expect(
    vi.mocked(f.host.start).mock.calls.every(([config]) => config.settings.port === 4750),
  ).toBe(true);
});
it.each(["unreadable", "different-attempt"])(
  "cleans known labels but preserves %s storage after a failed start",
  async (kind) => {
    const f = fixture();
    vi.mocked(f.host.healthy).mockImplementation(async () => {
      if (kind === "unreadable") vi.mocked(f.host.read).mockRejectedValue(new Error("unreadable"));
      else {
        const record = f.get();
        if (record) f.set({ ...record, id: "2043d7a1-fb2a-4e83-afb2-2a90dacdc6c0" });
      }
      throw new Error("lost health");
    });
    await expect(startServiceLifecycle(f.host, f.config, signal())).rejects.toThrow(
      "recovery is required",
    );
    expect(f.host.remove).toHaveBeenCalledTimes(2);
    expect(f.host.contain).toHaveBeenCalledOnce();
    expect(f.get()?.phase).toBe("validating");
  },
);
it.each(["remove", "contain", "save"])(
  "a failed %s leaves recovery pending and still attempts other cleanup",
  async (kind) => {
    const f = fixture();
    await startServiceLifecycle(f.host, f.config, signal());
    if (kind === "remove") vi.mocked(f.host.remove).mockRejectedValueOnce(new Error("not gone"));
    if (kind === "contain")
      vi.mocked(f.host.contain).mockRejectedValueOnce(new Error("unknown container"));
    if (kind === "save") vi.mocked(f.host.save).mockRejectedValueOnce(new Error("disk"));
    await expect(stopServiceLifecycle(f.host, signal())).rejects.toThrow("recovery is required");
    expect(f.host.remove).toHaveBeenCalledTimes(2);
    expect(f.host.contain).toHaveBeenCalledOnce();
    expect(f.get()?.phase).toBe("stopping");
    expect((await recoverServiceLifecycle(f.host))?.phase).toBe("stopped");
  },
);
it("recovery retires pending starts rather than repeating bootstrap or kickstart", async () => {
  const f = fixture();
  await startServiceLifecycle(f.host, f.config, signal());
  const old = f.get();
  if (!old) throw new Error();
  f.set({
    ...old,
    phase: "starting",
    jobs: { keyd: { phase: "starting" }, daemon: { phase: "absent" } },
  });
  vi.mocked(f.host.start).mockClear();
  vi.mocked(f.host.bootstrap).mockClear();
  expect((await recoverServiceLifecycle(f.host))?.phase).toBe("stopped");
  expect(f.host.start).not.toHaveBeenCalled();
  expect(f.host.bootstrap).not.toHaveBeenCalled();
});
it("freshly checks running services and retires them on readiness loss", async () => {
  const f = fixture();
  await startServiceLifecycle(f.host, f.config, signal());
  expect((await recoverServiceLifecycle(f.host))?.phase).toBe("running");
  vi.mocked(f.host.healthy).mockRejectedValue(new Error("different boot"));
  expect((await recoverServiceLifecycle(f.host))?.phase).toBe("stopped");
});
it("can retire owned services when their release verification is damaged", async () => {
  const f = fixture();
  await startServiceLifecycle(f.host, f.config, signal());
  vi.mocked(f.host.verify).mockRejectedValue(new Error("damaged executable"));
  expect((await recoverServiceLifecycle(f.host))?.phase).toBe("stopped");
  expect(f.host.authorizeRetirement).toHaveBeenCalledOnce();
  expect(f.host.remove).toHaveBeenCalledTimes(2);
});
it("keeps a stopping intent but touches no job when private ownership cannot be verified", async () => {
  const f = fixture();
  await startServiceLifecycle(f.host, f.config, signal());
  vi.mocked(f.host.authorizeRetirement).mockRejectedValue(new Error("wrong owner"));
  await expect(stopServiceLifecycle(f.host, signal())).rejects.toThrow();
  expect(f.get()?.phase).toBe("stopping");
  expect(f.host.remove).not.toHaveBeenCalled();
  expect(f.host.contain).not.toHaveBeenCalled();
});
it("rejects nonterminal, mismatched or structurally inconsistent state before a new start", async () => {
  const f = fixture();
  const first = await startServiceLifecycle(f.host, f.config, signal());
  vi.mocked(f.host.bootstrap).mockClear();
  await expect(startServiceLifecycle(f.host, configuration("1.2.4"), signal())).rejects.toThrow();
  expect(f.host.bootstrap).not.toHaveBeenCalled();
  expect(ServiceJournal.safeParse({ ...first, phase: "stopped" }).success).toBe(false);
  expect(ServiceJournal.safeParse({ ...first, extra: "secret" }).success).toBe(false);
});
