import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ServiceConfiguration,
  ServiceJournal,
} from "../../../../packages/protocol/src/install-services.ts";
import { installedUpdateHost } from "./installed-update.ts";
import { releaseDirectoryName, releaseLayout } from "./release-layout.ts";
import { serviceConfigurationId, serviceLocation } from "./service-definition.ts";
import { serviceJournalStore } from "./service-journal.ts";
import { updateJournalStore } from "./update-journal.ts";
import { activateUpdate, recoverUpdate } from "./update-transaction.ts";

// Real private records, release selection and both transaction coordinators. Native service,
// signature and network effects are simulated; this does not establish installed acceptance.
const mock = vi.hoisted(() => ({
  verify: vi.fn(),
  release: vi.fn(),
  isolation: vi.fn(),
  command: vi.fn(),
  ready: vi.fn(),
  remove: vi.fn(),
  contain: vi.fn(),
  runtimes: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("./login-agent.ts", () => ({
  syncLoginAgent: mock.sync,
  nodeLoginAgentHost: () => ({ fake: true }),
}));
vi.mock("./promote-release.ts", () => ({ installedReleaseVerifier: () => mock.release }));
vi.mock("./service-journal.ts", async (original) => ({
  ...(await original<typeof import("./service-journal.ts")>()),
  verifyServiceConfiguration: mock.verify,
}));
vi.mock("./service-command.ts", () => ({ runServiceCommand: mock.command }));
vi.mock("./service-readiness.ts", () => ({
  waitForServiceReadiness: mock.ready,
  verifyServiceReadiness: mock.ready,
}));
vi.mock("./service-isolation.ts", () => ({ verifyInstalledIsolation: mock.isolation }));
vi.mock("./prepare-runtimes.ts", () => ({ prepareInstalledRuntimes: mock.runtimes }));
vi.mock("./service-retirement.ts", () => ({
  installedServiceRetirement: () => ({ remove: mock.remove, contain: mock.contain }),
}));
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const fn of Object.values(mock)) fn.mockReset();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(first = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-update-host-")));
  roots.push(root);
  await chmod(root, 0o700);
  const home = join(root, "home"),
    state = join(root, "install");
  for (const path of [home, state, join(state, "releases")]) await mkdir(path, { mode: 0o700 });
  const settings = {
    state,
    home,
    userHome: root,
    node: await realpath(process.execPath),
    dockerSocket: join(root, "docker.sock"),
    uid: process.getuid?.() ?? -1,
    port: 4873,
    ownerId: "a".repeat(32),
  };
  const configuration = (version: string, hex: string, port: number): ServiceConfiguration => {
    const release = { version, packageSha256: hex.repeat(64), manifestSha256: hex.repeat(64) };
    const values = { ...settings, port };
    return { settings: values, release, configuration: serviceConfigurationId(values, release) };
  };
  const previous = configuration("1.0.0", "b", 4873),
    candidate = configuration("1.1.0", "c", 4874);
  for (const config of [previous, candidate])
    await mkdir(join(state, "releases", releaseDirectoryName(config.release)), { mode: 0o700 });
  await writeFile(
    join(state, "service-owner.json"),
    JSON.stringify({
      v: 1,
      id: settings.ownerId,
      state,
      home,
      uid: settings.uid,
    }),
    { mode: 0o600 },
  );
  const records = serviceJournalStore(settings),
    updates = updateJournalStore(state);
  const old: ServiceJournal = {
    v: 1,
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    configuration: previous,
    previous: null,
    phase: "running",
    jobs: { keyd: { phase: "running", pid: 21 }, daemon: { phase: "running", pid: 22 } },
  };
  const layout = releaseLayout(state, mock.release),
    events: string[] = [];
  const jobs = new Set<string>();
  if (!first) {
    await records.save(old);
    await layout.select(previous.release, signal());
    await updates.save({
      v: 1,
      id: old.id,
      previous: null,
      candidate: previous.release,
      phase: "committed",
    });
    jobs.add("keyd");
    jobs.add("daemon");
  }
  await writeFile(join(home, "retained-user-data"), "keep me", { mode: 0o600 });
  mock.verify.mockImplementation(async (config) =>
    serviceLocation(state, home, settings.uid, settings.ownerId, config.configuration),
  );
  mock.command.mockImplementation(async (definition, operation) => {
    const record = await records.read();
    expect(record?.phase).toBe("starting");
    expect(record?.jobs[definition.role as "daemon" | "keyd"].phase).toBe(
      operation === "bootstrap" ? "bootstrapping" : "starting",
    );
    events.push(`${operation}:${record?.configuration.release.version}:${definition.role}`);
    if (operation === "bootstrap") jobs.add(definition.role);
    return {
      code: 0,
      stdout: operation === "kickstart" ? `${definition.role === "keyd" ? 31 : 32}\n` : "",
      stderr: "",
    };
  });
  mock.remove.mockImplementation(async (config, role) => {
    expect((await records.read())?.phase).toBe("stopping");
    events.push(`remove:${config.release.version}:${role}`);
    jobs.delete(role);
  });
  mock.contain.mockImplementation(async () => {
    expect(jobs.size).toBe(0);
    expect((await records.read())?.phase).toBe("stopping");
    events.push("contained");
  });
  mock.ready.mockImplementation(async (expected) => {
    events.push(`ready:${expected.identity.release.version}:${expected.port}`);
  });
  mock.runtimes.mockImplementation(async (config) => {
    const record = await records.read();
    expect(record === null || record.phase === "stopped").toBe(true);
    expect(jobs.size).toBe(0);
    events.push(`runtimes:${config.release.version}`);
  });
  return {
    state,
    home,
    settings,
    previous,
    candidate,
    records,
    updates,
    layout,
    old,
    events,
    jobs,
    host: () => installedUpdateHost(settings, "/verified/helper", candidate),
    recovery: () => installedUpdateHost(settings, "/verified/helper"),
  };
}
it.each([false, true])("activates with real durable records (first install: %s)", async (first) => {
  const f = await fixture(first);
  expect((await activateUpdate(f.host(), f.candidate.release, signal())).phase).toBe("committed");
  expect(await f.layout.current()).toEqual(f.candidate.release);
  expect((await f.records.read())?.configuration).toEqual(f.candidate);
  expect((await f.records.read())?.phase).toBe("running");
  expect(f.events).toContain("ready:1.1.0:4874");
  expect(f.events.indexOf("runtimes:1.1.0")).toBeLessThan(f.events.indexOf("bootstrap:1.1.0:keyd"));
  if (!first)
    expect(f.events.indexOf("contained")).toBeLessThan(f.events.indexOf("bootstrap:1.1.0:keyd"));
  expect(await readFile(join(f.home, "retained-user-data"), "utf8")).toBe("keep me");
});
it("rolls back a failed candidate to the recorded old port and configuration", async () => {
  const f = await fixture();
  mock.ready.mockImplementation(async (expected) => {
    if (expected.port === 4874) throw new Error("candidate never ready");
    expect(expected.port).toBe(4873);
  });
  await expect(activateUpdate(f.host(), f.candidate.release, signal())).rejects.toThrow("restored");
  expect((await f.updates.read())?.phase).toBe("rolled-back");
  expect(await f.layout.current()).toEqual(f.previous.release);
  expect((await f.records.read())?.configuration).toEqual(f.previous);
  expect((await f.records.read())?.previous).toEqual(f.candidate);
  expect((await f.records.read())?.phase).toBe("running");
});
it("prepares the previous runtime before rollback bootstrap when candidate preparation fails", async () => {
  const f = await fixture();
  mock.runtimes.mockImplementation(async (config) => {
    expect((await f.records.read())?.phase).toBe("stopped");
    f.events.push(`runtimes:${config.release.version}`);
    if (config.release.version === "1.1.0") throw new Error("partial runtime migration");
  });
  await expect(activateUpdate(f.host(), f.candidate.release, signal())).rejects.toThrow("restored");
  expect(f.events).not.toContain("bootstrap:1.1.0:keyd");
  expect(f.events.indexOf("runtimes:1.0.0")).toBeLessThan(f.events.indexOf("bootstrap:1.0.0:keyd"));
  expect((await f.records.read())?.configuration).toEqual(f.previous);
});
it.each(["prepared", "quiescing", "activating", "validating", "rolling-back"] as const)(
  "a fresh adapter recovers a crash in %s using persisted configuration",
  async (phase) => {
    const f = await fixture();
    if (phase === "validating" || phase === "rolling-back") {
      await f.layout.select(f.candidate.release, signal());
      await f.records.save({ ...f.old, configuration: f.candidate, previous: f.previous });
    }
    await f.updates.save({
      v: 1,
      id: f.old.id,
      phase,
      previous: f.previous.release,
      candidate: f.candidate.release,
    });
    expect((await recoverUpdate(f.recovery()))?.phase).toBe("rolled-back");
    expect((await f.records.read())?.configuration).toEqual(f.previous);
    expect((await f.records.read())?.phase).toBe("running");
    expect(await f.layout.current()).toEqual(f.previous.release);
    expect(f.events).not.toContain("bootstrap:1.1.0:keyd");
  },
);
it("recovers a first-install crash after selection but before any service intent", async () => {
  const f = await fixture(true);
  await f.layout.select(f.candidate.release, signal());
  await f.updates.save({
    v: 1,
    id: f.old.id,
    phase: "validating",
    previous: null,
    candidate: f.candidate.release,
  });
  expect((await recoverUpdate(f.recovery()))?.phase).toBe("rolled-back");
  expect(await f.layout.current()).toBe(null);
  expect(await f.records.read()).toBe(null);
  expect(mock.command).not.toHaveBeenCalled();
});
it("keeps recovery pending when physical containment cannot be confirmed", async () => {
  const f = await fixture();
  mock.contain.mockRejectedValue(new Error("container unknown"));
  await expect(activateUpdate(f.host(), f.candidate.release, signal())).rejects.toThrow();
  expect((await f.updates.read())?.phase).toBe("rolling-back");
  expect((await f.records.read())?.phase).toBe("stopping");
  expect(await f.layout.current()).toEqual(f.previous.release);
  expect(mock.command).not.toHaveBeenCalled();
});
it("refuses missing previous service authority instead of reporting quiescence", async () => {
  const f = await fixture();
  await rm(join(f.state, "service-journal.json"));
  await f.updates.save({
    v: 1,
    id: f.old.id,
    phase: "activating",
    previous: f.previous.release,
    candidate: f.candidate.release,
  });
  await expect(recoverUpdate(f.recovery())).rejects.toThrow();
  expect((await f.updates.read())?.phase).toBe("rolling-back");
  expect(mock.command).not.toHaveBeenCalled();
});
it("does not stop the running installation when candidate isolation fails", async () => {
  const f = await fixture();
  mock.isolation.mockRejectedValue(new Error("wrong images"));
  await expect(activateUpdate(f.host(), f.candidate.release, signal())).rejects.toThrow();
  expect(mock.remove).not.toHaveBeenCalled();
  expect((await f.records.read())?.phase).toBe("running");
});
it("rejects a configuration outside this installation", async () => {
  const f = await fixture();
  const config = structuredClone(f.candidate);
  config.settings.home = "/foreign/home";
  config.configuration = serviceConfigurationId(config.settings, config.release);
  expect(() => installedUpdateHost(f.settings, "/verified/helper", config)).toThrow();
});
it("checks both selected identity and fresh service readiness", async () => {
  const f = await fixture();
  const host = f.host();
  await expect(host.healthy(f.candidate.release, signal())).rejects.toThrow();
  await expect(host.start(f.candidate.release, signal())).rejects.toThrow();
  expect(mock.command).not.toHaveBeenCalled();
  await host.healthy(f.previous.release, signal());
  mock.ready.mockImplementation(async () => {
    await f.records.save({ ...f.old, id: "fedcba98-7654-4321-abcd-123456789abc" });
  });
  await expect(host.healthy(f.previous.release, signal())).rejects.toThrow();
});
it("re-points the login agent at the release it just started", async () => {
  const f = await fixture();
  mock.sync.mockResolvedValue("on");
  expect((await activateUpdate(f.host(), f.candidate.release, signal())).phase).toBe("committed");
  expect(mock.sync).toHaveBeenCalledWith(
    expect.objectContaining({ release: f.candidate.release }),
    { fake: true },
    expect.any(AbortSignal),
  );
});
it("still reports a successful update when re-pointing the login agent fails", async () => {
  const f = await fixture();
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.sync.mockRejectedValue(new Error("Start at login could not be changed safely."));
  expect((await activateUpdate(f.host(), f.candidate.release, signal())).phase).toBe("committed");
  expect(quiet).toHaveBeenCalledWith(expect.stringContaining("start at login"));
  quiet.mockRestore();
});
