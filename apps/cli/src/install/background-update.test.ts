import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_APP_UPDATES } from "../../../../packages/protocol/src/app-update.ts";
import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { applyPreparedOnLaunch, prepareBackgroundUpdate } from "./background-update.ts";

const mock = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  services: vi.fn(),
  journal: vi.fn(),
  prepare: vi.fn(),
  images: vi.fn(),
  verify: vi.fn(),
  helper: vi.fn(),
  activate: vi.fn(),
}));
vi.mock("./private-record.ts", () => ({
  privateRecordStore: (_: string, name: string) => ({
    read: async () => mock.files.get(name) ?? null,
    save: async (record: unknown) => {
      mock.files.set(name, record);
    },
  }),
}));
vi.mock("./service-journal.ts", () => ({ serviceJournalStore: () => ({ read: mock.services }) }));
vi.mock("./update-journal.ts", () => ({ updateJournalStore: () => ({ read: mock.journal }) }));
vi.mock("./prepare-release.ts", () => ({ withPreparedRelease: mock.prepare }));
vi.mock("./prepare-images.ts", () => ({ prepareInstalledReleaseImages: mock.images }));
vi.mock("./promote-release.ts", () => ({
  readInstalledRelease: mock.verify,
  readInstalledLockHelper: mock.helper,
}));
vi.mock("./activate-release.ts", () => ({ activateInstalledRelease: mock.activate }));
const identity = (version: string) => ({
  version,
  packageSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
});
const config: ServiceConfiguration = {
  release: identity("1.0.0"),
  configuration: "c".repeat(64),
  settings: {
    state: "/private/example/install",
    home: "/private/example",
    userHome: "/Users/example",
    uid: 501,
    node: "/node",
    dockerSocket: "/docker.sock",
    ownerId: "d".repeat(32),
    port: 4750,
  },
};
const candidate = identity("1.1.0"),
  signal = new AbortController().signal;
const io = { out: vi.fn(), err: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  mock.files.clear();
  mock.services.mockResolvedValue({ phase: "running", configuration: config });
  mock.journal.mockResolvedValue({
    v: 1,
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    previous: null,
    candidate: config.release,
    phase: "committed",
  });
  mock.prepare.mockImplementation(async (_state, _version, s, work) =>
    work({ identity: candidate }, s),
  );
  mock.images.mockResolvedValue(undefined);
  mock.verify.mockResolvedValue({});
  mock.helper.mockResolvedValue({ keydPath: "/verified/keyd" });
  mock.activate.mockResolvedValue({ configuration: { ...config, release: candidate } });
});
const prepare = () =>
  prepareBackgroundUpdate({ home: config.settings.home, version: "1.1.0", signal }, io);
const apply = () => applyPreparedOnLaunch(config, signal, io);
it("prepares exact pinned images without activation while the app runs", async () => {
  expect(await prepare()).toBe(0);
  expect(mock.images).toHaveBeenCalledWith(
    config.settings.state,
    candidate,
    config.settings.dockerSocket,
    signal,
  );
  expect(mock.files.get("prepared-app-update.json")).toMatchObject({
    previous: config.release,
    candidate,
  });
  expect(mock.activate).not.toHaveBeenCalled();
  expect(await apply()).toBeNull();
  expect(mock.activate).not.toHaveBeenCalled();
});
it("re-verifies and consumes a saved candidate only after services stop", async () => {
  await prepare();
  mock.services.mockResolvedValue({ phase: "stopped", configuration: config });
  mock.activate.mockImplementation(async () => {
    expect(mock.files.get("prepared-app-update.json")).toMatchObject({ candidate: null });
    return { configuration: { ...config, release: candidate } };
  });
  expect((await apply())?.release).toEqual(candidate);
  expect(mock.verify).toHaveBeenCalledWith(config.settings.state, candidate, signal);
  expect(mock.activate).toHaveBeenCalledTimes(1);
  expect(await apply()).toBeNull();
});
it("does not repeat a failed activation at the next launch", async () => {
  await prepare();
  mock.services.mockResolvedValue({ phase: "stopped", configuration: config });
  mock.activate.mockRejectedValueOnce(new Error("rollback"));
  await expect(apply()).rejects.toThrow("rollback");
  expect(await apply()).toBeNull();
  expect(mock.activate).toHaveBeenCalledTimes(1);
});
it.each(["preference", "changed-source", "damaged-payload"])(
  "leaves the current app intact for %s",
  async (kind) => {
    await prepare();
    mock.services.mockResolvedValue({ phase: "stopped", configuration: config });
    if (kind === "preference")
      mock.files.set("app-update.json", {
        preferences: { ...DEFAULT_APP_UPDATES, installOnLaunch: false },
      });
    if (kind === "changed-source")
      mock.files.set("prepared-app-update.json", { v: 1, previous: identity("0.9.0"), candidate });
    if (kind === "damaged-payload") mock.verify.mockRejectedValueOnce(new Error("bad signature"));
    expect(await apply()).toBeNull();
    expect(mock.activate).not.toHaveBeenCalled();
  },
);
it("does not publish readiness if image preparation fails", async () => {
  mock.images.mockRejectedValueOnce(new Error("wrong digest"));
  expect(await prepare()).toBe(1);
  expect(mock.files.has("prepared-app-update.json")).toBe(false);
});
it("does not recover or activate an unfinished update in the background", async () => {
  mock.journal.mockResolvedValueOnce({ ...(await mock.journal()), phase: "quiescing" });
  expect(await prepare()).toBe(1);
  expect(mock.images).not.toHaveBeenCalled();
  expect(mock.activate).not.toHaveBeenCalled();
});
