// @vitest-environment jsdom
import { USER_UPLOAD } from "@localdot/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { FileTransferFailure } from "./file-transfer.ts";
import { useUploads } from "./useUploads.ts";

const transfer = vi.hoisted(() => ({ uploadFile: vi.fn(), discardUpload: vi.fn(async () => {}) }));
vi.mock("./resumable-upload.ts", () => transfer);
const CELL = "01JXYZ0000000000000000CE11",
  OTHER = "01JXYZ00000000000000000002";
beforeEach(() => {
  transfer.uploadFile.mockReset();
  transfer.discardUpload.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const file = (name: string, size = 1) => {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const setup = () => {
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl: vi.fn() });
  let props = { api, cellId: CELL, ready: true, enabled: true };
  const view = renderHook((p) => useUploads(p), { initialProps: props });
  return {
    ...view,
    update: (over: Partial<typeof props>) => {
      props = { ...props, ...over };
      view.rerender(props);
    },
  };
};
describe("user-owned resumable attachment queue", () => {
  it("serializes selections and only attaches verified complete files", async () => {
    const first = Promise.withResolvers<string>();
    transfer.uploadFile.mockImplementation(async (_api, _cell, f) =>
      f.name === "one.zip" ? first.promise : `~/Downloads/${f.name}`,
    );
    const f = setup();
    act(() => {
      f.result.current.select([file("one.zip", 200 * 1024 ** 2)]);
      f.result.current.select([file("two.txt")]);
    });
    expect(transfer.uploadFile).toHaveBeenCalledOnce();
    expect(f.result.current.forMessage()).toBeNull();
    expect(f.result.current.rows.map((r) => r.phase)).toEqual(["uploading", "pending"]);
    await act(async () => first.resolve("~/Downloads/one.zip"));
    await waitFor(() =>
      expect(f.result.current.rows.map((r) => r.phase)).toEqual(["complete", "complete"]),
    );
    expect(f.result.current.forMessage()?.map((r) => r.path)).toEqual([
      "~/Downloads/one.zip",
      "~/Downloads/two.txt",
    ]);
  });
  it("does not cancel when hidden or task freshness disables the composer", async () => {
    const pending = Promise.withResolvers<string>();
    transfer.uploadFile.mockReturnValue(pending.promise);
    const f = setup();
    act(() => f.result.current.select([file("large.zip")]));
    const signal = transfer.uploadFile.mock.calls[0]?.[3] as AbortSignal;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    f.update({ enabled: false });
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve("~/Downloads/large.zip"));
    expect(f.result.current.rows[0]?.phase).toBe("complete");
  });
  it("resumes the same File and upload ID after offline or page suspension", async () => {
    const late = Promise.withResolvers<string>();
    transfer.uploadFile.mockReturnValueOnce(late.promise).mockResolvedValue("~/Downloads/data.zip");
    const f = setup(),
      data = file("data.zip");
    act(() => f.result.current.select([data]));
    const original = transfer.uploadFile.mock.calls[0];
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    expect(original?.[3].aborted).toBe(true);
    expect(f.result.current.rows[0]?.phase).toBe("uncertain");
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow")));
    expect(transfer.uploadFile.mock.calls[1]?.[2]).toBe(data);
    expect(transfer.uploadFile.mock.calls[1]?.[4].id).toBe(original?.[4].id);
    expect(f.result.current.rows[0]?.phase).toBe("complete");
    await act(async () => late.resolve("~/wrong-late-reply"));
    expect(f.result.current.rows[0]?.path).toBe("~/Downloads/data.zip");
  });
  it("keeps the source for explicit Retry after interrupted network attempts", async () => {
    transfer.uploadFile
      .mockRejectedValueOnce(new FileTransferFailure(true, undefined, "Paused"))
      .mockResolvedValue("~/Downloads/a.zip");
    const f = setup();
    act(() => f.result.current.select([file("a.zip")]));
    await waitFor(() => expect(f.result.current.rows[0]?.phase).toBe("uncertain"));
    act(() => f.result.current.retry(f.result.current.rows[0]?.id ?? 0));
    await waitFor(() => expect(f.result.current.rows[0]?.phase).toBe("complete"));
    expect(transfer.uploadFile.mock.calls[1]?.[4].id).toBe(
      transfer.uploadFile.mock.calls[0]?.[4].id,
    );
  });
  it("cancelling one upload does not cancel the next queued file", async () => {
    transfer.uploadFile
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue("~/Downloads/b.zip");
    const f = setup();
    act(() => f.result.current.select([file("a.zip"), file("b.zip")]));
    act(() => f.result.current.remove(f.result.current.rows[0]?.id ?? 0));
    await waitFor(() => expect(f.result.current.rows[0]?.phase).toBe("complete"));
    expect(f.result.current.rows[0]?.name).toBe("b.zip");
    expect(transfer.discardUpload).toHaveBeenCalledOnce();
  });
  it("retires stale receipts on a computer switch but retains confirmed files across temporary readiness loss", async () => {
    transfer.uploadFile.mockResolvedValue("~/Downloads/one.zip");
    const f = setup();
    act(() => f.result.current.select([file("one.zip")]));
    await waitFor(() => expect(f.result.current.rows[0]?.phase).toBe("complete"));
    f.update({ ready: false });
    expect(f.result.current.forMessage()).toBeNull();
    f.update({ ready: true });
    expect(f.result.current.forMessage()).toHaveLength(1);
    f.update({ cellId: OTHER });
    expect(f.result.current.rows).toEqual([]);
    expect(f.result.current.forMessage()).toEqual([]);
  });
  it("brings back files a message carried as finished chips, without uploading or deleting them", () => {
    const f = setup();
    const paths = ["~/Downloads/Uploads/a/notes.txt", "~/Downloads/Uploads/b/totals.csv"];
    act(() => f.result.current.restore(paths));
    act(() => f.result.current.restore([paths[1] as string]));
    expect(f.result.current.rows.map((row) => [row.name, row.phase, row.bytes])).toEqual([
      ["notes.txt", "complete", undefined],
      ["totals.csv", "complete", undefined],
    ]);
    expect(f.result.current.blocked).toBe(false);
    expect(f.result.current.forMessage()?.map((row) => row.path)).toEqual(paths);
    act(() => f.result.current.remove(f.result.current.rows[0]?.id ?? 0));
    expect(f.result.current.rows.map((row) => row.path)).toEqual([paths[1]]);
    expect(transfer.uploadFile).not.toHaveBeenCalled();
    expect(transfer.discardUpload).not.toHaveBeenCalled();
  });
  it("accepts same-named files safely but enforces per-file, draft and name limits", () => {
    transfer.uploadFile.mockReturnValue(new Promise(() => {}));
    const f = setup();
    act(() => f.result.current.select([file("large.zip", USER_UPLOAD.bytes + 1)]));
    expect(transfer.uploadFile).not.toHaveBeenCalled();
    act(() =>
      f.result.current.select([
        file("a", USER_UPLOAD.bytes),
        file("b", USER_UPLOAD.bytes),
        file("c"),
      ]),
    );
    expect(transfer.uploadFile).not.toHaveBeenCalled();
    act(() => f.result.current.select([file(`sk-proj-${"z".repeat(80)}`)]));
    expect(transfer.uploadFile).not.toHaveBeenCalled();
    act(() => f.result.current.select([file("same.zip"), file("same.zip")]));
    expect(f.result.current.rows).toHaveLength(2);
  });
});
