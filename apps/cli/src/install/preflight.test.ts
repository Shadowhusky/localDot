import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type DockerFacts,
  type HostFacts,
  type InstallPreflightProbes,
  MIN_DOCKER_MEMORY_BYTES,
  MIN_INSTALL_DISK_BYTES,
  runInstallPreflight,
} from "./preflight.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function fixture() {
  const host: HostFacts = {
    platform: "darwin",
    architecture: "arm64",
    nodeVersion: "24.19.0",
    macOSVersion: "14.0",
  };
  const docker: DockerFacts = {
    version: "29.2.0",
    apiVersion: "1.53",
    minimumApiVersion: "1.44",
    operatingSystem: "linux",
    architecture: "arm64",
    desktop: true,
    memoryBytes: MIN_DOCKER_MEMORY_BYTES,
  };
  const probes = {
    host: vi.fn(async () => host),
    availableDisk: vi.fn(async () => MIN_INSTALL_DISK_BYTES),
    docker: vi.fn(async () => docker),
  } satisfies InstallPreflightProbes;
  return { host, docker, probes, controller: new AbortController() };
}
it("a clean Mac without Docker gets an actionable failure without creating the app home", async () => {
  const root = await mkdtemp(join(tmpdir(), "localdot-clean-mac-"));
  roots.push(root);
  const home = join(root, "not-installed"),
    f = fixture();
  f.probes.docker.mockRejectedValue(new Error("private-path-or-token"));
  const result = await runInstallPreflight(home, f.controller.signal, f.probes);
  expect(result.prerequisitesPassed).toBe(false);
  expect(result.checks.at(-1)?.message).toContain("Install and start local Docker Desktop");
  expect(JSON.stringify(result)).not.toContain("private-path-or-token");
  await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
});
it("returns prerequisite evidence without claiming release or isolation verification", async () => {
  const f = fixture();
  const result = await runInstallPreflight("/owned/home", f.controller.signal, f.probes);
  expect(result).toEqual({
    prerequisitesPassed: true,
    checks: [
      expect.objectContaining({ name: "host", ok: true }),
      expect.objectContaining({ name: "disk", ok: true }),
      expect.objectContaining({ name: "docker", ok: true }),
    ],
  });
});
it.each([
  { platform: "linux" },
  { architecture: "x64" },
  { nodeVersion: "22.1.0" },
  { macOSVersion: "13.6" },
  { macOSVersion: "unknown" },
  { nodeVersion: "24-injected" },
])("unsupported host stops before disk/Docker discovery: %j", (change) => {
  return (async () => {
    const f = fixture();
    Object.assign(f.host, change);
    const result = await runInstallPreflight("/owned/home", f.controller.signal, f.probes);
    expect(result.prerequisitesPassed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(f.probes.availableDisk).not.toHaveBeenCalled();
    expect(f.probes.docker).not.toHaveBeenCalled();
  })();
});
it.each([
  { version: "27.5.1" },
  { architecture: "amd64" },
  { operatingSystem: "windows" },
  { desktop: false },
  { memoryBytes: MIN_DOCKER_MEMORY_BYTES - 1 },
  { memoryBytes: "8589934592" },
  { memoryBytes: Number.NaN },
  { apiVersion: "1.20" },
  { minimumApiVersion: "1.99" },
  { apiVersion: "not-a-version" },
])("refuses an incompatible Docker configuration: %j", async (change) => {
  const f = fixture();
  Object.assign(f.docker, change);
  const result = await runInstallPreflight("/owned/home", f.controller.signal, f.probes);
  expect(result.prerequisitesPassed).toBe(false);
  expect(result.checks.at(-1)?.ok).toBe(false);
});
it("reports low disk while collecting the independent Docker result", async () => {
  const f = fixture();
  f.probes.availableDisk.mockResolvedValue(MIN_INSTALL_DISK_BYTES - 1n);
  const result = await runInstallPreflight("/owned/home", f.controller.signal, f.probes);
  expect(result.prerequisitesPassed).toBe(false);
  expect(result.checks[1]?.message).toContain("Free at least 12 GiB");
  expect(result.checks[2]?.ok).toBe(true);
});
it("propagates cancellation before probes and between stages", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(runInstallPreflight("/owned/home", f.controller.signal, f.probes)).rejects.toThrow();
  expect(f.probes.host).not.toHaveBeenCalled();
  const next = fixture();
  next.probes.availableDisk.mockImplementation(async () => {
    next.controller.abort();
    return MIN_INSTALL_DISK_BYTES;
  });
  await expect(
    runInstallPreflight("/owned/home", next.controller.signal, next.probes),
  ).rejects.toThrow();
  expect(next.probes.docker).not.toHaveBeenCalled();
});

function linuxFixture() {
  const f = fixture();
  Object.assign(f.host, { platform: "linux", macOSVersion: undefined, wsl: null, systemd: true });
  Object.assign(f.docker, { desktop: false });
  return f;
}

it("passes Linux on Arm with systemd and the native Docker Engine", async () => {
  const f = linuxFixture();
  const result = await runInstallPreflight("/owned/home", f.controller.signal, f.probes, "linux");
  expect(result.prerequisitesPassed).toBe(true);
  expect(result.checks[0]?.message).toBe(
    "Linux, Arm and Node.js meet the installation requirements.",
  );
  expect(result.checks[2]?.message).toBe(
    "Docker Engine meets the engine, architecture and memory requirements.",
  );
});

it.each([
  [{ wsl: 1 }, "wsl --set-version"],
  [{ wsl: 2, systemd: false }, "[boot] systemd=true"],
  [{ systemd: false }, "loginctl enable-linger"],
  [{ architecture: "x64" }, "Arm (arm64) processors for now"],
  [{ platform: "win32" }, "wsl --install -d Ubuntu"],
])("explains an unsupported Linux or Windows host in plain words: %j", async (change, words) => {
  const f = linuxFixture();
  Object.assign(f.host, change);
  const result = await runInstallPreflight("/owned/home", f.controller.signal, f.probes, "linux");
  expect(result.checks).toEqual([expect.objectContaining({ name: "host", ok: false })]);
  expect(result.checks[0]?.message).toContain(words);
  expect(f.probes.docker).not.toHaveBeenCalled();
});

it("tells a Linux host how to fix Docker in its own terms", async () => {
  const f = linuxFixture();
  Object.assign(f.docker, { version: "27.5.1" });
  const old = await runInstallPreflight("/owned/home", f.controller.signal, f.probes, "linux");
  expect(old.checks[2]?.message).toContain("Update Docker Engine to version 28");
  Object.assign(f.docker, { version: "29.2.0", memoryBytes: 4 * 1024 ** 3 });
  const small = await runInstallPreflight("/owned/home", f.controller.signal, f.probes, "linux");
  expect(small.checks[2]?.message).toBe(
    "localDot needs a machine with at least 8 GiB of memory for its computers.",
  );
  f.probes.docker.mockRejectedValue(new Error("connect EACCES"));
  const missing = await runInstallPreflight("/owned/home", f.controller.signal, f.probes, "linux");
  expect(missing.checks[2]?.message).toContain("Install and start Docker Engine");
});

it("keeps requiring Docker Desktop on macOS", async () => {
  const f = fixture();
  Object.assign(f.docker, { desktop: false });
  const result = await runInstallPreflight("/owned/home", f.controller.signal, f.probes, "darwin");
  expect(result.checks[2]).toEqual({
    name: "docker",
    ok: false,
    message: "Use local Docker Desktop with a Linux arm64 engine.",
  });
});
