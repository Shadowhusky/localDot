import type { CellRecord } from "./types.ts";

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

export function internalNetworkSpec(name: string) {
  return { ...isolatedNetworkSpec(name), Labels: LABELS };
}

export function egressNetworkSpec(name: string) {
  return { Name: name, Driver: "bridge", EnableIPv6: false, Labels: LABELS };
}

export function homeVolumeSpec(name: string) {
  return { Name: name, Labels: LABELS };
}

export function gateSpec(record: CellRecord, image: string) {
  const d = record.docker;
  return {
    Image: image,
    User: "nobody",
    Env: [
      `LD_INTERNAL_ADDR=${d.gateInternalIp}`,
      `LD_EGRESS_ADDR=${d.gateEgressIp}`,
      `LD_DESKTOP_ADDR=${d.desktopIp}`,
      `LD_KEYD_PORT=${record.keydPort}`,
    ],
    Labels: { "localdot.cell": record.id, "localdot.role": "gate" },
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

export function desktopEnv(record: CellRecord): string[] {
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
  ];
}

// The desktop keeps the default capability set minus NET_RAW and no no-new-privileges: the agent
// installs software with passwordless sudo (spec, Hardening). Neither container gets a Docker
// restart policy: the orchestrator restarts them itself and re-reads the ports (P2-R14).
export function desktopSpec(record: CellRecord, image: string) {
  const d = record.docker;
  return {
    Image: image,
    Env: desktopEnv(record),
    Labels: { "localdot.cell": record.id, "localdot.role": "desktop" },
    HostConfig: {
      NetworkMode: d.internalNetwork,
      Mounts: [{ Type: "volume", Source: d.homeVolume, Target: "/config" }],
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
