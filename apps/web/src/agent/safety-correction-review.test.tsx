// @vitest-environment jsdom
import { type ApprovalCard as Card, DEFAULT_AUTONOMY } from "@localdot/protocol";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { type AgentFeed, type AgentFeedState, emptyAgentModel } from "./model.ts";
import { SafetyControls } from "./SafetyControls.tsx";
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

it.each(["pending GET", "failed GET", "nonterminal GET"] as const)(
  "terminal POST does not release replacement identity while reconciliation is %s",
  async (mode) => {
    vi.useFakeTimers();
    const read = Promise.withResolvers<Response>();
    let requestId = "";
    const posts: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/fence")) return Response.json({ revision: 4 });
      if (init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        requestId = input.requestId;
        posts.push(input);
        return Response.json({
          requestId,
          oldCellId: CELL,
          revision: 4,
          phase: "blocked",
          reason: "old_retirement",
        });
      }
      if (mode === "pending GET") return read.promise;
      if (mode === "failed GET") throw new Error("inert transport refusal");
      return Response.json({ requestId, oldCellId: CELL, revision: 4, phase: "retiring" });
    });
    const f = fixture(fetchImpl, null);
    f.update({
      cell: { ...f.props.cell!, state: "failed", fenced: { revision: 4 } },
      agent: { ...f.props.agent, fresh: false },
    });
    await act(async () => {
      expect(await f.result.current.replace()).toBe(true);
    });
    expect(f.result.current.canReplace).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(f.result.current.canReplace).toBe(false);
    await act(async () => {
      expect(await f.result.current.replace()).toBe(false);
    });
    expect(posts).toHaveLength(1);
    if (mode === "pending GET")
      await act(async () => {
        read.resolve(Response.json({ requestId, oldCellId: CELL, revision: 4, phase: "retiring" }));
      });
  },
);
it.each(["before newer preflight", "during newer preflight"] as const)(
  "old POST failure %s cannot release a newer replacement preflight",
  async (timing) => {
    vi.useFakeTimers();
    const firstReply = Promise.withResolvers<Response>();
    const nextFence = Promise.withResolvers<Response>();
    let fenceReads = 0;
    const posts: { requestId: string; oldRevision: number; home: string }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/fence")) {
        fenceReads++;
        return fenceReads === 1
          ? Response.json({ revision: 4 })
          : nextFence.promise.then(() => Response.json({ revision: 4 }));
      }
      if (init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        posts.push(input);
        if (posts.length === 1) return firstReply.promise;
        return Response.json({
          requestId: input.requestId,
          oldCellId: CELL,
          revision: 4,
          phase: "retiring",
        });
      }
      return Response.json({
        requestId: posts[0]?.requestId,
        oldCellId: CELL,
        revision: 4,
        phase: "blocked",
        reason: "old_retirement",
      });
    });
    const f = fixture(fetchImpl, null);
    f.update({
      cell: { ...f.props.cell!, state: "failed", fenced: { revision: 4 } },
      agent: { ...f.props.agent, fresh: false },
    });
    let first!: Promise<boolean>;
    act(() => {
      first = f.result.current.replace();
    });
    await act(async () => {});
    expect(posts).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(f.result.current.canReplace).toBe(true);
    if (timing === "before newer preflight")
      await act(async () => {
        firstReply.reject(new Error("old reply lost"));
        await first;
      });
    let second!: Promise<boolean>;
    act(() => {
      second = f.result.current.replace();
    });
    expect(fenceReads).toBe(2);
    if (timing === "during newer preflight")
      await act(async () => {
        firstReply.reject(new Error("old reply lost"));
        await first;
      });
    let duplicate!: Promise<boolean>;
    act(() => {
      duplicate = f.result.current.replace();
    });
    await act(async () => {
      nextFence.resolve(Response.json({ revision: 4 }));
      await second;
      await duplicate;
    });
    expect({
      fenceReads,
      posts: posts.length,
      selected: vi.mocked(f.props.selectReady).mock.calls.length,
    }).toEqual({ fenceReads: 2, posts: 2, selected: 0 });
  },
);
it("replacement rechecks actual document focus after its delayed fence read", async () => {
  const fence = Promise.withResolvers<Response>();
  const actualFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const posts: unknown[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/fence")) return fence.promise;
    const body = JSON.parse(String(init?.body));
    posts.push(body);
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
  let work!: Promise<boolean>;
  act(() => {
    work = f.result.current.replace();
  });
  actualFocus.mockReturnValue(false);
  await act(async () => {
    fence.resolve(Response.json({ revision: 4 }));
    await work;
  });
  expect(posts).toHaveLength(0);
});
it.each([
  "current blurred",
  "stale epoch",
  "expired",
  "takeover",
  "hidden",
  "blocked",
  "permission denied",
] as const)("notification eligibility remains owner-bound: %s", (mode) => {
  const notices: { onclick: (() => void) | null; close: () => void }[] = [];
  class Notice {
    static permission = mode === "permission denied" ? "denied" : "granted";
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(readonly title: string) {
      expect(title).toBe("localDot needs your decision");
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", Notice);
  vi.spyOn(window, "focus").mockImplementation(() => {});
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const f = fixture(fetchImpl, mode === "expired" ? { ...card, expiresAt: Date.now() - 1 } : card);
  act(() => window.dispatchEvent(new Event("blur")));
  if (mode === "stale epoch") {
    act(() => f.invalidate({ epoch: 8 }));
    f.update({ agent: { ...f.props.agent } });
  }
  if (mode === "takeover")
    f.update({
      agent: { ...f.props.agent, model: { ...f.props.agent.model, pendingTakeover: OTHER } },
    });
  if (mode === "hidden") vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  if (mode === "blocked") f.update({ blocked: true });
  if (mode === "hidden") f.update({ agent: { ...f.props.agent } });
  const view = render(
    <SafetyControls safety={f.result.current} agent={f.props.agent} cell={f.props.cell} />,
  );
  expect(notices).toHaveLength(mode === "current blurred" ? 1 : 0);
  if (mode === "current blurred") {
    view.rerender(
      <SafetyControls safety={f.result.current} agent={f.props.agent} cell={f.props.cell} />,
    );
    expect(notices).toHaveLength(1);
    act(() => notices[0]?.onclick?.());
  }
  expect(fetchImpl).toHaveBeenCalledTimes(0);
});
