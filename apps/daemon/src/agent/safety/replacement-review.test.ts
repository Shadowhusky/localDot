import { ReplacementRecord, SELFTEST_CHECKS, ulid } from "@localdot/protocol";
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
import { KillSwitch } from "../../gateway/kill-switch.ts";
import { LiveSessions } from "../../gateway/live.ts";
import { MemoryStore } from "../memory.ts";
import { AgentRunner } from "../runner.ts";
import { toolHarness } from "../testing/harness.ts";
import { ComputerFences } from "./fences.ts";
import { createReplacementController } from "./replacement-controller.ts";

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
    watchEveryMs: 5,
    readyTimeoutMs: 1000,
  });
  await cells.create({ id: h.session.cellId, scale: 2 });
  await until(() => cells.get(h.session.cellId)?.state === "ready");
  const live = new LiveSessions(),
    tickets = new TicketRegistry(),
    killSwitch = new KillSwitch({ live, keyd, cells, settleMs: 200 });
  const retireBrain = vi.fn(async (_session: string) => {});
  const runner = new AgentRunner({
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
  });
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
  const app = createApp({
    token: TOKEN,
    port: 4750,
    eventLog: h.eventLog,
    cells: { cells, tickets, replacement },
    desktop: { cells, tickets, vendorDir: "/private/tmp/unused-selkies" },
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
    retireBrain,
    replacement,
    request,
    fence,
    body,
    health,
    fences,
  };
}

describe("review replacement health ownership", () => {
  it.each(["ordinary", "replacement"] as const)(
    "keeps %s computer supervision after Ready",
    async (kind) => {
      const f = await fixture();
      let id = f.oldCellId;
      if (kind === "replacement") {
        await f.fence();
        const response = await f.request(`/api/cells/${f.oldCellId}/replacement`, "POST", f.body());
        expect(response.status).toBe(200);
        const result = ReplacementRecord.parse(await response.json());
        expect(result.phase).toBe("ready");
        if (!result.newCellId) throw new Error("fixture ready receipt has no candidate");
        id = result.newCellId;
      }
      const record = f.store.get(id);
      if (!record) throw new Error("fixture computer record missing");
      expect(f.cells.get(id)?.state).toBe("ready");
      expect(f.cells.endpoints(id)).toBeDefined();
      expect(f.fake.state.containers.delete(record.docker.desktop)).toBe(true);
      const deadline = Date.now() + 250;
      while (f.cells.get(id)?.state === "ready" && Date.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect({ state: f.cells.get(id)?.state, hasEndpoint: !!f.cells.endpoints(id) }).toEqual({
        state: "failed",
        hasEndpoint: false,
      });
    },
    5000,
  );
  it.each(["held-republish", "recovered"] as const)(
    "supervises %s Ready after its former watcher exits",
    async (mode) => {
      const f = await fixture();
      await f.fence();
      const body = f.body();
      const result = ReplacementRecord.parse(
        await (await f.request(`/api/cells/${f.oldCellId}/replacement`, "POST", body)).json(),
      );
      if (!result.newCellId) throw new Error("verified candidate required");
      const id = result.newCellId,
        record = f.store.get(id);
      if (!record) throw new Error("owned computer record missing");
      f.cells.holdReplacement(id);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(f.cells.endpoints(id)).toBeUndefined();
      if (mode === "recovered") {
        const cold = createReplacementController({
          home: f.home,
          fences: new ComputerFences(f.home),
          runner: f.runner,
          cells: f.cells,
          tickets: f.tickets,
        });
        await cold.owner.start();
        expect(await cold.owner.status(f.oldCellId, body.requestId)).toEqual(result);
      } else {
        expect(await f.cells.inspectReplacement(id)).toBe("ready");
        f.cells.publishReplacement(id);
        f.cells.publishReplacement(id);
      }
      expect(f.cells.endpoints(id)).toBeDefined();
      expect(f.fake.state.containers.delete(record.docker.desktop)).toBe(true);
      await until(() => f.cells.get(id)?.state === "failed");
      expect(f.cells.endpoints(id)).toBeUndefined();
    },
  );
});
