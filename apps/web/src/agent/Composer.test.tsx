// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";
import { emptyAgentModel } from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

const cellId = "01JXYZ0000000000000000CE11";
const sessionId = "01JXYZ0000000000000000SESS";
const otherSession = "01JXYZ00000000000000000002";
const cell: CellSummary = {
  id: cellId,
  state: "ready",
  scale: 2,
  createdAt: "t",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
const snapshot = { sessionId, cellId, status: "running" as const, toolCalls: 0 };
const agent: AgentSessionView = {
  sessionId,
  model: emptyAgentModel(),
  snapshot: { sessionId, cellId, status: "running", toolCalls: 0 },
  availability: "ready",
  error: null,
  fresh: true,
  connection: "live",
  reconcile: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup(
  response: () => Response | Promise<Response> = () => new Response(null, { status: 202 }),
  over: Partial<ComposerProps> = {},
) {
  const requests: { path: string; body: unknown }[] = [];
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async (url, init) => {
      requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return response();
    },
  });
  let props: ComposerProps = {
    api,
    cell,
    agent,
    known: true,
    pending: false,
    keysOpen: false,
    receiveKey: vi.fn(() => false),
    ...over,
  };
  const view = render(<Composer {...props} />);
  const field =
    (screen.queryByLabelText("Message") as HTMLTextAreaElement | null) ??
    (screen.getByLabelText("New task") as HTMLTextAreaElement);
  const input = (text: string) => fireEvent.input(field, { target: { value: text } });
  const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Message dot" }));
  return {
    ...view,
    field,
    input,
    submit,
    requests,
    get props() {
      return props;
    },
    update(over: Partial<ComposerProps>) {
      props = { ...props, ...over };
      view.rerender(<Composer {...props} />);
    },
  };
}
describe("composer delivery ownership and draft handling", () => {
  it("offers Move to Keys before a computer exists, without delivering a task", () => {
    const receiveKey = vi.fn(() => true);
    const f = setup(undefined, {
      cell: null,
      agent: { ...agent, sessionId: null, snapshot: null, fresh: false },
      receiveKey,
    });
    const key = `sk-proj-${"z".repeat(80)}`;
    fireEvent.paste(f.field, { clipboardData: { getData: () => `use ${key} for setup` } });
    expect(f.field.value).toBe("use  for setup");
    fireEvent.click(screen.getByRole("button", { name: "Move to Keys" }));
    expect(receiveKey).toHaveBeenCalledOnce();
    expect(f.requests).toEqual([]);
    expect(document.body.innerHTML).not.toContain(key);
  });
  it("preserves ordinary DOM replacements even if no input event updated the revision", async () => {
    const pending = Promise.withResolvers<Response>();
    const f = setup(() => pending.promise);
    f.input("original ordinary text");
    f.submit();
    f.field.value = "replacement draft without an input event";
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(f.field.value).toBe("replacement draft without an input event");
    expect(f.requests).toHaveLength(1);
  });
  it("synchronously fences duplicate Enter/click submits and clears only confirmed text", async () => {
    const pending = Promise.withResolvers<Response>();
    const f = setup(() => pending.promise);
    f.input("请继续 monthly report");
    act(() => {
      f.field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      f.submit();
      f.submit();
    });
    expect(f.requests).toEqual([
      {
        path: `/api/agent/sessions/${sessionId}/messages`,
        body: { kind: "steer", text: "请继续 monthly report" },
      },
    ]);
    expect(f.field.value).toBe("请继续 monthly report");
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(f.field.value).toBe("");
    expect(screen.getByText("Accepted by the daemon.")).toBeTruthy();
  });
  it("preserves a newer draft even when its text equals the accepted message", async () => {
    const pending = Promise.withResolvers<Response>();
    const f = setup(() => pending.promise);
    f.input("same text");
    f.submit();
    f.input("same text");
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(f.field.value).toBe("same text");
    f.submit();
    expect(f.requests).toHaveLength(2);
  });
  it("ignores completion after a session switch and does not clear the new task's draft", async () => {
    const pending = Promise.withResolvers<Response>();
    const f = setup(() => pending.promise);
    f.input("old session text");
    f.submit();
    f.update({
      agent: {
        ...agent,
        sessionId: otherSession,
        snapshot: { ...snapshot, sessionId: otherSession },
      },
    });
    f.input("new session draft");
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(f.field.value).toBe("new session draft");
    expect(screen.queryByText("Accepted by the daemon.")).toBeNull();
    f.submit();
    expect(f.requests.at(-1)?.path).toContain(otherSession);
  });
  it("never resends an uncertain action until the user chooses the explicit duplicate-risk retry", async () => {
    let attempts = 0;
    const f = setup(() => {
      if (++attempts === 1) throw new Error("lost after acceptance");
      return new Response(null, { status: 202 });
    });
    f.input("captured ordinary message");
    f.submit();
    await screen.findByText(/reply was lost/);
    expect(f.field.value).toBe("captured ordinary message");
    f.input("new unsent draft");
    f.submit();
    expect(f.requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check current task" }));
    expect(agent.reconcile).toHaveBeenCalled();
    expect(f.requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Resend once, risking a duplicate" }));
    await screen.findByText("Accepted by the daemon.");
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.body).toEqual({ kind: "steer", text: "captured ordinary message" });
    expect(f.field.value).toBe("new unsent draft");
  });
  it("does not interpret Shift/modified Enter or IME composition as submit", () => {
    const f = setup();
    f.input("多行\ntext");
    for (const modifier of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
    ])
      fireEvent.keyDown(f.field, { key: "Enter", ...modifier });
    fireEvent.compositionStart(f.field);
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(f.requests).toEqual([]);
    fireEvent.compositionEnd(f.field);
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.body).toEqual({ kind: "steer", text: "多行\ntext" });
  });
  it("fences two synchronous duplicate-risk retry clicks", async () => {
    const pending = Promise.withResolvers<Response>();
    let attempts = 0;
    const f = setup(() => {
      if (++attempts === 1) throw new Error("lost");
      return pending.promise;
    });
    f.input("captured message");
    f.submit();
    await screen.findByText(/reply was lost/);
    const retry = screen.getByRole("button", { name: "Resend once, risking a duplicate" });
    act(() => {
      retry.click();
      retry.click();
      f.submit();
    });
    expect(f.requests).toHaveLength(2);
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(screen.getByText("Accepted by the daemon.")).toBeTruthy();
  });
  it("checks the current field before retrying a captured ordinary request", async () => {
    const f = setup(() => {
      throw new Error("lost");
    });
    f.input("ordinary request");
    f.submit();
    await screen.findByText(/reply was lost/);
    const key = `sk-proj-${"a".repeat(156)}`;
    f.field.value = key;
    fireEvent.click(screen.getByRole("button", { name: "Resend once, risking a duplicate" }));
    expect(f.requests).toHaveLength(1);
    expect(f.field.value).toBe("");
    expect(document.body.innerHTML).not.toContain(key);
    expect(
      screen
        .getByRole("button", { name: "Resend once, risking a duplicate" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("retains the start gate when live polling adopts its session before the confirmed reply", async () => {
    const pending = Promise.withResolvers<Response>();
    const f = setup(() => pending.promise, {
      agent: { ...agent, sessionId: null, snapshot: null, fresh: false },
    });
    f.input("new task awaiting reply");
    f.submit();
    f.update({ agent });
    f.submit();
    expect(f.requests).toHaveLength(1);
    await act(async () => pending.resolve(Response.json({ sessionId }, { status: 202 })));
    expect(f.field.value).toBe("");
    expect(screen.getByText("Accepted by the daemon.")).toBeTruthy();
  });
  it("does not acknowledge or clear a start reply for an unrelated adopted session", async () => {
    const pending = Promise.withResolvers<Response>();
    const f = setup(() => pending.promise, {
      agent: { ...agent, sessionId: null, snapshot: null, fresh: false },
    });
    f.input("new task awaiting reply");
    f.submit();
    f.update({
      agent: {
        ...agent,
        sessionId: otherSession,
        snapshot: { ...snapshot, sessionId: otherSession },
      },
    });
    await act(async () => pending.resolve(Response.json({ sessionId }, { status: 202 })));
    expect(f.field.value).toBe("new task awaiting reply");
    expect(screen.queryByText("Accepted by the daemon.")).toBeNull();
    expect(screen.getByText(/task changed while sending/)).toBeTruthy();
  });
  it("keeps a lost start reply uncertain after adoption and permits explicit dismissal without resending", async () => {
    const pending = Promise.withResolvers<Response>();
    const f = setup(() => pending.promise, {
      agent: { ...agent, sessionId: null, snapshot: null, fresh: false },
    });
    f.input("new task awaiting reply");
    f.submit();
    f.update({ agent });
    await act(async () => pending.reject(new Error("lost after start")));
    expect(screen.getByText(/reply was lost/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Resend once, risking a duplicate" })
        .hasAttribute("disabled"),
    ).toBe(true);
    f.input("new unsent draft");
    f.submit();
    expect(f.requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep draft and stop retrying" }));
    expect(f.field.value).toBe("new unsent draft");
    expect(screen.getByText(/Delivery is still unconfirmed/)).toBeTruthy();
    expect(f.requests).toHaveLength(1);
    expect(screen.queryByLabelText("Message delivery")).toBeNull();
  });
  it("captures the selected mode synchronously and labels paused/takeover messages honestly", async () => {
    const f = setup();
    f.input("afterwards");
    act(() => {
      fireEvent.click(screen.getByLabelText("After this task"));
      f.submit();
    });
    expect(f.requests[0]?.body).toEqual({ kind: "followup", text: "afterwards" });
    await act(async () => {});
    f.update({ agent: { ...agent, snapshot: { ...snapshot, status: "paused" } } });
    expect(
      screen.getByText("A message does not resume the task or hand back control."),
    ).toBeTruthy();
    f.update({ agent: { ...agent, model: { ...agent.model, pendingTakeover: otherSession } } });
    expect(
      screen.getByText("A message does not resume the task or hand back control."),
    ).toBeTruthy();
  });
  it.each([
    "stale",
    "paused computer",
    "pending computer",
    "unknown computer",
    "Keys modal",
    "offline",
  ] as const)("refuses even a forged submit while %s", async (reason) => {
    const f = setup();
    f.input("ordinary text");
    if (reason === "stale") f.update({ agent: { ...agent, fresh: false } });
    else if (reason === "paused computer") f.update({ cell: { ...cell, paused: true } });
    else if (reason === "pending computer") f.update({ pending: true });
    else if (reason === "unknown computer") f.update({ known: false });
    else if (reason === "Keys modal") f.update({ keysOpen: true });
    else vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    f.submit();
    await act(async () => {});
    expect(f.requests).toEqual([]);
    expect(f.field.value).toBe("ordinary text");
  });
  it("checks pasted and synthetic-submit keys before delivery state, requests or a key preview", () => {
    const f = setup();
    const key = `sk-proj-${"a".repeat(156)}`;
    fireEvent.paste(f.field, { clipboardData: { getData: () => `before ${key} after` } });
    expect(f.field.value).toBe("before  after");
    f.submit();
    expect(f.requests).toEqual([]);
    expect(document.body.innerHTML).not.toContain(key);
    fireEvent.click(screen.getByRole("button", { name: "Discard detected keys" }));
    f.field.value = key;
    f.submit();
    expect(f.field.value).toBe("");
    expect(f.requests).toEqual([]);
    expect(screen.queryByLabelText("Message delivery")).toBeNull();
  });
  it("rejects empty and oversized drafts, with an exact 8000-character positive", async () => {
    const f = setup();
    for (const value of ["", "  ", "x".repeat(8001)]) {
      f.field.value = value;
      f.submit();
    }
    expect(f.requests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Review message" }));
    f.input("x".repeat(8000));
    f.submit();
    expect(f.requests).toHaveLength(1);
    await act(async () => {});
  });
  it("starts a new task and sends idle follow-up without creating a new session", async () => {
    const f = setup(() => Response.json({ sessionId }, { status: 202 }));
    f.update({ agent: { ...agent, sessionId: null, snapshot: null, fresh: false } });
    f.input("new task");
    f.submit();
    await act(async () => {});
    expect(f.requests[0]).toEqual({
      path: `/api/cells/${cellId}/agent`,
      body: { task: "new task" },
    });
    f.update({
      agent: { ...agent, snapshot: { ...snapshot, status: "idle" } },
      api: createApi("fixture", {
        origin: "http://127.0.0.1:4790",
        fetchImpl: async (url, init) => {
          f.requests.push({
            path: new URL(String(url)).pathname,
            body: JSON.parse(String(init?.body)),
          });
          return new Response(null, { status: 202 });
        },
      }),
    });
    f.input("idle follow-up");
    f.submit();
    await act(async () => {});
    expect(f.requests.at(-1)).toEqual({
      path: `/api/agent/sessions/${sessionId}/messages`,
      body: { kind: "followup", text: "idle follow-up" },
    });
  });
});
