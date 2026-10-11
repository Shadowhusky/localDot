import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELFTEST_CHECKS, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUpdateRefused,
  ComputerUpdateStore,
  ComputerUpdates,
  UPDATE_LABEL,
  updateComputer,
} from "./computer-update.ts";
import { DockerClient } from "./docker.ts";
import { retireExactContainers } from "./exact-retirement.ts";
import {
  CellControlConflict,
  CellOrchestrator,
  type OrchestratorDeps,
  UPDATE_NEEDS_FRESH_START,
  UPDATE_RECORDS_UNREADABLE,
  UPDATE_UNFINISHED,
} from "./orchestrator.ts";
import { desktopSpec, gateSpec } from "./spec.ts";
import { CellStore } from "./store.ts";
import { type FakeDocker, startFakeDocker } from "./testing/fake-docker.ts";
import type { CellRecord, CellSummary, DesktopdHealth } from "./types.ts";

const images = { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" };
const OLD = `sha256:${"a".repeat(64)}`;
const NEW_DESKTOP = `sha256:${"b".repeat(64)}`;
const NEW_GATE = `sha256:${"c".repeat(64)}`;
const healthy: DesktopdHealth = {
  ok: true,
  scale: 2,
  display: ":1",
  screen: { w: 2560, h: 1600 },
  hidpi: {
    ok: true,
    expected: { windowScalingFactor: 2, xftDpi: 96 },
    windowScalingFactor: 2,
    xftDpi: 96,
  },
  selftest: {
    ok: true,
    ms: 16,
    checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "fine" })),
  },
};
const keyd = () => ({
  wire: async () => {},
  isWired: async () => true,
  refresh: async () => [],
  revoke: async () => 0,
  close: vi.fn(async (_id: string) => {}),
});

let fake: FakeDocker;
const made: CellOrchestrator[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const o of made.splice(0)) o.dispose();
  await fake?.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const waitUntil = (pred: () => boolean, ms = 2000) =>
  new Promise<void>((resolve) => {
    const deadline = Date.now() + ms;
    const check = () => (pred() || Date.now() > deadline ? resolve() : setTimeout(check, 5));
    check();
  });

async function setup(deps: Partial<OrchestratorDeps> = {}) {
  fake = await startFakeDocker();
  const home = mkdtempSync(join(tmpdir(), "local dot's update-"));
  homes.push(home);
  const store = new CellStore(home);
  const docker = new DockerClient(fake.socketPath);
  const changes: CellSummary[] = [];
  // A fresh daemon over the same home and Docker: what a restart finds.
  const boot = () => {
    const updates = new ComputerUpdates({
      home,
      docker,
      images,
      stream: { fullcolor: false },
      ...(deps.relay ? { relay: deps.relay } : {}),
    });
    const orchestrator = new CellOrchestrator({
      docker,
      store,
      images,
      updates,
      probeDesktopd: async () =>
        store.list().every((r) => fake.state.containers.get(r.docker.desktop)?.running)
          ? healthy
          : undefined,
      probeStream: async () => true,
      sleep: async () => {},
      readyTimeoutMs: 5000,
      watchEveryMs: 0,
      restartBackoffMs: [0, 0],
      ...deps,
    });
    made.push(orchestrator);
    orchestrator.subscribe((cell) => changes.push(cell));
    return { updates, orchestrator };
  };
  const first = boot();
  const cell = await first.orchestrator.create({ scale: 2 });
  await waitUntil(() => first.orchestrator.get(cell.id)?.state === "ready");
  const record = store.get(cell.id) as CellRecord;
  return { ...first, boot, home, store, docker, changes, id: cell.id, record };
}

const rebuild = () => {
  fake.state.imageIds.set(images.desktop, NEW_DESKTOP);
  fake.state.imageIds.set(images.gate, NEW_GATE);
};
const containerIds = () => [...fake.state.containers.values()].map((c) => c.id);

describe("update detection", () => {
  it("finds an update when a tag names a new image ID, not by comparing tags", async () => {
    const { updates, orchestrator, docker, home, id, record } = await setup();
    expect(await updates.check(record)).toBe(false);
    expect(orchestrator.get(id)).not.toHaveProperty("updateAvailable");

    fake.state.imageIds.set(images.desktop, NEW_DESKTOP);
    expect(await updates.check(record)).toBe(true);
    expect(orchestrator.get(id)?.updateAvailable).toBe(true);
    expect(await updates.check(record)).toBe(false);

    // Another tag for the image the computer already runs is no update.
    const renamed = new ComputerUpdates({
      home,
      docker,
      images: { desktop: "localdot/desktop:renamed", gate: images.gate },
      stream: { fullcolor: false },
    });
    fake.state.imageIds.set("localdot/desktop:renamed", OLD);
    expect(await renamed.check(record)).toBe(false);
    expect(renamed.available(id)).toBe(false);
  });

  it("reports nothing when the new image is gone", async () => {
    const { updates, id, record } = await setup();
    fake.state.imageIds.set(images.desktop, NEW_DESKTOP);
    fake.state.images.delete(images.desktop);
    await updates.check(record);
    expect(updates.available(id)).toBe(false);
  });
});

describe("CellOrchestrator.update", () => {
  it("leaves installed system changes running instead of discarding them in an update", async () => {
    const { orchestrator, record, id } = await setup();
    rebuild();
    const desktop = fake.state.containers.get(record.docker.desktop);
    if (!desktop) throw new Error("missing test desktop");
    desktop.changes = [
      { Path: "/opt/example-app/bin", Kind: 1 },
      { Path: "/var/lib/dpkg/status", Kind: 0 },
    ];
    const before = fake.state.calls.length;
    await expect(orchestrator.update(id)).rejects.toThrow("would discard");
    expect(desktop.running).toBe(true);
    expect(
      fake.state.calls
        .slice(before)
        .some((call) => call.method === "DELETE" || call.path.endsWith("/stop")),
    ).toBe(false);
  });

  it("moves the computer onto the new images with the same home, and retires the old containers", async () => {
    const { updates, orchestrator, store, changes, id, record } = await setup();
    rebuild();
    await updates.check(record);
    await orchestrator.update(id);
    await waitUntil(() => orchestrator.get(id)?.state === "ready");

    const next = store.get(id) as CellRecord;
    expect(next.ownership?.desktop).not.toBe(record.ownership?.desktop);
    expect(next.ownership?.gate).not.toBe(record.ownership?.gate);
    expect({ ...next, ownership: undefined }).toEqual({ ...record, ownership: undefined });
    expect(next.ownership?.internalNetwork).toBe(record.ownership?.internalNetwork);
    expect(next.ownership?.egressNetwork).toBe(record.ownership?.egressNetwork);

    const desktop = fake.state.containers.get(record.docker.desktop);
    const gate = fake.state.containers.get(record.docker.gate);
    expect(desktop?.id).toBe(next.ownership?.desktop);
    expect(gate?.id).toBe(next.ownership?.gate);
    expect(desktop?.image).toBe(NEW_DESKTOP);
    expect(gate?.image).toBe(NEW_GATE);
    expect(desktop?.body.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: record.docker.homeVolume, Target: "/config" },
    ]);
    expect(desktop?.body.Labels?.[UPDATE_LABEL]).toMatch(/^[0-9A-Z]{26}$/);
    expect(fake.state.volumes.has(record.docker.homeVolume)).toBe(true);
    expect(desktop?.running && gate?.running).toBe(true);

    expect(containerIds()).not.toContain(record.ownership?.desktop);
    expect(containerIds()).not.toContain(record.ownership?.gate);
    expect(fake.state.containers.size).toBe(2);

    expect(changes.some((c) => c.id === id && c.updating && c.state === "stopping")).toBe(true);
    expect(orchestrator.get(id)).not.toHaveProperty("updating");
    expect(orchestrator.get(id)).not.toHaveProperty("updateAvailable");
    expect(orchestrator.endpoints(id)?.desktopd.token).toBe(record.tokens.desktopd);
  });

  it("reports the update as one operation from its stop through its start, and keeps its time", async () => {
    const clock = { now: 1_000_000 };
    const { updates, orchestrator, store, changes, id, record } = await setup({
      now: () => clock.now,
      probeDesktopd: async () => {
        clock.now += 6_000;
        return healthy;
      },
    });
    rebuild();
    await updates.check(record);
    const from = changes.length;
    const began = clock.now;
    await orchestrator.update(id);
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    const seen = changes.slice(from).filter((c) => c.id === id);
    expect(new Set(seen.map((c) => c.operation?.kind))).toEqual(new Set(["update"]));
    expect(new Set(seen.map((c) => c.operation?.startedAt))).toEqual(new Set([began]));
    expect([...new Set(seen.map((c) => c.operation?.step))]).toEqual([
      "shutdown",
      "install",
      "network",
      "desktop",
      "ready",
      "screen",
    ]);
    expect(seen[0]?.operation?.expectedMs).toBe(40_000);
    expect(store.timings(id)).toEqual({ "first-start": 6_000, update: 6_000 });
  });

  it("gives a computer made before capture the gate's token, and containers that capture", async () => {
    const wired: CellRecord[] = [];
    const { store, boot, id, record } = await setup({
      keyd: { ...keyd(), wire: async (r) => void wired.push(structuredClone(r)) },
    });
    const { capture: _capture, ...tokens } = record.tokens;
    store.save({ ...record, tokens });
    for (const o of made.splice(0)) o.dispose();
    const { updates, orchestrator } = boot();
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    rebuild();
    await updates.check(store.get(id) as CellRecord);
    await orchestrator.update(id);
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    const capture = store.get(id)?.tokens.capture;
    expect(capture).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.get(id)?.tokens).toMatchObject(tokens);
    const gate = fake.state.containers.get(record.docker.gate)?.body as
      | { Env?: string[]; User?: string }
      | undefined;
    expect(gate?.Env).toContain(`LD_CAPTURE_TOKEN=${capture}`);
    expect(wired.at(-1)?.tokens.capture).toBe(capture);
    expect(gate?.User).toBe("root");
    expect(fake.state.containers.get(record.docker.desktop)?.body.HostConfig.Dns).toEqual([
      record.docker.gateInternalIp,
    ]);
  });

  // A rebuilt gate image from before capture: no capture label and no link.sh for the helper.
  const rebuildOlderGate = () => {
    rebuild();
    fake.state.imageLabels.clear();
    fake.state.failRequests.add("POST /containers/id-localdot-link-");
  };
  const capturing = (store: CellStore, record: CellRecord) => {
    const gate = fake.state.containers.get(record.docker.gate)?.body as
      | { Env?: string[]; User?: string }
      | undefined;
    return {
      token: store.get(record.id)?.tokens.capture,
      user: gate?.User,
      env: gate?.Env?.some((entry) => entry.startsWith("LD_CAPTURE_TOKEN=")),
      dns: fake.state.containers.get(record.docker.desktop)?.body.HostConfig.Dns,
    };
  };
  const NOT_CAPTURING = { token: undefined, user: "nobody", env: false, dns: undefined };

  it("keeps a computer made before capture without it when the new gate image can't capture", async () => {
    const wired: CellRecord[] = [];
    const { store, boot, id, record } = await setup({
      keyd: { ...keyd(), wire: async (r) => void wired.push(structuredClone(r)) },
    });
    const { capture: _capture, ...tokens } = record.tokens;
    store.save({ ...record, tokens });
    for (const o of made.splice(0)) o.dispose();
    const { updates, orchestrator } = boot();
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    rebuildOlderGate();
    await updates.check(store.get(id) as CellRecord);
    await orchestrator.update(id);
    await waitUntil(() => ["ready", "failed"].includes(orchestrator.get(id)?.state ?? ""));
    expect(orchestrator.get(id)?.state).toBe("ready");
    expect(fake.state.containers.get(record.docker.gate)?.image).toBe(NEW_GATE);
    expect(capturing(store, record)).toEqual(NOT_CAPTURING);
    expect(wired.at(-1)?.tokens).not.toHaveProperty("capture");
  });

  it("gives up the gate's token when the computer goes onto a gate image that can't capture", async () => {
    const { updates, orchestrator, store, id, record } = await setup();
    expect(capturing(store, record).token).toBe(record.tokens.capture);
    rebuildOlderGate();
    await updates.check(record);
    await orchestrator.update(id);
    await waitUntil(() => ["ready", "failed"].includes(orchestrator.get(id)?.state ?? ""));
    expect(orchestrator.get(id)?.state).toBe("ready");
    expect(fake.state.containers.get(record.docker.gate)?.image).toBe(NEW_GATE);
    expect(store.get(id)?.tokens).toEqual({
      desktopd: record.tokens.desktopd,
      stream: record.tokens.stream,
    });
    expect(capturing(store, record)).toEqual(NOT_CAPTURING);
  });

  it("gives the new gate keyd's socket on Docker Engine", async () => {
    const relay = { kind: "socket", keydDir: "/h/keyd/relay", toolDir: "/h/relay" } as const;
    const { updates, orchestrator, id, record } = await setup({ relay: async () => relay });
    rebuild();
    await updates.check(record);
    await orchestrator.update(id);
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    const gate = fake.state.containers.get(record.docker.gate);
    expect(gate?.image).toBe(NEW_GATE);
    expect(gate?.body.Labels?.[UPDATE_LABEL]).toBeDefined();
    const env = (gate?.body as { Env?: string[] } | undefined)?.Env ?? [];
    expect(env).toContain(`LD_KEYD_SOCKET=/run/localdot/keyd/${record.keydPort}.sock`);
    expect(env.filter((entry) => entry.startsWith("LD_TOOL_SOCKET="))).toEqual([]);
    expect(gate?.body.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: "/h/keyd/relay", Target: "/run/localdot/keyd", ReadOnly: true },
    ]);
  });

  it("adopts a container whose create reply was lost instead of making a second", async () => {
    const { updates, orchestrator, store, id, record } = await setup();
    rebuild();
    await updates.check(record);
    fake.state.loseReplies.add("POST /containers/create");
    await orchestrator.update(id);
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    expect(store.get(id)?.ownership?.gate).toBe(`id-${record.docker.gate}-update`);
    expect(fake.state.containers.size).toBe(2);
  });

  it("brings the computer back as it was when a new container can't be made", async () => {
    const { updates, orchestrator, store, home, changes, id, record } = await setup();
    rebuild();
    await updates.check(record);
    fake.state.failCreate.add(`${record.docker.desktop}-update`);
    await expect(orchestrator.update(id)).rejects.toThrow("It's back as it was");
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    // Turning the old computer back on is not "Updating" any more.
    expect(changes.filter((c) => c.state === "starting" && c.updating)).toEqual([]);

    expect(store.get(id)).toEqual(record);
    expect(containerIds().sort()).toEqual(
      [record.ownership?.desktop, record.ownership?.gate].sort(),
    );
    expect(fake.state.containers.get(record.docker.desktop)?.running).toBe(true);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
    expect(orchestrator.get(id)?.updateAvailable).toBe(true);
  });

  it("refuses a fenced computer without touching it", async () => {
    let fenced = false;
    const { updates, orchestrator, id, record } = await setup({ permanentFence: () => fenced });
    rebuild();
    await updates.check(record);
    fenced = true;
    const before = fake.state.calls.length;
    await expect(orchestrator.update(id)).rejects.toBeInstanceOf(CellControlConflict);
    expect(
      fake.state.calls
        .slice(before)
        .filter((c) => c.method !== "GET")
        .map((c) => c.path),
    ).toEqual([]);
  });
});

describe("an update interrupted by a daemon restart", () => {
  it("rolls back an update that was still making its containers", async () => {
    const { orchestrator, boot, home, store, docker, id, record } = await setup();
    rebuild();
    await orchestrator.stop(id);
    // The first daemon made the gate and, with its reply lost, the desktop, then stopped.
    const operationId = ulid();
    const ledger = new ComputerUpdateStore(home);
    const entry = {
      v: 1 as const,
      operationId,
      cellId: id,
      previous: {
        gate: record.ownership?.gate as string,
        desktop: record.ownership?.desktop as string,
      },
      images: { gate: NEW_GATE, desktop: NEW_DESKTOP },
      candidates: { gate: null, desktop: null },
      phase: "creating" as const,
    };
    ledger.write(entry);
    for (const [role, spec] of [
      ["gate", gateSpec(record, images.gate)],
      ["desktop", desktopSpec(record, images.desktop, { fullcolor: false })],
    ] as const)
      await docker.request({
        method: "POST",
        path: "/containers/create",
        query: { name: `${record.docker[role]}-update` },
        body: { ...spec, Labels: { ...spec.Labels, [UPDATE_LABEL]: operationId } },
      });
    ledger.write({
      ...entry,
      candidates: { gate: `id-${record.docker.gate}-update`, desktop: null },
    });
    orchestrator.dispose();

    const restarted = boot();
    await restarted.orchestrator.reconcile();
    expect(restarted.orchestrator.get(id)?.state).toBe("stopped");
    expect(store.get(id)).toEqual(record);
    expect(containerIds().sort()).toEqual(
      [record.ownership?.desktop, record.ownership?.gate].sort(),
    );
    expect(fake.state.volumes.has(record.docker.homeVolume)).toBe(true);
    expect(ledger.read(id)).toBeUndefined();
    expect(restarted.updates.pending(id)).toBe(false);
    await restarted.updates.check(record);
    expect(restarted.orchestrator.get(id)?.updateAvailable).toBe(true);
  });

  it("finishes an update whose old containers were already retired", async () => {
    const { updates, orchestrator, boot, home, store, id, record } = await setup();
    rebuild();
    await updates.check(record);
    fake.state.failRequests.add(`POST /containers/id-${record.docker.desktop}-update/rename`);
    await expect(orchestrator.update(id)).rejects.toThrow(UPDATE_UNFINISHED);
    expect(orchestrator.get(id)).toMatchObject({ state: "failed", error: UPDATE_UNFINISHED });
    expect(orchestrator.get(id)?.updateAvailable).toBe(true);
    // Docker refuses the rename again when recovery tries it.
    await expect(orchestrator.start(id)).rejects.toThrow(UPDATE_NEEDS_FRESH_START);
    expect(orchestrator.get(id)).toMatchObject({
      state: "failed",
      error: UPDATE_NEEDS_FRESH_START,
      needsFreshStart: true,
    });
    expect(orchestrator.get(id)).not.toHaveProperty("updateAvailable");
    expect(new ComputerUpdateStore(home).read(id)?.phase).toBe("renaming");
    orchestrator.dispose();

    fake.state.failRequests.clear();
    const restarted = boot();
    await restarted.orchestrator.reconcile();
    const next = store.get(id) as CellRecord;
    expect(next.ownership?.desktop).toBe(`id-${record.docker.desktop}-update`);
    expect(fake.state.containers.get(record.docker.desktop)?.id).toBe(next.ownership?.desktop);
    expect(fake.state.containers.get(record.docker.gate)?.id).toBe(next.ownership?.gate);
    expect(fake.state.containers.size).toBe(2);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
    expect(restarted.orchestrator.get(id)?.state).toBe("stopped");
    expect(restarted.orchestrator.get(id)).not.toHaveProperty("needsFreshStart");

    await restarted.orchestrator.start(id);
    await waitUntil(() => restarted.orchestrator.get(id)?.state === "ready");
    expect(fake.state.containers.get(record.docker.desktop)?.image).toBe(NEW_DESKTOP);
    expect(restarted.orchestrator.get(id)).not.toHaveProperty("updateAvailable");
  });
});

const interrupt = (request: string) => fake.state.failRequests.add(request);
const renameOf = (record: CellRecord, role: "gate" | "desktop") =>
  `POST /containers/id-${record.docker[role]}-update/rename`;
const mountsHome = (record: CellRecord) =>
  [...fake.state.containers.values()].filter((c) =>
    ((c.body.HostConfig.Mounts as { Source?: string }[] | undefined) ?? []).some(
      (m) => m.Source === record.docker.homeVolume,
    ),
  );

describe("refusals before and during the swap", () => {
  it("says the new version isn't here before anything stops", async () => {
    const { updates, orchestrator, id, record } = await setup();
    rebuild();
    await updates.check(record);
    fake.state.images.delete(images.desktop);
    const before = fake.state.calls.length;
    await expect(orchestrator.update(id)).rejects.toThrow("The new version isn't on this Mac yet.");
    expect(fake.state.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    expect(orchestrator.get(id)?.state).toBe("ready");
    expect(orchestrator.get(id)).not.toHaveProperty("updating");
  });

  it("passes the key layer's silence on once the computer is back", async () => {
    const wiring = keyd();
    const { updates, orchestrator, id, record } = await setup({ keyd: wiring });
    rebuild();
    await updates.check(record);
    wiring.close.mockRejectedValueOnce(new Error("timed out"));
    await expect(orchestrator.update(id)).rejects.toThrow("The key layer didn't answer.");
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    expect(orchestrator.get(id)?.state).toBe("ready");
    expect(fake.state.containers.get(record.docker.desktop)?.id).toBe(record.ownership?.desktop);
  });

  it("never swaps a computer that is still on", async () => {
    const { updates, store, home, id } = await setup();
    rebuild();
    await expect(updates.swap(store.get(id) as CellRecord, () => {})).rejects.toThrow(
      "has to be off",
    );
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
    expect(fake.state.containers.size).toBe(2);
  });

  it("rolls back a new container that isn't on the new image", async () => {
    const { updates, orchestrator, store, home, id, record } = await setup();
    // The tag names the new build, yet what Docker made from it is still the old image.
    fake.state.imageInspect = (reference, reply) => ({
      ...reply,
      Id: reference === images.desktop ? NEW_DESKTOP : NEW_GATE,
    });
    await updates.check(record);
    await expect(orchestrator.update(id)).rejects.toThrow("It's back as it was");
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    expect(store.get(id)).toEqual(record);
    expect(containerIds().sort()).toEqual(
      [record.ownership?.desktop, record.ownership?.gate].sort(),
    );
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
  });

  it("leaves a container it didn't make under the temporary name alone", async () => {
    const { updates, orchestrator, docker, home, id, record } = await setup();
    const foreign = `${record.docker.desktop}-update`;
    await docker.request({
      method: "POST",
      path: "/containers/create",
      query: { name: foreign },
      body: {
        Image: images.desktop,
        Labels: { "localdot.cell": id, "localdot.role": "desktop" },
        HostConfig: {},
      },
    });
    rebuild();
    await updates.check(record);
    await expect(orchestrator.update(id)).rejects.toThrow("It's back as it was");
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    expect(fake.state.containers.get(foreign)?.id).toBe(`id-${foreign}`);
    expect(fake.state.containers.has(`${record.docker.gate}-update`)).toBe(false);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
  });

  it("ends as stopped, not updating, when the computer is fenced as the new version starts", async () => {
    let fenced = false;
    const { updates, orchestrator, id, record } = await setup({ permanentFence: () => fenced });
    rebuild();
    await updates.check(record);
    let release = () => {};
    const rename = renameOf(record, "desktop");
    fake.state.holds.set(
      rename,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const done = orchestrator.update(id).catch((error: unknown) => error);
    await waitUntil(() => fake.state.calls.some((c) => `${c.method} ${c.path}` === rename));
    fenced = true;
    release();
    expect(await done).toBeInstanceOf(CellControlConflict);
    expect(orchestrator.get(id)?.state).toBe("stopped");
    expect(orchestrator.get(id)).not.toHaveProperty("updating");
  });

  it("offers no update while the computer is held", async () => {
    let fenced = false;
    const { updates, orchestrator, id, record } = await setup({ permanentFence: () => fenced });
    rebuild();
    await updates.check(record);
    expect(orchestrator.get(id)?.updateAvailable).toBe(true);
    fenced = true;
    expect(orchestrator.get(id)).not.toHaveProperty("updateAvailable");
  });
});

describe("an update that can't be finished", () => {
  it("is over when its new containers are gone, and the old computer starts", async () => {
    const { updates, orchestrator, home, id, record } = await setup();
    rebuild();
    await updates.check(record);
    interrupt(`DELETE /containers/${record.ownership?.gate}`);
    await expect(orchestrator.update(id)).rejects.toThrow(UPDATE_UNFINISHED);
    expect(new ComputerUpdateStore(home).read(id)?.phase).toBe("retiring");
    fake.state.failRequests.clear();
    // Pruned by hand while the computer was off.
    for (const role of ["gate", "desktop"] as const)
      fake.state.containers.delete(`${record.docker[role]}-update`);

    await orchestrator.start(id);
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    expect(orchestrator.get(id)?.state).toBe("ready");
    expect(fake.state.containers.get(record.docker.desktop)?.id).toBe(record.ownership?.desktop);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
    expect(updates.pending(id)).toBe(false);
  });

  it("refuses to finish over a computer that changed, and Remove still clears all of it", async () => {
    const { updates, orchestrator, boot, store, home, id, record } = await setup();
    rebuild();
    await updates.check(record);
    interrupt(renameOf(record, "desktop"));
    await expect(orchestrator.update(id)).rejects.toThrow(UPDATE_UNFINISHED);
    fake.state.failRequests.clear();
    orchestrator.dispose();
    store.save({
      ...record,
      ownership: {
        ...(record.ownership as NonNullable<CellRecord["ownership"]>),
        desktop: "f".repeat(64),
      },
    });

    const restarted = boot();
    await expect(restarted.orchestrator.start(id)).rejects.toThrow(UPDATE_NEEDS_FRESH_START);
    expect(restarted.orchestrator.get(id)?.needsFreshStart).toBe(true);
    expect(fake.state.containers.has(`${record.docker.desktop}-update`)).toBe(true);

    await restarted.orchestrator.remove(id, { purgeHome: true });
    expect(fake.state.containers.size).toBe(0);
    expect(fake.state.volumes.has(record.docker.homeVolume)).toBe(false);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
    expect(restarted.orchestrator.get(id)).toBeUndefined();
  });

  it("needs a fresh start when one new container is gone after the old ones were retired", async () => {
    const { updates, orchestrator, home, id, record } = await setup({ keyd: keyd() });
    rebuild();
    await updates.check(record);
    interrupt(renameOf(record, "desktop"));
    await expect(orchestrator.update(id)).rejects.toThrow(UPDATE_UNFINISHED);
    expect(orchestrator.get(id)).not.toHaveProperty("needsFreshStart");
    fake.state.failRequests.clear();
    fake.state.containers.delete(`${record.docker.desktop}-update`);

    await expect(orchestrator.start(id)).rejects.toThrow(UPDATE_NEEDS_FRESH_START);
    expect(orchestrator.get(id)).toMatchObject({
      state: "failed",
      error: UPDATE_NEEDS_FRESH_START,
      needsFreshStart: true,
    });
    expect(orchestrator.get(id)).not.toHaveProperty("updateAvailable");
    await expect(orchestrator.update(id)).rejects.toThrow();

    await orchestrator.discardUpdate(id);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
    expect(orchestrator.get(id)).not.toHaveProperty("needsFreshStart");
  });

  it("keeps trying when Docker didn't answer, and finishes once it does", async () => {
    const { updates, orchestrator, home, id, record } = await setup();
    rebuild();
    await updates.check(record);
    interrupt(renameOf(record, "desktop"));
    await expect(orchestrator.update(id)).rejects.toThrow(UPDATE_UNFINISHED);
    fake.state.failRequests.clear();
    fake.state.loseReplies.add(renameOf(record, "desktop"));

    await expect(orchestrator.start(id)).rejects.toThrow(UPDATE_UNFINISHED);
    expect(orchestrator.get(id)).not.toHaveProperty("needsFreshStart");

    await orchestrator.start(id);
    await waitUntil(() => orchestrator.get(id)?.state === "ready");
    expect(fake.state.containers.get(record.docker.desktop)?.image).toBe(NEW_DESKTOP);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
  });

  it("lets Remove through while Docker keeps refusing the last step", async () => {
    const { updates, orchestrator, home, id, record } = await setup();
    rebuild();
    await updates.check(record);
    interrupt(renameOf(record, "desktop"));
    await expect(orchestrator.update(id)).rejects.toThrow(UPDATE_UNFINISHED);
    await orchestrator.remove(id);
    expect(fake.state.containers.size).toBe(0);
    expect(fake.state.volumes.has(record.docker.homeVolume)).toBe(true);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
  });

  it("is cleared before the computer is replaced or reset", async () => {
    const { updates, orchestrator, home, id, record } = await setup({ keyd: keyd() });
    rebuild();
    await updates.check(record);
    interrupt(renameOf(record, "desktop"));
    await expect(orchestrator.update(id)).rejects.toThrow(UPDATE_UNFINISHED);
    expect(mountsHome(record).map((c) => c.name)).toEqual([`${record.docker.desktop}-update`]);

    await orchestrator.discardUpdate(id);
    expect(mountsHome(record)).toEqual([]);
    expect(new ComputerUpdateStore(home).read(id)).toBeUndefined();
    expect(await orchestrator.retireReplacement(id, true)).toEqual({ absent: true, revoked: true });
  });

  it("is cleared when a replacement retires the computer", async () => {
    const { updates, orchestrator, id, record } = await setup({ keyd: keyd() });
    rebuild();
    await updates.check(record);
    interrupt(renameOf(record, "desktop"));
    await expect(orchestrator.update(id)).rejects.toThrow(UPDATE_UNFINISHED);
    expect(await orchestrator.retireReplacement(id, true)).toEqual({ absent: true, revoked: true });
    expect(fake.state.containers.size).toBe(0);
  });
});

describe("unreadable update records", () => {
  it("say so instead of offering an update, and keep Remove working", async () => {
    const { orchestrator, boot, home, id, record } = await setup();
    orchestrator.dispose();
    chmodSync(join(home, "safety", "computer-image-updates"), 0o755);
    const restarted = boot();
    rebuild();
    await restarted.updates.check(record);
    expect(restarted.updates.available(id)).toBe(false);
    await restarted.orchestrator.reconcile();
    expect(restarted.orchestrator.get(id)).toMatchObject({
      state: "failed",
      error: UPDATE_RECORDS_UNREADABLE,
    });
    expect(restarted.orchestrator.get(id)).not.toHaveProperty("updateAvailable");
    await expect(restarted.orchestrator.start(id)).rejects.toThrow(UPDATE_RECORDS_UNREADABLE);
    await restarted.orchestrator.remove(id, { purgeHome: true });
    expect(fake.state.containers.size).toBe(0);
  });
});

describe("ComputerUpdateStore", () => {
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), "local dot's update store-"));
    homes.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const CELL = ulid();
  const start = () => ({
    v: 1 as const,
    operationId: ulid(),
    cellId: CELL,
    previous: { gate: "old-gate", desktop: "old-desktop" },
    images: { gate: NEW_GATE, desktop: NEW_DESKTOP },
    candidates: { gate: null, desktop: null },
    phase: "creating" as const,
  });
  const both = { gate: "new-gate", desktop: "new-desktop" };

  it("starts an update only from nothing, with no new containers yet", () => {
    const store = new ComputerUpdateStore(home());
    expect(() => store.write({ ...start(), phase: "retiring", candidates: both })).toThrow(
      "starts with no new containers",
    );
    expect(() =>
      store.write({ ...start(), candidates: { gate: "new-gate", desktop: null } }),
    ).toThrow("starts with no new containers");
    const entry = start();
    store.write(entry);
    expect(() => store.write(start())).toThrow("earlier computer update is unfinished");
    store.remove(CELL);
    expect(store.read(CELL)).toBeUndefined();
    store.write(start());
  });

  it("moves one phase at a time, only forward, with both new containers past creating", () => {
    const store = new ComputerUpdateStore(home());
    const entry = start();
    store.write(entry);
    store.write({ ...entry, candidates: { gate: "new-gate", desktop: null } });
    expect(() =>
      store.write({ ...entry, phase: "retiring", candidates: { gate: "new-gate", desktop: null } }),
    ).toThrow("identity or phase changed");
    expect(() => store.write({ ...entry, phase: "renaming", candidates: both })).toThrow(
      "identity or phase changed",
    );
    store.write({ ...entry, phase: "retiring", candidates: both });
    expect(() => store.write({ ...entry, phase: "creating", candidates: both })).toThrow(
      "identity or phase changed",
    );
    store.write({ ...entry, phase: "renaming", candidates: both });
    expect(store.read(CELL)?.phase).toBe("renaming");
  });

  it("never lets an update change what it replaces, its images or a recorded container", () => {
    const store = new ComputerUpdateStore(home());
    const entry = { ...start(), candidates: { gate: "new-gate", desktop: null } };
    store.write({ ...entry, candidates: { gate: null, desktop: null } });
    store.write(entry);
    for (const changed of [
      { ...entry, previous: { gate: "other", desktop: "old-desktop" } },
      { ...entry, images: { gate: NEW_DESKTOP, desktop: NEW_DESKTOP } },
      { ...entry, candidates: { gate: "other-gate", desktop: null } },
      { ...entry, candidates: { gate: null, desktop: null } },
    ])
      expect(() => store.write(changed)).toThrow("identity or phase changed");
    expect(store.read(CELL)).toEqual(entry);
  });
});

describe("retireExactContainers", () => {
  it("refuses a running, paused or someone else's container and removes nothing", async () => {
    const { orchestrator, docker, id, record } = await setup();
    await orchestrator.stop(id);
    const desktop = fake.state.containers.get(record.docker.desktop);
    const gate = fake.state.containers.get(record.docker.gate);
    if (!desktop || !gate) throw new Error("no computer");
    const pairs = [
      { role: "gate" as const, id: gate.id as string },
      { role: "desktop" as const, id: desktop.id as string },
    ];
    desktop.running = true;
    await expect(retireExactContainers(docker, id, pairs)).rejects.toThrow("cannot be confirmed");
    desktop.paused = true;
    await expect(retireExactContainers(docker, id, pairs)).rejects.toThrow("cannot be confirmed");
    desktop.running = false;
    desktop.paused = false;
    await expect(retireExactContainers(docker, ulid(), pairs)).rejects.toThrow(
      "ownership cannot be confirmed",
    );
    await expect(
      retireExactContainers(docker, id, [{ role: "desktop", id: gate.id as string }]),
    ).rejects.toThrow("ownership cannot be confirmed");
    expect(fake.state.containers.size).toBe(2);
    await retireExactContainers(docker, id, pairs);
    expect(fake.state.containers.size).toBe(0);
  });
});

describe("updateComputer admission", () => {
  const ID = "01JXYZ0000000000000000ABCD";
  const summary = (patch: Partial<CellSummary> = {}): CellSummary => ({
    id: ID,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-09T10:00:00.000Z",
    stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
    updateAvailable: true,
    ...patch,
  });
  const deps = (
    cell: CellSummary,
    session?: { status: string; controlHeld: boolean; hold?: boolean },
    opts: { admitted?: boolean; pending?: boolean } = {},
  ) => {
    const release = vi.fn();
    const order: string[] = [];
    return {
      release,
      order,
      d: {
        cells: {
          get: () => cell,
          update: vi.fn(async () => {
            order.push(release.mock.calls.length ? "released early" : "update");
          }),
        },
        live: {
          get: () => (session ? "01JXYZ0000000000000000SESS" : undefined),
          admitIdleOperation: () => (opts.admitted === false ? undefined : { release }),
          idleOperationPending: () => opts.pending === true,
        },
        runner: {
          holds: () => session?.hold === true,
          get: () => session,
          release: vi.fn(async () => {
            order.push("follow-up ended");
          }) as ((signal?: AbortSignal) => Promise<void>) | undefined,
        },
      },
    };
  };
  const refusal = async (d: ReturnType<typeof deps>["d"]) => {
    const error = await updateComputer(d, ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ComputerUpdateRefused);
    expect(d.cells.update).not.toHaveBeenCalled();
    return (error as Error).message;
  };

  it("refuses while dot works, while the user holds the computer, or when fenced", async () => {
    for (const [cell, session, words] of [
      [summary(), { status: "running", controlHeld: false }, "Wait for dot to finish"],
      [summary(), { status: "waiting_user", controlHeld: false }, "Wait for dot to finish"],
      [summary(), { status: "idle", controlHeld: true }, "Hand back the computer first."],
      [summary(), { status: "idle", controlHeld: false, hold: true }, "Hand back the computer"],
      [summary({ fenced: { revision: 1 } }), undefined, "can't be updated right now"],
      [summary({ updateAvailable: undefined }), undefined, "up to date"],
    ] as const) {
      const { d } = deps(cell, session);
      const refusal = await updateComputer(d, ID).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ComputerUpdateRefused);
      expect((refusal as Error).message).toContain(words);
      expect(d.cells.update).not.toHaveBeenCalled();
    }
  });

  it("answers a second Update while the first one waits its turn", async () => {
    const { d } = deps(summary(), undefined, { pending: true });
    expect(await refusal(d)).toBe("Your computer is already updating.");
  });

  it("refuses when a task slips in between the checks and the update", async () => {
    const { d } = deps(summary(), undefined, { admitted: false });
    expect(await refusal(d)).toBe("Wait for dot to finish, or stop the task first.");
  });

  it("refuses when a finished task's wait can't be ended", async () => {
    const missing = deps(summary(), { status: "idle", controlHeld: false });
    missing.d.runner.release = undefined;
    expect(await refusal(missing.d)).toBe("Wait for dot to finish, or stop the task first.");
    const failing = deps(summary(), { status: "idle", controlHeld: false });
    failing.d.runner.release = vi.fn(async () => {
      throw new Error("task is busy again");
    });
    expect(await refusal(failing.d)).toBe("Wait for dot to finish, or stop the task first.");
    expect(failing.release).not.toHaveBeenCalled();
  });

  it("ends a finished task's wait and holds new tasks off until the update is done", async () => {
    const { d, release, order } = deps(summary(), { status: "idle", controlHeld: false });
    await updateComputer(d, ID);
    expect(order).toEqual(["follow-up ended", "update"]);
    expect(release).toHaveBeenCalledOnce();
  });
});
