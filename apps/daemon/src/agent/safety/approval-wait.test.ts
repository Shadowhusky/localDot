import { DEFAULT_AUTONOMY, msToMicros, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolClient } from "../../../../../cells/brain/src/tool-client.ts";
import { FakeOrchestrator } from "../../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../../cells/types.ts";
import { DesktopdRegistry } from "../../desktopd/registry.ts";
import { FakeDesktopd } from "../../desktopd/testing/fake-desktopd.ts";
import { FrameStore } from "../../gateway/frames.ts";
import {
  type ActionContext,
  ActionGateway,
  type ActionOutcome,
  type GuiAction,
  type NativeActionIdentity,
} from "../../gateway/gateway.ts";
import { DEFAULT_ONSET_TABLE } from "../../gateway/onset-table.ts";
import { keepPolicy } from "../../gateway/ring-onset.ts";
import { redactor } from "../redact.ts";
import { TOOL_TOKEN, toolHarness } from "../testing/harness.ts";
import { dispatchTool } from "../tools/index.ts";

type Harness = ReturnType<typeof toolHarness>;
const owned: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of owned.splice(0)) close();
});

const CANCELLED = "The tool was cancelled or could not complete.";
const canvas = (x = 400): NativeActionIdentity => ({
  target: null,
  window: 9,
  point: { x, y: 364 },
});
const password: NativeActionIdentity = {
  target: {
    point: { x: 10, y: 10 },
    source: "ax",
    role: "password text",
    name: "Password",
    secret: true,
  },
  window: 9,
  point: { x: 10, y: 10 },
};

// The real gateway's contract with the computer tool: authorize against the identity it read,
// then read the identity again and consume the permit just before each dispatch.
function contractGateway(
  h: Harness,
  read: (run: number) => NativeActionIdentity,
  opts: { hang?: boolean } = {},
) {
  const dispatched: GuiAction[] = [];
  let runs = 0;
  const same = (a: NativeActionIdentity, b: NativeActionIdentity) =>
    JSON.stringify(a) === JSON.stringify(b);
  h.tools.gateway = {
    ...h.tools.gateway,
    run: async (ctx: ActionContext, action: GuiAction): Promise<ActionOutcome> => {
      const run = runs++;
      const identity = read(run);
      const permit = await ctx.authorizeAgent?.({
        action,
        identity,
        revalidate: async () => same(identity, read(run)),
      });
      if (!permit) return { ok: false, cancelled: "user", error: "not authorized" };
      const fresh = read(run);
      if (!permit.consume(action, fresh, fresh))
        return { ok: false, cancelled: "stale", error: "changed" };
      dispatched.push(action);
      if (opts.hang)
        await new Promise((_, reject) =>
          ctx.signal?.addEventListener("abort", () => reject(ctx.signal?.reason), { once: true }),
        );
      return { ok: true, frameId: ulid() };
    },
  };
  return dispatched;
}

function realGateway(h: Harness, desktop: FakeDesktopd) {
  let now = 10_000_000;
  const cells = new FakeOrchestrator();
  const registry = new DesktopdRegistry(cells, { nowMicros: () => now }, desktop.fetchImpl);
  owned.push(() => registry.dispose());
  cells.emit({
    id: h.session.cellId,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-08T00:00:00Z",
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
}

function harness(options: Parameters<typeof toolHarness>[0] = {}) {
  const h = toolHarness({ autoApprove: false, ...options });
  owned.push(h.close);
  return h;
}

// The API brain's own tool client, talking to the daemon's tool API in-process.
function brain(h: Harness) {
  const client = new ToolClient("http://127.0.0.1:4751", TOOL_TOKEN, ((
    input: string,
    init: RequestInit,
  ) => {
    const url = new URL(String(input));
    return h.app.request(url.pathname + url.search, init);
  }) as typeof fetch);
  owned.push(() => void client.close());
  return client;
}

function observe<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  const settled = promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.error = error;
    },
  );
  return { state, settled };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await vi.advanceTimersByTimeAsync(0);
  expect(condition()).toBe(true);
}

function approve(h: Harness) {
  const card = h.session.pendingApproval;
  if (!card) throw new Error("no card");
  return h.session.answerApproval({
    approvalId: card.approvalId,
    generation: card.generation,
    revision: card.revision,
    decision: "approve",
  });
}

function dispatch(h: Harness, input: unknown) {
  return dispatchTool(
    { tools: h.tools },
    h.session,
    "computer",
    ulid(),
    input,
    redactor([]),
    h.session.generation,
  );
}

describe("an unanswered card waits for the user", () => {
  it.each([3, 15])(
    "evidence rows 18 and 20: a click whose card waits %i minutes still runs when approved",
    async (minutes) => {
      vi.useFakeTimers();
      const h = harness();
      const dispatched = contractGateway(h, () => canvas());
      const call = observe(
        brain(h).tool("computer", ulid(), { action: "click", point: { x: 400, y: 364 }, count: 3 }),
      );
      await until(() => h.session.pendingApproval !== undefined);
      await vi.advanceTimersByTimeAsync(minutes * 60_000);
      expect(call.state.done).toBe(false);
      expect(h.session.pendingApproval).toBeDefined();
      expect(approve(h)).toBe(true);
      await until(() => call.state.done);
      expect(call.state.error).toBeUndefined();
      expect(call.state.value?.ok).toBe(true);
      expect(dispatched).toHaveLength(1);
    },
  );

  it("a hand-off inside a computer call survives five minutes and returns after hand-back", async () => {
    vi.useFakeTimers();
    const h = harness({ autonomy: DEFAULT_AUTONOMY });
    const dispatched = contractGateway(h, () => password);
    const call = observe(brain(h).tool("computer", ulid(), { action: "type", text: "hunter" }));
    await until(() => h.session.manualControl === "ready");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(call.state.done).toBe(false);
    const requestId = h.session.pendingTakeover;
    expect(requestId && h.session.endTakeover(requestId, undefined)).toBe(true);
    await until(() => call.state.done);
    expect(call.state.error).toBeUndefined();
    expect(call.state.value?.content[0]).not.toMatchObject({ text: CANCELLED });
    expect(dispatched).toHaveLength(0);
  });
});

describe("a target that changed while the user decided", () => {
  it("comes back retryable, with the screen as it is now", async () => {
    const h = harness();
    const button = (name: string) => ({
      target: {
        point: { x: 800, y: 728 },
        bbox: { x: 780, y: 708, w: 40, h: 40 },
        source: "ax" as const,
        role: "push button",
        name,
        app: "Paint",
      },
      window: 9,
      ms: 1,
    });
    const desktop = new FakeDesktopd({ hitTest: () => button("Brush") });
    realGateway(h, desktop);
    h.eventLog.subscribe((_id, event) => {
      if (event.type !== "approval.request") return;
      desktop.script.hitTest = () => button("Eraser");
      queueMicrotask(() => approve(h));
    });
    const out = await dispatch(h, { action: "click", point: { x: 400, y: 364 } });
    expect(out.result).toMatchObject({
      ok: false,
      cancelled: "stale",
      content: [
        {
          type: "text",
          text: "The screen changed while the user was deciding. Look again before acting.",
        },
        { type: "image" },
      ],
    });
    expect(desktop.calls.filter((c) => c.path === "/input")).toHaveLength(0);
  });
});

describe("the daemon bounds a call's own work", () => {
  it("cancels a hung computer call after two minutes of work", async () => {
    vi.useFakeTimers();
    const h = harness({ autonomy: DEFAULT_AUTONOMY });
    contractGateway(h, () => canvas(), { hang: true });
    const call = observe(dispatch(h, { action: "click", point: { x: 400, y: 364 } }));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => call.state.done);
    expect(call.state.value?.result).toMatchObject({ ok: false, content: [{ text: CANCELLED }] });
  });

  it("does not count the time a card waits, only the work after it", async () => {
    vi.useFakeTimers();
    const h = harness();
    contractGateway(h, () => canvas(), { hang: true });
    const call = observe(dispatch(h, { action: "click", point: { x: 400, y: 364 } }));
    await until(() => h.session.pendingApproval !== undefined);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(call.state.done).toBe(false);
    expect(approve(h)).toBe(true);
    await vi.advanceTimersByTimeAsync(118_000);
    expect(call.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => call.state.done);
    expect(call.state.value?.result).toMatchObject({ ok: false, content: [{ text: CANCELLED }] });
  });

  it("does not count the time the user holds control", async () => {
    vi.useFakeTimers();
    const h = harness({ autonomy: DEFAULT_AUTONOMY });
    contractGateway(h, () => password);
    const call = observe(dispatch(h, { action: "type", text: "hunter" }));
    await until(() => h.session.manualControl === "ready");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(call.state.done).toBe(false);
    const requestId = h.session.pendingTakeover;
    expect(requestId && h.session.endTakeover(requestId, undefined)).toBe(true);
    await until(() => call.state.done);
    expect(call.state.value?.result.content[0]).not.toMatchObject({ text: CANCELLED });
  });
});

describe("one decision for a repeated key", () => {
  it("repeat 5 under Careful shows one card for five presses", async () => {
    const h = harness();
    const dispatched = contractGateway(h, () => canvas());
    const cards: string[][] = [];
    h.eventLog.subscribe((_id, event) => {
      if (event.type !== "approval.request") return;
      cards.push((event.data.preview as { fields: string[][] }).fields.flat());
      queueMicrotask(() => approve(h));
    });
    const out = await dispatch(h, { action: "key", keys: ["bracketright"], repeat: 5 });
    expect(out.result.ok).toBe(true);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(expect.arrayContaining(["Repeat", "× 5"]));
    expect(dispatched).toHaveLength(5);
  });

  it("stops the rest when the target changes partway through", async () => {
    const h = harness();
    const dispatched = contractGateway(h, (run) => (run < 2 ? canvas() : canvas(600)));
    let cards = 0;
    h.eventLog.subscribe((_id, event) => {
      if (event.type !== "approval.request") return;
      cards++;
      queueMicrotask(() => approve(h));
    });
    const out = await dispatch(h, { action: "key", keys: ["bracketright"], repeat: 5 });
    expect(out.result).toMatchObject({ ok: false, cancelled: "stale" });
    expect(cards).toBe(1);
    expect(dispatched).toHaveLength(2);
  });

  it("asks again for a different call with the same keys", async () => {
    const h = harness();
    const dispatched = contractGateway(h, () => canvas());
    let cards = 0;
    h.eventLog.subscribe((_id, event) => {
      if (event.type !== "approval.request") return;
      cards++;
      queueMicrotask(() => approve(h));
    });
    await dispatch(h, { action: "key", keys: ["bracketright"], repeat: 2 });
    await dispatch(h, { action: "key", keys: ["bracketright"], repeat: 2 });
    expect(cards).toBe(2);
    expect(dispatched).toHaveLength(4);
  });
});
