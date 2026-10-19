// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { useRuntime } from "./useRuntime.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("follows Docker startup and recovery without continuing to poll a ready engine", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ docker: "unavailable", startup: "waiting" }))
    .mockResolvedValueOnce(Response.json({ docker: "ready", startup: "recovering" }))
    .mockResolvedValue(Response.json({ docker: "ready", startup: "ready" }));
  const api = createApi("fixture", { origin: "https://owned.invalid", fetchImpl });
  const hook = renderHook(() => useRuntime(api));
  await act(async () => {});
  expect(hook.result.current.problem).toBe("docker");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(hook.result.current.problem).toBe("recovering");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(hook.result.current.problem).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
it("does not interpret an HTTP failure as a stopped Docker engine", async () => {
  const api = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: vi.fn(async () => new Response("missing", { status: 404 })),
  });
  const hook = renderHook(() => useRuntime(api));
  await act(async () => {});
  expect(hook.result.current).toMatchObject({ checked: true, problem: null });
});
