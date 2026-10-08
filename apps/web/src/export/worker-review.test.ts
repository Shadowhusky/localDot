import { emptyModel } from "@localdot/stage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportIn, ExportOut } from "./export-protocol.ts";

const test = vi.hoisted(() => ({
  posts: [] as ExportOut[],
  videoTimes: [] as number[],
  backdropTimes: [] as number[],
  sequence: [] as string[],
  closeVideo: vi.fn(),
  closeBackdrop: vi.fn(),
  clearVideo: vi.fn(),
  destroy: vi.fn(),
  outputCancel: vi.fn(async () => {}),
  outputFinalize: vi.fn(async () => {}),
  holdCreate: null as Promise<void> | null,
  chunk: false,
  write: null as ((chunk: { position: number; data: Uint8Array }) => Promise<void>) | null,
}));
vi.mock("pixi.js", () => ({ Rectangle: class {} }));
vi.mock("./burn-in.ts", () => ({
  ExportBurnIn: class {
    draw() {}
  },
}));
vi.mock("../stage/pixi-presenter.ts", () => ({
  PixiPresenter: {
    create: async () => {
      await test.holdCreate;
      return {
        setScreen() {},
        setCamera() {},
        screen: { addChild() {} },
        present(frame: { close(): void }) {
          frame.close();
        },
        draw() {},
        render() {
          test.sequence.push("render");
        },
        clearVideo: test.clearVideo,
        app: { destroy: test.destroy },
      };
    },
  },
}));
vi.mock("../replay/replay-video.ts", () => ({
  ReplayVideo: {
    open: async () => ({
      firstMs: 0,
      lastMs: 1000,
      want: async (time: number) => {
        test.videoTimes.push(time);
        return { close: vi.fn() };
      },
      stats: () => ({ openFrames: 1 }),
      close: test.closeVideo,
    }),
  },
}));
vi.mock("../replay/backdrop.ts", () => ({
  ObserveBackdrop: class {
    frameAt(_model: unknown, time: number) {
      test.backdropTimes.push(time);
      return null;
    }
    close = test.closeBackdrop;
  },
}));
vi.mock("mediabunny", () => ({
  QUALITY_HIGH: 1,
  Mp4OutputFormat: class {},
  StreamTarget: class {
    constructor(writable: WritableStream) {
      const writer = writable.getWriter();
      test.write = (chunk) => writer.write(chunk);
    }
  },
  CanvasSource: class {
    async add() {
      test.sequence.push("encode");
      if (test.chunk) {
        test.chunk = false;
        await test.write?.({ position: 0, data: Uint8Array.of(1, 2, 3) });
      }
    }
    close() {}
  },
  Output: class {
    addVideoTrack() {}
    async start() {}
    finalize = test.outputFinalize;
    cancel = test.outputCancel;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  test.posts.length = test.videoTimes.length = test.backdropTimes.length = test.sequence.length = 0;
  test.holdCreate = null;
  test.chunk = false;
  test.write = null;
  vi.stubGlobal(
    "VideoEncoder",
    class {
      encode() {}
    },
  );
  vi.stubGlobal("OffscreenCanvas", class {});
});
afterEach(() => vi.unstubAllGlobals());

async function worker({ video = true, gap = true, autoAck = true } = {}) {
  const scope = {
    onmessage: null as ((event: { data: ExportIn }) => void) | null,
    close: vi.fn(),
    postMessage(message: ExportOut) {
      test.posts.push(message);
      if (message.type === "chunk" && autoAck)
        queueMicrotask(() => scope.onmessage?.({ data: { type: "ack", chunk: message.chunk } }));
    },
  };
  vi.stubGlobal("self", scope);
  await import("./export-worker.ts");
  const sessionId = "01K00000000000000000000000";
  const model = emptyModel();
  model.startT = 0;
  model.ended = { t: 200, reason: "done" };
  const gaps = gap ? [{ from: 50_000, to: 150_000, reason: "user-control" as const }] : [];
  const start: ExportIn = {
    type: "start",
    request: {
      sessionId,
      fromMs: 0,
      toMs: 200,
      speed: 1,
      skipIdle: false,
      captions: true,
      size: { w: 1280, h: 800 },
    },
    source: {
      sessionId,
      origin: "http://inert.invalid",
      authorization: "Bearer fixture",
      video: video ? { upto: null } : null,
      gaps,
    },
    model,
    gaps,
    activity: [],
    theme: {} as Extract<ExportIn, { type: "start" }>["theme"],
    hashes: false,
    probe: true,
  };
  scope.onmessage?.({ data: start });
  return scope;
}

describe("independent export worker lifecycle", () => {
  it("holds takeover frames, then resumes exact increasing video targets, rendering before encoding", async () => {
    const scope = await worker();
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce());
    expect(test.posts.at(-1)).toMatchObject({ type: "done", frames: 6 });
    expect(test.videoTimes.map(Math.round)).toEqual([0, 33, 167]);
    expect(test.backdropTimes).toEqual([]);
    expect(test.posts.find((post) => post.type === "sources")).toMatchObject({
      entries: [
        { source: "video" },
        { source: "video" },
        { source: "hold" },
        { source: "hold" },
        { source: "hold" },
        { source: "video" },
      ],
    });
    expect(test.sequence).toEqual(Array.from({ length: 6 }, () => ["render", "encode"]).flat());
    expect(test.closeVideo).toHaveBeenCalledOnce();
    expect(test.closeBackdrop).toHaveBeenCalledOnce();
    expect(test.destroy).toHaveBeenCalledOnce();
  });
  it("does not consult fallback screenshots inside a takeover when no video is available", async () => {
    const scope = await worker({ video: false });
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce());
    expect(test.backdropTimes.map(Math.round)).toEqual([0, 33, 167]);
    expect(test.videoTimes).toEqual([]);
    expect(test.posts.at(-1)).toMatchObject({ type: "done", frames: 6 });
  });
  it("unwinds a compositor that becomes ready after cancellation without rendering or committing", async () => {
    let ready = () => {};
    test.holdCreate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const scope = await worker();
    scope.onmessage?.({ data: { type: "cancel" } });
    ready();
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce());
    expect(test.posts).toEqual([{ type: "cancelled" }]);
    expect(test.sequence).toEqual([]);
    expect(test.outputFinalize).not.toHaveBeenCalled();
    expect(test.destroy).toHaveBeenCalledOnce();
  });
  it("waits for file acknowledgement and cancellation rejects that wait without a done result", async () => {
    test.chunk = true;
    const scope = await worker({ autoAck: false });
    await vi.waitFor(() => expect(test.posts.some((post) => post.type === "chunk")).toBe(true));
    expect(test.outputFinalize).not.toHaveBeenCalled();
    scope.onmessage?.({ data: { type: "cancel" } });
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce());
    expect(test.posts.at(-1)).toEqual({ type: "cancelled" });
    expect(test.posts.some((post) => post.type === "done")).toBe(false);
    expect(test.outputCancel).toHaveBeenCalledOnce();
    expect(test.destroy).toHaveBeenCalledOnce();
  });
});
