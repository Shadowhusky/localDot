import { DEFAULT_AUTONOMY, ReplacementRecord, SELFTEST_CHECKS, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.ts";
import { DockerClient } from "../../cells/docker.ts";
import { CellOrchestrator } from "../../cells/orchestrator.ts";
import { TicketRegistry } from "../../cells/secrets.ts";
import { CellStore } from "../../cells/store.ts";
import { startFakeDocker } from "../../cells/testing/fake-docker.ts";
import type { DesktopdHealth } from "../../cells/types.ts";
import { monotonicClock } from "../../clock.ts";
import { DesktopdRegistry } from "../../desktopd/registry.ts";
import { ShellCleanupUncertainError } from "../../desktopd/tools-client.ts";
import { KillSwitch } from "../../gateway/kill-switch.ts";
import { LiveSessions } from "../../gateway/live.ts";
import { MemoryStore } from "../memory.ts";
import { AgentRunner, type AgentRunnerDeps } from "../runner.ts";
import { toolHarness } from "../testing/harness.ts";
import { ComputerFences } from "./fences.ts";
import { createReplacementController } from "./replacement-controller.ts";
import { SafetyIntentStore } from "./store.ts";

const owned: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of owned.splice(0)) await close();
  vi.restoreAllMocks();
});
const TOKEN = "r".repeat(43);
async function until(test: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("replacement fixture condition missing");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}
function hold() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const h = toolHarness({ autoApprove: false }),
    home = h.home,
    fences = new ComputerFences(home),
    store = new CellStore(home),
    fake = await startFakeDocker();
  const open = new Set<string>(),
    calls: { kind: string; id: string }[] = [];
  const keyd = {
    wire: vi.fn(async (record: { id: string }) => {
      open.add(record.id);
      calls.push({ kind: "wire", id: record.id });
    }),
    isWired: async (record: { id: string }) => open.has(record.id),
    refresh: vi.fn(async () => []),
    revoke: vi.fn(async (id: string) => {
      calls.push({ kind: "revoke", id });
      return 0;
    }),
    close: vi.fn(async (id: string) => {
      open.delete(id);
      calls.push({ kind: "close", id });
    }),
  };
  const health: DesktopdHealth = {
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
      checks: SELFTEST_CHECKS.map((check) => ({
        ...check,
        ok: true,
        detail: "synthetic readiness",
      })),
      ms: 0,
    },
  };
  const cells = new CellOrchestrator({
    docker: new DockerClient(fake.socketPath),
    store,
    keyd,
    images: { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" },
    permanentFence: (id) => (fences.record(id) ? { revision: 1 } : fences.isFenced(id)),
    probeDesktopd: async () => health,
    probeStream: async () => true,
    watchEveryMs: 60000,
    readyTimeoutMs: 1000,
  });
  await cells.create({ id: h.session.cellId, scale: 2 });
  await until(() => cells.get(h.session.cellId)?.state === "ready");
  const live = new LiveSessions(),
    tickets = new TicketRegistry(),
    killSwitch = new KillSwitch({ live, keyd, cells, settleMs: 200 });
  const retireBrain = vi.fn(async (_session: string) => {});
  const runnerDeps: AgentRunnerDeps = {
    home,
    fences,
    eventLog: h.eventLog,
    live,
    cell: (id) => cells.get(id),
    cellBusy: (id) => killSwitch.isBusy(id),
    brains: {
      open: vi.fn(async () => {
        throw new Error("no model allocation in this fixture");
      }),
      start: async () => {},
      exited: async () => 0,
      close: async () => {},
      retireSession: retireBrain,
    },
    keyd: {
      secrets: async () => [],
      beginTask: async () => {},
      modelAdmission: async () => {
        throw new Error("no model admission in this fixture");
      },
      setModelAdmission: async () => {
        throw new Error("no model admission in this fixture");
      },
    },
    settings: () => ({ main: { provider: "chatgpt", model: "gpt-6-astra" } }),
    catalog: () => normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-04T00:00:00Z"),
    memory: new MemoryStore(home),
    transcripts: h.transcripts,
    installSkills: async () => [],
    waitForUploads: async () => {},
    stopSession: (id) => killSwitch.stopSession(id),
  };
  const runner = new AgentRunner(runnerDeps);
  live.start(
    h.session.cellId,
    h.session.id,
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  h.tools.stopForUncertainty = (session, reason) => runner.contain(session, reason);
  const replacement = createReplacementController({
    home,
    fences,
    runner,
    cells,
    tickets,
    readyTimeoutMs: 1000,
  });
  const clock = monotonicClock(),
    registry = new DesktopdRegistry(cells, clock);
  const app = createApp({
    token: TOKEN,
    port: 4750,
    eventLog: h.eventLog,
    cells: { cells, tickets, replacement },
    desktop: { cells, tickets, vendorDir: "/private/tmp/unused-selkies" },
    gateway: { registry, clock, live, killSwitch },
  });
  const request = (path: string, method = "GET", body?: unknown, token: string | null = TOKEN) =>
    app.request(`http://127.0.0.1:4750${path}`, {
      method,
      headers: {
        host: "127.0.0.1:4750",
        origin: "http://127.0.0.1:4750",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const oldCellId = h.session.cellId,
    old = store.get(oldCellId);
  if (!old) throw new Error("old record missing");
  const fence = async () => {
    await runner.contain(h.session, "shell_cleanup_uncertain");
    await live.settled(h.session.id);
  };
  const body = () => ({ requestId: ulid(), oldRevision: 1, home: "fresh" });
  owned.push(async () => {
    registry.dispose();
    cells.dispose();
    h.session.stop();
    live.stop(h.session.id);
    await runner.close();
    await fake.close();
    h.close();
  });
  return {
    h,
    home,
    oldCellId,
    old,
    fake,
    cells,
    store,
    keyd,
    open,
    calls,
    live,
    tickets,
    killSwitch,
    runner,
    runnerDeps,
    retireBrain,
    replacement,
    request,
    fence,
    body,
    health,
    fences,
  };
}
describe("replacement crosses real runner, lifecycle and public route boundaries", () => {
  it("a named shell uncertainty permanently fences historical work; only the fresh Ready identity can run", async () => {
    const f = await fixture(),
      ticket = f.tickets.issue(f.oldCellId);
    const originalDesktop = f.h.tools.desktop;
    f.h.tools.desktop = (id) => {
      const desktop = originalDesktop(id);
      if (!desktop) return undefined;
      return {
        ...desktop,
        shell: async () => {
          throw new ShellCleanupUncertainError();
        },
      };
    };
    const pending = f.h.call("shell", { command: "uncertain named shell fixture", timeout_sec: 1 });
    await until(() => !!f.h.session.pendingApproval);
    const card = f.h.session.pendingApproval;
    if (!card) throw new Error("shell approval missing");
    f.h.session.answerApproval({
      approvalId: card.approvalId,
      generation: card.generation,
      revision: card.revision,
      decision: "approve",
    });
    const result = await pending;
    expect(result.body.ok).toBe(false);
    await f.live.settled(f.h.session.id);
    expect(new ComputerFences(f.home).isFenced(f.oldCellId)).toBe(true);
    const response = await f.request(`/api/cells/${f.oldCellId}/replacement`, "POST", f.body());
    expect(response.status).toBe(200);
    const record = ReplacementRecord.parse(await response.json());
    if (!record.newCellId) throw new Error("fresh ID missing");
    expect(record).toMatchObject({ phase: "ready", oldCellId: f.oldCellId });
    expect(record.newCellId).not.toBe(f.oldCellId);
    const fresh = f.store.get(record.newCellId);
    expect(fresh).toBeDefined();
    expect(fresh?.tokens).not.toEqual(f.old.tokens);
    expect(fresh?.docker.homeVolume).not.toBe(f.old.docker.homeVolume);
    expect(f.fake.state.volumes.has(f.old.docker.homeVolume)).toBe(true);
    expect(
      [...f.fake.state.containers.values()].some((c) =>
        JSON.stringify(c.body.HostConfig).includes(f.old.docker.homeVolume),
      ),
    ).toBe(false);
    await expect(f.runner.start(f.oldCellId, "old historical task")).rejects.toThrow(
      "cleanup needs attention",
    );
    await expect(f.cells.start(f.oldCellId)).rejects.toThrow("fenced");
    await expect(f.killSwitch.resume(f.oldCellId)).rejects.toThrow("fenced");
    expect((await f.request(`/cells/${f.oldCellId}/desktop/${ticket}/api/status`)).status).toBe(
      403,
    );
    expect((await f.request(`/api/cells/${f.oldCellId}/stream-ticket`, "POST")).status).toBe(409);
    const nativeEffects = f.fake.state.calls.filter(
      (call) => call.method === "DELETE" && call.path.startsWith("/containers/"),
    );
    expect(nativeEffects.every((call) => call.path.includes("id-localdot-"))).toBe(true);
  });
  it.each(["keyd closure", "container deletion", "network deletion", "post-delete absence"])(
    "%s failure never allocates or wires another computer",
    async (boundary) => {
      const f = await fixture();
      await f.fence();
      const wires = f.keyd.wire.mock.calls.length,
        creates = f.fake.state.calls.filter(
          (call) => call.method === "POST" && call.path === "/containers/create",
        ).length;
      if (boundary === "keyd closure") f.keyd.close.mockRejectedValue(new Error("lost close"));
      if (boundary === "container deletion")
        f.fake.state.failRequests.add(`DELETE /containers/${f.old.ownership?.desktop}`);
      if (boundary === "network deletion")
        f.fake.state.failRequests.add(`DELETE /networks/${f.old.ownership?.internalNetwork}`);
      if (boundary === "post-delete absence")
        f.fake.state.failRequests.add(`GET /containers/${f.old.ownership?.desktop}/json`);
      const response = await f.request(`/api/cells/${f.oldCellId}/replacement`, "POST", f.body());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ phase: "blocked", reason: "old_retirement" });
      expect(f.keyd.wire).toHaveBeenCalledTimes(wires);
      expect(
        f.fake.state.calls.filter(
          (call) => call.method === "POST" && call.path === "/containers/create",
        ),
      ).toHaveLength(creates);
      expect(new ComputerFences(f.home).isFenced(f.oldCellId)).toBe(true);
    },
  );
  it("all ownership is checked before any foreign collision is touched", async () => {
    const f = await fixture();
    await f.fence();
    const desktop = f.fake.state.containers.get(f.old.docker.desktop);
    if (!desktop) throw new Error("desktop missing");
    desktop.body.Labels = { "localdot.cell": ulid(), "localdot.role": "desktop" };
    const before = f.fake.state.calls.filter((call) => call.method === "DELETE").length;
    const response = await f.request(`/api/cells/${f.oldCellId}/replacement`, "POST", f.body());
    expect(await response.json()).toMatchObject({ phase: "blocked" });
    expect(f.fake.state.containers.get(f.old.docker.desktop)).toBe(desktop);
    expect(f.fake.state.calls.filter((call) => call.method === "DELETE")).toHaveLength(before);
  });
  it("candidate readiness is withheld from input, Start and stream tickets until its durable Ready receipt", async () => {
    const f = await fixture();
    await f.fence();
    const gate = hold(),
      create = f.cells.create.bind(f.cells);
    let candidate: string | undefined;
    vi.spyOn(f.cells, "create").mockImplementation(async (options) => {
      candidate = options.id;
      const result = await create(options);
      await until(() => f.cells.get(result.id)?.state === "ready");
      await gate.promise;
      return result;
    });
    const pending = f.request(`/api/cells/${f.oldCellId}/replacement`, "POST", f.body());
    await until(() => !!candidate && f.cells.get(candidate)?.state === "ready");
    if (!candidate) throw new Error("candidate missing");
    expect(f.cells.get(candidate)?.replacementPending).toBe(true);
    expect(f.cells.endpoints(candidate)).toBeUndefined();
    expect((await f.request(`/api/cells/${candidate}/start`, "POST")).status).toBe(409);
    expect((await f.request(`/api/cells/${candidate}/stream-ticket`, "POST")).status).toBe(409);
    const input = await f.request(`/api/cells/${candidate}/input`, "POST", {});
    expect(input.status).toBe(409);
    expect(await input.text()).toContain("awaiting replacement confirmation");
    await expect(f.runner.start(candidate, "candidate task")).rejects.toThrow(
      "paused or changing state",
    );
    gate.resolve();
    expect((await pending).status).toBe(200);
    expect(f.cells.get(candidate)?.replacementPending).toBeUndefined();
    expect(f.cells.endpoints(candidate)).toBeDefined();
  });
  it("a computer fenced while its runtime is verified never reaches Ready", async () => {
    const f = await fixture(),
      id = ulid(),
      checked = hold();
    let fenced = false;
    const cells = new CellOrchestrator({
      docker: new DockerClient(f.fake.socketPath),
      store: f.store,
      keyd: f.keyd,
      images: { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" },
      permanentFence: (cell) => cell === id && fenced,
      verifyRuntime: async (record) => {
        if (record.id !== id || cells.get(id)?.state !== "starting") return;
        fenced = true;
        checked.resolve();
      },
      probeDesktopd: async () => f.health,
      probeStream: async () => true,
      watchEveryMs: 60000,
      readyTimeoutMs: 1000,
    });
    owned.push(async () => cells.dispose());
    await cells.create({ id, scale: 2 });
    await checked.promise;
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(cells.get(id)?.state).toBe("starting");
    expect(cells.endpoints(id)).toBeUndefined();
  });
  it("public replacement routes require daemon authorization and reject stale or caller-selected identities", async () => {
    const f = await fixture();
    await f.fence();
    const before = f.fake.state.calls.length,
      body = f.body(),
      path = `/api/cells/${f.oldCellId}/replacement`;
    expect((await f.request(path, "POST", body, null)).status).toBe(401);
    expect((await f.request(path, "POST", { ...body, newCellId: ulid() })).status).toBe(400);
    expect((await f.request(path, "POST", { ...body, oldRevision: 2 })).status).toBe(409);
    expect(f.fake.state.calls).toHaveLength(before);
  });
  it("a reserved identity collision and simultaneous create cannot reuse a foreign home", async () => {
    const f = await fixture(),
      id = ulid(),
      name = `localdot-home-${id}`;
    f.fake.state.volumes.add(name);
    f.fake.state.volumeLabels.set(name, { "localdot.cell": ulid(), "localdot.role": "home" });
    const before = f.fake.state.calls.filter((call) => call.method === "POST").length;
    await expect(f.cells.create({ id, scale: 2 })).rejects.toThrow("already exists");
    expect(f.fake.state.volumes.has(name)).toBe(true);
    expect(f.fake.state.calls.filter((call) => call.method === "POST")).toHaveLength(before);
  });
  it("cold Ready recovery verifies ownership, keyd and readiness before publishing the same candidate", async () => {
    const f = await fixture();
    await f.fence();
    const body = f.body(),
      response = await f.request(`/api/cells/${f.oldCellId}/replacement`, "POST", body),
      ready = ReplacementRecord.parse(await response.json());
    expect(ready.phase).toBe("ready");
    if (!ready.newCellId) throw new Error("fresh ID missing");
    f.cells.dispose();
    const proof = hold();
    let checked = false;
    const cold = new CellOrchestrator({
      docker: new DockerClient(f.fake.socketPath),
      store: f.store,
      keyd: f.keyd,
      images: { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" },
      permanentFence: (id) => (f.fences.record(id) ? { revision: 1 } : f.fences.isFenced(id)),
      probeDesktopd: async () => {
        checked = true;
        await proof.promise;
        return f.health;
      },
      probeStream: async () => true,
      watchEveryMs: 60000,
    });
    owned.push(async () => cold.dispose());
    const restore = createReplacementController({
      home: f.home,
      fences: new ComputerFences(f.home),
      runner: f.runner,
      cells: cold,
      tickets: new TicketRegistry(),
    });
    const before = f.fake.state.calls.filter(
        (c) => c.method === "POST" && c.path === "/containers/create",
      ).length,
      pending = restore.owner.start();
    await until(() => checked);
    expect(cold.get(ready.newCellId)?.replacementPending).toBe(true);
    expect(cold.endpoints(ready.newCellId)).toBeUndefined();
    await expect(cold.start(ready.newCellId)).rejects.toThrow("fenced");
    proof.resolve();
    await pending;
    expect(await restore.owner.status(f.oldCellId, body.requestId)).toEqual(ready);
    expect(cold.endpoints(ready.newCellId)).toBeDefined();
    expect(
      f.fake.state.calls.filter((c) => c.method === "POST" && c.path === "/containers/create"),
    ).toHaveLength(before);
    expect(cold.endpoints(f.oldCellId)).toBeUndefined();
  });
  it("a computer fenced at start by a crashed Pause is replaced by a fresh Ready computer", async () => {
    const f = await fixture();
    f.h.session.stop();
    f.live.stop(f.h.session.id);
    await f.live.settled(f.h.session.id);
    new SafetyIntentStore(f.home).write(
      f.h.session.id,
      f.oldCellId,
      DEFAULT_AUTONOMY,
      {
        requestId: ulid(),
        revision: 1,
        reason: "user",
        phase: "pausing",
        atStepBoundary: false,
        resumeAvailable: false,
      },
      "api",
    );
    f.cells.dispose();
    const fences = new ComputerFences(f.home),
      cells = new CellOrchestrator({
        docker: new DockerClient(f.fake.socketPath),
        store: f.store,
        keyd: f.keyd,
        images: { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" },
        permanentFence: (id) => (fences.record(id) ? { revision: 1 } : fences.isFenced(id)),
        probeDesktopd: async () => f.health,
        probeStream: async () => true,
        watchEveryMs: 60000,
        readyTimeoutMs: 1000,
      });
    owned.push(async () => cells.dispose());
    await cells.containFenced();
    expect(cells.get(f.oldCellId)?.fenced).toEqual({ revision: 1 });
    const live = new LiveSessions(),
      runner = new AgentRunner({ ...f.runnerDeps, fences, live, cell: (id) => cells.get(id) });
    owned.push(() => runner.close());
    const restarted = createReplacementController({
      home: f.home,
      fences,
      runner,
      cells,
      tickets: new TicketRegistry(),
      readyTimeoutMs: 1000,
    });
    await restarted.owner.start();
    await cells.reconcile();
    const record = await restarted.owner.replace(f.oldCellId, f.body());
    expect(record).toMatchObject({ phase: "ready", oldCellId: f.oldCellId });
    if (!record.newCellId) throw new Error("fresh ID missing");
    expect(cells.get(record.newCellId)).toMatchObject({ state: "ready" });
    expect(cells.get(record.newCellId)?.replacementPending).toBeUndefined();
    expect(cells.endpoints(record.newCellId)).toBeDefined();
    expect(fences.isFenced(record.newCellId)).toBe(false);
  });
  it("startup containment stops only captured owned executors and leaves the old home for recovery", async () => {
    const f = await fixture();
    f.fences.capture(f.oldCellId, f.h.session.id, "api");
    const foreignId = ulid();
    await f.cells.create({ id: foreignId, scale: 2 });
    await until(() => f.cells.get(foreignId)?.state === "ready");
    await f.cells.containFenced();
    for (const name of [f.old.docker.desktop, f.old.docker.gate])
      expect(f.fake.state.containers.get(name)?.running).toBe(false);
    const foreign = f.cells.record(foreignId);
    if (!foreign) throw new Error("foreign fixture missing");
    expect(f.fake.state.containers.get(foreign.docker.desktop)?.running).toBe(true);
    expect(f.fake.state.volumes.has(f.old.docker.homeVolume)).toBe(true);
    expect(f.cells.endpoints(f.oldCellId)).toBeUndefined();
    expect(f.keyd.close).toHaveBeenCalledWith(f.oldCellId);
  });
  it("startup containment refuses a foreign label collision before stopping either container", async () => {
    const f = await fixture();
    f.fences.capture(f.oldCellId, f.h.session.id, "api");
    const desktop = f.fake.state.containers.get(f.old.docker.desktop);
    if (!desktop) throw new Error("desktop fixture missing");
    desktop.body.Labels = { "localdot.cell": ulid(), "localdot.role": "desktop" };
    const before = f.fake.state.calls.filter(
      (c) => c.method === "POST" && c.path.endsWith("/stop"),
    ).length;
    await f.cells.containFenced();
    expect(desktop.running).toBe(true);
    expect(f.cells.get(f.oldCellId)?.error).toContain("cleanup attention");
    expect(
      f.fake.state.calls.filter((c) => c.method === "POST" && c.path.endsWith("/stop")),
    ).toHaveLength(before);
  });
});
