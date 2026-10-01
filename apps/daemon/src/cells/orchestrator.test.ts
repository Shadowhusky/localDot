import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator, UnknownCellError } from "./orchestrator.ts";
import { ISOLATED_GATEWAY_OPTION } from "./spec.ts";
import { CellStore } from "./store.ts";
import { type FakeDocker, startFakeDocker } from "./testing/fake-docker.ts";
import { sampleRecord } from "./testing/sample-record.ts";
import type { CellSummary, DesktopdHealth } from "./types.ts";

const images = { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" };
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

// The default probe answers like a real desktop: healthy only while the fake container runs.
const runningDesktop = (store: CellStore) => () => {
  const names = store.list().map((r) => r.docker.desktop);
  return names.every((n) => fake.state.containers.get(n)?.running) ? healthy : undefined;
};

// Gives up after `ms` so a test that never gets there fails on its assertions, not a timeout.
const waitUntil = (pred: () => boolean, ms = 2000) =>
  new Promise<void>((resolve) => {
    const deadline = Date.now() + ms;
    const check = () => (pred() || Date.now() > deadline ? resolve() : setTimeout(check, 5));
    check();
  });

const callsTo = (request: string) =>
  fake.state.calls.filter((c) => `${c.method} ${c.path}` === request).length;

async function setup(
  opts: {
    desktopd?: (store: CellStore) => () => DesktopdHealth | undefined;
    probeDesktopd?: () => Promise<DesktopdHealth | undefined>;
    stream?: () => boolean;
    readyTimeoutMs?: number;
    restartBackoffMs?: number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  fake = await startFakeDocker();
  const home = mkdtempSync(join(tmpdir(), "local dot's orch-"));
  homes.push(home);
  const store = new CellStore(home);
  const changes: CellSummary[] = [];
  const probe = (opts.desktopd ?? runningDesktop)(store);
  const orchestrator = new CellOrchestrator({
    docker: new DockerClient(fake.socketPath),
    store,
    images,
    probeDesktopd: opts.probeDesktopd ?? (async () => probe()),
    probeStream: async () => (opts.stream ?? (() => true))(),
    sleep: opts.sleep ?? (async () => {}),
    readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
    watchEveryMs: 0,
    restartBackoffMs: opts.restartBackoffMs ?? [0, 0],
  });
  made.push(orchestrator);
  orchestrator.subscribe((cell) => changes.push(cell));
  const stateOf = (id: string, state: CellSummary["state"]) =>
    new Promise<CellSummary>((resolve) => {
      const hit = changes.find((c) => c.id === id && c.state === state);
      if (hit) return resolve(hit);
      orchestrator.subscribe((cell) => {
        if (cell.id === id && cell.state === state) resolve(cell);
      });
    });
  return { orchestrator, store, home, changes, stateOf };
}

describe("CellOrchestrator.create", () => {
  it("provisions networks, volume and hardened containers, then reaches ready", async () => {
    const { orchestrator, store, home, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    expect(cell.state).toBe("starting");
    await stateOf(cell.id, "ready");

    const record = store.get(cell.id);
    expect(record).toBeDefined();
    expect(statSync(join(home, "cells", cell.id, "cell.json")).mode & 0o777).toBe(0o600);
    expect(record?.keydPort).toBe(4760);
    expect(record?.docker).toMatchObject({
      gateInternalIp: "172.21.0.10",
      desktopIp: "172.21.0.11",
      gateEgressIp: "172.22.0.10",
    });

    const internal = fake.state.networks.get(record?.docker.internalNetwork ?? "");
    expect(internal).toMatchObject({
      Internal: true,
      Options: { [ISOLATED_GATEWAY_OPTION]: "isolated" },
    });
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(true);

    const gate = fake.state.containers.get(record?.docker.gate ?? "");
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    expect(gate?.body.HostConfig).toMatchObject({ CapDrop: ["ALL"], ReadonlyRootfs: true });
    expect(gate?.networks).toEqual({
      [record?.docker.egressNetwork ?? ""]: { IPAMConfig: { IPv4Address: "172.22.0.10" } },
      [record?.docker.internalNetwork ?? ""]: { IPAMConfig: { IPv4Address: "172.21.0.10" } },
    });
    expect(desktop?.body.HostConfig).toMatchObject({ CapDrop: ["NET_RAW"] });
    expect(desktop?.running).toBe(true);

    const order = fake.state.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`POST /containers/${record?.docker.gate}/start`)).toBeLessThan(
      order.indexOf(`POST /networks/${record?.docker.internalNetwork}/connect`),
    );
    expect(order.indexOf(`POST /networks/${record?.docker.internalNetwork}/connect`)).toBeLessThan(
      order.indexOf(`POST /containers/${record?.docker.desktop}/start`),
    );

    const endpoints = orchestrator.endpoints(cell.id);
    expect(endpoints?.desktopd).toEqual({
      baseUrl: "http://127.0.0.1:50000",
      token: record?.tokens.desktopd,
    });
    expect(endpoints?.stream).toEqual({
      baseUrl: "http://127.0.0.1:50001",
      authorization: `Basic ${Buffer.from(`localdot:${record?.tokens.stream}`).toString("base64")}`,
    });
  });

  it("undoes everything when the desktop container cannot be created", async () => {
    const { orchestrator, store } = await setup();
    fake.state.failCreate.add("localdot-desktop-");
    const err = await orchestrator.create({ scale: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("refusing to create");
    expect(store.list()).toEqual([]);
    expect(fake.state.networks.size).toBe(0);
    expect(fake.state.containers.size).toBe(0);
    expect(fake.state.volumes.size).toBe(0);
  });

  it("gives two concurrent creates different keyd ports", async () => {
    const { orchestrator, store } = await setup();
    const cells = await Promise.all([
      orchestrator.create({ scale: 2 }),
      orchestrator.create({ scale: 2 }),
    ]);
    const ports = cells.map((cell) => store.get(cell.id)?.keydPort);
    expect(new Set(ports)).toEqual(new Set([4760, 4761]));
  });
});

describe("CellOrchestrator lifecycle", () => {
  it("reads new ports after a stop and start and connects the internal network only once", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    await orchestrator.stop(cell.id);
    expect(orchestrator.get(cell.id)?.state).toBe("stopped");
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    const after = orchestrator.endpoints(cell.id);
    expect(after?.desktopd.baseUrl).not.toBe(before?.desktopd.baseUrl);
    const record = store.get(cell.id);
    const connects = fake.state.calls.filter(
      (c) => c.path === `/networks/${record?.docker.internalNetwork}/connect`,
    );
    expect(connects).toHaveLength(1);
  });

  it("fails with the exit code when the desktop container dies while starting", async () => {
    const { orchestrator, store, stateOf } = await setup({ desktopd: () => () => undefined });
    const cell = await orchestrator.create({ scale: 2 });
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toContain("exited with 137");
  });

  it("fails with the last detail when readiness times out", async () => {
    const { orchestrator, stateOf } = await setup({
      desktopd: () => () => ({ ...healthy, ok: false }),
      readyTimeoutMs: 30,
    });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toMatch(/not ready after/);
    expect(failed.error).toContain("desktopd not ready");
  });

  it("keeps waiting while desktopd answers ok:false and is ready only once it answers ok", async () => {
    let probes = 0;
    const { orchestrator, stateOf } = await setup({
      desktopd: () => () => {
        probes += 1;
        return probes < 4 ? { ...healthy, ok: false } : healthy;
      },
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    expect(probes).toBe(4);
  });

  it("removes containers and networks, keeps the home volume unless purged, and emits removed", async () => {
    const { orchestrator, store, stateOf, changes } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    await orchestrator.remove(cell.id);
    expect(fake.state.containers.size).toBe(0);
    expect(fake.state.networks.size).toBe(0);
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(true);
    expect(store.get(cell.id)).toBeUndefined();
    expect(changes.at(-1)).toMatchObject({ id: cell.id, state: "removed" });
    await expect(orchestrator.remove(cell.id)).rejects.toBeInstanceOf(UnknownCellError);
  });

  it("removes each container with its anonymous volumes", async () => {
    const { orchestrator, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.remove(cell.id);
    const deletes = fake.state.calls.filter(
      (c) => c.method === "DELETE" && c.path.startsWith("/containers/"),
    );
    expect(deletes.map((c) => Object.fromEntries(c.query))).toEqual([
      { force: "true", v: "true" },
      { force: "true", v: "true" },
    ]);
  });

  it("purges the home volume on request", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    await orchestrator.remove(cell.id, { purgeHome: true });
    expect(fake.state.volumes.has(record?.docker.homeVolume ?? "")).toBe(false);
  });

  it("percent-encodes the names it reads from a cell record into Docker API paths", async () => {
    const { orchestrator, store, home, stateOf } = await setup();
    const victim = await orchestrator.create({ scale: 2 });
    await stateOf(victim.id, "ready");
    const victimNetwork = store.get(victim.id)?.docker.internalNetwork ?? "";
    const edited = sampleRecord();
    edited.docker.gate = `../networks/${victimNetwork}`;
    store.save(edited);
    // The loader refuses such a name (store.test.ts); this store hands it over regardless, so the
    // encoding is tested on its own.
    const unchecked = new (class extends CellStore {
      override get(id: string) {
        return id === edited.id ? edited : super.get(id);
      }
    })(home);
    const other = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store: unchecked,
      images,
      probeDesktopd: async () => undefined,
      probeStream: async () => false,
    });
    made.push(other);

    await other.remove(edited.id);

    expect(fake.state.networks.has(victimNetwork)).toBe(true);
    const encoded = `/containers/${encodeURIComponent(edited.docker.gate)}`;
    expect(fake.state.calls.some((c) => c.method === "DELETE" && c.path === encoded)).toBe(true);
  });
});

describe("CellOrchestrator restarts", () => {
  it("restarts an exited desktop with backoff and keeps the gate's published ports", async () => {
    const { orchestrator, store, stateOf, changes } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () =>
        changes.some(
          (c) =>
            c.id === cell.id &&
            c.state === "starting" &&
            (c.error ?? "").includes("restarting (attempt 1 of 2)"),
        )
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    await new Promise<void>((resolve) => {
      const check = () =>
        desktop?.starts === 2 && orchestrator.get(cell.id)?.state === "ready"
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    expect(orchestrator.endpoints(cell.id)).toEqual(before);
    expect(orchestrator.get(cell.id)?.error).toBeUndefined();
  });

  it("restarts an exited gate with backoff and reads its new published ports", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const before = orchestrator.endpoints(cell.id);
    const record = store.get(cell.id);
    const gate = fake.state.containers.get(record?.docker.gate ?? "");
    if (gate) {
      gate.running = false;
      gate.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () =>
        gate?.starts === 2 && orchestrator.get(cell.id)?.state === "ready"
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    const after = orchestrator.endpoints(cell.id);
    expect(after?.desktopd.baseUrl).not.toBe(before?.desktopd.baseUrl);
    expect(after?.stream.baseUrl).not.toBe(before?.stream.baseUrl);
    expect(orchestrator.get(cell.id)?.error).toBeUndefined();
  });

  it("gives up once the backoff list is exhausted, even across recoveries", async () => {
    const { orchestrator, store, stateOf } = await setup({ restartBackoffMs: [0] });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    const kill = () => {
      if (desktop) {
        desktop.running = false;
        desktop.exitCode = 137;
      }
    };
    const until = (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (pred() ? resolve() : setTimeout(check, 5));
        check();
      });
    kill();
    await until(() => desktop?.starts === 2 && orchestrator.get(cell.id)?.state === "ready");
    kill();
    await until(() => orchestrator.get(cell.id)?.state === "failed");
    expect(orchestrator.get(cell.id)?.error).toBe(
      "desktop container exited with 137; gave up after 1 restarts",
    );
    expect(desktop?.starts).toBe(2);
  });

  it("keeps a cell stopped when the stop lands during the restart backoff", async () => {
    const backoff = Promise.withResolvers<void>();
    const { orchestrator, store, stateOf, changes } = await setup({
      restartBackoffMs: [60_000],
      sleep: (ms) => (ms === 60_000 ? backoff.promise : Promise.resolve()),
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await new Promise<void>((resolve) => {
      const check = () =>
        changes.some(
          (c) =>
            c.id === cell.id &&
            c.state === "starting" &&
            (c.error ?? "").includes("restarting (attempt 1 of 1)"),
        )
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    await orchestrator.stop(cell.id);
    backoff.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(orchestrator.get(cell.id)?.state).toBe("stopped");
    expect(changes.at(-1)).toMatchObject({ id: cell.id, state: "stopped" });
    expect(desktop?.starts).toBe(1);
  });
});

describe("CellOrchestrator operation queue", () => {
  it("runs a Start that lands during a Stop after it, ending ready with no failure between", async () => {
    const { orchestrator, store, stateOf, changes } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const gate = fake.state.containers.get(record?.docker.gate ?? "");
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    const from = changes.length;

    await Promise.all([orchestrator.stop(cell.id), orchestrator.start(cell.id)]);
    await waitUntil(() => orchestrator.get(cell.id)?.state === "ready");

    expect(changes.slice(from).map((c) => c.state)).toEqual([
      "stopping",
      "stopped",
      "starting",
      "starting",
      "ready",
    ]);
    expect({ gate: gate?.starts, desktop: desktop?.starts }).toEqual({ gate: 2, desktop: 2 });
    expect({ gate: gate?.running, desktop: desktop?.running }).toEqual({
      gate: true,
      desktop: true,
    });
  });

  it("runs a Stop that lands during a restart after it, leaving both containers stopped", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const gate = fake.state.containers.get(record?.docker.gate ?? "");
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    const startDesktop = `POST /containers/${record?.docker.desktop}/start`;
    const held = Promise.withResolvers<void>();
    fake.state.holds.set(startDesktop, held.promise);
    const starts = callsTo(startDesktop);
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await waitUntil(() => callsTo(startDesktop) > starts);

    const stopping = orchestrator.stop(cell.id);
    await new Promise((r) => setTimeout(r, 20));
    held.resolve();
    await stopping;

    expect(orchestrator.get(cell.id)?.state).toBe("stopped");
    expect({ gate: gate?.running, desktop: desktop?.running }).toEqual({
      gate: false,
      desktop: false,
    });
  });

  it("runs a Stop that lands during reconcile after it, with no failure between", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    orchestrator.dispose();
    const record = store.get(cell.id);
    const inspectGate = `GET /containers/${record?.docker.gate}/json`;
    const held = Promise.withResolvers<void>();
    fake.state.holds.set(inspectGate, held.promise);
    const fresh = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
    });
    made.push(fresh);
    const seen: CellSummary[] = [];
    fresh.subscribe((c) => seen.push(c));
    const inspects = callsTo(inspectGate);

    const reconciling = fresh.reconcile();
    await waitUntil(() => callsTo(inspectGate) > inspects);
    const stopping = fresh.stop(cell.id);
    await new Promise((r) => setTimeout(r, 20));
    held.resolve();
    await Promise.all([reconciling, stopping]);

    expect(fresh.get(cell.id)?.state).toBe("stopped");
    expect(seen.map((c) => c.state)).not.toContain("failed");
  });

  it("runs a Stop that lands while a new cell starts after it, leaving both containers stopped", async () => {
    const { orchestrator, store } = await setup();
    const held = Promise.withResolvers<void>();
    let startGate = "";
    // The new cell's id is known only once create() saves it and reports it starting.
    orchestrator.subscribe((c) => {
      if (startGate || c.state !== "starting") return;
      startGate = `POST /containers/${store.get(c.id)?.docker.gate}/start`;
      fake.state.holds.set(startGate, held.promise);
    });
    const creating = orchestrator.create({ scale: 2 });
    await waitUntil(() => startGate !== "" && callsTo(startGate) === 1);
    const id = store.list()[0]?.id ?? "";

    const stopping = orchestrator.stop(id);
    await new Promise((r) => setTimeout(r, 20));
    held.resolve();
    await Promise.all([creating, stopping]);

    const record = store.get(id);
    expect(orchestrator.get(id)?.state).toBe("stopped");
    expect({
      gate: fake.state.containers.get(record?.docker.gate ?? "")?.running,
      desktop: fake.state.containers.get(record?.docker.desktop ?? "")?.running,
    }).toEqual({ gate: false, desktop: false });
  });

  it("drops a restart that queued behind a remove", async () => {
    const { orchestrator, store, stateOf, changes } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    const deleteDesktop = `DELETE /containers/${record?.docker.desktop}`;
    const startGate = `POST /containers/${record?.docker.gate}/start`;
    const held = Promise.withResolvers<void>();
    fake.state.holds.set(deleteDesktop, held.promise);

    const removing = orchestrator.remove(cell.id);
    await waitUntil(() => callsTo(deleteDesktop) === 1);
    const gateStarts = callsTo(startGate);
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await waitUntil(() => changes.some((c) => (c.error ?? "").includes("restarting")));
    await new Promise((r) => setTimeout(r, 20));
    held.resolve();
    await removing;
    await new Promise((r) => setTimeout(r, 50));

    expect(callsTo(startGate)).toBe(gateStarts);
    expect(orchestrator.get(cell.id)).toBeUndefined();
  });

  it("keeps cells apart: one cell's slow stop holds up no other cell", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const slow = await orchestrator.create({ scale: 2 });
    const quick = await orchestrator.create({ scale: 2 });
    await stateOf(slow.id, "ready");
    await stateOf(quick.id, "ready");
    const stopSlow = `POST /containers/${store.get(slow.id)?.docker.desktop}/stop`;
    const held = Promise.withResolvers<void>();
    fake.state.holds.set(stopSlow, held.promise);

    const stoppingSlow = orchestrator.stop(slow.id);
    await waitUntil(() => callsTo(stopSlow) === 1);
    const quickStopped = await Promise.race([
      orchestrator.stop(quick.id).then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 1000)),
    ]);
    expect(quickStopped).toBe(true);
    expect(orchestrator.get(slow.id)?.state).toBe("stopping");
    held.resolve();
    await stoppingSlow;
    expect(orchestrator.get(slow.id)?.state).toBe("stopped");
  });
});

describe("CellOrchestrator background loops", () => {
  it("lets a remove that lands while readiness awaits its probe win", async () => {
    const answer = Promise.withResolvers<DesktopdHealth | undefined>();
    let probes = 0;
    let streamProbes = 0;
    const { orchestrator, changes } = await setup({
      probeDesktopd: () => {
        probes += 1;
        return answer.promise;
      },
      stream: () => {
        streamProbes += 1;
        return true;
      },
    });
    const cell = await orchestrator.create({ scale: 2 });
    await waitUntil(() => probes === 1);
    await orchestrator.remove(cell.id);
    const calls = fake.state.calls.length;
    answer.resolve(healthy);
    await new Promise((r) => setTimeout(r, 50));
    expect(changes.filter((c) => c.id === cell.id).map((c) => c.state)).toEqual([
      "starting",
      "starting",
      "removed",
    ]);
    expect(orchestrator.get(cell.id)).toBeUndefined();
    expect({ probes, streamProbes }).toEqual({ probes: 1, streamProbes: 0 });
    expect(fake.state.calls.length).toBe(calls);
  });

  it("ends the readiness loop on dispose without touching the cell", async () => {
    let answer: DesktopdHealth | undefined;
    let probes = 0;
    const { orchestrator, changes } = await setup({
      desktopd: () => () => {
        probes += 1;
        return answer;
      },
    });
    await orchestrator.create({ scale: 2 });
    await waitUntil(() => probes >= 2);
    orchestrator.dispose();
    const seen = { changes: changes.length, probes };
    answer = healthy;
    await new Promise((r) => setTimeout(r, 50));
    expect({ changes: changes.length, probes }).toEqual(seen);
  });
});

describe("CellOrchestrator.reconcile", () => {
  it("marks a cell whose desktop died while its gate runs as failed with the exit code", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    orchestrator.dispose();
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 139;
    }
    const fresh = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
    });
    made.push(fresh);
    await fresh.reconcile();
    expect(fresh.get(cell.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("desktop container exited with 139"),
    });
  });

  it("recovers running, stopped and vanished cells from their records", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const running = await orchestrator.create({ scale: 2 });
    await stateOf(running.id, "ready");
    const stopped = await orchestrator.create({ scale: 2 });
    await stateOf(stopped.id, "ready");
    await orchestrator.stop(stopped.id);
    const vanished = sampleRecord();
    store.save(vanished);

    const fresh = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
    });
    made.push(fresh);
    const seen: CellSummary[] = [];
    fresh.subscribe((c) => seen.push(c));
    await fresh.reconcile();
    await new Promise<void>((resolve) => {
      const check = () =>
        seen.some((c) => c.id === running.id && c.state === "ready")
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    expect(fresh.get(stopped.id)?.state).toBe("stopped");
    expect(fresh.get(vanished.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("removed outside localDot"),
    });
    expect(fresh.list()).toHaveLength(3);
  });
});
