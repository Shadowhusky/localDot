// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { slot, usePreview } from "./usePreview.ts";

describe("preview slots", () => {
  it("lets two previews load at once and starts the third when one finishes", async () => {
    const signal = new AbortController().signal;
    const first = await slot(signal);
    const second = await slot(signal);
    let third = false;
    const waiting = slot(signal).then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    first();
    first(); // releasing twice frees one slot only
    const release = await waiting;
    expect(third).toBe(true);
    second();
    release();
  });
  it("drops a queued preview whose file went away", async () => {
    const signal = new AbortController().signal;
    const a = await slot(signal);
    const b = await slot(signal);
    const gone = new AbortController();
    const queued = slot(gone.signal);
    gone.abort(new Error("unmounted"));
    await expect(queued).rejects.toThrow("unmounted");
    a();
    b();
    const next = await slot(signal);
    const other = await slot(signal);
    next();
    other();
  });
});

describe("a file's preview", () => {
  it("keeps showing while the file folds away, and each version loads once until it leaves", async () => {
    const asked: string[] = [];
    const api = createApi("a".repeat(43), {
      origin: "http://127.0.0.1:4750",
      fetchImpl: async (url) => {
        asked.push(new URL(String(url)).search);
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        });
      },
    });
    let made = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++made}`);
    URL.revokeObjectURL = vi.fn();
    const target = { current: null };
    const hook = renderHook(
      ({ shown, version }) =>
        usePreview(api, target, "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", "chart.png", version, shown, 0),
      { initialProps: { shown: true, version: 1 } },
    );
    await waitFor(() => expect(hook.result.current).toMatchObject({ url: "blob:1" }));
    hook.rerender({ shown: false, version: 1 });
    expect(hook.result.current).toMatchObject({ state: "image", url: "blob:1" });
    hook.rerender({ shown: true, version: 2 });
    await waitFor(() => expect(hook.result.current).toMatchObject({ url: "blob:2" }));
    hook.rerender({ shown: true, version: 1 });
    expect(hook.result.current).toMatchObject({ state: "image", url: "blob:1" });
    await act(async () => {});
    expect(asked).toEqual(["?v=1", "?v=2"]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    hook.unmount();
    expect(
      vi
        .mocked(URL.revokeObjectURL)
        .mock.calls.map(([url]) => url)
        .sort(),
    ).toEqual(["blob:1", "blob:2"]);
  });
});
