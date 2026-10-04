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
    agent: { ...f.props.agent, snapshot: { ...f.props.agent.snapshot!, pendingAsk: OTHER } },
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
            revoked: false,
            paused: field === "paused",
            stopped: field === "stopped",
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
