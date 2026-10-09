import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { availableInstallDisk, defaultDockerSockets, installDockerSocket } from "./host-probes.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "localdot-preflight-fs-"));
  roots.push(path);
  return realpath(path);
}
it("reads free space at the nearest owned parent without creating nested install directories", async () => {
  const root = await fixture(),
    home = join(root, "missing/app"),
    signal = new AbortController().signal;
  expect(await availableInstallDisk(home, signal)).toBeGreaterThanOrEqual(0n);
  await expect(stat(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects linked, non-directory and group-writable installation parents", async () => {
  const root = await fixture(),
    actual = join(root, "actual"),
    linked = join(root, "alias"),
    file = join(root, "file");
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, linked);
  await writeFile(file, "keep");
  const signal = new AbortController().signal;
  await expect(availableInstallDisk(join(linked, "home"), signal)).rejects.toThrow();
  await expect(availableInstallDisk(file, signal)).rejects.toThrow();
  await chmod(actual, 0o770);
  await expect(availableInstallDisk(join(actual, "home"), signal)).rejects.toThrow();
});
it.each(["relative", "/", "/private/tmp/../tmp/test", "/private/tmp/bad\nname"])(
  "rejects invalid home %j",
  async (home) => {
    await expect(availableInstallDisk(home, new AbortController().signal)).rejects.toThrow();
  },
);
it.each([
  "tcp://127.0.0.1:2375",
  "ssh://remote",
  "unix://relative",
  "unix:///private/tmp/../socket",
  "",
])(
  "refuses explicit unsupported Docker endpoints without contacting anything: %s",
  async (host) => {
    await expect(
      installDockerSocket({ DOCKER_HOST: host }, new AbortController().signal),
    ).rejects.toThrow();
  },
);
it("a missing explicitly selected socket is not replaced with another engine", async () => {
  const root = await fixture();
  await expect(
    installDockerSocket(
      { DOCKER_HOST: `unix://${join(root, "missing.sock")}` },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Configured Docker socket unavailable");
});
it("looks for the system, rootless and Docker Desktop sockets on Linux, and keeps macOS's two", () => {
  expect(defaultDockerSockets("linux", { XDG_RUNTIME_DIR: "/run/user/1000" })).toEqual([
    "/var/run/docker.sock",
    "/run/user/1000/docker.sock",
    join(homedir(), ".docker/desktop/docker.sock"),
  ]);
  expect(defaultDockerSockets("linux", { XDG_RUNTIME_DIR: "relative/run" })).toHaveLength(2);
  expect(defaultDockerSockets("darwin", { XDG_RUNTIME_DIR: "/run/user/1000" })).toEqual([
    join(homedir(), ".docker/run/docker.sock"),
    "/var/run/docker.sock",
  ]);
});
