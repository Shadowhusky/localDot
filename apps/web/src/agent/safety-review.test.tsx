// @vitest-environment jsdom
import { type ApprovalCard as Card, DEFAULT_AUTONOMY } from "@localdot/protocol";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { type AgentFeed, type AgentFeedState, emptyAgentModel } from "./model.ts";
import { SafetyNotes } from "./SafetyNotes.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import { type SafetyProps, useSafety } from "./useSafety.ts";

const CELL = "01J00000000000000000000001",
  SESSION = "01J00000000000000000000002",
  ID = "01J00000000000000000000003",
  OTHER = "01J00000000000000000000004";
const card: Card = {
  approvalId: ID,
  generation: 1,
  revision: 1,
  expiresAt: Date.now() + 60000,
  actionClass: "send",
  risk: "high",
  title: "<img src=x onerror=alert(1)>",
  fields: [
    ["Recipient", "Synthetic person"],
    ["Body", "<script>steal()</script>"],
  ],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
function fixture(fetchImpl: typeof fetch, approval: Card | null = card) {
  document.body.tabIndex = -1;
  document.body.focus();
  const model = { ...emptyAgentModel(), approval };
  let state: AgentFeedState = {
    cellId: CELL,
    sessionId: SESSION,
    epoch: 7,
    connection: "live",
    replayed: true,
    history: true,
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
      status: "running",
      toolCalls: 0,
      autonomy: DEFAULT_AUTONOMY,
      ...(approval ? { approval } : {}),
    },
    availability: "ready",
    error: null,
    fresh: true,
    authorityEpoch: 7,
    connection: "live",
    reconcile: vi.fn(),
  };
  let props: SafetyProps = {
    api: createApi("fixture", { origin: "https://owned.invalid", fetchImpl }),
    cell: {
      id: CELL,
      state: "ready",
      scale: 1,
      createdAt: "",
      stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
    },
    agent,
    feed,
    blocked: false,
    visible: true,
    selectReady: vi.fn(async () => true),
  };
  const view = renderHook((p) => useSafety(p), { initialProps: props });
  return {
    ...view,
    get props() {
      return props;
    },
    update(over: Partial<SafetyProps>) {
      props = { ...props, ...over };
      view.rerender(props);
    },
    invalidate(over: Partial<AgentFeedState>) {
      state = { ...state, ...over };
      for (const callback of listeners) callback();
    },
  };
}

afterEach(() => vi.useRealTimers());

it.each(["old_retirement", "new_creation"] as const)(
  "terminal blocked %s receipt permits only a fresh explicit replacement attempt",
  async (reason) => {
    vi.useFakeTimers();
    const posts: { requestId: string; oldRevision: number; home: string }[] = [];
    let reads = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/fence")) return Response.json({ revision: 4 });
      if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
      else reads++;
      return Response.json({
        requestId: posts.at(-1)?.requestId,
        oldCellId: CELL,
        revision: 4,
        phase: "blocked",
        reason,
        ...(reason === "new_creation" ? { newCellId: OTHER } : {}),
      });
    });
    const f = fixture(fetchImpl, null);
    f.update({
      cell: { ...f.props.cell!, state: "failed", fenced: { revision: 4 } },
      agent: { ...f.props.agent, fresh: false },
    });
    await act(async () => {
      await f.result.current.replace();
    });
    expect(posts).toHaveLength(1);
    expect(f.props.selectReady).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(reads).toBe(1);
    expect(f.result.current.replacement?.phase).toBe("blocked");
    expect(posts).toHaveLength(1); // Reconciliation itself cannot repeat the mutation.
    expect(f.result.current.replacing).toBe(false);
    expect(f.result.current.canReplace).toBe(true);
    await act(async () => {
      await f.result.current.replace();
    });
    expect(posts).toHaveLength(2);
    expect(posts[1]?.requestId).not.toBe(posts[0]?.requestId);
    expect(f.props.selectReady).not.toHaveBeenCalled();
  },
);

it.each(["current", "hidden", "owner changed"] as const)(
  "replacement preflight %s checks the owner immediately before POST",
  async (mode) => {
    const response = Promise.withResolvers<Response>();
    let posts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/fence")) return response.promise;
      if (init?.method === "POST") posts++;
      const body = JSON.parse(String(init?.body));
      return Response.json({
        requestId: body.requestId,
        oldCellId: CELL,
        revision: 4,
        phase: "retiring",
      });
    });
    const f = fixture(fetchImpl, null);
    f.update({
      cell: { ...f.props.cell!, state: "failed", fenced: { revision: 4 } },
      agent: { ...f.props.agent, fresh: false },
    });
    let work: Promise<boolean>;
    act(() => {
      work = f.result.current.replace();
    });
    if (mode === "hidden") f.update({ visible: false });
    if (mode === "owner changed") f.update({ cell: { ...f.props.cell!, id: OTHER } });
    await act(async () => {
      response.resolve(Response.json({ revision: 4 }));
      await work;
    });
    expect(posts).toBe(mode === "current" ? 1 : 0);
  },
);

it.each(["current", "stale epoch"] as const)(
  "Resume %s remains tied to the current event owner at invocation",
  async (mode) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const f = fixture(fetchImpl, null);
    const pause = {
      requestId: ID,
      revision: 3,
      phase: "paused" as const,
      reason: "user" as const,
      atStepBoundary: true,
      resumeAvailable: true,
    };
    const model = { ...f.props.agent.model, safetyPause: pause };
    act(() => f.invalidate({ model }));
    f.update({
      agent: {
        ...f.props.agent,
        model,
        snapshot: { sessionId: SESSION, cellId: CELL, status: "paused", toolCalls: 0, pause },
      },
    });
    const retainedResume = f.result.current.resume;
    if (mode === "stale epoch") act(() => f.invalidate({ epoch: 8 }));
    await act(async () => {
      expect(await retainedResume()).toBe(mode === "current");
    });
    expect(fetchImpl).toHaveBeenCalledTimes(mode === "current" ? 1 : 0);
  },
);

it("a granted notification still announces a current approval while the visible window is unfocused", () => {
  const notices: { title: string; onclick: (() => void) | null; close: () => void }[] = [];
  class Notice {
    static permission = "granted";
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(readonly title: string) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", Notice);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const f = fixture(fetchImpl);
  act(() => window.dispatchEvent(new Event("blur")));
  expect(f.result.current.canApprove).toBe(false);
  render(<SafetyNotes safety={f.result.current} agent={f.props.agent} cell={f.props.cell} />);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.title).toBe("localDot needs your decision");
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("synchronous duplicate approval calls produce only one authenticated mutation", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const f = fixture(fetchImpl);
  const decision = { approvalId: ID, generation: 1, revision: 1, decision: "approve" };
  await act(async () => {
    await Promise.all([
      f.result.current.answerApproval(decision),
      f.result.current.answerApproval(decision),
    ]);
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.result.current.canApprove).toBe(false);
});
