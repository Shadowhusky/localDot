import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELFTEST_CHECKS, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerClient } from "../cells/docker.ts";
import { CellOrchestrator, type OrchestratorDeps } from "../cells/orchestrator.ts";
import { CellStore } from "../cells/store.ts";
import { type FakeDocker, startFakeDocker } from "../cells/testing/fake-docker.ts";
import type { CellSummary, DesktopdHealth } from "../cells/types.ts";
import { CELL_FILES_DIR, CellKeydWiring } from "../keyd/cell-wiring.ts";
import { KeydClient, KeydUnavailableError } from "../keyd/client.ts";
import { type FakeKeyd, startFakeKeyd } from "../keyd/testing/fake-keyd.ts";
import { stopAll } from "../routines/stop-all.ts";
import { RoutineStore } from "../routines/store.ts";
import { KillSwitch, type StopOutcome } from "./kill-switch.ts";
import { LiveSessions } from "./live.ts";

const healthy: DesktopdHealth = {
  ok: true,
  scale: 2,
  display: ":1",
  selftest: {
    ok: true,
    ms: 0,
    checks: SELFTEST_CHECKS.map((check) => ({ ...check, ok: true, detail: "ok" })),
  },
  screen: { w: 2560, h: 1600 },
  hidpi: {
    ok: true,
    expected: { windowScalingFactor: 2, xftDpi: 96 },
    windowScalingFactor: 2,
    xftDpi: 96,
  },
};
const SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
// Gives up after 2 s so a test that never gets there fails on its assertions.
const until = (pred: () => boolean) =>
  new Promise<void>((resolve) => {
    const deadline = Date.now() + 2000;
    const check = () => (pred() || Date.now() > deadline ? resolve() : setTimeout(check, 5));
    check();
  });
// For a crash restart whose backoff is real time, so a Stop can land inside it.
const realTime: Partial<OrchestratorDeps> = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  watchEveryMs: 20,
  restartBackoffMs: [300],
};
// A session that runs until Stop aborts it.
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));

let docker: FakeDocker;
let keyd: FakeKeyd;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function readyCell(settleMs = 200, opts: Partial<OrchestratorDeps> = {}) {
  docker = await startFakeDocker();
  keyd = await startFakeKeyd();
  keyd.records.set("weather", { id: "weather", kind: "http", createdAt: "t", updatedAt: "t" });
  const home = mkdtempSync(join(tmpdir(), "local dot's kill-"));
  const client = new DockerClient(docker.socketPath);
  const wiring = new CellKeydWiring({
    keyd: new KeydClient(keyd.socketPath, 1000),
    docker: client,
  });
  const store = new CellStore(home);
  const cells = new CellOrchestrator({
    docker: client,
    store,
    images: { desktop: "d", gate: "g" },
    probeDesktopd: async () => healthy,
    probeStream: async () => true,
    sleep: async () => {},
    watchEveryMs: 60_000,
    keyd: wiring,
    ...opts,
  });
  cleanup.push(
    () => docker.close(),
    () => keyd.close(),
    () => rmSync(home, { recursive: true, force: true }),
    () => cells.dispose(),
  );
  const changes: CellSummary[] = [];
  cells.subscribe((c) => changes.push(c));
  const cell = await cells.create({ scale: 2 });
  await until(() => cells.get(cell.id)?.state === "ready");
  expect(cells.get(cell.id)?.state).toBe("ready");
  const live = new LiveSessions();
  const killSwitch = new KillSwitch({ live, keyd: wiring, cells, settleMs });
  const desktop = () => docker.state.containers.get(store.get(cell.id)?.docker.desktop ?? "");
  return { cells, live, killSwitch, id: cell.id, desktop, changes, store, client, wiring };
}

describe("KillSwitch.stopSession", () => {
  it("publishes one physical Stop receipt before aborting session cleanup that awaits it", async () => {
    const { live, killSwitch, id, desktop } = await readyCell(30);
    let observed: Promise<StopOutcome> | undefined;
    live.start(id, SESSION, async (signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            observed = killSwitch.pendingStop(SESSION);
            resolve();
          },
          { once: true },
        ),
      );
      await observed;
    });
    const stopping = killSwitch.stopSession(SESSION);
    expect(observed).toBe(stopping);
    expect(killSwitch.pendingStop(SESSION)).toBe(stopping);
    expect(killSwitch.pendingStop("unrelated")).toBeUndefined();
    expect(killSwitch.stopSession(SESSION)).toBe(stopping);
    expect(await stopping).toMatchObject({ revoked: true, paused: true, stopped: false });
    await live.settled(SESSION);
    expect(desktop()?.paused).toBe(true);
    expect(killSwitch.pendingStop(SESSION)).toBeUndefined();
    expect(killSwitch.isBusy(id)).toBe(false);
  });

  it("aborts the session, revokes the cell's keys, lets the run finish, then freezes the desktop", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    const timeline: string[] = [];
    live.start(id, SESSION, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      timeline.push(`aborted, keyd revoked ${keyd.cells.get(id)?.revoked}`);
      await new Promise((r) => setTimeout(r, 30));
      timeline.push(`run ended, paused ${desktop()?.paused}`);
    });
    const outcome = await killSwitch.stopSession(SESSION);
    expect(outcome).toEqual({
      revoked: true,
      paused: true,
      closed: false,
      stopped: false,
      errors: [],
    });
    expect(timeline).toEqual(["aborted, keyd revoked 0", "run ended, paused false"]);
    expect(keyd.cells.get(id)).toMatchObject({ revoked: 1, surrogates: {} });
    expect(desktop()?.paused).toBe(true);
    expect(cells.get(id)).toMatchObject({ state: "ready", paused: true });
    expect(live.get(id)).toBeUndefined();
  });

  it("says which computer it froze", async () => {
    const { cells, live, wiring, id } = await readyCell();
    const froze = vi.fn();
    const killSwitch = new KillSwitch({ live, keyd: wiring, cells, settleMs: 50, froze });
    live.start(id, SESSION, (signal) => new Promise((r) => signal.addEventListener("abort", r)));
    expect(await killSwitch.stopSession(SESSION)).toMatchObject({ paused: true });
    expect(froze).toHaveBeenCalledWith(id);
  });

  it("freezes the desktop after a bounded wait even if the run never ends", async () => {
    const { live, killSwitch, id, desktop } = await readyCell(50);
    live.start(id, SESSION, () => new Promise(() => {}));
    const started = Date.now();
    expect(await killSwitch.stopSession(SESSION)).toMatchObject({ paused: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(desktop()?.paused).toBe(true);
  });

  it("still freezes the desktop when keyd is down, and says what failed", async () => {
    const { live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await keyd.stop();
    const outcome = await killSwitch.stopSession(SESSION);
    expect(outcome).toMatchObject({ revoked: false, paused: true });
    expect(outcome?.errors.join()).toContain("keyd");
    expect(desktop()?.paused).toBe(true);
  });

  it("closes the cell in keyd and stops the computer when the desktop cannot be frozen", async () => {
    const { cells, live, killSwitch, id, desktop, store } = await readyCell();
    live.start(id, SESSION, untilAborted);
    docker.state.failRequests.add(`POST /containers/${store.get(id)?.docker.desktop}/pause`);
    const outcome = await killSwitch.stopSession(SESSION);
    expect(outcome).toMatchObject({ revoked: true, paused: false, closed: true, stopped: true });
    expect(outcome?.errors.join()).toContain("pause");
    expect(keyd.cells.has(id)).toBe(false);
    expect(desktop()).toMatchObject({ running: false, paused: false });
    expect(cells.get(id)?.state).toBe("stopped");
  });

  it("stops a computer Stop caught in a crash restart's backoff, so the queued restart never reopens it", async () => {
    const { cells, live, killSwitch, id, desktop, store } = await readyCell(200, realTime);
    const gate = docker.state.containers.get(store.get(id)?.docker.gate ?? "");
    if (!gate) throw new Error("no gate");
    live.start(id, SESSION, untilAborted);
    gate.running = false;
    gate.exitCode = 137;
    await until(() => cells.get(id)?.state === "starting");
    const outcome = await killSwitch.stopSession(SESSION);
    expect(outcome).toMatchObject({ paused: false, closed: true, stopped: true });
    // Past the 300 ms backoff: the restart it queued finds the cell stopped and does nothing.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(cells.get(id)?.state).toBe("stopped");
    expect(keyd.cells.has(id)).toBe(false);
    expect(desktop()).toMatchObject({ running: false, starts: 1 });
    expect(gate).toMatchObject({ running: false, starts: 1 });
  });

  it("keeps a computer it could not freeze stopped through a keyd and a daemon restart", async () => {
    const { cells, live, killSwitch, id, desktop, store, client, wiring } = await readyCell();
    live.start(id, SESSION, untilAborted);
    docker.state.failRequests.add(`POST /containers/${store.get(id)?.docker.desktop}/pause`);
    await killSwitch.stopSession(SESSION);
    keyd.restart();
    await cells.rewireIfLost(id);
    expect(desktop()).toMatchObject({ running: false, starts: 1 });
    expect(keyd.cells.has(id)).toBe(false);
    cells.dispose();
    const fresh = new CellOrchestrator({
      docker: client,
      store,
      images: { desktop: "d", gate: "g" },
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
      watchEveryMs: 60_000,
      keyd: wiring,
    });
    cleanup.push(() => fresh.dispose());
    await fresh.reconcile();
    expect(fresh.get(id)?.state).toBe("stopped");
    expect(desktop()?.starts).toBe(1);
    expect(keyd.cells.has(id)).toBe(false);
  });

  it("does nothing for a session that is not live", async () => {
    const { killSwitch } = await readyCell();
    expect(await killSwitch.stopSession(SESSION)).toBeUndefined();
  });
});

describe("KillSwitch.resume", () => {
  it("watches a resumed computer again, so a crash is restarted", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    await killSwitch.resume(id);
    const d = desktop();
    if (!d) throw new Error("no desktop");
    d.running = false;
    d.exitCode = 137;
    await until(() => d.starts === 2 && cells.get(id)?.state === "ready");
    expect(d).toMatchObject({ starts: 2, running: true });
  });

  it("thaws the desktop and writes fresh surrogates", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    const before = keyd.cells.get(id)?.surrogates.weather;
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    await killSwitch.resume(id);
    const after = keyd.cells.get(id)?.surrogates.weather;
    expect(after).toMatch(/^ld_key_/);
    expect(after).not.toBe(before);
    expect(desktop()?.paused).toBe(false);
    expect(cells.get(id)?.paused).toBeUndefined();
    expect(desktop()?.files.get(`${CELL_FILES_DIR}/surrogates.sh`)?.toString()).toContain(
      `'${after}'`,
    );
  });

  it("restarts a computer Docker still calls paused after its runtime thawed it", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    const frozen = desktop();
    if (!frozen) throw new Error("no desktop");
    frozen.stuckPaused = true;
    await killSwitch.resume(id);
    await until(() => cells.get(id)?.state === "ready" && !cells.get(id)?.paused);
    expect(desktop()).toMatchObject({ running: true, paused: false });
    expect(desktop()?.starts).toBeGreaterThan(1);
  });

  it("revokes again before it mints, so a revoke Stop could not make still holds", async () => {
    const { live, killSwitch, id } = await readyCell();
    const first = keyd.cells.get(id)?.surrogates.weather ?? "";
    live.start(id, SESSION, untilAborted);
    keyd.failures.set(`POST /v1/cells/${id}/revoke`, { status: 500, code: "internal" });
    expect(await killSwitch.stopSession(SESSION)).toMatchObject({ revoked: false, paused: true });
    expect(keyd.cells.get(id)?.valid.has(first)).toBe(true);
    await killSwitch.resume(id);
    expect(keyd.cells.get(id)?.valid.has(first)).toBe(false);
    expect(keyd.cells.get(id)?.valid.size).toBe(1);
  });

  it("keeps the computer frozen while keyd is offline, and says so", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    await keyd.stop();
    await expect(killSwitch.resume(id)).rejects.toBeInstanceOf(KeydUnavailableError);
    expect(desktop()?.paused).toBe(true);
    expect(cells.get(id)?.paused).toBe(true);
  });

  it("leaves a frozen computer frozen while its gate restarts, and resumes it once it is back", async () => {
    const { cells, killSwitch, id, desktop, store, changes } = await readyCell(200, realTime);
    await cells.pause(id);
    const from = changes.length;
    const gate = docker.state.containers.get(store.get(id)?.docker.gate ?? "");
    if (!gate) throw new Error("no gate");
    gate.running = false;
    gate.exitCode = 137;
    await until(() => cells.get(id)?.state === "starting");
    await expect(killSwitch.resume(id)).rejects.toThrow("ready and paused");
    expect(desktop()?.paused).toBe(true);
    await until(() => cells.get(id)?.state === "ready");
    expect(cells.get(id)).toMatchObject({ state: "ready", paused: true });
    expect(gate.starts).toBe(2);
    // The HUD keeps Paused and Resume through the gate's restart.
    expect(changes.slice(from).filter((c) => c.id === id && !c.paused)).toEqual([]);
    await killSwitch.resume(id);
    expect(desktop()).toMatchObject({ paused: false, starts: 1 });
    expect(cells.get(id)?.paused).toBeUndefined();
  });

  it("restarts the desktop when keyd lost the cell while it was frozen", async () => {
    const { live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    keyd.restart();
    await killSwitch.resume(id);
    expect(desktop()?.starts).toBe(2);
    expect(keyd.cells.has(id)).toBe(true);
  });
});

describe("CellOrchestrator pause", () => {
  it("checks an allegedly paused desktop instead of trusting stale state", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    await cells.pause(id);
    const d = desktop();
    if (!d) throw new Error("no desktop");
    d.paused = false; // Someone thawed it outside the daemon.
    live.start(id, SESSION, untilAborted);
    expect(await killSwitch.stopSession(SESSION)).toMatchObject({
      paused: false,
      closed: true,
      stopped: true,
    });
    expect(d.running).toBe(false);
  });
  it("only pauses a ready cell, and Stop computer stops a frozen one", async () => {
    const { cells, id, desktop } = await readyCell();
    await cells.pause(id);
    await cells.pause(id);
    expect(desktop()?.paused).toBe(true);
    await cells.stop(id);
    expect(desktop()).toMatchObject({ paused: false, running: false });
    expect(keyd.cells.has(id)).toBe(false);
    await expect(cells.pause(id)).rejects.toThrow("not ready");
  });

  it("boots a desktop Docker still holds frozen afresh when the user starts the computer", async () => {
    const { cells, id, desktop } = await readyCell();
    await cells.pause(id);
    await cells.start(id);
    await until(() => cells.get(id)?.state === "ready");
    expect(cells.get(id)).toMatchObject({ state: "ready" });
    expect(cells.get(id)?.paused).toBeUndefined();
    expect(desktop()).toMatchObject({ starts: 2, running: true, paused: false });
  });

  it("keeps a frozen computer frozen when keyd restarts", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    keyd.restart();
    await cells.rewireIfLost(id);
    expect(desktop()).toMatchObject({ starts: 1, paused: true });
    expect(cells.get(id)).toMatchObject({ state: "ready", paused: true });
  });

  it("brings a frozen computer's gate back and keeps the desktop frozen", async () => {
    const { cells, id, desktop, store } = await readyCell();
    await cells.pause(id);
    const gate = docker.state.containers.get(store.get(id)?.docker.gate ?? "");
    if (!gate) throw new Error("no gate");
    gate.running = false;
    gate.exitCode = 137;
    await until(() => gate.starts === 2 && cells.get(id)?.state === "ready");
    expect(gate).toMatchObject({ starts: 2, running: true });
    expect(cells.get(id)).toMatchObject({ state: "ready", paused: true });
    expect(desktop()).toMatchObject({ starts: 1, paused: true });
  });

  it("never starts a frozen computer's desktop again behind the user's back", async () => {
    const { cells, id, desktop } = await readyCell();
    await cells.pause(id);
    const d = desktop();
    if (!d) throw new Error("no desktop");
    d.running = false;
    d.paused = false;
    d.exitCode = 137;
    await until(() => cells.get(id)?.state === "failed");
    expect(cells.get(id)).toMatchObject({
      state: "failed",
      error: "desktop container exited with 137 while it was frozen; start the computer again",
    });
    expect(cells.get(id)?.paused).toBeUndefined();
    expect(d.starts).toBe(1);
  });

  it("keeps a frozen cell frozen across a daemon restart, without probing it", async () => {
    const { cells, id, store, client, wiring } = await readyCell();
    await cells.pause(id);
    cells.dispose();
    const fresh = new CellOrchestrator({
      docker: client,
      store,
      images: { desktop: "d", gate: "g" },
      probeDesktopd: async () => undefined,
      probeStream: async () => false,
      sleep: async () => {},
      watchEveryMs: 60_000,
      keyd: wiring,
    });
    cleanup.push(() => fresh.dispose());
    await fresh.reconcile();
    expect(fresh.get(id)).toMatchObject({ state: "ready", paused: true });
  });
});

describe("kill-switch races and failed resume", () => {
  it("revokes material issued by lifecycle work that was already ahead of Stop", async () => {
    const { cells, live, killSwitch, id, wiring, store } = await readyCell();
    const record = store.get(id);
    if (!record) throw new Error("no record");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const earlier = cells.withLifecycle(id, async () => {
      entered = true;
      await held;
      await wiring.refresh(record);
    });
    await until(() => entered);
    live.start(id, SESSION, untilAborted);
    const stopping = killSwitch.stopSession(SESSION);
    try {
      await until(() => (keyd.cells.get(id)?.revoked ?? 0) > 0);
      expect(keyd.cells.get(id)?.revoked).toBe(1);
    } finally {
      release();
      await Promise.all([earlier, stopping]);
    }
    expect(await stopping).toMatchObject({ revoked: true, paused: true });
    expect(keyd.cells.get(id)?.revoked).toBe(2);
    expect(keyd.cells.get(id)?.valid.size).toBe(0);
  });
  it("revokes immediately even when an earlier Start is waiting for Docker", async () => {
    const { cells, live, killSwitch, id, store } = await readyCell();
    const path = `/containers/${store.get(id)?.docker.desktop}/json`;
    let release!: () => void;
    docker.state.holds.set(
      `GET ${path}`,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const before = docker.state.calls.length;
    const starting = cells.start(id);
    await until(() => docker.state.calls.slice(before).some((call) => call.path === path));
    live.start(id, SESSION, untilAborted);
    const stopping = killSwitch.stopSession(SESSION);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(keyd.cells.get(id)?.revoked).toBeGreaterThan(0);
    } finally {
      release();
      await Promise.all([starting, stopping]);
    }
    await starting;
    const outcome = await stopping;
    expect(outcome?.paused || outcome?.stopped).toBe(true);
  });
  it("keeps the desktop frozen if fresh credentials cannot be installed", async () => {
    const { cells, live, killSwitch, id, desktop, store } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    docker.state.failRequests.add(`PUT /containers/${store.get(id)?.docker.desktop}/archive`);
    await expect(killSwitch.resume(id)).rejects.toThrow();
    expect(cells.get(id)?.paused).toBe(true);
    expect(desktop()?.paused).toBe(true);
    expect(keyd.cells.get(id)?.valid.size).toBe(0);
  });

  it("installs credentials before thawing and exposes no endpoint while frozen", async () => {
    const { cells, live, killSwitch, id, desktop, store } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    expect(cells.endpoints(id)).toBeUndefined();
    const archive = `/containers/${store.get(id)?.docker.desktop}/archive`;
    let release!: () => void;
    docker.state.holds.set(
      `PUT ${archive}`,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const before = docker.state.calls.length;
    const resuming = killSwitch.resume(id);
    try {
      await until(() => docker.state.calls.slice(before).some((c) => c.path === archive));
      expect(desktop()?.paused).toBe(true);
      expect(killSwitch.isBusy(id)).toBe(true);
    } finally {
      release();
    }
    await resuming;
    expect(desktop()?.paused).toBe(false);
    expect(cells.endpoints(id)).toBeDefined();
    expect(killSwitch.isBusy(id)).toBe(false);
  });

  it("restarts lost key material without thawing old processes first", async () => {
    const { live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    keyd.restart();
    const before = docker.state.calls.length;
    await killSwitch.resume(id);
    expect(desktop()?.starts).toBe(2);
    expect(docker.state.calls.slice(before).filter((c) => c.path.endsWith("/unpause"))).toEqual([]);
  });

  it("keeps a desktop frozen when Docker cannot confirm unpause", async () => {
    const { cells, killSwitch, id, desktop, store } = await readyCell();
    await cells.pause(id);
    docker.state.failRequests.add(`POST /containers/${store.get(id)?.docker.desktop}/unpause`);
    await expect(killSwitch.resume(id)).rejects.toThrow();
    expect(cells.get(id)?.paused).toBe(true);
    expect(desktop()?.paused).toBe(true);
  });

  it("serializes the whole Stop before a later Start, and coalesces duplicate Stops", async () => {
    const { cells, live, killSwitch, id, desktop, wiring } = await readyCell();
    live.start(id, SESSION, untilAborted);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = wiring.revoke.bind(wiring);
    let entered = false;
    let revocations = 0;
    wiring.revoke = async (cell) => {
      entered = true;
      revocations++;
      await held;
      return revoke(cell);
    };
    const stopping = killSwitch.stopSession(SESSION);
    await until(() => entered);
    expect(killSwitch.stopSession(SESSION)).toBe(stopping);
    let started = false;
    const starting = cells.start(id).then(() => {
      started = true;
    });
    try {
      await new Promise((r) => setTimeout(r, 30));
      expect(started).toBe(false);
      expect(killSwitch.isBusy(id)).toBe(true);
    } finally {
      release();
    }
    expect(await stopping).toMatchObject({ revoked: true, paused: true });
    await starting;
    await until(() => cells.get(id)?.state === "ready");
    expect(desktop()).toMatchObject({ starts: 2, paused: false, running: true });
    expect(revocations).toBe(1);
  });

  it("does not let a gate crash during pause reboot the desktop", async () => {
    const { cells, live, killSwitch, id, desktop, store } = await readyCell(200, realTime);
    const record = store.get(id);
    if (!record) throw new Error("no record");
    const gate = docker.state.containers.get(record.docker.gate);
    if (!gate) throw new Error("no gate");
    let release!: () => void;
    const path = `/containers/${record.docker.desktop}/pause`;
    docker.state.holds.set(
      `POST ${path}`,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    live.start(id, SESSION, untilAborted);
    const stopping = killSwitch.stopSession(SESSION);
    try {
      await until(() => docker.state.calls.some((c) => c.path === path));
      gate.running = false;
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      release();
    }
    expect(await stopping).toMatchObject({ paused: true });
    await until(() => gate.starts === 2 && cells.get(id)?.state === "ready");
    expect(gate.starts).toBe(2);
    expect(desktop()).toMatchObject({ starts: 1, paused: true });
  });

  it("never exposes credential or Docker exception contents in the Stop reply", async () => {
    const { live, killSwitch, id, wiring } = await readyCell();
    live.start(id, SESSION, untilAborted);
    wiring.revoke = async () => {
      throw new Error("private-key-do-not-expose");
    };
    const outcome = await killSwitch.stopSession(SESSION);
    expect(outcome).toMatchObject({ revoked: false, paused: true });
    expect(JSON.stringify(outcome)).not.toContain("private-key");
  });
});

describe("Stop everything", () => {
  it("stops two running sessions, pauses the routine and revokes both computers within 2 s", async () => {
    const f = await readyCell(50);
    const second = await f.cells.create({ scale: 2 });
    await until(() => f.cells.get(second.id)?.state === "ready");
    const one = ulid(),
      two = ulid();
    f.live.start(f.id, one, untilAborted);
    f.live.start(second.id, two, untilAborted);
    const home = mkdtempSync(join(tmpdir(), "local dot's stop-all-"));
    const store = new RoutineStore(home, { now: Date.now, zone: () => "Europe/London" });
    cleanup.push(() => {
      store.close();
      rmSync(home, { recursive: true, force: true });
    });
    const routine = store.create(
      { name: "Morning bills", instruction: "x", when: { kind: "daily", time: "08:30" } },
      { state: "active" },
    );
    const started = Date.now();
    const outcome = await stopAll(
      {
        cells: f.cells,
        live: f.live,
        killSwitch: f.killSwitch,
        store,
        launcher: { cancelAll: () => 0 },
        scheduler: { replan: () => {} },
        audit: { append: () => {} },
        publish: () => {},
        now: Date.now,
      },
      "user",
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.confirmed).toBe(true);
    expect(outcome.sessions.map((s) => s.sessionId).sort()).toEqual([one, two].sort());
    expect(f.live.get(f.id)).toBeUndefined();
    expect(f.live.get(second.id)).toBeUndefined();
    expect(store.get(routine.id)).toMatchObject({ state: "paused", pausedReason: "stop_all" });
    expect(keyd.cells.get(f.id)?.revoked).toBeGreaterThanOrEqual(1);
    expect(keyd.cells.get(second.id)?.revoked).toBeGreaterThanOrEqual(1);
    expect(f.cells.get(f.id)?.paused).toBe(true);
    expect(f.cells.get(second.id)?.paused).toBe(true);
  });

  it("freezes a computer with no task and leaves a frozen one alone", async () => {
    const { cells, killSwitch, id, desktop } = await readyCell(30);
    expect(await killSwitch.stopIdleCell(id)).toEqual({
      revoked: true,
      paused: true,
      closed: false,
      stopped: false,
      errors: [],
    });
    expect(keyd.cells.get(id)?.revoked).toBe(1);
    expect(desktop()?.paused).toBe(true);
    expect(cells.get(id)?.paused).toBe(true);
    expect(await killSwitch.stopIdleCell(id)).toBeUndefined();
  });
});
