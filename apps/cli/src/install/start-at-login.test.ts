import { afterEach, expect, it, vi } from "vitest";
import { runStartAtLogin } from "./start-at-login.ts";

const mock = vi.hoisted(() => ({
  read: vi.fn(),
  helper: vi.fn(),
  lock: vi.fn(),
  verify: vi.fn(),
  set: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./service-journal.ts", () => ({
  serviceJournalStore: () => ({ read: mock.read }),
  verifyServiceConfiguration: mock.verify,
}));
vi.mock("./promote-release.ts", () => ({ readInstalledLockHelper: mock.helper }));
vi.mock("./install-lock.ts", () => ({
  withInstallLock: mock.lock,
  keydLockAcquirer: () => undefined,
}));
vi.mock("./login-agent.ts", () => ({
  setStartAtLogin: mock.set,
  startAtLoginStore: () => ({ read: mock.status }),
  nodeLoginAgentHost: () => ({ fake: true }),
}));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});
const io = () => ({ out: vi.fn(), err: vi.fn() });
const context = { home: "/private/tmp/home", signal: new AbortController().signal };
const configuration = {
  settings: { state: "/private/tmp/home/install" },
  release: { version: "1.2.3" },
};

it("prints off for a fresh installation without taking the lock", async () => {
  mock.status.mockResolvedValue(null);
  const out = io();
  expect(await runStartAtLogin(context, "status", out)).toBe(0);
  expect(out.out).toHaveBeenCalledWith("off");
  expect(mock.lock).not.toHaveBeenCalled();
});

it("turns it on under the install lock against the verified journaled configuration", async () => {
  let locked = false;
  mock.read.mockResolvedValue({ configuration });
  mock.helper.mockResolvedValue({ keydPath: "/verified/keyd" });
  mock.lock.mockImplementation(async (_s, _sig, _a, work) => {
    locked = true;
    try {
      return await work();
    } finally {
      locked = false;
    }
  });
  mock.verify.mockImplementation(async () => expect(locked).toBe(true));
  mock.set.mockImplementation(async () => {
    expect(locked).toBe(true);
    return "on";
  });
  const out = io();
  expect(await runStartAtLogin(context, "on", out)).toBe(0);
  expect(mock.set).toHaveBeenCalledWith(configuration, true, { fake: true }, context.signal);
  expect(out.out).toHaveBeenCalledWith("localDot will start when you log in.");
});

it("changes nothing when another installation operation holds the lock", async () => {
  mock.read.mockResolvedValue({ configuration });
  mock.helper.mockResolvedValue({ keydPath: "/verified/keyd" });
  mock.lock.mockRejectedValue(new Error("Another installation operation is running."));
  const out = io();
  expect(await runStartAtLogin(context, "on", out)).toBe(1);
  expect(mock.set).not.toHaveBeenCalled();
  expect(out.err).toHaveBeenCalledWith(expect.stringContaining("try again"));
});
