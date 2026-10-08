// @vitest-environment jsdom
import { emptyModel } from "@localdot/stage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportIn, ExportOut } from "./export-protocol.ts";
import { startExport } from "./exporter.ts";
import { pickFileSink } from "./sink.ts";

vi.mock("../stage/theme.ts", () => ({ readTheme: () => ({}) }));
class WorkerFixture {
  static latest: WorkerFixture;
  onmessage?: (event: { data: ExportOut }) => void;
  messages: ExportIn[] = [];
  terminate = vi.fn();
  constructor() {
    WorkerFixture.latest = this;
  }
  postMessage(message: ExportIn) {
    this.messages.push(message);
  }
  emit(data: ExportOut) {
    this.onmessage?.({ data });
  }
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const stream = {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  vi.stubGlobal("showSaveFilePicker", async () => ({ createWritable: async () => stream }));
  const sink = await pickFileSink("localdot-2026-10-05.mp4");
  if (!sink) throw new Error("Missing fixture sink");
  const sessionId = "01K00000000000000000000000";
  const handle = startExport({
    request: {
      sessionId,
      fromMs: 0,
      toMs: 1000,
      speed: 1,
      skipIdle: false,
      captions: false,
      size: { w: 1280, h: 800 },
    },
    source: {
      sessionId,
      origin: "http://inert.invalid",
      authorization: "Bearer fixture",
      video: null,
      gaps: [],
    },
    model: emptyModel(),
    activity: [],
    gaps: [],
    sink,
  });
  return { handle, stream, worker: WorkerFixture.latest };
}
beforeEach(() => vi.stubGlobal("Worker", WorkerFixture));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("independent file and worker completion ownership", () => {
  it("forces a nonresponsive cancelled worker closed after one second and cannot commit late output", async () => {
    vi.useFakeTimers();
    const { handle, stream, worker } = await setup();
    handle.cancel();
    await vi.advanceTimersByTimeAsync(999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await handle.done).toEqual({ type: "cancelled" });
    worker.emit({ type: "done", frames: 30, bytes: 0, hashes: null });
    worker.emit({ type: "chunk", chunk: 0, position: 0, data: new ArrayBuffer(4) });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    expect(stream.write).not.toHaveBeenCalled();
  });
  it("holds cancelled completion until the admitted file write settles, then aborts with no acknowledgement", async () => {
    const { handle, stream, worker } = await setup();
    const writing = deferred();
    stream.write.mockImplementation(() => writing.promise);
    worker.emit({ type: "chunk", chunk: 0, position: 0, data: new ArrayBuffer(4) });
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledOnce());
    handle.cancel();
    worker.emit({ type: "cancelled" });
    let completed = false;
    void handle.done.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(stream.abort).not.toHaveBeenCalled();
    writing.resolve();
    expect(await handle.done).toEqual({ type: "cancelled" });
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    expect(worker.messages.filter((message) => message.type === "ack")).toEqual([]);
  });
  it("reports success only after file commit, and cancellation cannot steal an admitted commit", async () => {
    const { handle, stream, worker } = await setup();
    const commit = deferred();
    stream.close.mockImplementation(() => commit.promise);
    const complete = { type: "done" as const, frames: 30, bytes: 0, hashes: null };
    worker.emit(complete);
    await vi.waitFor(() => expect(stream.close).toHaveBeenCalledOnce());
    let finished = false;
    void handle.done.then(() => {
      finished = true;
    });
    handle.cancel();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(stream.abort).not.toHaveBeenCalled();
    commit.resolve();
    expect(await handle.done).toEqual(complete);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(stream.abort).not.toHaveBeenCalled();
  });
});
