// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import type { AgentFeed, AgentFeedState, AgentQuestion } from "./model.ts";
import { emptyAgentModel } from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import { useTaskControls } from "./useTaskControls.ts";

const CELL = "01JXYZ0000000000000000CELL",
  SESSION = "01JXYZ0000000000000000SESS",
  ID = "01JXYZ00000000000000000001",
  OTHER = "01JXYZ00000000000000000002";
const ready: CellSummary = {
  id: CELL,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function fixture(fetchImpl: typeof fetch, takeover = false) {
  const question: AgentQuestion = {
    askId: ID,
    question: "Choose",
    options: [{ key: "A", text: "First" }],
    allowText: true,
  };
  const model = {
    ...emptyAgentModel(),
    questions: new Map([[ID, question]]),
    pendingAsk: takeover ? null : ID,
    pendingTakeover: takeover ? ID : null,
  };
  let state: AgentFeedState = {
    cellId: CELL,
    sessionId: SESSION,
    epoch: 7,
    connection: "live",
    replayed: true,
    streamError: null,
    model,
  };
  const listeners = new Set<() => void>();
  const feed: AgentFeed = {
    read: () => state,
    subscribe: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  const agent: AgentSessionView = {
    sessionId: SESSION,
    model,
    snapshot: {
      sessionId: SESSION,
      cellId: CELL,
      status: "waiting_user",
      toolCalls: 0,
      ...(takeover ? { pendingTakeover: ID, manualControl: "ready" as const } : { pendingAsk: ID }),
    },
    availability: "ready",
    error: null,
    fresh: true,
    authorityEpoch: 7,
    connection: "live",
    reconcile: vi.fn(),
  };
  let props = {
    api: createApi("fixture", { origin: "https://owned.invalid", fetchImpl }),
    cell: ready as CellSummary | null,
    cellPending: null,
    agent,
    feed,
    suspended: false,
    manualVisible: true,
    refreshCell: vi.fn(),
  };
  const view = renderHook((p) => useTaskControls(p), { initialProps: props });
  return {
    ...view,
    update(over: Partial<typeof props>) {
      props = { ...props, ...over };
      view.rerender(props);
    },
    get props() {
      return props;
    },
    invalidate(over: Partial<AgentFeedState>) {
      state = { ...state, ...over };
      for (const notify of listeners) notify();
    },
  };
}
it("excludes duplicate answers synchronously and rejects old IDs, options and same-render stale feed authority", async () => {
  const late = Promise.withResolvers<Response>(),
    fetchImpl = vi.fn<typeof fetch>(async () => late.promise),
    f = fixture(fetchImpl);
  expect(f.result.current.canAnswer).toBe(true);
  await act(async () => {
    await f.result.current.answer({ askId: OTHER, option: "A" });
    await f.result.current.answer({ askId: ID, option: "F" });
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  let work: Promise<boolean> | undefined;
  act(() => {
    work = f.result.current.answer({ askId: ID, option: "A" });
    void f.result.current.answer({ askId: ID, option: "A" });
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  await act(async () => {
    late.resolve(new Response(null, { status: 204 }));
    await work;
  });
  expect(f.result.current.status?.phase).toBe("checking");
  const answered = { ...f.props.agent.model, pendingAsk: null };
  act(() => f.invalidate({ epoch: 8, model: answered }));
  f.update({
    agent: {
      ...f.props.agent,
      model: answered,
      authorityEpoch: 8,
      snapshot: { sessionId: SESSION, cellId: CELL, status: "running", toolCalls: 0 },
    },
  });
  await waitFor(() => expect(f.result.current.status).toBeNull());
  act(() => f.invalidate({ epoch: 9 }));
  await act(async () => {
    await f.result.current.answer({ askId: ID, option: "A" });
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("never replays an uncertain answer; explicit reread must provide a fresh snapshot before another request", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("offline");
    }),
    f = fixture(fetchImpl);
  await act(async () => {
    await f.result.current.answer({ askId: ID, text: "hello" });
  });
  expect(f.result.current.status?.phase).toBe("uncertain");
  f.update({
    agent: {
      ...f.props.agent,
      snapshot: {
        ...f.props.agent.snapshot,
        sessionId: SESSION,
        cellId: CELL,
        status: "waiting_user",
        toolCalls: 0,
      },
    },
  });
  expect(f.result.current.canAnswer).toBe(false);
  expect(fetchImpl).toHaveBeenCalledOnce();
  act(() => f.result.current.recheck());
  f.update({
    agent: {
      ...f.props.agent,
      snapshot: {
        ...f.props.agent.snapshot,
        sessionId: SESSION,
        cellId: CELL,
        status: "waiting_user",
        toolCalls: 0,
      },
    },
  });
  await waitFor(() => expect(f.result.current.canAnswer).toBe(true));
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("retires a pending operation on API replacement and ignores its late reply", async () => {
  const late = Promise.withResolvers<Response>(),
    oldFetch = vi.fn<typeof fetch>(async () => late.promise),
    newFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(oldFetch, true);
  let work: Promise<boolean> | undefined;
  act(() => {
    work = f.result.current.input(ID, { kind: "text", text: "synthetic-owned-secret" });
  });
  f.update({
    api: createApi("replacement", { origin: "https://owned.invalid", fetchImpl: newFetch }),
  });
  await act(async () => {
    expect(await work).toBe(false);
  });
  expect(oldFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(f.result.current.status).toBeNull();
  expect(f.result.current.canInput).toBe(true);
  await act(async () => {
    late.resolve(new Response(null, { status: 204 }));
    expect(await f.result.current.input(ID, { kind: "key", combo: ["tab"] })).toBe(true);
  });
  expect(oldFetch).toHaveBeenCalledOnce();
  expect(newFetch).toHaveBeenCalledOnce();
  expect(f.result.current.status).toBeNull();
  expect(f.result.current.stopStatus.phase).toBe("idle");
});
it("does not submit a replacement question while the old answer is pending or replay its late acknowledgement", async () => {
  const late = Promise.withResolvers<Response>();
  let calls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    ++calls === 1 ? late.promise : new Response(null, { status: 204 }),
  );
  const f = fixture(fetchImpl);
  let old: Promise<boolean> | undefined;
  act(() => {
    old = f.result.current.answer({ askId: ID, text: "old answer" });
  });
  const replacement = {
    ...f.props.agent.model,
    pendingAsk: OTHER,
    questions: new Map([
      [
        OTHER,
        {
          askId: OTHER,
          question: "Replacement",
          options: [{ key: "A", text: "New answer" }],
          allowText: false,
        },
      ],
    ]),
  };
  act(() => f.invalidate({ epoch: 8, model: replacement }));
  f.update({
    agent: {
      ...f.props.agent,
      model: replacement,
      authorityEpoch: 8,
      snapshot: {
        sessionId: SESSION,
        cellId: CELL,
        status: "waiting_user",
        toolCalls: 0,
        pendingAsk: OTHER,
      },
    },
  });
  await act(async () => {
    expect(await f.result.current.answer({ askId: OTHER, option: "A" })).toBe(false);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  await act(async () => {
    late.resolve(new Response(null, { status: 204 }));
    await old;
  });
  f.update({
    agent: { ...f.props.agent, snapshot: { ...snapshotOf(f), pendingAsk: OTHER } },
  });
  await waitFor(() => expect(f.result.current.canAnswer).toBe(true));
  expect(fetchImpl).toHaveBeenCalledOnce();
  await act(async () => {
    expect(await f.result.current.answer({ askId: OTHER, option: "A" })).toBe(true);
  });
  expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
    askId: OTHER,
    option: "A",
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it.each(["blur", "pagehide", "modal", "pane", "feed"])(
  "cancels owned text on %s and keeps its outcome unknown",
  async (reason) => {
    const late = Promise.withResolvers<Response>(),
      fetchImpl = vi.fn<typeof fetch>(async () => late.promise),
      f = fixture(fetchImpl, true);
    let work: Promise<boolean> | undefined;
    act(() => {
      work = f.result.current.input(ID, { kind: "text", text: "fake-password-中文" });
    });
    if (reason === "modal") f.update({ suspended: true });
    else if (reason === "pane") f.update({ manualVisible: false });
    else if (reason === "feed") act(() => f.invalidate({ connection: "lost" }));
    else act(() => window.dispatchEvent(new Event(reason)));
    await act(async () => {
      await work;
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(f.result.current.status?.phase).toBe("uncertain");
    expect(JSON.stringify(f.result.current.status)).not.toContain("fake-password");
    await act(async () => {
      late.resolve(new Response(null, { status: 204 }));
    });
    expect(f.result.current.status?.phase).toBe("uncertain");
    expect(fetchImpl).toHaveBeenCalledOnce();
  },
);
it("handback excludes duplicate input and Stop takes priority across the same shared controller", async () => {
  const first = Promise.withResolvers<Response>(),
    handback = Promise.withResolvers<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/input")
      ? first.promise
      : String(url).endsWith("/done")
        ? handback.promise
        : Response.json(
            { revoked: true, paused: true, closed: false, stopped: false, errors: [] },
            { status: 202 },
          ),
  );
  const f = fixture(fetchImpl, true);
  let input: Promise<boolean> | undefined, returned: Promise<boolean> | undefined;
  act(() => {
    input = f.result.current.input(ID, { kind: "key", combo: ["tab"] });
    returned = f.result.current.handback(ID);
    void f.result.current.handback(ID);
    void f.result.current.input(ID, { kind: "key", combo: ["enter"] });
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  await act(async () => {
    await Promise.all([f.result.current.stop(), f.result.current.stop(), input, returned]);
  });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(f.result.current.stopStatus.phase).toBe("paused");
  expect(f.result.current.fenced).toBe(true);
  await act(async () => {
    first.resolve(new Response(null, { status: 204 }));
    handback.resolve(new Response(null, { status: 204 }));
  });
  expect(f.result.current.stopStatus.phase).toBe("paused");
});
it.each(["all-false", "lost-then404"])(
  "retains Stop uncertainty and closed admission for %s even after missing task status",
  async (reason) => {
    let count = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      count++;
      if (reason === "all-false")
        return Response.json(
          {
            revoked: true,
            paused: false,
            stopped: false,
            closed: false,
            errors: ["pause: could not confirm completion"],
          },
          { status: 202 },
        );
      if (count === 1) throw new TypeError("lost");
      return new Response(null, { status: 404 });
    });
    const f = fixture(fetchImpl, true);
    await act(async () => {
      await f.result.current.stop();
    });
    f.update({
      cell: null,
      agent: {
        ...f.props.agent,
        sessionId: null,
        fresh: false,
        availability: "missing",
        snapshot: null,
      },
    });
    expect(f.result.current.stopStatus.phase).toBe("unconfirmed");
    expect(f.result.current.fenced).toBe(true);
    await act(async () => {
      await f.result.current.stop();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.result.current.stopStatus.phase).toBe("unconfirmed");
    expect(f.result.current.canInput).toBe(false);
  },
);
it.each(["paused", "stopped"])(
  "uses actual %s containment, then permits recovery only after the observed ready cycle",
  async (field) => {
    const f = fixture(
      async () =>
        Response.json(
          {
            revoked: field === "paused",
            paused: field === "paused",
            stopped: field === "stopped",
            closed: field === "stopped",
            errors: [],
          },
          { status: 202 },
        ),
      true,
    );
    await act(async () => {
      await f.result.current.stop();
    });
    expect(f.result.current.stopStatus.phase).toBe(field);
    expect(f.result.current.canInput).toBe(false);
    f.update({
      cell: field === "paused" ? { ...ready, paused: true } : { ...ready, state: "stopped" },
    });
    expect(f.result.current.fenced).toBe(true);
    f.update({ cell: { ...ready } });
    await waitFor(() => expect(f.result.current.stopStatus.phase).toBe("idle"));
  },
);

it("reports the computer off once it stops after a paused Stop", async () => {
  const f = fixture(
    async () =>
      Response.json(
        {
          revoked: true,
          paused: true,
          stopped: false,
          closed: false,
          errors: ["keyd: could not confirm completion"],
        },
        { status: 202 },
      ),
    true,
  );
  await act(async () => {
    await f.result.current.stop();
  });
  f.update({ cell: { ...ready, paused: true } });
  expect(f.result.current.stopStatus.phase).toBe("paused");
  f.update({ cell: { ...ready, state: "stopped" } });
  await waitFor(() => expect(f.result.current.stopStatus.phase).toBe("stopped"));
  expect(f.result.current.stopStatus.errors).toEqual(["keyd: could not confirm completion"]);
  expect(f.result.current.fenced).toBe(true);
  f.update({ cell: { ...ready } });
  await waitFor(() => expect(f.result.current.stopStatus.phase).toBe("idle"));
});

function pauseFixture(f: ReturnType<typeof fixture>, subscription = false) {
  const model = {
    ...f.props.agent.model,
    pendingAsk: null,
    pendingTakeover: null,
    state: {
      state: "paused" as const,
      reason: subscription ? "chatgpt plan limit reached" : "budget",
    },
    budget: {
      id: ID,
      at: 1,
      data: { scope: "task" as const, taskId: SESSION, limitUSD: 5, spentUSD: 4 },
    },
    subscription: subscription
      ? {
          id: OTHER,
          at: 2,
          data: { provider: "chatgpt" as const, windows: [], limitReached: true },
        }
      : null,
  };
  act(() => f.invalidate({ model }));
  f.update({
    agent: {
      ...f.props.agent,
      model,
      snapshot: {
        sessionId: SESSION,
        cellId: CELL,
        status: "paused",
        toolCalls: 0,
        models: subscription
          ? { kind: "chatgpt", model: "fixture" }
          : { kind: "api", roles: [{ role: "main", provider: "openai", model: "fixture" }] },
      },
    },
  });
}
it("validates ceilings before dispatch and shares the same mutation exclusion with Resume and Stop", async () => {
  const late = Promise.withResolvers<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/stop")
      ? Response.json(
          { revoked: true, paused: true, closed: false, stopped: false, errors: [] },
          { status: 202 },
        )
      : late.promise,
  );
  const f = fixture(fetchImpl);
  pauseFixture(f);
  expect(f.result.current.canRaiseBudget).toBe(true);
  await act(async () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10001, 0.0000001])
      await f.result.current.raiseBudget(value);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  let raising: Promise<boolean> | undefined;
  act(() => {
    raising = f.result.current.raiseBudget(8);
    void f.result.current.raiseBudget(9);
    void f.result.current.resume();
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ budgetUSD: 8 }));
  const raiseSignal = fetchImpl.mock.calls[0]?.[1]?.signal;
  await act(async () => {
    await f.result.current.stop();
  });
  expect(raiseSignal?.aborted).toBe(true);
  expect(f.result.current.fenced).toBe(true);
  await act(async () => {
    late.resolve(new Response(null, { status: 204 }));
    await raising;
  });
  expect(f.result.current.status).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it("lost budget delivery never retries or implies a fresh ceiling; explicit reread is required", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new TypeError("lost private diagnostic");
  });
  const f = fixture(fetchImpl);
  pauseFixture(f);
  await act(async () => {
    await f.result.current.raiseBudget(8);
  });
  expect(f.result.current.status?.phase).toBe("uncertain");
  await act(async () => {
    await f.result.current.raiseBudget(8);
    await f.result.current.resume();
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(f.props.agent.model.budget?.data.spentUSD).toBe(4);
  f.update({ agent: { ...f.props.agent, snapshot: { ...snapshotOf(f), toolCalls: 1 } } });
  expect(f.result.current.canRaiseBudget).toBe(false);
  act(() => f.result.current.recheck());
  f.update({ agent: { ...f.props.agent, snapshot: { ...snapshotOf(f), toolCalls: 2 } } });
  await waitFor(() => expect(f.result.current.canRaiseBudget).toBe(true));
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("subscription tasks expose explicit Resume without a USD raise even if an unrelated key budget refusal is reported", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const f = fixture(fetchImpl);
  pauseFixture(f, true);
  expect(f.result.current.canRaiseBudget).toBe(false);
  await act(async () => {
    await f.result.current.raiseBudget(8);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  await act(async () => {
    await f.result.current.resume();
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
    `https://owned.invalid/api/agent/sessions/${SESSION}/resume`,
  );
  expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
});
it("budget/resume cannot run during takeover or lost feed, and a replacement session ignores an old reply", async () => {
  const late = Promise.withResolvers<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async () => late.promise);
  const f = fixture(fetchImpl);
  pauseFixture(f);
  act(() => f.invalidate({ connection: "lost" }));
  await act(async () => {
    await f.result.current.raiseBudget(8);
    await f.result.current.resume();
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  act(() => f.invalidate({ connection: "live" }));
  let raising: Promise<boolean> | undefined;
  act(() => {
    raising = f.result.current.raiseBudget(8);
  });
  f.update({
    agent: {
      ...f.props.agent,
      sessionId: OTHER,
      snapshot: { ...snapshotOf(f), sessionId: OTHER },
    },
  });
  expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await act(async () => {
    late.resolve(new Response(null, { status: 204 }));
    await raising;
  });
  expect(f.result.current.status).toBeNull();
  const held = fixture(fetchImpl, true);
  await act(async () => {
    await held.result.current.raiseBudget(8);
    await held.result.current.resume();
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("memory Undo names the durable eligible change, preserves conflict without overwriting, and remains fenced against Stop", async () => {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response("private backend detail", { status: 409 }),
  );
  const f = fixture(fetchImpl);
  pauseFixture(f);
  const change = {
    id: OTHER,
    type: "memory" as const,
    path: "MEMORY.md",
    changeId: ID,
    patch: "remembered",
    truncated: false,
  };
  const model = { ...f.props.agent.model, changes: [change] };
  act(() => f.invalidate({ model }));
  f.update({ agent: { ...f.props.agent, model } });
  await act(async () => {
    await f.result.current.undo(OTHER);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  await act(async () => {
    await f.result.current.undo(ID);
    void f.result.current.undo(ID);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
    `https://owned.invalid/api/agent/memory/${ID}/undo`,
  );
  expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
  expect(f.result.current.status).toMatchObject({
    kind: "memory",
    target: ID,
    phase: "refused",
    code: 409,
  });
  expect(f.result.current.status?.message).not.toContain("private backend detail");
  const undone = {
    ...model,
    changes: [...model.changes, { ...change, id: ID, changeId: OTHER, undoes: ID }],
  };
  act(() => f.invalidate({ model: undone }));
  f.update({ agent: { ...f.props.agent, model: undone } });
  await waitFor(() => expect(f.result.current.status).toBeNull());
  await act(async () => {
    await f.result.current.undo(ID);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

function snapshotOf(f: ReturnType<typeof fixture>) {
  const snapshot = f.props.agent.snapshot;
  if (!snapshot) throw new Error("fixture snapshot missing");
  return snapshot;
}

it("allows a verified completed-task memory Undo, records only the exact durable acknowledgement and never resumes ended work", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ changeId: OTHER }));
  const f = fixture(fetchImpl);
  pauseFixture(f);
  const change = {
    id: OTHER,
    type: "memory" as const,
    path: "MEMORY.md",
    changeId: ID,
    patch: "old",
    truncated: false,
  };
  const model = { ...f.props.agent.model, ended: { reason: "done" as const }, changes: [change] };
  act(() => f.invalidate({ model, connection: "ended" }));
  f.update({
    agent: {
      ...f.props.agent,
      model,
      fresh: false,
      readFresh: false,
      connection: "ended",
      snapshot: { ...snapshotOf(f), status: "ended" },
    },
  });
  await act(async () => {
    await f.result.current.undo(ID);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  f.update({ agent: { ...f.props.agent, readFresh: true } });
  expect(f.result.current.canUndoMemory).toBe(true);
  expect(f.result.current.canResumeTask).toBe(false);
  expect(f.result.current.canAnswer).toBe(false);
  await act(async () => {
    await f.result.current.undo(ID);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(f.result.current.memoryUndone.has(ID)).toBe(true);
  expect(f.result.current.status).toBeNull();
  await act(async () => {
    await f.result.current.undo(ID);
    await f.result.current.resume();
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("a verified terminal snapshot retires an acknowledged budget action without enabling task input", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const f = fixture(fetchImpl);
  pauseFixture(f);
  await act(async () => {
    await f.result.current.raiseBudget(8);
  });
  expect(f.result.current.status?.phase).toBe("checking");
  const model = { ...f.props.agent.model, ended: { reason: "done" as const } };
  act(() => f.invalidate({ model, connection: "ended" }));
  f.update({
    agent: {
      ...f.props.agent,
      model,
      fresh: false,
      readFresh: true,
      connection: "ended",
      snapshot: { ...snapshotOf(f), status: "ended" },
    },
  });
  await waitFor(() => expect(f.result.current.status).toBeNull());
  expect(f.result.current.canUndoMemory).toBe(true);
  expect(f.result.current.canRaiseBudget).toBe(false);
  expect(f.result.current.canInput).toBe(false);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([
  { revoked: false, paused: true, closed: false, stopped: false, errors: [] },
  { revoked: false, paused: false, closed: false, stopped: true, errors: [] },
])(
  "incomplete physical/revocation Stop proof remains unconfirmed and keeps input closed",
  async (outcome) => {
    const f = fixture(async () => Response.json(outcome, { status: 202 }), true);
    await act(async () => {
      await f.result.current.stop();
    });
    expect(f.result.current.stopStatus.phase).toBe("unconfirmed");
    expect(f.result.current.canInput).toBe(false);
    expect(f.result.current.fenced).toBe(true);
  },
);
