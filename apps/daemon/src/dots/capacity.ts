import type { DockerClient } from "../cells/docker.ts";
import { DESKTOP_LIMITS } from "../cells/spec.ts";

const GIB = 1024 ** 3;
// The browsers, brains and Docker's own engine beside the computers.
export const HEADROOM_BYTES = 2 * GIB;
const COUNT = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

const gigabytes = (bytes: number) => `${Math.round(bytes / GIB)} GB`;

// Before one more computer runs on this Docker, whichever dot it belongs to: plain advice when
// Docker's memory can't hold them all at their 4 GiB cap, else undefined. It warns; the user may
// start anyway. A first computer, or Docker that doesn't report its memory, gets none.
export async function computerCapacity(
  docker: Pick<DockerClient, "request">,
  starting?: string,
): Promise<string | undefined> {
  const running = await docker.request<{ Labels?: Record<string, string> }[]>({
    method: "GET",
    path: "/containers/json",
    query: { filters: JSON.stringify({ label: ["localdot.role=desktop"], status: ["running"] }) },
  });
  const others = (Array.isArray(running) ? running : []).filter(
    (container) => !starting || container.Labels?.["localdot.cell"] !== starting,
  ).length;
  if (others === 0) return undefined;
  const info = await docker.request<{ MemTotal?: number; OperatingSystem?: string }>({
    method: "GET",
    path: "/info",
  });
  const memory = info.MemTotal;
  if (typeof memory !== "number" || !Number.isFinite(memory) || memory <= 0) return undefined;
  const computers = others + 1;
  const needed = computers * DESKTOP_LIMITS.memoryBytes + HEADROOM_BYTES;
  if (memory >= needed) return undefined;
  const where = /Docker Desktop/i.test(info.OperatingSystem ?? "")
    ? "Raise it in Docker Desktop → Settings → Resources"
    : "Give Docker more memory, or stop a computer first";
  return `${COUNT[computers] ?? computers} running computers need about ${gigabytes(needed)} for Docker; it has ${gigabytes(memory)}. ${where}.`;
}
