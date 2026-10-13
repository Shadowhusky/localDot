import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LINGER_MS } from "./render-gate.ts";
import type { WorkerIn, WorkerOut } from "./worker-protocol.ts";

// A still stage costs no rendering: the worker draws once, then only when a frame arrives.
const state = vi.hoisted(() => ({ renders: 0, pending: false, fail: false }));
vi.mock("./pixi-presenter.ts", () => ({
  PixiPresenter: {
    create: async () => ({
      presented: 0,
      frameSize: { w: 1280, h: 800 },
      get hasFrame() {
        return state.pending;
      },
      fades: () => [255, 0],
      present(frame: VideoFrame) {
        frame.close();
        state.pending = true;
      },
      setScreen() {},
      setCamera() {},
      setDim() {},
      draw() {},
      render() {
        state.renders += 1;
        if (state.fail) throw new Error("renderer unavailable");
        state.pending = false;
      },
    }),
  },
}));
beforeEach(() => {
  state.fail = false;
  state.renders = 0;
  state.pending = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

let seq = 0;
const ev = (type: string, tMs: number, data: Record<string, unknown>): LocalDotEvent =>
  ({
    v: 1,
    id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    seq: seq++,
    t: msToMicros(tMs),
    agent: "main",
    type,
    data,
  }) as LocalDotEvent;

async function worker() {
  const posted: WorkerOut[] = [];
  const scope: {
    onmessage: ((e: { data: WorkerIn }) => void) | null;
    postMessage(m: WorkerOut): void;
  } = { onmessage: null, postMessage: (message) => posted.push(message) };
  const frames: FrameRequestCallback[] = [];
  const timers: (() => void)[] = [];
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("self", scope);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("setTimeout", (fn: () => void) => timers.push(fn));
  vi.stubGlobal("clearTimeout", () => {});
  await import("./render-worker.ts");
  let queue = Promise.resolve();
  const send = (data: WorkerIn) => {
    scope.onmessage?.({ data });
    // The worker handles its messages in order on one promise chain; this waits for that turn.
    queue = queue.then(() => new Promise((done) => setImmediate(done)));
    return queue;
  };
  const step = (ms: number) => {
    now += ms;
    const due = frames.splice(0);
    for (const fn of due) fn(now);
    return due.length;
  };
  // Waits out the stage's linger, then runs its idle look.
  const settle = () => {
    for (let ms = 0; ms <= LINGER_MS; ms += 16) step(16);
    for (const look of timers.splice(0)) look();
    step(16);
  };
  await send({
    type: "init",
    canvas: {} as OffscreenCanvas,
    width: 1280,
    height: 800,
    dpr: 1,
    theme: {} as never,
    reducedMotion: false,
  });
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  return { send, step, settle, frames, timers, posted, now: () => now };
}

it("renders a still stage once, sleeps, and wakes for a frame", async () => {
  const { send, step, frames, timers } = await worker();
  step(16);
  expect(state.renders).toBe(1);
  // Nothing changes: the display frames go by without a render, then the worker stops asking.
  for (let ms = 0; ms <= LINGER_MS; ms += 16) step(16);
  expect(state.renders).toBe(1);
  expect(frames).toHaveLength(0);
  expect(timers.length).toBeGreaterThan(0);
  const frame = { displayWidth: 1280, displayHeight: 800, close() {} } as unknown as VideoFrame;
  send({ type: "frames", sourceId: 1, readable: new ReadableStream(), first: frame });
  await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
  step(16);
  expect(state.renders).toBe(2);
  send({ type: "stop" });
});

it("does not render a still stage for each word dot streams", async () => {
  const { send, step, settle, now } = await worker();
  await send({
    type: "clock",
    clock: { offsetMicros: 0, originMicros: msToMicros(performance.timeOrigin) },
  });
  await send({
    type: "events",
    events: [
      ev("session.start", 0, { screen: { w: 1280, h: 800, scale: 1 }, os: "linux" }),
      ev("agent.state", 1, { state: "acting" }),
    ],
  });
  step(16);
  settle();
  const still = state.renders;
  expect(still).toBeGreaterThan(0);
  const messageId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M";
  for (let word = 0; word < 25; word++) {
    await send({
      type: "events",
      events: [ev("message.delta", now(), { messageId, text: ` word${word}` })],
    });
    step(40);
  }
  expect(state.renders).toBe(still);
  await send({ type: "view", view: { dim: true } });
  step(16);
  expect(state.renders).toBe(still + 1);
});

it("backs off repeated renderer failures and resumes when rendering works", async () => {
  const { step, frames, timers, posted } = await worker();
  state.fail = true;
  step(16);
  expect(state.renders).toBe(1);
  expect(frames).toHaveLength(0);
  for (let n = 0; n < 3; n++) {
    for (const callback of timers.splice(0)) callback();
    step(1000);
  }
  expect(state.renders).toBe(4);
  expect(posted.filter((message) => message.type === "error")).toHaveLength(1);
  state.fail = false;
  for (const callback of timers.splice(0)) callback();
  step(1000);
  expect(state.renders).toBe(5);
  expect(frames).toHaveLength(1);
});
