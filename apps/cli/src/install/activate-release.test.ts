import { afterEach, expect, it, vi } from "vitest";
import { activateInstalledRelease } from "./activate-release.ts";

const mock = vi.hoisted(() => ({
  host: vi.fn(),
  recover: vi.fn(),
  read: vi.fn(),
  current: vi.fn(),
  prepare: vi.fn(),
  images: vi.fn(),
  activate: vi.fn(),
}));
vi.mock("./installed-update.ts", () => ({ installedUpdateHost: mock.host }));
vi.mock("./update-transaction.ts", () => ({
  recoverUpdate: mock.recover,
  activateUpdate: mock.activate,
}));
vi.mock("./service-journal.ts", () => ({
  serviceJournalStore: () => ({ read: mock.read }),
  prepareServiceConfiguration: mock.prepare,
}));
vi.mock("./prepare-images.ts", () => ({ prepareInstalledReleaseImages: mock.images }));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});
function fixture() {
  const settings = {
    state: "/private/tmp/install",
    home: "/private/tmp/home",
    userHome: "/Users/fixture",
    node: "/recorded/node",
    dockerSocket: "/recorded/docker.sock",
    uid: 501,
    port: 4880,
  };
  const identity = {
    version: "1.2.3",
    packageSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  const controller = new AbortController(),
    events: string[] = [];
  mock.host.mockReturnValue({ current: mock.current });
  mock.current.mockResolvedValue(null);
  mock.read.mockResolvedValue(null);
  mock.recover.mockImplementation(async () => {
    events.push("recover");
  });
  mock.prepare.mockImplementation(async (chosen, release) => {
    events.push("prepare");
    return { settings: chosen, release, configuration: "c".repeat(64) };
  });
  mock.images.mockImplementation(async () => {
    events.push("images");
  });
  mock.activate.mockImplementation(async () => {
    events.push("activate");
    return { phase: "committed" };
  });
  const report = vi.fn();
  return {
    settings,
    identity,
    controller,
    events,
    report,
    run: () =>
      activateInstalledRelease(settings, identity, "/verified/helper", controller.signal, report),
  };
}
it("recovers, prepares immutable configuration and downloads pins before activation", async () => {
  const f = fixture();
  expect((await f.run()).journal.phase).toBe("committed");
  expect(f.events).toEqual(["recover", "prepare", "images", "activate"]);
  expect(mock.images).toHaveBeenCalledWith(
    f.settings.state,
    f.identity,
    f.settings.dockerSocket,
    f.controller.signal,
    f.report,
  );
});
it("retains the recovered installation's port, runtime and Docker socket", async () => {
  const f = fixture();
  const recorded = {
    ...f.settings,
    port: 4991,
    node: "/original/node",
    dockerSocket: "/original/docker.sock",
    ownerId: "d".repeat(32),
  };
  mock.read.mockResolvedValue({ configuration: { settings: recorded } });
  mock.current.mockResolvedValue({ ...f.identity, version: "1.2.2" });
  await f.run();
  expect(mock.prepare).toHaveBeenCalledWith(recorded, f.identity, f.controller.signal);
  expect(mock.images.mock.calls[0]?.[2]).toBe(recorded.dockerSocket);
});
it.each(["recover", "prepare", "images"] as const)(
  "does not activate after %s fails",
  async (step) => {
    const f = fixture();
    mock[step].mockRejectedValue(new Error("failed"));
    await expect(f.run()).rejects.toThrow();
    expect(mock.activate).not.toHaveBeenCalled();
  },
);
it("refuses selected releases with no service configuration", async () => {
  const f = fixture();
  mock.current.mockResolvedValue(f.identity);
  await expect(f.run()).rejects.toThrow();
  expect(mock.images).not.toHaveBeenCalled();
  expect(mock.prepare).not.toHaveBeenCalled();
});
it("does not start another activation after cancellation during recovery", async () => {
  const f = fixture();
  mock.recover.mockImplementation(async () => {
    f.controller.abort();
  });
  await expect(f.run()).rejects.toThrow();
  expect(mock.prepare).not.toHaveBeenCalled();
});
it("snapshots the release identity before asynchronous recovery", async () => {
  const f = fixture();
  const expected = { ...f.identity };
  mock.recover.mockImplementation(async () => {
    f.identity.version = "9.9.9";
  });
  await f.run();
  expect(mock.prepare).toHaveBeenCalledWith(f.settings, expected, f.controller.signal);
});
