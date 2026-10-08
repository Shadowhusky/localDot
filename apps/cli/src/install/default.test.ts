import { afterEach, expect, it, vi } from "vitest";
import { runDefault } from "./default.ts";

const mock = vi.hoisted(() => ({
  exists: vi.fn(),
  initialize: vi.fn(),
  service: vi.fn(),
  update: vi.fn(),
  probes: vi.fn(),
  preflight: vi.fn(),
  prepare: vi.fn(),
  activate: vi.fn(),
  up: vi.fn(),
  open: vi.fn(),
  browser: vi.fn(),
  launch: vi.fn(),
}));
vi.mock("./browser-progress.ts", () => ({ startInstallProgressBrowser: mock.browser }));
vi.mock("./browser-open.ts", async (original) => ({
  ...(await original<typeof import("./browser-open.ts")>()),
  openInstallerBrowser: mock.launch,
}));
vi.mock("./initialize-home.ts", () => ({
  hasInstallState: mock.exists,
  initializeInstallHome: mock.initialize,
}));
vi.mock("./service-journal.ts", () => ({ serviceJournalStore: () => ({ read: mock.service }) }));
vi.mock("./update-journal.ts", () => ({ updateJournalStore: () => ({ read: mock.update }) }));
vi.mock("./host-probes.ts", () => ({ installHostProbes: mock.probes }));
vi.mock("./preflight.ts", () => ({ runInstallPreflight: mock.preflight }));
vi.mock("./prepare-release.ts", () => ({ withPreparedRelease: mock.prepare }));
vi.mock("./activate-release.ts", () => ({ activateInstalledRelease: mock.activate }));
vi.mock("./up.ts", () => ({ runUp: mock.up }));
vi.mock("../../../daemon/src/open-link.ts", () => ({ runOpenLink: mock.open }));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});
function fixture() {
  const controller = new AbortController(),
    io = { out: vi.fn(), err: vi.fn() };
  const context = {
    home: "/private/tmp/fixture",
    version: "1.2.3",
    env: {} as NodeJS.ProcessEnv,
    signal: controller.signal,
  };
  const release = {
    identity: { version: "1.2.3", packageSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
  };
  const settings = {
    home: context.home,
    state: `${context.home}/install`,
    uid: process.getuid?.() ?? -1,
    port: 4891,
    dockerSocket: "/recorded/docker.sock",
    node: "/recorded/node",
    userHome: "/Users/fixture",
    ownerId: "c".repeat(32),
  };
  const events: string[] = [];
  let locked = false;
  mock.exists.mockResolvedValue(false);
  mock.service.mockResolvedValue(null);
  mock.update.mockResolvedValue(null);
  mock.probes.mockImplementation((_env, report) => {
    report("/selected/docker.sock");
    return {};
  });
  mock.preflight.mockImplementation(async () => {
    events.push("preflight");
    return { prerequisitesPassed: true, checks: [{ ok: true, message: "Prerequisites passed." }] };
  });
  mock.initialize.mockImplementation(async (home) => {
    events.push("directories");
    return { home, state: `${home}/install` };
  });
  mock.prepare.mockImplementation(async (_state, _version, signal, work) => {
    events.push("prepare");
    locked = true;
    try {
      return await work(release, signal, { keydPath: "/verified/helper" });
    } finally {
      locked = false;
      events.push("unlock");
    }
  });
  mock.activate.mockImplementation(async () => {
    expect(locked).toBe(true);
    events.push("activate");
    return { configuration: { settings } };
  });
  mock.open.mockImplementation(async (_context, output) => {
    expect(locked).toBe(true);
    events.push("link");
    output.out(`http://127.0.0.1:4891/#code=${"c".repeat(43)}`);
    return 0;
  });
  mock.up.mockResolvedValue(0);
  mock.launch.mockResolvedValue(true);
  return { context, controller, io, release, settings, events, run: () => runDefault(context, io) };
}
it("runs first setup in order and holds the preparation mutex through sign-in", async () => {
  const f = fixture();
  expect(await f.run()).toBe(0);
  expect(f.events).toEqual(["preflight", "directories", "prepare", "activate", "link", "unlock"]);
  expect(mock.activate).toHaveBeenCalledWith(
    expect.objectContaining({ dockerSocket: "/selected/docker.sock", port: 4750 }),
    f.release.identity,
    "/verified/helper",
    f.controller.signal,
    expect.any(Function),
  );
  expect(mock.open).toHaveBeenCalledWith(
    { home: f.context.home, port: 4891, signal: f.controller.signal },
    expect.objectContaining({ out: expect.any(Function), err: expect.any(Function) }),
  );
});
it("reuses an existing installation without preflight/downloads or parsing ambient settings", async () => {
  const f = fixture();
  mock.exists.mockResolvedValue(true);
  mock.service.mockResolvedValue({ configuration: { settings: f.settings } });
  mock.update.mockResolvedValue({ phase: "committed", previous: null });
  f.context.env = { LOCALDOT_PORT: "private invalid value", DOCKER_HOST: "unrelated" };
  f.context.version = "invalid";
  expect(await f.run()).toBe(0);
  expect(mock.up).toHaveBeenCalledWith(
    { home: f.context.home, signal: f.controller.signal },
    expect.objectContaining({ out: expect.any(Function) }),
  );
  expect(mock.preflight).not.toHaveBeenCalled();
  expect(mock.prepare).not.toHaveBeenCalled();
});
it("resumes a failed first installation using its recorded settings", async () => {
  const f = fixture();
  mock.exists.mockResolvedValue(true);
  mock.service.mockResolvedValue({ configuration: { settings: f.settings } });
  mock.update.mockResolvedValue({ phase: "rolling-back", previous: null });
  f.context.env = { LOCALDOT_PORT: "invalid", DOCKER_HOST: "unrelated" };
  expect(await f.run()).toBe(0);
  expect(mock.probes).toHaveBeenCalledWith(
    expect.objectContaining({ DOCKER_HOST: "unix:///recorded/docker.sock" }),
    expect.any(Function),
  );
  expect(mock.activate.mock.calls[0]?.[0]).toEqual(f.settings);
});
it("shows missing-Docker guidance without creating files or acquiring releases", async () => {
  const f = fixture();
  mock.preflight.mockResolvedValue({
    prerequisitesPassed: false,
    checks: [{ ok: false, message: "Install and start Docker Desktop." }],
  });
  expect(await f.run()).toBe(1);
  expect(f.io.err).toHaveBeenCalledWith("Install and start Docker Desktop.");
  expect(mock.initialize).not.toHaveBeenCalled();
  expect(mock.prepare).not.toHaveBeenCalled();
});
it.each([
  "unsafe-home",
  "corrupt-journal",
  "lost-service-authority",
  "version",
  "port",
  "no-socket",
  "directories",
  "prepare",
  "activate",
])("does not issue a link or announce readiness after %s failure", async (kind) => {
  const f = fixture();
  if (kind === "unsafe-home") mock.exists.mockRejectedValue(new Error("private detail"));
  if (kind === "corrupt-journal") {
    mock.exists.mockResolvedValue(true);
    mock.service.mockRejectedValue(new Error("private detail"));
  }
  if (kind === "lost-service-authority") {
    mock.exists.mockResolvedValue(true);
    mock.update.mockResolvedValue({ phase: "committed", previous: null });
  }
  if (kind === "version") f.context.version = "../../private-detail";
  if (kind === "port") f.context.env.LOCALDOT_PORT = "80";
  if (kind === "no-socket") mock.probes.mockReturnValue({});
  if (kind === "directories") mock.initialize.mockRejectedValue(new Error("private detail"));
  if (kind === "prepare") mock.prepare.mockRejectedValue(new Error("private detail"));
  if (kind === "activate") mock.activate.mockRejectedValue(new Error("private detail"));
  expect(await f.run()).toBe(1);
  expect(mock.open).not.toHaveBeenCalled();
  expect(JSON.stringify(f.io.out.mock.calls)).not.toContain("localDot is ready");
  expect(JSON.stringify(f.io.err.mock.calls)).not.toContain("private detail");
});
it("keeps the lock until cancellation cleanup settles and does not issue a link", async () => {
  const f = fixture();
  let close!: () => void,
    settled = false;
  mock.activate.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      close = resolve;
    });
    return { configuration: { settings: f.settings } };
  });
  const done = f.run().finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(mock.activate).toHaveBeenCalledOnce());
  f.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.events).not.toContain("unlock");
  close();
  expect(await done).toBe(130);
  expect(f.events.at(-1)).toBe("unlock");
  expect(mock.open).not.toHaveBeenCalled();
});
it("does no discovery or setup when already cancelled", async () => {
  const f = fixture();
  f.controller.abort();
  expect(await f.run()).toBe(130);
  expect(mock.exists).not.toHaveBeenCalled();
});
it("updates progress, delivers the ready link once, and closes the temporary UI", async () => {
  const f = fixture();
  const browser = {
    report: vi.fn(),
    starting: vi.fn(),
    finish: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
  mock.browser.mockResolvedValue(browser);
  mock.activate.mockImplementation(async (_settings, _identity, _helper, _signal, report) => {
    for (const role of ["brain", "desktop", "browser", "gate"]) report({ role, phase: "ready" });
    return { configuration: { settings: { ...f.settings, port: 4750 } } };
  });
  mock.open.mockImplementation(async (_context, output) => {
    output.out(`http://127.0.0.1:4750/#code=${"d".repeat(43)}`);
    return 0;
  });
  expect(await f.run()).toBe(0);
  expect(browser.report).toHaveBeenCalledTimes(4);
  expect(browser.starting).toHaveBeenCalledOnce();
  expect(browser.finish).toHaveBeenCalledWith(
    "ready",
    `http://127.0.0.1:4750/#code=${"d".repeat(43)}`,
  );
  expect(browser.close).toHaveBeenCalledOnce();
  expect(mock.launch).not.toHaveBeenCalled();
});
it("keeps successful installation successful when browser delivery fails", async () => {
  const f = fixture();
  const browser = {
    report: vi.fn(),
    starting: vi.fn(),
    finish: vi.fn().mockResolvedValue(false),
    close: vi.fn(),
  };
  mock.browser.mockResolvedValue(browser);
  mock.launch.mockResolvedValue(false);
  expect(await f.run()).toBe(0);
  expect(mock.launch).toHaveBeenCalledWith(
    `http://127.0.0.1:4891/#code=${"c".repeat(43)}`,
    f.controller.signal,
  );
  expect(f.io.out).toHaveBeenCalledWith(`http://127.0.0.1:4891/#code=${"c".repeat(43)}`);
  expect(f.io.err).toHaveBeenCalledWith("Could not open the browser. Use the sign-in link above.");
  expect(browser.close).toHaveBeenCalled();
});
it("closes progress on setup failure without launching or issuing a sign-in link", async () => {
  const f = fixture();
  const browser = {
    report: vi.fn(),
    starting: vi.fn(),
    finish: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  };
  mock.browser.mockResolvedValue(browser);
  mock.prepare.mockRejectedValue(new Error("private error"));
  expect(await f.run()).toBe(1);
  expect(browser.finish).toHaveBeenCalledWith("failed");
  expect(browser.close).toHaveBeenCalledOnce();
  expect(mock.open).not.toHaveBeenCalled();
  expect(mock.launch).not.toHaveBeenCalled();
});
it("opens the fresh link for an existing installation without a progress listener", async () => {
  const f = fixture();
  mock.exists.mockResolvedValue(true);
  mock.service.mockResolvedValue({ configuration: { settings: f.settings } });
  mock.up.mockImplementation(async (_context, output) => {
    output.out(`http://127.0.0.1:4891/#code=${"e".repeat(43)}`);
    return 0;
  });
  expect(await f.run()).toBe(0);
  expect(mock.browser).not.toHaveBeenCalled();
  expect(mock.launch).toHaveBeenCalledWith(
    `http://127.0.0.1:4891/#code=${"e".repeat(43)}`,
    f.controller.signal,
  );
});
it("returns interrupted status if cancellation arrives during the final browser launch", async () => {
  const f = fixture();
  mock.launch.mockImplementation(async () => {
    f.controller.abort();
    return false;
  });
  expect(await f.run()).toBe(130);
});
