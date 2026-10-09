import { describe, expect, it } from "vitest";
import { DockerError } from "../cells/docker.ts";
import { dockerRuntime, dockerRuntimeChecks, isolationFix, socketFix } from "./docker-runtime.ts";
import type { HostPlatform } from "./host.ts";

const linux: HostPlatform = {
  os: "linux",
  arch: "x64",
  user: "ana",
  wsl: null,
  systemd: true,
  desktop: false,
  linger: true,
};
const limits = { MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true };

describe("dockerRuntime", () => {
  it("tells Docker Desktop, rootless Docker and the native engine apart", () => {
    expect(dockerRuntime({ OperatingSystem: "Docker Desktop", OSType: "linux" })?.flavor).toBe(
      "desktop",
    );
    expect(
      dockerRuntime({
        OperatingSystem: "Ubuntu 24.04.1 LTS",
        SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"],
      })?.flavor,
    ).toBe("rootless");
    expect(
      dockerRuntime({
        OperatingSystem: "Debian GNU/Linux 13 (trixie)",
        CgroupVersion: "2",
        ...limits,
      }),
    ).toEqual({
      flavor: "engine",
      osType: "",
      cgroup: "2",
      limits: { memory: true, swap: true, cpu: true, pids: true },
      snap: false,
    });
    expect(dockerRuntime({ DockerRootDir: "/var/snap/docker/common/var-lib-docker" })?.snap).toBe(
      true,
    );
    expect(dockerRuntime(null)).toBeNull();
    expect(dockerRuntime([])).toBeNull();
  });
});

describe("dockerRuntimeChecks", () => {
  const runtime = (info: Record<string, unknown>) => {
    const parsed = dockerRuntime({ OSType: "linux", ...info });
    if (!parsed) throw new Error("unparsed");
    return parsed;
  };

  it("passes an engine that can apply every limit the computers use", () => {
    expect(dockerRuntimeChecks(runtime(limits), linux)).toEqual([
      {
        name: "docker-limits",
        ok: true,
        detail: "Docker Engine can limit each computer's memory, processor and processes.",
      },
    ]);
  });

  it("fails an engine that drops memory limits and says how to turn them on", () => {
    const [check] = dockerRuntimeChecks(runtime({ ...limits, MemoryLimit: false }), linux);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("can't set memory limits");
    expect(check?.detail).toContain("cgroup_enable=memory");
  });

  it("gives rootless Docker the delegation fix on cgroup v2 and a way out on v1", () => {
    const v2 = runtime({ SecurityOptions: ["name=rootless"], CgroupVersion: "2", PidsLimit: true });
    expect(dockerRuntimeChecks(v2, linux)[0]?.detail).toContain(
      "Delegate=cpu cpuset io memory pids",
    );
    const v1 = runtime({ SecurityOptions: ["name=rootless"], CgroupVersion: "1" });
    expect(dockerRuntimeChecks(v1, linux)[0]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("needs cgroup v2"),
    });
  });

  it("only notes a missing processor limit", () => {
    expect(dockerRuntimeChecks(runtime({ ...limits, CpuCfsQuota: false }), linux)[0]).toMatchObject(
      {
        ok: true,
        detail: expect.stringContaining("processor limits"),
      },
    );
  });

  it("asks for Linux containers and says nothing on macOS", () => {
    expect(
      dockerRuntimeChecks(runtime({ ...limits, OSType: "windows" }), linux)[0]?.detail,
    ).toContain("Switch it to Linux containers");
    expect(dockerRuntimeChecks(runtime({}), { ...linux, os: "macos" })).toEqual([]);
  });

  it("names the update for each kind of Docker", () => {
    expect(isolationFix("desktop")).toBe(
      "Update Docker Desktop: localDot needs Docker Engine 28 or later.",
    );
    expect(isolationFix("engine")).toContain("Update Docker Engine to version 28");
  });
});

describe("socketFix", () => {
  const unreachable = (code: string) =>
    new DockerError(0, `${code}; is Docker running?`, "/version");

  it("says how to get permission or start Docker on Linux", () => {
    expect(socketFix(unreachable("EACCES"), linux)).toContain("usermod -aG docker");
    expect(socketFix(unreachable("ENOENT"), linux)).toContain("sudo systemctl start docker");
    expect(socketFix(unreachable("ECONNREFUSED"), { ...linux, wsl: 2 })).toContain(
      "WSL integration",
    );
    expect(socketFix(unreachable("ETIMEDOUT"), linux)).toBeNull();
    expect(socketFix(unreachable("EACCES"), { ...linux, os: "macos" })).toBeNull();
  });
});
