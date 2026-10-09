// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { loadKnowledge, raiseTaskBudget, resumeTask, undoMemory } from "./control-api.ts";
import { type AgentFeed, type AgentFeedState, emptyAgentModel } from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import { MemoryResponse } from "./useKnowledge.ts";
import { useTaskControls } from "./useTaskControls.ts";

const SESSION = "01JXYZ0000000000000000SESS",
  CELL = "01JXYZ0000000000000000CE11";
const CHANGE = "01JXYZ00000000000000000001",
  OTHER = "01JXYZ00000000000000000002";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("bounds an unannounced chunked knowledge body before parsing and cancels its reader", async () => {
  const cancelled = vi.fn(),
    parse = vi.fn(MemoryResponse.parse);
  const bytes = new TextEncoder().encode(JSON.stringify({ user: "x".repeat(199_000), memory: "" }));
  const chunks = [bytes.subarray(0, 120_000), bytes.subarray(120_000)];
  const api = createApi("inert", {
    origin: "https://owned.invalid",
    fetchImpl: async () =>
      new Response(
        new ReadableStream(
          {
            pull(c) {
              const chunk = chunks.shift();
              if (chunk) c.enqueue(chunk);
              else c.close();
            },
            cancel: cancelled,
          },
          { highWaterMark: 0 },
        ),
      ),
  });
  await expect(
    loadKnowledge(api, "/api/agent/memory", new AbortController().signal, parse),
  ).rejects.toMatchObject({ uncertain: true });
  expect(parse).not.toHaveBeenCalled();
  expect(cancelled).toHaveBeenCalledOnce();
});
it("keeps its finite deadline through a successful header and an unfinished body", async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  const api = createApi("inert", {
    origin: "https://owned.invalid",
    fetchImpl: async () => new Response(new ReadableStream({ cancel: cancelled })),
  });
  const stop = new AbortController();
  let settled = false;
  const result = loadKnowledge(api, "/api/agent/memory", stop.signal, MemoryResponse.parse)
    .then(
      () => ({ ok: true, uncertain: false }),
      (e) => ({ ok: false, uncertain: e.uncertain }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await vi.advanceTimersByTimeAsync(35_001);
    expect(settled, "finite deadline must settle the unfinished body before test cleanup").toBe(
      true,
    );
    expect(await result).toEqual({ ok: false, uncertain: true });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stop.abort();
    await result;
  }
});
it("cancels late knowledge response ownership without clearing a replacement token on stale raw 401", async () => {
  const late = Promise.withResolvers<Response>(),
    rejected = vi.fn(),
    cancelled = vi.fn();
  const api = createApi("old-inert", {
    origin: "https://owned.invalid",
    fetchImpl: async () => late.promise,
    onUnauthorized: rejected,
  });
  const stop = new AbortController();
  const work = loadKnowledge(api, "/api/agent/memory", stop.signal, MemoryResponse.parse).catch(
    (e) => e,
  );
  stop.abort();
  expect(await work).toMatchObject({ uncertain: true });
  late.resolve(new Response(new ReadableStream({ cancel: cancelled }), { status: 401 }));
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  expect(rejected).not.toHaveBeenCalled();
  expect(cancelled).toHaveBeenCalledOnce();
});
it("requires exact acknowledgements for new budget, resume and memory operations", async () => {
  const api = createApi("inert", {
    origin: "https://owned.invalid",
    fetchImpl: async () => Response.json({ changeId: OTHER, echoedSecret: "inert-canary" }),
  });
  const signal = new AbortController().signal;
  await expect(undoMemory(api, CHANGE, signal)).rejects.toMatchObject({ uncertain: true });
  await expect(raiseTaskBudget(api, SESSION, 8, signal)).rejects.toMatchObject({ uncertain: true });
  await expect(resumeTask(api, SESSION, signal)).rejects.toMatchObject({ uncertain: true });
});
it("classifies a current raw 401 definitively, clears its current token once and never reflects body text", async () => {
  const reject = vi.fn();
  const api = createApi("inert", {
    origin: "https://owned.invalid",
    onUnauthorized: reject,
    fetchImpl: async () => new Response("private-401-canary", { status: 401 }),
  });
  const failure = await undoMemory(api, CHANGE, new AbortController().signal).catch((e) => e);
  expect(failure).toMatchObject({ uncertain: false, status: 401 });
  expect(String(failure)).not.toContain("canary");
  expect(reject).toHaveBeenCalledOnce();
});
it.each(["gap", "takeover", "replacement"] as const)(
  "an old retained memory callback cannot cross a same-render %s boundary",
  async (boundary) => {
    const model = {
      ...emptyAgentModel(),
      changes: [
        {
          id: OTHER,
          type: "memory" as const,
          path: "MEMORY.md",
          changeId: CHANGE,
          patch: "old",
          truncated: false,
        },
      ],
    };
    let state: AgentFeedState = {
      cellId: CELL,
      sessionId: SESSION,
      epoch: 1,
      connection: "live",
      replayed: true,
      history: true,
      streamError: null,
      model,
    };
    const feed: AgentFeed = { read: () => state, subscribe: () => () => {} };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ changeId: OTHER }));
    const api = createApi("inert", { origin: "https://owned.invalid", fetchImpl });
    const cell: CellSummary = {
      id: CELL,
      state: "ready",
      scale: 1,
      createdAt: "",
      stream: { connection: "live", viewers: 0, lastUpstreamAt: null },
    };
    const agent: AgentSessionView = {
      sessionId: SESSION,
      model,
      snapshot: { sessionId: SESSION, cellId: CELL, status: "idle", toolCalls: 0 },
      availability: "ready",
      error: null,
      fresh: true,
      readFresh: true,
      authorityEpoch: 1,
      connection: "live",
      reconcile() {},
    };
    const view = renderHook(() =>
      useTaskControls({
        api,
        cell,
        cellPending: null,
        agent,
        feed,
        suspended: false,
        manualVisible: false,
        refreshCell() {},
      }),
    );
    expect(view.result.current.canUndoMemory).toBe(true);
    const old = view.result.current.undo;
    if (boundary === "gap") state = { ...state, epoch: 2, streamError: "missing events" };
    else if (boundary === "takeover")
      state = { ...state, model: { ...model, pendingTakeover: OTHER } };
    else state = { ...state, sessionId: OTHER };
    await act(async () => {
      expect(await old(CHANGE)).toBe(false);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);
