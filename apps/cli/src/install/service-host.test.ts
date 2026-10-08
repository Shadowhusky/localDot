import { afterEach, expect, it, vi } from "vitest";
import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { serviceConfigurationId, serviceLocation } from "./service-definition.ts";
import { installedServiceHost, launchedServicePid } from "./service-host.ts";

const hooks = vi.hoisted(() => ({
  verify: vi.fn(),
  owner: vi.fn(),
  command: vi.fn(),
  readiness: vi.fn(),
}));
vi.mock("./service-command.ts", () => ({ runServiceCommand: hooks.command }));
vi.mock("./service-readiness.ts", () => ({
  verifyServiceReadiness: hooks.readiness,
  waitForServiceReadiness: hooks.readiness,
}));
vi.mock("./service-journal.ts", async (original) => ({
  ...(await original<typeof import("./service-journal.ts")>()),
  verifyServiceConfiguration: hooks.verify,
  verifyServiceOwner: hooks.owner,
}));
afterEach(() => {
  hooks.verify.mockReset();
  hooks.owner.mockReset();
  hooks.command.mockReset();
  hooks.readiness.mockReset();
});
const signal = () => new AbortController().signal;
function fixture() {
  const settings = {
    state: "/private/test/install",
    home: "/private/test/home",
    userHome: "/Users/test",
    node: "/usr/local/bin/node",
    dockerSocket: "/private/test/docker.sock",
    uid: process.getuid?.() ?? -1,
    port: 4750,
    ownerId: "e".repeat(32),
  };
  const release = {
    version: "1.2.3",
    packageSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  const config: ServiceConfiguration = {
    settings,
    release,
    configuration: serviceConfigurationId(settings, release),
  };
  const definitions = serviceLocation(
    settings.state,
    settings.home,
    settings.uid,
    settings.ownerId,
    config.configuration,
  );
  hooks.verify.mockResolvedValue(definitions);
  hooks.owner.mockImplementation(async (config) => structuredClone(config));
  hooks.command.mockResolvedValue({ code: 0, stdout: "41\n", stderr: "" });
  hooks.readiness.mockResolvedValue({ ready: true });
  const checks = {
    remove: vi.fn(async () => {}),
    contain: vi.fn(async () => {}),
    isolation: vi.fn(async (_config: ServiceConfiguration) => {}),
  };
  return { config, definitions, checks, host: installedServiceHost(settings, checks) };
}
it("reverifies owned definitions immediately before each fixed launch operation", async () => {
  const f = fixture(),
    s = signal();
  await f.host.bootstrap(f.config, "keyd", s);
  expect(hooks.command).toHaveBeenCalledWith(f.definitions.keyd, "bootstrap", s);
  expect(await f.host.start(f.config, "keyd", s)).toBe(41);
  expect(hooks.verify).toHaveBeenCalledTimes(2);
  expect(hooks.command).toHaveBeenLastCalledWith(f.definitions.keyd, "kickstart", s);
  expect(hooks.verify.mock.invocationCallOrder[1]).toBeLessThan(
    hooks.command.mock.invocationCallOrder[1] ?? 0,
  );
});
it.each(["scope", "owner", "unverified", "nonzero"])(
  "refuses %s command authority",
  async (kind) => {
    const f = fixture();
    if (kind === "scope") {
      f.config.settings.home = "/foreign/home";
      f.config.configuration = serviceConfigurationId(f.config.settings, f.config.release);
    }
    if (kind === "owner")
      hooks.verify.mockResolvedValue({
        ...f.definitions,
        keyd: { ...f.definitions.keyd, ownerId: "f".repeat(32) },
      });
    if (kind === "unverified") hooks.verify.mockRejectedValue(new Error("bad signature"));
    if (kind === "nonzero")
      hooks.command.mockResolvedValue({ code: 5, stdout: "", stderr: "private" });
    await expect(f.host.bootstrap(f.config, "keyd", signal())).rejects.toThrow();
    if (kind !== "nonzero") expect(hooks.command).not.toHaveBeenCalled();
  },
);
it("requires readiness before and after isolation and snapshots its expected identity", async () => {
  const f = fixture(),
    events: string[] = [];
  hooks.readiness.mockImplementation(async (expected) => {
    events.push("ready");
    expect(expected.identity.release.version).toBe("1.2.3");
  });
  f.checks.isolation.mockImplementation(async (config) => {
    events.push("isolation");
    config.release.version = "9.0.0";
  });
  await f.host.healthy(f.config, { keyd: 41, daemon: 42 }, signal());
  expect(events).toEqual(["ready", "isolation", "ready"]);
  expect(f.config.release.version).toBe("1.2.3");
});
it.each(["first-readiness", "isolation", "last-readiness"])(
  "refuses failed %s before startup commitment",
  async (kind) => {
    const f = fixture();
    if (kind === "first-readiness") hooks.readiness.mockRejectedValue(new Error("not ready"));
    if (kind === "isolation") f.checks.isolation.mockRejectedValue(new Error("not isolated"));
    if (kind === "last-readiness")
      hooks.readiness
        .mockResolvedValueOnce({ ready: true })
        .mockRejectedValueOnce(new Error("restarted"));
    await expect(f.host.healthy(f.config, { keyd: 41, daemon: 42 }, signal())).rejects.toThrow();
    if (kind === "first-readiness") expect(f.checks.isolation).not.toHaveBeenCalled();
  },
);
it.each([
  "",
  "0",
  "-1",
  "41 42",
  "41\n42\n",
  "pid=41",
  "41\r\n",
  "2147483648",
  "1e2",
  " 41",
  "41\n\n",
])("rejects ambiguous PID output %j", (stdout) => {
  expect(() => launchedServicePid({ code: 0, stdout, stderr: "" })).toThrow();
});
it("accepts only documented successful kickstart PID output", () => {
  expect(launchedServicePid({ code: 0, stdout: "41\n", stderr: "" })).toBe(41);
  expect(launchedServicePid({ code: 0, stdout: "41", stderr: "" })).toBe(41);
  expect(() => launchedServicePid({ code: 1, stdout: "41", stderr: "" })).toThrow();
  expect(() => launchedServicePid({ code: 0, stdout: "41", stderr: "warning" })).toThrow();
});
it("rechecks private ownership before retirement effects without requiring executable health", async () => {
  const f = fixture(),
    s = signal();
  hooks.verify.mockRejectedValue(new Error("damaged executable"));
  await f.host.authorizeRetirement(f.config, s);
  await f.host.remove(f.config, "daemon", 42, s);
  await f.host.contain(f.config, s);
  expect(hooks.owner).toHaveBeenCalledTimes(3);
  expect(hooks.verify).not.toHaveBeenCalled();
  expect(f.checks.remove).toHaveBeenCalledWith(f.config, "daemon", 42, s);
  hooks.owner.mockRejectedValue(new Error("wrong owner"));
  await expect(f.host.remove(f.config, "keyd", 41, s)).rejects.toThrow();
  expect(f.checks.remove).toHaveBeenCalledTimes(1);
});
