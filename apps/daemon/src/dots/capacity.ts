import { type ComputerSizeView, MEMORY_STEP_BYTES } from "@localdot/protocol";
import type { DockerClient } from "../cells/docker.ts";
import { DESKTOP_LIMITS } from "../cells/spec.ts";

type Docker = Pick<DockerClient, "request">;
type Amount = { memoryBytes: number; cpus: number };
export type DockerRoom = ComputerSizeView["docker"];

const GIB = 1024 ** 3;
// The browsers, brains and Docker's own engine beside the computers.
export const HEADROOM_BYTES = 2 * GIB;
const COUNT = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

const gigabytes = (bytes: number) => `${Math.round(bytes / GIB)} GB`;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

interface DockerInfo {
  MemTotal?: number;
  NCPU?: number;
  OperatingSystem?: string;
  Name?: string;
}

function dockerApp(info: DockerInfo, platform: NodeJS.Platform): DockerRoom["app"] {
  if (/Docker Desktop/i.test(info.OperatingSystem ?? "")) return "docker-desktop";
  if (/OrbStack/i.test(`${info.OperatingSystem} ${info.Name}`)) return "orbstack";
  return platform === "linux" ? "host" : "vm";
}

// What Docker has for all of this computer's dots: undefined when it doesn't say its memory, and
// 0 CPUs when it doesn't say those.
export async function dockerRoom(
  docker: Docker,
  platform: NodeJS.Platform = process.platform,
): Promise<DockerRoom | undefined> {
  const info = await docker.request<DockerInfo>({ method: "GET", path: "/info" });
  if (!positive(info?.MemTotal)) return undefined;
  return {
    memoryBytes: info.MemTotal,
    cpus: positive(info.NCPU) ? info.NCPU : 0,
    app: dockerApp(info, platform),
  };
}

// What the running computers of other dots on this Docker hold: their desktops' limits as Docker
// has them now. The web browsers beside them are within the headroom.
export async function heldByOthers(
  docker: Docker,
  mine: (cell: string) => boolean,
): Promise<Amount & { computers: number }> {
  const running = await docker.request<{ Id?: string; Labels?: Record<string, string> }[]>({
    method: "GET",
    path: "/containers/json",
    query: { filters: JSON.stringify({ label: ["localdot.role=desktop"], status: ["running"] }) },
  });
  const others = (Array.isArray(running) ? running : []).filter(
    (container) => !mine(container.Labels?.["localdot.cell"] ?? ""),
  );
  const limits = await Promise.all(
    others.map((container) =>
      docker
        .request<{ HostConfig?: { Memory?: number; NanoCpus?: number } }>({
          method: "GET",
          path: `/containers/${encodeURIComponent(container.Id ?? "")}/json`,
        })
        .then((inspect) => inspect?.HostConfig)
        .catch(() => undefined),
    ),
  );
  // A computer whose limits can't be read counts at the default size.
  return {
    computers: others.length,
    memoryBytes: limits.reduce(
      (sum, limit) => sum + (positive(limit?.Memory) ? limit.Memory : DESKTOP_LIMITS.memoryBytes),
      0,
    ),
    cpus: limits.reduce(
      (sum, limit) =>
        sum + (positive(limit?.NanoCpus) ? limit.NanoCpus : DESKTOP_LIMITS.nanoCpus) / 1e9,
      0,
    ),
  };
}

// The most one dot's computer may be given: Docker's memory less the headroom and what the other
// dots hold, in whole steps, and Docker's CPUs less theirs.
export function sizeBounds(room: Amount, others: Amount): Amount {
  const memory = room.memoryBytes - HEADROOM_BYTES - others.memoryBytes;
  return {
    memoryBytes: Math.max(0, Math.floor(memory / MEMORY_STEP_BYTES) * MEMORY_STEP_BYTES),
    cpus: Math.max(0, Math.floor(room.cpus - others.cpus + 1e-9)),
  };
}

// Before one more computer runs on this Docker, whichever dot it belongs to: plain advice when
// Docker's memory can't hold them all at their limits, else undefined. It warns; the user may
// start anyway. A first computer, or Docker that doesn't report its memory, gets none.
export async function computerCapacity(
  docker: Docker,
  starting?: string,
  memoryBytes: number = DESKTOP_LIMITS.memoryBytes,
): Promise<string | undefined> {
  const others = await heldByOthers(docker, (cell) => !!starting && cell === starting);
  if (others.computers === 0) return undefined;
  const room = await dockerRoom(docker);
  if (!room) return undefined;
  const computers = others.computers + 1;
  const needed = others.memoryBytes + memoryBytes + HEADROOM_BYTES;
  if (room.memoryBytes >= needed) return undefined;
  const where =
    room.app === "docker-desktop"
      ? "Raise it in Docker Desktop → Settings → Resources"
      : "Give Docker more memory, or stop a computer first";
  return `${COUNT[computers] ?? computers} running computers need about ${gigabytes(needed)} for Docker; it has ${gigabytes(room.memoryBytes)}. ${where}.`;
}
