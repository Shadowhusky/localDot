// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSupport, opfsSink, pickFileSink } from "./sink.ts";

afterEach(() => {
  vi.unstubAllGlobals();
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
  const save = vi.fn(async () => ({ createWritable }));
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
