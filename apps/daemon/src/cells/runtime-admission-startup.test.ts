import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runDaemonStartup } from "../main-startup.ts";
import { DockerClient, DockerError, type DockerRequest } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { verifyDesktopRuntimeImages } from "./runtime-image-check.ts";
import { RuntimeUpdateAdmission } from "./runtime-update-admission.ts";
import {
  preparedRuntimeRecord,
  type RuntimeUpdateJournal,
  RuntimeUpdateStore,
} from "./runtime-update-store.ts";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";
import type { CellRecord } from "./types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const held = "01JXYZ00000000000000000001",
  healthy = "01JXYZ00000000000000000002";
const digest = (c: string) => c.repeat(64);
const images = {
  desktop: `ghcr.io/example/desktop@sha256:${digest("8")}`,
  gate: `ghcr.io/example/gate@sha256:${digest("9")}`,
};
const installed = { desktop: `sha256:${digest("e")}`, gate: `sha256:${digest("d")}` };
type Container = {
  Id: string;
  Image: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: { Running: boolean; Paused: boolean; ExitCode: number; Error: string };
  NetworkSettings: { Ports: Record<string, never>; Networks: Record<string, never> };
};

function prepared(home: string, id: string, ids: string, operation: string): CellRecord {
  const [gate, desktop, internalNetwork, egressNetwork, newGate, newDesktop] = [...ids].map(digest);
  const journals = new RuntimeUpdateStore(home);
  let journal: RuntimeUpdateJournal = {
    v: 1,
    operationId: `00000000-0000-4000-8000-00000000000${operation}`,
    source: {
      ...sampleRecord(id),
      ownership: {
        gate: gate as string,
        desktop: desktop as string,
        internalNetwork: internalNetwork as string,
        egressNetwork: egressNetwork as string,
      },
    },
    images,
    fullcolor: true,
    phase: "retiring",
    candidates: { gate: null, desktop: null },
  };
  journals.write(journal);
  journal = { ...journal, phase: "creating" };
  journals.write(journal);
  journal = {
    ...journal,
    phase: "prepared",
    candidates: { gate: newGate as string, desktop: newDesktop as string },
  };
  journals.write(journal);
  const record = preparedRuntimeRecord(journal);
  new CellStore(home).save(record);
  return record;
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-runtime-startup-"));
  roots.push(home);
  const records = [prepared(home, held, "123456", "1"), prepared(home, healthy, "789abc", "2")];
  const containers = new Map<string, Container>();
  for (const record of records)
    for (const role of ["gate", "desktop"] as const)
      containers.set(record.docker[role], {
        Id: record.ownership?.[role] ?? "",
        Image: installed[role],
        Config: {
          Image: images[role],
          Labels: { "localdot.cell": record.id, "localdot.role": role },
        },
        State: { Running: false, Paused: false, ExitCode: 0, Error: "" },
        NetworkSettings: { Ports: {}, Networks: {} },
      });
  const docker = new DockerClient("/nonexistent/runtime-startup-fixture.sock");
  const request = vi
    .spyOn(docker, "request")
    .mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
      if (req.method !== "GET") throw new Error("fixture forbids mutations");
      for (const [name, container] of containers)
        if (req.path === `/containers/${name}/json`) return structuredClone(container) as T;
      for (const role of ["gate", "desktop"] as const)
        if (req.path === `/images/${encodeURIComponent(images[role])}/json`)
          return {
            Id: installed[role],
            Os: "linux",
            Architecture: "arm64",
            RepoDigests: [images[role]],
          } as T;
      throw new DockerError(404, "fixture absent", req.path);
    });
  const store = new CellStore(home),
    admission = new RuntimeUpdateAdmission(home);
  const cells = new CellOrchestrator({
    store,
    docker,
    images,
    keyd: {
      wire: vi.fn(),
      isWired: vi.fn(async () => true),
      refresh: vi.fn(async () => []),
      revoke: vi.fn(async () => 0),
      close: vi.fn(),
    },
    runtimeHold: (id) => admission.held(id),
    creationAllowed: () => admission.creationAllowed(),
    verifyRuntime: (record) => verifyDesktopRuntimeImages(docker, record, images),
    probeDesktopd: async () => undefined,
    probeStream: async () => false,
  });
  const desktopOf = (id: string) => {
    const container = containers.get(`localdot-desktop-${id}`);
    if (!container) throw new Error("fixture container missing");
    return container;
  };
  return { store, admission, cells, docker, request, desktopOf };
}

async function startup(f: ReturnType<typeof fixture>) {
  const log: string[] = [];
  const later = {
    recoverBrowsers: vi.fn(async () => {}),
    containFenced: vi.fn(async () => {}),
    startAgent: vi.fn(async () => {}),
    recoverReplacements: vi.fn(async () => {}),
    restoreResets: vi.fn(async () => {}),
    openResets: vi.fn(),
  };
  const result = runDaemonStartup(
    {
      stopping: () => false,
      restorePrepared: () =>
        f.admission.restorePrepared({
          images,
          readCell: (id) => f.store.get(id),
          verify: (record) => verifyDesktopRuntimeImages(f.docker, record, images),
          canPublish: () => true,
        }),
      reconcile: () => f.cells.reconcile(),
      ...later,
    },
    (line) => log.push(line),
  );
  return { result, log, later };
}

it.each([
  [
    "its installed image moved after creation",
    (c: Container) => {
      c.Image = `sha256:${digest("0")}`;
    },
  ],
  [
    "another container took its name",
    (c: Container) => {
      c.Id = digest("f");
    },
  ],
  [
    "its labels name another computer",
    (c: Container) => {
      c.Config.Labels["localdot.cell"] = healthy;
    },
  ],
  [
    "its labels name another role",
    (c: Container) => {
      c.Config.Labels["localdot.role"] = "gate";
    },
  ],
])(
  "holds only the computer whose runtime fails verification when %s; startup completes",
  async (_, fault) => {
    const f = fixture();
    fault(f.desktopOf(held));
    const { result, log, later } = await startup(f);
    await expect(result).rejects.toThrow("startup incomplete: runtime update recovery");
    for (const step of Object.values(later)) expect(step).toHaveBeenCalledOnce();
    expect(log).toEqual([
      expect.stringMatching(
        new RegExp(
          `runtime update recovery failed \\(Computer ${held} stays held: .*does not match`,
        ),
      ),
    ]);
    expect(f.admission.held(held)).toBe(true);
    expect(f.admission.held(healthy)).toBe(false);
    expect(f.cells.get(held)).toMatchObject({
      state: "failed",
      error: "Computer runtime update recovery is incomplete.",
    });
    await expect(f.cells.start(held)).rejects.toThrow();
    expect(f.cells.get(healthy)?.state).toBe("stopped");
    expect(f.request.mock.calls.every(([req]) => req.method === "GET")).toBe(true);
    f.cells.dispose();
  },
);

it("releases every prepared computer and completes startup when all runtimes verify", async () => {
  const f = fixture();
  const { result, log, later } = await startup(f);
  await expect(result).resolves.toBeUndefined();
  expect(log).toEqual([]);
  expect(later.openResets).toHaveBeenCalledOnce();
  expect(f.admission.held(held)).toBe(false);
  expect(f.admission.held(healthy)).toBe(false);
  expect(f.admission.creationAllowed()).toBe(true);
  expect(f.cells.get(held)?.state).toBe("stopped");
  f.cells.dispose();
});
