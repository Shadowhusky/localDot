// @vitest-environment jsdom

import type { ManualStreamInput } from "@localdot/protocol";
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
    history: true,
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
  const send = vi.fn<(input: ManualStreamInput) => void>();
  const drained = vi.fn(async () => true);
  const keyboard = vi.fn<(on: boolean) => void>();
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
            send={send}
            drained={drained}
            typing={false}
            onKeyboard={keyboard}
            refused={null}
          />
        ) : (
          <AskForm question={question} controls={controls} visible={visible} receiveKey={receive} />
        )}
        <StopControl controls={controls} />
      </>
    );
  }
  const view = render(<Parts />);
  return { ...view, fetchImpl, receive, model, Parts, send, drained, keyboard };
}
it("respects Chinese composition, exact pending ask ID and shared answer exclusion", async () => {
  const f = mount(false);
  fireEvent.click(screen.getByRole("radio", { name: "Something else…" }));
  const field = screen.getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement;
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
  expect(screen.getByRole("button", { name: "Send answer" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
});
it("guards question and hand-back notes before a recognized key can enter a request", async () => {
  const sentinel = `sk-proj-${"z".repeat(80)}`;
  for (const takeover of [false, true]) {
    const f = mount(takeover);
    if (!takeover) fireEvent.click(screen.getByRole("radio", { name: "Something else…" }));
    const field = screen.getByRole("textbox", {
      name: takeover ? "Optional note for dot" : "Your answer",
    }) as HTMLTextAreaElement;
    fireEvent.input(field, { target: { value: sentinel } });
    expect(field.value).toBe("");
    expect(f.container.textContent).not.toContain(sentinel);
    const send = screen.getByRole("button", {
      name: takeover ? "Return control to dot" : "Send answer",
    }) as HTMLButtonElement;
    expect(send.disabled || send.getAttribute("aria-disabled") === "true").toBe(true);
    const notice =
      "A key in your message was taken out before anything was sent. Move it to Keys to keep it safe, or discard it.";
    const described = () =>
      (send.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent);
    expect(described()).toContain(notice);
    fireEvent.click(send);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move to Keys" }));
    expect(f.receive).toHaveBeenCalledOnce();
    expect(described()).not.toContain(notice);
    f.unmount();
    cleanup();
  }
});
it("types pasted credentials on the computer through the input stream, clears the field and keeps them out of React state", async () => {
  const f = mount(true),
    sentinel = `sk-proj-${"p".repeat(80)} 中文🙂`;
  expect(screen.queryByLabelText("Text for the computer")).toBeNull();
  expect(screen.queryByRole("button", { name: "Type text" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Keyboard" }));
  expect(f.keyboard).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
  const field = screen.getByLabelText("Text to type on the computer") as HTMLTextAreaElement;
  expect(document.activeElement).toBe(field);
  fireEvent.paste(field, { clipboardData: { getData: () => sentinel } });
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ kind: "text", text: sentinel });
  expect(screen.queryByLabelText("Text to type on the computer")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
  const typed = screen.getByLabelText("Text to type on the computer") as HTMLTextAreaElement;
  typed.value = "line one";
  fireEvent.compositionStart(typed);
  fireEvent.keyDown(typed, { key: "Enter", isComposing: true });
  expect(f.send).toHaveBeenCalledOnce();
  fireEvent.compositionEnd(typed);
  fireEvent.keyDown(typed, { key: "Enter" });
  expect(f.send).toHaveBeenLastCalledWith({ kind: "text", text: "line one" });
  expect(f.container.innerHTML).not.toContain(sentinel);
  expect(JSON.stringify(f.model)).not.toContain(sentinel);
  fireEvent.click(screen.getByRole("button", { name: "Computer tab" }));
  expect(f.send).toHaveBeenLastCalledWith({ kind: "key", combo: ["tab"] });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
  const unsent = screen.getByLabelText("Text to type on the computer") as HTMLTextAreaElement;
  unsent.value = "unsent";
  fireEvent(window, new Event("blur"));
  expect(unsent.value).toBe("");
  unsent.value = "unsent";
  f.rerender(<f.Parts visible={false} />);
  expect(unsent.value).toBe("");
});
it("lets typed input reach the computer before control goes back to dot", async () => {
  const f = mount(true),
    drained = Promise.withResolvers<boolean>();
  f.drained.mockImplementation(() => drained.promise);
  fireEvent.click(screen.getByRole("button", { name: "Return control to dot" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.drained).toHaveBeenCalledOnce();
  expect(f.fetchImpl).not.toHaveBeenCalled();
  await act(async () => drained.resolve(true));
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(String(f.fetchImpl.mock.calls[0]?.[0])).toContain("/takeover/done");
});
it("picks an answer by its number, writes one under Something else, and sends only the choice", async () => {
  const f = mount(false);
  const send = screen.getByRole("button", { name: "Send answer" });
  expect(send.getAttribute("aria-disabled")).toBe("true");
  expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull();
  const form = screen.getByRole("form", { name: "Answer dot" });
  fireEvent.keyDown(form, { key: "2" });
  expect(screen.getByRole("radio", { name: "Something else…" })).toHaveProperty("checked", true);
  expect(screen.getByRole("textbox", { name: "Your answer" })).toBeTruthy();
  expect(send.getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(form, { key: "1" });
  expect(screen.getByRole("radio", { name: "Text" })).toHaveProperty("checked", true);
  expect(send.hasAttribute("aria-disabled")).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ askId: ID, option: "A" }));
});
