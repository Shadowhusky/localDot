import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUpdateRefused,
  ComputerUpdateStore,
  ComputerUpdates,
  UPDATE_LABEL,
  updateComputer,
} from "./computer-update.ts";
import { DockerClient } from "./docker.ts";
import { CellControlConflict, CellOrchestrator, UPDATE_UNFINISHED } from "./orchestrator.ts";
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
};

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

async function setup(deps: { permanentFence?: (id: string) => boolean } = {}) {
  fake = await startFakeDocker();
  const home = mkdtempSync(join(tmpdir(), "local dot's update-"));
  homes.push(home);
  const store = new CellStore(home);
  const docker = new DockerClient(fake.socketPath);
  const changes: CellSummary[] = [];
  // A fresh daemon over the same home and Docker: what a restart finds.
  const boot = () => {
    const updates = new ComputerUpdates({ home, docker, images, stream: { fullcolor: false } });
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
    const { updates, orchestrator, store, home, id, record } = await setup();
    rebuild();
    await updates.check(record);
    fake.state.failCreate.add(`${record.docker.desktop}-update`);
    await expect(orchestrator.update(id)).rejects.toThrow("It's back as it was");
    await waitUntil(() => orchestrator.get(id)?.state === "ready");

    expect(store.get(id)).toEqual(record);
    expect(containerIds().sort()).toEqual(
      [record.ownership?.desktop, record.ownership?.gate].sort(),
    );
    expect(fake.state.containers.get(record.docker.desktop)?.running).toBe(true);
    expect(new ComputerUpdateStore(home).read(id)?.phase).toBe("rolled-back");
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
    expect(ledger.read(id)?.phase).toBe("rolled-back");
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
    await expect(orchestrator.start(id)).rejects.toThrow(UPDATE_UNFINISHED);
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
    expect(new ComputerUpdateStore(home).read(id)?.phase).toBe("done");
    expect(restarted.orchestrator.get(id)?.state).toBe("stopped");

    await restarted.orchestrator.start(id);
    await waitUntil(() => restarted.orchestrator.get(id)?.state === "ready");
    expect(fake.state.containers.get(record.docker.desktop)?.image).toBe(NEW_DESKTOP);
    expect(restarted.orchestrator.get(id)).not.toHaveProperty("updateAvailable");
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
          admitIdleOperation: () => ({ release }),
        },
        runner: {
          holds: () => session?.hold === true,
          get: () => session,
          release: vi.fn(async () => {
            order.push("follow-up ended");
          }),
        },
      },
    };
  };

  it("refuses while dot works, while the user holds the computer, or when fenced", async () => {
    for (const [cell, session, words] of [
      [summary(), { status: "running", controlHeld: false }, "Wait for dot to finish"],
      [summary(), { status: "waiting_user", controlHeld: false }, "Wait for dot to finish"],
      [summary(), { status: "idle", controlHeld: true }, "Hand back the computer first."],
      [summary(), { status: "idle", controlHeld: true, hold: true }, "Hand back the computer"],
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

  it("ends a finished task's wait and holds new tasks off until the update is done", async () => {
    const { d, release, order } = deps(summary(), { status: "idle", controlHeld: false });
    await updateComputer(d, ID);
    expect(order).toEqual(["follow-up ended", "update"]);
    expect(release).toHaveBeenCalledOnce();
  });
});
