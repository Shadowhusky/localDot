import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
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
import { CodexDriver } from "../codex/driver.ts";
import { type McpEndpoint, openMcpEndpoint } from "../codex/mcp-endpoint.ts";
import type { NativePauseReceipt } from "../codex/native-pause.ts";
import { type deferred, fakeCodex } from "../codex/testing/fake-codex.ts";
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
  const root = mkdtempSync(
    join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ld-nr-"),
  );
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

describe("native repeated-input recovery ownership", () => {
  it("returns recovery to the same native turn, which can inspect and change approach without an ask", async () => {
    const f = fixture();
    f.run();
    const first = await f.active();
    for (let i = 0; i < 2; i++) await first.c.call({ action: "key", keys: ["ARROWDOWN"] });
    const blocked = await first.c.call({ action: "key", keys: ["ARROWDOWN"] });
    expect(JSON.stringify(blocked)).toContain("without verified progress");
    expect(f.effects()).toHaveLength(2);
    expect(f.session.safetyPause).toBeUndefined();
    expect(f.session.pendingAsk).toBeUndefined();
    expect(f.receipt()).toBeUndefined();
    await first.c.call({ action: "screenshot" });
    await first.c.call({ action: "key", keys: ["ARROWUP"] });
    expect(f.effects()).toHaveLength(3);
    expect(f.fake.launches).toHaveLength(1);
    expect(f.h.events().filter((row) => row.type === "ask.request")).toHaveLength(0);
  }, 8000);

  it("bounds ignored recovery attempts, and preserves a follow-up across explicit Resume", async () => {
    const f = fixture();
    f.run();
    const first = await f.active();
    for (let i = 0; i < 5; i++) await first.c.call({ action: "key", keys: ["ARROWDOWN"] });
    await f.control.settled();
    const pause = f.session.safetyPause;
    assert.ok(pause);
    expect(f.effects()).toHaveLength(2);
    expect(pause).toMatchObject({
      phase: "paused",
      reason: "repeated_action",
      resumeAvailable: true,
    });
    expect(f.session.pendingAsk).toBeUndefined();
    expect(f.h.events().filter((row) => row.type === "ask.request")).toHaveLength(0);
    const correction = "Select the Help menu instead.";
    f.session.post("followup", correction);
    expect(f.fake.launches).toHaveLength(1);
    expect(f.session.safetyPause?.requestId).toBe(pause.requestId);
    await f.control.resume(pause.requestId, pause.revision);
    const second = await f.active(2);
    expect(
      JSON.stringify(second.process.requests.find((row) => row.method === "turn/start")?.params),
    ).toContain(correction);
    expect(
      f.h.transcripts
        .read(f.session.id)
        .filter((row) => row.role === "user" && row.content === correction),
    ).toHaveLength(1);
    expect(f.effects()).toHaveLength(2);
  }, 8000);

  it("a real user Pause still requires explicit Resume and delivers its follow-up once", async () => {
    const f = fixture();
    f.run();
    await f.active();
    const pause = f.control.request(ulid());
    await f.control.settled();
    const correction = "Use the Help menu on this explicit follow-up.";
    f.session.post("followup", correction);
    expect(f.fake.launches).toHaveLength(1);
    await f.control.resume(pause.requestId, pause.revision);
    const next = await f.active(2);
    expect(
      JSON.stringify(next.process.requests.find((row) => row.method === "turn/start")?.params),
    ).toContain(correction);
    expect(
      f.h.transcripts
        .read(f.session.id)
        .filter((row) => row.role === "user" && row.content === correction),
    ).toHaveLength(1);
    expect(f.effects()).toHaveLength(0);
  }, 8000);

  it("Stop while the model is recovering closes the native endpoint without another physical effect", async () => {
    const f = fixture();
    f.run();
    const first = await f.active();
    for (let i = 0; i < 3; i++) await first.c.call({ action: "key", keys: ["ARROWDOWN"] });
    expect(f.session.safetyPause).toBeUndefined();
    f.session.stop();
    await f.running()?.catch(() => {});
    expect(f.endpoints[0]?.connections()).toBe(0);
    expect(f.fake.launches).toHaveLength(1);
    expect(f.effects()).toHaveLength(2);
  }, 8000);

  it("a failed pause journal after exhausted recovery cannot advertise Resume", async () => {
    const f = fixture();
    f.run();
    const first = await f.active();
    f.persist.mockImplementation(() => {
      throw new Error("journal unavailable");
    });
    for (let i = 0; i < 5; i++) await first.c.call({ action: "key", keys: ["ARROWDOWN"] });
    await f.control.settled();
    const pause = f.session.safetyPause;
    assert.ok(pause);
    expect(pause.resumeAvailable).toBe(false);
    await expect(f.control.resume(pause.requestId, pause.revision)).rejects.toThrow();
    expect(f.session.pendingAsk).toBeUndefined();
    expect(f.effects()).toHaveLength(2);
  }, 8000);
});
