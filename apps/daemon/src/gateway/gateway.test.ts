import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventOf,
  type HitTestResult,
  type LocalDotEvent,
  msToMicros,
  type Point,
  sessionMsOf,
  ulid,
} from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM, type StreamState } from "../cells/types.ts";
import type { Clock } from "../clock.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import { ClockMap } from "../desktopd/clock-map.ts";
import { DesktopdRegistry } from "../desktopd/registry.ts";
import { FakeDesktopd, type FakeScript } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "./frames.ts";
import {
  type ActionContext,
  ActionGateway,
  type NativeActionIdentity,
  type NativeActionRequest,
  type NativeScreenBinding,
} from "./gateway.ts";
import { DEFAULT_ONSET_TABLE } from "./onset-table.ts";
import { keepPolicy } from "./ring-onset.ts";

function fakeClock(start = 10_000_000): Clock & { advance(us: number): void } {
  let now = start;
  return {
    nowMicros: () => now,
    advance: (us) => {
      now += us;
    },
  };
}

function setup(
  script: FakeScript = {},
  opts: { viewers?: number; scale?: 1 | 2; heldButtonMs?: number } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "local dot's gateway-"));
  const clock = fakeClock();
  const eventLog = new EventLog(home, clock);
  const cells = new FakeOrchestrator();
  const fake = new FakeDesktopd(script);
  const registry = new DesktopdRegistry(cells, clock, fake.fetchImpl);
  const cellId = ulid();
  cells.emit({
    id: cellId,
    state: "ready",
    scale: opts.scale ?? 2,
    createdAt: new Date().toISOString(),
    stream: {
      ...NO_STREAM,
      connection: (opts.viewers ?? 1) > 0 ? "live" : "none",
      viewers: opts.viewers ?? 1,
    },
  });
  cells.endpointsById.set(cellId, {
    desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token },
    stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
  });
  const sleeps: number[] = [];
  const gateway = new ActionGateway({
    eventLog,
    cells,
    registry,
    onset: DEFAULT_ONSET_TABLE,
    ringOnset: keepPolicy(DEFAULT_ONSET_TABLE),
    frames: new FrameStore(home),
    now: () => clock.nowMicros(),
    // Advances the fake clock, then yields one macrotask so a hit test that started beside the
    // travel resolves before the dispatch, as it does with real timers.
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      clock.advance(msToMicros(ms));
      await new Promise((r) => setImmediate(r));
    },
    hitTestTimeoutMs: 2500,
    ...(opts.heldButtonMs ? { heldButtonMs: opts.heldButtonMs } : {}),
  });
  const sessionId = eventLog.createSession("test");
  const events = () => eventLog.read(sessionId);
  const ofType = <T extends LocalDotEvent["type"]>(type: T) =>
    events().filter((e): e is EventOf<T> => e.type === type);
  return {
    home,
    clock,
    eventLog,
    cells,
    fake,
    registry,
    cellId,
    sessionId,
    gateway,
    sleeps,
    events,
    ofType,
  };
}

const search = (point = { x: 300, y: 400 }) => ({
  target: {
    point,
    bbox: { x: 280, y: 380, w: 40, h: 40 },
    source: "ax" as const,
    role: "button",
    name: "Search",
    app: "Chromium",
    window: "Example",
  },
  window: 77,
  ms: 12,
});

function boundScreen(s: ReturnType<typeof setup>) {
  const fake = new FakeDesktopd({ hitTest: (point) => ({ ...search(point), window: null }) });
  const client = new DesktopdClient(
    { baseUrl: "http://127.0.0.1:3", token: fake.token },
    fake.fetchImpl,
  );
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  let stream: StreamState = {
    ...NO_STREAM,
    connection: "live" as const,
    viewers: 1,
  };
  const screen: NativeScreenBinding = {
    cellId: ulid(),
    parentCellId: s.cellId,
    scale: 2,
    device: {
      client,
      clocks: new ClockMap(
        async () => (await client.clock()).mono,
        () => s.clock.nowMicros(),
      ),
    },
    signal: abort.signal,
    check: () => abort.signal.throwIfAborted(),
    stream: () => stream,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const ctx: ActionContext = {
    source: "agent",
    sessionId: s.sessionId,
    cellId: screen.cellId,
    screen,
    authorizeAgent: async () => ({ consume: () => true }),
    beforeEffect: () => true,
  };
  return {
    fake,
    abort,
    screen,
    ctx,
    listeners,
    update: (patch: Partial<typeof stream>) => {
      stream = { ...stream, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

describe("ActionGateway admitted screen binding", () => {
  it("routes a browser action to its bound device and uses its stream and scale", async () => {
    const s = setup({}, { scale: 1 }),
      b = boundScreen(s);
    s.cells.updateStream(s.cellId, { connection: "stalled" });
    const authorize = vi.fn(b.ctx.authorizeAgent!);
    const result = await s.gateway.run(
      { ...b.ctx, authorizeAgent: authorize },
      { verb: "click", point: { x: 120, y: 80 }, speed: "instant" },
    );
    expect(result).toMatchObject({ ok: true });
    expect(authorize).toHaveBeenCalledOnce();
    expect(s.fake.calls).toHaveLength(0);
    expect(b.fake.calls.filter((c) => c.path === "/input").at(-1)?.body).toMatchObject({
      input: { kind: "click", at: { x: 240, y: 160 } },
    });
    expect(s.gateway.cursorOf(b.screen.cellId)).toEqual({ x: 240, y: 160 });
    s.registry.dispose();
    s.eventLog.close();
  });

  it.each(["denied", "revoked", "changed", "parent-fenced", "effect-paused"] as const)(
    "refuses %s approval before physical input",
    async (mode) => {
      const s = setup(),
        b = boundScreen(s);
      if (mode === "effect-paused") b.ctx.beforeEffect = () => false;
      b.ctx.authorizeAgent = async () => {
        if (mode === "denied") return undefined;
        if (mode === "revoked") b.abort.abort();
        if (mode === "changed")
          b.fake.script.hitTest = (point) => ({
            ...search(point),
            target: { ...search(point).target, name: "Different action" },
            window: null,
          });
        if (mode === "parent-fenced")
          s.cells.emit({ ...s.cells.get(s.cellId)!, fenced: { revision: 1 } });
        return { consume: () => true };
      };
      const result = await s.gateway.run(b.ctx, {
        verb: "click",
        point: { x: 120, y: 80 },
        speed: "instant",
      });
      expect(result.ok).toBe(false);
      expect(b.fake.calls.filter((c) => c.path === "/input")).toHaveLength(0);
      expect(s.fake.calls).toHaveLength(0);
      s.registry.dispose();
      s.eventLog.close();
    },
  );

  it.each(["live", "lease-aborted", "parent-paused"] as const)(
    "waits on the browser stream and handles %s",
    async (end) => {
      const s = setup(),
        b = boundScreen(s);
      const baseListeners = s.cells.listeners.size;
      b.update({ connection: "stalled" });
      const running = s.gateway.run(b.ctx, {
        verb: "click",
        point: { x: 120, y: 80 },
        speed: "instant",
      });
      for (let i = 0; i < 100 && b.listeners.size === 0; i++)
        await new Promise((r) => setImmediate(r));
      expect(b.listeners.size).toBe(1);
      expect(b.fake.calls.filter((c) => c.path === "/input")).toHaveLength(0);
      if (end === "live") b.update({ connection: "live" });
      if (end === "lease-aborted") b.abort.abort();
      if (end === "parent-paused") s.cells.emit({ ...s.cells.get(s.cellId)!, paused: true });
      const result = await running;
      expect(result.ok).toBe(end === "live");
      expect(b.listeners.size).toBe(0);
      expect(s.cells.listeners.size).toBe(baseListeners);
      s.registry.dispose();
      s.eventLog.close();
    },
  );

  it("refuses a physical cell mismatch and a late screenshot from a revoked screen", async () => {
    const s = setup(),
      b = boundScreen(s);
    expect(
      (await s.gateway.run({ ...b.ctx, cellId: s.cellId }, { verb: "key", combo: ["ENTER"] })).ok,
    ).toBe(false);
    const waiting = Promise.withResolvers<Awaited<ReturnType<DesktopdClient["observe"]>>>();
    let observingStarted = false;
    b.screen.device.client.observe = () => {
      observingStarted = true;
      return waiting.promise;
    };
    const observing = s.gateway.observe(b.ctx);
    for (let i = 0; i < 100 && !observingStarted; i++) await new Promise((r) => setImmediate(r));
    expect(observingStarted).toBe(true);
    b.abort.abort();
    waiting.resolve({
      frameId: ulid(),
      width: 1280,
      height: 800,
      image: "",
      pointer: { x: 0, y: 0 },
      windows: [],
    });
    await expect(observing).rejects.toThrow();
    expect(s.ofType("observe")).toHaveLength(0);
    s.registry.dispose();
    s.eventLog.close();
  });
});

describe("ActionGateway click", () => {
  it("emits intent → target → dispatch → settle → observe → result with the timing contract", async () => {
    const s = setup({
      hitTest: () => search(),
      settle: () => ({
        changed: [{ x: 1, y: 2, w: 3, h: 4 }],
        lastChangeMono: 50_010,
        quiet: true,
        noVisibleChange: false,
      }),
    });
    const outcome = await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId, step: "s1" },
      { verb: "click", point: { x: 150, y: 200 }, label: "Click the search box" },
    );
    expect(outcome.ok).toBe(true);
    // The target may land before or after the dispatch (S2: hit tests can outlast the travel).
    const types = s.events().map((e) => e.type);
    expect(types[0]).toBe("action.intent");
    expect(types).toContain("action.target");
    expect(types.filter((t) => t !== "action.target")).toEqual([
      "action.intent",
      "action.dispatch",
      "screen.settle",
      "observe",
      "action.result",
    ]);
    const [intent] = s.ofType("action.intent");
    const [dispatch] = s.ofType("action.dispatch");
    if (!intent || !dispatch) throw new Error("missing events");
    expect(intent.data).toMatchObject({
      verb: "click",
      label: "Click the search box",
      point: { x: 300, y: 400 },
      risk: "none",
    });
    expect(intent.step).toBe("s1");
    const plan = intent.data.pointer;
    if (!plan) throw new Error("no plan");
    expect(plan.curve).toBe("minjerk-bow-v1");
    expect(plan.to).toEqual({ x: 300, y: 400 });
    expect(plan.startsAt).toBe(Math.round(sessionMsOf(intent)) + 120);
    const distance = Math.hypot(plan.to.x - plan.from.x, plan.to.y - plan.from.y);
    expect(plan.durationMs).toBeCloseTo(
      Math.min(700, Math.max(220, 150 + 100 * Math.log2(distance / 48 + 1))),
      6,
    );
    // The press happens after travel + 90 ms dwell: the sleeps add up to lead + travel + dwell.
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(120 + plan.durationMs + 90, 3);
    expect(dispatch.data).toMatchObject({
      input: { kind: "click", button: "left", count: 1, at: { x: 300, y: 400 } },
      injector: "xtest",
    });
    expect(dispatch.data.ringAt - dispatch.data.pressT).toBe(23_100);
    expect(dispatch.data.pressT).toBeLessThanOrEqual(dispatch.t);
    expect(s.fake.calls.find((c) => c.path === "/input")?.body).toMatchObject({
      window: 77,
      injector: "xtest",
    });
    const [settle] = s.ofType("screen.settle");
    expect(settle?.data).toMatchObject({
      changed: [{ x: 1, y: 2, w: 3, h: 4 }],
      noVisibleChange: false,
    });
    const [observe] = s.ofType("observe");
    expect(
      existsSync(join(s.home, "sessions", s.sessionId, "frames", `${observe?.data.frameId}.webp`)),
    ).toBe(true);
    expect(outcome.frameId).toBe(observe?.data.frameId);
    // The observe after the settle reports the pointer where the click landed; the gateway's
    // cursor (the next plan's `from`) follows it.
    expect(s.fake.pointer).toEqual({ x: 300, y: 400 });
    expect(s.gateway.cursorOf(s.cellId)).toEqual({ x: 300, y: 400 });
  });

  it("labels a find click by the element's name, truncates a 300-character name, names a point click by its coordinates and keeps the crosshair when the hit test is empty", async () => {
    // Only a `find` click knows its element before the intent; a point click's hit test runs
    // beside the travel, so its label is the coordinates.
    const long = {
      ...search(),
      target: { ...search().target, name: "n".repeat(300), window: "w".repeat(400) },
    };
    const s = setup({ find: () => long });
    await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "click", find: { name: "n".repeat(300) } },
    );
    const [intent] = s.ofType("action.intent");
    expect(intent?.data.label.length).toBe(80);
    expect(intent?.data.label.startsWith('Click "nnn')).toBe(true);
    expect(intent?.data.label.endsWith("…")).toBe(true);
    const [target] = s.ofType("action.target");
    expect(target?.data.target.name?.length).toBe(64);
    expect(target?.data.target.window?.length).toBe(256);

    const byPoint = setup({ hitTest: () => long });
    await byPoint.gateway.run(
      { source: "manual" as const, sessionId: byPoint.sessionId, cellId: byPoint.cellId },
      { verb: "click", point: { x: 1, y: 1 } },
    );
    expect(byPoint.ofType("action.intent")[0]?.data.label).toBe("Click at (2, 2)");
    expect(byPoint.ofType("action.target")[0]?.data.target.name?.length).toBe(64);

    const empty = setup({ hitTest: () => ({ target: null, window: null, ms: 3 }) });
    await empty.gateway.run(
      { source: "manual" as const, sessionId: empty.sessionId, cellId: empty.cellId },
      { verb: "click", point: { x: 10, y: 20 } },
    );
    expect(empty.ofType("action.target")).toHaveLength(0);
    expect(empty.ofType("action.intent")[0]?.data.label).toBe("Click at (20, 40)");
    expect(empty.fake.calls.find((c) => c.path === "/input")?.body).not.toHaveProperty("window");
  });

  it("dispatches at Fast with no viewer and never holds", async () => {
    const s = setup({ hitTest: () => search() }, { viewers: 0 });
    // A tab that closed while its stream was down leaves `disconnected` behind with no viewer.
    s.cells.updateStream(s.cellId, { connection: "disconnected" });
    const outcome = await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "click", point: { x: 150, y: 200 } },
    );
    expect(outcome.ok).toBe(true);
    const plan = s.ofType("action.intent")[0]?.data.pointer;
    expect(plan?.startsAt).toBe(
      Math.round(sessionMsOf(s.ofType("action.intent")[0] ?? { t: 0 })) + 60,
    );
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(60 + (plan?.durationMs ?? 0) + 45, 3);
  });

  it("instant: no travel, dispatch after 60 ms", async () => {
    const s = setup({ hitTest: () => search() });
    await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "click", point: { x: 150, y: 200 }, speed: "instant" },
    );
    expect(s.ofType("action.intent")[0]?.data.pointer?.durationMs).toBe(0);
    expect(s.sleeps).toEqual([60]);
  });

  it("holds dispatch while the stream is stalled and resumes on live", async () => {
    const s = setup({ hitTest: () => search() });
    s.cells.updateStream(s.cellId, { connection: "stalled" });
    const running = s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "click", point: { x: 150, y: 200 } },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(s.fake.calls.some((c) => c.path === "/input")).toBe(false);
    expect(s.events().map((e) => e.type)).toEqual(["action.intent", "action.target"]);
    s.cells.updateStream(s.cellId, { connection: "live" });
    const outcome = await running;
    expect(outcome.ok).toBe(true);
    expect(s.fake.calls.some((c) => c.path === "/input")).toBe(true);
  });

  it("finds a named target first and clicks its centre", async () => {
    const s = setup({ find: () => search({ x: 700, y: 468 }) });
    await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "click", find: { name: "Page two", role: "link" } },
    );
    expect(s.fake.calls[0]).toMatchObject({
      path: "/find",
      body: { name: "Page two", role: "link" },
    });
    expect(s.ofType("action.intent")[0]?.data.point).toEqual({ x: 700, y: 468 });
    expect(s.ofType("action.intent")[0]?.data.label).toBe('Click "Search"');
    expect(
      s
        .events()
        .map((e) => e.type)
        .slice(0, 2),
    ).toEqual(["action.intent", "action.target"]);
  });

  it("floors Fitts' target width at 16 px times the scale", async () => {
    const close = {
      target: {
        point: { x: 1200, y: 900 },
        bbox: { x: 1196, y: 896, w: 8, h: 8 },
        source: "ax" as const,
        name: "Close",
      },
      window: 77,
      ms: 3,
    };
    const s = setup({ find: () => close });
    await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "click", find: { name: "Close" } },
    );
    const plan = s.ofType("action.intent")[0]?.data.pointer;
    if (!plan) throw new Error("no plan");
    const distance = Math.hypot(plan.to.x - plan.from.x, plan.to.y - plan.from.y);
    expect(plan.durationMs).toBeCloseTo(
      Math.min(700, Math.max(220, 150 + 100 * Math.log2(distance / 32 + 1))),
      6,
    );
  });

  it("cancels with timeout when desktopd reports no press, and with preflight when find fails", async () => {
    const s = setup({
      hitTest: () => search(),
      input: () => ({ status: 504, body: "no raw press observed" }),
    });
    const outcome = await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "click", point: { x: 1, y: 1 } },
    );
    expect(outcome).toMatchObject({ ok: false, cancelled: "timeout" });
    expect(
      s
        .events()
        .map((e) => e.type)
        .filter((t) => t !== "action.target"),
    ).toEqual(["action.intent", "action.cancel"]);
    expect(s.ofType("action.cancel")[0]?.data).toMatchObject({ reason: "timeout" });

    const missing = setup({ find: () => ({ target: null, window: null, ms: 1 }) });
    const out2 = await missing.gateway.run(
      { source: "manual" as const, sessionId: missing.sessionId, cellId: missing.cellId },
      { verb: "click", find: { name: "Nope" } },
    );
    expect(out2).toMatchObject({ ok: false, cancelled: "preflight" });
    expect(missing.ofType("action.cancel")[0]?.data.detail).toContain("Nope");
  });

  it("cancels with user when aborted during travel", async () => {
    const s = setup({ hitTest: () => search() });
    const ac = new AbortController();
    const running = s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId, signal: ac.signal },
      { verb: "click", point: { x: 1, y: 1 } },
    );
    ac.abort();
    const outcome = await running;
    expect(outcome.cancelled).toBe("user");
    expect(s.ofType("action.cancel")[0]?.data.reason).toBe("user");
    expect(s.fake.calls.some((c) => c.path === "/input")).toBe(false);
  });
});

describe("ActionGateway type and key", () => {
  it("masks the focused password after Tab even when the cursor and custom label refer to plain text", async () => {
    const s = setup({
      hitTest: () => search(),
      focused: () => ({
        ...search(),
        target: { ...search().target, role: "textbox", secret: true },
      }),
      type: () => ({
        progress: [{ count: 7, chunk: "hunter2", pressMono: 60_000 }],
        result: {
          done: true,
          count: 7,
          firstPressMono: 60_000,
          injector: "xtest",
          armedMono: 59_000,
        },
      }),
    });
    const result = await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "type", text: "hunter2", label: "Type hunter2" },
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(s.events())).not.toContain("hunter2");
    expect(s.fake.calls.find((c) => c.path === "/type")?.body).toMatchObject({ masked: true });
  });

  it("masks text when keyboard focus cannot be classified", async () => {
    const s = setup({ focused: () => ({ target: null, window: null, ms: 1 }) });
    await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "type", text: "private-value", label: "private-value" },
    );
    expect(JSON.stringify(s.events())).not.toContain("private-value");
    expect(s.fake.calls.find((c) => c.path === "/type")?.body).toMatchObject({ masked: true });
  });

  it.each(["stopped", "paused"] as const)(
    "refuses actions when %s during target lookup",
    async (state) => {
      const s = setup({
        find: () => {
          const cell = s.cells.get(s.cellId);
          if (cell)
            s.cells.emit(state === "paused" ? { ...cell, paused: true } : { ...cell, state });
          return search();
        },
      });
      const ac = new AbortController();
      ac.abort();
      const ctx = {
        source: "manual" as const,
        sessionId: s.sessionId,
        cellId: s.cellId,
        signal: ac.signal,
      };
      expect((await s.gateway.run(ctx, { verb: "key", combo: ["Return"] })).ok).toBe(false);
      expect(
        (
          await s.gateway.run(
            { ...ctx, signal: undefined },
            { verb: "click", find: { name: "Search" } },
          )
        ).ok,
      ).toBe(false);
      expect(s.fake.calls.some((c) => c.path === "/input")).toBe(false);
    },
  );

  it("masks a secret field end to end", async () => {
    const s = setup({
      hitTest: () => ({
        target: {
          point: { x: 100, y: 100 },
          bbox: { x: 80, y: 90, w: 200, h: 30 },
          source: "dom",
          role: "textbox",
          name: "Password",
          secret: true,
        },
        window: 9,
        ms: 5,
      }),
      type: () => ({
        progress: [
          { count: 3, pressMono: 60_000 },
          { count: 7, pressMono: 60_300 },
        ],
        result: {
          done: true,
          count: 7,
          firstPressMono: 59_900,
          injector: "xtest",
          armedMono: 59_000,
        },
      }),
    });
    const outcome = await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "type", text: "hunter2" },
    );
    expect(outcome.ok).toBe(true);
    expect(s.events().map((e) => e.type)).toEqual([
      "action.intent",
      "action.target",
      "action.dispatch",
      "text.progress",
      "text.progress",
      "screen.settle",
      "observe",
      "action.result",
    ]);
    expect(s.ofType("action.intent")[0]?.data.label).toBe("Type 7 characters");
    expect(s.ofType("action.dispatch")[0]?.data.input).toEqual({
      kind: "type",
      chars: 7,
      masked: true,
    });
    expect(s.ofType("text.progress").map((e) => e.data)).toEqual([
      { count: 3, masked: true },
      { count: 7, masked: true },
    ]);
    expect(JSON.stringify(s.events())).not.toContain("hunter2");
    expect(s.fake.calls.find((c) => c.path === "/type")?.body).toMatchObject({
      masked: true,
      pace: { firstMs: 35, firstCount: 60, restMs: 6 },
    });
  });

  it("types plain text with chunks, paced by the speed", async () => {
    const s = setup(
      {
        hitTest: () => ({ target: null, window: null, ms: 2 }),
        focused: () => search(),
        type: () => ({
          progress: [
            { count: 1, chunk: "h", pressMono: 60_000 },
            { count: 2, chunk: "i", pressMono: 60_040 },
          ],
          result: {
            done: true,
            count: 2,
            firstPressMono: 60_000,
            injector: "xtest",
            armedMono: 59_000,
          },
        }),
      },
      { viewers: 0 },
    );
    await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "type", text: "hi" },
    );
    expect(s.ofType("text.progress").map((e) => e.data)).toEqual([
      { count: 1, chunk: "h", masked: false },
      { count: 2, chunk: "i", masked: false },
    ]);
    expect(s.fake.calls.find((c) => c.path === "/type")?.body).toMatchObject({
      pace: { firstMs: 8, firstCount: 60, restMs: 8 },
    });
    const dispatch = s.ofType("action.dispatch")[0];
    expect((dispatch?.data.ringAt ?? 0) - (dispatch?.data.pressT ?? 0)).toBe(29_300);
  });

  it("a Stop mid-typing ends the typing itself", async () => {
    const s = setup({
      hitTest: () => ({ target: null, window: null, ms: 2 }),
      type: () => ({
        progress: [{ count: 1, chunk: "h", pressMono: 60_000 }],
        result: {
          done: true,
          count: 40,
          firstPressMono: 60_000,
          injector: "xtest",
          armedMono: 59_000,
        },
      }),
      typeHolds: true,
    });
    const stop = new AbortController();
    const running = s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId, signal: stop.signal },
      { verb: "type", text: "h".repeat(40) },
    );
    await vi.waitFor(() => expect(s.ofType("text.progress")).toHaveLength(1));
    stop.abort();
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    expect(s.events().map((e) => e.type)).toEqual([
      "action.intent",
      "action.dispatch",
      "text.progress",
      "action.result",
    ]);
  });

  it("presses a key combo with a readable label and a key onset", async () => {
    const s = setup();
    await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "key", combo: ["ctrl", "l"] },
    );
    expect(s.ofType("action.intent")[0]?.data).toMatchObject({
      verb: "key",
      label: "Press Ctrl+L",
    });
    expect(s.ofType("action.dispatch")[0]?.data.input).toEqual({
      kind: "key",
      combo: ["ctrl", "l"],
    });
    const dispatch = s.ofType("action.dispatch")[0];
    expect((dispatch?.data.ringAt ?? 0) - (dispatch?.data.pressT ?? 0)).toBe(29_300);
    expect(s.sleeps).toEqual([90]);
  });

  it("waits without touching the desktop", async () => {
    const s = setup();
    await s.gateway.run(
      { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId },
      { verb: "wait", ms: 500 },
    );
    expect(s.events().map((e) => e.type)).toEqual(["action.intent", "action.result"]);
    expect(s.sleeps).toEqual([500]);
    expect(s.fake.calls).toEqual([]);
  });
});

describe("ActionGateway keyboard", () => {
  function agentCtx(s: ReturnType<typeof setup>, signal?: AbortSignal) {
    return {
      source: "agent" as const,
      sessionId: s.sessionId,
      cellId: s.cellId,
      ...(signal ? { signal } : {}),
      authorizeAgent: vi.fn(async () => ({ consume: () => true })),
      beforeEffect: vi.fn(() => true),
      afterEffect: vi.fn(),
    };
  }
  const inputs = (s: ReturnType<typeof setup>) =>
    s.fake.calls
      .filter((c) => c.path === "/input")
      .map((c) => (c.body as { input: unknown }).input);
  let frames = 0;
  const frame = (image = `frame ${frames++}`) => ({
    frameId: ulid(),
    width: 1280,
    height: 800,
    image: Buffer.from(image).toString("base64"),
    pointer: { x: 0, y: 0 },
    windows: [],
  });
  const settled = (noVisibleChange: boolean) => ({
    changed: noVisibleChange ? [] : [{ x: 10, y: 10, w: 40, h: 20 }],
    lastChangeMono: noVisibleChange ? null : 50_100,
    quiet: true,
    noVisibleChange,
  });

  it("presses a repeated combo as one input, under one approval and one admission", async () => {
    const s = setup({ focused: () => search() });
    const ctx = agentCtx(s);
    const outcome = await s.gateway.run(ctx, { verb: "key", combo: ["]"], repeat: 5 });
    expect(outcome.ok).toBe(true);
    expect(ctx.authorizeAgent).toHaveBeenCalledOnce();
    expect(ctx.beforeEffect).toHaveBeenCalledOnce();
    expect(inputs(s)).toEqual([{ kind: "key", combo: ["]"], repeat: 5 }]);
    expect(s.ofType("action.intent")[0]?.data.label).toBe("Press ] 5 times");
    expect(s.ofType("action.dispatch")).toHaveLength(1);
  });

  it("holds keys for their time, then settles once they are released", async () => {
    const s = setup({ focused: () => search() });
    const outcome = await s.gateway.run(agentCtx(s), {
      verb: "key",
      combo: ["shift"],
      holdMs: 1500,
    });
    expect(outcome.ok).toBe(true);
    expect(inputs(s)).toEqual([{ kind: "key", combo: ["shift"], holdMs: 1500 }]);
    expect(s.ofType("action.intent")[0]?.data.label).toBe("Hold Shift for 1.5 s");
    const paths = s.fake.calls.map((c) => c.path);
    expect(paths.indexOf("/settle")).toBeGreaterThan(paths.indexOf("/input"));
    expect(paths).not.toContain("/release");
  });

  it("delivers a hold that is stopped, says how long the keys were down, and releases them first", async () => {
    const s = setup({ focused: () => search(), inputHolds: 1, releaseMs: 20 });
    const stop = new AbortController();
    const running = s.gateway.run(agentCtx(s, stop.signal), {
      verb: "key",
      combo: ["shift"],
      holdMs: 10_000,
    });
    await vi.waitFor(() => expect(s.ofType("action.dispatch")).toHaveLength(1));
    s.clock.advance(msToMicros(3100));
    stop.abort(new Error("the task was paused"));
    expect(await running).toEqual({
      ok: false,
      cancelled: "user",
      error: "the task was paused",
      partial: { presses: 1, heldMs: 3100 },
      focus: { target: search().target },
    });
    expect(s.fake.calls.at(-1)?.path).toBe("/release");
    expect(s.events().map((e) => e.type)).toEqual([
      "action.intent",
      "action.dispatch",
      "action.result",
    ]);
    expect(s.ofType("action.dispatch")[0]?.data.input).toEqual({
      kind: "key",
      combo: ["shift"],
      holdMs: 10_000,
    });
    expect(s.ofType("action.result")[0]?.data).toEqual({
      ok: false,
      error: "Stopped after holding for 3.1 s of 10 s: the task was paused",
    });
  });

  it("delivers a repeat that is stopped, with the presses it made", async () => {
    const s = setup({ focused: () => search(), inputHolds: 37 });
    const stop = new AbortController();
    const running = s.gateway.run(agentCtx(s, stop.signal), {
      verb: "key",
      combo: ["Delete"],
      repeat: 100,
    });
    await vi.waitFor(() => expect(s.ofType("action.dispatch")).toHaveLength(1));
    stop.abort();
    expect(await running).toMatchObject({ ok: false, cancelled: "user", partial: { presses: 37 } });
    expect(s.ofType("action.result")[0]?.data.error).toMatch(/^Stopped after 37 of 100 presses/);
    expect(s.ofType("action.cancel")).toEqual([]);
  });

  it("does not deliver a hold stopped before its keys went down", async () => {
    const s = setup({ focused: () => search(), inputHolds: 0 });
    const stop = new AbortController();
    const running = s.gateway.run(agentCtx(s, stop.signal), {
      verb: "key",
      combo: ["shift"],
      holdMs: 10_000,
    });
    await vi.waitFor(() => expect(inputs(s)).toHaveLength(1));
    stop.abort();
    const outcome = await running;
    expect(outcome).toMatchObject({ ok: false, cancelled: "user" });
    expect(outcome.partial).toBeUndefined();
    expect(s.ofType("action.dispatch")).toEqual([]);
    expect(s.ofType("action.cancel")[0]?.data.reason).toBe("user");
    expect(s.fake.calls.at(-1)?.path).toBe("/release");
  });

  it("releases every key and button when a key input fails", async () => {
    const s = setup({
      focused: () => search(),
      input: () => ({ status: 500, body: "the helper went away" }),
    });
    const outcome = await s.gateway.run(agentCtx(s), { verb: "key", combo: ["ctrl", "a"] });
    expect(outcome.ok).toBe(false);
    expect(s.fake.calls.map((c) => c.path).slice(-2)).toEqual(["/input", "/release"]);
  });

  it("reports where keyboard focus was, and whether the screen changed after the keys", async () => {
    const s = setup({ focused: () => search(), observe: () => frame() });
    const ctx = agentCtx(s);
    s.fake.script.settle = () => settled(true);
    const still = await s.gateway.run(ctx, { verb: "key", combo: ["ctrl", "a"] });
    expect(still).toMatchObject({ ok: true, changed: false, focus: { target: search().target } });
    s.fake.script.settle = () => settled(false);
    const moved = await s.gateway.run(ctx, { verb: "key", combo: ["Tab"] });
    expect(moved).toMatchObject({ ok: true, changed: true });
    expect(ctx.afterEffect.mock.calls.map((c) => [c[0].combo, c[2]])).toEqual([
      [["ctrl", "a"], false],
      [["Tab"], true],
    ]);
    expect(ctx.afterEffect.mock.calls[0]?.[1]).toMatchObject({
      window: 77,
      target: search().target,
    });
    s.fake.script.focused = () => ({ target: null, window: 77, unknown: true, ms: 300 });
    const unknown = await s.gateway.run(ctx, { verb: "key", combo: ["Tab"] });
    expect(unknown).toMatchObject({ ok: true, focus: { target: null, unknown: true } });
  });

  it("counts a frame identical to the one before the input as no change", async () => {
    const s = setup({ focused: () => search(), observe: () => frame("the same pixels") });
    const ctx = agentCtx(s);
    s.fake.script.settle = () => settled(false);
    await s.gateway.observe(ctx);
    const outcome = await s.gateway.run(ctx, { verb: "key", combo: ["ctrl", "a"] });
    expect(outcome).toMatchObject({ ok: true, changed: false });
    expect(ctx.afterEffect.mock.calls.map((c) => c[2])).toEqual([false]);
  });

  it("reports the field that typing went into", async () => {
    const field = {
      target: {
        point: { x: 300, y: 400 },
        source: "ax" as const,
        role: "text",
        name: "HTML notation",
        window: "Change Foreground Color",
      },
      window: 21,
      ms: 4,
    };
    const s = setup({
      focused: () => field,
      settle: () => settled(false),
      observe: () => frame(),
      type: () => ({
        progress: [{ count: 6, chunk: "A9743E", pressMono: 60_000 }],
        result: { done: true, count: 6, firstPressMono: 60_000, injector: "xtest", armedMono: 1 },
      }),
    });
    const outcome = await s.gateway.run(agentCtx(s), { verb: "type", text: "A9743E" });
    expect(outcome).toMatchObject({ ok: true, changed: true, focus: { target: field.target } });
  });
});

describe("ActionGateway settle and zoom", () => {
  it("settles each input with its verb and that verb's wait for a first change", async () => {
    const s = setup(
      {
        hitTest: () => ({ target: null, window: null, ms: 2 }),
        type: () => ({
          progress: [{ count: 1, chunk: "h", pressMono: 60_000 }],
          result: { done: true, count: 1, firstPressMono: 60_000, injector: "xtest", armedMono: 1 },
        }),
      },
      { viewers: 0 },
    );
    const ctx = { source: "manual" as const, sessionId: s.sessionId, cellId: s.cellId };
    await s.gateway.run(ctx, { verb: "click", point: { x: 10, y: 10 } });
    await s.gateway.run(ctx, { verb: "scroll", point: { x: 10, y: 10 }, dx: 0, dy: 2 });
    await s.gateway.run(ctx, { verb: "key", combo: ["Escape"] });
    await s.gateway.run(ctx, { verb: "type", text: "h" });
    expect(s.fake.calls.filter((c) => c.path === "/settle").map((c) => c.body)).toEqual([
      { verb: "click", quietMs: 250, firstMs: 800, timeoutMs: 3000 },
      { verb: "scroll", quietMs: 250, firstMs: 800, timeoutMs: 3000 },
      { verb: "key", quietMs: 250, firstMs: 400, timeoutMs: 3000 },
      { verb: "type", quietMs: 250, firstMs: 400, timeoutMs: 3000 },
    ]);
    // The result frame is observed right after the settle, with nothing in between.
    const paths = s.fake.calls.map((c) => c.path);
    for (const [i, path] of paths.entries())
      if (path === "/settle") expect(paths[i + 1]).toBe("/observe");
  });

  it("zooms the session's newest frame through its desktop, and nothing else", async () => {
    let next = 0;
    const ids = ["01J9ZQ3V8Y7X6W5T4S3R2Q1P0A", "01J9ZQ3V8Y7X6W5T4S3R2Q1P0B"];
    const s = setup({
      observe: () => ({
        frameId: ids[next++] as string,
        width: 1280,
        height: 800,
        image: Buffer.from("RIFF....WEBP").toString("base64"),
        pointer: { x: 0, y: 0 },
        windows: [],
      }),
      zoom: (body) => Buffer.from(`png of ${(body as { frameId: string }).frameId}`),
    });
    const ctx = { sessionId: s.sessionId, cellId: s.cellId };
    const region = { x: 100, y: 50, w: 40, h: 20 };
    const { frameId } = await s.gateway.observe(ctx);
    expect((await s.gateway.zoom(s.sessionId, frameId, region))?.toString()).toBe(
      `png of ${frameId}`,
    );
    expect(s.fake.calls.at(-1)).toEqual({ path: "/zoom", body: { frameId, region } });
    expect(
      await s.gateway.zoom(s.eventLog.createSession("other"), frameId, region),
    ).toBeUndefined();
    expect(await s.gateway.zoom(s.sessionId, "01J9ZQ3V8Y7X6W5T4S3R2Q1P0Z", region)).toBeUndefined();
    const cell = s.cells.get(s.cellId);
    if (!cell) throw new Error("no cell");
    s.cells.emit({ ...cell, paused: true });
    expect(await s.gateway.zoom(s.sessionId, frameId, region)).toBeUndefined();
    s.cells.emit(cell);
    await s.gateway.observe(ctx);
    expect(await s.gateway.zoom(s.sessionId, frameId, region)).toBeUndefined();
    expect(s.fake.calls.filter((c) => c.path === "/zoom")).toHaveLength(1);
  });
});

describe("ActionGateway native identity", () => {
  const frame = { x: 0, y: 54, w: 1604, h: 1258 };
  const element =
    (name = "Search", dx = 0) =>
    (point: Point): HitTestResult => {
      const hit = search(point);
      return {
        ...hit,
        target: { ...hit.target, name, bbox: { ...hit.target.bbox, x: hit.target.bbox.x + dx } },
        windowFrame: frame,
      };
    };
  // desktopd's answer when the element lookup ran out of time: the window and its frame only.
  const timedOut = (point: Point): HitTestResult => ({
    target: { point, source: "coords", app: "Chromium", window: "Example" },
    window: 77,
    windowFrame: frame,
    unknown: true,
    ms: 300,
  });
  // A reply the client cannot read: the lookup failed, so nothing at all is known.
  const broken = () => ({ target: "?" }) as unknown as HitTestResult;
  const click = { verb: "click", point: { x: 150, y: 200 }, speed: "instant" } as const;

  function agent(reads: ((point: Point) => HitTestResult)[], revalidate = false) {
    const s = setup();
    let n = 0;
    s.fake.script.hitTest = (point) => (reads[Math.min(n++, reads.length - 1)] ?? broken)(point);
    const consumed: NativeActionIdentity[] = [];
    const found: NativeActionIdentity[] = [];
    const admitted: NativeActionIdentity[] = [];
    const revalidated: boolean[] = [];
    const ctx: ActionContext = {
      source: "agent",
      sessionId: s.sessionId,
      cellId: s.cellId,
      authorizeAgent: async (request) => {
        if (revalidate) revalidated.push(await request.revalidate());
        return {
          consume: (_action, identity, fresh) => {
            consumed.push(identity);
            found.push(fresh);
            return true;
          },
        };
      },
      beforeEffect: (_action, identity) => {
        admitted.push(identity);
        return true;
      },
    };
    const inputs = () => s.fake.calls.filter((c) => c.path === "/input");
    return { s, ctx, consumed, found, admitted, revalidated, inputs };
  }

  it("acts on a window-level approval when the next read finds an element in that window", async () => {
    const a = agent([timedOut, element()]);
    const outcome = await a.s.gateway.run(a.ctx, click);
    expect(outcome.ok).toBe(true);
    expect(a.inputs()).toHaveLength(1);
    expect(a.inputs()[0]?.body).toMatchObject({ window: 77 });
    // The permit and the repeat guard see what was approved, not the later read.
    expect(a.consumed).toEqual([expect.objectContaining({ unknown: true, window: 77 })]);
    expect(a.admitted).toEqual(a.consumed);
    // The permit also gets the later read, to classify the element it found.
    expect(a.found).toEqual([
      expect.objectContaining({ target: expect.objectContaining({ name: "Search" }) }),
    ]);
  });

  it("refuses a window-level approval once that window has moved", async () => {
    const moved = (point: Point) => ({
      ...timedOut(point),
      windowFrame: { ...frame, x: frame.x + 40 },
    });
    const a = agent([timedOut, moved]);
    expect(await a.s.gateway.run(a.ctx, click)).toMatchObject({ ok: false, cancelled: "stale" });
    expect(a.inputs()).toHaveLength(0);
    const resized = agent([
      timedOut,
      (point) => ({ ...moved(point), windowFrame: { ...frame, h: 900 } }),
    ]);
    expect((await resized.s.gateway.run(resized.ctx, click)).ok).toBe(false);
    expect(resized.inputs()).toHaveLength(0);
  });

  it("refuses a secret field that a window-level approval finds at dispatch", async () => {
    const password = (point: Point): HitTestResult => {
      const hit = search(point);
      return {
        ...hit,
        target: { ...hit.target, role: "password text", secret: true },
        windowFrame: frame,
      };
    };
    const a = agent([timedOut, password]);
    expect(await a.s.gateway.run(a.ctx, click)).toMatchObject({ ok: false, cancelled: "stale" });
    expect(a.found).toHaveLength(0);
    expect(a.inputs()).toHaveLength(0);
  });

  it("refuses an approved element that a later read can no longer confirm", async () => {
    const a = agent([element(), timedOut]);
    const outcome = await a.s.gateway.run(a.ctx, click);
    expect(outcome).toMatchObject({ ok: false, cancelled: "stale" });
    expect(a.inputs()).toHaveLength(0);
  });

  it("refuses a button swapped under the cursor after approval", async () => {
    const a = agent([element("Search"), element("Send")]);
    expect(await a.s.gateway.run(a.ctx, click)).toMatchObject({ ok: false, cancelled: "stale" });
    expect(a.inputs()).toHaveLength(0);
  });

  it("acts through a pixel of layout jitter and binds the approved box", async () => {
    const a = agent([element("Search", 0), element("Search", 1)]);
    expect((await a.s.gateway.run(a.ctx, click)).ok).toBe(true);
    expect(a.consumed[0]?.target?.bbox?.x).toBe(280);
    const far = agent([element("Search", 0), element("Search", 3)]);
    expect((await far.s.gateway.run(far.ctx, click)).ok).toBe(false);
  });

  it("revalidates an approval by the same rule", async () => {
    const lost = agent([element(), timedOut], true);
    await lost.s.gateway.run(lost.ctx, click);
    expect(lost.revalidated).toEqual([false]);
    expect(lost.inputs()).toHaveLength(0);
    const found = agent([timedOut, element()], true);
    expect((await found.s.gateway.run(found.ctx, click)).ok).toBe(true);
    expect(found.revalidated).toEqual([true]);
  });

  it("treats a failed lookup as unknown, never as an empty answer", async () => {
    const appeared = agent([broken, element()]);
    expect(await appeared.s.gateway.run(appeared.ctx, click)).toMatchObject({
      ok: false,
      cancelled: "stale",
    });
    const silent = agent([broken, broken]);
    expect((await silent.s.gateway.run(silent.ctx, click)).ok).toBe(true);
    expect(silent.consumed[0]).toMatchObject({ target: null, window: null, unknown: true });
  });
});

describe("ActionGateway drags, moves and held buttons", () => {
  function agentCtx(s: ReturnType<typeof setup>, signal?: AbortSignal) {
    const released: string[] = [];
    let release: (() => Promise<void>) | undefined;
    const forget = vi.fn();
    const ctx = {
      source: "agent" as const,
      sessionId: s.sessionId,
      cellId: s.cellId,
      ...(signal ? { signal } : {}),
      authorizeAgent: vi.fn(async (_request: NativeActionRequest) => ({ consume: () => true })),
      beforeEffect: vi.fn(() => true),
      afterEffect: vi.fn(),
      holdInput: vi.fn((r: () => Promise<void>) => {
        release = r;
        return forget;
      }),
    };
    return { ctx, released, forget, release: () => release?.() };
  }
  const inputs = (s: ReturnType<typeof setup>) =>
    s.fake.calls
      .filter((c) => c.path === "/input")
      .map((c) => c.body as { input: { kind: string }; window?: number; dropWindow?: number });
  const at = (x: number, y: number, name?: string, window = 77): HitTestResult => ({
    target: name ? { point: { x, y }, source: "ax", role: "list item", name } : null,
    window,
    ms: 3,
  });
  const desk = (point: Point) =>
    point.x > 1000 ? at(point.x, point.y, "Trash", 88) : at(point.x, point.y, "report.txt");

  it("drags along the whole path under one approval that names both ends", async () => {
    const s = setup({ hitTest: desk });
    const { ctx } = agentCtx(s);
    const path = [
      { x: 100, y: 200 },
      { x: 300, y: 250 },
      { x: 600, y: 300 },
    ];
    const outcome = await s.gateway.run(ctx, {
      verb: "drag",
      path,
      button: "left",
      mods: ["shift"],
    });
    expect(outcome.ok).toBe(true);
    expect(ctx.authorizeAgent).toHaveBeenCalledOnce();
    const request = ctx.authorizeAgent.mock.calls[0]?.[0];
    expect(request?.action).toMatchObject({ verb: "drag", path });
    expect(request?.identity).toMatchObject({
      target: { name: "report.txt" },
      point: { x: 200, y: 400 },
      drop: { target: { name: "Trash" }, window: 88, point: { x: 1200, y: 600 } },
    });
    const [sent] = inputs(s);
    expect(sent).toMatchObject({
      input: {
        kind: "drag",
        from: { x: 200, y: 400 },
        to: { x: 1200, y: 600 },
        path: [{ x: 600, y: 500 }],
        button: "left",
        mods: ["shift"],
        durationMs: expect.any(Number),
      },
      window: 77,
      dropWindow: 88,
    });
    expect(s.ofType("action.intent")[0]?.data).toMatchObject({
      verb: "drag",
      label: 'Drag "report.txt" to "Trash"',
      point: { x: 200, y: 400 },
    });
    expect(s.ofType("action.dispatch")).toHaveLength(1);
    expect(s.gateway.cursorOf(s.cellId)).toEqual({ x: 1200, y: 600 });
  });

  it("cancels a drag whose drop point changed after approval, before any press", async () => {
    let trash = "Trash";
    const s = setup({ hitTest: (p) => (p.x > 1000 ? at(p.x, p.y, trash, 88) : desk(p)) });
    const { ctx } = agentCtx(s);
    ctx.authorizeAgent.mockImplementation(async () => {
      trash = "Shred";
      return { consume: () => true };
    });
    const outcome = await s.gateway.run(ctx, {
      verb: "drag",
      path: [
        { x: 100, y: 200 },
        { x: 600, y: 300 },
      ],
    });
    expect(outcome).toMatchObject({ ok: false, cancelled: "stale" });
    expect(inputs(s)).toEqual([]);
  });

  it("lets go of the button when stopped mid-drag, before the action returns", async () => {
    const s = setup({ hitTest: desk, inputHolds: 1, releaseMs: 20 });
    const stop = new AbortController();
    const { ctx } = agentCtx(s, stop.signal);
    const running = s.gateway.run(ctx, {
      verb: "drag",
      path: [
        { x: 100, y: 200 },
        { x: 600, y: 300 },
      ],
    });
    await vi.waitFor(() => expect(s.ofType("action.dispatch")).toHaveLength(1));
    stop.abort();
    expect(await running).toMatchObject({ ok: false, cancelled: "user" });
    expect(s.fake.calls.at(-1)?.path).toBe("/release");
    expect(s.ofType("action.result")[0]?.data.ok).toBe(false);
  });

  it("refuses a drag or a press while a button is down", async () => {
    const s = setup({ hitTest: desk });
    const { ctx } = agentCtx(s);
    expect((await s.gateway.run(ctx, { verb: "down", point: { x: 10, y: 10 } })).ok).toBe(true);
    for (const action of [
      {
        verb: "drag" as const,
        path: [
          { x: 1, y: 1 },
          { x: 9, y: 9 },
        ],
      },
      { verb: "down" as const, point: { x: 10, y: 10 } },
      { verb: "click" as const, point: { x: 10, y: 10 } },
    ])
      expect(await s.gateway.run(ctx, action)).toMatchObject({
        ok: false,
        cancelled: "preflight",
        error: "the left button is still down; let go of it with left_mouse_up first",
      });
    expect(inputs(s).map((i) => i.input.kind)).toEqual(["down"]);
  });

  it("keeps a pressed button down between actions, glides while it is down, and lets go on up", async () => {
    const s = setup({ hitTest: desk });
    const { ctx, forget } = agentCtx(s);
    await s.gateway.run(ctx, { verb: "move", point: { x: 50, y: 60 } });
    await s.gateway.run(ctx, { verb: "down", mods: ["ctrl"] });
    expect(ctx.holdInput).toHaveBeenCalledOnce();
    await s.gateway.run(ctx, { verb: "move", point: { x: 200, y: 160 } });
    const up = await s.gateway.run(ctx, { verb: "up" });
    expect(up).toMatchObject({ ok: true });
    expect(up.notDown).toBeUndefined();
    expect(inputs(s).map((i) => i.input)).toEqual([
      { kind: "move", to: { x: 100, y: 120 } },
      { kind: "down", button: "left", at: { x: 100, y: 120 }, mods: ["ctrl"] },
      { kind: "move", to: { x: 400, y: 320 }, durationMs: expect.any(Number) },
      { kind: "up", button: "left", at: { x: 400, y: 320 } },
    ]);
    expect(forget).toHaveBeenCalledOnce();
    expect(s.ofType("action.intent").map((e) => e.data.label)).toEqual([
      'Move to "report.txt"',
      'Hold down the left button on "report.txt"',
      'Move to "report.txt"',
      'Release the left button on "report.txt"',
    ]);
  });

  it("glides to a release point while the button is down, then lets go there", async () => {
    const s = setup({ hitTest: desk });
    const { ctx } = agentCtx(s);
    await s.gateway.run(ctx, { verb: "down", point: { x: 10, y: 10 } });
    await s.gateway.run(ctx, { verb: "up", point: { x: 300, y: 300 } });
    expect(inputs(s).map((i) => i.input.kind)).toEqual(["down", "move", "up"]);
    expect(inputs(s)[1]?.input).toMatchObject({
      to: { x: 600, y: 600 },
      durationMs: expect.any(Number),
    });
  });

  it("says when a released button was not down", async () => {
    const s = setup({
      hitTest: desk,
      input: () => ({ pressMono: 50_001, presses: [], injector: "xtest", armedMono: 50_000 }),
    });
    const { ctx } = agentCtx(s);
    expect(await s.gateway.run(ctx, { verb: "up" })).toMatchObject({ ok: true, notDown: true });
  });

  it("lets go of a held button for its owner, and after its time without another pointer action", async () => {
    const s = setup({ hitTest: desk, releaseMs: 5 }, { heldButtonMs: 60 });
    const a = agentCtx(s);
    await s.gateway.run(a.ctx, { verb: "down", point: { x: 10, y: 10 } });
    await a.release();
    expect(s.fake.calls.filter((c) => c.path === "/release")).toHaveLength(1);
    expect(a.forget).toHaveBeenCalledOnce();
    await a.release();
    expect(s.fake.calls.filter((c) => c.path === "/release")).toHaveLength(1);

    await s.gateway.run(a.ctx, { verb: "down", point: { x: 10, y: 10 } });
    await new Promise((r) => setTimeout(r, 40));
    await s.gateway.run(a.ctx, { verb: "move", point: { x: 20, y: 20 } });
    await new Promise((r) => setTimeout(r, 40));
    expect(s.fake.calls.filter((c) => c.path === "/release")).toHaveLength(1);
    await vi.waitFor(() =>
      expect(s.fake.calls.filter((c) => c.path === "/release")).toHaveLength(2),
    );
    expect((await s.gateway.run(a.ctx, { verb: "click", point: { x: 5, y: 5 } })).ok).toBe(true);
  });

  it("lets go at once of a button pressed just as its owner stopped", async () => {
    const s = setup({ hitTest: desk });
    const { ctx, forget } = agentCtx(s);
    ctx.holdInput.mockImplementation((release: () => Promise<void>) => {
      void release();
      return forget;
    });
    expect((await s.gateway.run(ctx, { verb: "down" })).ok).toBe(true);
    await vi.waitFor(() => expect(s.fake.calls.map((c) => c.path)).toContain("/release"));
    expect((await s.gateway.run(ctx, { verb: "click", point: { x: 5, y: 5 } })).ok).toBe(true);
  });

  it("lets go when a press fails", async () => {
    const s = setup({ hitTest: desk, input: () => ({ status: 504, body: "no raw press" }) });
    const { ctx } = agentCtx(s);
    expect((await s.gateway.run(ctx, { verb: "down" })).ok).toBe(false);
    expect(s.fake.calls.at(-1)?.path).toBe("/release");
    expect(ctx.holdInput).not.toHaveBeenCalled();
  });

  it("moves the cursor without a glide when no button is down, and checks no basis for it", async () => {
    const s = setup({ hitTest: desk });
    const { ctx } = agentCtx(s);
    const outcome = await s.gateway.run(ctx, { verb: "move", point: { x: 40, y: 30 } });
    expect(outcome.ok).toBe(true);
    expect(inputs(s)).toEqual([
      expect.objectContaining({ input: { kind: "move", to: { x: 80, y: 60 } } }),
    ]);
    expect(s.fake.calls.filter((c) => c.path === "/observe")).toHaveLength(1);
  });
});
