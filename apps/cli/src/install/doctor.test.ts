import { afterEach, expect, it, vi } from "vitest";
import type { ServiceJournal } from "../../../../packages/protocol/src/install-services.ts";
import { IMAGE_ROLES } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { runInstalledDoctor } from "./doctor.ts";
import { serviceConfigurationId } from "./service-definition.ts";

const mock = vi.hoisted(() => ({
  read: vi.fn(),
  helper: vi.fn(),
  lock: vi.fn(),
  selected: vi.fn(),
  update: vi.fn(),
  release: vi.fn(),
  definitions: vi.fn(),
  probes: vi.fn(),
  preflight: vi.fn(),
  imageClient: vi.fn(),
  images: vi.fn(),
  gateway: vi.fn(),
  observe: vi.fn(),
  ready: vi.fn(),
  selftests: vi.fn(),
  inventory: vi.fn(),
  canary: vi.fn(),
  port: vi.fn(),
}));
vi.mock("./service-journal.ts", () => ({
  serviceJournalStore: () => ({ read: mock.read }),
  verifyServiceConfiguration: mock.definitions,
}));
vi.mock("./promote-release.ts", () => ({
  readInstalledLockHelper: mock.helper,
  readInstalledRelease: mock.release,
  installedReleaseVerifier: () => undefined,
}));
vi.mock("./release-layout.ts", () => ({ releaseLayout: () => ({ current: mock.selected }) }));
vi.mock("./update-journal.ts", () => ({ updateJournalStore: () => ({ read: mock.update }) }));
vi.mock("./install-lock.ts", () => ({
  withInstallLock: mock.lock,
  keydLockAcquirer: () => undefined,
}));
vi.mock("./host-probes.ts", () => ({ installHostProbes: mock.probes }));
vi.mock("./preflight.ts", () => ({ runInstallPreflight: mock.preflight }));
vi.mock("./image-client.ts", () => ({ installImageClient: mock.imageClient }));
vi.mock("./doctor-images.ts", () => ({ inspectDoctorImages: mock.images }));
vi.mock("./network-isolation.ts", () => ({ verifyInstalledGateway: mock.gateway }));
vi.mock("./service-observation.ts", () => ({ observeServiceJob: mock.observe }));
vi.mock("./service-readiness.ts", () => ({ verifyServiceReadiness: mock.ready }));
vi.mock("./doctor-selftests.ts", () => ({ requestDoctorSelfTests: mock.selftests }));
vi.mock("./container-containment.ts", () => ({ readContainerInventory: mock.inventory }));
vi.mock("./installed-canary.ts", () => ({ runInstalledCanary: mock.canary }));
vi.mock("./doctor-port.ts", () => ({ probeInstalledPort: mock.port }));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});
function fixture() {
  const home = "/private/doctor-fixture",
    controller = new AbortController(),
    io = { out: vi.fn(), err: vi.fn() };
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
  const release = {
    version: "1.0.0",
    packageSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  };
  const config = { settings, release, configuration: serviceConfigurationId(settings, release) };
  const journal: ServiceJournal = {
    v: 1,
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    configuration: config,
    previous: null,
    phase: "running",
    jobs: { keyd: { phase: "running", pid: 123 }, daemon: { phase: "running", pid: 456 } },
  };
  const update = { v: 1, id: journal.id, phase: "committed", previous: null, candidate: release };
  const events: string[] = [];
  let locked = false;
  mock.read.mockImplementation(async () => structuredClone(journal));
  mock.update.mockImplementation(async () => structuredClone(update));
  mock.selected.mockResolvedValue(release);
  mock.helper.mockResolvedValue({ keydPath: "/verified/helper", identity: release });
  mock.lock.mockImplementation(async (_state, _signal, _acquire, work) => {
    locked = true;
    events.push("lock");
    try {
      return await work();
    } finally {
      locked = false;
      events.push("unlock");
    }
  });
  mock.release.mockResolvedValue({ directory: "/verified/release", manifest: sampleManifest() });
  mock.definitions.mockResolvedValue({ keyd: { role: "keyd" }, daemon: { role: "daemon" } });
  mock.preflight.mockResolvedValue({
    prerequisitesPassed: true,
    checks: ["host", "disk", "docker"].map((name) => ({
      name,
      ok: true,
      message: "meets requirements",
    })),
  });
  const imageResult = {
    engineId: "engine-1",
    images: Object.fromEntries(IMAGE_ROLES.map((r) => [r, `sha256:${"d".repeat(64)}`])),
    checks: IMAGE_ROLES.map((r) => ({ name: `image-${r}`, ok: true, detail: "verified" })),
  };
  mock.images.mockImplementation(async () => structuredClone(imageResult));
  mock.gateway.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("gateway");
    return { engineId: "engine-1" };
  });
  mock.canary.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("canary");
    return { scan: { ok: true }, artifacts: { ok: true } };
  });
  mock.port.mockResolvedValue("free");
  mock.observe.mockImplementation(async ({ role }) => {
    expect(locked).toBe(true);
    return { pid: role === "keyd" ? 123 : 456 };
  });
  mock.ready.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("ready");
    return { bootId: "01234567-89ab-4cde-8fab-0123456789ab" };
  });
  const cellId = "01JXYZ00000000000000000001";
  mock.selftests.mockResolvedValue({ cells: [{ id: cellId, outcome: "passed" }] });
  mock.inventory.mockResolvedValue({
    records: [{ id: cellId, kind: "desktop" }],
    invalid: false,
    digest: "inventory-1",
  });
  const context = {
    home,
    port: 4999,
    signal: controller.signal,
    installed: structuredClone(config),
    env: { DOCKER_HOST: "tcp://foreign", LOCALDOT_PORT: "4999" },
  };
  return {
    context,
    config,
    controller,
    io,
    journal,
    update,
    imageResult,
    events,
    run: () => runInstalledDoctor(context, io),
    text: () => JSON.stringify(io.out.mock.calls),
  };
}
it("checks recorded resources/all images/owned gateway and authenticates its own occupied port under the lock", async () => {
  const f = fixture();
  expect(await f.run()).toBe(0);
  expect(mock.probes).toHaveBeenCalledWith({ DOCKER_HOST: "unix:///recorded/docker.sock" });
  expect(mock.imageClient).toHaveBeenCalledWith("/recorded/docker.sock");
  expect(mock.images).toHaveBeenCalledTimes(4);
  expect(mock.ready).toHaveBeenCalledWith(
    expect.objectContaining({
      home: f.config.settings.home,
      port: 4891,
      keydPid: 123,
      daemonPid: 456,
      identity: { ownerId: f.config.settings.ownerId, release: f.config.release },
    }),
    f.controller.signal,
  );
  expect(mock.observe).toHaveBeenCalledTimes(8);
  expect(f.events).toEqual(["lock", "gateway", "ready", "ready", "canary", "ready", "unlock"]);
  expect(f.text()).toContain("ok   port-4891");
  expect(f.text()).not.toContain("4999");
  expect(f.text()).toContain("ok   cell-self-tests");
  expect(f.text()).toContain("ok   secret-canary");
  expect(mock.canary).toHaveBeenCalledWith(
    {
      configuration: f.config,
      verifiedKeydPath: "/verified/helper",
      releaseDirectory: "/verified/release",
      manifest: sampleManifest(),
      engineId: "engine-1",
      imageIds: { desktop: `sha256:${"d".repeat(64)}`, gate: `sha256:${"d".repeat(64)}` },
    },
    f.controller.signal,
  );
});
it.each(["configuration", "selection", "pending-update", "helper", "release", "definitions"])(
  "refuses %s before contacting Docker",
  async (fault) => {
    const f = fixture();
    if (fault === "configuration") f.journal.configuration.settings.port = 4888;
    if (fault === "selection") mock.selected.mockResolvedValue(null);
    if (fault === "pending-update") f.update.phase = "activating";
    if (fault === "helper") mock.helper.mockRejectedValue(new Error("private detail"));
    if (fault === "release") mock.release.mockRejectedValue(new Error("private detail"));
    if (fault === "definitions") mock.definitions.mockRejectedValue(new Error("private detail"));
    expect(await f.run()).toBe(1);
    expect(mock.preflight).not.toHaveBeenCalled();
    expect(mock.gateway).not.toHaveBeenCalled();
    expect(f.io.out).not.toHaveBeenCalled();
    expect(JSON.stringify(f.io.err.mock.calls)).not.toContain("private detail");
  },
);
it("reports resource failure without probing or pulling Docker images", async () => {
  const f = fixture();
  mock.preflight.mockResolvedValue({
    prerequisitesPassed: false,
    checks: [{ name: "docker", ok: false, message: "Give Docker 8 GiB" }],
  });
  expect(await f.run()).toBe(1);
  expect(mock.images).not.toHaveBeenCalled();
  expect(mock.gateway).not.toHaveBeenCalled();
  expect(f.text()).toContain("Give Docker 8 GiB");
  expect(f.text()).toContain("image-browser");
});
it.each(["image", "gateway", "engine", "image-change", "port", "pid", "stopped"])(
  "reports %s failure without claiming a healthy installation",
  async (fault) => {
    const f = fixture();
    if (fault === "image") mock.images.mockRejectedValue(new Error("private detail"));
    if (fault === "gateway") mock.gateway.mockRejectedValue(new Error("private detail"));
    if (fault === "engine") mock.gateway.mockResolvedValue({ engineId: "engine-2" });
    if (fault === "image-change")
      mock.images.mockResolvedValueOnce(structuredClone(f.imageResult)).mockResolvedValue({
        ...f.imageResult,
        images: { ...f.imageResult.images, brain: "different" },
      });
    if (fault === "port") mock.ready.mockRejectedValue(new Error("private detail"));
    if (fault === "pid") mock.observe.mockResolvedValue({ pid: 789 });
    if (fault === "stopped") {
      f.journal.phase = "stopped";
      f.journal.jobs = { keyd: { phase: "absent" }, daemon: { phase: "absent" } };
    }
    expect(await f.run()).toBe(1);
    const output = f.text();
    expect(output).not.toContain("private detail");
    const name =
      fault === "image-change"
        ? "docker-stability"
        : ["port", "pid", "stopped"].includes(fault)
          ? "port-4891"
          : fault === "image"
            ? "image-desktop"
            : "isolated-gateway-mode";
    expect(output).toContain(`FAIL ${name}`);
    if (["pid", "stopped"].includes(fault)) expect(mock.ready).not.toHaveBeenCalled();
  },
);
it.each([
  "invalid-before",
  "invalid-after",
  "changed",
  "omitted",
  "unexpected",
  "empty",
  "failed",
  "unavailable",
  "restart",
])("does not certify fresh self-tests with %s evidence", async (fault) => {
  const f = fixture();
  const id = "01JXYZ00000000000000000001";
  const inventory = { records: [{ id, kind: "desktop" }], invalid: false, digest: "inventory-1" };
  if (fault === "invalid-before") mock.inventory.mockResolvedValue({ ...inventory, invalid: true });
  if (fault === "invalid-after")
    mock.inventory
      .mockResolvedValueOnce(inventory)
      .mockResolvedValue({ ...inventory, invalid: true });
  if (fault === "changed")
    mock.inventory
      .mockResolvedValueOnce(inventory)
      .mockResolvedValue({ ...inventory, digest: "inventory-2" });
  if (fault === "omitted") mock.selftests.mockResolvedValue({ cells: [] });
  if (fault === "unexpected")
    mock.selftests.mockResolvedValue({
      cells: [{ id: "01JXYZ00000000000000000002", outcome: "passed" }],
    });
  if (fault === "empty") {
    mock.inventory.mockResolvedValue({ ...inventory, records: [] });
    mock.selftests.mockResolvedValue({ cells: [] });
  }
  if (fault === "failed" || fault === "unavailable")
    mock.selftests.mockResolvedValue({ cells: [{ id, outcome: fault }] });
  if (fault === "restart")
    mock.ready.mockResolvedValueOnce({ bootId: "before" }).mockResolvedValue({ bootId: "after" });
  expect(await f.run()).toBe(1);
  expect(f.text()).toContain("FAIL cell-self-tests");
  expect(f.text()).not.toContain("ok   cell-self-tests");
  if (fault === "invalid-before") expect(mock.selftests).not.toHaveBeenCalled();
  if (fault === "restart") expect(f.text()).toContain("FAIL port-4891");
});
it("discards success observations when the durable service journal changes", async () => {
  const f = fixture();
  mock.ready.mockImplementation(async () => {
    f.journal.id = "11234567-89ab-4cde-8fab-0123456789ab";
  });
  expect(await f.run()).toBe(1);
  expect(f.io.out).not.toHaveBeenCalled();
  expect(f.io.err).toHaveBeenCalled();
});
it("keeps ownership until a cancelled gateway probe and its cleanup settle", async () => {
  const f = fixture();
  let done: (() => void) | undefined;
  mock.gateway.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      done = resolve;
    });
    return { engineId: "engine-1" };
  });
  const work = f.run();
  await vi.waitFor(() => expect(done).toBeTypeOf("function"));
  f.controller.abort();
  await Promise.resolve();
  expect(f.events).not.toContain("unlock");
  done?.();
  expect(await work).toBe(130);
  expect(f.events.at(-1)).toBe("unlock");
  expect(mock.ready).not.toHaveBeenCalled();
  expect(f.io.out).not.toHaveBeenCalled();
});

it("reports a failed canary without exposing private errors or claiming installation success", async () => {
  const f = fixture();
  mock.canary.mockRejectedValue(new Error("private diagnostic data"));
  expect(await f.run()).toBe(1);
  expect(f.text()).toContain("FAIL secret-canary");
  expect(f.text()).not.toContain("private diagnostic data");
  expect(f.events.at(-1)).toBe("unlock");
});
it("waits for the cancelled canary cleanup before releasing the install lock", async () => {
  const f = fixture();
  let drain: (() => void) | undefined;
  mock.canary.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      drain = resolve;
    });
  });
  const work = f.run();
  await vi.waitFor(() => expect(drain).toBeTypeOf("function"));
  f.controller.abort();
  await Promise.resolve();
  expect(f.events).not.toContain("unlock");
  drain?.();
  expect(await work).toBe(130);
  expect(f.events.at(-1)).toBe("unlock");
  expect(f.io.out).not.toHaveBeenCalled();
});
it.each(["host", "image", "isolation"])(
  "does not start a canary with failed %s prerequisites",
  async (fault) => {
    const f = fixture();
    if (fault === "host")
      mock.preflight.mockResolvedValue({
        prerequisitesPassed: false,
        checks: [
          { name: "docker", ok: true, message: "ready" },
          { name: "host", ok: false, message: "unsupported" },
        ],
      });
    if (fault === "image")
      f.imageResult.checks[0] = { name: "image-desktop", ok: false, detail: "missing" };
    if (fault === "isolation") mock.gateway.mockRejectedValue(new Error("unavailable"));
    expect(await f.run()).toBe(1);
    expect(mock.canary).not.toHaveBeenCalled();
    expect(f.text()).toContain("FAIL secret-canary");
  },
);
it.each(["before", "after"])("refuses image drift %s the canary", async (when) => {
  const f = fixture();
  let inspections = 0;
  mock.images.mockImplementation(async () => {
    inspections++;
    return {
      ...f.imageResult,
      engineId:
        inspections >= (when === "before" ? 3 : 4) ? "other-engine" : f.imageResult.engineId,
    };
  });
  expect(await f.run()).toBe(1);
  expect(mock.canary).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  expect(f.text()).toContain("FAIL secret-canary");
});
it("discards earlier service and canary success if installed services restart during diagnostics", async () => {
  const f = fixture();
  mock.canary.mockImplementation(async () => {
    mock.ready.mockResolvedValue({ bootId: "restarted" });
  });
  expect(await f.run()).toBe(1);
  expect(f.io.out).not.toHaveBeenCalled();
  expect(f.io.err).toHaveBeenCalled();
});

it("invalidates the whole doctor receipt when a non-canary image changes during the canary", async () => {
  const f = fixture();
  mock.canary.mockImplementation(async () => {
    f.imageResult.images.brain = `sha256:${"e".repeat(64)}`;
  });
  expect(await f.run()).toBe(1);
  expect(f.text()).toContain("FAIL secret-canary");
});

it.each(["free", "occupied", "unavailable"])(
  "explains a stopped installation with a %s port without claiming app readiness",
  async (port) => {
    const f = fixture();
    f.journal.phase = "stopped";
    f.journal.jobs = { keyd: { phase: "absent" }, daemon: { phase: "absent" } };
    mock.observe.mockResolvedValue(null);
    mock.port.mockResolvedValue(port);
    expect(await f.run()).toBe(1);
    expect(mock.port).toHaveBeenCalledWith(4891, f.controller.signal);
    expect(mock.ready).not.toHaveBeenCalled();
    expect(mock.selftests).not.toHaveBeenCalled();
    expect(mock.observe).toHaveBeenCalledTimes(8);
    expect(mock.port).toHaveBeenCalledTimes(2);
    expect(f.text()).toContain(`${port === "free" ? "ok  " : "FAIL"} port-4891`);
    expect(f.text()).toContain("FAIL cell-self-tests");
    expect(f.text()).toContain(
      port === "free"
        ? "loopback port is free"
        : port === "occupied"
          ? "loopback port is occupied"
          : "port could not be checked",
    );
  },
);
it("does not bind-probe a port when a stopped journal still has an observed service job", async () => {
  const f = fixture();
  f.journal.phase = "stopped";
  f.journal.jobs = { keyd: { phase: "absent" }, daemon: { phase: "absent" } };
  mock.observe.mockResolvedValue({ pid: null });
  expect(await f.run()).toBe(1);
  expect(mock.port).not.toHaveBeenCalled();
  expect(f.text()).toContain("Stopped service state could not be confirmed");
});
it("invalidates stopped-port evidence if a service appears during the canary", async () => {
  const f = fixture();
  f.journal.phase = "stopped";
  f.journal.jobs = { keyd: { phase: "absent" }, daemon: { phase: "absent" } };
  mock.observe.mockResolvedValue(null);
  mock.canary.mockImplementation(async () => {
    mock.observe.mockResolvedValue({ pid: 789 });
  });
  expect(await f.run()).toBe(1);
  expect(f.io.out).not.toHaveBeenCalled();
  expect(f.io.err).toHaveBeenCalled();
});

it("discards an earlier free-port receipt if another listener occupies it before reporting", async () => {
  const f = fixture();
  f.journal.phase = "stopped";
  f.journal.jobs = { keyd: { phase: "absent" }, daemon: { phase: "absent" } };
  mock.observe.mockResolvedValue(null);
  mock.port.mockResolvedValueOnce("free").mockResolvedValue("occupied");
  expect(await f.run()).toBe(1);
  expect(f.io.out).not.toHaveBeenCalled();
  expect(f.io.err).toHaveBeenCalled();
});
