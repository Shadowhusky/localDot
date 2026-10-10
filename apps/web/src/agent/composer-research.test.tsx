// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";
import { emptyAgentModel } from "./model.ts";
import { requestResearch } from "./research.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

const cellId = "01JXYZ0000000000000000CE11";
const sessionId = "01JXYZ0000000000000000SESS";
const cell: CellSummary = {
  id: cellId,
  state: "ready",
  scale: 2,
  createdAt: "t",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
const fresh: AgentSessionView = {
  sessionId: null,
  model: emptyAgentModel(),
  snapshot: null,
  availability: "ready",
  error: null,
  fresh: false,
  connection: "live",
  reconcile: vi.fn(),
};
const running: AgentSessionView = {
  ...fresh,
  sessionId,
  snapshot: { sessionId, cellId, status: "running", toolCalls: 0 },
  fresh: true,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(agent: AgentSessionView, over: Partial<ComposerProps> = {}) {
  const requests: { path: string; body: unknown }[] = [];
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, body: JSON.parse(String(init?.body)) });
      return path.endsWith("/agent")
        ? Response.json({ sessionId: "01JXYZ00000000000000000NEW" }, { status: 202 })
        : new Response(null, { status: 202 });
    },
  });
  const props: ComposerProps = {
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
  const field = view.container.querySelector("textarea") as HTMLTextAreaElement;
  return {
    ...view,
    field,
    requests,
    toggle: () => screen.getByRole("button", { name: /^Research/ }),
    input: (text: string) => fireEvent.input(field, { target: { value: text } }),
    submit: () => fireEvent.submit(screen.getByRole("form", { name: "Message dot" })),
    rerender: (agent: AgentSessionView) => view.rerender(<Composer {...props} agent={agent} />),
  };
}

describe("research in the composer", () => {
  it("starts the next task as research, then goes back to ordinary messages", async () => {
    const f = setup(fresh);
    expect(f.toggle().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(f.toggle());
    expect(f.toggle().getAttribute("aria-pressed")).toBe("true");
    expect(f.field.placeholder).toBe("What should dot research?");
    screen.getByRole("button", { name: "Start research" });
    f.input("Which heat pumps work best below -15 C?");
    await act(async () => f.submit());
    expect(f.requests).toEqual([
      {
        path: `/api/cells/${cellId}/agent`,
        body: { task: "Which heat pumps work best below -15 C?", mode: "research" },
      },
    ]);
    expect(f.toggle().getAttribute("aria-pressed")).toBe("false");
  });
  it("starts research from a conversation at rest instead of sending a follow-up", async () => {
    const f = setup({
      ...running,
      snapshot: { sessionId, cellId, status: "idle", toolCalls: 3 },
    });
    fireEvent.click(f.toggle());
    f.input("Now compare their warranties");
    await act(async () => f.submit());
    expect(f.requests[0]).toEqual({
      path: `/api/cells/${cellId}/agent`,
      body: { task: "Now compare their warranties", mode: "research" },
    });
  });
  it("sends an ordinary task when research is off", async () => {
    const f = setup(fresh);
    f.input("Book a table for two");
    await act(async () => f.submit());
    expect(f.requests[0]?.body).toEqual({ task: "Book a table for two" });
  });
  it("keeps its place but waits while dot works, and queues the next message", async () => {
    const f = setup(running);
    expect(f.toggle().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(f.toggle());
    expect(f.toggle().getAttribute("aria-pressed")).toBe("false");
    f.input("Focus on prices");
    await act(async () => f.submit());
    expect(f.requests[0]).toEqual({
      path: `/api/agent/sessions/${sessionId}/messages`,
      body: { kind: "followup", text: "Focus on prices" },
    });
  });
  it("lets dot suggest research once typing pauses, without a word in the layout", () => {
    vi.useFakeTimers();
    const f = setup(fresh);
    f.input("Compare the evidence on intermittent fasting and cite your sources");
    expect(f.toggle().hasAttribute("data-suggested")).toBe(false);
    act(() => vi.advanceTimersByTime(700));
    expect(f.toggle().hasAttribute("data-suggested")).toBe(true);
    expect(f.toggle().textContent).toBe("Research");
    f.input("Send Anna the slides");
    act(() => vi.advanceTimersByTime(700));
    expect(f.toggle().hasAttribute("data-suggested")).toBe(false);
  });
  it("keeps a phone's field to its words: research comes from More and shows over the field", async () => {
    vi.useFakeTimers();
    const f = setup(fresh, { layout: "pill" });
    expect(screen.queryByRole("button", { name: /^Research/ })).toBeNull();
    act(() => requestResearch());
    expect(screen.getByText("a cited report")).toBeTruthy();
    expect(document.activeElement).toBe(f.field);
    fireEvent.click(screen.getByRole("button", { name: "Don't research" }));
    f.input("Compare the evidence on intermittent fasting and cite your sources");
    act(() => vi.advanceTimersByTime(700));
    fireEvent.click(screen.getByRole("button", { name: "Research this question" }));
    vi.useRealTimers();
    await act(async () => f.submit());
    expect(f.requests[0]?.body).toEqual({
      task: "Compare the evidence on intermittent fasting and cite your sources",
      mode: "research",
    });
  });
  it("leaves a request from More alone while dot works", () => {
    setup(running, { layout: "pill" });
    act(() => requestResearch());
    expect(screen.queryByText("a cited report")).toBeNull();
  });
});
