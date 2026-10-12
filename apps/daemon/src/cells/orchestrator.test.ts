import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator, UnknownCellError } from "./orchestrator.ts";
import type { GateRelay } from "./relay.ts";
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

// Root reads a mode-000 file anyway, so an unreadable cell.json can't be staged as root.
const isRoot = process.getuid?.() === 0;

// Collects what would otherwise reach Node's unhandledRejection handler and end the daemon.
async function withRejectionsCaught(run: (rejections: unknown[]) => Promise<void>) {
  const rejections: unknown[] = [];
  const record = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", record);
  try {
    await run(rejections);
  } finally {
    process.off("unhandledRejection", record);
  }
}

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

// Counts reads of cell.json, to show which calls stay off the disk.
class CountingStore extends CellStore {
  reads = 0;
  override get(id: string) {
    this.reads += 1;
    return super.get(id);
  }
}

async function setup(
  opts: {
    desktopd?: (store: CellStore) => () => DesktopdHealth | undefined;
    probeDesktopd?: () => Promise<DesktopdHealth | undefined>;
    stream?: () => boolean;
    readyTimeoutMs?: number;
    restartBackoffMs?: number[];
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    makeStore?: (home: string) => CellStore;
    externalKeydPorts?: () => Iterable<number>;
    labels?: Record<string, string>;
    relay?: () => Promise<GateRelay>;
  } = {},
) {
  fake = await startFakeDocker();
  const home = mkdtempSync(join(tmpdir(), "local dot's orch-"));
  homes.push(home);
  const store = (opts.makeStore ?? ((dir) => new CellStore(dir)))(home);
  const changes: CellSummary[] = [];
  const probe = (opts.desktopd ?? runningDesktop)(store);
  const orchestrator = new CellOrchestrator({
    docker: new DockerClient(fake.socketPath),
    store,
    images,
    probeDesktopd: opts.probeDesktopd ?? (async () => probe()),
    probeStream: async () => (opts.stream ?? (() => true))(),
    sleep: opts.sleep ?? (async () => {}),
    ...(opts.now ? { now: opts.now } : {}),
    readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
    ...(opts.labels ? { labels: opts.labels } : {}),
    watchEveryMs: 0,
    restartBackoffMs: opts.restartBackoffMs ?? [0, 0],
    ...(opts.externalKeydPorts ? { externalKeydPorts: opts.externalKeydPorts } : {}),
    ...(opts.relay ? { relay: opts.relay } : {}),
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

  it("links each started desktop to its gate with a one-shot helper and leaves none behind", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    if (record?.kind !== "desktop" || !record.tokens.capture) throw new Error("no capture token");
    const gate = fake.state.containers.get(record.docker.gate)?.body as
      | { User?: string; Env?: string[] }
      | undefined;
    expect(gate?.User).toBe("root");
    expect(gate?.Env).toContain(`LD_CAPTURE_TOKEN=${record.tokens.capture}`);
    const link = `localdot-link-${cell.id}`;
    const create = fake.state.calls.find(
      (c) => c.path === "/containers/create" && c.query.get("name") === link,
    );
    expect(create?.body).toMatchObject({
      Entrypoint: ["/link.sh"],
      HostConfig: { NetworkMode: `container:${record.docker.desktop}`, CapAdd: ["NET_ADMIN"] },
    });
    const order = fake.state.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`POST /containers/${record.docker.desktop}/start`)).toBeLessThan(
      order.indexOf(`POST /containers/id-${link}/start`),
    );
    expect(order).toContain(`POST /containers/id-${link}/wait`);
    expect(fake.state.containers.has(link)).toBe(false);
    await orchestrator.stop(cell.id);
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    expect(
      fake.state.calls.filter(
        (c) => c.method === "POST" && c.path === `/containers/id-${link}/wait`,
      ),
    ).toHaveLength(2);
  });

  it("clears a link helper an interrupted start left behind only when it is this cell's own", async () => {
    const { orchestrator, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.stop(cell.id);
    const name = `localdot-link-${cell.id}`;
    const leftover = (labels: Record<string, string>) =>
      fake.state.containers.set(name, {
        name,
        body: { Image: "localdot/gate:dev", Labels: labels, HostConfig: {} },
        running: false,
        paused: false,
        files: new Map(),
        exitCode: 0,
        starts: 0,
        ports: {},
        networks: {},
      });
    leftover({ "localdot.cell": cell.id, "localdot.role": "link" });
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    expect(fake.state.containers.has(name)).toBe(false);
    await orchestrator.stop(cell.id);
    leftover({ "localdot.cell": "someone-else", "localdot.role": "link" });
    await orchestrator.start(cell.id).catch(() => {});
    await stateOf(cell.id, "failed");
    expect(fake.state.containers.get(name)?.body.Labels?.["localdot.cell"]).toBe("someone-else");
    expect(
      fake.state.calls.some((c) => c.method === "DELETE" && c.path === `/containers/${name}`),
    ).toBe(false);
  });

  it("fails the start when the desktop's link cannot be set up", async () => {
    const { orchestrator, stateOf } = await setup();
    fake.state.failRequests.add("POST /containers/id-localdot-link-");
    const cell = await orchestrator.create({ scale: 2 }).catch(() => undefined);
    const id = cell?.id ?? orchestrator.list()[0]?.id;
    if (id) await stateOf(id, "failed");
    expect(orchestrator.list().every((c) => c.state !== "ready")).toBe(true);
  });

  // An older gate image has no capture label and no link.sh for the helper to run.
  const olderGate = () => {
    fake.state.imageLabels.clear();
    fake.state.failRequests.add("POST /containers/id-localdot-link-");
  };
  const settled = (orchestrator: CellOrchestrator, id: string) =>
    waitUntil(() => ["ready", "failed"].includes(orchestrator.get(id)?.state ?? ""));

  it("makes a computer without capture from a gate image that can't capture", async () => {
    const { orchestrator, store } = await setup();
    olderGate();
    const cell = await orchestrator.create({ scale: 2 });
    await settled(orchestrator, cell.id);
    expect(orchestrator.get(cell.id)?.state).toBe("ready");
    const record = store.get(cell.id);
    if (record?.kind !== "desktop") throw new Error("no desktop record");
    expect(record.tokens).not.toHaveProperty("capture");
    const gate = fake.state.containers.get(record.docker.gate)?.body as
      | { User?: string; Env?: string[] }
      | undefined;
    expect(gate?.User).toBe("nobody");
    expect(gate?.Env?.some((entry) => entry.startsWith("LD_CAPTURE_TOKEN="))).toBe(false);
    expect(fake.state.containers.get(record.docker.desktop)?.body.HostConfig).not.toHaveProperty(
      "Dns",
    );
    expect(
      fake.state.calls.some((c) => c.query.get("name")?.startsWith("localdot-link-") ?? false),
    ).toBe(false);
  });

  it("starts a computer without its link once the gate image can't capture", async () => {
    const { orchestrator, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.stop(cell.id);
    olderGate();
    await orchestrator.start(cell.id);
    await settled(orchestrator, cell.id);
    expect(orchestrator.get(cell.id)?.state).toBe("ready");
    expect(callsTo(`POST /containers/id-localdot-link-${cell.id}/wait`)).toBe(1);
  });

  it("labels every Docker object it creates with the labels it was given", async () => {
    const { orchestrator, stateOf } = await setup({ labels: { "dev.localdot.test": "unit" } });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const created = fake.state.calls.filter(
      (c) => c.method === "POST" && c.path.endsWith("/create"),
    );
    expect(created.length).toBe(6);
    for (const call of created)
      expect((call.body as { Labels?: Record<string, string> }).Labels).toMatchObject({
        "dev.localdot.test": "unit",
        "localdot.cell": cell.id,
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

  it("gives the gate keyd's socket on Docker Engine", async () => {
    const relay = { kind: "socket", keydDir: "/h/keyd/relay", toolDir: "/h/relay" } as const;
    const { orchestrator, store } = await setup({ relay: async () => relay });
    const cell = await orchestrator.create({ scale: 2 });
    const record = store.get(cell.id);
    const gate = fake.state.calls.find(
      (c) => c.path === "/containers/create" && c.query.get("name") === record?.docker.gate,
    )?.body as { Env: string[]; HostConfig: { Mounts?: unknown } };
    expect(gate.Env).toContain(`LD_KEYD_SOCKET=/run/localdot/keyd/${record?.keydPort}.sock`);
    expect(gate.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: "/h/keyd/relay", Target: "/run/localdot/keyd", ReadOnly: true },
    ]);
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
    const before = fake.state.calls.length;
    await orchestrator.remove(cell.id);
    const deletes = fake.state.calls
      .slice(before)
      .filter((c) => c.method === "DELETE" && c.path.startsWith("/containers/"));
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
    store.save(edited);
    edited.docker.gate = `../networks/${victimNetwork}`;
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

describe("CellOrchestrator operations", () => {
  // Each readiness probe takes this long on the daemon's clock.
  const BOOT_MS = 9_000;
  const timed = () => {
    const clock = { now: 1_000_000 };
    return {
      clock,
      now: () => clock.now,
      desktopd: (store: CellStore) => () => {
        clock.now += BOOT_MS;
        return runningDesktop(store)();
      },
    };
  };
  const steps = (changes: CellSummary[], id: string) =>
    changes.filter((c) => c.id === id).map((c) => [c.state, c.operation?.step]);

  it("reports a first start from when the daemon began it, step by step, until the screen is up", async () => {
    const { clock, now, desktopd } = timed();
    const { orchestrator, changes, stateOf } = await setup({ now, desktopd });
    const cell = await orchestrator.create({ scale: 2 });
    expect(cell.operation).toMatchObject({
      kind: "first-start",
      startedAt: 1_000_000,
      expectedMs: 60_000,
    });
    await stateOf(cell.id, "ready");
    expect(steps(changes, cell.id)).toEqual([
      ["starting", "network"],
      ["starting", "desktop"],
      ["starting", "ready"],
      ["ready", "screen"],
    ]);
    expect(new Set(changes.map((c) => c.operation?.startedAt))).toEqual(new Set([1_000_000]));
    clock.now += 500;
    expect(orchestrator.get(cell.id)?.operation).toMatchObject({
      step: "screen",
      elapsedMs: BOOT_MS + 500,
    });
    orchestrator.updateStream(cell.id, { connection: "live", viewers: 1 });
    expect(orchestrator.get(cell.id)).not.toHaveProperty("operation");
    orchestrator.updateStream(cell.id, { connection: "stalled" });
    expect(orchestrator.get(cell.id)).not.toHaveProperty("operation");
  });

  it("keeps how long each kind took with the computer, as the next one's expected time", async () => {
    const { clock, now, desktopd } = timed();
    const { orchestrator, home, changes, stateOf } = await setup({ now, desktopd });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const from = changes.length;
    await orchestrator.stop(cell.id);
    expect(changes.slice(from)[0]?.operation).toMatchObject({
      kind: "stop",
      step: "shutdown",
      expectedMs: 5_000,
    });
    expect(orchestrator.get(cell.id)).not.toHaveProperty("operation");
    clock.now += 60_000;
    const startedAt = clock.now;
    await orchestrator.start(cell.id);
    await waitUntil(() => orchestrator.get(cell.id)?.state === "ready");
    expect(changes.slice(from).find((c) => c.operation?.kind === "start")?.operation).toMatchObject(
      { startedAt, expectedMs: 20_000 },
    );
    expect(new CellStore(home).timings(cell.id)).toEqual({
      "first-start": BOOT_MS,
      start: BOOT_MS,
      stop: expect.any(Number),
    });

    // The next daemon on the same home expects what this computer took last time.
    orchestrator.dispose();
    const next = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store: new CellStore(home),
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
      now,
      watchEveryMs: 0,
    });
    made.push(next);
    const seen: CellSummary[] = [];
    next.subscribe((c) => seen.push(c));
    await next.stop(cell.id);
    await next.start(cell.id);
    expect(seen.find((c) => c.operation?.kind === "start")?.operation?.expectedMs).toBe(BOOT_MS);
  });

  it("names a crash restart, expecting a start plus its wait, and keeps no time for it", async () => {
    const { now, desktopd } = timed();
    const { orchestrator, store, home, changes, stateOf } = await setup({
      now,
      desktopd,
      restartBackoffMs: [4_000, 8_000],
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const desktop = fake.state.containers.get(store.get(cell.id)?.docker.desktop ?? "");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await waitUntil(() => changes.some((c) => c.operation?.kind === "restart"));
    expect(changes.find((c) => c.operation?.kind === "restart")?.operation).toMatchObject({
      expectedMs: 20_000 + 4_000,
    });
    await waitUntil(() => desktop?.starts === 2 && orchestrator.get(cell.id)?.state === "ready");
    expect(new CellStore(home).timings(cell.id)).toEqual({ "first-start": BOOT_MS });
  });
});

describe("CellOrchestrator restarts", () => {
  it.each(["desktop", "stream"])(
    "recycles a running container after its %s service shuts down",
    async (service) => {
      let broken = false;
      let desktopName = "";
      const recovered = () => !broken || (fake.state.containers.get(desktopName)?.starts ?? 0) > 1;
      const { orchestrator, store, stateOf, changes } = await setup({
        probeDesktopd: async () => (service === "desktop" && !recovered() ? undefined : healthy),
        stream: () => service !== "stream" || recovered(),
      });
      const cell = await orchestrator.create({ scale: 2 });
      await stateOf(cell.id, "ready");
      const record = store.get(cell.id);
      if (!record) throw new Error("missing cell");
      desktopName = record.docker.desktop;
      const desktop = fake.state.containers.get(desktopName);
      if (!desktop) throw new Error("missing desktop");
      broken = true;
      expect(desktop.running).toBe(true);
      await waitUntil(() => desktop.starts === 2 && orchestrator.get(cell.id)?.state === "ready");
      expect(desktop.starts).toBe(2);
      expect(fake.state.containers.get(record.docker.gate)?.starts).toBe(2);
      expect(callsTo(`POST /containers/${desktopName}/stop`)).toBe(1);
      expect(changes.some((c) => c.error?.includes("3 consecutive checks"))).toBe(true);
      expect(store.get(cell.id)?.docker.homeVolume).toBe(record.docker.homeVolume);
    },
  );

  it("resets the health failure count after a successful probe", async () => {
    let checks = 0;
    let watching = false;
    const { orchestrator, store, stateOf } = await setup({
      probeDesktopd: async () => {
        if (!watching) return healthy;
        checks += 1;
        return checks % 3 === 0 ? healthy : undefined;
      },
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    watching = true;
    await waitUntil(() => checks >= 9);
    expect(checks).toBeGreaterThanOrEqual(9);
    expect(orchestrator.get(cell.id)?.state).toBe("ready");
    expect(fake.state.containers.get(store.get(cell.id)?.docker.desktop ?? "")?.starts).toBe(1);
  });

  it.each(["stop", "pause"] as const)(
    "a pending unhealthy probe cannot undo user %s",
    async (action) => {
      const answer = Promise.withResolvers<DesktopdHealth | undefined>();
      let watching = false;
      let entered = false;
      const { orchestrator, store, stateOf } = await setup({
        probeDesktopd: async () => {
          if (!watching) return healthy;
          entered = true;
          return answer.promise;
        },
      });
      const cell = await orchestrator.create({ scale: 2 });
      await stateOf(cell.id, "ready");
      watching = true;
      await waitUntil(() => entered);
      expect(entered).toBe(true);
      await orchestrator[action](cell.id);
      answer.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const desktop = fake.state.containers.get(store.get(cell.id)?.docker.desktop ?? "");
      if (!desktop) throw new Error("missing desktop");
      expect(desktop.starts).toBe(1);
      if (action === "stop") expect(orchestrator.get(cell.id)?.state).toBe("stopped");
      else expect(desktop.paused).toBe(true);
    },
  );

  it("allows a user start to recycle unhealthy services after the recovery budget is exhausted", async () => {
    let broken = false;
    let desktopName = "";
    const { orchestrator, store, stateOf } = await setup({
      restartBackoffMs: [],
      probeDesktopd: async () =>
        broken && (fake.state.containers.get(desktopName)?.starts ?? 0) < 2 ? undefined : healthy,
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    desktopName = store.get(cell.id)?.docker.desktop ?? "";
    broken = true;
    await waitUntil(() => orchestrator.get(cell.id)?.state === "failed");
    expect(orchestrator.get(cell.id)?.error).toContain("gave up after 0 restarts");
    await orchestrator.start(cell.id);
    await waitUntil(() => orchestrator.get(cell.id)?.state === "ready");
    expect(orchestrator.get(cell.id)?.state).toBe("ready");
    expect(fake.state.containers.get(desktopName)?.starts).toBe(2);
  });

  it("a user start() during a restart's backoff leaves exactly one watch loop", async () => {
    const held: (() => void)[] = [];
    const { orchestrator, store, stateOf } = await setup({
      restartBackoffMs: [7000, 7000],
      sleep: (ms) => (ms === 7000 ? new Promise<void>((r) => held.push(r)) : Promise.resolve()),
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
    const until = (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (pred() ? resolve() : setTimeout(check, 5));
        check();
      });
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await until(() =>
      (orchestrator.get(cell.id)?.error ?? "").includes("restarting (attempt 1 of 2)"),
    );
    await until(() => held.length === 1);
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    expect(desktop?.starts).toBe(2);
    held[0]?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(desktop?.starts).toBe(2);
    expect(orchestrator.get(cell.id)?.state).toBe("ready");
    if (desktop) {
      desktop.running = false;
      desktop.exitCode = 137;
    }
    await until(() => held.length === 2);
    held[1]?.();
    await until(() => desktop?.starts === 3 && orchestrator.get(cell.id)?.state === "ready");
    await new Promise((r) => setTimeout(r, 30));
    expect(desktop?.starts).toBe(3);
  });
  it.each([0, 137])(
    "restarts a desktop exiting with %s and keeps the gate's published ports",
    async (exitCode) => {
      const { orchestrator, store, stateOf, changes } = await setup();
      const cell = await orchestrator.create({ scale: 2 });
      await stateOf(cell.id, "ready");
      const before = orchestrator.endpoints(cell.id);
      const record = store.get(cell.id);
      const desktop = fake.state.containers.get(record?.docker.desktop ?? "");
      if (desktop) {
        desktop.running = false;
        desktop.exitCode = exitCode;
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
    },
  );

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
      "starting",
      "stopping",
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

describe("CellOrchestrator background failures", () => {
  it.skipIf(isRoot)(
    "keeps watching through an unreadable cell.json, with no unhandled rejection",
    async () => {
      await withRejectionsCaught(async (rejections) => {
        // A probe that reads no records, so only the orchestrator could touch the file.
        const { orchestrator, store, home, stateOf } = await setup({
          probeDesktopd: async () => healthy,
        });
        const cell = await orchestrator.create({ scale: 2 });
        await stateOf(cell.id, "ready");
        const desktop = fake.state.containers.get(store.get(cell.id)?.docker.desktop ?? "");
        const file = join(home, "cells", cell.id, "cell.json");
        const error = quiet();
        try {
          chmodSync(file, 0o000);
          if (desktop) {
            desktop.running = false;
            desktop.exitCode = 137;
          }
          await waitUntil(() => desktop?.starts === 2 && desktop.running);
          await new Promise((r) => setTimeout(r, 50));
          expect(rejections).toEqual([]);
          expect(desktop?.starts).toBe(2);
          // The record held in memory carries the cell through; nothing reads the file again.
          expect(error.mock.calls.filter((call) => String(call[0]).includes(cell.id))).toEqual([]);
        } finally {
          chmodSync(file, 0o600);
          error.mockRestore();
        }
      });
    },
  );

  it("fails a cell whose background check throws, with one line and no unhandled rejection", async () => {
    await withRejectionsCaught(async (rejections) => {
      const error = quiet();
      try {
        const { orchestrator } = await setup({
          probeDesktopd: async () => {
            throw Object.assign(new Error("probe exploded at /Users/x/cell.json"), {
              code: "EPROBE",
            });
          },
        });
        const cell = await orchestrator.create({ scale: 2 });
        await waitUntil(() => error.mock.calls.length > 0, 500);
        await new Promise((r) => setTimeout(r, 50));
        expect(rejections).toEqual([]);
        expect(error.mock.calls).toEqual([[`cell ${cell.id}: background check stopped (EPROBE)`]]);
        expect(orchestrator.get(cell.id)).toMatchObject({
          state: "failed",
          error: "background check stopped (EPROBE)",
        });
      } finally {
        error.mockRestore();
      }
    });
  });

  it("catches a listener's rejection and logs only the cell id and the error code", async () => {
    await withRejectionsCaught(async (rejections) => {
      const error = quiet();
      try {
        const { orchestrator, stateOf } = await setup();
        orchestrator.subscribe(async () => {
          throw Object.assign(new Error("listener saw /Users/x/secret"), { code: "ELISTEN" });
        });
        orchestrator.subscribe(() => {
          throw new Error("listener saw /Users/x/secret");
        });
        const cell = await orchestrator.create({ scale: 2 });
        await stateOf(cell.id, "ready");
        await new Promise((r) => setTimeout(r, 20));
        expect(rejections).toEqual([]);
        expect(new Set(error.mock.calls.map((call) => call.join(" ")))).toEqual(
          new Set([
            `cell ${cell.id}: a state listener failed (ELISTEN)`,
            `cell ${cell.id}: a state listener failed (no error code)`,
          ]),
        );
      } finally {
        error.mockRestore();
      }
    });
  });

  it("fails a cell whose stop Docker refuses, instead of leaving it stopping", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    fake.state.failRequests.add(`POST /containers/${store.get(cell.id)?.docker.desktop}/stop`);
    await expect(orchestrator.stop(cell.id)).rejects.toThrow("refusing");
    expect(orchestrator.get(cell.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("stop failed"),
    });
  });

  it("fails a ready cell whose container was removed outside localDot", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    fake.state.containers.delete(store.get(cell.id)?.docker.desktop ?? "");
    await waitUntil(() => orchestrator.get(cell.id)?.state === "failed", 1000);
    expect(orchestrator.get(cell.id)).toMatchObject({
      state: "failed",
      error: "desktop container is missing: removed outside localDot",
    });
  });

  it("keeps watching a ready cell through a passing inspect error", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const desktop = store.get(cell.id)?.docker.desktop ?? "";
    const inspect = `GET /containers/${desktop}/json`;
    fake.state.failRequests.add(inspect);
    const inspects = callsTo(inspect);
    await waitUntil(() => callsTo(inspect) > inspects + 5);
    fake.state.failRequests.delete(inspect);
    await new Promise((r) => setTimeout(r, 20));
    expect(orchestrator.get(cell.id)?.state).toBe("ready");
    expect(fake.state.containers.get(desktop)?.starts).toBe(1);
  });

  it("names the gate at once when it exits while the cell starts", async () => {
    const { orchestrator, store } = await setup({ desktopd: () => () => undefined });
    const cell = await orchestrator.create({ scale: 2 });
    const gate = fake.state.containers.get(store.get(cell.id)?.docker.gate ?? "");
    if (gate) {
      gate.running = false;
      gate.exitCode = 1;
    }
    await waitUntil(() => orchestrator.get(cell.id)?.state === "failed", 1000);
    expect(orchestrator.get(cell.id)).toMatchObject({
      state: "failed",
      error: "gate container exited with 1",
    });
  });

  it("clamps desktopd's detail when it copies it into the error", async () => {
    const screen = { w: 1, h: 1, junk: "x".repeat(10_000) } as DesktopdHealth["screen"];
    const { orchestrator, stateOf } = await setup({
      desktopd: () => () => ({ ...healthy, ok: false, screen }),
      readyTimeoutMs: 30,
    });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toMatch(/^not ready after 0\.03 s: desktopd not ready: /);
    expect(failed.error?.length).toBeLessThanOrEqual(300);
  });
});

describe("CellOrchestrator records and endpoints", () => {
  it("hands out endpoints only while the cell is ready", async () => {
    const answer = Promise.withResolvers<DesktopdHealth | undefined>();
    const { orchestrator, stateOf } = await setup({ probeDesktopd: () => answer.promise });
    const cell = await orchestrator.create({ scale: 2 });
    expect(orchestrator.get(cell.id)?.state).toBe("starting");
    expect(orchestrator.endpoints(cell.id)).toBeUndefined();
    answer.resolve(healthy);
    await stateOf(cell.id, "ready");
    expect(orchestrator.endpoints(cell.id)).toBeDefined();
    await orchestrator.stop(cell.id);
    expect(orchestrator.endpoints(cell.id)).toBeUndefined();
  });

  it("hands out no endpoints for a cell that failed while it held ports", async () => {
    const { orchestrator, stateOf } = await setup({
      desktopd: () => () => ({ ...healthy, ok: false }),
      readyTimeoutMs: 30,
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "failed");
    expect(orchestrator.endpoints(cell.id)).toBeUndefined();
  });

  it("serves records from memory, so endpoints, reads and stream updates touch no disk", async () => {
    let store: CountingStore | undefined;
    const { orchestrator, stateOf } = await setup({
      makeStore: (home) => {
        store = new CountingStore(home);
        return store;
      },
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const reads = store?.reads ?? 0;
    for (let i = 0; i < 100; i++) {
      orchestrator.endpoints(cell.id);
      orchestrator.get(cell.id);
      orchestrator.updateStream(cell.id, { viewers: i });
    }
    expect((store?.reads ?? 0) - reads).toBe(0);
  });

  it("refuses to create while a cell record can't be read, whose keyd port may be taken", async () => {
    const { orchestrator, store, home } = await setup();
    store.save(sampleRecord());
    const unreadable = ulid();
    mkdirSync(join(home, "cells", unreadable, "cell.json"), { recursive: true });
    const error = quiet();
    try {
      const err = await orchestrator.create({ scale: 2 }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        name: "SkippedCellsError",
        message: expect.stringContaining(unreadable),
      });
      expect(fake.state.calls.filter((c) => c.method === "POST")).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("reconciles every other cell when one record can't be read", async () => {
    const { orchestrator, home, stateOf } = await setup();
    const first = await orchestrator.create({ scale: 2 });
    await stateOf(first.id, "ready");
    const second = await orchestrator.create({ scale: 2 });
    await stateOf(second.id, "ready");
    orchestrator.dispose();
    // The first read lists the record; the next, a moment later, fails.
    let reads = 0;
    const flaky = new (class extends CellStore {
      override getStored(id: string) {
        if (id === first.id && ++reads > 1) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${home}'`), {
            code: "EACCES",
          });
        }
        return super.getStored(id);
      }
    })(home);
    const fresh = new CellOrchestrator({
      docker: new DockerClient(fake.socketPath),
      store: flaky,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
    });
    made.push(fresh);
    const error = quiet();
    try {
      await fresh.reconcile();
      await waitUntil(() => fresh.get(second.id)?.state === "ready", 1000);
      expect(fresh.get(second.id)?.state).toBe("ready");
      expect(error.mock.calls).toContainEqual([`cell ${first.id}: not reconciled (EACCES)`]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("CellOrchestrator undo", () => {
  it.each([
    ["the desktop cannot start", "POST /containers/localdot-desktop-"],
    ["the gate cannot join its internal network", "POST /networks/localdot-cell-"],
  ])("emits removed and undoes everything when %s", async (_what, failing) => {
    const { orchestrator, store, changes } = await setup();
    fake.state.failRequests.add(failing);
    const err = await orchestrator.create({ scale: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const id = changes[0]?.id ?? "";
    expect(changes.every((c) => c.id === id)).toBe(true);
    expect(changes.at(-1)?.state).toBe("removed");
    expect(orchestrator.get(id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect({
      containers: fake.state.containers.size,
      networks: fake.state.networks.size,
      volumes: fake.state.volumes.size,
    }).toEqual({ containers: 0, networks: 0, volumes: 0 });
  });

  it("logs each undo step that fails, naming the object and the status", async () => {
    const { orchestrator, changes } = await setup();
    fake.state.failRequests.add("POST /containers/localdot-desktop-");
    fake.state.failRequests.add("DELETE /networks/");
    const error = quiet();
    try {
      await orchestrator.create({ scale: 2 }).catch(() => {});
      const id = changes[0]?.id ?? "";
      expect(error.mock.calls).toEqual([
        [`cell ${id}: could not undo network localdot-egress-${id} (status 500)`],
        [`cell ${id}: could not undo network localdot-cell-${id} (status 500)`],
      ]);
    } finally {
      error.mockRestore();
    }
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

describe("shared desktop and brain keyd allocation", () => {
  it("skips brain-owned ports and exposes desktop reservations before provisioning yields", async () => {
    let brainPorts: number[] = [];
    const h = await setup({ externalKeydPorts: () => brainPorts });
    brainPorts = [h.store.keydPorts.from];
    const first = h.orchestrator.create({ scale: 1 });
    expect(h.orchestrator.reservedKeydPorts()).toContain(h.store.keydPorts.from + 1);
    const second = h.orchestrator.create({ scale: 1 });
    expect(h.orchestrator.reservedKeydPorts()).toContain(h.store.keydPorts.from + 2);
    const [a, b] = await Promise.all([first, second]);
    expect(h.store.get(a.id)?.keydPort).toBe(h.store.keydPorts.from + 1);
    expect(h.store.get(b.id)?.keydPort).toBe(h.store.keydPorts.from + 2);
  });
  it("refuses desktop allocation while agent cleanup has no trustworthy inventory", async () => {
    const h = await setup({
      externalKeydPorts: () => {
        throw new Error("cleanup pending");
      },
    });
    await expect(h.orchestrator.create({ scale: 1 })).rejects.toThrow("cleanup pending");
    expect(h.store.list()).toEqual([]);
    expect(fake.state.calls).toEqual([]);
  });
});
