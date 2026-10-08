import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { prepareOwnedCodexRoots } from "@localdot/codex-harness";
import { CAREFUL_AUTONOMY, msToMicros, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../../cells/types.ts";
import { DesktopdRegistry } from "../../desktopd/registry.ts";
import { FakeDesktopd } from "../../desktopd/testing/fake-desktopd.ts";
import { FrameStore } from "../../gateway/frames.ts";
import { ActionGateway } from "../../gateway/gateway.ts";
import { DEFAULT_ONSET_TABLE } from "../../gateway/onset-table.ts";
import { keepPolicy } from "../../gateway/ring-onset.ts";
import { CODEX_DONE, CodexDriver } from "../codex/driver.ts";
import { type McpEndpoint, openMcpEndpoint } from "../codex/mcp-endpoint.ts";
import type { NativePauseReceipt } from "../codex/native-pause.ts";
import { deferred, fakeCodex, until } from "../codex/testing/fake-codex.ts";
import { actPolicy } from "../policy.ts";
import { redactor } from "../redact.ts";
import { toolHarness } from "../testing/harness.ts";
import { dispatchTool } from "../tools/index.ts";
import { SafetyController } from "./controller.ts";

const owned: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of owned.splice(0)) await close();
  vi.restoreAllMocks();
});
function client(path: string) {
  const socket = connect(path);
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  let buffer = "",
    next = 0;
  socket.on("error", () => {});
  socket.on("data", (bytes) => {
    buffer += bytes.toString();
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ready = async () => {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "native-pause-fixture", version: "1" },
    });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  };
  const call = (args: unknown) => request("tools/call", { name: "computer", arguments: args });
  return { socket, ready, call, request };
}
function fixture() {
  const h = toolHarness({ autonomy: { ...CAREFUL_AUTONOMY, send: "act" } });
  const initial = h.session.generation;
  assert.ok(initial);
  h.session.retireBrain(initial);
  const root = mkdtempSync("/tmp/ld-native-pause-");
  mkdirSync(join(root, "user"), { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(root, "ld"), join(root, "user"));
  const fake = fakeCodex();
  const desktop = new FakeDesktopd({
    focused: () => ({
      target: {
        point: { x: 20, y: 40 },
        bbox: { x: 10, y: 20, w: 40, h: 40 },
        source: "ax",
        role: "textbox",
        name: "Notes",
        app: "Editor",
        window: "Notes",
        mark: 1,
        secret: false,
      },
      window: 77,
      ms: 1,
    }),
  });
  const stage: {
    typing?: ReturnType<typeof deferred<void>>;
    input?: ReturnType<typeof deferred<void>>;
    entered: boolean;
  } = { entered: false };
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    ).pathname;
    const response = await desktop.fetchImpl(input, init);
    if (path === "/type" && stage.typing) {
      stage.entered = true;
      await stage.typing.promise;
    }
    if (path === "/input" && stage.input) {
      stage.entered = true;
      await stage.input.promise;
    }
    return response;
  };
  let now = 10_000_000;
  const cells = new FakeOrchestrator();
  const registry = new DesktopdRegistry(cells, { nowMicros: () => now }, fetcher);
  cells.emit({
    id: h.session.cellId,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-04T00:00:00Z",
    stream: { ...NO_STREAM, connection: "live", viewers: 1 },
  });
  cells.endpointsById.set(h.session.cellId, {
    desktopd: { baseUrl: "http://127.0.0.1:1", token: desktop.token },
    stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic fixture" },
  });
  h.tools.gateway = new ActionGateway({
    eventLog: h.eventLog,
    cells,
    registry,
    onset: DEFAULT_ONSET_TABLE,
    ringOnset: keepPolicy(DEFAULT_ONSET_TABLE),
    frames: new FrameStore(h.home),
    now: () => now,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      now += msToMicros(ms);
      await new Promise<void>((r) => setImmediate(r));
      signal?.throwIfAborted();
    },
  });
  const endpoints: McpEndpoint[] = [],
    sockets: Socket[] = [],
    calls: string[] = [];
  const driver = new CodexDriver({
    auth: fake.auth,
    transcripts: h.transcripts,
    instructions: () => "Only localdot tools.",
    heartbeatMs: 5,
    observe: async () => ({
      frameId: ulid(),
      full: true,
      png: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
    openEndpoint: async (input) => {
      const endpoint = await openMcpEndpoint({
        ...input,
        roots,
        dispatch: (name, id, args, context) => {
          calls.push(name);
          if (name === "computer" && (args as { action?: unknown }).action === "type") {
            // Synthetic already-admitted typing pins retirement/drain only. Production ordinary
            // typing still requires takeover and is separately covered at its permission boundary.
            return h.session.runAtomic(context.generation, context.signal, async () => {
              const lease = h.session.admit(context.generation, context.signal);
              try {
                const entry = registry.for(h.session.cellId);
                assert.ok(entry);
                const client = entry.client;
                await client.type(
                  {
                    text: (args as { text: string }).text,
                    masked: false,
                    injector: "xtest",
                    pace: { firstMs: 0, firstCount: 0, restMs: 0 },
                  },
                  () => {},
                  lease.signal,
                );
                lease.check();
                return {
                  status: 200 as const,
                  result: {
                    ok: true,
                    content: [{ type: "text" as const, text: "Finite synthetic typing settled." }],
                  },
                };
              } finally {
                lease.finish();
              }
            });
          }
          return dispatchTool(
            { tools: h.tools, policy: actPolicy },
            h.session,
            name,
            id,
            args,
            redactor([]),
            context.generation,
            context.signal,
          );
        },
      });
      endpoints.push(endpoint);
      return endpoint;
    },
  });
  let receipt: NativePauseReceipt | undefined;
  const persisted: unknown[] = [];
  const persist = vi.fn((pause: unknown) => {
    persisted.push(pause);
  });
  const contained = vi.fn(async () => {
    h.session.stop();
  });
  const control = new SafetyController(h.session, {
    mode: "native",
    owner: () => undefined,
    ready: () => {},
    modelAdmission: async () => {
      throw new Error("native must not call keyd model admission");
    },
    setModelAdmission: async () => {
      throw new Error("native must not call keyd model admission");
    },
    persist,
    sleep: async () => {},
    native: {
      pause: async (pause) => {
        receipt = await driver.pauseAtBoundary(h.session, pause);
        return receipt;
      },
      resume: (pause, value) => driver.resumeAtBoundary(h.session, pause, value),
      contain: contained,
    },
  });
  let running: Promise<number> | undefined;
  const run = () => {
    running = driver.run(h.session, { model: "gpt-6-astra", resume: false });
    void running.catch(() => {});
    return running;
  };
  const active = async (count = 1) => {
    const process = await fake.nextLaunch(count);
    await process.waitFor("turn/start");
    const endpoint = endpoints[count - 1];
    assert.ok(endpoint);
    const c = client(endpoint.socket);
    sockets.push(c.socket);
    await c.ready();
    return { process, c };
  };
  const effects = () =>
    desktop.calls.filter((row) => row.path === "/input" || row.path === "/type");
  owned.push(async () => {
    stage.typing?.resolve();
    stage.input?.resolve();
    h.session.stop();
    for (const socket of sockets) socket.destroy();
    await running?.catch(() => {});
    for (const endpoint of endpoints) await endpoint.close();
    registry.dispose();
    h.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    h,
    session: h.session,
    fake,
    stage,
    driver,
    control,
    run,
    active,
    effects,
    calls,
    endpoints,
    contained,
    persist,
    persisted,
    receipt: () => receipt,
    running: () => running,
  };
}

describe("native Pause uses settled calls and retired turn owners", () => {
  it("waits for active MCP typing and refuses queued input before a lease; a late completion leaves Pause held", async () => {
    const f = fixture();
    f.run();
    const { process, c } = await f.active();
    f.stage.typing = deferred<void>();
    const typing = c.call({ action: "type", text: "finite local notes" });
    await until(() => f.stage.entered);
    const queued = c.call({ action: "key", keys: ["A"] });
    await c.request("tools/list", {});
    const pause = f.control.request(ulid());
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(f.effects()).toHaveLength(1);
    expect(f.session.safetyPause?.phase).toBe("pausing");
    expect(f.session.safetyPause?.resumeAvailable).toBe(false);
    process.complete();
    f.session.post("followup", "continue please");
    expect(f.fake.launches).toHaveLength(1);
    f.stage.typing.resolve();
    await typing;
    await queued;
    await f.control.settled();
    expect(f.effects()).toHaveLength(1);
    expect(f.calls).toEqual(["computer"]);
    expect(f.session.safetyPause).toMatchObject({
      requestId: pause.requestId,
      phase: "paused",
      atStepBoundary: true,
      resumeAvailable: true,
    });
    expect(f.receipt()).toMatchObject({
      turnRetired: true,
      callsSettled: true,
      resultOwnershipConfirmed: true,
      completedCalls: 1,
    });
    expect(f.fake.activeLeases).toBe(0);
    expect(process.stopped).toBe(true);
    expect(f.contained).not.toHaveBeenCalled();
    await f.control.resume(pause.requestId, pause.revision);
    const next = await f.active(2);
    expect(f.effects()).toHaveLength(1);
    expect(f.session.safetyPause).toBeUndefined();
    await expect(f.control.resume(pause.requestId, pause.revision)).rejects.toThrow();
    expect(next.process.requests.find((row) => row.method === "turn/start")?.params).toBeTruthy();
    f.session.stop();
    expect(await f.running()).toBe(CODEX_DONE);
  }, 8000);
  it("an approved production MCP key settles before native Pause retires its process", async () => {
    const f = fixture();
    f.run();
    const { c, process } = await f.active();
    process.requestHook = (method) => {
      if (method !== "turn/interrupt") return undefined;
      process.complete("interrupted");
      return Promise.resolve({});
    };
    f.stage.input = deferred<void>();
    const input = c.call({ action: "key", keys: ["A"] });
    await until(() => f.stage.entered);
    const pause = f.control.request(ulid());
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(f.effects()).toHaveLength(1);
    expect(f.session.safetyPause?.atStepBoundary).toBe(false);
    expect(process.stopped).toBe(false);
    f.stage.input.resolve();
    await input;
    await f.control.settled();
    expect(f.receipt()?.completedCalls).toBe(1);
    expect(f.session.safetyPause).toMatchObject({
      requestId: pause.requestId,
      phase: "paused",
      resumeAvailable: true,
    });
    expect(f.effects()).toHaveLength(1);
    expect(process.stopped).toBe(true);
  }, 8000);
  it.each(["signed_out", "changed_auth"] as const)(
    "%s while paused cannot restore the old credential lease",
    async (kind) => {
      const f = fixture();
      f.run();
      await f.active();
      const pause = f.control.request(ulid());
      await f.control.settled();
      expect(f.session.safetyPause?.resumeAvailable).toBe(true);
      if (kind === "signed_out") f.fake.setSignedIn(false);
      else f.fake.changeAuth();
      await expect(f.control.resume(pause.requestId, pause.revision)).rejects.toThrow();
      expect(f.fake.launches).toHaveLength(1);
      expect(f.fake.activeLeases).toBe(0);
      expect(f.effects()).toHaveLength(0);
      expect(f.session.safetyPause?.resumeAvailable).toBe(false);
      expect(f.contained).toHaveBeenCalledTimes(1);
    },
    8000,
  );
  it("lost active call reply contains the computer and cannot advertise Resume", async () => {
    const f = fixture();
    f.run();
    const { c } = await f.active();
    f.stage.typing = deferred<void>();
    void c.call({ action: "type", text: "finite uncertain reply" });
    await until(() => f.stage.entered);
    const pause = f.control.request(ulid());
    c.socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 20));
    f.stage.typing.resolve();
    await f.control.settled();
    expect(f.effects()).toHaveLength(1);
    expect(f.session.safetyPause).toMatchObject({
      requestId: pause.requestId,
      phase: "uncertain",
      resumeAvailable: false,
    });
    expect(f.contained).toHaveBeenCalledTimes(1);
    expect(f.receipt()).toBeUndefined();
    await expect(f.control.resume(pause.requestId, pause.revision)).rejects.toThrow();
    expect(f.fake.launches).toHaveLength(1);
  }, 8000);
  it("pending credential admission must settle before Pause can be confirmed", async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.fake.acquireGate = gate.promise;
    const acquiring = vi.spyOn(f.fake.auth, "acquireTask");
    f.run();
    await until(() => acquiring.mock.calls.length === 1);
    const pause = f.control.request(ulid());
    await new Promise<void>((r) => setTimeout(r, 15));
    expect(f.session.safetyPause?.resumeAvailable).toBe(false);
    expect(f.fake.launches).toHaveLength(0);
    gate.resolve();
    await f.control.settled();
    expect(f.session.safetyPause?.phase).toBe("paused");
    expect(f.fake.activeLeases).toBe(0);
    await f.control.resume(pause.requestId, pause.revision);
    await f.active();
    expect(f.effects()).toHaveLength(0);
  }, 8000);
  it("an unknown process closure stays uncertain and contains through Stop", async () => {
    const f = fixture();
    f.run();
    const { process } = await f.active();
    const closed = deferred<void>();
    process.stopGate = closed.promise;
    f.control.request(ulid());
    await f.control.settled();
    expect(f.session.safetyPause?.resumeAvailable).toBe(false);
    expect(f.contained).toHaveBeenCalledTimes(1);
    expect(f.receipt()).toBeUndefined();
    closed.resolve();
  }, 8000);
  it("a copied private receipt cannot authorize native Resume", async () => {
    const f = fixture();
    f.run();
    await f.active();
    const pause = f.control.request(ulid());
    await f.control.settled();
    const receipt = f.receipt();
    assert.ok(receipt);
    f.session.beginSafetyResume(pause.requestId, pause.revision);
    await expect(f.driver.resumeAtBoundary(f.session, pause, { ...receipt })).rejects.toThrow();
    expect(f.fake.activeLeases).toBe(0);
    expect(f.fake.launches).toHaveLength(1);
    await f.driver.resumeAtBoundary(f.session, pause, receipt);
    f.session.resumeSafety(pause.requestId, pause.revision);
    await f.active(2);
    await expect(f.driver.resumeAtBoundary(f.session, pause, receipt)).rejects.toThrow();
    expect(f.effects()).toHaveLength(0);
  }, 8000);
  it("failed clearing of durable Pause intent never admits another native turn", async () => {
    const f = fixture();
    f.run();
    await f.active();
    const pause = f.control.request(ulid());
    await f.control.settled();
    f.persist.mockImplementation((value) => {
      if (value === undefined) throw new Error("fixture persistence failed");
    });
    await expect(f.control.resume(pause.requestId, pause.revision)).rejects.toThrow();
    expect(f.fake.launches).toHaveLength(1);
    expect(f.effects()).toHaveLength(0);
    expect(f.session.safetyPause?.resumeAvailable).toBe(false);
    expect(f.contained).toHaveBeenCalledTimes(1);
  }, 8000);
});
