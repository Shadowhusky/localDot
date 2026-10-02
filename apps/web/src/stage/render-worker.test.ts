import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerIn, WorkerOut } from "./render-worker.ts";

// The presenter fails on the second frame, as a lost canvas would.
vi.mock("./presenter.ts", () => ({
  canvasPresenter: () => {
    let shown = 0;
    return {
      present() {
        shown += 1;
        if (shown === 2) throw new Error("canvas lost");
      },
    };
  },
}));

const frame = () =>
  ({ displayWidth: 2560, displayHeight: 1600, close: () => {} }) as unknown as VideoFrame;

afterEach(() => vi.unstubAllGlobals());

describe("render worker", () => {
  it("tells the page when its pump dies instead of going quiet", async () => {
    const posted: WorkerOut[] = [];
    const scope: {
      onmessage: ((e: { data: WorkerIn }) => void) | null;
      postMessage(m: WorkerOut): void;
    } = {
      onmessage: null,
      postMessage: (m) => posted.push(m),
    };
    vi.stubGlobal("self", scope);
    await import("./render-worker.ts");
    const frames = [frame(), frame(), frame()];
    const readable = new ReadableStream<VideoFrame>({
      pull(controller) {
        const next = frames.shift();
        if (next) controller.enqueue(next);
      },
    });
    scope.onmessage?.({ data: { type: "init", canvas: {} as OffscreenCanvas } });
    scope.onmessage?.({ data: { type: "frames", readable } });
    await vi.waitFor(() => expect(posted.filter((m) => m.type === "error")).toHaveLength(1));
    expect(posted.find((m) => m.type === "error")).toEqual({
      type: "error",
      message: "canvas lost",
    });
  });
});
