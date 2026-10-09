import { describe, expect, it } from "vitest";
import { browserNames, browserNetworkSpec, browserSpec } from "./browser-spec.ts";
import { browserImagesFromEnv } from "./images.ts";
import { desktopSpec, gateSpec, ISOLATED_GATEWAY_OPTION, streamOptions } from "./spec.ts";
import { sampleBrowserRecord } from "./testing/sample-browser-record.ts";
import { sampleRecord } from "./testing/sample-record.ts";

describe("persistent browser container isolation", () => {
  it("mounts only the shared sign-in profile and keeps credentials and home ephemeral", () => {
    const record = sampleBrowserRecord();
    const spec = browserSpec(record, "browser-image", streamOptions(), "localdot-accounts");
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: "localdot-accounts", Target: "/profile" },
    ]);
    expect(spec.HostConfig.Tmpfs).not.toHaveProperty("/profile");
    expect(spec.HostConfig.Tmpfs["/downloads"]).toBe(
      "rw,nosuid,nodev,noexec,size=1152m,uid=1000,gid=1000,mode=0700",
    );
    for (const path of ["/config", "/home/browser", "/etc/localdot/cell"] as const)
      expect(spec.HostConfig.Tmpfs[path]).toMatch(/uid=1000,gid=1000,mode=0700/u);
    for (const forbidden of [
      "Binds",
      "Privileged",
      "CapAdd",
      "Devices",
      "PortBindings",
      "RestartPolicy",
      "PidMode",
      "IpcMode",
    ])
      expect(spec.HostConfig).not.toHaveProperty(forbidden);
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(spec.User).toBe("1000:1000");
    expect(spec.HostConfig.Init).toBe(true);
    expect(spec.HostConfig.Memory).toBeGreaterThan(0);
    expect(spec.HostConfig.MemorySwap).toBe(spec.HostConfig.Memory);
    expect(spec.HostConfig.NanoCpus).toBeGreaterThan(0);
    expect(spec.HostConfig.PidsLimit).toBeGreaterThan(0);
    expect(spec.HostConfig.NetworkMode).toBe(record.docker.internalNetwork);
    expect(Object.keys(spec.NetworkingConfig.EndpointsConfig)).toEqual([
      record.docker.internalNetwork,
    ]);
    expect(spec.Labels).toEqual({
      "localdot.cell": record.id,
      "localdot.role": "browser",
      "localdot.parent": record.parentCellId,
    });
  });

  it("gives the computer no mount of the sign-ins and no network shared with the browser", () => {
    const computer = sampleRecord();
    const record = { ...sampleBrowserRecord(), parentCellId: computer.id };
    const desktop = desktopSpec(computer, "desktop-image", streamOptions());
    const browser = browserSpec(record, "browser-image", streamOptions(), "localdot-accounts");
    expect(desktop.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: computer.docker.homeVolume, Target: "/config" },
    ]);
    expect(JSON.stringify(desktop)).not.toMatch(/accounts|profile-|remote-debugging/u);
    expect(desktop.HostConfig).not.toHaveProperty("Binds");
    expect(desktop.HostConfig).not.toHaveProperty("VolumesFrom");
    expect(Object.keys(desktop.NetworkingConfig.EndpointsConfig)).not.toContain(
      browser.HostConfig.NetworkMode,
    );
    expect(Object.keys(browser.NetworkingConfig.EndpointsConfig)).toEqual([
      record.docker.internalNetwork,
    ]);
    expect(gateSpec(computer, "gate-image").HostConfig).not.toHaveProperty("Mounts");
  });

  it("uses one-shot stdin for bootstrap and exposes neither proxy material nor a debug port", () => {
    const record = sampleBrowserRecord();
    const spec = browserSpec(record, "browser-image", streamOptions(), "localdot-accounts");
    expect(spec).toMatchObject({ OpenStdin: true, AttachStdin: true, StdinOnce: true, Tty: false });
    expect(spec).not.toHaveProperty("ExposedPorts");
    expect(spec.Env).toContain(`LOCALDOT_BROWSER_CELL_ID=${record.id}`);
    expect(spec.Env).toContain(`LOCALDOT_PARENT_CELL_ID=${record.parentCellId}`);
    expect(spec.Env.join("\n")).not.toMatch(
      /proxy.token|BEGIN CERTIFICATE|remote-debugging|9222/iu,
    );
    expect(spec.Env.some((entry) => entry.startsWith("LOCALDOT_BROWSERD_TOKEN="))).toBe(true);
    expect(spec.Env.some((entry) => entry.startsWith("LOCALDOT_STREAM_TOKEN="))).toBe(true);
  });

  it("streams the browser screen 4:2:0 unless the 4:4:4 opt-in is set", () => {
    const record = sampleBrowserRecord();
    expect(
      browserSpec(record, "browser-image", streamOptions(), "localdot-accounts").Env,
    ).toContain("LOCALDOT_STREAM_FULLCOLOR=0");
    expect(
      browserSpec(record, "browser-image", { fullcolor: true }, "localdot-accounts").Env,
    ).toContain("LOCALDOT_STREAM_FULLCOLOR=1");
  });

  it("routes the browser's service and stream through its own loopback-published gate", () => {
    const record = sampleBrowserRecord();
    const gate = gateSpec(record, "gate-image");
    expect(gate.Env).toContain(`LD_DESKTOP_ADDR=${record.docker.browserIp}`);
    expect(gate.Env).toContain(`LD_KEYD_PORT=${record.keydPort}`);
    expect(gate.HostConfig.NetworkMode).toBe(record.docker.egressNetwork);
    for (const bindings of Object.values(gate.HostConfig.PortBindings))
      expect(bindings).toEqual([{ HostIp: "127.0.0.1", HostPort: "" }]);
    expect(gate.Labels["localdot.parent"]).toBe(record.parentCellId);
    const internal = browserNetworkSpec(
      "internal",
      record.docker.internalNetwork,
      record.id,
      record.parentCellId,
    );
    expect(internal).toMatchObject({
      Internal: true,
      EnableIPv6: false,
      Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
      Labels: {
        "localdot.cell": record.id,
        "localdot.parent": record.parentCellId,
        "localdot.role": "internal",
      },
    });
    expect(
      browserNetworkSpec("egress", record.docker.egressNetwork, record.id, record.parentCellId),
    ).toMatchObject({
      EnableIPv6: false,
      Labels: {
        "localdot.cell": record.id,
        "localdot.parent": record.parentCellId,
        "localdot.role": "egress",
      },
    });
  });

  it("keeps test resource names separate and rejects path-like resource identities", () => {
    const id = sampleBrowserRecord().id;
    expect(browserNames(id, "localdot-test-").profileVolume).toBe(`localdot-test-profile-${id}`);
    expect(() => browserNames("../other")).toThrow();
    expect(() => browserNames(id, "/private/")).toThrow();
    expect(
      browserImagesFromEnv({
        LOCALDOT_BROWSER_IMAGE: "custom-browser",
        LOCALDOT_GATE_IMAGE: "custom-gate",
      }),
    ).toEqual({ browser: "custom-browser", gate: "custom-gate" });
    expect(browserImagesFromEnv({})).toEqual({
      browser: "localdot/browser:dev",
      gate: "localdot/gate:dev",
    });
  });
});

interface Rule {
  names: string[];
  action: string;
  includes?: { caps?: string[]; arches?: string[] };
  excludes?: { caps?: string[]; arches?: string[] };
  args?: { index: number; op: string; value: number; valueTwo?: number }[];
}

describe("Chromium namespace seccomp allowances without capabilities", () => {
  const text = browserSpec(
    sampleBrowserRecord(),
    "image",
    streamOptions(),
    "localdot-accounts",
  ).HostConfig.SecurityOpt.find((value) => value.startsWith("seccomp="));
  const profile = JSON.parse(text?.slice("seccomp=".length) ?? "null") as {
    defaultAction: string;
    syscalls: Rule[];
  };
  function allowed(name: string, flags: number) {
    return profile.syscalls.some((rule) => {
      if (!rule.names.includes(name) || rule.action !== "SCMP_ACT_ALLOW") return false;
      if (rule.includes?.caps?.length) return false;
      if (rule.includes?.arches && !rule.includes.arches.includes("amd64")) return false;
      if (rule.excludes?.arches?.includes("amd64")) return false;
      return (rule.args ?? []).every((arg) => {
        if (arg.index !== 0) return false;
        if (arg.op === "SCMP_CMP_MASKED_EQ")
          return (BigInt(flags) & BigInt(arg.value)) === BigInt(arg.valueTwo ?? 0);
        if (arg.op === "SCMP_CMP_EQ") return flags === arg.value;
        return false;
      });
    });
  }
  it("keeps deny-by-default and permits Chromium user/PID/network namespaces", () => {
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    for (const flags of [0x10000000, 0x20000000, 0x40000000, 0x70000000]) {
      expect(allowed("clone", flags | 17)).toBe(true);
      expect(allowed("unshare", flags)).toBe(true);
    }
    expect(allowed("chroot", 0)).toBe(true);
  });
  it("does not permit mount, UTS, IPC or cgroup namespaces through the new allowances", () => {
    for (const flag of [0x00020000, 0x04000000, 0x08000000, 0x02000000]) {
      expect(allowed("clone", 0x10000000 | flag)).toBe(false);
      expect(allowed("unshare", 0x10000000 | flag)).toBe(false);
    }
    expect(allowed("unshare", 0x00000400)).toBe(false);
    expect(allowed("mount", 0)).toBe(false);
    expect(allowed("bpf", 0)).toBe(false);
    expect(allowed("clone3", 0)).toBe(false);
  });
});
