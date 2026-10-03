import { TOOL_API_PORT } from "@localdot/protocol";
import { isolatedNetworkSpec } from "../cells/spec.ts";

export const BRAIN_GATE_OFFSET = 10;
export const BRAIN_OFFSET = 11;
// keyd's listener, through the gate: the brain's proxy for http://llm.ldot/<route>.
export const BRAIN_PROXY_PORT = 3128;
export const BRAIN_TOOL_PORT = TOOL_API_PORT;
export const BRAIN_LIMITS = { memoryBytes: 1024 ** 3, nanoCpus: 2_000_000_000, pids: 256 } as const;
const LOG_CONFIG = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };

export interface BrainNames {
  internalNetwork: string;
  egressNetwork: string;
  gate: string;
  brain: string;
}

export function brainNames(id: string, prefix = "localdot-"): BrainNames {
  return {
    internalNetwork: `${prefix}braincell-${id}`,
    egressNetwork: `${prefix}brainegress-${id}`,
    gate: `${prefix}braingate-${id}`,
    brain: `${prefix}brain-${id}`,
  };
}

export interface BrainLayout {
  id: string;
  sessionId: string;
  keydPort: number;
  names: BrainNames;
  gateInternalIp: string;
  gateEgressIp: string;
  brainIp: string;
  // Which daemon home made it, so a startup sweep removes only its own leftovers.
  home: string;
}

const labels = (b: BrainLayout, role: string) => ({
  "localdot.brain": b.id,
  "localdot.session": b.sessionId,
  "localdot.home": b.home,
  "localdot.role": role,
  "localdot.keyd-port": String(b.keydPort),
});

export function brainNetworkSpecs(b: BrainLayout) {
  return {
    internal: {
      ...isolatedNetworkSpec(b.names.internalNetwork),
      Labels: labels(b, "brain-network"),
    },
    egress: {
      Name: b.names.egressNetwork,
      Driver: "bridge",
      EnableIPv6: false,
      Labels: labels(b, "brain-network"),
    },
  };
}

// The brain's gate relays two things out and nothing in: keyd's listener for this cell, and the
// daemon's tool API. Both listen only on the gate's internal-network address (cells/gate/relay.sh).
export function brainGateSpec(
  b: BrainLayout,
  image: string,
  toolPort = TOOL_API_PORT,
  networkId = b.names.egressNetwork,
) {
  return {
    Image: image,
    User: "nobody",
    Env: [
      "LD_ROLE=brain",
      `LD_INTERNAL_ADDR=${b.gateInternalIp}`,
      `LD_KEYD_PORT=${b.keydPort}`,
      `LD_TOOL_PORT=${toolPort}`,
    ],
    Labels: labels(b, "brain-gate"),
    HostConfig: {
      NetworkMode: networkId,
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Memory: 64 * 1024 ** 2,
      PidsLimit: 64,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: {
      EndpointsConfig: { [networkId]: { IPAMConfig: { IPv4Address: b.gateEgressIp } } },
    },
  };
}

// Spec "Hardening": the brain runs read-only with no-new-privileges and every capability dropped.
// Its only state is in the daemon (the transcript); its tool token is worthless off this Mac.
export function brainSpec(
  b: BrainLayout,
  image: string,
  toolToken: string,
  networkId = b.names.internalNetwork,
) {
  return {
    Image: image,
    User: "node",
    Env: [
      `LOCALDOT_TOOL_URL=http://${b.gateInternalIp}:${BRAIN_TOOL_PORT}`,
      `LOCALDOT_TOOL_TOKEN=${toolToken}`,
      "NODE_ENV=production",
    ],
    Labels: labels(b, "brain"),
    HostConfig: {
      NetworkMode: networkId,
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
      Memory: BRAIN_LIMITS.memoryBytes,
      MemorySwap: BRAIN_LIMITS.memoryBytes,
      NanoCpus: BRAIN_LIMITS.nanoCpus,
      PidsLimit: BRAIN_LIMITS.pids,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: {
      EndpointsConfig: { [networkId]: { IPAMConfig: { IPv4Address: b.brainIp } } },
    },
  };
}
