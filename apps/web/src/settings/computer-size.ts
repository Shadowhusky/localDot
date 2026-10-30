import {
  browserShare,
  type ComputerSize,
  ComputerSizeView,
  MEMORY_STEP_BYTES,
} from "@localdot/protocol";
import { count } from "../copy/format.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import type { SliderMark } from "../ui/StepSlider.tsx";

const GIB = 1024 ** 3;
const PATH = "/api/computer-size";

export const readSize = async (api: ApiClient, signal?: AbortSignal) =>
  ComputerSizeView.parse(await api.get(PATH, { signal }));
export const saveSize = async (api: ApiClient, size: ComputerSize) =>
  ComputerSizeView.parse(await api.put(PATH, size));

// What went wrong, in localDot's own words where it gave some.
export function sizeProblem(error: unknown): string {
  return error instanceof ApiError && [400, 409, 503].includes(error.status)
    ? error.message
    : "The computer's size couldn't be saved. Try again.";
}

export const gigabytes = (bytes: number) => `${Number((bytes / GIB).toFixed(1))} GB`;
export const cpuCount = (cpus: number) => count(Number(cpus.toFixed(1)), "CPU", "CPUs");
export const sameSize = (a: ComputerSize, b: ComputerSize) =>
  a.memoryBytes === b.memoryBytes && a.cpus === b.cpus;

// Today's size, or as much of it as Docker can hold beside the other dots; none when Docker can't
// hold even the smallest computer.
export function recommendedSize(view: ComputerSizeView): ComputerSize | null {
  const size = {
    memoryBytes: Math.min(view.default.memoryBytes, view.max.memoryBytes),
    cpus: Math.min(view.default.cpus, view.max.cpus),
  };
  return size.memoryBytes < view.min.memoryBytes || size.cpus < view.min.cpus ? null : size;
}

// Where the limit comes from, and where it is raised.
export function dockerTip(docker: ComputerSizeView["docker"], what: "memory" | "cpus"): string {
  // A no-break space keeps an amount on one line of the tip.
  const amount = (
    what === "memory" ? gigabytes(docker.memoryBytes) : cpuCount(docker.cpus)
  ).replace(" ", "\u00a0");
  if (docker.app === "host")
    return what === "memory"
      ? `Docker gives localDot all ${amount} of this computer's memory.`
      : `Docker gives localDot all ${docker.cpus} of this computer's CPUs.`;
  const where =
    docker.app === "docker-desktop"
      ? "Docker Desktop → Settings → Resources"
      : docker.app === "orbstack"
        ? "OrbStack → Settings → System"
        : "the settings of the app that runs Docker";
  return `Docker gives localDot ${amount}. Raise it in ${where}.`;
}

export function browserLine(size: ComputerSize): string {
  const share = browserShare(size);
  return `The web browser runs beside the desktop with ${gigabytes(share.memoryBytes)} and ${cpuCount(share.cpus)} of its own.`;
}

export interface SliderModel {
  value: number;
  min: number;
  max: number;
  end: number;
  step: number;
  marks: SliderMark[];
  legend: { tone: SliderMark["tone"]; text: string }[];
  endLabel: string;
  endTip: string;
  lowReason: string;
  highReason: string;
}

// The memory slider in gigabytes: Docker's memory end to end, what stays free for Docker at its
// end, what other dots hold before that, and what this computer uses now from the start. A size
// saved before Docker shrank may be kept or lowered, never raised.
export function memorySlider(view: ComputerSizeView, value: number): SliderModel {
  const end = view.docker.memoryBytes / GIB;
  const kept = Math.min(end, view.headroomBytes / GIB);
  const held = Math.min(end - kept, view.others.memoryBytes / GIB);
  const used = view.usage ? view.usage.memoryBytes / GIB : 0;
  return {
    value: value / GIB,
    min: view.min.memoryBytes / GIB,
    max: Math.max(view.max.memoryBytes, view.size.memoryBytes) / GIB,
    end,
    step: MEMORY_STEP_BYTES / GIB,
    marks: [
      ...(used > 0 ? [{ from: 0, to: used, tone: "used" as const }] : []),
      ...(held > 0 ? [{ from: end - kept - held, to: end - kept, tone: "held" as const }] : []),
      ...(kept > 0 ? [{ from: end - kept, to: end, tone: "kept" as const }] : []),
    ],
    legend: [
      ...(view.usage
        ? [{ tone: "used" as const, text: `${gigabytes(view.usage.memoryBytes)} in use` }]
        : []),
      ...(held > 0
        ? [{ tone: "held" as const, text: `Other dots hold ${gigabytes(view.others.memoryBytes)}` }]
        : []),
      ...(kept > 0
        ? [{ tone: "kept" as const, text: `${gigabytes(view.headroomBytes)} kept free` }]
        : []),
    ],
    endLabel: gigabytes(view.docker.memoryBytes),
    endTip: dockerTip(view.docker, "memory"),
    lowReason: `dot's computer needs at least ${gigabytes(view.min.memoryBytes)}.`,
    highReason:
      held > 0
        ? `That's all Docker can hold for it: other dots hold ${gigabytes(view.others.memoryBytes)} and ${gigabytes(view.headroomBytes)} stays free for the web browser and Docker.`
        : `That's all Docker can hold for it: ${gigabytes(view.headroomBytes)} stays free for the web browser and Docker.`,
  };
}

export function cpuSlider(view: ComputerSizeView, value: number): SliderModel {
  const end = view.docker.cpus;
  const held = Math.min(end, view.others.cpus);
  const used = view.usage?.cpus ?? 0;
  return {
    value,
    min: view.min.cpus,
    max: Math.max(view.max.cpus, view.size.cpus),
    end,
    step: 1,
    marks: [
      ...(used > 0 ? [{ from: 0, to: used, tone: "used" as const }] : []),
      ...(held > 0 ? [{ from: end - held, to: end, tone: "held" as const }] : []),
    ],
    legend: [
      ...(view.usage?.cpus !== undefined
        ? [{ tone: "used" as const, text: `${cpuCount(view.usage.cpus)} in use` }]
        : []),
      ...(held > 0
        ? [{ tone: "held" as const, text: `Other dots hold ${cpuCount(view.others.cpus)}` }]
        : []),
    ],
    endLabel: cpuCount(end),
    endTip: dockerTip(view.docker, "cpus"),
    lowReason: `dot's computer needs at least ${cpuCount(view.min.cpus)}.`,
    highReason:
      held > 0
        ? `That's all Docker can give it: other dots hold ${cpuCount(view.others.cpus)}.`
        : "That's every CPU Docker has.",
  };
}
