// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "../lib/api.ts";
import * as keysApi from "./keys-api.ts";
import { useKeys } from "./useKeys.ts";

const record = { id: "weather", kind: "http", createdAt: "t", updatedAt: "t" } as const;
const health = (bootId = "one") => ({ online: true, bootId, sealKey: "key" });
function server(reply: (path: string, method: string) => unknown | Promise<unknown>) {
  const calls: string[] = [];
  const api = createApi("test", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      return new Response(JSON.stringify(await reply(path, method)));
    },
  });
  return { api, calls };
}
const flush = () => act(async () => {});
const advance = (ms = 100) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useKeys", () => {
  it("waits for a health request to settle before polling again", async () => {
    const slow = Promise.withResolvers<ReturnType<typeof health>>();
    const { api, calls } = server((path) => (path === "/api/keyd" ? slow.promise : { keys: [] }));
    const { result } = renderHook(() => useKeys(api, 100));
    await advance(1000);
    expect(calls).toEqual(["GET /api/keyd"]);
    await act(async () => {
      slow.resolve(health());
    });
    expect(result.current.health?.online).toBe(true);
    await advance();
    expect(calls.filter((c) => c === "GET /api/keyd")).toHaveLength(2);
  });

  it("retries a failed list on the next poll without waiting for a new boot", async () => {
    let lists = 0;
    const { api } = server((path) => {
      if (path === "/api/keyd") return health();
      if (++lists === 1) throw new ApiError(502, "temporary failure");
      return { keys: [record] };
    });
    const { result } = renderHook(() => useKeys(api, 100));
    await flush();
    expect(result.current.loadError).not.toBeNull();
    await advance();
    expect(lists).toBe(2);
    expect(result.current.keys).toEqual([record]);
    expect(result.current.loadError).toBeNull();
    await advance();
    expect(lists).toBe(2);
  });

  it("clears stale keys while offline and reloads when the same boot reconnects", async () => {
    let online = true;
    const { api, calls } = server((path) =>
      path === "/api/keyd" ? (online ? health() : { online: false }) : { keys: [record] },
    );
    const { result } = renderHook(() => useKeys(api, 100));
    await flush();
    expect(result.current.keys).toEqual([record]);
    online = false;
    await advance();
    expect(result.current.health?.online).toBe(false);
    expect(result.current.keys).toEqual([]);
    online = true;
    await advance();
    expect(result.current.keys).toEqual([record]);
    expect(calls.filter((c) => c === "GET /api/keys")).toHaveLength(2);
  });

  it("reloads when keyd's boot changes even if it never appeared offline", async () => {
    let boot = "one";
    const { api, calls } = server((path) =>
      path === "/api/keyd" ? health(boot) : { keys: boot === "one" ? [record] : [] },
    );
    const { result } = renderHook(() => useKeys(api, 100));
    await flush();
    boot = "two";
    await advance();
    expect(result.current.health?.bootId).toBe("two");
    expect(result.current.keys).toEqual([]);
    expect(calls.filter((c) => c === "GET /api/keys")).toHaveLength(2);
  });

  it("ignores a previous API's late list and stops polling after unmount", async () => {
    const stale = Promise.withResolvers<{ keys: (typeof record)[] }>();
    const first = server((path) => (path === "/api/keyd" ? health("old") : stale.promise));
    const next = server((path) => (path === "/api/keyd" ? health("new") : { keys: [] }));
    const { result, rerender, unmount } = renderHook(({ api }) => useKeys(api, 100), {
      initialProps: { api: first.api },
    });
    await flush();
    rerender({ api: next.api });
    await flush();
    await act(async () => {
      stale.resolve({ keys: [record] });
    });
    expect(result.current.health?.bootId).toBe("new");
    expect(result.current.keys).toEqual([]);
    unmount();
    const before = [...next.calls];
    await advance(1000);
    expect(next.calls).toEqual(before);
    expect(first.calls).toEqual(["GET /api/keyd", "GET /api/keys"]);
  });

  it("reloads after save and delete without keeping the value in hook state", async () => {
    const saved = vi.spyOn(keysApi, "saveKey").mockResolvedValue({ key: record, restart: true });
    const { api, calls } = server((path) => (path === "/api/keyd" ? health() : { keys: [record] }));
    const { result } = renderHook(() => useKeys(api, 100));
    await flush();
    const binding = {
      id: "weather",
      kind: "http",
      hosts: ["api.example.com"],
      header: "Authorization",
      format: "bearer",
    } as const;
    await act(async () => {
      expect(
        await result.current.save({ ...binding, hosts: [...binding.hosts] }, "fake-private-value"),
      ).toEqual({ restart: true, key: record });
    });
    expect(saved).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.current)).not.toContain("fake-private-value");
    await act(async () => {
      await result.current.remove("weather");
    });
    expect(calls).toContain("DELETE /api/keys/weather");
    expect(calls.filter((c) => c === "GET /api/keys")).toHaveLength(3);
  });
});
