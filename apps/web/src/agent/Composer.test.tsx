// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";
import { emptyAgentModel } from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

// Lets one test pass a key-shaped name through the upload's own guards to reach Send's check.
const transfer = vi.hoisted(() => ({ trustNames: false }));
vi.mock("./file-transfer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./file-transfer.ts")>();
  return {
    ...actual,
    safeTransferName: (name: string) => transfer.trustNames || actual.safeTransferName(name),
    uploadFile: async (...args: Parameters<typeof actual.uploadFile>) =>
      transfer.trustNames ? `~/Downloads/${args[2].name}` : actual.uploadFile(...args),
  };
});

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
  transfer.trustNames = false;
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
  it("retains a refused new task when polling retires the stopped owner, but clears it on another task", async () => {
    const f = setup(() => new Response("refused", { status: 409 }), {
      agent: { ...agent, model: { ...emptyAgentModel(), ended: { reason: "stopped" } } },
    });
    f.input("explicit new task after Stop");
    f.submit();
    await screen.findByText(/The daemon refused this message/);
    f.update({ agent: { ...agent, sessionId: null, snapshot: null, fresh: false } });
    expect(screen.getByText(/The daemon refused this message/)).toBeTruthy();
    expect(f.field.value).toBe("explicit new task after Stop");
    expect(f.requests).toHaveLength(1);
    f.update({
      agent: {
        ...agent,
        sessionId: otherSession,
        snapshot: { ...snapshot, sessionId: otherSession },
      },
    });
    expect(screen.queryByText(/The daemon refused this message/)).toBeNull();
    expect(f.requests).toHaveLength(1);
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
  it("asks for the new task's session as soon as the start is accepted", async () => {
    const onTaskStarted = vi.fn();
    const f = setup(() => Response.json({ sessionId }, { status: 202 }), {
      agent: { ...agent, sessionId: null, snapshot: null, fresh: false },
      onTaskStarted,
    });
    f.input("new task");
    await act(async () => f.submit());
    await waitFor(() => expect(onTaskStarted).toHaveBeenCalledOnce());
    f.update({ agent });
    f.input("steer the running task");
    await act(async () => f.submit());
    await waitFor(() => expect(f.requests).toHaveLength(2));
    expect(onTaskStarted).toHaveBeenCalledOnce();
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
    fireEvent.click(screen.getByRole("button", { name: "Discard key and edit" }));
    f.field.value = key;
    f.submit();
    expect(f.field.value).toBe("");
    expect(f.requests).toEqual([]);
    expect(screen.queryByLabelText("Message delivery")).toBeNull();
  });
  it("lets a draft with a detected key reach Send only by discarding the key", async () => {
    const f = setup();
    const key = `sk-ant-api03-${"x".repeat(40)}`;
    f.input(`token ${key} please`);
    const send = screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const reason = document.getElementById(send.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("1 recognised key was removed from your message");
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    f.input(`${f.field.value} continue`);
    fireEvent.keyDown(f.field, { key: "Enter" });
    f.submit();
    expect(f.requests).toEqual([]);
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard key and edit" }));
    expect(screen.queryByRole("region", { name: "Key safeguard" })).toBeNull();
    expect(document.activeElement).toBe(f.field);
    expect(send.disabled).toBe(false);
    expect(send.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.keyDown(f.field, { key: "Enter" });
    await act(async () => {});
    expect(f.requests).toEqual([
      {
        path: `/api/agent/sessions/${sessionId}/messages`,
        body: { kind: "steer", text: "token  please continue" },
      },
    ]);
    expect(JSON.stringify(f.requests)).not.toContain("sk-ant-api03");
  });
  it("rejects empty and oversized drafts, with an exact 8000-character positive", async () => {
    const f = setup();
    for (const value of ["", "  ", "x".repeat(8001)]) {
      f.field.value = value;
      f.submit();
    }
    expect(f.requests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
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
  it("opens model settings before any computer exists and keeps the draft", () => {
    const onSettings = vi.fn();
    const f = setup(undefined, {
      cell: null,
      known: false,
      agent: { ...agent, sessionId: null, snapshot: null, fresh: false },
      configured: false,
      onSettings,
    });
    expect(f.field.disabled).toBe(false);
    f.input("Draft the monthly summary");
    const connect = screen.getByRole("button", { name: "Connect a model" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect(onSettings).toHaveBeenCalledExactlyOnceWith(f.field);
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(onSettings).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.field.value).toBe("Draft the monthly summary");
    expect(f.requests).toEqual([]);
  });
});

describe("explicit composer attachments", () => {
  it("serializes picker and drop uploads, then cites only confirmed paths on explicit Send", async () => {
    const first = Promise.withResolvers<Response>();
    const calls: { path: string; body: unknown }[] = [];
    const one = new File(["one"], "one.txt"),
      two = new File(["two"], "two.txt");
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: async (url, init) => {
        const target = new URL(String(url));
        calls.push({ path: target.pathname, body: init?.body });
        if (target.pathname.endsWith("/upload"))
          return target.searchParams.get("name") === "one.txt"
            ? first.promise
            : Response.json({ path: "~/Downloads/two.txt" }, { status: 201 });
        return new Response(null, { status: 202 });
      },
    });
    const f = setup(undefined, { api });
    f.input("Read both sample files");
    fireEvent.change(screen.getByLabelText("Add files"), { target: { files: [one] } });
    fireEvent.drop(screen.getByRole("form", { name: "Message dot" }), {
      dataTransfer: { files: [two], types: ["Files"] },
    });
    f.submit();
    expect(calls.map((c) => c.body)).toEqual([one]);
    await act(async () =>
      first.resolve(Response.json({ path: "~/Downloads/one.txt" }, { status: 201 })),
    );
    await waitFor(() => expect(screen.getAllByText("Uploaded to Downloads")).toHaveLength(2));
    expect(calls.map((c) => c.body)).toEqual([one, two]);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await screen.findByText("Accepted by the daemon.");
    expect(JSON.parse(String(calls[2]?.body))).toEqual({
      kind: "steer",
      text: "Read both sample files\n\nAttached files on this computer:\n- ~/Downloads/one.txt\n- ~/Downloads/two.txt",
    });
    expect(f.field.value).toBe("");
    expect(screen.queryByText("Uploaded to Downloads")).toBeNull();
  });
  it("cannot cite a forged upload acknowledgment or send an unconfirmed attachment", async () => {
    const calls: string[] = [];
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: async (url) => {
        calls.push(new URL(String(url)).pathname);
        return Response.json({ path: "~/Downloads/other.txt" }, { status: 201 });
      },
    });
    const f = setup(undefined, { api });
    f.input("Read the file");
    fireEvent.change(screen.getByLabelText("Add files"), {
      target: { files: [new File(["x"], "one.txt")] },
    });
    await screen.findByText("Upload unconfirmed");
    f.submit();
    expect(calls).toEqual([`/api/cells/${cellId}/upload`]);
    expect(f.field.value).toBe("Read the file");
    expect(screen.queryByLabelText("Message delivery")).toBeNull();
    expect(screen.getByText(/Finish or remove unconfirmed uploads/)).toBeTruthy();
  });
  it("refuses to cite a confirmed attachment whose name looks like a key", async () => {
    transfer.trustNames = true;
    const key = `sk-ant-api03-${"x".repeat(40)}`;
    const f = setup();
    f.input("Read the file");
    fireEvent.change(screen.getByLabelText("Add files"), {
      target: { files: [new File(["x"], `${key}.txt`)] },
    });
    await screen.findByText("Uploaded to Downloads");
    f.submit();
    await act(async () => {});
    expect(f.requests).toEqual([]);
    expect(f.field.value).toBe("Read the file");
    expect(screen.queryByLabelText("Message delivery")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(
      "Shorten the message or attachment names before sending.",
    );
  });
  it("retains the original confirmed attachment references for an explicit uncertain-message retry", async () => {
    const delivered: string[] = [];
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/upload"))
          return Response.json({ path: "~/Downloads/one.txt" }, { status: 201 });
        delivered.push(String(init?.body));
        if (delivered.length === 1) throw new Error("lost after admission");
        return new Response(null, { status: 202 });
      },
    });
    const f = setup(undefined, { api });
    f.input("Original text");
    fireEvent.change(screen.getByLabelText("Add files"), {
      target: { files: [new File(["x"], "one.txt")] },
    });
    await screen.findByText("Uploaded to Downloads");
    f.submit();
    await screen.findByText(/reply was lost/);
    f.input("New unsent draft");
    f.submit();
    expect(delivered).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Resend once, risking a duplicate" }));
    await screen.findByText("Accepted by the daemon.");
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toBe(delivered[0]);
    expect(JSON.parse(delivered[0] as string).text).toContain("~/Downloads/one.txt");
    expect(f.field.value).toBe("New unsent draft");
    expect(screen.queryByText("Uploaded to Downloads")).toBeNull();
  });
});
