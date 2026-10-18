// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openCapture } from "./capture.ts";

let contexts: FakeContext[];
let tracks: { stop: ReturnType<typeof vi.fn> }[];
let workers: FakeWorker[];
let session: { type: string };
class FakeContext {
  state = "running";
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = "closed";
  });
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createAnalyser = () => ({
    fftSize: 1024,
    getFloatTimeDomainData: (frame: Float32Array) => frame.fill(0.2),
  });
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
  constructor() {
    contexts.push(this);
  }
}
class FakeWorker {
  port = {
    onmessage: null as
      | ((event: { data: { samples?: Float32Array; flushed?: number } }) => void)
      | null,
    close: vi.fn(),
    postMessage: ({ flush }: { flush: number }) =>
      queueMicrotask(() => this.port.onmessage?.({ data: { flushed: flush } })),
  };
  connect = (node: { connect(): void }) => node;
  disconnect = vi.fn();
  constructor() {
    workers.push(this);
  }
  samples(...values: number[]) {
    this.port.onmessage?.({ data: { samples: Float32Array.from(values) } });
  }
}
beforeEach(() => {
  contexts = [];
  tracks = [];
  workers = [];
  session = { type: "auto" };
  vi.stubGlobal("navigator", {
    audioSession: session,
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const track = { stop: vi.fn() };
        tracks.push(track);
        return { getTracks: () => [track] };
      }),
    },
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorker);
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("does not open a microphone for an already cancelled turn", async () => {
  await expect(openCapture(true, AbortSignal.abort())).rejects.toMatchObject({ failure: "failed" });
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});

it("resumes in the click gesture and releases a microphone granted after cancellation", async () => {
  const grant = Promise.withResolvers<MediaStream>();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(grant.promise);
  const controller = new AbortController();
  const opening = openCapture(true, controller.signal);
  expect(contexts[0]?.resume).toHaveBeenCalledOnce();
  controller.abort();
  expect(contexts[0]?.close).toHaveBeenCalledOnce();
  const stop = vi.fn();
  grant.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await expect(opening).rejects.toMatchObject({ failure: "failed" });
  expect(stop).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(0);
  expect(session.type).toBe("auto");
});

it("releases every session after Stop, Cancel and page reload, then records again", async () => {
  for (const action of ["stop", "cancel", "reload", "stop"]) {
    const capture = await openCapture(true);
    expect(session.type).toBe("play-and-record");
    workers.at(-1)?.samples(0.1, 0.2, 0.3);
    expect(Array.from(await capture.snapshot())).toEqual(
      Array.from(Float32Array.of(0.1, 0.2, 0.3)),
    );
    expect(capture.level()).toBeGreaterThan(0);
    workers.at(-1)?.samples(0.4);
    if (action === "stop") expect(await capture.audio()).toHaveLength(4);
    else if (action === "cancel") capture.close();
    else window.dispatchEvent(new Event("pagehide"));
    capture.close();
    expect(tracks.at(-1)?.stop).toHaveBeenCalledOnce();
    expect(contexts.at(-1)?.close).toHaveBeenCalledOnce();
    expect(workers.at(-1)?.port.close).toHaveBeenCalledOnce();
    expect(session.type).toBe("auto");
    expect(capture.level()).toBe(-1);
  }
});

it("closes the previous capture before opening another", async () => {
  const first = await openCapture(true);
  const second = await openCapture(true);
  expect(tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(first.level()).toBe(-1);
  expect(second.level()).toBeGreaterThan(0);
  second.close();
});

it("releases the microphone and session when worklet setup fails", async () => {
  const opening = openCapture(true);
  contexts[0]?.audioWorklet.addModule.mockRejectedValue(new Error("blocked"));
  await expect(opening).rejects.toMatchObject({ failure: "failed" });
  expect(tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(contexts[0]?.close).toHaveBeenCalledOnce();
  expect(session.type).toBe("auto");
});

it("bounds a stalled worklet and still releases recording on Stop", async () => {
  vi.useFakeTimers();
  const capture = await openCapture(true);
  const worker = workers[0];
  if (!worker) throw new Error("Missing capture worker");
  worker.port.postMessage = () => {};
  const final = expect(capture.audio()).rejects.toMatchObject({ failure: "no-mic" });
  await vi.advanceTimersByTimeAsync(2000);
  await final;
  expect(tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(session.type).toBe("auto");
});

it("cancels a pending snapshot without leaving a timer or microphone behind", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const capture = await openCapture(true, controller.signal);
  const worker = workers[0];
  if (!worker) throw new Error("Missing capture worker");
  worker.port.postMessage = () => {};
  const snapshot = expect(capture.snapshot()).rejects.toMatchObject({ failure: "failed" });
  controller.abort();
  await snapshot;
  expect(vi.getTimerCount()).toBe(0);
  expect(tracks[0]?.stop).toHaveBeenCalledOnce();
});
