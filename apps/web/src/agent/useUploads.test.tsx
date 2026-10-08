// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { Attachments } from "./Attachments.tsx";
import { FILE_LIMITS } from "./file-transfer.ts";
import { useUploads } from "./useUploads.ts";

const CELL = "01JXYZ0000000000000000CE11",
  OTHER = "01JXYZ00000000000000000002";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const file = (name: string, size = 1) => {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const setup = (fetchImpl: typeof fetch) => {
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
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
describe("serial uploads owned by the ready computer", () => {
  it("serializes synchronous selections and exposes no message paths until every upload is confirmed", async () => {
    const first = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("one.txt")
        ? first.promise
        : Response.json({ path: "~/Downloads/two.txt" }, { status: 201 }),
    );
    const f = setup(fetchImpl);
    act(() => {
      f.result.current.select([file("one.txt")]);
      f.result.current.select([file("two.txt")]);
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(f.result.current.forMessage()).toBeNull();
    expect(f.result.current.rows.map((r) => r.phase)).toEqual(["uploading", "pending"]);
    await act(async () =>
      first.resolve(Response.json({ path: "~/Downloads/one.txt" }, { status: 201 })),
    );
    await waitFor(() =>
      expect(f.result.current.rows.map((r) => r.phase)).toEqual(["complete", "complete"]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.result.current.forMessage()?.map((row) => row.path)).toEqual([
      "~/Downloads/one.txt",
      "~/Downloads/two.txt",
    ]);
  });
  it("checks aggregate bytes and duplicate names before any admission", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const f = setup(fetchImpl);
    act(() => f.result.current.select([file("one.bin", FILE_LIMITS.bytes), file("two.bin", 1)]));
    expect(f.result.current.rows).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    act(() => f.result.current.select([file("same.txt"), file("same.txt")]));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.result.current.rows).toEqual([]);
  });
  it("marks admitted cancellation uncertain, refuses unstarted queued work and never retries automatically", async () => {
    const late = Promise.withResolvers<Response>();
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal;
      return late.promise;
    });
    const f = setup(fetchImpl);
    act(() => f.result.current.select([file("one.txt"), file("two.txt")]));
    act(() => f.result.current.cancel());
    expect(signal?.aborted).toBe(true);
    expect(f.result.current.rows.map((r) => r.phase)).toEqual(["uncertain", "refused"]);
    expect(f.result.current.forMessage()).toBeNull();
    await act(async () =>
      late.resolve(Response.json({ path: "~/Downloads/one.txt" }, { status: 201 })),
    );
    expect(f.result.current.rows[0]?.phase).toBe("uncertain");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("retires late metadata after another computer or API takes ownership", async () => {
    const late = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn<typeof fetch>(async () => late.promise);
    const f = setup(fetchImpl);
    act(() => f.result.current.select([file("one.txt")]));
    f.update({ cellId: OTHER });
    expect(f.result.current.rows).toEqual([]);
    await act(async () =>
      late.resolve(Response.json({ path: "~/Downloads/one.txt" }, { status: 201 })),
    );
    expect(f.result.current.rows).toEqual([]);
    expect(f.result.current.forMessage()).toEqual([]);
  });
  it("aborts on pagehide and does not restore or cite the upload on return", async () => {
    const late = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn<typeof fetch>(async () => late.promise);
    const f = setup(fetchImpl);
    act(() => f.result.current.select([file("one.txt")]));
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    expect(f.result.current.rows[0]?.phase).toBe("uncertain");
    await act(async () =>
      late.resolve(Response.json({ path: "~/Downloads/one.txt" }, { status: 201 })),
    );
    expect(f.result.current.forMessage()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("drops confirmed draft attachments when Stop removes readiness", async () => {
    const f = setup(async () => Response.json({ path: "~/Downloads/one.txt" }, { status: 201 }));
    act(() => f.result.current.select([file("one.txt")]));
    await waitFor(() => expect(f.result.current.rows[0]?.phase).toBe("complete"));
    f.update({ ready: false });
    expect(f.result.current.rows).toEqual([]);
    expect(f.result.current.forMessage()).toBeNull();
  });
  it("refuses key-shaped file metadata without retaining the name in observable rows", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const f = setup(fetchImpl);
    const name = `sk-proj-${"z".repeat(80)}`;
    act(() => f.result.current.select([file(name)]));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(f.result.current.rows)).not.toContain(name);
    expect(f.result.current.problem).not.toContain(name);
  });
});
describe("removed attachments notice", () => {
  const REMOVED =
    "Your computer was interrupted, so the files you added were removed. Add them again.";
  it("says nothing when a computer starts, stops or changes with no attachments", () => {
    const f = setup(vi.fn<typeof fetch>());
    f.update({ cellId: null as unknown as string, ready: false });
    f.update({ cellId: CELL, ready: true });
    f.update({ ready: false });
    f.update({ cellId: OTHER, ready: true });
    expect(f.result.current.notice).toBeNull();
    expect(f.result.current.problem).toBeNull();
  });
  it("tells the user to add files again only when attachments were removed", async () => {
    const f = setup(async () => Response.json({ path: "~/Downloads/one.txt" }, { status: 201 }));
    act(() => f.result.current.select([file("one.txt")]));
    await waitFor(() => expect(f.result.current.rows[0]?.phase).toBe("complete"));
    f.update({ cellId: OTHER });
    expect(f.result.current.rows).toEqual([]);
    expect(f.result.current.notice).toBe(REMOVED);
    expect(f.result.current.problem).toBeNull();
    act(() => f.result.current.select([file("two.txt")]));
    expect(f.result.current.notice).toBeNull();
  });
  it("announces the removal politely rather than as an alert", async () => {
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4747",
      fetchImpl: async () => Response.json({ path: "~/Downloads/one.txt" }, { status: 201 }),
    });
    let select: ReturnType<typeof useUploads>["select"] = () => {};
    function Harness({ cellId }: { cellId: string }) {
      const uploads = useUploads({ api, cellId, ready: true, enabled: true });
      select = uploads.select;
      return <Attachments uploads={uploads} disabled={false} />;
    }
    const view = render(<Harness cellId={CELL} />);
    expect(screen.queryByText(REMOVED)).toBeNull();
    act(() => select([file("one.txt")]));
    await screen.findByText("Uploaded to Downloads");
    view.rerender(<Harness cellId={OTHER} />);
    expect(screen.getByText(REMOVED).getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
