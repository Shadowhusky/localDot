import { DOCKER_API } from "../../../daemon/src/cells/docker.ts";

export const MIN_INSTALL_DISK_BYTES = 12n * 1024n ** 3n;
export const MIN_DOCKER_MEMORY_BYTES = 8 * 1024 ** 3;
export type Prerequisite = "host" | "disk" | "docker";
export interface InstallCheck {
  name: Prerequisite;
  ok: boolean;
  message: string;
}
export interface HostFacts {
  platform: string;
  architecture: string;
  nodeVersion: string;
  macOSVersion?: string;
  // Linux only: WSL's version, and whether a systemd user manager runs the services.
  wsl?: 1 | 2 | null;
  systemd?: boolean;
}
export interface DockerFacts {
  version: unknown;
  apiVersion: unknown;
  minimumApiVersion: unknown;
  operatingSystem: unknown;
  architecture: unknown;
  desktop: unknown;
  memoryBytes: unknown;
}
export interface InstallPreflightProbes {
  host(signal: AbortSignal): Promise<HostFacts>;
  availableDisk(home: string, signal: AbortSignal): Promise<bigint>;
  docker(signal: AbortSignal): Promise<DockerFacts>;
}
export interface InstallPrerequisites {
  prerequisitesPassed: boolean;
  checks: InstallCheck[];
}

function majorVersion(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(value))
    return undefined;
  const major = Number(value.split(".")[0]);
  return Number.isSafeInteger(major) ? major : undefined;
}
function api(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^v?\d{1,3}\.\d{1,3}$/.test(value)) return undefined;
  const [major, minor] = value.replace(/^v/, "").split(".").map(Number);
  return (major ?? 0) * 1000 + (minor ?? 0);
}
// The computers' images are built for Arm today, so Linux hosts need an arm64 processor too.
function linuxHostVerdict(host: HostFacts): InstallCheck {
  const fail = (message: string): InstallCheck => ({ name: "host", ok: false, message });
  if (host.wsl === 1)
    return fail(
      "This is WSL 1, which can't run Docker. In PowerShell, run wsl --set-version <your distro> 2, then try again.",
    );
  if (host.architecture !== "arm64")
    return fail(
      "localDot's computers run on Arm (arm64) processors for now; this machine's processor isn't supported yet.",
    );
  if ((majorVersion(host.nodeVersion) ?? -1) < 24)
    return fail("Install Node.js 24 or later before running localDot.");
  if (host.systemd !== true)
    return fail(
      host.wsl
        ? "localDot runs its services with systemd. Add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown in PowerShell, then try again."
        : "localDot runs its services with systemd, and no systemd user session answers. Sign in normally (not with su), or run: sudo loginctl enable-linger $USER",
    );
  return {
    name: "host",
    ok: true,
    message: `${host.wsl ? "Linux in WSL 2" : "Linux"}, Arm and Node.js meet the installation requirements.`,
  };
}
function hostVerdict(host: HostFacts): InstallCheck {
  let message = "macOS 14 or later on Apple Silicon is required.";
  if (host.platform === "linux") return linuxHostVerdict(host);
  if (host.platform === "win32")
    return {
      name: "host",
      ok: false,
      message:
        "On Windows, localDot runs inside WSL 2. In PowerShell, run wsl --install -d Ubuntu, then install localDot in Ubuntu.",
    };
  if (host.platform !== "darwin") return { name: "host", ok: false, message };
  if (host.architecture !== "arm64")
    return {
      name: "host",
      ok: false,
      message:
        "Use Apple Silicon with a native arm64 Node.js installation; Rosetta/x64 is unsupported.",
    };
  if ((majorVersion(host.nodeVersion) ?? -1) < 24)
    return {
      name: "host",
      ok: false,
      message: "Install Node.js 24 or later before running localDot.",
    };
  if ((majorVersion(host.macOSVersion) ?? -1) < 14) return { name: "host", ok: false, message };
  message = "macOS, Apple Silicon and Node.js meet the installation requirements.";
  return { name: "host", ok: true, message };
}
function dockerVerdict(facts: DockerFacts, platform: string): InstallCheck {
  const current = api(facts.apiVersion),
    minimum = api(facts.minimumApiVersion),
    client = api(DOCKER_API);
  const linux = platform === "linux",
    desktop = facts.desktop === true;
  if (
    (!linux && !desktop) ||
    facts.operatingSystem !== "linux" ||
    !["arm64", "aarch64"].includes(String(facts.architecture))
  )
    return {
      name: "docker",
      ok: false,
      message: linux
        ? "Docker must run Linux containers on this machine's Arm processor."
        : "Use local Docker Desktop with a Linux arm64 engine.",
    };
  if (
    (majorVersion(facts.version) ?? -1) < 28 ||
    current === undefined ||
    minimum === undefined ||
    client === undefined ||
    minimum > current ||
    minimum > client ||
    current < client
  )
    return {
      name: "docker",
      ok: false,
      message:
        linux && !desktop
          ? "Update Docker Engine to version 28 or later (docs.docker.com/engine/install)."
          : "Update Docker Desktop to an engine compatible with localDot (Engine 28 or later).",
    };
  if (
    typeof facts.memoryBytes !== "number" ||
    !Number.isSafeInteger(facts.memoryBytes) ||
    facts.memoryBytes < MIN_DOCKER_MEMORY_BYTES
  )
    return {
      name: "docker",
      ok: false,
      message:
        linux && !desktop
          ? "localDot needs a machine with at least 8 GiB of memory for its computers."
          : "Give Docker Desktop at least 8 GiB of memory in Settings → Resources, then apply and restart it.",
    };
  return {
    name: "docker",
    ok: true,
    message: `${desktop ? "Docker Desktop" : "Docker Engine"} meets the engine, architecture and memory requirements.`,
  };
}

/** No writes or installer effects. A passing result is not permission to execute an unverified release. */
export async function runInstallPreflight(
  home: string,
  signal: AbortSignal,
  probes: InstallPreflightProbes,
  platform: string = process.platform,
): Promise<InstallPrerequisites> {
  signal.throwIfAborted();
  const checks: InstallCheck[] = [];
  const linux = platform === "linux";
  try {
    const host = await probes.host(signal);
    platform = host.platform;
    checks.push(hostVerdict(host));
  } catch {
    signal.throwIfAborted();
    checks.push({
      name: "host",
      ok: false,
      message: linux
        ? "Could not verify the host requirements. Use Linux on Arm (arm64) with systemd and Node.js 24+."
        : "Could not verify the host requirements. Use macOS 14+, Apple Silicon and Node.js 24+.",
    });
  }
  signal.throwIfAborted();
  if (!checks[0]?.ok) return { prerequisitesPassed: false, checks };
  try {
    const available = await probes.availableDisk(home, signal);
    const ok = typeof available === "bigint" && available >= MIN_INSTALL_DISK_BYTES;
    checks.push({
      name: "disk",
      ok,
      message: ok
        ? "At least 12 GiB is available for localDot."
        : "Free at least 12 GiB on the installation disk before continuing.",
    });
  } catch {
    signal.throwIfAborted();
    checks.push({
      name: "disk",
      ok: false,
      message:
        "The installation directory is unavailable or unsafe. Choose a writable directory owned by your user.",
    });
  }
  signal.throwIfAborted();
  try {
    checks.push(dockerVerdict(await probes.docker(signal), platform));
  } catch {
    signal.throwIfAborted();
    checks.push({
      name: "docker",
      ok: false,
      message: linux
        ? "Install and start Docker Engine (docs.docker.com/engine/install), then retry. Use its local Unix socket; remote Docker hosts are unsupported."
        : "Install and start local Docker Desktop, then retry. Use its local Unix socket; remote Docker hosts are unsupported.",
    });
  }
  signal.throwIfAborted();
  return { prerequisitesPassed: checks.every((check) => check.ok), checks };
}
