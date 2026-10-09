// @vitest-environment jsdom
import { emptyModel } from "@localdot/stage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportIn, ExportOut } from "./export-protocol.ts";
import { startExport } from "./exporter.ts";
import { type ExportSink, ExportTooLongError, LONG_EXPORT } from "./sink.ts";

vi.mock("../stage/theme.ts", () => ({ readTheme: () => ({}) }));

class TestWorker {
  static latest: TestWorker;
  messages: ExportIn[] = [];
  onmessage?: (event: { data: ExportOut }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminate = vi.fn();
  constructor() {
    TestWorker.latest = this;
  }
  postMessage(message: ExportIn) {
    this.messages.push(message);
  }
  emit(message: ExportOut) {
    this.onmessage?.({ data: message });
  }
}

const sessionId = "01K00000000000000000000000";
const complete = { type: "done" as const, frames: 30, bytes: 4, hashes: null };
function chunk(index = 0) {
  return { type: "chunk" as const, chunk: index, position: index * 4, data: new ArrayBuffer(4) };
}
function setup() {
  const sink = {
    write: vi.fn<ExportSink["write"]>().mockResolvedValue(),
    close: vi.fn<ExportSink["close"]>().mockResolvedValue(),
    abort: vi.fn<ExportSink["abort"]>().mockResolvedValue(),
  };
  const handle = startExport({
    request: {
      sessionId,
      fromMs: 0,
      toMs: 1000,
      speed: 1,
      skipIdle: true,
      size: { w: 1280, h: 800 },
      captions: true,
    },
    source: {
      sessionId,
      origin: "http://localhost",
      authorization: "Bearer fake",
      video: null,
      gaps: [],
    },
    model: emptyModel(),
    activity: [],
    gaps: [],
    sink,
    hashes: true,
  });
  return { sink, handle, worker: TestWorker.latest };
}
beforeEach(() => {
  vi.stubGlobal("Worker", TestWorker);
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.unstubAllGlobals());

describe("export file ownership", () => {
  it("acknowledges only written chunks and commits once after the final acknowledgement", async () => {
    const { sink, handle, worker } = setup();
    let release: () => void = () => {};
    sink.write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    worker.emit(chunk());
    await vi.waitFor(() => expect(sink.write).toHaveBeenCalledOnce());
    expect(worker.messages).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(worker.messages.at(-1)).toEqual({ type: "ack", chunk: 0 }));
    worker.emit(complete);
    expect(await handle.done).toEqual(complete);
    worker.emit(complete);
    expect(sink.close).toHaveBeenCalledOnce();
    expect(sink.abort).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("cancels ownership immediately and ignores late output without committing", async () => {
    const { sink, handle, worker } = setup();
    handle.cancel();
    worker.emit(chunk());
    worker.emit(complete);
    handle.cancel();
    worker.emit({ type: "cancelled" });
    expect(await handle.done).toEqual({ type: "cancelled" });
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(sink.close).not.toHaveBeenCalled();
    expect(sink.write).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("aborts rather than acknowledging a failed disk write", async () => {
    const { sink, handle, worker } = setup();
    sink.write.mockRejectedValue(new Error("disk full"));
    worker.emit(chunk());
    expect((await handle.done).type).toBe("error");
    expect(worker.messages.some((message) => message.type === "ack")).toBe(false);
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(sink.close).not.toHaveBeenCalled();
  });
  it("says a long export needs another browser when the download path fills", async () => {
    const { sink, handle, worker } = setup();
    sink.write.mockRejectedValue(new ExportTooLongError());
    worker.emit(chunk());
    expect(await handle.done).toEqual({ type: "error", message: LONG_EXPORT });
    expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("rejects completion before its chunks have been written", async () => {
    const { sink, handle, worker } = setup();
    worker.emit(chunk());
    worker.emit(complete);
    expect((await handle.done).type).toBe("error");
    expect(sink.close).not.toHaveBeenCalled();
    expect(sink.abort).toHaveBeenCalledOnce();
  });
  it.each(["duplicate", "unbounded", "invalid position"])(
    "rejects %s chunk messages",
    async (kind) => {
      const { sink, handle, worker } = setup();
      if (kind === "duplicate") {
        worker.emit(chunk());
        worker.emit(chunk());
      }
      if (kind === "unbounded") for (let index = 0; index < 5; index++) worker.emit(chunk(index));
      if (kind === "invalid position") worker.emit({ ...chunk(), position: -1 });
      expect((await handle.done).type).toBe("error");
      expect(sink.close).not.toHaveBeenCalled();
    },
  );
  it("reports commit failure and aborts the file", async () => {
    const { sink, handle, worker } = setup();
    sink.close.mockRejectedValue(new Error("commit refused"));
    worker.emit(complete);
    expect((await handle.done).type).toBe("error");
    expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("cleans up when the worker crashes", async () => {
    const { sink, handle, worker } = setup();
    worker.onerror?.();
    expect((await handle.done).type).toBe("error");
    expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("only enables frame hashes through the explicit probe flag", async () => {
    const first = setup();
    expect(first.worker.messages[0]).toMatchObject({ type: "start", hashes: false });
    first.handle.cancel();
    first.worker.emit({ type: "cancelled" });
    await first.handle.done;
    window.history.replaceState(null, "", "/?exportProbe=1");
    const second = setup();
    expect(second.worker.messages[0]).toMatchObject({ type: "start", hashes: true });
    second.handle.cancel();
    second.worker.emit({ type: "cancelled" });
    await second.handle.done;
  });
});
