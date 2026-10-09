import { expect, it, vi } from "vitest";
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
  return { name, displayWidth: 2560, displayHeight: 1600, close: () => {} };
}

// Safari reads the client's track in the worker that draws it, with no frame crossing the page.
it("reads a track handed to it, says it can as it starts, and ends the track with its pump", async () => {
  const posted: WorkerOut[] = [];
  const scope: {
    onmessage: ((e: { data: WorkerIn }) => void) | null;
    postMessage(m: WorkerOut): void;
  } = { onmessage: null, postMessage: (m) => posted.push(m) };
  let feed: ReadableStreamDefaultController<unknown> | undefined;
  const read: unknown[] = [];
  vi.stubGlobal("self", scope);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readonly readable = new ReadableStream({
        start: (controller) => {
          feed = controller;
        },
      });
      constructor(init: { track: unknown }) {
        read.push(init.track);
      }
    },
  );
  await import("./render-worker.ts");
  expect(posted[0]).toEqual({ type: "caps", tracks: true });
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
  const track = { stop: vi.fn() };
  send({ type: "frames", sourceId: 1, track: track as unknown as MediaStreamTrack });
  await vi.waitFor(() => expect(read).toEqual([track]));
  const a = videoFrame("a");
  feed?.enqueue(a);
  await vi.waitFor(() => expect(shown).toContain(a));
  expect(track.stop).not.toHaveBeenCalled();
  send({ type: "stop" });
  await vi.waitFor(() => expect(track.stop).toHaveBeenCalledTimes(1));
  expect(posted.filter((m) => m.type === "error")).toEqual([]);
  vi.unstubAllGlobals();
});
