import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DockerError, type DockerRequest } from "./docker.ts";
import { prepareDesktopRuntime, type RuntimeUpdateHost } from "./runtime-update.ts";
import { preparedRuntimeRecord, RuntimeUpdateStore } from "./runtime-update-store.ts";
import { cellNames, type desktopSpec, type gateSpec } from "./spec.ts";
import type { CellRecord } from "./types.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const hex = (n: number) => n.toString(16).repeat(64);
const cellId = "01JXYZ00000000000000000001";
const images = {
  gate: `ghcr.io/example/gate@sha256:${hex(8)}`,
  desktop: `ghcr.io/example/desktop@sha256:${hex(9)}`,
};
const input = { cellId, images, fullcolor: true };
const off = { Running: false, Paused: false, Restarting: false };
interface ContainerFixture {
  Id: string;
  Config: { Labels: Record<string, string>; Image?: string; Env: string[]; User?: string };
  State: typeof off;
  HostConfig: Record<string, unknown>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture value missing");
  return value;
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-runtime-update-"));
  homes.push(home);
  const source: CellRecord = {
    v: 2,
    kind: "desktop",
    id: cellId,
    scale: 2,
    createdAt: "2026-10-07T00:00:00Z",
    keydPort: 4760,
    tokens: { desktopd: "d".repeat(43), stream: "s".repeat(43) },
    docker: {
      ...cellNames(cellId),
      gateInternalIp: "10.3.0.10",
      gateEgressIp: "10.4.0.10",
      desktopIp: "10.3.0.11",
    },
    ownership: { gate: hex(1), desktop: hex(2), internalNetwork: hex(3), egressNetwork: hex(4) },
  };
  let current = structuredClone(source);
  const objects = new Map<string, Record<string, unknown>>();
  const aliases = new Map<string, string>();
  const mounted = new Set([hex(2)]);
  const mutations: DockerRequest[] = [];
  const labels = (role: string) => ({ "localdot.cell": cellId, "localdot.role": role });
  for (const role of ["gate", "desktop"] as const) {
    const key = `/containers/${source.ownership?.[role]}`;
    aliases.set(`/containers/${source.docker[role]}`, key);
    objects.set(key, {
      Id: source.ownership?.[role],
      Config: { Labels: labels(role) },
      State: { ...off },
    });
  }
  for (const [field, role] of [
    ["internalNetwork", "internal"],
    ["egressNetwork", "egress"],
  ] as const) {
    const key = `/networks/${source.ownership?.[field]}`;
    aliases.set(`/networks/${source.docker[field]}`, key);
    objects.set(key, { Id: source.ownership?.[field], Labels: labels(role) });
  }
  objects.set(`/volumes/${source.docker.homeVolume}`, {
    Name: source.docker.homeVolume,
    Labels: labels("home"),
    Sentinel: "user files retained",
  });
  const controls = {
    loseDeleteReply: false,
    loseCreateReply: false,
    failCreate: false,
    keepDeleted: false,
    quiescent: true,
    failSave: false,
    saveThenFail: false,
    afterMutation: undefined as undefined | ((request: DockerRequest) => void),
  };
  let nextId = 5;
  const request = vi.fn(async (req: DockerRequest) => {
    if (req.method === "GET" && req.path === "/containers/json")
      return [...mounted].map((Id) => ({ Id }));
    const path = req.path.replace(/\/json$/, "");
    const key = aliases.get(path) ?? path;
    if (req.method === "GET" && req.path.endsWith("/changes")) return [];
    if (req.method === "GET") {
      const result = objects.get(key);
      if (!result) throw new DockerError(404, "absent", req.path);
      return structuredClone(result);
    }
    mutations.push(structuredClone(req));
    // Every physical mutation must have its write-ahead intent on disk.
    expect(new RuntimeUpdateStore(home).read(cellId)).toBeDefined();
    if (req.method === "DELETE" && path.startsWith("/containers/")) {
      expect(req.query).toBeUndefined();
      if (!controls.keepDeleted) {
        objects.delete(key);
        mounted.delete(key.split("/").at(-1) as string);
      }
      controls.afterMutation?.(req);
      if (controls.loseDeleteReply) throw new Error("fixture lost DELETE reply");
      return undefined;
    }
    if (req.method === "POST" && path === "/containers/create") {
      if (controls.failCreate) throw new Error("fixture unavailable");
      const spec = req.body as ReturnType<typeof gateSpec> | ReturnType<typeof desktopSpec>;
      const role = spec.Labels["localdot.role"];
      const id = hex(nextId++);
      const target = `/containers/${id}`;
      objects.set(target, {
        Id: id,
        Name: `/${req.query?.name}`,
        Config: {
          Image: spec.Image,
          Env: ["PATH=/bin", ...spec.Env],
          Labels: spec.Labels,
          User: "User" in spec ? spec.User : undefined,
        },
        HostConfig: structuredClone(spec.HostConfig),
        State: { ...off },
      });
      aliases.set(`/containers/${req.query?.name}`, target);
      if (role === "desktop") mounted.add(id);
      controls.afterMutation?.(req);
      if (controls.loseCreateReply) throw new Error("fixture lost POST reply");
      return { Id: id };
    }
    throw new Error("unexpected destructive operation");
  });
  const journal = new RuntimeUpdateStore(home);
  const host: RuntimeUpdateHost = {
    docker: { request: request as RuntimeUpdateHost["docker"]["request"] },
    journal,
    readCell: () => structuredClone(current),
    saveCell: vi.fn((record) => {
      if (controls.failSave) throw new Error("fixture save failed");
      current = structuredClone(record);
      if (controls.saveThenFail) throw new Error("fixture lost save acknowledgement");
    }),
    assertQuiescent: vi.fn(async () => {
      if (!controls.quiescent) throw new Error("fixture admission open");
    }),
  };
  return {
    home,
    source,
    host,
    journal,
    objects,
    aliases,
    mounted,
    mutations,
    controls,
    request,
    container: (id: string) =>
      required(objects.get(`/containers/${id}`)) as unknown as ContainerFixture,
    changeCell: (f: (c: CellRecord) => void) => f(current),
    restart: (): RuntimeUpdateHost => ({ ...host, journal: new RuntimeUpdateStore(home) }),
  };
}

it("prepares both pinned containers while retaining all identity, home data and networks", async () => {
  const f = fixture();
  const retained = [...f.objects].filter(([key]) => !key.startsWith("/containers/"));
  const next = await prepareDesktopRuntime(f.host, input);
  expect(next).toEqual({
    ...f.source,
    ownership: { ...f.source.ownership, gate: hex(5), desktop: hex(6) },
  });
  expect([...f.objects].filter(([key]) => !key.startsWith("/containers/"))).toEqual(retained);
  expect(f.mutations.map((r) => [r.method, r.path])).toEqual([
    ["DELETE", `/containers/${hex(1)}`],
    ["DELETE", `/containers/${hex(2)}`],
    ["POST", "/containers/create"],
    ["POST", "/containers/create"],
  ]);
  expect(f.journal.read(cellId)?.phase).toBe("prepared");
  expect(f.mutations.some((r) => /volumes|networks|start/.test(r.path))).toBe(false);
  const count = f.mutations.length;
  expect(await prepareDesktopRuntime(f.restart(), input)).toEqual(next);
  expect(f.mutations).toHaveLength(count);
  expect(statSync(join(f.home, "safety/computer-updates", `${cellId}.json`)).mode & 0o777).toBe(
    0o600,
  );
});

it.each(["loseDeleteReply", "loseCreateReply"] as const)(
  "recovers %s using physical evidence",
  async (fault) => {
    const f = fixture();
    f.controls[fault] = true;
    await expect(prepareDesktopRuntime(f.host, input)).resolves.toMatchObject({ id: cellId });
    expect(f.mutations).toHaveLength(4);
  },
);

it("resumes after restart with an unrecorded candidate and never repeats its creation", async () => {
  const f = fixture();
  const write = f.journal.write.bind(f.journal);
  vi.spyOn(f.journal, "write").mockImplementation((j) => {
    if (j.candidates.gate) throw new Error("fixture disk full");
    write(j);
  });
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  expect(f.journal.read(cellId)?.candidates.gate).toBeNull();
  await expect(prepareDesktopRuntime(f.restart(), input)).resolves.toBeDefined();
  expect(f.mutations.filter((r) => r.method === "POST")).toHaveLength(2);
});

it.each(["failSave", "saveThenFail"] as const)(
  "replays a prepared journal after %s",
  async (fault) => {
    const f = fixture();
    f.controls[fault] = true;
    await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
    expect(f.journal.read(cellId)?.phase).toBe("prepared");
    f.controls[fault] = false;
    await expect(prepareDesktopRuntime(f.restart(), input)).resolves.toEqual(
      preparedRuntimeRecord(required(f.journal.read(cellId))),
    );
    expect(f.mutations).toHaveLength(4);
  },
);

it.each([
  "running",
  "paused",
  "missing",
  "foreign",
  "missing-home",
  "foreign-mount",
  "changed-network",
  "admission",
])("refuses %s before any mutation", async (fault) => {
  const f = fixture(),
    desktop = f.container(hex(2));
  if (fault === "running") desktop.State.Running = true;
  if (fault === "paused") desktop.State.Paused = true;
  if (fault === "missing") f.objects.delete(`/containers/${hex(2)}`);
  if (fault === "foreign") desktop.Config.Labels["localdot.cell"] = "other";
  if (fault === "missing-home") f.objects.delete(`/volumes/${f.source.docker.homeVolume}`);
  if (fault === "foreign-mount") f.mounted.add(hex(7));
  if (fault === "changed-network") required(f.objects.get(`/networks/${hex(3)}`)).Id = hex(7);
  if (fault === "admission") f.controls.quiescent = false;
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(0);
});

it("requires observed retirement even after successful DELETE", async () => {
  const f = fixture();
  f.controls.keepDeleted = true;
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(1);
  expect(f.journal.read(cellId)?.phase).toBe("retiring");
});

it("stops after admission is lost and resumes exact retirement only when restored", async () => {
  const f = fixture();
  f.controls.afterMutation = () => {
    f.controls.quiescent = false;
  };
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(1);
  f.controls.afterMutation = undefined;
  f.controls.quiescent = true;
  await expect(prepareDesktopRuntime(f.restart(), input)).resolves.toBeDefined();
  expect(f.mutations).toHaveLength(4);
});

it.each(["marker", "image", "mount", "environment", "running"])(
  "does not adopt a candidate with a changed %s",
  async (fault) => {
    const f = fixture();
    f.controls.afterMutation = (req) => {
      if (req.method !== "POST") return;
      const raw = f.container(hex(5));
      if (fault === "marker") raw.Config.Labels["localdot.runtime-update"] = "other";
      if (fault === "image") raw.Config.Image = "untrusted:latest";
      if (fault === "mount") raw.HostConfig.NetworkMode = "host";
      if (fault === "environment") raw.Config.Env.push("LD_KEYD_PORT=1");
      if (fault === "running") raw.State.Running = true;
    };
    await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
    expect(f.host.saveCell).not.toHaveBeenCalled();
    expect(f.mutations).toHaveLength(3);
  },
);

it("refuses a different target while an earlier target is incomplete", async () => {
  const f = fixture();
  f.controls.failCreate = true;
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  const n = f.mutations.length;
  await expect(prepareDesktopRuntime(f.restart(), { ...input, fullcolor: false })).rejects.toThrow(
    "unconfirmed",
  );
  expect(f.mutations).toHaveLength(n);
});

it("refuses changed cell authority during an interrupted update", async () => {
  const f = fixture();
  f.controls.failCreate = true;
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  f.changeCell((c) => {
    c.tokens.desktopd = "x".repeat(43);
  });
  const n = f.mutations.length;
  await expect(prepareDesktopRuntime(f.restart(), input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(n);
});

it("never recreates a recorded candidate that disappeared", async () => {
  const f = fixture();
  await prepareDesktopRuntime(f.host, input);
  f.objects.delete(`/containers/${hex(5)}`);
  await expect(prepareDesktopRuntime(f.restart(), input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(4);
});

it("refuses a missing journal observed during retirement", async () => {
  const f = fixture();
  f.controls.afterMutation = () =>
    rmSync(join(f.home, "safety/computer-updates", `${cellId}.json`));
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(1);
});

it("refuses unsafe journals and does not disclose source tokens in errors", async () => {
  const f = fixture();
  await prepareDesktopRuntime(f.host, input);
  const path = join(f.home, "safety/computer-updates", `${cellId}.json`);
  chmodSync(path, 0o644);
  await expect(prepareDesktopRuntime(f.restart(), input)).rejects.toThrow(
    /^Computer runtime update is unconfirmed/,
  );
  expect(f.mutations).toHaveLength(4);
  chmodSync(path, 0o600);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.source.tokens.desktopd = "sensitive-invalid-data";
  writeFileSync(path, `${JSON.stringify(raw)}\n`);
  await expect(prepareDesktopRuntime(f.restart(), input)).rejects.toThrow(
    /^Computer runtime update is unconfirmed/,
  );
});

it("prevents journal identity rewrites, phase rollback and candidate substitution", async () => {
  const f = fixture();
  await prepareDesktopRuntime(f.host, input);
  const j = required(f.journal.read(cellId));
  expect(() => f.journal.write({ ...j, images: { ...images, gate: images.desktop } })).toThrow();
  expect(() => f.journal.write({ ...j, phase: "creating" })).toThrow();
  expect(() => f.journal.write({ ...j, candidates: { ...j.candidates, gate: hex(7) } })).toThrow();
});

it("can prepare a rollback target after completing the interrupted target without starting either", async () => {
  const f = fixture();
  const home = structuredClone(f.objects.get(`/volumes/${f.source.docker.homeVolume}`));
  await prepareDesktopRuntime(f.host, input);
  const firstOperation = f.journal.read(cellId)?.operationId;
  const previousImages = {
    gate: `ghcr.io/example/gate@sha256:${hex(10)}`,
    desktop: `ghcr.io/example/desktop@sha256:${hex(11)}`,
  };
  const next = await prepareDesktopRuntime(f.restart(), { ...input, images: previousImages });
  expect(next).toEqual({
    ...f.source,
    ownership: { ...f.source.ownership, gate: hex(7), desktop: hex(8) },
  });
  expect(f.journal.read(cellId)?.operationId).not.toBe(firstOperation);
  expect(f.objects.get(`/volumes/${f.source.docker.homeVolume}`)).toEqual(home);
  expect(f.mutations).toHaveLength(8);
  expect(
    f.mutations.filter((r) => r.method === "POST").map((r) => (r.body as { Image: string }).Image),
  ).toEqual([images.gate, images.desktop, previousImages.gate, previousImages.desktop]);
});

it("does nothing when the first durable intent cannot be saved", async () => {
  const f = fixture();
  vi.spyOn(f.journal, "write").mockImplementation(() => {
    throw new Error("fixture disk full");
  });
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(0);
});

it("recovers an initial intent whose durable write acknowledgement was lost", async () => {
  const f = fixture(),
    write = f.journal.write.bind(f.journal);
  vi.spyOn(f.journal, "write").mockImplementation((j) => {
    write(j);
    throw new Error("fixture lost acknowledgement");
  });
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(0);
  await expect(prepareDesktopRuntime(f.restart(), input)).resolves.toBeDefined();
  expect(f.mutations).toHaveLength(4);
});

it("preserves interrupted ownership and stops further effects on cancellation", async () => {
  const f = fixture(),
    abort = new AbortController();
  f.host.signal = abort.signal;
  f.controls.afterMutation = () => abort.abort();
  await expect(prepareDesktopRuntime(f.host, input)).rejects.toThrow("unconfirmed");
  expect(f.mutations).toHaveLength(1);
  expect(f.journal.read(cellId)?.phase).toBe("retiring");
  f.controls.afterMutation = undefined;
  await expect(
    prepareDesktopRuntime({ ...f.restart(), signal: undefined }, input),
  ).resolves.toBeDefined();
  expect(f.mutations).toHaveLength(4);
});

it("refuses tag-based targets before touching Docker or journaling", async () => {
  const f = fixture();
  await expect(
    prepareDesktopRuntime(f.host, { ...input, images: { ...images, gate: "example/gate:latest" } }),
  ).rejects.toThrow("unconfirmed");
  expect(f.request).not.toHaveBeenCalled();
  expect(f.journal.read(cellId)).toBeUndefined();
});
