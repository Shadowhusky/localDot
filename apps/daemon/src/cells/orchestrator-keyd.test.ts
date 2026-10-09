import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELFTEST_CHECKS, type SelfTestReport } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CELL_FILES_DIR, CellKeydWiring, refreshRunningCells } from "../keyd/cell-wiring.ts";
import { KeydClient, KeydError } from "../keyd/client.ts";
import { FAKE_CA_PEM, type FakeKeyd, startFakeKeyd } from "../keyd/testing/fake-keyd.ts";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { CellStore } from "./store.ts";
import { type FakeDocker, startFakeDocker } from "./testing/fake-docker.ts";
import type { CellSummary, DesktopdHealth } from "./types.ts";

const images = { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" };
const passing: SelfTestReport = {
  ok: true,
  ms: 16,
  checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "fine" })),
};
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
  selftest: passing,
};

let docker: FakeDocker;
let keyd: FakeKeyd;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(
  opts: {
    probe?: () => DesktopdHealth | undefined | Promise<DesktopdHealth | undefined>;
    readyTimeoutMs?: number;
    gatewayOnInternal?: boolean;
  } = {},
) {
  docker = await startFakeDocker({ gatewayOnInternal: opts.gatewayOnInternal ?? false });
  keyd = await startFakeKeyd();
  const home = mkdtempSync(join(tmpdir(), "local dot's orch-keyd-"));
  const store = new CellStore(home, { from: 4791, to: 4797 });
  const client = new DockerClient(docker.socketPath);
  const keydClient = new KeydClient(keyd.socketPath, 1000);
  const orchestrator = new CellOrchestrator({
    docker: client,
    store,
    images,
    probeDesktopd: async () => (opts.probe ?? (() => healthy))(),
    probeStream: async () => true,
    sleep: async () => {},
    readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
    watchEveryMs: 0,
    restartBackoffMs: [0, 0],
    keyd: new CellKeydWiring({ keyd: keydClient, docker: client }),
  });
  cleanup.push(
    () => docker.close(),
    () => keyd.close(),
    () => rmSync(home, { recursive: true, force: true }),
    () => orchestrator.dispose(),
  );
  const changes: CellSummary[] = [];
  orchestrator.subscribe((c) => changes.push(c));
  const until = (pred: () => boolean) =>
    vi.waitFor(() => expect(pred()).toBe(true), { timeout: 1500, interval: 5 });
  const stateOf = async (id: string, state: CellSummary["state"]) => {
    await until(() => changes.some((c) => c.id === id && c.state === state));
    return changes.filter((c) => c.id === id && c.state === state).at(-1) as CellSummary;
  };
  return { orchestrator, store, changes, until, stateOf, home, client, keydClient };
}

const record = { kind: "http" as const, createdAt: "t", updatedAt: "t" };

describe("CellOrchestrator with keyd", () => {
  it("retains a failed create's record and port if keyd cleanup cannot be confirmed", async () => {
    const { orchestrator, store, keydClient, client } = await setup();
    const close = keydClient.closeCell.bind(keydClient);
    let uploaded = false;
    const spy = vi.spyOn(keydClient, "closeCell").mockImplementation(async (id) => {
      if (uploaded) throw new KeydError(500, "internal", "closure failed", "/v1/cells");
      return close(id);
    });
    const archive = vi.spyOn(client, "putArchive").mockImplementation(async () => {
      uploaded = true;
      throw new Error("archive failed");
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(orchestrator.create({ scale: 2 })).rejects.toThrow("archive failed");
      const record = store.list()[0];
      expect(record).toBeDefined();
      if (!record) return;
      expect(keyd.cells.has(record.id)).toBe(true);
      expect(orchestrator.get(record.id)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("keyd cleanup could not be confirmed"),
      });
      spy.mockRestore();
      archive.mockRestore();
      await orchestrator.remove(record.id);
      expect(keyd.cells.size).toBe(0);
      expect(store.list()).toEqual([]);
    } finally {
      spy.mockRestore();
      archive.mockRestore();
      quiet.mockRestore();
    }
  });

  it("stops processes but retains the record when keyd refuses a close, then allows retry", async () => {
    const { orchestrator, store, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      keyd.failures.set(`DELETE /v1/cells/${cell.id}`, { status: 500, code: "internal" });
      await expect(orchestrator.stop(cell.id)).rejects.toThrow(
        "keyd closure could not be confirmed",
      );
      const record = store.get(cell.id);
      expect(record).toBeDefined();
      expect(docker.state.containers.get(record?.docker.desktop ?? "")?.running).toBe(false);
      keyd.failures.set(`DELETE /v1/cells/${cell.id}`, { status: 500, code: "internal" });
      await expect(orchestrator.remove(cell.id)).rejects.toThrow(
        "keyd closure could not be confirmed",
      );
      expect(store.get(cell.id)).toBeDefined();
      await orchestrator.remove(cell.id);
      expect(store.get(cell.id)).toBeUndefined();
      expect(keyd.cells.has(cell.id)).toBe(false);
    } finally {
      quiet.mockRestore();
    }
  });

  it("closes keyd material when the desktop start fails after wiring", async () => {
    const { orchestrator, store, client, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.stop(cell.id);
    const record = store.get(cell.id);
    if (!record) throw new Error("record missing");
    docker.state.failRequests.add(`POST /containers/${record.docker.desktop}/start`);
    await expect(orchestrator.start(cell.id)).rejects.toThrow();
    expect(keyd.cells.has(cell.id)).toBe(false);
    expect(docker.state.containers.get(record.docker.gate)?.running).toBe(false);
    // A failed archive upload during a fresh create also removes its newly opened listener.
    vi.spyOn(client, "putArchive").mockRejectedValueOnce(new Error("archive failed"));
    await expect(orchestrator.create({ scale: 2 })).rejects.toThrow("archive failed");
    expect(keyd.cells.size).toBe(0);
  });

  it("serializes isolation cleanup with a newer start", async () => {
    const answer = Promise.withResolvers<DesktopdHealth>();
    let first = true;
    const { orchestrator, store, until, keydClient } = await setup({
      probe: () => (first ? answer.promise : healthy),
    });
    const cell = await orchestrator.create({ scale: 2 });
    const record = store.get(cell.id);
    if (!record) throw new Error("record missing");
    const held = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const close = keydClient.closeCell.bind(keydClient);
    const spy = vi.spyOn(keydClient, "closeCell").mockImplementationOnce(async (id) => {
      closing.resolve();
      await held.promise;
      return close(id);
    });
    let started: Promise<void> | undefined;
    try {
      answer.resolve({
        ...healthy,
        ok: false,
        selftest: {
          ...passing,
          checks: passing.checks.map((c) => (c.id === "dns" ? { ...c, ok: false } : c)),
        },
      });
      await closing.promise;
      first = false;
      let finished = false;
      started = orchestrator.start(cell.id).then(() => {
        finished = true;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(finished).toBe(false);
    } finally {
      held.resolve();
      await started;
      spy.mockRestore();
    }
    await until(() => orchestrator.get(cell.id)?.state === "ready");
    expect(keyd.cells.has(cell.id)).toBe(true);
    expect(docker.state.containers.get(record.docker.desktop)?.running).toBe(true);
  });

  it("does not claim an isolation failure stopped a desktop when Docker refuses the stop", async () => {
    const { orchestrator, stateOf, store } = await setup({
      probe: () => {
        const desktop = [...docker.state.containers.values()].find(
          (c) => c.body.Image === images.desktop,
        );
        docker.state.failRequests.add(`POST /containers/${desktop?.name}/stop`);
        return {
          ...healthy,
          ok: false,
          selftest: {
            ...passing,
            checks: passing.checks.map((c) => (c.id === "dns" ? { ...c, ok: false } : c)),
          },
        };
      },
    });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toContain("could not confirm the computer stopped");
    expect(docker.state.containers.get(store.get(cell.id)?.docker.desktop ?? "")?.running).toBe(
      true,
    );
    expect(keyd.cells.has(cell.id)).toBe(false);
  });

  it("checks every IPAM entry for an internal gateway", async () => {
    const { orchestrator } = await setup();
    docker.state.networkInspect = (reply) => ({
      ...reply,
      IPAM: {
        Config: [
          ...(reply.IPAM as { Config: unknown[] }).Config,
          { Subnet: "fd00::/64", Gateway: "fd00::1" },
        ],
      },
    });
    await expect(orchestrator.create({ scale: 2 })).rejects.toThrow("has a gateway address");
    expect(docker.state.networks.size).toBe(0);
  });

  it("keeps a skipped live record stopped when reconcile runs in the same daemon", async () => {
    const { orchestrator, store, stateOf, home } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const record = store.get(cell.id);
    if (!record) throw new Error("record missing");
    writeFileSync(join(home, "cells", cell.id, "cell.json"), "bad record");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await orchestrator.reconcile();
      await new Promise((r) => setTimeout(r, 30));
      expect(docker.state.containers.get(record.docker.desktop)?.running).toBe(false);
      expect(keyd.cells.has(cell.id)).toBe(false);
      expect(orchestrator.get(cell.id)?.state).toBe("failed");
      await expect(orchestrator.start(cell.id)).rejects.toThrow("fix the cell record");
      writeFileSync(join(home, "cells", cell.id, "cell.json"), JSON.stringify(record));
      await orchestrator.start(cell.id);
      expect(keyd.cells.has(cell.id)).toBe(true);
    } finally {
      quiet.mockRestore();
    }
  });

  it("opens the cell in keyd and writes its files before the desktop starts", async () => {
    const { orchestrator, store, stateOf } = await setup();
    keyd.records.set("weather", { id: "weather", ...record, hosts: ["api.weather.example"] });
    keyd.records.set("anthropic", {
      id: "anthropic",
      kind: "llm",
      provider: "anthropic",
      createdAt: "t",
      updatedAt: "t",
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const r = store.get(cell.id);
    if (!r) throw new Error("no record");
    expect(r.keydPort).toBe(4791);
    expect(keyd.calls.find((c) => c.method === "POST" && c.path === "/v1/cells")?.body).toEqual({
      cellId: cell.id,
      role: "desktop",
      port: 4791,
      secrets: ["weather"],
      captureToken: r.tokens.capture,
    });
    const files = docker.state.containers.get(r.docker.desktop)?.files;
    expect(files?.get(`${CELL_FILES_DIR}/ca.pem`)?.toString()).toBe(FAKE_CA_PEM);
    expect(files?.get(`${CELL_FILES_DIR}/proxy-token`)?.toString()).toMatch(
      /^[A-Za-z0-9_-]{43}\n$/,
    );
    const surrogate = keyd.cells.get(cell.id)?.surrogates.weather;
    expect(files?.get(`${CELL_FILES_DIR}/surrogates.sh`)?.toString()).toContain(
      `export LOCALDOT_KEY_WEATHER='${surrogate}'`,
    );
    const order = docker.state.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`PUT /containers/${r.docker.desktop}/archive`)).toBeLessThan(
      order.indexOf(`POST /containers/${r.docker.desktop}/start`),
    );
  });

  it("will not start a computer while the key layer is offline, and says so", async () => {
    const { orchestrator, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.stop(cell.id);
    await keyd.stop();
    await expect(orchestrator.start(cell.id)).rejects.toThrow("key layer is offline");
    expect(orchestrator.get(cell.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("start keyd"),
    });
  });

  it("closes the cell in keyd when the computer stops or is removed", async () => {
    const { orchestrator, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.stop(cell.id);
    expect(keyd.cells.has(cell.id)).toBe(false);
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    expect(keyd.cells.has(cell.id)).toBe(true);
    await orchestrator.remove(cell.id);
    expect(keyd.cells.has(cell.id)).toBe(false);
  });

  it("keeps a running desktop's keyd cell when only its gate restarts", async () => {
    const { orchestrator, store, stateOf, until } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const r = store.get(cell.id);
    const gate = docker.state.containers.get(r?.docker.gate ?? "");
    if (gate) {
      gate.running = false;
      gate.exitCode = 137;
    }
    await until(() => gate?.starts === 2 && orchestrator.get(cell.id)?.state === "ready");
    expect(keyd.calls.filter((c) => c.method === "POST" && c.path === "/v1/cells")).toHaveLength(1);
    expect(docker.state.containers.get(r?.docker.desktop ?? "")?.starts).toBe(1);
  });

  it("restarts a running desktop with new keyd files when keyd lost the cell", async () => {
    const { orchestrator, store, stateOf, until } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const r = store.get(cell.id);
    const desktop = docker.state.containers.get(r?.docker.desktop ?? "");
    const tokenBefore = desktop?.files.get(`${CELL_FILES_DIR}/proxy-token`)?.toString();
    await orchestrator.rewireIfLost(cell.id);
    expect(desktop?.starts).toBe(1);
    keyd.restart();
    await orchestrator.rewireIfLost(cell.id);
    await until(() => orchestrator.get(cell.id)?.state === "ready");
    expect(desktop?.starts).toBe(2);
    expect(keyd.cells.has(cell.id)).toBe(true);
    expect(desktop?.files.get(`${CELL_FILES_DIR}/proxy-token`)?.toString()).not.toBe(tokenBefore);
  });

  it("rewires a computer keyd lost while the daemon was away, even when keyd answered first", async () => {
    const { orchestrator, store, stateOf, client, until } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const desktop = docker.state.containers.get(store.get(cell.id)?.docker.desktop ?? "");
    orchestrator.dispose();
    keyd.restart();
    const fresh = new CellOrchestrator({
      docker: client,
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
      watchEveryMs: 0,
      keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker: client }),
    });
    cleanup.push(() => fresh.dispose());
    // The daemon's startup reconcile runs in the background: keyd's monitor can ask about the
    // cell before the reconcile has reached it.
    await fresh.rewireIfLost(cell.id);
    await fresh.reconcile();
    await until(() => fresh.get(cell.id)?.state === "ready");
    expect(desktop?.starts).toBe(2);
    expect(keyd.cells.has(cell.id)).toBe(true);
  });

  it("stops a computer whose self-test finds a way out, naming the check", async () => {
    const breach: DesktopdHealth = {
      ...healthy,
      ok: false,
      selftest: {
        ok: false,
        ms: 9,
        checks: [
          {
            id: "dns",
            kind: "isolation",
            ok: false,
            detail: "example.com resolved to 93.184.215.14",
          },
        ],
      },
    };
    const { orchestrator, store, stateOf } = await setup({ probe: () => breach });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toBe(
      "network isolation check failed (dns: example.com resolved to 93.184.215.14); the computer was stopped",
    );
    expect(docker.state.containers.get(store.get(cell.id)?.docker.desktop ?? "")?.running).toBe(
      false,
    );
    expect(keyd.cells.has(cell.id)).toBe(false);
  });

  it("names the failing self-test check when a cell never gets ready", async () => {
    const stuck: DesktopdHealth = {
      ...healthy,
      ok: false,
      selftest: {
        ok: false,
        ms: 4,
        checks: passing.checks.map((c) =>
          c.id === "keyd" ? { ...c, ok: false, detail: "timeout" } : c,
        ),
      },
    };
    const { orchestrator, stateOf } = await setup({ probe: () => stuck, readyTimeoutMs: 30 });
    const cell = await orchestrator.create({ scale: 2 });
    expect((await stateOf(cell.id, "failed")).error).toMatch(
      /^not ready after .* s: self-test failed: keyd: timeout$/,
    );
  });

  it("stops the containers of a cell whose record can't be read, closes it in keyd, removes nothing", async () => {
    const { orchestrator, store, stateOf, home, client } = await setup();
    const lost = await orchestrator.create({ scale: 2 });
    const kept = await orchestrator.create({ scale: 2 });
    await stateOf(lost.id, "ready");
    await stateOf(kept.id, "ready");
    const names = store.get(lost.id)?.docker;
    if (!names) throw new Error("no record");
    writeFileSync(join(home, "cells", lost.id, "cell.json"), "{ not json");
    orchestrator.dispose();
    const fresh = new CellOrchestrator({
      docker: client,
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
      watchEveryMs: 0,
      keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker: client }),
    });
    cleanup.push(() => fresh.dispose());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fresh.reconcile();
    } finally {
      error.mockRestore();
    }
    for (const name of [names.desktop, names.gate]) {
      expect(docker.state.containers.get(name)).toMatchObject({ running: false });
    }
    expect(docker.state.networks.has(names.internalNetwork)).toBe(true);
    expect(docker.state.volumes.has(names.homeVolume)).toBe(true);
    expect(keyd.cells.has(lost.id)).toBe(false);
    const keptRecord = store.get(kept.id);
    expect(docker.state.containers.get(keptRecord?.docker.desktop ?? "")?.running).toBe(true);
    expect(keyd.cells.has(kept.id)).toBe(true);
  });

  it("never touches a cell of another home, whatever its prefix", async () => {
    const { orchestrator, store, stateOf, client } = await setup();
    const mine = await orchestrator.create({ scale: 2 });
    await stateOf(mine.id, "ready");
    // A second daemon on another LOCALDOT_HOME (an e2e run, say), with the same name prefix.
    const otherHome = mkdtempSync(join(tmpdir(), "local dot's other-home-"));
    cleanup.push(() => rmSync(otherHome, { recursive: true, force: true }));
    const other = new CellOrchestrator({
      docker: client,
      store: new CellStore(otherHome, { from: 4791, to: 4797 }),
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
      watchEveryMs: 0,
      keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker: client }),
    });
    cleanup.push(() => other.dispose());
    await other.reconcile();
    const names = store.get(mine.id)?.docker;
    for (const name of [names?.desktop ?? "", names?.gate ?? ""]) {
      expect(docker.state.containers.get(name)).toMatchObject({ running: true });
    }
    expect(docker.state.networks.has(names?.internalNetwork ?? "")).toBe(true);
    expect(keyd.cells.has(mine.id)).toBe(true);
  });

  it("refuses an internal network that has a gateway address, and undoes the create", async () => {
    const { orchestrator, store } = await setup({ gatewayOnInternal: true });
    const err = await orchestrator.create({ scale: 2 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(
      /has a gateway address .*does not isolate internal networks/,
    );
    expect(store.list()).toEqual([]);
    expect(docker.state.networks.size).toBe(0);
    expect(docker.state.containers.size).toBe(0);
    expect(keyd.cells.size).toBe(0);
  });

  it("clamps the self-test's detail in the cell's error", async () => {
    const breach: DesktopdHealth = {
      ...healthy,
      ok: false,
      selftest: {
        ok: false,
        ms: 9,
        checks: [{ id: "dns", kind: "isolation", ok: false, detail: "x".repeat(500) }],
      },
    };
    const { orchestrator, stateOf } = await setup({ probe: () => breach });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toBe(
      `network isolation check failed (dns: ${"x".repeat(199)}…); the computer was stopped`,
    );
  });

  it("names a check the self-test left out when a cell never gets ready", async () => {
    const partial: DesktopdHealth = {
      ...healthy,
      ok: false,
      selftest: { ...passing, checks: passing.checks.filter((c) => c.id !== "gateway") },
    };
    const { orchestrator, stateOf } = await setup({ probe: () => partial, readyTimeoutMs: 30 });
    const cell = await orchestrator.create({ scale: 2 });
    expect((await stateOf(cell.id, "failed")).error).toMatch(
      /^not ready after .* s: self-test failed: gateway: missing$/,
    );
  });
});

describe("CellOrchestrator's keyd ports and removals", () => {
  it("counts a running cell whose folder was deleted by hand when it hands out a port", async () => {
    const { orchestrator, store, stateOf, home } = await setup();
    const first = await orchestrator.create({ scale: 2 });
    await stateOf(first.id, "ready");
    expect(store.get(first.id)?.keydPort).toBe(4791);
    rmSync(join(home, "cells", first.id), { recursive: true, force: true });
    const second = await orchestrator.create({ scale: 2 });
    expect(store.get(second.id)?.keydPort).toBe(4792);
  });

  it("names the folder to fix and the containers to remove while a record can't be read", async () => {
    const { orchestrator, stateOf, home } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    writeFileSync(join(home, "cells", cell.id, "cell.json"), "{ not json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = await orchestrator.create({ scale: 2 }).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "SkippedCellsError" });
      // A fixed record starts the computer again (P4b-R14): its containers go only with its folder.
      expect((err as Error).message).toBe(
        `cell records this daemon can't use (unreadable, or outside its keyd ports) may still hold keyd ports. Fix ${join(home, "cells", cell.id)} to start those computers again, or remove a folder and then its containers (localdot-*-${cell.id}), before creating another computer`,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("emits no failure while a remove runs, even as the watch finds a container gone", async () => {
    const { orchestrator, store, stateOf, changes, until } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const names = store.get(cell.id)?.docker;
    const gateGone = Promise.withResolvers<void>();
    docker.state.holds.set(`DELETE /containers/${names?.gate}`, gateGone.promise);
    const removed = orchestrator.remove(cell.id);
    await until(() => !docker.state.containers.has(names?.desktop ?? ""));
    // The watch loop polls without pause here: give it time to see the desktop gone.
    await new Promise((r) => setTimeout(r, 50));
    gateGone.resolve();
    await removed;
    const states = changes.filter((c) => c.id === cell.id).map((c) => c.state);
    expect(states).not.toContain("failed");
    expect(states.at(-1)).toBe("removed");
  });
  it("refreshes a computer's surrogates in its queue, after a start that is still wiring it", async () => {
    const { orchestrator, store, stateOf, until } = await setup();
    keyd.records.set("weather", { id: "weather", ...record, hosts: ["api.weather.example"] });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.stop(cell.id);
    const desktop = store.get(cell.id)?.docker.desktop ?? "";
    let release = () => {};
    docker.state.holds.set(
      `POST /containers/${desktop}/start`,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const starting = orchestrator.start(cell.id);
    await until(() => orchestrator.get(cell.id)?.state === "starting");
    const minted = () =>
      keyd.calls.filter((c) => c.path === `/v1/cells/${cell.id}/surrogates`).length;
    const refreshed = refreshRunningCells(orchestrator, "weather");
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(minted()).toBe(0);
    } finally {
      release();
      await starting;
      await refreshed;
    }
    expect(await refreshed).toEqual({ restart: false });
    expect(minted()).toBe(1);
    const current = keyd.cells.get(cell.id)?.surrogates.weather ?? "";
    expect(keyd.cells.get(cell.id)?.valid.has(current)).toBe(true);
    const files = docker.state.containers.get(desktop)?.files;
    expect(files?.get(`${CELL_FILES_DIR}/surrogates.sh`)?.toString()).toContain(`'${current}'`);
  });

  it.each(["pause", "stop"] as const)(
    "does not refresh credentials after an earlier queued %s changes the computer",
    async (operation) => {
      const { orchestrator, stateOf } = await setup();
      keyd.records.set("weather", { id: "weather", ...record, hosts: ["api.weather.example"] });
      const cell = await orchestrator.create({ scale: 2 });
      await stateOf(cell.id, "ready");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const changed = orchestrator.withLifecycle(cell.id, async (controls) => {
        entered.resolve();
        await release.promise;
        await controls[operation]();
      });
      await entered.promise;
      // The initial list still says ready. Eligibility must be checked again
      // inside the queue, after Stop has frozen or stopped the desktop.
      const refreshed = refreshRunningCells(orchestrator, "weather");
      release.resolve();
      await changed;
      expect(await refreshed).toEqual({ restart: false });
      expect(keyd.calls.filter((c) => c.path === `/v1/cells/${cell.id}/surrogates`)).toEqual([]);
      expect(orchestrator.get(cell.id)).toMatchObject(
        operation === "pause" ? { state: "ready", paused: true } : { state: "stopped" },
      );
    },
  );
});
