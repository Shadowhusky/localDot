import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export type HostOs = "macos" | "linux" | "windows" | "other";

export interface HostPlatform {
  os: HostOs;
  arch: string;
  // WSL's version when this Linux runs inside Windows.
  wsl: 1 | 2 | null;
  // A systemd user manager answers: services, start at login and keep-running work.
  systemd: boolean;
  // A screen someone signs in to, where banners can show.
  desktop: boolean;
  // systemd keeps this user's services running with nobody signed in.
  linger: boolean;
  user: string;
}

export interface HostProbe {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  uid: number | undefined;
  user: string;
  read(path: string): string | null;
  exists(path: string): boolean;
}

export function systemHostProbe(env: NodeJS.ProcessEnv = process.env): HostProbe {
  let user = env.USER ?? "";
  try {
    user = userInfo().username;
  } catch {}
  return {
    platform: process.platform,
    arch: process.arch,
    env,
    uid: process.getuid?.(),
    user,
    read(path) {
      try {
        return readFileSync(path, "utf8").slice(0, 4096);
      } catch {
        return null;
      }
    },
    exists: existsSync,
  };
}

export function detectHost(probe: HostProbe = systemHostProbe()): HostPlatform {
  const os: HostOs =
    probe.platform === "darwin"
      ? "macos"
      : probe.platform === "linux"
        ? "linux"
        : probe.platform === "win32"
          ? "windows"
          : "other";
  const base = { os, arch: probe.arch, user: probe.user };
  if (os !== "linux")
    return { ...base, wsl: null, systemd: false, desktop: os === "macos", linger: false };
  const release = probe.read("/proc/sys/kernel/osrelease") ?? "";
  const wsl = /microsoft/i.test(release)
    ? /WSL2|microsoft-standard/i.test(release)
      ? 2
      : 1
    : null;
  const runtime =
    probe.env.XDG_RUNTIME_DIR || (probe.uid !== undefined ? `/run/user/${probe.uid}` : "");
  const systemd =
    probe.exists("/run/systemd/system") &&
    runtime !== "" &&
    probe.exists(join(runtime, "systemd", "private"));
  const desktop = Boolean(probe.env.WAYLAND_DISPLAY || probe.env.DISPLAY);
  const linger =
    /^[a-z_][a-z0-9_.-]{0,31}\$?$/i.test(probe.user) &&
    probe.exists(join("/var/lib/systemd/linger", probe.user));
  return { ...base, wsl, systemd, desktop, linger };
}

export function hostName(host: Pick<HostPlatform, "os" | "wsl">): string {
  if (host.os === "macos") return "macOS";
  if (host.os === "windows") return "Windows";
  if (host.wsl) return `Linux in WSL ${host.wsl}`;
  return host.os === "linux" ? "Linux" : "this system";
}

export interface HostCheck {
  name: string;
  ok: boolean;
  detail: string;
}

// What this machine needs to run localDot, in plain words with the fix. macOS has its own
// installer checks, so it gets none here.
export function hostChecks(host: HostPlatform): HostCheck[] {
  const name = "host-platform";
  if (host.os === "macos") return [];
  if (host.os === "windows")
    return [
      {
        name,
        ok: false,
        detail:
          "On Windows, localDot runs inside WSL 2. Open PowerShell, run wsl --install -d Ubuntu, then install localDot in Ubuntu.",
      },
    ];
  if (host.os !== "linux")
    return [{ name, ok: false, detail: "localDot runs on macOS, Linux and Windows (WSL 2)." }];
  if (host.wsl === 1)
    return [
      {
        name,
        ok: false,
        detail:
          "This is WSL 1, which can't run the computers. In PowerShell, run wsl --set-version <your distro> 2, then try again.",
      },
    ];
  if (host.arch !== "x64" && host.arch !== "arm64")
    return [
      {
        name,
        ok: false,
        detail: `localDot needs a 64-bit Intel/AMD or Arm processor, not ${host.arch}.`,
      },
    ];
  const notes: string[] = [];
  if (!host.systemd)
    notes.push(
      host.wsl
        ? "To let localDot start on its own, turn on systemd: add [boot] systemd=true to /etc/wsl.conf, then run wsl --shutdown in PowerShell."
        : "No systemd user session, so localDot can't start on its own. Start it with localdot up.",
    );
  else if (!host.desktop && !host.linger)
    notes.push(
      `To keep localDot running after you sign out and when the machine restarts, run: sudo loginctl enable-linger ${host.user || "$USER"}`,
    );
  return [
    {
      name,
      ok: true,
      detail: [`${hostName(host)} on ${host.arch === "x64" ? "x86-64" : "Arm"}.`, ...notes].join(
        " ",
      ),
    },
  ];
}
