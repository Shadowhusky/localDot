import { describe, expect, it } from "vitest";
import { type HostBannerProbe, hostBanner } from "./banner.ts";
import type { ExecFile } from "./mac.ts";

function probe(
  over: Partial<HostBannerProbe> & { files?: string[]; dirs?: Record<string, string[]> },
) {
  const files = new Set(over.files ?? []);
  return {
    platform: "linux" as NodeJS.Platform,
    env: { HOME: "/home/ana" },
    uid: 1000,
    exists: (path: string) => files.has(path),
    list: (path: string) => over.dirs?.[path] ?? [],
    ...over,
  };
}

function recorder() {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const execFile: ExecFile = (file, args, options, callback) => {
    calls.push({ file, args, env: options.env });
    callback(null);
  };
  return { calls, execFile };
}

const desktop = {
  files: ["/usr/bin/notify-send", "/run/user/1000/bus"],
  dirs: { "/run/user/1000": ["bus", "wayland-0"] },
};

describe("hostBanner", () => {
  it("keeps the Mac banner on macOS", () => {
    expect(hostBanner(probe({ platform: "darwin" })).kind).toBe("mac");
  });

  it("uses notify-send on a Linux desktop, finding the bus and screen without the environment", async () => {
    const { calls, execFile } = recorder();
    const banner = hostBanner(probe(desktop), { execFile });
    expect(banner.kind).toBe("desktop");
    await expect(banner.notifier.show("-e dot needs you", "Open localDot")).resolves.toBe("shown");
    expect(calls[0]?.file).toBe("/usr/bin/notify-send");
    expect(calls[0]?.args).toEqual([
      "--app-name=localDot",
      "--",
      "-e dot needs you",
      "Open localDot",
    ]);
    expect(calls[0]?.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/ana",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });

  it("finds an X11 screen too", () => {
    expect(
      hostBanner(probe({ files: desktop.files, dirs: { "/tmp/.X11-unix": ["X0"] } })).kind,
    ).toBe("desktop");
  });

  it("shows nothing on a machine with no screen, no bus or no notify-send", async () => {
    const headless = hostBanner(probe({ files: desktop.files }));
    expect(headless.kind).toBe("none");
    await expect(headless.notifier.show("a", "b")).resolves.toBe("unavailable");
    expect(hostBanner(probe({ files: ["/usr/bin/notify-send"], dirs: desktop.dirs })).kind).toBe(
      "none",
    );
    expect(hostBanner(probe({ files: ["/run/user/1000/bus"], dirs: desktop.dirs })).kind).toBe(
      "none",
    );
    expect(hostBanner(probe({ platform: "win32" })).kind).toBe("none");
  });
});
