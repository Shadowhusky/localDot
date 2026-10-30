import { join } from "node:path";
import {
  browserShare,
  ComputerSize,
  type ComputerSizeView,
  DEFAULT_COMPUTER_SIZE,
  MEMORY_STEP_BYTES,
  MIN_COMPUTER_SIZE,
} from "@localdot/protocol";
import { z } from "zod";
import { dockerRoom, HEADROOM_BYTES, heldByOthers, sizeBounds } from "../dots/capacity.ts";
import { readPrivateJson, writePrivateJson } from "../dots/private-json.ts";
import type { DockerClient } from "./docker.ts";
import { DESKTOP_LIMITS } from "./spec.ts";

type Docker = Pick<DockerClient, "request">;

export interface Limits {
  Memory: number;
  MemorySwap: number;
  NanoCpus: number;
}

const SPILL = DESKTOP_LIMITS.memorySwapBytes - DESKTOP_LIMITS.memoryBytes;
const GIB = 1024 ** 3;

export const desktopLimits = (size: ComputerSize): Limits => ({
  Memory: size.memoryBytes,
  MemorySwap: size.memoryBytes + SPILL,
  NanoCpus: size.cpus * 1e9,
});

export function browserLimits(size: ComputerSize): Limits {
  const share = browserShare(size);
  return { Memory: share.memoryBytes, MemorySwap: share.memoryBytes, NanoCpus: share.cpus * 1e9 };
}

const Saved = ComputerSize.extend({ v: z.literal(1) });

// The size is the dot's own, kept in its home; without one, its computer has the default.
export class ComputerSizeStore {
  readonly #path: string;
  constructor(home: string) {
    this.#path = join(home, "computer-size.json");
  }
  read(): ComputerSize {
    try {
      const saved = Saved.safeParse(readPrivateJson(this.#path));
      if (saved.success) return { memoryBytes: saved.data.memoryBytes, cpus: saved.data.cpus };
    } catch {}
    return DEFAULT_COMPUTER_SIZE;
  }
  write(size: ComputerSize): void {
    writePrivateJson(this.#path, { v: 1, ...size });
  }
}

const gigabytes = (bytes: number) => `${Number((bytes / GIB).toFixed(1))} GB`;

export class SizeRefused extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

// Raising past what Docker can hold is refused; keeping or lowering an amount it no longer can
// hold is not, so a smaller Docker never traps the user at their old size.
export function sizeProblem(
  next: ComputerSize,
  saved: ComputerSize,
  max: { memoryBytes: number; cpus: number },
): SizeRefused | undefined {
  if (next.memoryBytes % MEMORY_STEP_BYTES !== 0)
    return new SizeRefused(400, "Memory goes in steps of 0.5 GB.");
  if (next.memoryBytes < MIN_COMPUTER_SIZE.memoryBytes || next.cpus < MIN_COMPUTER_SIZE.cpus)
    return new SizeRefused(
      400,
      `dot's computer needs at least ${gigabytes(MIN_COMPUTER_SIZE.memoryBytes)} and ${MIN_COMPUTER_SIZE.cpus} CPUs.`,
    );
  if (next.memoryBytes > Math.max(max.memoryBytes, saved.memoryBytes))
    return new SizeRefused(
      409,
      `Docker can hold at most ${gigabytes(max.memoryBytes)} for this computer now.`,
    );
  if (next.cpus > Math.max(max.cpus, saved.cpus))
    return new SizeRefused(409, `Docker can give this computer at most ${max.cpus} CPUs now.`);
  return undefined;
}

interface Inspect {
  State?: { Running?: boolean };
  HostConfig?: Partial<Limits>;
}

interface Stats {
  memory_stats?: {
    usage?: number;
    stats?: { inactive_file?: number; total_inactive_file?: number };
  };
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
}

const containerPath = (id: string, action: string) =>
  `/containers/${encodeURIComponent(id)}/${action}`;

const stats = (docker: Docker, id: string) =>
  docker.request<Stats>({
    method: "GET",
    path: containerPath(id, "stats"),
    query: { stream: "false", "one-shot": "true" },
  });

// What the programs hold, as Docker's own stats show it: the kernel drops inactive files first.
export function workingSet(sample: Stats): number | undefined {
  const usage = sample.memory_stats?.usage;
  if (typeof usage !== "number") return undefined;
  const files = sample.memory_stats?.stats;
  const inactive = files?.inactive_file ?? files?.total_inactive_file ?? 0;
  return inactive < usage ? usage - inactive : usage;
}

const differs = (now: Partial<Limits> | undefined, want: Limits) =>
  now?.Memory !== want.Memory ||
  now?.MemorySwap !== want.MemorySwap ||
  now?.NanoCpus !== want.NanoCpus;

// Raising, and anything while it is stopped, applies at once. Lowering a running one's memory
// below what it uses now, with a step to spare, would have the kernel kill its programs, so its
// memory waits until it next starts; its CPUs still change.
export async function applyLimits(
  docker: Docker,
  id: string,
  want: Limits,
): Promise<"unchanged" | "applied" | "pending"> {
  const now = await docker.request<Inspect>({ method: "GET", path: containerPath(id, "json") });
  const held = now?.HostConfig;
  let memory = held?.Memory !== want.Memory || held?.MemorySwap !== want.MemorySwap;
  const cpus = held?.NanoCpus !== want.NanoCpus;
  let pending = false;
  if (memory && now?.State?.Running && want.Memory < (held?.Memory || Number.POSITIVE_INFINITY)) {
    const used = workingSet(await stats(docker, id).catch(() => ({})));
    if (used === undefined || want.Memory < used + MEMORY_STEP_BYTES) {
      memory = false;
      pending = true;
    }
  }
  if (memory || cpus)
    await docker.request({
      method: "POST",
      path: containerPath(id, "update"),
      body: {
        ...(memory ? { Memory: want.Memory, MemorySwap: want.MemorySwap } : {}),
        ...(cpus ? { NanoCpus: want.NanoCpus } : {}),
      },
    });
  return pending ? "pending" : memory || cpus ? "applied" : "unchanged";
}

interface Mine {
  id: string;
  role: "desktop" | "browser";
}

interface CpuSample {
  total: number;
  system: number;
}

export interface ComputerSizesDeps {
  home: string;
  docker: Docker;
  // This dot's computers, by id.
  computers(): readonly string[];
  platform?: NodeJS.Platform;
}

// One dot's computer size: what it is, what Docker leaves room for, and putting it on the dot's
// desktops and web browsers, live where Docker allows.
export class ComputerSizes {
  readonly #store: ComputerSizeStore;
  readonly #docker: Docker;
  // Each desktop's last CPU reading, so the next one-shot reading shows its use between the two.
  readonly #samples = new Map<string, CpuSample>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ComputerSizesDeps) {
    this.#store = new ComputerSizeStore(deps.home);
    this.#docker = deps.docker;
  }

  read(): ComputerSize {
    return this.#store.read();
  }

  async view(): Promise<ComputerSizeView> {
    const size = this.read();
    const ids = new Set(this.deps.computers());
    const [room, others, mine] = await Promise.all([
      dockerRoom(this.#docker, this.deps.platform),
      heldByOthers(this.#docker, (cell) => ids.has(cell)),
      this.#mine(ids),
    ]);
    if (!room?.cpus)
      throw new SizeRefused(409, "Docker didn't say how much memory and how many CPUs it has.");
    const states = await Promise.all(
      mine.map(async (each) => ({
        ...each,
        inspect: await this.#docker
          .request<Inspect>({ method: "GET", path: containerPath(each.id, "json") })
          .catch(() => undefined),
      })),
    );
    // A stopped web browser is made anew with the size when it next starts.
    const pending = states.some(
      ({ role, inspect }) =>
        !!inspect &&
        (role === "desktop" || inspect.State?.Running) &&
        differs(inspect.HostConfig, role === "desktop" ? desktopLimits(size) : browserLimits(size)),
    );
    const desktop = states.find(
      ({ role, inspect }) => role === "desktop" && inspect?.State?.Running,
    );
    return {
      size,
      default: DEFAULT_COMPUTER_SIZE,
      min: MIN_COMPUTER_SIZE,
      max: sizeBounds(room, others),
      docker: room,
      others: { memoryBytes: others.memoryBytes, cpus: others.cpus },
      headroomBytes: HEADROOM_BYTES,
      usage: desktop ? await this.#usage(desktop.id) : null,
      pending,
    };
  }

  change(next: ComputerSize): Promise<ComputerSizeView> {
    const run = this.#queue.then(async () => {
      const view = await this.view();
      const refused = sizeProblem(next, view.size, view.max);
      if (refused) throw refused;
      this.#store.write(next);
      for (const each of await this.#mine(new Set(this.deps.computers())))
        await applyLimits(
          this.#docker,
          each.id,
          each.role === "desktop" ? desktopLimits(next) : browserLimits(next),
        ).catch((error: unknown) =>
          console.error(`computer size: ${each.role} kept its size (${(error as Error).message})`),
        );
      return this.view();
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  // Before a desktop starts, whichever way it was made: it takes the dot's size.
  async prepare(desktop: string): Promise<void> {
    await applyLimits(this.#docker, desktop, desktopLimits(this.read()));
  }

  async #mine(ids: ReadonlySet<string>): Promise<Mine[]> {
    if (!ids.size) return [];
    const all = await this.#docker.request<{ Id?: string; Labels?: Record<string, string> }[]>({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters: JSON.stringify({ label: ["localdot.role"] }) },
    });
    return (Array.isArray(all) ? all : []).flatMap(({ Id, Labels = {} }): Mine[] => {
      const role = Labels["localdot.role"];
      if (!Id) return [];
      if (role === "desktop" && ids.has(Labels["localdot.cell"] ?? "")) return [{ id: Id, role }];
      if (role === "browser" && ids.has(Labels["localdot.parent"] ?? "")) return [{ id: Id, role }];
      return [];
    });
  }

  async #usage(id: string): Promise<ComputerSizeView["usage"]> {
    const sample = await stats(this.#docker, id).catch(() => undefined);
    const memoryBytes = sample && workingSet(sample);
    if (memoryBytes === undefined) return null;
    const cpu = sample?.cpu_stats;
    const now = { total: cpu?.cpu_usage?.total_usage ?? 0, system: cpu?.system_cpu_usage ?? 0 };
    const before = this.#samples.get(id);
    this.#samples.set(id, now);
    const spent = before && now.total - before.total;
    const elapsed = before && now.system - before.system;
    return {
      memoryBytes,
      ...(spent !== undefined && elapsed && elapsed > 0 && spent >= 0
        ? { cpus: (spent / elapsed) * (cpu?.online_cpus ?? 1) }
        : {}),
    };
  }
}
