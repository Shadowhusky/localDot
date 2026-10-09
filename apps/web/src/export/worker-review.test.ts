import { emptyModel } from "@localdot/stage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportIn, ExportOut } from "./export-protocol.ts";

const test = vi.hoisted(() => ({
  posts: [] as ExportOut[],
  videoTimes: [] as number[],
  backdropTimes: [] as number[],
  sequence: [] as string[],
  encoded: [] as { t: number; d: number }[],
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
  burnInText: (...parts: (string | null)[]) => parts.filter(Boolean).join(" ") || null,
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
vi.mock("./export-video.ts", () => ({
  ExportVideo: {
    open: async () => ({
      firstMs: 0,
      lastMs: 1000,
      async *samples(times: number[]) {
        for (const time of times) {
          test.videoTimes.push(time);
          yield { timestamp: time / 1000, toVideoFrame: () => ({ close() {} }), close() {} };
        }
      },
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
class Sample {
  timestamp = 0;
  duration = 0;
  clone() {
    return new Sample();
  }
  setTimestamp(value: number) {
    this.timestamp = value;
  }
  setDuration(value: number) {
    this.duration = value;
  }
  close() {}
}
vi.mock("mediabunny", () => ({
  Quality: class {},
  canEncodeVideo: async () => true,
  Mp4OutputFormat: class {},
  WebMOutputFormat: class {},
  VideoSample: Sample,
  StreamTarget: class {
    constructor(writable: WritableStream) {
      const writer = writable.getWriter();
      test.write = (chunk) => writer.write(chunk);
    }
  },
  VideoSampleSource: class {
    async add(sample: Sample) {
      test.sequence.push("encode");
      test.encoded.push({
        t: Math.round(sample.timestamp * 1000),
        d: Math.round(sample.duration * 1000),
      });
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
  test.encoded.length = 0;
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

async function worker({ video = true, gap = true, autoAck = true, endMs = 200 } = {}) {
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
  model.ended = { t: endMs, reason: "done" };
  const gaps = gap ? [{ from: 50_000, to: 150_000, reason: "user-control" as const }] : [];
  const start: ExportIn = {
    type: "start",
    request: {
      sessionId,
      fromMs: 0,
      toMs: endMs,
      speed: 1,
      skipIdle: false,
      captions: true,
      overlays: true,
      size: { w: 1280, h: 800 },
      fps: 30,
      quality: "high",
      format: "mp4",
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
  it("reads the recording only where the video shows it, and renders each new look once", async () => {
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
    // The takeover's card is drawn once and held for its three frames, as one longer frame.
    expect(test.sequence).toEqual([
      "render",
      "render",
      "encode",
      "render",
      "encode",
      "render",
      "encode",
      "encode",
    ]);
    expect(test.encoded).toEqual([
      { t: 0, d: 33 },
      { t: 33, d: 33 },
      { t: 67, d: 100 },
      { t: 167, d: 33 },
    ]);
    expect(test.closeVideo).toHaveBeenCalledOnce();
    expect(test.closeBackdrop).toHaveBeenCalledOnce();
    expect(test.destroy).toHaveBeenCalledOnce();
  });
  it("does not consult fallback screenshots inside a takeover when no video is available", async () => {
    const scope = await worker({ video: false });
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce());
    expect(test.backdropTimes.map(Math.round)).toEqual([0, 167]);
    expect(test.videoTimes).toEqual([]);
    expect(test.posts.at(-1)).toMatchObject({ type: "done", frames: 6 });
  });
  it("encodes a still picture once a second, however long it stays", async () => {
    const scope = await worker({ video: false, gap: false, endMs: 2500 });
    await vi.waitFor(() => expect(scope.close).toHaveBeenCalledOnce());
    expect(test.posts.at(-1)).toMatchObject({ type: "done", frames: 75 });
    expect(test.sequence.filter((step) => step === "render")).toHaveLength(1);
    expect(test.encoded).toEqual([
      { t: 0, d: 1000 },
      { t: 1000, d: 1000 },
      { t: 2000, d: 500 },
    ]);
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
