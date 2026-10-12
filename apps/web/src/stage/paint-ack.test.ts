import { afterEach, expect, it, vi } from "vitest";
import type { WorkerIn, WorkerOut } from "./worker-protocol.ts";

// PixiPresenter.present updates its pending texture; only render submits the stage to the canvas.
// Exercise the actual worker/pump scheduling, with inert present/render boundaries instead of GPU work.
const state = vi.hoisted(() => ({ pending: "", painted: "", presented: 0, failRender: false }));
vi.mock("./pixi-presenter.ts", () => ({
  PixiPresenter: {
    create: async () => ({
      get presented() {
        return state.presented;
      },
      frameSize: { w: 1280, h: 800 },
      get hasFrame() {
        return state.pending !== state.painted;
      },
      fades: () => [],
      present(frame: VideoFrame & { name: string }) {
        state.pending = frame.name;
        state.presented += 1;
      },
      setScreen() {},
      setCamera() {},
      draw() {},
      render() {
        if (state.failRender) throw new Error("inert render failure");
        state.painted = state.pending;
      },
    }),
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each([false, true])(
  "acknowledges a replacement only after successful canvas rendering (failure=%s)",
  async (failFirstRender) => {
    state.pending = "";
    state.painted = "";
    state.presented = 0;
    state.failRender = false;
    const posted: WorkerOut[] = [];
    const scope: {
      onmessage: ((e: { data: WorkerIn }) => void) | null;
      postMessage(m: WorkerOut): void;
    } = {
      onmessage: null,
      postMessage: (message) => posted.push(message),
    };
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let tick: FrameRequestCallback | undefined;
    vi.stubGlobal("self", scope);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      tick = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    await import("./render-worker.ts");
    const send = (data: WorkerIn) => scope.onmessage?.({ data });
    const frame = (name: string) =>
      ({ name, displayWidth: 1280, displayHeight: 800, close() {} }) as unknown as VideoFrame;
    send({
      type: "init",
      canvas: {} as OffscreenCanvas,
      width: 1280,
      height: 800,
      dpr: 1,
      theme: {} as never,
      reducedMotion: false,
    });
    try {
      send({ type: "frames", sourceId: 1, readable: new ReadableStream(), first: frame("old") });
      await vi.waitFor(() => expect(state.pending).toBe("old"));
      tick?.(0);
      expect(state.painted).toBe("old"); // An actual prior frame has reached the render boundary.
      posted.length = 0;
      send({ type: "stop" });
      send({ type: "frames", sourceId: 2, readable: new ReadableStream(), first: frame("new") });
      await vi.waitFor(() => expect(state.pending).toBe("new"));
      expect(state.painted).toBe("old");
      expect(
        posted.filter((m) => m.type === "stats" && m.sourceId === 2),
        "source stats are the manual-admission acknowledgement, so cannot precede the new canvas render",
      ).toHaveLength(0);
      if (failFirstRender) {
        state.failRender = true;
        tick?.(8);
        expect(state.painted).toBe("old");
        expect(posted.some((m) => m.type === "stats" && m.sourceId === 2)).toBe(false);
        expect(posted.some((m) => m.type === "error")).toBe(true);
        state.failRender = false;
        // A failed renderer now backs off before retrying; no acknowledgement during that wait.
        now = 500;
        tick?.(now);
        expect(posted.some((m) => m.type === "stats" && m.sourceId === 2)).toBe(false);
        now = 1000;
      }
      tick?.(16);
      expect(state.painted).toBe("new");
      expect(posted.some((m) => m.type === "stats" && m.sourceId === 2)).toBe(true);
    } finally {
      send({ type: "stop" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  },
);
