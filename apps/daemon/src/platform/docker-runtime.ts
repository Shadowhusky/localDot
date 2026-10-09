import type { HostCheck, HostPlatform } from "./host.ts";

export type DockerFlavor = "desktop" | "engine" | "rootless";

export interface DockerRuntime {
  flavor: DockerFlavor;
  osType: string;
  cgroup: string | null;
  limits: { memory: boolean; swap: boolean; cpu: boolean; pids: boolean };
  // Docker from the Snap Store keeps its data under /var/snap.
  snap: boolean;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Reads Docker's /info. Docker Desktop names itself in OperatingSystem; rootless Docker lists
// name=rootless among its security options.
export function dockerRuntime(info: unknown): DockerRuntime | null {
  if (!object(info)) return null;
  const options = Array.isArray(info.SecurityOptions) ? info.SecurityOptions : [];
  const flavor: DockerFlavor =
    typeof info.OperatingSystem === "string" && /^Docker Desktop(?:\s|$)/.test(info.OperatingSystem)
      ? "desktop"
      : options.some(
            (option) => typeof option === "string" && /(?:^|,)name=rootless(?:,|$)/.test(option),
          )
        ? "rootless"
        : "engine";
  return {
    flavor,
    osType: typeof info.OSType === "string" ? info.OSType : "",
    cgroup: typeof info.CgroupVersion === "string" ? info.CgroupVersion : null,
    limits: {
      memory: info.MemoryLimit === true,
      swap: info.SwapLimit === true,
      cpu: info.CpuCfsQuota === true,
      pids: info.PidsLimit === true,
    },
    snap: typeof info.DockerRootDir === "string" && info.DockerRootDir.startsWith("/var/snap/"),
  };
}

export function dockerName(flavor: DockerFlavor): string {
  return flavor === "desktop"
    ? "Docker Desktop"
    : flavor === "rootless"
      ? "Rootless Docker"
      : "Docker Engine";
}

// What to do when internal networks still get a gateway: the engine predates isolated gateway mode.
export function isolationFix(flavor: DockerFlavor): string {
  return flavor === "desktop"
    ? "Update Docker Desktop: localDot needs Docker Engine 28 or later."
    : `Update ${dockerName(flavor)} to version 28 or later (docs.docker.com/engine/install).`;
}

// Docker drops a limit the kernel cannot apply and only warns, so a computer could take the whole
// machine. Each missing limit fails with the way to turn it on for this kind of Docker.
export function dockerRuntimeChecks(runtime: DockerRuntime, host: HostPlatform): HostCheck[] {
  if (host.os === "macos") return [];
  const name = "docker-limits";
  const docker = dockerName(runtime.flavor);
  if (runtime.osType !== "linux")
    return [
      {
        name,
        ok: false,
        detail: `${docker} runs Windows containers. Switch it to Linux containers, then try again.`,
      },
    ];
  const missing = [
    !runtime.limits.memory && "memory",
    !runtime.limits.pids && "process",
    !runtime.limits.cpu && "processor",
  ].filter((limit): limit is string => typeof limit === "string");
  if (missing.length === 0)
    return [
      {
        name,
        ok: true,
        detail: `${docker} can limit each computer's memory, processor and processes.`,
      },
    ];
  const what = `${docker} can't set ${list(missing)} limits here, so one computer could use up this machine.`;
  let fix: string;
  if (runtime.flavor === "rootless")
    fix =
      runtime.cgroup === "2"
        ? "Let it set limits: create /etc/systemd/system/user@.service.d/delegate.conf with [Service] Delegate=cpu cpuset io memory pids, run sudo systemctl daemon-reload, then sign out and in again."
        : "Rootless Docker needs cgroup v2 for limits. Use a newer Linux (Ubuntu 22.04 or later) or the regular Docker Engine.";
  else if (runtime.flavor === "desktop") fix = "Update Docker Desktop, then restart it.";
  else if (host.wsl) fix = "Update WSL: run wsl --update in PowerShell, then wsl --shutdown.";
  else
    fix =
      "Turn on the kernel's memory controller: add cgroup_enable=memory cgroup_memory=1 to the kernel command line (on a Raspberry Pi, /boot/firmware/cmdline.txt), then restart the machine.";
  // The processor limit alone is a fairness setting, not containment.
  const ok = runtime.limits.memory && runtime.limits.pids;
  return [{ name, ok, detail: `${what} ${fix}` }];
}

function list(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// How to reach Docker when its socket refuses or is missing.
export function socketFix(error: unknown, host: HostPlatform): string | null {
  if (host.os !== "linux") return null;
  const code = /\b(EACCES|ENOENT|ECONNREFUSED)\b/.exec(
    error instanceof Error ? error.message : "",
  )?.[1];
  if (code === "EACCES")
    return "Let your user use Docker: sudo usermod -aG docker $USER, then sign out and in again.";
  if (code === "ENOENT" || code === "ECONNREFUSED")
    return host.wsl
      ? "Start Docker: open Docker Desktop on Windows with WSL integration on for this distro, or run sudo systemctl start docker."
      : "Start Docker: sudo systemctl start docker. No Docker yet? Install Docker Engine from docs.docker.com/engine/install.";
  return null;
}
