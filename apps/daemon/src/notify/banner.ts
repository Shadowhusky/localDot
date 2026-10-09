import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BannerKind } from "@localdot/protocol";
import { bannerCommand, type ExecFile, type MacNotifier, macNotifier } from "./mac.ts";

export interface HostBanner {
  kind: BannerKind;
  notifier: MacNotifier;
}

export interface HostBannerProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  uid: number | undefined;
  exists(path: string): boolean;
  // Names in a directory, or none when it cannot be read.
  list(path: string): string[];
}

const NOTIFY_SEND = "/usr/bin/notify-send";

export function systemBannerProbe(): HostBannerProbe {
  return {
    platform: process.platform,
    env: process.env,
    uid: process.getuid?.(),
    exists: existsSync,
    list(path) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
  };
}

export interface LiveBanner {
  kind(): BannerKind;
  notifier: MacNotifier;
}

// A Linux desktop session can begin after the daemon (lingering starts it at boot), so until a
// screen is found, each banner and each look at Settings searches again.
export function liveHostBanner(detect: () => HostBanner = () => hostBanner()): LiveBanner {
  let found = detect();
  const current = () => {
    if (found.kind === "none") found = detect();
    return found;
  };
  return {
    kind: () => current().kind,
    notifier: {
      get available() {
        return current().notifier.available;
      },
      show: (title, body) => current().notifier.show(title, body),
    },
  };
}

// macOS shows banners with osascript; a Linux desktop with notify-send over the session bus. A
// machine nobody signs in to on a screen gets none, and Settings says so.
export function hostBanner(
  probe: HostBannerProbe = systemBannerProbe(),
  opts: { execFile?: ExecFile; now?: () => number } = {},
): HostBanner {
  if (probe.platform === "darwin") return { kind: "mac", notifier: macNotifier(opts) };
  const none: HostBanner = {
    kind: "none",
    notifier: { available: false, show: async () => "unavailable" },
  };
  if (probe.platform !== "linux" || probe.uid === undefined || !probe.exists(NOTIFY_SEND))
    return none;
  // A service runs with a cleared environment, so the bus and the screen are found where
  // systemd and the display servers put them for this user.
  const runtime = `/run/user/${probe.uid}`;
  const bus =
    probe.env.DBUS_SESSION_BUS_ADDRESS ??
    (probe.exists(join(runtime, "bus")) ? `unix:path=${join(runtime, "bus")}` : undefined);
  const screen =
    Boolean(probe.env.WAYLAND_DISPLAY || probe.env.DISPLAY) ||
    probe.list(runtime).some((name) => /^wayland-\d+$/.test(name)) ||
    probe.list("/tmp/.X11-unix").some((name) => /^X\d+$/.test(name));
  if (!bus || !screen) return none;
  return {
    kind: "desktop",
    notifier: bannerCommand({
      available: true,
      file: NOTIFY_SEND,
      args: (title, body) => ["--app-name=localDot", "--", title, body],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: probe.env.HOME,
        LANG: "C.UTF-8",
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: bus,
      },
      failure: "a desktop notification could not be shown",
      ...opts,
    }),
  };
}
