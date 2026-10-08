// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_LIMIT,
  downloadFile,
  ExportTooLongError,
  exportSupport,
  LONG_EXPORT,
  memorySink,
  NO_ENCODER,
  opfsSink,
  pickFileSink,
} from "./sink.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

function fakeFile() {
  const operations: { position: number; data: Uint8Array }[] = [];
  const stream = {
    write: vi.fn(async (write: { position: number; data: Uint8Array }) => {
      operations.push(write);
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const createWritable = vi.fn(async () => stream);
  const save = vi.fn(async () => ({ name: "", createWritable }));
  vi.stubGlobal("showSaveFilePicker", save);
  return { operations, stream, createWritable, save };
}

describe("streamed export files", () => {
  it("writes positioned chunks in order and closes after all writes", async () => {
    const file = fakeFile();
    const sink = await pickFileSink("localdot-date.mp4");
    if (!sink) throw new Error("The picker was unexpectedly cancelled.");
    const first = sink.write(16, Uint8Array.of(1, 2));
    const patch = sink.write(0, Uint8Array.of(3));
    const closing = sink.close();
    await Promise.all([first, patch, closing]);
    expect(file.operations.map((entry) => entry.position)).toEqual([16, 0]);
    expect(file.stream.close).toHaveBeenCalledOnce();
    expect(file.save).toHaveBeenCalledWith({
      suggestedName: "localdot-date.mp4",
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
    await expect(sink.write(2, Uint8Array.of(4))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts queued chunks without committing the swap file", async () => {
    const file = fakeFile();
    const sink = await pickFileSink("localdot-date.mp4");
    if (!sink) throw new Error("Missing sink.");
    const writing = sink.write(0, Uint8Array.of(1));
    const failedWrite = expect(writing).rejects.toMatchObject({ name: "AbortError" });
    await sink.abort();
    await failedWrite;
    await sink.abort();
    expect(file.operations).toEqual([]);
    expect(file.stream.abort).toHaveBeenCalledOnce();
    expect(file.stream.close).not.toHaveBeenCalled();
    await expect(sink.close()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates write failures without closing and permits cleanup", async () => {
    const file = fakeFile();
    file.stream.write.mockRejectedValueOnce(new Error("Disk full"));
    const sink = await pickFileSink("localdot-date.mp4");
    if (!sink) throw new Error("Missing sink.");
    await expect(sink.write(0, Uint8Array.of(1))).rejects.toThrow("Disk full");
    await expect(sink.close()).rejects.toThrow("Disk full");
    await sink.abort();
    expect(file.stream.close).not.toHaveBeenCalled();
    expect(file.stream.abort).toHaveBeenCalledOnce();
  });

  it("distinguishes picker cancellation from file failures", async () => {
    const file = fakeFile();
    file.save.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    expect(await pickFileSink("localdot-date.mp4")).toBeNull();
    expect(file.createWritable).not.toHaveBeenCalled();
    file.createWritable.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(pickFileSink("localdot-date.mp4")).rejects.toThrow("Permission denied");
  });

  it("requires the probe flag before touching OPFS and reports missing browser features", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    expect(exportSupport().ok).toBe(false);
    await expect(opfsSink("localdot-export-probe.mp4")).rejects.toThrow("disabled");
    window.history.replaceState(null, "", "/?exportProbe=1");
    await expect(opfsSink("../other.mp4")).rejects.toThrow(RangeError);
  });
});

describe("where the browser can save an export", () => {
  it("saves through a download where the browser can make video but has no save picker", () => {
    vi.stubGlobal("VideoEncoder", class {});
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("showSaveFilePicker", undefined);
    expect(exportSupport()).toEqual({ ok: true, save: "download" });
    vi.stubGlobal("showSaveFilePicker", vi.fn());
    expect(exportSupport()).toEqual({ ok: true, save: "picker" });
  });

  it("says what the browser lacks when it cannot make video", () => {
    vi.stubGlobal("VideoEncoder", undefined);
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("showSaveFilePicker", vi.fn());
    expect(exportSupport()).toEqual({ ok: false, reason: NO_ENCODER });
  });

  it("names the file the person chose in the picker", async () => {
    const file = fakeFile();
    file.save.mockResolvedValueOnce({ name: "Report.mp4", createWritable: file.createWritable });
    expect((await pickFileSink("localdot-date.mp4"))?.name).toBe("Report.mp4");
  });
});

describe("the download path's in-memory file", () => {
  async function bytes(blob: Blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  it("assembles positioned writes, a patch to its start and a write across blocks", async () => {
    const sink = memorySink();
    const block = 4 * 1024 * 1024;
    await sink.write(4, Uint8Array.of(5, 6, 7));
    await sink.write(block - 2, Uint8Array.of(8, 9, 10, 11));
    await sink.write(0, Uint8Array.of(1, 2, 3, 4));
    await sink.close();
    const blob = sink.blob();
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBe(block + 2);
    const all = await bytes(blob);
    expect([...all.subarray(0, 7)]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...all.subarray(block - 2)]).toEqual([8, 9, 10, 11]);
    expect(all[100]).toBe(0);
  });

  it("stops a video that outgrows what a page should hold, with the reason", async () => {
    const sink = memorySink(16);
    await sink.write(0, new Uint8Array(16));
    const over = sink.write(16, Uint8Array.of(1));
    await expect(over).rejects.toBeInstanceOf(ExportTooLongError);
    await expect(over).rejects.toThrow(LONG_EXPORT);
    expect(DOWNLOAD_LIMIT).toBe(256 * 1024 * 1024);
  });

  it("refuses writes once aborted and has no file before it is closed", async () => {
    const sink = memorySink();
    await sink.write(0, Uint8Array.of(1));
    expect(() => sink.blob()).toThrow();
    await sink.abort();
    await expect(sink.write(1, Uint8Array.of(2))).rejects.toMatchObject({ name: "AbortError" });
    await expect(sink.close()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("downloads the file under its name and leaves its address to the caller", () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: revoke }));
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    downloadFile("blob:video", "localdot-2026-10-08-0901.mp4");
    expect(clicked).toEqual([{ href: "blob:video", download: "localdot-2026-10-08-0901.mp4" }]);
    expect(document.querySelector("a[download]")).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(revoke).not.toHaveBeenCalled();
  });
});
