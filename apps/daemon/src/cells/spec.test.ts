import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cellNames,
  DESKTOP_LIMITS,
  desktopSpec,
  egressNetworkSpec,
  gateSpec,
  ISOLATED_GATEWAY_OPTION,
  internalNetworkSpec,
  isolatedNetworkSpec,
  keydEnv,
  LINK,
  linkName,
  linkSpec,
  streamOptions,
} from "./spec.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const record = sampleRecord("01JXYZ0000000000000000ABCD");

describe("network specs", () => {
  it("creates every cell network internal with isolated gateway mode", () => {
    expect(internalNetworkSpec("n")).toMatchObject({
      Name: "n",
      Driver: "bridge",
      Internal: true,
      EnableIPv6: false,
      Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
      Labels: { "localdot.cell": "1" },
    });
    expect(isolatedNetworkSpec("p")).toEqual({
      Name: "p",
      Driver: "bridge",
      Internal: true,
      EnableIPv6: false,
      Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
    });
    expect(egressNetworkSpec("e")).toMatchObject({
      Name: "e",
      Driver: "bridge",
      EnableIPv6: false,
    });
    expect((egressNetworkSpec("e") as { Internal?: boolean }).Internal).toBeUndefined();
  });

  it("derives every Docker object name from the cell id and the name prefix", () => {
    expect(cellNames("X")).toEqual({
      internalNetwork: "localdot-cell-X",
      egressNetwork: "localdot-egress-X",
      homeVolume: "localdot-home-X",
      gate: "localdot-gate-X",
      desktop: "localdot-desktop-X",
    });
    expect(cellNames("X", "localdot-test-").desktop).toBe("localdot-test-desktop-X");
  });
});

describe("gateSpec", () => {
  const spec = gateSpec(record, "localdot/gate:dev");

  it("is read-only, unprivileged, capability-free and bound to 127.0.0.1", () => {
    expect(spec.User).toBe("nobody");
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: record.docker.egressNetwork,
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: 64,
      PortBindings: {
        "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        "8082/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
    });
    expect("Binds" in spec.HostConfig).toBe(false);
    expect("RestartPolicy" in spec.HostConfig).toBe(false);
    expect(spec.NetworkingConfig.EndpointsConfig[record.docker.egressNetwork]).toEqual({
      IPAMConfig: { IPv4Address: "172.25.0.10" },
    });
  });

  it("tells the relays their addresses and the cell's keyd port", () => {
    expect(spec.Env).toEqual([
      "LD_INTERNAL_ADDR=172.24.0.10",
      "LD_EGRESS_ADDR=172.25.0.10",
      "LD_DESKTOP_ADDR=172.24.0.11",
      "LD_KEYD_PORT=4760",
    ]);
  });
});

describe("desktopSpec", () => {
  const spec = desktopSpec(record, "localdot/desktop:dev", streamOptions());

  it("drops NET_RAW, keeps sudo possible, limits resources and mounts only the named home volume", () => {
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: record.docker.internalNetwork,
      CapDrop: ["NET_RAW"],
      Mounts: [{ Type: "volume", Source: record.docker.homeVolume, Target: "/config" }],
      Tmpfs: {
        "/run/localdot-desktop-browser":
          "rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=0700",
      },
      ShmSize: DESKTOP_LIMITS.shmBytes,
      Memory: DESKTOP_LIMITS.memoryBytes,
      MemorySwap: DESKTOP_LIMITS.memoryBytes,
      NanoCpus: DESKTOP_LIMITS.nanoCpus,
      PidsLimit: DESKTOP_LIMITS.pids,
    });
    expect("Binds" in spec.HostConfig).toBe(false);
    expect("SecurityOpt" in spec.HostConfig).toBe(false);
    expect("CapAdd" in spec.HostConfig).toBe(false);
    expect("RestartPolicy" in spec.HostConfig).toBe(false);
    expect(spec.NetworkingConfig.EndpointsConfig[record.docker.internalNetwork]).toEqual({
      IPAMConfig: { IPv4Address: "172.24.0.11" },
    });
  });

  it("passes the per-cell tokens, scale and fixed proxy settings into the container", () => {
    const keys = spec.Env.map((e) => e.split("=")[0]);
    expect(keys).toEqual([
      "PUID",
      "PGID",
      "TZ",
      "LOCALDOT_SCALE",
      "SELKIES_MANUAL_WIDTH",
      "SELKIES_MANUAL_HEIGHT",
      "LOCALDOT_DESKTOPD_TOKEN",
      "PASSWORD",
      "SELKIES_VIDEO_FULLCOLOR",
      ...keydEnv(record).map((entry) => entry.split("=")[0]),
    ]);
    expect(spec.Env).toContain(`LOCALDOT_DESKTOPD_TOKEN=${record.tokens.desktopd}`);
    expect(spec.Env).toContain(`PASSWORD=${record.tokens.stream}`);
    expect(spec.Env).toContain("SELKIES_MANUAL_WIDTH=2560");
    expect(desktopSpec({ ...record, scale: 1 }, "i", streamOptions()).Env).toContain(
      "SELKIES_MANUAL_HEIGHT=800",
    );
    expect(spec.Env.join("\n")).not.toMatch(/ld_[a-z0-9]{2,12}_|BEGIN CERTIFICATE/);
  });

  it("streams 4:2:0 unless LOCALDOT_STREAM_FULLCOLOR=1 opts in to 4:4:4", () => {
    expect(spec.Env).toContain("SELKIES_VIDEO_FULLCOLOR=false|locked");
    expect(streamOptions()).toEqual({ fullcolor: false });
    for (const value of [undefined, "0", "", "true", "yes"])
      expect(streamOptions({ LOCALDOT_STREAM_FULLCOLOR: value })).toEqual({ fullcolor: false });
    const fullcolor = streamOptions({ LOCALDOT_STREAM_FULLCOLOR: "1" });
    expect(fullcolor).toEqual({ fullcolor: true });
    expect(desktopSpec(record, "i", fullcolor).Env).toContain(
      "SELKIES_VIDEO_FULLCOLOR=true|locked",
    );
  });

  it("builds the desktop image with the same 4:2:0 default", () => {
    const dockerfile = readFileSync(
      new URL("../../../../cells/desktop/Dockerfile", import.meta.url),
      "utf8",
    );
    expect(dockerfile.match(/SELKIES_VIDEO_FULLCOLOR=\S+/gu)).toEqual([
      'SELKIES_VIDEO_FULLCOLOR="false|locked"',
    ]);
  });

  it("routes desktop programs through the forwarder with only loopback exempt", () => {
    expect(keydEnv(record)).toEqual([
      "LOCALDOT_CELL_ID=01JXYZ0000000000000000ABCD",
      "LOCALDOT_GATE_ADDR=172.24.0.10",
      "HTTP_PROXY=http://127.0.0.1:3129",
      "HTTPS_PROXY=http://127.0.0.1:3129",
      "http_proxy=http://127.0.0.1:3129",
      "https_proxy=http://127.0.0.1:3129",
      "NO_PROXY=localhost,127.0.0.1,::1",
      "no_proxy=localhost,127.0.0.1,::1",
      "NODE_USE_ENV_PROXY=1",
      "NODE_EXTRA_CA_CERTS=/etc/localdot/cell/ca.pem",
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
    ]);
  });
});

describe("container spec keys", () => {
  // Nothing beyond these reaches Docker: no Privileged, CapAdd, Binds, Devices or RestartPolicy.
  it("sets exactly the gate's and the desktop's chosen keys", () => {
    const gate = gateSpec(record, "g");
    const desktop = desktopSpec(record, "d", streamOptions());
    expect(Object.keys(gate).sort()).toEqual([
      "Env",
      "ExposedPorts",
      "HostConfig",
      "Image",
      "Labels",
      "NetworkingConfig",
      "User",
    ]);
    expect(Object.keys(gate.HostConfig).sort()).toEqual([
      "CapDrop",
      "LogConfig",
      "Memory",
      "NetworkMode",
      "PidsLimit",
      "PortBindings",
      "ReadonlyRootfs",
      "SecurityOpt",
    ]);
    expect(Object.keys(desktop).sort()).toEqual([
      "Env",
      "HostConfig",
      "Image",
      "Labels",
      "NetworkingConfig",
    ]);
    expect(Object.keys(desktop.HostConfig).sort()).toEqual([
      "CapDrop",
      "LogConfig",
      "Memory",
      "MemorySwap",
      "Mounts",
      "NanoCpus",
      "NetworkMode",
      "PidsLimit",
      "ShmSize",
      "Tmpfs",
    ]);
  });
});

describe("container logs", () => {
  it("rotates both containers' json-file logs at 10 MB, keeping 3 files", () => {
    const bounded = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };
    expect(gateSpec(record, "g").HostConfig.LogConfig).toEqual(bounded);
    expect(desktopSpec(record, "d", streamOptions()).HostConfig.LogConfig).toEqual(bounded);
  });
});

describe("capture", () => {
  const captured = { ...record, tokens: { ...record.tokens, capture: "c".repeat(43) } };

  it("starts a capturing gate as root with only what its entrypoint needs before it drops them", () => {
    const spec = gateSpec(captured, "localdot/gate:dev");
    expect(spec.User).toBe("root");
    expect(spec.HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      CapAdd: ["NET_ADMIN", "SETUID", "SETGID", "SETPCAP"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
    });
    expect(spec.Env).toContain(`LD_CAPTURE_TOKEN=${"c".repeat(43)}`);
  });

  it("points a capturing desktop's names at its gate and never gives the desktop NET_ADMIN", () => {
    const spec = desktopSpec(captured, "localdot/desktop:dev", streamOptions());
    expect(spec.HostConfig).toMatchObject({ Dns: ["172.24.0.10"], CapDrop: ["NET_RAW"] });
    expect("CapAdd" in spec.HostConfig).toBe(false);
    expect(spec.Env.join("\n")).not.toContain("c".repeat(43));
  });

  it("keeps a computer made before capture as it was", () => {
    expect(gateSpec(record, "i").User).toBe("nobody");
    expect("CapAdd" in gateSpec(record, "i").HostConfig).toBe(false);
    expect(gateSpec(record, "i").Env.some((e) => e.startsWith("LD_CAPTURE_TOKEN="))).toBe(false);
    expect("Dns" in desktopSpec(record, "i", streamOptions()).HostConfig).toBe(false);
  });

  it("links the desktop to its gate from a one-shot helper in the desktop's network namespace", () => {
    const spec = linkSpec(captured, "localdot/gate:dev");
    expect(spec).toMatchObject({
      Image: "localdot/gate:dev",
      User: "root",
      Entrypoint: ["/link.sh"],
      Cmd: ["172.24.0.11", "172.24.0.10", LINK.desktop, LINK.gate, "default"],
      HostConfig: {
        NetworkMode: `container:${record.docker.desktop}`,
        CapDrop: ["ALL"],
        CapAdd: ["NET_ADMIN"],
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges"],
      },
    });
    expect(linkName(record.id, "ldtest-l5-")).toBe(`ldtest-l5-link-${record.id}`);
  });
});
