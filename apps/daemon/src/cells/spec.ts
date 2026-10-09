import { type GateRelay, gateRelayEnv, gateRelayMounts, HOST_RELAY } from "./relay.ts";
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

// The one-shot helper that sets up a desktop's link (linkSpec) is gone once it has run.
export function linkName(id: string, prefix = NAME_PREFIX) {
  return `${prefix}link-${id}`;
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

// The two ends of the IP-in-IP link a desktop's outbound traffic crosses to its gate in
// (cells/gate/link.sh): DS-Lite's own pair from the IETF protocol space, which keyd never dials.
export const LINK = { gate: "192.0.0.1", desktop: "192.0.0.2" } as const;

// A desktop's gate with a capture token starts as root with only what its entrypoint needs to take
// the desktop's traffic (NET_ADMIN) and then become nobody with no capabilities at all.
const CAPTURE_CAPS = ["NET_ADMIN", "SETUID", "SETGID", "SETPCAP"];

export function gateSpec(
  record: CellRecord | BrowserCellRecord,
  image: string,
  relay: GateRelay = HOST_RELAY,
) {
  const d = record.docker;
  const address = record.kind === "browser" ? record.docker.browserIp : record.docker.desktopIp;
  const capture = record.kind === "desktop" ? record.tokens.capture : undefined;
  return {
    Image: image,
    User: capture ? "root" : "nobody",
    Env: [
      `LD_INTERNAL_ADDR=${d.gateInternalIp}`,
      `LD_EGRESS_ADDR=${d.gateEgressIp}`,
      `LD_DESKTOP_ADDR=${address}`,
      `LD_KEYD_PORT=${record.keydPort}`,
      ...gateRelayEnv(relay, record.keydPort, false),
      ...(capture ? [`LD_CAPTURE_TOKEN=${capture}`] : []),
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
      ...gateRelayMounts(relay, false),
      CapDrop: ["ALL"],
      ...(capture ? { CapAdd: CAPTURE_CAPS } : {}),
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

// A one-shot helper that sets up the desktop's end of its link and routes the desktop's traffic
// into it. It shares the desktop's network namespace, holds NET_ADMIN only for that, and exits;
// the desktop itself never has NET_ADMIN, so nothing in it can change the route.
export function linkSpec(record: CellRecord, image: string) {
  const d = record.docker;
  return {
    Image: image,
    User: "root",
    Entrypoint: ["/link.sh"],
    Cmd: [d.desktopIp, d.gateInternalIp, LINK.desktop, LINK.gate, "default"],
    Labels: { "localdot.cell": record.id, "localdot.role": "link" },
    HostConfig: {
      NetworkMode: `container:${d.desktop}`,
      CapDrop: ["ALL"],
      CapAdd: ["NET_ADMIN"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Memory: 32 * 1024 ** 2,
      PidsLimit: 16,
      LogConfig: LOG_CONFIG,
    },
  };
}

export interface StreamOptions {
  fullcolor: boolean;
}

// iPhones and iPads cannot decode H.264 4:4:4, so the sharper 4:4:4 stream is opt-in. Installed
// services run with a fixed environment, so they always take the 4:2:0 default.
export function streamOptions(
  env: Readonly<Record<string, string | undefined>> = {},
): StreamOptions {
  return { fullcolor: env.LOCALDOT_STREAM_FULLCOLOR === "1" };
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

export function desktopEnv(record: CellRecord, stream: StreamOptions): string[] {
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
    `SELKIES_VIDEO_FULLCOLOR=${stream.fullcolor}|locked`,
    ...keydEnv(record),
  ];
}

// The desktop keeps the default capability set minus NET_RAW and no no-new-privileges: the agent
// installs software with passwordless sudo (spec, Hardening). Neither container gets a Docker
// restart policy: the orchestrator restarts them itself and re-reads the ports (P2-R14).
export function desktopSpec(record: CellRecord, image: string, stream: StreamOptions) {
  const d = record.docker;
  return {
    Image: image,
    Env: desktopEnv(record, stream),
    Labels: { "localdot.cell": record.id, "localdot.role": "desktop" },
    HostConfig: {
      NetworkMode: d.internalNetwork,
      // Names resolve to the gate's placeholders, which only keyd turns into addresses.
      ...(record.tokens.capture ? { Dns: [d.gateInternalIp] } : {}),
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
