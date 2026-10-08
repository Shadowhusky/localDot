import { describe, expect, it, vi } from "vitest";
import type { WorkerIn, WorkerOut } from "./worker-protocol.ts";

const shown: unknown[] = [];
vi.mock("./pixi-presenter.ts", () => ({
  PixiPresenter: {
    create: async () => ({
      presented: 0,
      present(frame: unknown) {
        shown.push(frame);
      },
    }),
  },
}));

function videoFrame(name: string) {
  const f = { name, displayWidth: 2560, displayHeight: 1600, closed: false, close: () => {} };
  f.close = () => {
    f.closed = true;
  };
  return f;
}

// iOS Safari cannot transfer a stream to a worker, so the page posts each frame on its own.
describe("render worker fed one frame at a time", () => {
  it("presents posted frames and closes frames from a replaced source", async () => {
    const posted: WorkerOut[] = [];
    const scope: {
      onmessage: ((e: { data: WorkerIn }) => void) | null;
      postMessage(m: WorkerOut): void;
    } = { onmessage: null, postMessage: (m) => posted.push(m) };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    await import("./render-worker.ts");
    const send = (data: WorkerIn) => scope.onmessage?.({ data });
    send({
      type: "init",
      canvas: {} as OffscreenCanvas,
      width: 1,
      height: 1,
      dpr: 1,
      theme: {} as never,
      reducedMotion: false,
    });
    send({ type: "frames", sourceId: 1, pushed: true });
    const a = videoFrame("a");
    send({ type: "frame", sourceId: 1, frame: a as unknown as VideoFrame });
    await vi.waitFor(() => expect(shown).toContain(a));
    const b = videoFrame("b");
    send({ type: "frame", sourceId: 1, frame: b as unknown as VideoFrame });
    await vi.waitFor(() => expect(shown).toContain(b));

    send({ type: "frames", sourceId: 2, pushed: true });
    const stale = videoFrame("stale");
    send({ type: "frame", sourceId: 1, frame: stale as unknown as VideoFrame });
    await vi.waitFor(() => expect(stale.closed).toBe(true));
    expect(shown).not.toContain(stale);
    expect(posted.filter((m) => m.type === "error")).toEqual([]);
  });
});
