import { describe, expect, it } from "vitest";
import { detectHost, type HostProbe, hostChecks } from "./host.ts";

function probe(over: Partial<HostProbe> & { files?: Record<string, string> } = {}): HostProbe {
  const files = over.files ?? {};
  return {
    platform: "linux",
    arch: "x64",
    env: {},
    uid: 1000,
    user: "ana",
    read: (path) => files[path] ?? null,
    exists: (path) => path in files,
    ...over,
  };
}

const systemdUser = { "/run/systemd/system": "", "/run/user/1000/systemd/private": "" };

describe("detectHost", () => {
  it("reads a Linux desktop with a systemd user session", () => {
    const host = detectHost(
      probe({
        env: { WAYLAND_DISPLAY: "wayland-0" },
        files: { ...systemdUser, "/proc/sys/kernel/osrelease": "6.8.0-45-generic\n" },
      }),
    );
    expect(host).toEqual({
      os: "linux",
      arch: "x64",
      user: "ana",
      wsl: null,
      systemd: true,
      desktop: true,
      linger: false,
    });
  });

  it("tells WSL 2 from WSL 1 by the kernel release", () => {
    const wsl2 = probe({
      files: { "/proc/sys/kernel/osrelease": "5.15.167.4-microsoft-standard-WSL2" },
    });
    const wsl1 = probe({ files: { "/proc/sys/kernel/osrelease": "4.4.0-19041-Microsoft" } });
    expect(detectHost(wsl2).wsl).toBe(2);
    expect(detectHost(wsl1).wsl).toBe(1);
    expect(detectHost(wsl2).systemd).toBe(false);
  });

  it("finds a headless server's linger and the runtime directory systemd names", () => {
    const host = detectHost(
      probe({
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        files: { ...systemdUser, "/var/lib/systemd/linger/ana": "" },
      }),
    );
    expect(host).toMatchObject({ systemd: true, desktop: false, linger: true });
    expect(
      detectHost(probe({ user: "../ana", files: { "/var/lib/systemd/linger/../ana": "" } })).linger,
    ).toBe(false);
  });

  it("keeps macOS and Windows out of the Linux probes", () => {
    const read = () => {
      throw new Error("read on macOS");
    };
    expect(detectHost(probe({ platform: "darwin", arch: "arm64", read }))).toMatchObject({
      os: "macos",
      desktop: true,
      wsl: null,
    });
    expect(detectHost(probe({ platform: "win32" })).os).toBe("windows");
  });
});

describe("hostChecks", () => {
  const linux = {
    os: "linux" as const,
    arch: "x64",
    user: "ana",
    wsl: null,
    systemd: true,
    desktop: true,
    linger: false,
  };

  it("adds nothing on macOS", () => {
    expect(hostChecks({ ...linux, os: "macos" })).toEqual([]);
  });

  it("passes a Linux desktop and names it", () => {
    expect(hostChecks(linux)).toEqual([
      { name: "host-platform", ok: true, detail: "Linux on x86-64." },
    ]);
  });

  it("tells a headless server how to keep running after sign-out", () => {
    const [check] = hostChecks({ ...linux, desktop: false });
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("sudo loginctl enable-linger ana");
    expect(hostChecks({ ...linux, desktop: false, linger: true })[0]?.detail).toBe(
      "Linux on x86-64.",
    );
  });

  it("explains WSL without systemd, WSL 1 and Windows itself in plain words", () => {
    expect(hostChecks({ ...linux, wsl: 2, systemd: false })[0]).toMatchObject({
      ok: true,
      detail: expect.stringContaining("[boot] systemd=true to /etc/wsl.conf"),
    });
    expect(hostChecks({ ...linux, wsl: 1 })[0]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("wsl --set-version"),
    });
    expect(hostChecks({ ...linux, os: "windows" })[0]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("wsl --install -d Ubuntu"),
    });
    expect(hostChecks({ ...linux, arch: "ia32" })[0]?.ok).toBe(false);
  });
});
