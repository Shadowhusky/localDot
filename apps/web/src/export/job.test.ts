// @vitest-environment jsdom
import { emptyModel } from "@localdot/stage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportContext } from "./export-context.ts";
import type { ExportRequest } from "./export-plan.ts";
import type { ExportOut } from "./export-protocol.ts";
import type { ExportSink } from "./sink.ts";

type Result = Extract<ExportOut, { type: "done" | "cancelled" | "error" }>;
type Progress = Extract<ExportOut, { type: "progress" }>;

const run = vi.hoisted(() => ({
  sink: null as ExportSink | null,
  finish: (_result: Result) => {},
  progress: (_value: Progress) => {},
  cancel: vi.fn(),
}));
vi.mock("./exporter.ts", () => ({
  startExport: (options: { sink: ExportSink }) => {
    run.sink = options.sink;
    return {
      done: new Promise<Result>((resolve) => {
        run.finish = resolve;
      }),
      cancel: run.cancel,
      onProgress(callback: (value: Progress) => void) {
        run.progress = callback;
      },
    };
  },
}));

const { CANCELLED_NOTE, createExportJob } = await import("./job.ts");

const sessionId = "01K00000000000000000000000";
const context = {
  sessionId,
  model: emptyModel(),
  activity: [],
  gaps: [],
  source: { sessionId, origin: "http://localhost", authorization: "", video: null, gaps: [] },
  whole: { fromMs: 0, toMs: 60_000 },
  chapter: null,
  selection: null,
  atMs: 0,
} satisfies ExportContext;
const request: ExportRequest = {
  sessionId,
  fromMs: 0,
  toMs: 60_000,
  speed: 2,
  skipIdle: true,
  captions: true,
  overlays: true,
  size: { w: 1280, h: 800 },
  fps: 30,
  quality: "high",
  format: "mp4",
};
const expected = { durationS: 30, fitted: { bytes: 1_000_000, ms: 2000 } };
const done = (bytes: number) => ({ type: "done" as const, frames: 30, bytes, hashes: null });

beforeEach(() => {
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 8, 9, 1));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  run.cancel.mockReset();
  run.sink = null;
});

describe("an export without a save picker", () => {
  it("makes the video, then saves it as a download when asked, as often as asked", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(`${this.download} ${this.href}`);
    });
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: revoke }),
    );
    const job = createExportJob();
    const seen: string[] = [];
    job.subscribe(() => seen.push(job.snapshot().phase));
    const starting = job.start(context, request, expected);
    await vi.waitFor(() => expect(job.snapshot().phase).toBe("exporting"));
    expect(job.snapshot().context).toBe(context);
    run.progress({ type: "progress", done: 12, total: 40, openFrames: 1, encodeQueue: 1 });
    expect(job.snapshot()).toMatchObject({ done: 12, total: 40 });
    await run.sink?.write(0, new Uint8Array(2048));
    await run.sink?.close();
    run.finish(done(2048));
    await starting;
    expect(job.snapshot()).toMatchObject({
      phase: "ready",
      file: { name: "localdot-2026-10-08-0901.mp4", bytes: 2048, durationS: 30 },
    });
    expect(names).toEqual([]);
    job.save();
    expect(names).toEqual(["localdot-2026-10-08-0901.mp4 blob:x"]);
    expect(job.snapshot().phase).toBe("downloaded");
    // Safari on a phone asks first and the person may say no, so the file stays to be saved again.
    vi.useFakeTimers();
    vi.advanceTimersByTime(10 * 60_000);
    expect(revoke).not.toHaveBeenCalled();
    job.save();
    expect(names).toEqual([
      "localdot-2026-10-08-0901.mp4 blob:x",
      "localdot-2026-10-08-0901.mp4 blob:x",
    ]);
    job.dismiss();
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(job.snapshot().phase).toBe("options");
    job.save();
    expect(names).toHaveLength(2);
    expect(seen).toContain("ready");
  });

  it("keeps a finished video waiting to be saved when the popover is put away", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = createExportJob();
    const starting = job.start(context, request, expected);
    await vi.waitFor(() => expect(run.sink).not.toBeNull());
    await run.sink?.close();
    run.finish(done(0));
    await starting;
    job.dismiss();
    expect(job.snapshot().phase).toBe("ready");
  });
});

describe("an export through the save picker", () => {
  it("saves under the name the person chose", async () => {
    const stream = { write: vi.fn(), close: vi.fn(async () => {}), abort: vi.fn() };
    vi.stubGlobal(
      "showSaveFilePicker",
      vi.fn(async () => ({ name: "Quarterly.mp4", createWritable: async () => stream })),
    );
    const job = createExportJob();
    const starting = job.start(context, request, { ...expected, durationS: 12 });
    expect(job.snapshot().phase).toBe("picking");
    await vi.waitFor(() => expect(job.snapshot().phase).toBe("exporting"));
    run.finish(done(5000));
    await starting;
    expect(job.snapshot()).toMatchObject({
      phase: "saved",
      file: { name: "Quarterly.mp4", bytes: 5000, durationS: 12 },
    });
  });

  it("goes back to the choices when the picker is dismissed", async () => {
    vi.stubGlobal(
      "showSaveFilePicker",
      vi.fn(async () => {
        throw new DOMException("Cancelled", "AbortError");
      }),
    );
    const job = createExportJob();
    await job.start(context, request, { ...expected, durationS: 12 });
    expect(job.snapshot()).toMatchObject({ phase: "options", note: null });
  });
});

describe("an export that does not finish", () => {
  it("says a cancelled export saved nothing, until the popover is put away", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = createExportJob();
    const starting = job.start(context, request, expected);
    await vi.waitFor(() => expect(job.snapshot().phase).toBe("exporting"));
    job.cancel();
    expect(run.cancel).toHaveBeenCalledOnce();
    run.finish({ type: "cancelled" });
    await starting;
    expect(job.snapshot()).toMatchObject({ phase: "options", note: CANCELLED_NOTE, context: null });
    job.dismiss();
    expect(job.snapshot().note).toBeNull();
  });

  it("stops the export when Replay closes and ignores what it reports after", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = createExportJob();
    const listener = vi.fn();
    job.subscribe(listener);
    const starting = job.start(context, request, expected);
    await vi.waitFor(() => expect(job.snapshot().phase).toBe("exporting"));
    listener.mockClear();
    job.dispose();
    expect(run.cancel).toHaveBeenCalledOnce();
    run.progress({ type: "progress", done: 30, total: 40, openFrames: 1, encodeQueue: 1 });
    run.finish({ type: "cancelled" });
    await starting;
    expect(listener).not.toHaveBeenCalled();
    expect(job.snapshot().phase).toBe("options");
  });

  it("says why when the browser cannot make video", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    const job = createExportJob();
    await job.start(context, request, expected);
    expect(job.snapshot()).toMatchObject({
      phase: "options",
      note: "Export needs Chrome, Edge or Safari 17 or later",
    });
  });
});

describe("what a finished export leaves behind", () => {
  it("names a WebM video for its format and saves it as one", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = createExportJob();
    const starting = job.start(context, { ...request, format: "webm" }, expected);
    await vi.waitFor(() => expect(run.sink).not.toBeNull());
    await run.sink?.write(0, new Uint8Array(16));
    await run.sink?.close();
    run.finish(done(16));
    await starting;
    expect(job.snapshot().file?.name).toBe("localdot-2026-10-08-0901.webm");
  });

  it("learns how this browser's export compared with the estimate", async () => {
    localStorage.clear();
    const stream = { write: vi.fn(), close: vi.fn(async () => {}), abort: vi.fn() };
    vi.stubGlobal(
      "showSaveFilePicker",
      vi.fn(async () => ({ name: "a.mp4", createWritable: async () => stream })),
    );
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const job = createExportJob();
    const starting = job.start(context, request, expected);
    await vi.waitFor(() => expect(job.snapshot().phase).toBe("exporting"));
    clock.mockReturnValue(1000 + 3000);
    run.finish(done(2_000_000));
    await starting;
    expect(job.snapshot().file?.ms).toBe(3000);
    expect(JSON.parse(localStorage.getItem("localdot.export-calibration.v1") ?? "")).toEqual({
      time: 1.5,
      size: 2,
    });
  });
});
