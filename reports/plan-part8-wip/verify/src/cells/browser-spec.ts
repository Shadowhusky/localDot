import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CellRecord } from "./types.ts";

// The signed-in browser cell (spec "Signed-in browser (M7)", "Hardening"; P8-R1, P8-R4, P8-R5).
export const BROWSER_LIMITS = {
  memoryBytes: 3 * 1024 ** 3,
  nanoCpus: 2_000_000_000,
  pids: 1024,
  shmBytes: 512 * 1024 ** 2,
} as const;
export const BROWSER_UID = 1000;
export const PROFILE_DIR = "/profile";
export const CELL_FILES_DIR = "/etc/localdot/cell";
const LOG_CONFIG = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };

export function browserCellNames(id: string, prefix = "localdot-") {
  return {
    internalNetwork: `${prefix}cell-${id}`,
    egressNetwork: `${prefix}egress-${id}`,
    homeVolume: `${prefix}profile-${id}`,
    cellFilesVolume: `${prefix}cellfiles-${id}`,
    gate: `${prefix}gate-${id}`,
    desktop: `${prefix}browser-${id}`,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
// Docker's default seccomp profile plus the three calls Chromium's namespace sandbox needs
// (cells/browser/seccomp/, Task 8). The Engine API takes the profile itself, not a path.
export function chromiumSeccomp(file = join(here, "seccomp-chromium.json")): string {
  return JSON.stringify(JSON.parse(readFileSync(file, "utf8")));
}

export function browserEnv(record: CellRecord, keydEnv: string[]): string[] {
  const [w, h] = record.scale === 2 ? [2560, 1600] : [1280, 800];
  return [
    `LOCALDOT_SCALE=${record.scale}`,
    `LOCALDOT_SCREEN=${w}x${h}`,
    `LOCALDOT_BROWSERD_TOKEN=${record.tokens.desktopd}`,
    `PASSWORD=${record.tokens.stream}`,
    `HOME=/home/browser`,
    "TZ=Etc/UTC",
    ...keydEnv,
  ];
}

// Read-only, every capability dropped, no-new-privileges, uid 1000. Its only writable places are
// the profile volume (the cookies: mounted here and nowhere else), the keyd-files volume the
// daemon writes before each start, and three tmpfs mounts.
export function browserSpec(record: CellRecord, image: string, seccomp: string, keydEnv: string[]) {
  const d = record.docker;
  if (record.kind !== "browser" || !record.parent || !d.cellFilesVolume)
    throw new Error("browserSpec needs a browser record with its parent and its cell-files volume");
  return {
    Image: image,
    User: `${BROWSER_UID}:${BROWSER_UID}`,
    Env: browserEnv(record, keydEnv),
    Labels: { "localdot.cell": record.id, "localdot.role": "browser", "localdot.parent": record.parent },
    HostConfig: {
      NetworkMode: d.internalNetwork,
      Mounts: [
        { Type: "volume", Source: d.homeVolume, Target: PROFILE_DIR },
        { Type: "volume", Source: d.cellFilesVolume, Target: CELL_FILES_DIR },
      ],
      Tmpfs: {
        "/tmp": "rw,nosuid,nodev,noexec,size=512m,mode=1777",
        "/run/localdot": `rw,nosuid,nodev,noexec,size=16m,uid=${BROWSER_UID},gid=${BROWSER_UID},mode=0700`,
        "/home/browser": `rw,nosuid,nodev,noexec,size=128m,uid=${BROWSER_UID},gid=${BROWSER_UID},mode=0700`,
      },
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges", `seccomp=${seccomp}`],
      ShmSize: BROWSER_LIMITS.shmBytes,
      Memory: BROWSER_LIMITS.memoryBytes,
      MemorySwap: BROWSER_LIMITS.memoryBytes,
      NanoCpus: BROWSER_LIMITS.nanoCpus,
      PidsLimit: BROWSER_LIMITS.pids,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: {
      EndpointsConfig: { [d.internalNetwork]: { IPAMConfig: { IPv4Address: d.desktopIp } } },
    },
  };
}
