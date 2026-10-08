import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { imageRef, ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { ComputerFences } from "../../../daemon/src/agent/safety/fences.ts";
import { DockerError, type DockerRequest } from "../../../daemon/src/cells/docker.ts";
import type { runtimeCandidateSpec } from "../../../daemon/src/cells/runtime-update-candidate.ts";
import { RuntimeUpdateStore } from "../../../daemon/src/cells/runtime-update-store.ts";
import { cellNames } from "../../../daemon/src/cells/spec.ts";
import type { CellRecord } from "../../../daemon/src/cells/types.ts";
import { prepareInstalledRuntimes } from "./prepare-runtimes.ts";
import { serviceConfigurationId } from "./service-definition.ts";

const mock = vi.hoisted(() => ({
  service: vi.fn(),
  leases: vi.fn(),
  release: vi.fn(),
  images: vi.fn(),
  docker: vi.fn(),
  update: vi.fn(),
  contain: vi.fn(),
}));
vi.mock("./container-containment.ts", async (original) => ({
  ...(await original<typeof import("./container-containment.ts")>()),
  containInstalledContainers: mock.contain,
}));
vi.mock("./service-journal.ts", async (original) => ({
  ...(await original<typeof import("./service-journal.ts")>()),
  serviceJournalStore: () => ({ read: mock.service }),
}));
vi.mock("./service-retirement.ts", () => ({ withStoppedServiceLeases: mock.leases }));
vi.mock("./promote-release.ts", () => ({ readInstalledRelease: mock.release }));
vi.mock("./image-client.ts", () => ({ installImageClient: mock.images }));
vi.mock("./runtime-client.ts", () => ({ installRuntimeClient: mock.docker }));
vi.mock("./update-journal.ts", () => ({ updateJournalStore: () => ({ read: mock.update }) }));
const homes: string[] = [];
afterEach(async () => {
  for (const fn of Object.values(mock)) fn.mockReset();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const hex = (n: number) => n.toString(16).padStart(64, "0");
const off = { Running: false, Paused: false, Restarting: false };
interface ObjectFixture {
  Id?: string;
  Name?: string;
  Image?: string;
  Config?: { Image: string; Labels: Record<string, string>; Env?: string[]; User?: string };
  State?: typeof off;
  volume?: string;
  Labels?: Record<string, string>;
  Sentinel?: string;
  HostConfig?: unknown;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture value missing");
  return value;
}
async function fixture(count = 1) {
  const home = await realpath(await mkdtemp("/private/tmp/localdot-runtime-host-"));
  homes.push(home);
  const state = join(home, "install");
  await mkdir(state, { mode: 0o700 });
  await mkdir(join(home, "cells"), { mode: 0o700 });
  const previous = ReleaseManifest.parse(sampleManifest()),
    next = ReleaseManifest.parse(sampleManifest()),
    manifests = [previous, next];
  next.version = "1.1.0";
  for (const pin of Object.values(next.images)) pin.digest = `sha256:${"b".repeat(64)}`;
  const identity = (version: string) => ({
    version,
    packageSha256: (version === "1.0.0" ? "a" : "b").repeat(64),
    manifestSha256: (version === "1.0.0" ? "c" : "d").repeat(64),
  });
  const settings = {
    home,
    state,
    userHome: home,
    uid: process.getuid?.() ?? -1,
    ownerId: "e".repeat(32),
    node: process.execPath,
    dockerSocket: join(home, "docker.sock"),
    port: 4875,
  };
  const config = (version: string) => ({
    settings,
    release: identity(version),
    configuration: serviceConfigurationId(settings, identity(version)),
  });
  const target = config(next.version),
    old = config(previous.version),
    controller = new AbortController();
  mock.service.mockResolvedValue({ configuration: old, phase: "stopped" });
  let held = false;
  const recheck = vi.fn(async () => {
    expect(held).toBe(true);
    controller.signal.throwIfAborted();
  });
  mock.leases.mockImplementation(async (_c, _h, _s, work) => {
    held = true;
    try {
      await recheck();
      const result = await work(recheck);
      await recheck();
      return result;
    } finally {
      held = false;
    }
  });
  mock.contain.mockImplementation(async () => {
    expect(held).toBe(true);
  });
  const update = { previous: old.release, candidate: target.release, phase: "activating" };
  mock.update.mockImplementation(async () => structuredClone(update));
  mock.release.mockImplementation(async (_state, id) => {
    const manifest = manifests.find((m) => m.version === id.version);
    if (!manifest) throw new Error("unanchored release");
    return { record: { identity: id }, manifest: structuredClone(manifest) };
  });
  const image = (ref: string) => ({
    Id: ref.slice(ref.indexOf("@") + 1),
    Os: "linux",
    Architecture: "arm64",
    RepoDigests: [ref],
  });
  const engine = vi.fn(async () => ({
    id: "fixture-engine",
    operatingSystem: "linux",
    architecture: "arm64",
  }));
  const inspect = vi.fn(async (pin) => image(imageRef(pin))),
    pull = vi.fn();
  mock.images.mockReturnValue({ engine, inspect, pull });
  const sources: CellRecord[] = [],
    objects = new Map<string, ObjectFixture>(),
    aliases = new Map<string, string>();
  for (let n = 1; n <= count; n++) {
    const id = `01JXYZ0000000000000000000${n}`;
    const source: CellRecord = {
      v: 2,
      kind: "desktop",
      id,
      createdAt: "2026-10-07T00:00:00Z",
      scale: 1,
      keydPort: 4759 + n,
      tokens: { desktopd: "d".repeat(43), stream: "s".repeat(43) },
      docker: {
        ...cellNames(id),
        gateInternalIp: "10.3.0.10",
        gateEgressIp: "10.4.0.10",
        desktopIp: "10.3.0.11",
      },
      ownership: {
        gate: hex(n * 10 + 1),
        desktop: hex(n * 10 + 2),
        internalNetwork: hex(n * 10 + 3),
        egressNetwork: hex(n * 10 + 4),
      },
    };
    sources.push(source);
    await mkdir(join(home, "cells", id), { mode: 0o700 });
    await writeFile(join(home, "cells", id, "cell.json"), JSON.stringify(source), { mode: 0o600 });
    for (const role of ["gate", "desktop"] as const) {
      const key = `/containers/${source.ownership?.[role]}`;
      objects.set(key, {
        Id: source.ownership?.[role],
        Name: `/${source.docker[role]}`,
        Image: previous.images[role].digest,
        Config: {
          Image: imageRef(previous.images[role]),
          Labels: { "localdot.cell": id, "localdot.role": role },
        },
        State: { ...off },
        volume: role === "desktop" ? source.docker.homeVolume : undefined,
      });
      aliases.set(`/containers/${source.docker[role]}`, key);
    }
    for (const [field, role] of [
      ["internalNetwork", "internal"],
      ["egressNetwork", "egress"],
    ] as const) {
      const key = `/networks/${source.ownership?.[field]}`;
      objects.set(key, {
        Id: source.ownership?.[field],
        Labels: { "localdot.cell": id, "localdot.role": role },
      });
      aliases.set(`/networks/${source.docker[field]}`, key);
    }
    objects.set(`/volumes/${source.docker.homeVolume}`, {
      Name: source.docker.homeVolume,
      Labels: { "localdot.cell": id, "localdot.role": "home" },
      Sentinel: `files-${n}`,
    });
  }
  // An unrelated retained browser profile must never be touched by desktop preparation.
  objects.set("/volumes/browser-profile", { Sentinel: "browser cookies" });
  let nextId = 100;
  const mutations: DockerRequest[] = [],
    controls = {
      failCreate: false,
      loseCreate: false,
      afterMutation: undefined as (() => void) | undefined,
    };
  const request = vi.fn(async (r: DockerRequest) => {
    expect(held).toBe(true);
    if (r.method === "GET" && r.path.startsWith("/images/"))
      return image(decodeURIComponent(r.path.slice(8, -5)));
    if (r.method === "GET" && r.path === "/containers/json") {
      const volume = JSON.parse(r.query?.filters ?? "{}").volume[0];
      return [...objects.values()].filter((o) => o.volume === volume).map((o) => ({ Id: o.Id }));
    }
    const path = r.path.replace(/\/json$/, ""),
      key = aliases.get(path) ?? path;
    if (r.method === "GET") {
      const found = objects.get(key);
      if (!found) throw new DockerError(404, "fixture missing", path);
      return structuredClone(found);
    }
    mutations.push(structuredClone(r));
    if (r.method === "DELETE" && path.startsWith("/containers/")) {
      expect(r.query).toBeUndefined();
      objects.delete(key);
      controls.afterMutation?.();
      return undefined;
    }
    if (r.method === "POST" && path === "/containers/create") {
      if (controls.failCreate) throw new Error("fixture offline");
      const spec = r.body as ReturnType<typeof runtimeCandidateSpec>,
        id = hex(nextId++);
      expect(new RuntimeUpdateStore(home).read(required(spec.Labels["localdot.cell"]))?.phase).toBe(
        "creating",
      );
      const key = `/containers/${id}`;
      objects.set(key, {
        Id: id,
        Name: `/${r.query?.name}`,
        Image: spec.Image.split("@")[1],
        Config: {
          Image: spec.Image,
          Env: spec.Env,
          User: "User" in spec ? spec.User : undefined,
          Labels: spec.Labels,
        },
        HostConfig: structuredClone(spec.HostConfig),
        State: { ...off },
        volume: "Mounts" in spec.HostConfig ? spec.HostConfig.Mounts[0]?.Source : undefined,
      });
      aliases.set(`/containers/${r.query?.name}`, key);
      controls.afterMutation?.();
      if (controls.loseCreate) throw new Error("lost creation reply");
      return { Id: id };
    }
    throw new Error("unexpected mutation");
  });
  mock.docker.mockReturnValue({ request });
  const saved = async (id: string) =>
    JSON.parse(await readFile(join(home, "cells", id, "cell.json"), "utf8")) as CellRecord;
  return {
    home,
    target,
    old,
    next,
    previous,
    sources,
    objects,
    mutations,
    controls,
    controller,
    saved,
    engine,
    inspect,
    pull,
    recheck,
    update,
    request,
    run: (c = target) => prepareInstalledRuntimes(c, "/verified/helper", controller.signal),
  };
}
it("prepares multiple retained computers under leases and is idempotent", async () => {
  const f = await fixture(2);
  await f.run();
  expect(f.mutations).toHaveLength(8);
  for (const source of f.sources) {
    const saved = await f.saved(source.id);
    expect({ ...saved, ownership: source.ownership }).toEqual(source);
    expect(saved.ownership?.desktop).not.toBe(source.ownership?.desktop);
    expect(f.objects.get(`/volumes/${source.docker.homeVolume}`)?.Sentinel).toMatch(/^files-/);
  }
  expect(f.objects.get("/volumes/browser-profile")).toEqual({ Sentinel: "browser cookies" });
  await f.run();
  expect(f.mutations).toHaveLength(8);
  expect(f.pull).not.toHaveBeenCalled();
});
it("finishes an interrupted candidate before preparing all computers for rollback", async () => {
  const f = await fixture(2);
  f.controls.failCreate = true;
  await expect(f.run()).rejects.toThrow("runtime preparation is incomplete");
  expect(new RuntimeUpdateStore(f.home).read(required(f.sources[0]).id)?.phase).toBe("creating");
  f.controls.failCreate = false;
  f.controls.loseCreate = true;
  await f.run(f.old);
  for (const source of f.sources) {
    const saved = await f.saved(source.id);
    expect(f.objects.get(`/containers/${saved.ownership?.desktop}`)?.Config?.Image).toBe(
      imageRef(f.previous.images.desktop),
    );
  }
  expect(
    f.mutations.every(
      (m) => m.path === "/containers/create" || /^\/containers\/[a-f0-9]{64}$/.test(m.path),
    ),
  ).toBe(true);
});
it("keeps a durable native-fenced identity untouched while updating another computer", async () => {
  const f = await fixture(2),
    retired = required(f.sources[0]);
  new ComputerFences(f.home).capture(retired.id, "01JXYZ00000000000000000009", "native");
  await f.run();
  expect(await f.saved(retired.id)).toEqual(retired);
  expect(f.mutations).toHaveLength(4);
});
it("rolls back a batch containing both completed and interrupted computer migrations", async () => {
  const f = await fixture(2);
  f.controls.afterMutation = () => {
    if (f.mutations.length >= 5) f.controls.failCreate = true;
  };
  await expect(f.run()).rejects.toThrow();
  expect(new RuntimeUpdateStore(f.home).read(required(f.sources[0]).id)?.phase).toBe("prepared");
  expect(new RuntimeUpdateStore(f.home).read(required(f.sources[1]).id)?.phase).toBe("creating");
  f.controls.afterMutation = undefined;
  f.controls.failCreate = false;
  await f.run(f.old);
  for (const source of f.sources) {
    const saved = await f.saved(source.id);
    expect(f.objects.get(`/containers/${saved.ownership?.desktop}`)?.Config?.Image).toBe(
      imageRef(f.previous.images.desktop),
    );
    expect(f.objects.get(`/volumes/${saved.docker.homeVolume}`)?.Sentinel).toMatch(/^files-/);
  }
});
it.each(["lease", "containment", "image", "engine", "record", "journal-authority"])(
  "refuses %s uncertainty before further effects",
  async (fault) => {
    const f = await fixture();
    if (fault === "lease") f.recheck.mockRejectedValue(new Error("lost lease"));
    if (fault === "containment")
      mock.contain.mockRejectedValue(new Error("unknown running executor"));
    if (fault === "image") f.inspect.mockResolvedValue(null as never);
    if (fault === "engine")
      f.engine.mockResolvedValueOnce({
        id: "first",
        operatingSystem: "linux",
        architecture: "arm64",
      });
    if (fault === "record")
      await writeFile(join(f.home, "cells", required(f.sources[0]).id, "cell.json"), "unsafe", {
        mode: 0o600,
      });
    if (fault === "journal-authority") {
      f.controls.failCreate = true;
      await expect(f.run()).rejects.toThrow();
      f.controls.failCreate = false;
      f.update.candidate = f.old.release;
    }
    const before = f.mutations.length;
    await expect(f.run(fault === "journal-authority" ? f.old : f.target)).rejects.toThrow(
      "runtime preparation is incomplete",
    );
    expect(f.mutations).toHaveLength(before);
    expect(f.pull).not.toHaveBeenCalled();
  },
);
it("does not dispatch more mutations after cancellation", async () => {
  const f = await fixture();
  f.controls.afterMutation = () => f.controller.abort();
  await expect(f.run()).rejects.toThrow();
  expect(f.mutations).toHaveLength(1);
});
it("only permits an empty inventory without a first service journal", async () => {
  const f = await fixture(0);
  mock.service.mockResolvedValue(null);
  await f.run();
  expect(mock.leases).not.toHaveBeenCalled();
  const g = await fixture();
  mock.service.mockResolvedValue(null);
  await expect(g.run()).rejects.toThrow();
  expect(g.mutations).toHaveLength(0);
});
