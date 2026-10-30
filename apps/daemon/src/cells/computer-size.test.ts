import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COMPUTER_SIZE } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_LIMITS, browserSpec } from "./browser-spec.ts";
import {
  applyLimits,
  browserLimits,
  ComputerSizeStore,
  ComputerSizes,
  desktopLimits,
  sizeProblem,
  workingSet,
} from "./computer-size.ts";
import type { DockerRequest } from "./docker.ts";
import { DESKTOP_LIMITS, streamOptions } from "./spec.ts";
import { sampleBrowserRecord } from "./testing/sample-browser-record.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

interface Box {
  cell: string;
  role: "desktop" | "browser";
  parent?: string;
  running: boolean;
  limits: { Memory: number; MemorySwap: number; NanoCpus: number };
  // Memory in use and the files the kernel can drop.
  usage?: number;
  inactive?: number;
  cpu?: { total: number; system: number };
}

// A Docker engine with a few computers: answers what ComputerSizes asks and records updates.
function engine(boxes: Record<string, Box>, info = { MemTotal: 7.6 * GIB, NCPU: 24 }) {
  const updates: { id: string; body: unknown }[] = [];
  const request = async <T>({ method, path, query, body }: DockerRequest): Promise<T> => {
    if (path === "/info") return { ...info, OperatingSystem: "Docker Desktop" } as T;
    if (path === "/containers/json") {
      const filters = JSON.parse(query?.filters ?? "{}");
      return Object.entries(boxes)
        .filter(([, box]) => !filters.status || box.running)
        .filter(
          ([, box]) => !filters.label?.includes("localdot.role=desktop") || box.role === "desktop",
        )
        .map(([Id, box]) => ({
          Id,
          Labels: {
            "localdot.role": box.role,
            "localdot.cell": box.role === "desktop" ? box.cell : `browser-${box.cell}`,
            ...(box.parent ? { "localdot.parent": box.parent } : {}),
          },
        })) as T;
    }
    const [, , id = "", action] = path.split("/");
    const box = boxes[decodeURIComponent(id)];
    if (!box) throw new Error(`no such box ${id}`);
    if (action === "json") return { State: { Running: box.running }, HostConfig: box.limits } as T;
    if (action === "stats")
      return {
        memory_stats: { usage: box.usage, stats: { inactive_file: box.inactive ?? 0 } },
        cpu_stats: {
          cpu_usage: { total_usage: box.cpu?.total },
          system_cpu_usage: box.cpu?.system,
          online_cpus: 24,
        },
      } as T;
    if (method === "POST" && action === "update") {
      updates.push({ id, body });
      Object.assign(box.limits, body);
      return { Warnings: [] } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { request, updates };
}

const today = () => ({ ...desktopLimits(DEFAULT_COMPUTER_SIZE) });

const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "localdot-size-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the computer's size", () => {
  it("keeps today's limits by default, for the desktop and the web browser beside it", () => {
    expect(desktopLimits(DEFAULT_COMPUTER_SIZE)).toEqual({
      Memory: DESKTOP_LIMITS.memoryBytes,
      MemorySwap: DESKTOP_LIMITS.memorySwapBytes,
      NanoCpus: DESKTOP_LIMITS.nanoCpus,
    });
    expect(browserLimits(DEFAULT_COMPUTER_SIZE)).toEqual({
      Memory: 3 * GIB,
      MemorySwap: 3 * GIB,
      NanoCpus: 2e9,
    });
    const spec = browserSpec(sampleBrowserRecord(), "i", streamOptions(), "accounts");
    expect(spec.HostConfig).toMatchObject({
      Memory: 3 * GIB,
      MemorySwap: 3 * GIB,
      NanoCpus: 2e9,
      ShmSize: BROWSER_LIMITS.shmBytes,
      PidsLimit: BROWSER_LIMITS.pids,
    });
  });

  it("splits a size at today's ratio and never starves the web browser", () => {
    expect(browserLimits({ memoryBytes: 8 * GIB, cpus: 8 })).toEqual({
      Memory: 6 * GIB,
      MemorySwap: 6 * GIB,
      NanoCpus: 4e9,
    });
    expect(browserLimits({ memoryBytes: 2.5 * GIB, cpus: 3 })).toMatchObject({
      Memory: 1.875 * GIB,
      NanoCpus: 1.5e9,
    });
    expect(browserLimits({ memoryBytes: 2 * GIB, cpus: 2 })).toMatchObject({
      Memory: 1.5 * GIB,
      NanoCpus: 1e9,
    });
    expect(desktopLimits({ memoryBytes: 6 * GIB, cpus: 6 })).toEqual({
      Memory: 6 * GIB,
      MemorySwap: 6 * GIB + 256 * MIB,
      NanoCpus: 6e9,
    });
  });

  it("refuses a size off the steps or under the minimum, and a raise past what Docker can hold", () => {
    const saved = DEFAULT_COMPUTER_SIZE;
    const max = { memoryBytes: 5.5 * GIB, cpus: 24 };
    expect(sizeProblem({ memoryBytes: 4.25 * GIB, cpus: 4 }, saved, max)?.message).toBe(
      "Memory goes in steps of 0.5 GB.",
    );
    expect(sizeProblem({ memoryBytes: 1.5 * GIB, cpus: 4 }, saved, max)?.status).toBe(400);
    expect(sizeProblem({ memoryBytes: 4 * GIB, cpus: 1 }, saved, max)?.message).toBe(
      "dot's computer needs at least 2 GB and 2 CPUs.",
    );
    const over = sizeProblem({ memoryBytes: 6 * GIB, cpus: 4 }, saved, max);
    expect(over?.status).toBe(409);
    expect(over?.message).toBe("Docker can hold at most 5.5 GB for this computer now.");
    expect(sizeProblem({ memoryBytes: 5.5 * GIB, cpus: 24 }, saved, max)).toBeUndefined();
    expect(sizeProblem({ memoryBytes: 4 * GIB, cpus: 25 }, saved, max)?.message).toBe(
      "Docker can give this computer at most 24 CPUs now.",
    );
  });

  it("keeps or lowers a size Docker can no longer hold, but never raises it", () => {
    const max = { memoryBytes: 2 * GIB, cpus: 3 };
    const saved = { memoryBytes: 6 * GIB, cpus: 6 };
    expect(sizeProblem(saved, saved, max)).toBeUndefined();
    expect(sizeProblem({ memoryBytes: 5 * GIB, cpus: 5 }, saved, max)).toBeUndefined();
    expect(sizeProblem({ memoryBytes: 6.5 * GIB, cpus: 6 }, saved, max)?.status).toBe(409);
  });

  it("is stored privately with the dot, and anything unreadable is the default", () => {
    const dir = home();
    const store = new ComputerSizeStore(dir);
    expect(store.read()).toEqual(DEFAULT_COMPUTER_SIZE);
    store.write({ memoryBytes: 6 * GIB, cpus: 8 });
    expect(new ComputerSizeStore(dir).read()).toEqual({ memoryBytes: 6 * GIB, cpus: 8 });
    expect(statSync(join(dir, "computer-size.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "computer-size.json"), "{nope", { mode: 0o600 });
    expect(store.read()).toEqual(DEFAULT_COMPUTER_SIZE);
  });

  it("reads the memory the programs hold, not the files the kernel can drop", () => {
    expect(workingSet({ memory_stats: { usage: 3 * GIB, stats: { inactive_file: GIB } } })).toBe(
      2 * GIB,
    );
    expect(
      workingSet({ memory_stats: { usage: GIB, stats: { total_inactive_file: 2 * GIB } } }),
    ).toBe(GIB);
    expect(workingSet({})).toBeUndefined();
  });
});

describe("applying a size", () => {
  it("raises a running computer at once", async () => {
    const docker = engine({ d: { cell: "A", role: "desktop", running: true, limits: today() } });
    expect(await applyLimits(docker, "d", desktopLimits({ memoryBytes: 6 * GIB, cpus: 8 }))).toBe(
      "applied",
    );
    expect(docker.updates).toEqual([
      { id: "d", body: { Memory: 6 * GIB, MemorySwap: 6 * GIB + 256 * MIB, NanoCpus: 8e9 } },
    ]);
  });

  it("lowers a running computer's memory while it stays a step above what it uses", async () => {
    const docker = engine({
      d: {
        cell: "A",
        role: "desktop",
        running: true,
        limits: today(),
        usage: 2 * GIB,
        inactive: GIB,
      },
    });
    expect(await applyLimits(docker, "d", desktopLimits({ memoryBytes: 2 * GIB, cpus: 4 }))).toBe(
      "applied",
    );
    expect(docker.updates[0]?.body).toEqual({ Memory: 2 * GIB, MemorySwap: 2 * GIB + 256 * MIB });
  });

  it("never takes memory a running computer uses: that waits for its next start, CPUs don't", async () => {
    const boxes = {
      d: { cell: "A", role: "desktop", running: true, limits: today(), usage: 3.2 * GIB } as Box,
    };
    const docker = engine(boxes);
    expect(await applyLimits(docker, "d", desktopLimits({ memoryBytes: 3 * GIB, cpus: 2 }))).toBe(
      "pending",
    );
    expect(docker.updates).toEqual([{ id: "d", body: { NanoCpus: 2e9 } }]);
    expect(boxes.d.limits.Memory).toBe(4 * GIB);

    boxes.d.running = false;
    expect(await applyLimits(docker, "d", desktopLimits({ memoryBytes: 3 * GIB, cpus: 2 }))).toBe(
      "applied",
    );
    expect(boxes.d.limits.Memory).toBe(3 * GIB);
  });

  it("leaves a computer that already has the size alone", async () => {
    const docker = engine({ d: { cell: "A", role: "desktop", running: true, limits: today() } });
    expect(await applyLimits(docker, "d", today())).toBe("unchanged");
    expect(docker.updates).toEqual([]);
  });
});

describe("one dot's sizes", () => {
  const sizes = (boxes: Record<string, Box>, info?: { MemTotal: number; NCPU: number }) => {
    const docker = engine(boxes, info);
    const dir = home();
    return {
      docker,
      dir,
      sizes: new ComputerSizes({ home: dir, docker, computers: () => ["A"], platform: "darwin" }),
    };
  };

  it("shows Docker's room, what other dots hold and this computer's use", async () => {
    const { sizes: dot } = sizes(
      {
        d: {
          cell: "A",
          role: "desktop",
          running: true,
          limits: today(),
          usage: GIB,
          cpu: { total: 0, system: 0 },
        },
        b: {
          cell: "A",
          role: "browser",
          parent: "A",
          running: true,
          limits: browserLimits(DEFAULT_COMPUTER_SIZE),
        },
        o: {
          cell: "B",
          role: "desktop",
          running: true,
          limits: desktopLimits({ memoryBytes: 2 * GIB, cpus: 3 }),
        },
        s: { cell: "C", role: "desktop", running: false, limits: today() },
      },
      { MemTotal: 12 * GIB, NCPU: 24 },
    );
    const view = await dot.view();
    expect(view).toMatchObject({
      size: DEFAULT_COMPUTER_SIZE,
      default: DEFAULT_COMPUTER_SIZE,
      min: { memoryBytes: 2 * GIB, cpus: 2 },
      max: { memoryBytes: 8 * GIB, cpus: 21 },
      docker: { memoryBytes: 12 * GIB, cpus: 24, app: "docker-desktop" },
      others: { memoryBytes: 2 * GIB, cpus: 3 },
      headroomBytes: 2 * GIB,
      usage: { memoryBytes: GIB },
      pending: false,
    });
    expect(view.usage?.cpus).toBeUndefined();
  });

  it("measures CPUs between two looks", async () => {
    const boxes: Record<string, Box> = {
      d: {
        cell: "A",
        role: "desktop",
        running: true,
        limits: today(),
        usage: GIB,
        cpu: { total: 0, system: 0 },
      },
    };
    const { sizes: dot } = sizes(boxes);
    await dot.view();
    boxes.d = { ...boxes.d, cpu: { total: 3e9, system: 24e9 } } as Box;
    expect((await dot.view()).usage?.cpus).toBeCloseTo(3);
  });

  it("saves a change with the dot, applies it to its desktop and web browser, and not another's", async () => {
    const boxes: Record<string, Box> = {
      d: { cell: "A", role: "desktop", running: true, limits: today(), usage: GIB },
      b: {
        cell: "A",
        role: "browser",
        parent: "A",
        running: true,
        limits: browserLimits(DEFAULT_COMPUTER_SIZE),
        usage: GIB,
      },
      o: { cell: "B", role: "desktop", running: true, limits: today() },
    };
    const { sizes: dot, dir, docker } = sizes(boxes, { MemTotal: 12 * GIB, NCPU: 24 });
    const view = await dot.change({ memoryBytes: 5 * GIB, cpus: 6 });
    expect(JSON.parse(readFileSync(join(dir, "computer-size.json"), "utf8"))).toEqual({
      v: 1,
      memoryBytes: 5 * GIB,
      cpus: 6,
    });
    expect(boxes.d?.limits).toEqual(desktopLimits({ memoryBytes: 5 * GIB, cpus: 6 }));
    expect(boxes.b?.limits).toEqual(browserLimits({ memoryBytes: 5 * GIB, cpus: 6 }));
    expect(docker.updates.map((update) => update.id).sort()).toEqual(["b", "d"]);
    expect(view).toMatchObject({ size: { memoryBytes: 5 * GIB, cpus: 6 }, pending: false });
  });

  it("refuses a raise Docker can't hold and saves nothing", async () => {
    const {
      sizes: dot,
      dir,
      docker,
    } = sizes(
      {
        d: { cell: "A", role: "desktop", running: true, limits: today() },
        o: { cell: "B", role: "desktop", running: true, limits: today() },
      },
      { MemTotal: 12 * GIB, NCPU: 8 },
    );
    await expect(dot.change({ memoryBytes: 6.5 * GIB, cpus: 4 })).rejects.toMatchObject({
      status: 409,
      message: "Docker can hold at most 6 GB for this computer now.",
    });
    expect(() => readFileSync(join(dir, "computer-size.json"))).toThrow();
    expect(docker.updates).toEqual([]);
  });

  it("says when less memory than the computer uses waits for its next start", async () => {
    const boxes: Record<string, Box> = {
      d: { cell: "A", role: "desktop", running: true, limits: today(), usage: 3 * GIB },
    };
    const { sizes: dot } = sizes(boxes);
    const view = await dot.change({ memoryBytes: 3 * GIB, cpus: 4 });
    expect(view.pending).toBe(true);
    expect(boxes.d?.limits.Memory).toBe(4 * GIB);
    boxes.d = { ...boxes.d, running: false } as Box;
    await dot.prepare("d");
    expect(boxes.d.limits.Memory).toBe(3 * GIB);
    expect((await dot.view()).pending).toBe(false);
  });

  it("keeps the size when Docker refuses to apply it, until the next start", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boxes: Record<string, Box> = {
      d: { cell: "A", role: "desktop", running: true, limits: today() },
    };
    const docker = engine(boxes);
    const refusing = {
      request: async <T>(request: DockerRequest): Promise<T> => {
        if (request.path.endsWith("/update")) throw new Error("refused");
        return docker.request<T>(request);
      },
    };
    const dot = new ComputerSizes({ home: home(), docker: refusing, computers: () => ["A"] });
    const view = await dot.change({ memoryBytes: 5 * GIB, cpus: 4 });
    expect(view).toMatchObject({ size: { memoryBytes: 5 * GIB }, pending: true });
    expect(error).toHaveBeenCalledWith("computer size: desktop kept its size (refused)");
  });
});
