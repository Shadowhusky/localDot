import { afterEach, expect, it, vi } from "vitest";
import { LINGER_MS } from "./render-gate.ts";
import type { WorkerIn, WorkerOut } from "./worker-protocol.ts";

// A still stage costs no rendering: the worker draws once, then only when a frame arrives.
const state = vi.hoisted(() => ({ renders: 0, pending: false }));
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
      draw() {},
      render() {
        state.renders += 1;
        state.pending = false;
      },
    }),
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("renders a still stage once, sleeps, and wakes for a frame", async () => {
  const scope: {
    onmessage: ((e: { data: WorkerIn }) => void) | null;
    postMessage(m: WorkerOut): void;
  } = { onmessage: null, postMessage: () => {} };
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
  const send = (data: WorkerIn) => scope.onmessage?.({ data });
  const step = (ms: number) => {
    now += ms;
    const due = frames.splice(0);
    for (const fn of due) fn(now);
    return due.length;
  };
  send({
    type: "init",
    canvas: {} as OffscreenCanvas,
    width: 1280,
    height: 800,
    dpr: 1,
    theme: {} as never,
    reducedMotion: false,
  });
  await vi.waitFor(() => expect(frames).toHaveLength(1));
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
