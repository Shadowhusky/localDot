import type { BrowserCellRecord, CellRecord } from "./types.ts";

export const ISOLATED_GATEWAY_OPTION = "com.docker.network.bridge.gateway_mode_ipv4";
export const GATE_OFFSET = 10;
export const DESKTOP_OFFSET = 11;
export const DESKTOPD_PORT = 7700;
export const SELKIES_PORT = 3000;
export const GATE_PORTS = { desktopd: "8081/tcp", stream: "8082/tcp" } as const;
export const DESKTOP_LIMITS = {
  memoryBytes: 4 * 1024 ** 3,
  nanoCpus: 4_000_000_000,
  pids: 4096,
  shmBytes: 1024 ** 3,
} as const;
export const NAME_PREFIX = "localdot-";
const LABELS = { "localdot.cell": "1" };
// The desktop session writes to the container log, which would otherwise grow for the cell's whole
// life on Docker Desktop's VM disk.
const LOG_CONFIG = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };

export function cellNames(id: string, prefix = NAME_PREFIX) {
  return {
    internalNetwork: `${prefix}cell-${id}`,
    egressNetwork: `${prefix}egress-${id}`,
    homeVolume: `${prefix}home-${id}`,
    gate: `${prefix}gate-${id}`,
    desktop: `${prefix}desktop-${id}`,
  };
}

// Plain --internal still exposes Docker Desktop VM listeners on the bridge gateway (S3, D14).
// IPv6 is pinned off: the isolated gateway option covers IPv4 only.
export function isolatedNetworkSpec(name: string) {
  return {
    Name: name,
    Driver: "bridge",
    Internal: true,
    EnableIPv6: false,
    Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
  };
}

export function internalNetworkSpec(name: string, cellId?: string) {
  return {
    ...isolatedNetworkSpec(name),
    Labels: cellId ? { "localdot.cell": cellId, "localdot.role": "internal" } : LABELS,
  };
}

export function egressNetworkSpec(name: string, cellId?: string) {
  return {
    Name: name,
    Driver: "bridge",
    EnableIPv6: false,
    Labels: cellId ? { "localdot.cell": cellId, "localdot.role": "egress" } : LABELS,
  };
}

export function homeVolumeSpec(name: string, cellId?: string) {
  return {
    Name: name,
    Labels: cellId ? { "localdot.cell": cellId, "localdot.role": "home" } : LABELS,
  };
}

export function gateSpec(record: CellRecord | BrowserCellRecord, image: string) {
  const d = record.docker;
  const address = record.kind === "browser" ? record.docker.browserIp : record.docker.desktopIp;
  return {
    Image: image,
    User: "nobody",
    Env: [
      `LD_INTERNAL_ADDR=${d.gateInternalIp}`,
      `LD_EGRESS_ADDR=${d.gateEgressIp}`,
      `LD_DESKTOP_ADDR=${address}`,
      `LD_KEYD_PORT=${record.keydPort}`,
    ],
    Labels: {
      "localdot.cell": record.id,
      "localdot.role": "gate",
      ...(record.kind === "browser" ? { "localdot.parent": record.parentCellId } : {}),
    },
    ExposedPorts: { [GATE_PORTS.desktopd]: {}, [GATE_PORTS.stream]: {} },
    HostConfig: {
      NetworkMode: d.egressNetwork,
      PortBindings: {
        [GATE_PORTS.desktopd]: [{ HostIp: "127.0.0.1", HostPort: "" }],
        [GATE_PORTS.stream]: [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Memory: 64 * 1024 ** 2,
      PidsLimit: 64,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: {
      EndpointsConfig: { [d.egressNetwork]: { IPAMConfig: { IPv4Address: d.gateEgressIp } } },
    },
  };
}

export interface DesktopOptions {
  fullcolor: boolean;
}

// Every program in the desktop reaches keyd through the forwarder on the cell's loopback, which adds
// the cell's proxy token; loopback itself stays inside the cell. The CA and token are files the
// daemon writes at every start (keyd makes new ones each time it opens the cell), so the only
// values here are fixed for the cell's life.
export const CELL_PROXY = "http://127.0.0.1:3129";
const LOOPBACK = "localhost,127.0.0.1,::1";
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export function keydEnv(record: CellRecord): string[] {
  return [
    `LOCALDOT_CELL_ID=${record.id}`,
    `LOCALDOT_GATE_ADDR=${record.docker.gateInternalIp}`,
    `HTTP_PROXY=${CELL_PROXY}`,
    `HTTPS_PROXY=${CELL_PROXY}`,
    `http_proxy=${CELL_PROXY}`,
    `https_proxy=${CELL_PROXY}`,
    `NO_PROXY=${LOOPBACK}`,
    `no_proxy=${LOOPBACK}`,
    "NODE_USE_ENV_PROXY=1",
    "NODE_EXTRA_CA_CERTS=/etc/localdot/cell/ca.pem",
    `SSL_CERT_FILE=${SYSTEM_CA_BUNDLE}`,
    `REQUESTS_CA_BUNDLE=${SYSTEM_CA_BUNDLE}`,
  ];
}

export function desktopEnv(
  record: CellRecord,
  opts: DesktopOptions = { fullcolor: true },
): string[] {
  const [w, h] = record.scale === 2 ? [2560, 1600] : [1280, 800];
  return [
    "PUID=1000",
    "PGID=1000",
    "TZ=Etc/UTC",
    `LOCALDOT_SCALE=${record.scale}`,
    `SELKIES_MANUAL_WIDTH=${w}`,
    `SELKIES_MANUAL_HEIGHT=${h}`,
    `LOCALDOT_DESKTOPD_TOKEN=${record.tokens.desktopd}`,
    `PASSWORD=${record.tokens.stream}`,
    `SELKIES_VIDEO_FULLCOLOR=${opts.fullcolor}|locked`,
    ...keydEnv(record),
  ];
}

// The desktop keeps the default capability set minus NET_RAW and no no-new-privileges: the agent
// installs software with passwordless sudo (spec, Hardening). Neither container gets a Docker
// restart policy: the orchestrator restarts them itself and re-reads the ports (P2-R14).
export function desktopSpec(
  record: CellRecord,
  image: string,
  opts: DesktopOptions = { fullcolor: true },
) {
  const d = record.docker;
  return {
    Image: image,
    Env: desktopEnv(record, opts),
    Labels: { "localdot.cell": record.id, "localdot.role": "desktop" },
    HostConfig: {
      NetworkMode: d.internalNetwork,
      Mounts: [{ Type: "volume", Source: d.homeVolume, Target: "/config" }],
      Tmpfs: {
        "/run/localdot-desktop-browser":
          "rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=0700",
      },
      CapDrop: ["NET_RAW"],
      ShmSize: DESKTOP_LIMITS.shmBytes,
      Memory: DESKTOP_LIMITS.memoryBytes,
      MemorySwap: DESKTOP_LIMITS.memoryBytes,
      NanoCpus: DESKTOP_LIMITS.nanoCpus,
      PidsLimit: DESKTOP_LIMITS.pids,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: {
      EndpointsConfig: { [d.internalNetwork]: { IPAMConfig: { IPv4Address: d.desktopIp } } },
    },
  };
}
