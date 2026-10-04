// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { loadKnowledge } from "./control-api.ts";
import { MemoryResponse, SkillsResponse, useKnowledge } from "./useKnowledge.ts";

const skills = [{ name: "sample", description: "Read-only metadata", source: "builtin" }];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("loads only visible read-only skill metadata, coalesces reads and ignores a late replaced owner", async () => {
  const late = Promise.withResolvers<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async () => late.promise);
  const api = createApi("fixture", { origin: "https://owned.invalid", fetchImpl });
  const view = renderHook((p) => useKnowledge(p.api, p.session, p.visible), {
    initialProps: { api, session: "first", visible: false },
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  view.rerender({ api, session: "first", visible: true });
  act(() => view.result.current.reloadSkills());
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("GET");
  expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://owned.invalid/api/agent/skills");
  const oldSignal = fetchImpl.mock.calls[0]?.[1]?.signal;
  const replacement = createApi("replacement", {
    origin: "https://owned.invalid",
    fetchImpl: async () => Response.json([]),
  });
  view.rerender({ api: replacement, session: "second", visible: true });
  expect(oldSignal?.aborted).toBe(true);
  await waitFor(() => expect(view.result.current.skillsPhase).toBe("ready"));
  await act(async () => late.resolve(Response.json(skills)));
  expect(view.result.current.skills).toEqual([]);
});
it("rereads current memory explicitly and prevents stale hidden-page data from repainting", async () => {
  const late = Promise.withResolvers<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/skills") ? Response.json(skills) : late.promise,
  );
  const api = createApi("fixture", { origin: "https://owned.invalid", fetchImpl });
  const view = renderHook((visible) => useKnowledge(api, "owned", visible), { initialProps: true });
  await waitFor(() => expect(view.result.current.skillsPhase).toBe("ready"));
  expect(fetchImpl).toHaveBeenCalledOnce();
  act(() => {
    view.result.current.rereadMemory();
    view.result.current.rereadMemory();
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(view.result.current.memory).toBeNull();
  view.rerender(false);
  expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  await act(async () => late.resolve(Response.json({ user: "old private memory", memory: "old" })));
  expect(view.result.current.memory).toBeNull();
});
it("rejects unsafe/unbounded knowledge responses and does not reflect backend diagnostics", async () => {
  for (const value of [
    [{ ...skills[0], source: "remote" }],
    [{ ...skills[0], dir: "/private" }],
    [skills[0], skills[0]],
  ])
    expect(SkillsResponse.safeParse(value).success).toBe(false);
  expect(MemoryResponse.safeParse({ user: "a", memory: "a", key: "private" }).success).toBe(false);
  const api = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: async () => new Response("private diagnostic", { status: 503 }),
  });
  await expect(
    loadKnowledge(api, "/api/agent/memory", new AbortController().signal, (v) =>
      MemoryResponse.parse(v),
    ),
  ).rejects.toMatchObject({ message: "Action delivery could not be confirmed." });
  const long = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: async () => new Response("x".repeat(196_609)),
  });
  await expect(
    loadKnowledge(long, "/api/agent/memory", new AbortController().signal, (v) =>
      MemoryResponse.parse(v),
    ),
  ).rejects.toMatchObject({ uncertain: true });
});
