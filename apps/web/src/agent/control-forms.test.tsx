// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { AskForm } from "./AskForm.tsx";
import {
  type AgentFeedState,
  type AgentQuestion,
  type AgentTakeover,
  emptyAgentModel,
} from "./model.ts";
import { StopControl } from "./StopControl.tsx";
import { TakeoverPanel } from "./TakeoverPanel.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import { useTaskControls } from "./useTaskControls.ts";

const CELL = "01JXYZ0000000000000000CELL",
  SESSION = "01JXYZ0000000000000000SESS",
  ID = "01JXYZ00000000000000000001";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(takeover: boolean) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const api = createApi("fixture", { origin: "https://owned.invalid", fetchImpl });
  const question: AgentQuestion = {
    askId: ID,
    question: "Which result?",
    options: [{ key: "A", text: "Text" }],
    allowText: true,
  };
  const control: AgentTakeover = { requestId: ID, reason: "login", note: "Sample login" };
  const model = {
    ...emptyAgentModel(),
    pendingAsk: takeover ? null : ID,
    pendingTakeover: takeover ? ID : null,
    questions: new Map([[ID, question]]),
    takeovers: new Map([[ID, control]]),
  };
  const state: AgentFeedState = {
    cellId: CELL,
    sessionId: SESSION,
    epoch: 0,
    connection: "live",
    replayed: true,
    streamError: null,
    model,
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
    fresh: true,
    authorityEpoch: 0,
    error: null,
    connection: "live",
    reconcile: vi.fn(),
  };
  const receive = vi.fn(() => true);
  const feed = { read: () => state, subscribe: () => () => {} };
  function Parts({ visible = true }: { visible?: boolean }) {
    const controls = useTaskControls({
      api,
      cell: {
        id: CELL,
        state: "ready",
        scale: 1,
        createdAt: "",
        stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
      },
      cellPending: null,
      agent,
      feed,
      suspended: !visible,
      manualVisible: visible,
      refreshCell: () => {},
    });
    return (
      <>
        {takeover ? (
          <TakeoverPanel
            takeover={control}
            controls={controls}
            visible={visible}
            manualStatus="ready"
            receiveKey={receive}
            screen={{ w: 1280, h: 800 }}
            pointerMode="click"
            onPointerMode={() => {}}
          />
        ) : (
          <AskForm question={question} controls={controls} visible={visible} receiveKey={receive} />
        )}
        <StopControl controls={controls} />
      </>
    );
  }
  const view = render(<Parts />);
  return { ...view, fetchImpl, receive, model, Parts };
}
it("respects Chinese composition, exact pending ask ID and shared answer exclusion", async () => {
  const f = mount(false),
    field = screen.getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement;
  fireEvent.compositionStart(field);
  fireEvent.input(field, { target: { value: "中文" } });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field);
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.submit(screen.getByRole("form", { name: "Answer dot" }));
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ askId: ID, text: "中文" }));
  await waitFor(() => expect(field.value).toBe(""));
  expect(screen.getByRole("button", { name: "Send answer" })).toHaveProperty("disabled", true);
});
it("guards question and hand-back notes before a recognized key can enter a request", async () => {
  const sentinel = `sk-proj-${"z".repeat(80)}`;
  for (const takeover of [false, true]) {
    const f = mount(takeover),
      field = screen.getByRole("textbox", {
        name: takeover ? "Optional note for dot" : "Your answer",
      }) as HTMLTextAreaElement;
    fireEvent.input(field, { target: { value: sentinel } });
    expect(field.value).toBe("");
    expect(f.container.textContent).not.toContain(sentinel);
    const send = screen.getByRole("button", {
      name: takeover ? "Return control to dot" : "Send answer",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(document.getElementById(send.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "1 recognised key was removed from your message. Discard it or move it to Keys before sending.",
    );
    fireEvent.click(send);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move to Keys" }));
    expect(f.receive).toHaveBeenCalledOnce();
    expect(send.hasAttribute("aria-describedby")).toBe(false);
    f.unmount();
    cleanup();
  }
});
it("sends credentials through the manual text route, clears before transport and on hide/blur, and avoids React text state", async () => {
  const f = mount(true),
    field = screen.getByLabelText("Text for the computer") as HTMLInputElement,
    sentinel = `sk-proj-${"p".repeat(80)} 中文🙂`;
  fireEvent.input(field, { target: { value: sentinel } });
  fireEvent.compositionStart(field);
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field);
  fireEvent.click(screen.getByRole("button", { name: "Type text" }));
  expect(field.value).toBe("");
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe(
    JSON.stringify({ requestId: ID, input: { kind: "text", text: sentinel } }),
  );
  expect(f.container.innerHTML).not.toContain(sentinel);
  expect(JSON.stringify(f.model)).not.toContain(sentinel);
  await act(async () => {
    await Promise.resolve();
  });
  field.value = "unsent";
  fireEvent(window, new Event("blur"));
  expect(field.value).toBe("");
  field.value = "unsent";
  f.rerender(<f.Parts visible={false} />);
  expect(field.value).toBe("");
});
