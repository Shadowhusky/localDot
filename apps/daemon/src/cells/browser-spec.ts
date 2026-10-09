import { readFileSync } from "node:fs";
import { ULID_PATTERN } from "@localdot/protocol";
import { runtimeLayout } from "../runtime-layout.ts";
import { egressNetworkSpec, internalNetworkSpec, NAME_PREFIX, type StreamOptions } from "./spec.ts";
import type { BrowserCellRecord } from "./types.ts";

export const BROWSER_LIMITS = {
  memoryBytes: 3 * 1024 ** 3,
  nanoCpus: 2_000_000_000,
  pids: 1024,
  shmBytes: 512 * 1024 ** 2,
} as const;

const SECCOMP = readFileSync(runtimeLayout.browserSeccomp, "utf8");

export function browserNames(id: string, prefix = NAME_PREFIX) {
  if (!ULID_PATTERN.test(id) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*-$/u.test(prefix))
    throw new Error("invalid browser resource identity");
  return {
    internalNetwork: `${prefix}cell-${id}`,
    egressNetwork: `${prefix}egress-${id}`,
    profileVolume: `${prefix}profile-${id}`,
    gate: `${prefix}gate-${id}`,
    browser: `${prefix}browser-${id}`,
  };
}

export function browserNetworkSpec(
  kind: "internal" | "egress",
  name: string,
  id: string,
  parentCellId: string,
) {
  const spec = kind === "internal" ? internalNetworkSpec(name, id) : egressNetworkSpec(name, id);
  return { ...spec, Labels: { ...spec.Labels, "localdot.parent": parentCellId } };
}

// The profile is the shared accounts volume, never one named after this cell.
export function browserSpec(
  record: BrowserCellRecord,
  image: string,
  stream: StreamOptions,
  profileVolume: string,
) {
  const d = record.docker;
  return {
    Image: image,
    User: "1000:1000",
    AttachStdin: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Env: [
      `LOCALDOT_BROWSER_CELL_ID=${record.id}`,
      `LOCALDOT_PARENT_CELL_ID=${record.parentCellId}`,
      `LOCALDOT_BROWSERD_TOKEN=${record.tokens.browserd}`,
      `LOCALDOT_STREAM_TOKEN=${record.tokens.stream}`,
      `LOCALDOT_GATE_ADDR=${d.gateInternalIp}`,
      `LOCALDOT_SCALE=${record.scale}`,
      `LOCALDOT_STREAM_FULLCOLOR=${stream.fullcolor ? 1 : 0}`,
    ],
    Labels: {
      "localdot.cell": record.id,
      "localdot.parent": record.parentCellId,
      "localdot.role": "browser",
    },
    HostConfig: {
      NetworkMode: d.internalNetwork,
      Mounts: [{ Type: "volume", Source: profileVolume, Target: "/profile" }],
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges", `seccomp=${SECCOMP}`],
      Init: true,
      Memory: BROWSER_LIMITS.memoryBytes,
      MemorySwap: BROWSER_LIMITS.memoryBytes,
      NanoCpus: BROWSER_LIMITS.nanoCpus,
      PidsLimit: BROWSER_LIMITS.pids,
      ShmSize: BROWSER_LIMITS.shmBytes,
      Tmpfs: {
        "/tmp": "rw,nosuid,nodev,noexec,size=256m,mode=1777",
        "/downloads": "rw,nosuid,nodev,noexec,size=1152m,uid=1000,gid=1000,mode=0700",
        "/config": "rw,nosuid,nodev,noexec,size=128m,uid=1000,gid=1000,mode=0700",
        "/home/browser": "rw,nosuid,nodev,noexec,size=128m,uid=1000,gid=1000,mode=0700",
        "/etc/localdot/cell": "rw,nosuid,nodev,noexec,size=1m,uid=1000,gid=1000,mode=0700",
      },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
    NetworkingConfig: {
      EndpointsConfig: { [d.internalNetwork]: { IPAMConfig: { IPv4Address: d.browserIp } } },
    },
  };
}
