import { chmodSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { ComputerSystemState } from "./system-state.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = "01JXYZ00000000000000000001",
  other = "01JXYZ00000000000000000002";
const hex = (n: number) => n.toString(16).repeat(64);
const images = {
  desktop: `ghcr.io/example/desktop@sha256:${hex(8)}`,
  gate: `ghcr.io/example/gate@sha256:${hex(9)}`,
};
function fixture(phase: RuntimeUpdateJournal["phase"] = "prepared") {
  const home = mkdtempSync(join(tmpdir(), "localdot-runtime-admission-"));
  roots.push(home);
  const store = new CellStore(home),
    journals = new RuntimeUpdateStore(home);
  const source = {
    ...sampleRecord(id),
    ownership: { gate: hex(1), desktop: hex(2), internalNetwork: hex(3), egressNetwork: hex(4) },
  };
  let journal: RuntimeUpdateJournal = {
    v: 1,
    operationId: "00000000-0000-4000-8000-000000000001",
    source,
    images,
    fullcolor: true,
    phase: "retiring",
    candidates: { gate: null, desktop: null },
  };
  journals.write(journal);
  if (phase !== "retiring") {
    journal = { ...journal, phase: "creating" };
    journals.write(journal);
  }
  if (phase === "prepared") {
    journal = { ...journal, phase, candidates: { gate: hex(5), desktop: hex(6) } };
    journals.write(journal);
  }
  const record = phase === "prepared" ? preparedRuntimeRecord(journal) : source;
  store.save(record);
  const ownership = record.ownership;
  if (!ownership) throw new Error("fixture ownership missing");
  const container = (role: "gate" | "desktop") => ({
    Id: ownership[role],
    Image: `sha256:${hex(role === "gate" ? 10 : 11)}`,
    Config: { Image: images[role], Labels: { "localdot.cell": id, "localdot.role": role } },
    State: { Running: false, Paused: false, ExitCode: 0, Error: "" },
    NetworkSettings: { Ports: {}, Networks: {} },
  });
  const containers = { gate: container("gate"), desktop: container("desktop") };
  const manifests: Record<"gate" | "desktop", Record<string, unknown>> = {
    gate: {
      Id: containers.gate.Image,
      Os: "linux",
      Architecture: "arm64",
      RepoDigests: [images.gate],
    },
    desktop: {
      Id: containers.desktop.Image,
      Os: "linux",
      Architecture: "arm64",
      RepoDigests: [images.desktop],
    },
  };
  const docker = new DockerClient("/nonexistent/runtime-admission-fixture.sock");
  const request = vi
    .spyOn(docker, "request")
    .mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
      if (req.method !== "GET") throw new Error("fixture forbids mutations");
      for (const role of ["gate", "desktop"] as const) {
        if (req.path === `/containers/${record.docker[role]}/json`)
          return structuredClone(containers[role]) as T;
        if (req.path === `/images/${encodeURIComponent(images[role])}/json`)
          return structuredClone(manifests[role]) as T;
      }
      throw new DockerError(404, "fixture absent", req.path);
    });
  const admission = new RuntimeUpdateAdmission(home);
  const verify = vi.fn((current: typeof source) =>
    verifyDesktopRuntimeImages(docker, current, images),
  );
  const restore = () =>
    admission.restorePrepared({
      images,
      readCell: (cell) => store.get(cell),
      verify,
      canPublish: () => true,
    });
  return {
    home,
    store,
    journals,
    journal,
    record,
    source,
    containers,
    manifests,
    docker,
    request,
    admission,
    verify,
    restore,
    file: join(home, "safety/computer-updates", `${id}.json`),
  };
}

it("restores a prepared runtime only after fresh image and saved-record verification; restart holds it again", async () => {
  const f = fixture();
  expect(f.admission.held(id)).toBe(true);
  expect(f.admission.creationAllowed()).toBe(false);
  await f.restore();
  expect(f.request).toHaveBeenCalledTimes(6);
  expect(f.admission.held(id)).toBe(false);
  expect(f.admission.creationAllowed()).toBe(true);
  expect(new RuntimeUpdateAdmission(f.home).held(id)).toBe(true);
});

it.each(["retiring", "creating"] as const)(
  "never resumes destructive work or publishes %s",
  async (phase) => {
    const f = fixture(phase);
    await expect(f.restore()).rejects.toThrow("incomplete");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.admission.held(id)).toBe(true);
  },
);

it.each(["wrong-target", "missing-cell", "old-cell", "changed-record", "shutdown"])(
  "holds prepared state after %s",
  async (fault) => {
    const f = fixture();
    if (fault === "missing-cell") f.store.remove(id);
    if (fault === "old-cell") f.store.save(f.source);
    if (fault === "changed-record") f.store.save({ ...f.record, scale: 1 });
    await expect(
      f.admission.restorePrepared({
        images: fault === "wrong-target" ? { ...images, desktop: images.gate } : images,
        readCell: (cell) => f.store.get(cell),
        verify: f.verify,
        canPublish: () => fault !== "shutdown",
      }),
    ).rejects.toThrow();
    expect(f.admission.held(id)).toBe(true);
  },
);

it("rechecks both journal and source after asynchronous validation", async () => {
  const f = fixture();
  await expect(
    f.admission.restorePrepared({
      images,
      readCell: (cell) => f.store.get(cell),
      canPublish: () => true,
      verify: async () => {
        unlinkSync(f.file);
      },
    }),
  ).rejects.toThrow("incomplete");
  expect(f.admission.held(other)).toBe(true);
  expect(f.admission.creationAllowed()).toBe(false);
});

it("refuses a source changed while its image was being verified", async () => {
  const f = fixture();
  await expect(
    f.admission.restorePrepared({
      images,
      readCell: (cell) => f.store.get(cell),
      canPublish: () => true,
      verify: async () => {
        f.store.save({ ...f.record, scale: 1 });
      },
    }),
  ).rejects.toThrow("incomplete");
  expect(f.admission.held(id)).toBe(true);
});

it("a permanently retired identity stays held without preventing unrelated new computers", async () => {
  const f = fixture("creating");
  f.store.remove(id);
  await f.admission.restorePrepared({
    images,
    readCell: (cell) => f.store.get(cell),
    canPublish: () => true,
    verify: f.verify,
    retired: (cell) => cell === id,
  });
  expect(f.admission.held(id)).toBe(true);
  expect(f.admission.creationAllowed()).toBe(true);
  expect(f.verify).not.toHaveBeenCalled();
});

it("unsafe journal state closes all admission including new computer creation", async () => {
  const f = fixture();
  chmodSync(f.file, 0o644);
  const admission = new RuntimeUpdateAdmission(f.home);
  expect(admission.held(other)).toBe(true);
  expect(admission.creationAllowed()).toBe(false);
  await expect(
    admission.restorePrepared({
      images,
      readCell: (cell) => f.store.get(cell),
      verify: f.verify,
      canPublish: () => true,
    }),
  ).rejects.toThrow("incomplete");
});

it.each([
  "requested-name",
  "actual-image",
  "image-id-missing",
  "image-pin",
  "platform",
  "architecture",
  "container-id",
  "owner",
  "role",
  "absent",
])("rejects %s without trusting Config.Image alone", async (fault) => {
  const f = fixture();
  if (fault === "requested-name") f.containers.desktop.Config.Image = "example/desktop:latest";
  if (fault === "actual-image") f.containers.desktop.Image = `sha256:${hex(12)}`;
  if (fault === "image-id-missing") delete f.manifests.desktop.Id;
  if (fault === "image-pin") f.manifests.desktop.RepoDigests = [];
  if (fault === "platform") f.manifests.desktop.Os = "windows";
  if (fault === "architecture") f.manifests.desktop.Architecture = "amd64";
  if (fault === "container-id") f.containers.desktop.Id = hex(12);
  if (fault === "owner") f.containers.desktop.Config.Labels["localdot.cell"] = other;
  if (fault === "role") f.containers.desktop.Config.Labels["localdot.role"] = "gate";
  if (fault === "absent")
    f.request.mockRejectedValue(new DockerError(404, "fixture absent", "ignored"));
  await expect(f.restore()).rejects.toThrow("does not match");
  expect(f.admission.held(id)).toBe(true);
  expect(f.request.mock.calls.every(([req]) => req.method === "GET")).toBe(true);
});

it("requires the container identity to remain unchanged across image inspection", async () => {
  const f = fixture(),
    original = f.request.getMockImplementation();
  f.request.mockImplementation(async (req) => {
    if (!original) throw new Error("fixture missing request");
    const result = await original(req);
    if (req.path.startsWith("/images/")) f.containers.gate.Id = hex(12);
    return result;
  });
  await expect(f.restore()).rejects.toThrow("does not match");
});

function orchestrator(f: ReturnType<typeof fixture>) {
  const keyd = {
    wire: vi.fn(),
    isWired: vi.fn(async () => true),
    refresh: vi.fn(async () => []),
    revoke: vi.fn(async () => 0),
    close: vi.fn(),
  };
  const cells = new CellOrchestrator({
    store: f.store,
    docker: f.docker,
    images,
    keyd,
    runtimeHold: (cell) => f.admission.held(cell),
    creationAllowed: () => f.admission.creationAllowed(),
    verifyRuntime: (record) => verifyDesktopRuntimeImages(f.docker, record, images),
    probeDesktopd: async () => undefined,
    probeStream: async () => false,
  });
  return { cells, keyd };
}

it("actual cell controls cannot clear update holds through replacement publication or Start", async () => {
  const f = fixture("creating"),
    { cells, keyd } = orchestrator(f);
  cells.publishReplacement(id);
  expect(cells.get(id)).toMatchObject({
    state: "failed",
    error: "Computer runtime update recovery is incomplete.",
  });
  expect(cells.endpoints(id)).toBeUndefined();
  await expect(cells.start(id)).rejects.toThrow();
  await expect(cells.create({ scale: 1 })).rejects.toThrow("incomplete");
  await expect(cells.reconcile({ strict: true })).rejects.toThrow("could not be confirmed");
  expect(keyd.wire).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  cells.dispose();
});

it("managed reconciliation accepts a stopped matching runtime but refuses an old image", async () => {
  const f = fixture();
  await f.restore();
  const { cells, keyd } = orchestrator(f);
  await cells.reconcile({ strict: true });
  expect(cells.get(id)?.state).toBe("stopped");
  f.containers.desktop.Config.Image = "old:release";
  await expect(cells.reconcile({ strict: true })).rejects.toThrow("could not be confirmed");
  expect(cells.get(id)?.state).toBe("failed");
  await expect(cells.start(id)).rejects.toThrow("does not match");
  expect(keyd.wire).not.toHaveBeenCalled();
  expect(f.request.mock.calls.every(([req]) => req.method === "GET")).toBe(true);
  cells.dispose();
});

it("keeps all updated computers held when one journal is still incomplete", async () => {
  const f = fixture();
  f.journals.write({
    ...f.journal,
    operationId: "00000000-0000-4000-8000-000000000002",
    source: { ...sampleRecord(other), ownership: f.source.ownership },
    phase: "retiring",
    candidates: { gate: null, desktop: null },
  });
  const admission = new RuntimeUpdateAdmission(f.home);
  await expect(
    admission.restorePrepared({
      images,
      readCell: (cell) => f.store.get(cell),
      verify: f.verify,
      canPublish: () => true,
    }),
  ).rejects.toThrow("incomplete");
  expect(admission.held(id)).toBe(true);
  expect(admission.held(other)).toBe(true);
  expect(f.verify).not.toHaveBeenCalled();
});

it("does not require image authority for a development home with no update journals", async () => {
  const f = fixture();
  unlinkSync(f.file);
  const admission = new RuntimeUpdateAdmission(f.home);
  await admission.restorePrepared({
    images: undefined,
    readCell: (cell) => f.store.get(cell),
    verify: f.verify,
    canPublish: () => true,
  });
  expect(admission.held(id)).toBe(false);
  expect(admission.creationAllowed()).toBe(true);
  expect(f.verify).not.toHaveBeenCalled();
});

it("rechecks runtime admission after asynchronous Start verification before wiring keys", async () => {
  const f = fixture();
  let held = false;
  const wire = vi.fn();
  const cells = new CellOrchestrator({
    store: f.store,
    docker: f.docker,
    images,
    runtimeHold: () => held,
    verifyRuntime: async () => {
      held = true;
    },
    keyd: {
      wire,
      isWired: async () => false,
      refresh: async () => [],
      revoke: async () => 0,
      close: async () => {},
    },
    probeDesktopd: async () => undefined,
    probeStream: async () => false,
  });
  await expect(cells.start(id)).rejects.toThrow("admission changed");
  expect(wire).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  cells.dispose();
});

it("admits only locally recorded system snapshots derived from the installed release", async () => {
  const f = fixture();
  const snapshotImage = `sha256:${hex(12)}`;
  const baseImage = f.containers.desktop.Image;
  const labels = { "localdot.snapshot": other, "localdot.snapshot-source": hex(13) };
  const state = new ComputerSystemState(f.home, f.docker, images.desktop);
  const snapshot = {
    cellId: other,
    container: hex(13),
    image: snapshotImage,
    baseImage,
    homeVolume: "snapshot-home",
  };
  state.records.write(other, snapshot);
  f.containers.desktop.Image = snapshotImage;
  f.containers.desktop.Config.Image = snapshotImage;
  Object.assign(f.containers.desktop.Config.Labels, labels);
  const original = f.request.getMockImplementation();
  if (!original) throw new Error("Missing Docker fixture");
  f.request.mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
    if (req.path === `/images/${encodeURIComponent(snapshotImage)}/json`)
      return { Id: snapshotImage, Config: { Labels: labels } } as T;
    if (req.path === "/volumes/snapshot-home")
      return {
        Name: "snapshot-home",
        Labels: { "localdot.cell": other, "localdot.role": "home" },
      } as T;
    return (await original(req)) as T;
  });
  await expect(
    verifyDesktopRuntimeImages(f.docker, f.record, images, f.home),
  ).resolves.toBeUndefined();
  state.records.write(other, { ...snapshot, baseImage: `sha256:${hex(14)}` });
  await expect(verifyDesktopRuntimeImages(f.docker, f.record, images, f.home)).rejects.toThrow(
    "does not match",
  );
  state.records.write(other, snapshot);
  f.containers.desktop.Image = `sha256:${hex(15)}`;
  await expect(verifyDesktopRuntimeImages(f.docker, f.record, images, f.home)).rejects.toThrow(
    "does not match",
  );
});

it("admits a preserved system only when its actual image records the installed base", async () => {
  const f = fixture();
  const migrated = `sha256:${hex(12)}`;
  const base = f.manifests.desktop.Id;
  const labels = { "localdot.system-base": base, "localdot.system-source": hex(2) };
  f.containers.desktop.Image = migrated;
  f.containers.desktop.Config.Image = migrated;
  Object.assign(f.containers.desktop.Config.Labels, labels);
  const request = f.request.getMockImplementation();
  if (!request) throw new Error("missing mock");
  f.request.mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
    if (req.path === `/images/${encodeURIComponent(migrated)}/json`)
      return {
        Id: migrated,
        Os: "linux",
        Architecture: "arm64",
        Config: { Labels: { ...labels } },
      } as T;
    return request(req) as Promise<T>;
  });
  await expect(verifyDesktopRuntimeImages(f.docker, f.record, images)).resolves.toBeUndefined();
  labels["localdot.system-base"] = `sha256:${hex(13)}`;
  await expect(verifyDesktopRuntimeImages(f.docker, f.record, images)).rejects.toThrow(
    "does not match",
  );
});

it("admits a migrated system that still carries the labels of the snapshot it came from", async () => {
  const f = fixture();
  const migrated = `sha256:${hex(12)}`;
  const base = f.manifests.desktop.Id;
  // Docker commit merges the source snapshot's labels into the migrated image. Its system-base
  // label is the authority, so neither a stale snapshot record nor its purged home is consulted.
  const labels = {
    "localdot.system-base": base,
    "localdot.system-source": hex(2),
    "localdot.snapshot": other,
    "localdot.snapshot-source": hex(13),
  };
  f.containers.desktop.Image = migrated;
  f.containers.desktop.Config.Image = migrated;
  Object.assign(f.containers.desktop.Config.Labels, labels);
  const request = f.request.getMockImplementation();
  if (!request) throw new Error("missing mock");
  f.request.mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
    if (req.path === `/images/${encodeURIComponent(migrated)}/json`)
      return {
        Id: migrated,
        Os: "linux",
        Architecture: "arm64",
        Config: { Labels: { ...labels } },
      } as T;
    return request(req) as Promise<T>;
  });
  await expect(
    verifyDesktopRuntimeImages(f.docker, f.record, images, f.home),
  ).resolves.toBeUndefined();
});

it("admits a snapshot computer after the snapshot's own home volume was purged", async () => {
  const f = fixture();
  const snapshotImage = `sha256:${hex(12)}`;
  const labels = { "localdot.snapshot": other, "localdot.snapshot-source": hex(13) };
  new ComputerSystemState(f.home, f.docker, images.desktop).records.write(other, {
    cellId: other,
    container: hex(13),
    image: snapshotImage,
    baseImage: f.containers.desktop.Image,
    homeVolume: "purged-home",
  });
  f.containers.desktop.Image = snapshotImage;
  f.containers.desktop.Config.Image = snapshotImage;
  Object.assign(f.containers.desktop.Config.Labels, labels);
  const original = f.request.getMockImplementation();
  if (!original) throw new Error("Missing Docker fixture");
  f.request.mockImplementation(async <T>(req: DockerRequest): Promise<T> => {
    if (req.path === `/images/${encodeURIComponent(snapshotImage)}/json`)
      return { Id: snapshotImage, Config: { Labels: labels } } as T;
    return (await original(req)) as T;
  });
  await expect(
    verifyDesktopRuntimeImages(f.docker, f.record, images, f.home),
  ).resolves.toBeUndefined();
});
