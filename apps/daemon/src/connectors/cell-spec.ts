import type { LocalServer } from "@localdot/protocol";
import { type GateRelay, gateRelayEnv, gateRelayMounts } from "../cells/relay.ts";
import { isolatedNetworkSpec } from "../cells/spec.ts";

export const CONNECTOR_GATE_OFFSET = 10;
export const CONNECTOR_OFFSET = 11;
// keyd's listener, through the gate.
export const CONNECTOR_PROXY_PORT = 3128;
export const CONNECTOR_HOME = "/home/connector";
export const CONNECTOR_LIMITS = {
  memoryBytes: 1024 ** 3,
  nanoCpus: 1_000_000_000,
  pids: 256,
} as const;
const LOG_CONFIG = { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } };

export interface ConnectorNames {
  internalNetwork: string;
  egressNetwork: string;
  gate: string;
  connector: string;
}

export function connectorNames(cellId: string, prefix = "localdot-"): ConnectorNames {
  return {
    internalNetwork: `${prefix}connnet-${cellId}`,
    egressNetwork: `${prefix}connegress-${cellId}`,
    gate: `${prefix}conngate-${cellId}`,
    connector: `${prefix}connector-${cellId}`,
  };
}

export interface ConnectorLayout {
  cellId: string;
  connectorId: string;
  keydPort: number;
  names: ConnectorNames;
  gateInternalIp: string;
  gateEgressIp: string;
  connectorIp: string;
  // Which daemon home made it, so a startup sweep removes only its own leftovers.
  home: string;
}

export const connectorLabels = (c: ConnectorLayout, role: string) => ({
  "localdot.connector": c.connectorId,
  "localdot.connector-cell": c.cellId,
  "localdot.home": c.home,
  "localdot.role": role,
  "localdot.keyd-port": String(c.keydPort),
});

export function connectorNetworkSpecs(c: ConnectorLayout) {
  return {
    internal: {
      ...isolatedNetworkSpec(c.names.internalNetwork),
      Labels: connectorLabels(c, "connector-network"),
    },
    egress: {
      Name: c.names.egressNetwork,
      Driver: "bridge",
      EnableIPv6: false,
      Labels: connectorLabels(c, "connector-network"),
    },
  };
}

// The connector's gate relays keyd's listener out and nothing in (cells/gate/relay.sh).
export function connectorGateSpec(
  c: ConnectorLayout,
  image: string,
  networkId: string,
  relay: GateRelay,
) {
  return {
    Image: image,
    User: "nobody",
    Env: [
      "LD_ROLE=connector",
      `LD_INTERNAL_ADDR=${c.gateInternalIp}`,
      `LD_KEYD_PORT=${c.keydPort}`,
      ...gateRelayEnv(relay, c.keydPort, false),
    ],
    Labels: connectorLabels(c, "connector-gate"),
    HostConfig: {
      NetworkMode: networkId,
      ...gateRelayMounts(relay, false),
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Memory: 64 * 1024 ** 2,
      PidsLimit: 64,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: {
      EndpointsConfig: { [networkId]: { IPAMConfig: { IPv4Address: c.gateEgressIp } } },
    },
  };
}

export interface ConnectorCredentials {
  proxyToken: string;
  caCertPem: string;
  // Each key's stand-in, by the variable the program reads it from.
  env: Readonly<Record<string, string>>;
}

// The user's program, in a container of its own: no folder of this Mac is mounted, its only network
// is the internal one, whose one way out is keyd through the gate; it gets stand-ins, never keys,
// and talks MCP over its stdin and stdout.
export function connectorSpec(
  c: ConnectorLayout,
  image: string,
  server: LocalServer,
  credentials: ConnectorCredentials,
  networkId: string,
) {
  const proxy = `http://connector:${credentials.proxyToken}@${c.gateInternalIp}:${CONNECTOR_PROXY_PORT}`;
  return {
    Image: image,
    User: "node",
    Cmd: [server.command, ...server.args],
    Env: [
      ...server.env.flatMap((env) => {
        const value = env.secret === undefined ? env.value : credentials.env[env.name];
        return value === undefined ? [] : [`${env.name}=${value}`];
      }),
      `HOME=${CONNECTOR_HOME}`,
      `HTTPS_PROXY=${proxy}`,
      `HTTP_PROXY=${proxy}`,
      `https_proxy=${proxy}`,
      `http_proxy=${proxy}`,
      "NO_PROXY=",
      "NODE_USE_ENV_PROXY=1",
      `LOCALDOT_CA_PEM=${credentials.caCertPem}`,
    ],
    Labels: connectorLabels(c, "connector"),
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      NetworkMode: networkId,
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: {
        [CONNECTOR_HOME]: "rw,nosuid,nodev,size=768m,uid=1000,gid=1000,mode=0700",
        "/tmp": "rw,nosuid,nodev,size=128m",
      },
      Memory: CONNECTOR_LIMITS.memoryBytes,
      MemorySwap: CONNECTOR_LIMITS.memoryBytes,
      NanoCpus: CONNECTOR_LIMITS.nanoCpus,
      PidsLimit: CONNECTOR_LIMITS.pids,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: {
      EndpointsConfig: { [networkId]: { IPAMConfig: { IPv4Address: c.connectorIp } } },
    },
  };
}
