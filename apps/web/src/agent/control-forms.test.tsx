// @vitest-environment jsdom

import type { ManualStreamInput } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ControlTools } from "../shell/ControlStrip.tsx";
import { AskForm } from "./AskForm.tsx";
import { useAskDraft } from "./ask-draft.ts";
import {
  type AgentFeedState,
  type AgentQuestion,
  type AgentTakeover,
  emptyAgentModel,
} from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import { useHandBack } from "./useHandBack.ts";
import { type TaskControls, useTaskControls } from "./useTaskControls.ts";

const CELL = "01JXYZ0000000000000000CELL",
  SESSION = "01JXYZ0000000000000000SESS",
  ID = "01JXYZ00000000000000000001";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(takeover: boolean, manualControl: "ready" | "unconfirmed" = "ready") {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const api = createApi("fixture", { origin: "https://owned.invalid", fetchImpl });
  const question: AgentQuestion = {
    askId: ID,
    question: "Which result?",
    options: [{ key: "A", text: "Text" }],
    allowText: true,
  };
  const control: AgentTakeover = {
    requestId: ID,
    reason: "other",
    note: "",
    by: "user",
  };
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
      ...(takeover ? { pendingTakeover: ID, manualControl } : { pendingAsk: ID }),
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
  const rightClick = vi.fn<(on: boolean) => void>();
  const feed = { read: () => state, subscribe: () => () => {} };
  function Ask({ controls }: { controls: TaskControls }) {
    const draft = useAskDraft(question);
    return draft ? (
      <AskForm
        draft={draft}
        layout="thread"
        answer={controls.answer}
        reason={controls.canAnswer ? undefined : "Check the current task before answering."}
      />
    ) : null;
  }
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
    const handBack = useHandBack({ takeover: control, controls, drained });
    return takeover ? (
      <ControlTools
        send={send}
        typing={false}
        onKeyboard={keyboard}
        rightClick={false}
        onRightClick={rightClick}
        handBack={handBack.slot}
        onHandBack={() => void handBack.run()}
      />
    ) : (
      <Ask controls={controls} />
    );
  }
  const view = render(<Parts />);
  return { ...view, fetchImpl, receive, model, Parts, send, drained, keyboard, rightClick };
}
it("respects Chinese composition, exact pending ask ID and shared answer exclusion", async () => {
  const f = mount(false);
  const field = screen.getByRole("textbox", { name: "Something else" }) as HTMLInputElement;
  fireEvent.compositionStart(field);
  fireEvent.change(field, { target: { value: "中文" } });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field);
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.submit(screen.getByRole("form", { name: "Answer dot" }));
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ askId: ID, text: "中文" }));
  expect(screen.getByRole("button", { name: "Send answer" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  fireEvent.submit(screen.getByRole("form", { name: "Answer dot" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("keeps a recognized key out of an answer and out of the page", async () => {
  const sentinel = `sk-proj-${"z".repeat(80)}`;
  const f = mount(false);
  const field = screen.getByRole("textbox", { name: "Something else" }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: `use ${sentinel}` } });
  expect(field.value).toBe("use ");
  expect(f.container.innerHTML).not.toContain(sentinel);
  expect(screen.getByText(/That looked like a key/)).toBeTruthy();
  fireEvent.submit(screen.getByRole("form", { name: "Answer dot" }));
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ askId: ID, text: "use" }));
});
it("types pasted credentials on the computer through the input stream, clears the field and keeps them out of React state", async () => {
  const f = mount(true),
    sentinel = `sk-proj-${"p".repeat(80)} 中文🙂`;
  fireEvent.click(screen.getByRole("button", { name: "Keyboard" }));
  expect(f.keyboard).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Right-click the next tap" }));
  expect(f.rightClick).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Type text" }));
  const field = (await screen.findByLabelText(
    "Text to type on the computer",
  )) as HTMLTextAreaElement;
  fireEvent.paste(field, { clipboardData: { getData: () => sentinel } });
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ kind: "text", text: sentinel });
  await waitFor(() => expect(screen.queryByLabelText("Text to type on the computer")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Type text" }));
  const typed = (await screen.findByLabelText(
    "Text to type on the computer",
  )) as HTMLTextAreaElement;
  typed.value = "line one";
  fireEvent.compositionStart(typed);
  fireEvent.keyDown(typed, { key: "Enter", isComposing: true });
  expect(f.send).toHaveBeenCalledOnce();
  fireEvent.compositionEnd(typed);
  fireEvent.keyDown(typed, { key: "Enter" });
  expect(f.send).toHaveBeenLastCalledWith({ kind: "text", text: "line one" });
  expect(document.body.innerHTML).not.toContain(sentinel);
  expect(JSON.stringify(f.model)).not.toContain(sentinel);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByLabelText("Text to type on the computer")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Type text" }));
  const unsent = (await screen.findByLabelText(
    "Text to type on the computer",
  )) as HTMLTextAreaElement;
  unsent.value = "unsent";
  fireEvent(window, new Event("blur"));
  expect(unsent.value).toBe("");
});
it("lets typed input reach the computer before control goes back to dot", async () => {
  const f = mount(true),
    drained = Promise.withResolvers<boolean>();
  f.drained.mockImplementation(() => drained.promise);
  fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.drained).toHaveBeenCalledOnce();
  expect(f.fetchImpl).not.toHaveBeenCalled();
  await act(async () => drained.resolve(true));
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(String(f.fetchImpl.mock.calls[0]?.[0])).toContain("/takeover/done");
});
it("hands back while the computer is still confirming the user's last input", async () => {
  const f = mount(true, "unconfirmed");
  const handBack = screen.getByRole("button", { name: "Hand back" });
  expect(handBack.hasAttribute("aria-disabled")).toBe(false);
  fireEvent.click(handBack);
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(String(f.fetchImpl.mock.calls[0]?.[0])).toContain("/takeover/done");
});
it("picks an answer by its number, writes one under Something else, and sends only the choice", async () => {
  const f = mount(false);
  const send = screen.getByRole("button", { name: "Send answer" });
  expect(send.getAttribute("aria-disabled")).toBe("true");
  const form = screen.getByRole("form", { name: "Answer dot" });
  fireEvent.change(screen.getByRole("textbox", { name: "Something else" }), {
    target: { value: "Both" },
  });
  expect(screen.getByRole("radio", { name: "Text" })).toHaveProperty("checked", false);
  expect(send.hasAttribute("aria-disabled")).toBe(false);
  fireEvent.keyDown(form, { key: "1" });
  expect(screen.getByRole("radio", { name: "Text" })).toHaveProperty("checked", true);
  expect(send.hasAttribute("aria-disabled")).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
  expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ askId: ID, option: "A" }));
});
