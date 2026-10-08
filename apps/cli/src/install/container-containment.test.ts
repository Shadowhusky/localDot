import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeCandidateSpec } from "../../../daemon/src/cells/runtime-update-candidate.ts";
import {
  preparedRuntimeRecord,
  type RuntimeUpdateJournal,
  RuntimeUpdateStore,
} from "../../../daemon/src/cells/runtime-update-store.ts";
import { sampleRecord } from "../../../daemon/src/cells/testing/sample-record.ts";
import type { StoredCellRecord } from "../../../daemon/src/cells/types.ts";
import type { InstallContainerClient } from "./container-client.ts";
import { containServiceContainers, readContainerInventory } from "./container-containment.ts";
import { readRuntimeUpdateInventory } from "./runtime-update-inventory.ts";
import { serviceConfigurationId } from "./service-definition.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
const first = "01JXYZ0000000000000000ABCD",
  second = "01JXYZ0000000000000000ABCE";
function fixture() {
  const settings = {
    state: "/private/install",
    home: "/private/home",
    userHome: "/Users/test",
    node: "/usr/local/bin/node",
    dockerSocket: "/private/docker.sock",
    uid: 501,
    port: 4750,
    ownerId: "e".repeat(32),
  };
  const release = {
    version: "1.2.3",
    packageSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  const config = { settings, release, configuration: serviceConfigurationId(settings, release) };
  const desktop = sampleRecord(first);
  desktop.ownership = {
    desktop: "a".repeat(64),
    gate: "b".repeat(64),
    internalNetwork: "1".repeat(64),
    egressNetwork: "2".repeat(64),
  };
  const records: StoredCellRecord[] = [desktop];
  const containers = new Map<
    string,
    {
      Id: string;
      Name: string;
      Config: { Labels: Record<string, string> };
      State: { Running: boolean; Paused: boolean; Restarting: boolean };
      HostConfig: { RestartPolicy: { Name: string } };
    }
  >();
  const add = (id: string, name: string, labels: Record<string, string>) => {
    const raw = {
      Id: id,
      Name: `/${name}`,
      Config: { Labels: labels },
      State: { Running: true, Paused: false, Restarting: false },
      HostConfig: { RestartPolicy: { Name: "no" } },
    };
    containers.set(id, raw);
    return raw;
  };
  add(desktop.ownership.desktop, desktop.docker.desktop, {
    "localdot.cell": first,
    "localdot.role": "desktop",
  });
  add(desktop.ownership.gate, desktop.docker.gate, {
    "localdot.cell": first,
    "localdot.role": "gate",
  });
  const homeLabel = createHash("sha256").update(settings.home).digest("hex").slice(0, 16);
  const brainLabels = {
    "localdot.home": homeLabel,
    "localdot.brain": second,
    "localdot.session": first,
    "localdot.role": "brain",
  };
  add("c".repeat(64), "localdot-brain-test", brainLabels);
  add("d".repeat(64), "foreign-brain", { ...brainLabels, "localdot.home": "foreign" });
  const inventory = vi.fn(async () => ({
    records: structuredClone(records),
    invalid: false,
    digest: "unchanged",
  }));
  const client: InstallContainerClient = {
    engine: vi.fn<InstallContainerClient["engine"]>(async () => ({
      id: "engine-one",
      architecture: "arm64",
      operatingSystem: "linux",
    })),
    list: vi.fn(async () =>
      [...containers.values()].map((c) => ({ Id: c.Id, Labels: { ...c.Config.Labels } })),
    ),
    inspect: vi.fn(async (ref) =>
      structuredClone(
        containers.get(ref) ?? [...containers.values()].find((c) => c.Name === `/${ref}`) ?? null,
      ),
    ),
    kill: vi.fn(async (id) => {
      const c = containers.get(id);
      if (c) c.State = { Running: false, Paused: false, Restarting: false };
    }),
  };
  return { config, records, desktop, containers, add, brainLabels, client, inventory };
}
it("stops only this home's exact owners, gates first, and independently checks final state", async () => {
  const f = fixture();
  const result = await containServiceContainers(f.config, f.client, f.inventory, signal());
  expect(result).toEqual({ engineId: "engine-one", observedContainers: 3 });
  expect(vi.mocked(f.client.kill).mock.calls.map(([id]) => id)).toEqual([
    "b".repeat(64),
    "a".repeat(64),
    "c".repeat(64),
  ]);
  expect(f.containers.get("d".repeat(64))?.State.Running).toBe(true);
  expect(f.client.list).toHaveBeenCalledTimes(2);
  expect(f.inventory).toHaveBeenCalledTimes(2);
  expect(f.client.engine).toHaveBeenCalledTimes(2);
});
it("accounts for paused computers without issuing any resume/start/delete operation", async () => {
  const f = fixture(),
    c = f.containers.get("a".repeat(64));
  if (!c) throw new Error();
  c.State.Paused = true;
  await containServiceContainers(f.config, f.client, f.inventory, signal());
  expect(c.State).toEqual({ Running: false, Paused: false, Restarting: false });
});
it("contains browser and browser-gate records and preserves profile ownership", async () => {
  const f = fixture();
  f.records.push({
    v: 2,
    kind: "browser",
    id: second,
    parentCellId: first,
    createdAt: "2026-10-07",
    scale: 2,
    keydPort: 4761,
    tokens: { browserd: "b".repeat(43), stream: "s".repeat(43) },
    docker: {
      ...f.desktop.docker,
      browser: `localdot-browser-${second}`,
      gate: `localdot-browsergate-${second}`,
      profileVolume: `localdot-profile-${second}`,
      browserIp: "172.24.0.11",
    },
    ownership: {
      browser: "e".repeat(64),
      gate: "f".repeat(64),
      internalNetwork: "1".repeat(64),
      egressNetwork: "2".repeat(64),
    },
  });
  for (const [id, role] of [
    ["e", "browser"],
    ["f", "gate"],
  ])
    f.add((id as string).repeat(64), `browser-${role}`, {
      "localdot.cell": second,
      "localdot.role": role as string,
      "localdot.parent": first,
      "localdot.browser-owner": "fixture-owner",
    });
  expect(
    (await containServiceContainers(f.config, f.client, f.inventory, signal())).observedContainers,
  ).toBe(5);
});
it("accepts a lost kill reply only when subsequent inspection confirms stopped state", async () => {
  const f = fixture();
  vi.mocked(f.client.kill).mockImplementation(async (id) => {
    const c = f.containers.get(id);
    if (c) c.State.Running = false;
    throw new Error("lost reply");
  });
  await expect(
    containServiceContainers(f.config, f.client, f.inventory, signal()),
  ).resolves.toMatchObject({ observedContainers: 3 });
});
it.each(["replaced", "labels", "policy", "unknown-child", "malformed-records"])(
  "refuses %s ownership or unsafe state while containing other known owners",
  async (kind) => {
    const f = fixture(),
      c = f.containers.get("a".repeat(64));
    if (!c) throw new Error();
    if (kind === "replaced") {
      f.containers.delete(c.Id);
      c.Id = "9".repeat(64);
      f.containers.set(c.Id, c);
    }
    if (kind === "labels") c.Config.Labels["localdot.cell"] = "foreign";
    if (kind === "policy") c.HostConfig.RestartPolicy.Name = "always";
    if (kind === "unknown-child")
      f.add("9".repeat(64), "unknown", {
        "localdot.cell": "01JXYZ0000000000000000ABCF",
        "localdot.parent": first,
        "localdot.role": "browser",
      });
    if (kind === "malformed-records")
      f.inventory.mockResolvedValue({ records: f.records, invalid: true, digest: "bad" });
    await expect(
      containServiceContainers(f.config, f.client, f.inventory, signal()),
    ).rejects.toThrow("could not be confirmed");
    expect(f.containers.get("b".repeat(64))?.State.Running).toBe(false);
    expect(f.containers.get("c".repeat(64))?.State.Running).toBe(false);
    if (kind === "replaced" || kind === "labels") expect(c.State.Running).toBe(true);
    if (kind === "policy") expect(c.State.Running).toBe(false);
  },
);
it.each(["engine", "inventory", "new-container", "restarted", "owner-changed"])(
  "refuses a %s change during shutdown",
  async (kind) => {
    const f = fixture();
    let lists = 0;
    vi.mocked(f.client.list).mockImplementation(async () => {
      if (++lists === 2) {
        if (kind === "new-container") f.add("8".repeat(64), "new-brain", f.brainLabels);
        const c = f.containers.get("a".repeat(64));
        if (c && kind === "restarted") c.State.Running = true;
        const brain = f.containers.get("c".repeat(64));
        if (brain && kind === "owner-changed") brain.Config.Labels["localdot.session"] = second;
      }
      return [...f.containers.values()].map((c) => ({ Id: c.Id, Labels: c.Config.Labels }));
    });
    if (kind === "engine")
      vi.mocked(f.client.engine)
        .mockResolvedValueOnce({
          id: "engine-one",
          architecture: "arm64",
          operatingSystem: "linux",
        })
        .mockResolvedValue({ id: "engine-two", architecture: "arm64", operatingSystem: "linux" });
    if (kind === "inventory")
      f.inventory
        .mockResolvedValueOnce({ records: f.records, invalid: false, digest: "unchanged" })
        .mockResolvedValue({ records: f.records, invalid: false, digest: "changed" });
    await expect(
      containServiceContainers(f.config, f.client, f.inventory, signal()),
    ).rejects.toThrow("could not be confirmed");
  },
);
it("refuses an inspect response for a different ID without signalling that unexpected container", async () => {
  const f = fixture();
  vi.mocked(f.client.inspect).mockImplementation(async (ref) =>
    ref === "a".repeat(64)
      ? structuredClone(f.containers.get("d".repeat(64)))
      : structuredClone(
          f.containers.get(ref) ??
            [...f.containers.values()].find((c) => c.Name === `/${ref}`) ??
            null,
        ),
  );
  await expect(
    containServiceContainers(f.config, f.client, f.inventory, signal()),
  ).rejects.toThrow();
  expect(vi.mocked(f.client.kill).mock.calls.some(([id]) => id === "d".repeat(64))).toBe(false);
});
it("does not begin a cancelled shutdown", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(
    containServiceContainers(f.config, f.client, f.inventory, controller.signal),
  ).rejects.toThrow();
  expect(f.client.engine).not.toHaveBeenCalled();
  expect(f.client.kill).not.toHaveBeenCalled();
});
async function homeFixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdot-contain-")));
  roots.push(home);
  await chmod(home, 0o700);
  return home;
}
it("reads real private records without creating absent directories or revealing tokens", async () => {
  const home = await homeFixture();
  expect(await readContainerInventory(home)).toEqual({
    records: [],
    invalid: false,
    digest: "absent",
  });
  const directory = join(home, "cells", first);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "cell.json"), JSON.stringify(sampleRecord(first)), {
    mode: 0o600,
  });
  const result = await readContainerInventory(home);
  expect(result.records).toHaveLength(1);
  expect(result.invalid).toBe(false);
  await writeFile(join(directory, "cell.json"), "private malformed token");
  const invalid = await readContainerInventory(home);
  expect(invalid.records).toEqual([]);
  expect(invalid.invalid).toBe(true);
});
it("refuses dangling cells links and marks linked records invalid", async () => {
  const home = await homeFixture();
  await symlink(join(home, "absent"), join(home, "cells"));
  await expect(readContainerInventory(home)).rejects.toThrow();
  await rm(join(home, "cells"));
  await mkdir(join(home, "cells"), { mode: 0o700 });
  await symlink(join(home, "absent"), join(home, "cells", first));
  expect((await readContainerInventory(home)).invalid).toBe(true);
});

function updateFixture() {
  const f = fixture();
  const journal: RuntimeUpdateJournal = {
    v: 1,
    operationId: "00000000-0000-4000-8000-000000000001",
    source: structuredClone(f.desktop),
    images: {
      gate: `ghcr.io/example/gate@sha256:${"8".repeat(64)}`,
      desktop: `ghcr.io/example/desktop@sha256:${"9".repeat(64)}`,
    },
    fullcolor: true,
    phase: "creating",
    candidates: { gate: null, desktop: null },
  };
  f.containers.delete("a".repeat(64));
  f.containers.delete("b".repeat(64));
  const create = (role: "gate" | "desktop", id: string) => {
    const spec = runtimeCandidateSpec(journal, role);
    const base = f.add(id, f.desktop.docker[role], spec.Labels);
    const raw = {
      ...base,
      Config: {
        ...base.Config,
        Image: spec.Image,
        Env: spec.Env,
        ...(role === "gate" ? { User: "nobody" } : {}),
      },
      HostConfig: { ...spec.HostConfig, RestartPolicy: { Name: "no" } },
    };
    f.containers.set(id, raw);
    return raw;
  };
  const gate = create("gate", "5".repeat(64)),
    desktop = create("desktop", "6".repeat(64));
  f.inventory.mockImplementation(async () => ({
    records: structuredClone(f.records),
    updates: [structuredClone(journal)],
    invalid: false,
    digest: JSON.stringify({ records: f.records, journal }),
  }));
  return { ...f, journal, gate, candidateDesktop: desktop };
}

it.each(["lost-create-reply", "recorded", "prepared-old-record", "prepared-new-record"])(
  "contains exact update candidates after %s before rollback",
  async (phase) => {
    const f = updateFixture();
    if (phase !== "lost-create-reply")
      f.journal.candidates = { gate: f.gate.Id, desktop: f.candidateDesktop.Id };
    if (phase.startsWith("prepared")) f.journal.phase = "prepared";
    if (phase === "prepared-new-record") f.records[0] = preparedRuntimeRecord(f.journal);
    await expect(
      containServiceContainers(f.config, f.client, f.inventory, signal()),
    ).resolves.toEqual({ engineId: "engine-one", observedContainers: 3 });
    const killed = vi.mocked(f.client.kill).mock.calls.map(([id]) => id);
    expect(killed[0]).toBe(f.gate.Id);
    expect(killed.slice(1).sort()).toEqual([f.candidateDesktop.Id, "c".repeat(64)].sort());
    expect(f.gate.State.Running).toBe(false);
    expect(f.candidateDesktop.State.Running).toBe(false);
  },
);

it.each(["operation", "image", "environment", "name", "phase", "candidate-id", "source"])(
  "does not adopt an update container with changed %s",
  async (fault) => {
    const f = updateFixture();
    if (fault === "operation") f.gate.Config.Labels["localdot.runtime-update"] = "different";
    if (fault === "image") f.gate.Config.Image = "foreign:latest";
    if (fault === "environment") f.gate.Config.Env.push("LD_KEYD_PORT=1");
    if (fault === "name") f.gate.Name = "/renamed";
    if (fault === "phase") f.journal.phase = "retiring";
    if (fault === "candidate-id") f.journal.candidates.gate = "7".repeat(64);
    if (fault === "source") f.journal.source.tokens.desktopd = "x".repeat(43);
    await expect(
      containServiceContainers(f.config, f.client, f.inventory, signal()),
    ).rejects.toThrow("could not be confirmed");
    expect(vi.mocked(f.client.kill).mock.calls.map(([id]) => id)).not.toContain(f.gate.Id);
    expect(f.containers.get("c".repeat(64))?.State.Running).toBe(false);
  },
);

it("rechecks the complete update configuration immediately before containment", async () => {
  const f = updateFixture(),
    inspect = vi.mocked(f.client.inspect).getMockImplementation();
  let gateReads = 0;
  vi.mocked(f.client.inspect).mockImplementation(async (ref, signal) => {
    if (ref === f.gate.Id && ++gateReads === 2) f.gate.Config.Env.push("LD_KEYD_PORT=1");
    if (!inspect) throw new Error("fixture missing inspect");
    return inspect(ref, signal);
  });
  await expect(
    containServiceContainers(f.config, f.client, f.inventory, signal()),
  ).rejects.toThrow();
  expect(vi.mocked(f.client.kill).mock.calls.map(([id]) => id)).not.toContain(f.gate.Id);
});

it("a changed update journal cannot produce a successful containment receipt", async () => {
  const f = updateFixture(),
    kill = vi.mocked(f.client.kill).getMockImplementation();
  vi.mocked(f.client.kill).mockImplementation(async (id, signal) => {
    if (!kill) throw new Error("fixture missing kill");
    await kill(id, signal);
    f.journal.candidates.gate = f.gate.Id;
  });
  await expect(containServiceContainers(f.config, f.client, f.inventory, signal())).rejects.toThrow(
    "could not be confirmed",
  );
});

it("orphaned journals after reset are accepted only when all their owned objects are absent", async () => {
  const f = updateFixture();
  f.journal.phase = "prepared";
  f.journal.candidates = { gate: f.gate.Id, desktop: f.candidateDesktop.Id };
  f.records.splice(0);
  await expect(
    containServiceContainers(f.config, f.client, f.inventory, signal()),
  ).rejects.toThrow();
  expect(f.gate.State.Running).toBe(false);
  f.containers.delete(f.gate.Id);
  f.containers.delete(f.candidateDesktop.Id);
  await expect(
    containServiceContainers(f.config, f.client, f.inventory, signal()),
  ).resolves.toMatchObject({ observedContainers: 1 });
});

it("reads update journals without creating absent safety directories or changing private contents", async () => {
  const home = await homeFixture();
  expect(await readRuntimeUpdateInventory(home)).toEqual([]);
  expect(await readdir(home)).toEqual([]);
  const f = updateFixture(),
    store = new RuntimeUpdateStore(home);
  store.write({ ...f.journal, phase: "retiring" });
  store.write(f.journal);
  const path = join(home, "safety/computer-updates", `${first}.json`),
    before = await readFile(path);
  expect(await readRuntimeUpdateInventory(home)).toEqual([f.journal]);
  expect(await readFile(path)).toEqual(before);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  const inventory = await readContainerInventory(home);
  expect(inventory.updates).toEqual([f.journal]);
  expect(inventory.digest).not.toBe("absent");
  store.write({ ...f.journal, candidates: { gate: f.gate.Id, desktop: null } });
  expect((await readContainerInventory(home)).digest).not.toBe(inventory.digest);
});

it.each([
  "permissions",
  "symlink",
  "noncanonical",
  "owner",
  "invalid",
  "unexpected-file",
  "oversized",
  "invalid-utf8",
  "hardlink",
  "temp-oversized",
])("refuses %s update inventory without leaking contents", async (fault) => {
  const home = await homeFixture(),
    f = updateFixture(),
    store = new RuntimeUpdateStore(home);
  store.write({ ...f.journal, phase: "retiring" });
  const directory = join(home, "safety/computer-updates"),
    path = join(directory, `${first}.json`);
  if (fault === "permissions") await chmod(path, 0o644);
  if (fault === "symlink") {
    await rm(path);
    await symlink(join(home, "missing"), path);
  }
  if (fault === "noncanonical")
    await writeFile(path, JSON.stringify({ ...f.journal, phase: "retiring" }));
  if (fault === "owner")
    await writeFile(
      path,
      `${JSON.stringify({ ...f.journal, phase: "retiring", source: { ...sampleRecord(second), ownership: f.desktop.ownership } })}\n`,
    );
  if (fault === "invalid") await writeFile(path, "private-token-that-must-not-escape");
  if (fault === "unexpected-file")
    await writeFile(join(directory, "unknown"), "private", { mode: 0o600 });
  if (fault === "oversized") await writeFile(path, "x".repeat(8193));
  if (fault === "invalid-utf8") await writeFile(path, Buffer.from([0xff]));
  if (fault === "hardlink") await link(path, join(home, "extra-link"));
  if (fault === "temp-oversized")
    await writeFile(join(directory, `.record-${second}.tmp`), "x".repeat(8193), { mode: 0o600 });
  await expect(readRuntimeUpdateInventory(home)).rejects.toThrow(
    /^Computer update recovery inventory is unavailable\.$/,
  );
  expect((await readContainerInventory(home)).invalid).toBe(true);
});

it("ignores only a bounded private temporary journal left before atomic publication", async () => {
  const home = await homeFixture(),
    f = updateFixture(),
    store = new RuntimeUpdateStore(home);
  store.write({ ...f.journal, phase: "retiring" });
  await writeFile(join(home, "safety/computer-updates", `.record-${second}.tmp`), "partial write", {
    mode: 0o600,
  });
  expect(await readRuntimeUpdateInventory(home)).toEqual([{ ...f.journal, phase: "retiring" }]);
});
