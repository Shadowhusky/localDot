// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { requestRevise } from "../deliverables/revise-draft.ts";
import { createApi } from "../lib/api.ts";
import type { TextAreaProps } from "../ui/TextArea.tsx";
import { withAttachments } from "./attachments.ts";
import { Composer, type ComposerProps, type ReplyOutcome } from "./Composer.tsx";
import { type AgentMessage, emptyAgentModel } from "./model.ts";
import { Outbox } from "./outbox.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

const spoken = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("../ui/Announcer.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/Announcer.tsx")>()),
  announce: spoken.announce,
}));
// What the composer said through the page's one polite region.
const said = () =>
  spoken.announce.mock.calls.flatMap(([channel, text]) => (channel === "composer" ? [text] : []));

// How often the message field itself renders, and how often a key scan runs.
const counts = vi.hoisted(() => ({ field: 0, scans: 0 }));
vi.mock("../ui/TextArea.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/TextArea.tsx")>();
  return {
    ...actual,
    TextArea: (props: TextAreaProps) => {
      counts.field += 1;
      return <actual.TextArea {...props} />;
    },
  };
});
vi.mock("@localdot/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@localdot/protocol")>();
  return {
    ...actual,
    scanKeyLike: (text: string) => {
      counts.scans += 1;
      return actual.scanKeyLike(text);
    },
  };
});

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
  vi.unstubAllGlobals();
  spoken.announce.mockClear();
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
  const attach = (...files: File[]) =>
    fireEvent.change(view.container.querySelector("input[type=file]") as HTMLInputElement, {
      target: { files },
    });
  return {
    ...view,
    field,
    input,
    submit,
    attach,
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
  it("switches the same button from Stop to queue Send while there is a draft", async () => {
    const stop = vi.fn();
    const f = setup(undefined, { taskAction: { kind: "stop", run: stop } });
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    expect(stop).toHaveBeenCalledOnce();
    f.input("Keep this follow-up");
    expect(screen.queryByRole("button", { name: "Stop task" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    await waitFor(() => expect(f.field.value).toBe(""));
    expect(f.requests[0]?.body).toEqual({ kind: "followup", text: "Keep this follow-up" });
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Stop task" })).toBeTruthy();
  });
  it("can still steer immediately through the explicit Send now menu action", async () => {
    const f = setup();
    f.input("Change direction now");
    fireEvent.click(screen.getByRole("button", { name: "Message options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send now" }));
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]?.body).toEqual({ kind: "steer", text: "Change direction now" });
  });

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
        body: { kind: "followup", text: "请继续 monthly report" },
      },
    ]);
    expect(f.field.value).toBe("请继续 monthly report");
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(f.field.value).toBe("");
    expect(said().at(-1)).toBe("Sent to dot.");
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
    expect(said()).toEqual([]);
    f.submit();
    expect(f.requests.at(-1)?.path).toContain(otherSession);
  });
  it("never resends an uncertain action until the user chooses the explicit duplicate-risk retry", async () => {
    let attempts = 0;
    const reconcile = vi.fn();
    const f = setup(
      () => {
        if (++attempts === 1) throw new Error("lost after acceptance");
        return new Response(null, { status: 202 });
      },
      { agent: { ...agent, reconcile } },
    );
    f.input("captured ordinary message");
    f.submit();
    await screen.findByText(/Not sure dot got that/);
    expect(f.field.value).toBe("captured ordinary message");
    f.input("new unsent draft");
    f.submit();
    // The task is checked at once, and that sends nothing.
    expect(reconcile).toHaveBeenCalledOnce();
    expect(f.requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(said().at(-1)).toBe("Sent to dot."));
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.body).toEqual({ kind: "followup", text: "captured ordinary message" });
    expect(f.field.value).toBe("new unsent draft");
  });
  it("does not interpret Shift/modified Enter or IME composition as submit", () => {
    const f = setup();
    f.input("多行\ntext");
    for (const modifier of [
      { shiftKey: true },
      { ctrlKey: true },
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
    expect(f.requests[0]?.body).toEqual({ kind: "followup", text: "多行\ntext" });
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
    await screen.findByText(/Not sure dot got that/);
    const retry = screen.getByRole("button", { name: "Send again" });
    act(() => {
      retry.click();
      retry.click();
      f.submit();
    });
    expect(f.requests).toHaveLength(2);
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(said().at(-1)).toBe("Sent to dot.");
  });
  it("checks the current field before retrying a captured ordinary request", async () => {
    const f = setup(() => {
      throw new Error("lost");
    });
    f.input("ordinary request");
    f.submit();
    await screen.findByText(/Not sure dot got that/);
    const key = `sk-proj-${"a".repeat(156)}`;
    f.field.value = key;
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    expect(f.requests).toHaveLength(1);
    expect(f.field.value).toBe("");
    expect(document.body.innerHTML).not.toContain(key);
    expect(screen.getByRole("button", { name: "Send again" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
  it("retains a refused new task when polling retires the stopped owner, but clears it on another task", async () => {
    const f = setup(() => new Response("refused", { status: 409 }), {
      agent: { ...agent, model: { ...emptyAgentModel(), ended: { reason: "stopped" } } },
    });
    f.input("explicit new task after Stop");
    f.submit();
    await screen.findByText(/Task not started/);
    f.update({ agent: { ...agent, sessionId: null, snapshot: null, fresh: false } });
    expect(screen.getByText(/Task not started/)).toBeTruthy();
    expect(f.field.value).toBe("explicit new task after Stop");
    expect(f.requests).toHaveLength(1);
    f.update({
      agent: {
        ...agent,
        sessionId: otherSession,
        snapshot: { ...snapshot, sessionId: otherSession },
      },
    });
    expect(screen.queryByText(/Task not started/)).toBeNull();
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
    expect(said()).toEqual(["Task started."]);
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
    expect(said()).not.toContain("Task started.");
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
    expect(screen.getByText(/Not sure dot got that/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send again" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    f.input("new unsent draft");
    f.submit();
    expect(f.requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep as draft" }));
    expect(f.field.value).toBe("new unsent draft");
    expect(screen.getByText(/dot may already have that message/)).toBeTruthy();
    expect(f.requests).toHaveLength(1);
    expect(screen.queryByLabelText("Message delivery")).toBeNull();
  });
  it("sends after this task from the menu or Option-Return, and labels paused/takeover messages honestly", async () => {
    const f = setup();
    f.input("afterwards");
    fireEvent.click(screen.getByRole("button", { name: "Message options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send after this task" }));
    expect(f.requests[0]?.body).toEqual({ kind: "followup", text: "afterwards" });
    expect(document.activeElement).toBe(f.field);
    await act(async () => {});
    f.input("later again");
    fireEvent.keyDown(f.field, { key: "Enter", altKey: true });
    expect(f.requests[1]?.body).toEqual({ kind: "followup", text: "later again" });
    await act(async () => {});
    f.update({ agent: { ...agent, snapshot: { ...snapshot, status: "paused" } } });
    expect(screen.queryByText("Sending won't resume the task")).toBeNull();
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeTruthy();
    f.update({ agent: { ...agent, model: { ...agent.model, pendingTakeover: otherSession } } });
    // While the user has the computer, the composer stays quiet about it: the island says so.
    expect(screen.queryByText("Sending won't resume the task")).toBeNull();
  });
  it("offers no choice of when to send once the task is idle, so Option-Return does nothing", async () => {
    const f = setup(undefined, { agent: { ...agent, snapshot: { ...snapshot, status: "idle" } } });
    fireEvent.click(screen.getByRole("button", { name: "Message options" }));
    expect(screen.queryByRole("menuitem", { name: "Send after this task" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    f.input("next");
    expect(fireEvent.keyDown(f.field, { key: "Enter", altKey: true })).toBe(false);
    expect(f.field.value).toBe("next");
    expect(f.requests).toEqual([]);
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(f.requests[0]?.body).toEqual({ kind: "followup", text: "next" });
    await act(async () => {});
  });
  // What it says is what Send already says, whichever way the message would go.
  it.each([
    ["stale", "Reconnecting to the task… Your message stays here."],
    ["paused computer", "Resume your computer first. Your message stays here."],
    ["pending computer", "Wait for your computer. Your message stays here."],
    ["unknown computer", "Checking your computer… Your message stays here."],
    ["Keys modal", "Reconnect and check the computer before sending."],
    ["offline", "You're offline. Your message stays here."],
  ] as const)("refuses even a forged submit while %s", async (reason, words) => {
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
    expect(screen.getByRole("alert").textContent).toBe(words);
  });
  it("checks pasted and synthetic-submit keys before delivery state, requests or a key preview", () => {
    const f = setup();
    const key = `sk-proj-${"a".repeat(156)}`;
    fireEvent.paste(f.field, { clipboardData: { getData: () => `before ${key} after` } });
    expect(f.field.value).toBe("before  after");
    f.submit();
    expect(f.requests).toEqual([]);
    expect(document.body.innerHTML).not.toContain(key);
    fireEvent.click(screen.getByRole("button", { name: "Discard key" }));
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
    const send = screen.getByRole("button", { name: "Queue message" }) as HTMLButtonElement;
    const blocked = () => send.getAttribute("aria-disabled") === "true";
    expect(blocked()).toBe(true);
    const described = (send.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described.join(" ")).toContain("A key in your message was taken out");
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    f.input(`${f.field.value} continue`);
    fireEvent.keyDown(f.field, { key: "Enter" });
    f.submit();
    expect(f.requests).toEqual([]);
    expect(blocked()).toBe(true);
    fireEvent.click(send);
    expect(f.requests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Discard key" }));
    expect(screen.queryByRole("region", { name: "Key safeguard" })).toBeNull();
    expect(document.activeElement).toBe(f.field);
    expect(blocked()).toBe(false);
    expect(send.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.keyDown(f.field, { key: "Enter" });
    await act(async () => {});
    expect(f.requests).toEqual([
      {
        path: `/api/agent/sessions/${sessionId}/messages`,
        body: { kind: "followup", text: "token  please continue" },
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
    expect(screen.queryByRole("button", { name: "Connect a model" })).toBeNull();
    const send = screen.getByRole("button", { name: "Start task" });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    const reason = (send.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(reason).toContain("Choose a model first");
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(onSettings).toHaveBeenCalledExactlyOnceWith(f.field);
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
    f.attach(one);
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
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    await waitFor(() => expect(said().at(-1)).toBe("Sent to dot."));
    expect(JSON.parse(String(calls[2]?.body))).toEqual({
      kind: "followup",
      text: "Read both sample files\n\nAttached files on this computer:\n- ~/Downloads/one.txt\n- ~/Downloads/two.txt",
    });
    expect(f.field.value).toBe("");
    // The chips fold away once the message carries the files.
    await waitFor(() => expect(screen.queryByText("Uploaded to Downloads")).toBeNull());
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
    f.attach(new File(["x"], "one.txt"));
    await screen.findByText("Unconfirmed");
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
    f.attach(new File(["x"], `${key}.txt`));
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
    f.attach(new File(["x"], "one.txt"));
    await screen.findByText("Uploaded to Downloads");
    f.submit();
    await screen.findByText(/Not sure dot got that/);
    f.input("New unsent draft");
    f.submit();
    expect(delivered).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(said().at(-1)).toBe("Sent to dot."));
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toBe(delivered[0]);
    expect(JSON.parse(delivered[0] as string).text).toContain("~/Downloads/one.txt");
    expect(f.field.value).toBe("New unsent draft");
    await waitFor(() => expect(screen.queryByText("Uploaded to Downloads")).toBeNull());
  });
});

describe("the composer's controls", () => {
  const reasonOf = (button: HTMLElement) =>
    (button.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  it("counts what is left only near the limit, where typing stops", () => {
    const f = setup();
    expect(f.field.maxLength).toBe(8000);
    f.input("x".repeat(7000));
    expect(screen.queryByText(/ left$/)).toBeNull();
    f.input("x".repeat(7500));
    expect(screen.getByText("500 left")).toBeTruthy();
    f.input("x".repeat(8000));
    expect(screen.getByText("0 left")).toBeTruthy();
    f.input("x".repeat(10));
    expect(screen.queryByText(/ left$/)).toBeNull();
  });
  it("starts a new line on Return on a phone, where Send sends", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const f = setup();
    f.input("Also add a chart");
    expect(fireEvent.keyDown(f.field, { key: "Enter" })).toBe(true);
    expect(f.requests).toEqual([]);
    const send = screen.getByRole("button", { name: "Queue message" });
    expect(send.hasAttribute("aria-keyshortcuts")).toBe(false);
    fireEvent.click(send);
    expect(f.requests).toHaveLength(1);
    await act(async () => {});
    // Sent from the menu, the message goes without bringing up the keyboard.
    f.input("Then the totals");
    fireEvent.click(screen.getByRole("button", { name: "Message options" }));
    const later = screen.getByRole("menuitem", { name: "Send after this task" });
    expect(later.hasAttribute("aria-keyshortcuts")).toBe(false);
    fireEvent.click(later);
    expect(f.requests[1]?.body).toEqual({ kind: "followup", text: "Then the totals" });
    expect(document.activeElement).not.toBe(f.field);
    await act(async () => {});
  });
  it("names Return as Send's shortcut where Return sends", () => {
    setup();
    expect(
      screen.getByRole("button", { name: "Queue message" }).getAttribute("aria-keyshortcuts"),
    ).toBe("Enter");
  });
  it("sends during a takeover with no files, and says when files can be added", async () => {
    const f = setup(undefined, {
      agent: { ...agent, model: { ...agent.model, pendingTakeover: otherSession } },
    });
    expect(reasonOf(screen.getByRole("button", { name: "Attach files" }))).toContain(
      "Add files once you hand back.",
    );
    f.input("Use the second sheet");
    f.submit();
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.requests).toEqual([
      {
        path: `/api/agent/sessions/${sessionId}/messages`,
        body: { kind: "followup", text: "Use the second sheet" },
      },
    ]);
  });
  it("waits for the hand-back while the user holds the computer with no task, then starts one", async () => {
    const f = setup(() => Response.json({ sessionId }, { status: 202 }), {
      configured: true,
      agent: {
        ...agent,
        snapshot: { ...snapshot, status: "idle", holder: true, pendingTakeover: otherSession },
      },
    });
    f.input("Now fill in the form");
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe(
      "Hand back the computer, then message dot. Your message stays here.",
    );
    expect(f.requests).toEqual([]);
    f.update({
      configured: true,
      agent: { ...agent, snapshot: { ...snapshot, status: "idle", holder: true } },
    });
    f.submit();
    await act(async () => {});
    expect(f.requests).toEqual([
      { path: `/api/cells/${cellId}/agent`, body: { task: "Now fill in the form" } },
    ]);
  });
  it("does nothing on Return with nothing written, and says why Send waits", () => {
    const f = setup();
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.requests).toEqual([]);
    expect(reasonOf(screen.getByRole("button", { name: "Queue message" }))).toContain(
      "Write a message first.",
    );
  });
  it("keeps a new task's draft while the computer is off and says what to do", () => {
    const f = setup(undefined, {
      cell: null,
      known: true,
      configured: true,
      agent: { ...agent, sessionId: null, snapshot: null, fresh: false },
    });
    f.input("Summarise the report");
    expect(reasonOf(screen.getByRole("button", { name: "Start task" }))).toContain(
      "Turn on your computer first.",
    );
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe(
      "Turn on your computer first. Your message stays here.",
    );
    expect(f.field.value).toBe("Summarise the report");
    expect(f.requests).toEqual([]);
  });
  it("asks for a task as a prompt, with no model or Stop of its own", () => {
    setup(undefined, {
      configured: true,
      agent: { ...agent, sessionId: null, snapshot: null, fresh: false },
    });
    expect(screen.getByRole("textbox", { name: "New task" }).getAttribute("placeholder")).toBe(
      "Ask dot to do something",
    );
    expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });
  it("invites a message that continues the conversation while an ended task is on show", async () => {
    const f = setup(
      () => Response.json({ sessionId: "01JXYZ0000000000000000NEXT" }, { status: 202 }),
      {
        agent: {
          ...agent,
          model: { ...emptyAgentModel(), ended: { reason: "stopped" } },
          snapshot: { sessionId, cellId, status: "ended", toolCalls: 0 },
          fresh: false,
        },
      },
    );
    expect(screen.getByRole("textbox", { name: "Message" }).getAttribute("placeholder")).toBe(
      "Message dot",
    );
    f.input("Now make it blue");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(f.requests).toEqual([
      { path: `/api/cells/${cellId}/agent`, body: { task: "Now make it blue" } },
    ]);
  });
  it("shows a dragged file over the card and adds what is dropped", async () => {
    transfer.trustNames = true;
    setup();
    const card = screen.getByRole("form", { name: "Message dot" });
    fireEvent.dragEnter(card, { dataTransfer: { types: ["Files"], files: [] } });
    expect(card.hasAttribute("data-dragging")).toBe(true);
    fireEvent.dragLeave(card, { dataTransfer: { types: ["Files"], files: [] } });
    expect(card.hasAttribute("data-dragging")).toBe(false);
    fireEvent.dragEnter(card, { dataTransfer: { types: ["Files"], files: [] } });
    fireEvent.drop(card, {
      dataTransfer: { types: ["Files"], files: [new File(["x"], "one.txt")] },
    });
    expect(card.hasAttribute("data-dragging")).toBe(false);
    await screen.findByText("Uploaded to Downloads");
    expect(screen.getByRole("list", { name: "Attached files" }).textContent).toContain("one.txt");
  });
  it("says politely that attachments went when the computer changed", async () => {
    transfer.trustNames = true;
    const f = setup();
    f.attach(new File(["x"], "one.txt"));
    await screen.findByText("Uploaded to Downloads");
    f.update({ cell: { ...cell, id: "01JXYZ00000000000000000CE2" } });
    const notice = screen.getByText(
      "Your computer was interrupted, so the files you added were removed. Add them again.",
    );
    expect(notice.closest("[role]")?.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a message on its way", () => {
  const user = (id: string, text: string): AgentMessage => ({
    id,
    role: "user",
    text,
    final: true,
  });
  it("waits at the end of the thread, faint while sent, and gives way to its own row", async () => {
    const outbox = document.createElement("div");
    document.body.append(outbox);
    const pending = Promise.withResolvers<Response>();
    const earlier = user("01JXYZ00000000000000000M01", "Add a chart");
    const model = { ...emptyAgentModel(), messages: new Map([[earlier.id, earlier]]) };
    const props: ComposerProps = {
      api: createApi("fixture", {
        origin: "http://127.0.0.1:4790",
        fetchImpl: async () => pending.promise,
      }),
      cell,
      agent: { ...agent, model },
      known: true,
      pending: false,
      keysOpen: false,
      receiveKey: vi.fn(() => false),
    };
    const end = { slot: outbox, show: vi.fn(), needs: vi.fn(), keep: vi.fn() };
    const view = render(
      <Outbox.Provider value={end}>
        <Composer {...props} />
      </Outbox.Provider>,
    );
    const field = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.input(field, { target: { value: "Add a chart" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const waiting = outbox.querySelector<HTMLElement>(".thread-pending");
    expect(waiting?.dataset.phase).toBe("sending");
    expect(waiting?.querySelector(".thread-bubble")?.textContent).toBe("Add a chart");
    expect(waiting?.querySelector(".thread-tag")?.textContent).toBe("After this task");
    expect(field.value).toBe("Add a chart");
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(outbox.querySelector<HTMLElement>(".thread-pending")?.dataset.phase).toBe("accepted");
    expect(field.value).toBe("");
    // The same words sent before are not this message's row.
    const rerender = (messages: AgentMessage[]) =>
      view.rerender(
        <Outbox.Provider value={end}>
          <Composer
            {...props}
            agent={{
              ...agent,
              model: { ...model, messages: new Map(messages.map((m) => [m.id, m])) },
            }}
          />
        </Outbox.Provider>,
      );
    rerender([earlier]);
    expect(outbox.querySelector(".thread-pending")).not.toBeNull();
    rerender([earlier, user("01JXYZ00000000000000000M02", "Add a chart")]);
    expect(outbox.querySelector(".thread-pending")).toBeNull();
    outbox.remove();
  });
  it("shows the files it carries and a refusal with the way back to the draft", async () => {
    transfer.trustNames = true;
    let refuse = false;
    const f = setup(() =>
      refuse ? new Response("no", { status: 409 }) : new Response(null, { status: 202 }),
    );
    f.attach(new File(["x"], "monthly-figures.csv"));
    await screen.findByText("Uploaded to Downloads");
    refuse = true;
    f.input("Use this");
    f.submit();
    const waiting = await screen.findByRole("region", { name: "Message delivery" });
    await waitFor(() => expect(waiting.textContent).toContain("Not sent"));
    expect(waiting.textContent).toContain("monthly-figures.csv");
    // A refused message was never sent while dot worked, so it says no such thing.
    expect(waiting.querySelector(".thread-tag")).toBeNull();
    expect(waiting.querySelector(".thread-bubble")?.textContent).toBe("Use this");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("region", { name: "Message delivery" })).toBeNull();
    expect(document.activeElement).toBe(f.field);
    expect(f.field.value).toBe("Use this");
  });
  it("settles a lost reply once the thread shows dot got it, and sends nothing again", async () => {
    transfer.trustNames = true;
    const text = withAttachments("Also add a chart", ["~/Downloads/totals.csv"]);
    // The same words sent before are not this message.
    const earlier = user("01JXYZ00000000000000000M01", text);
    const model = (...messages: AgentMessage[]) => ({
      ...emptyAgentModel(),
      messages: new Map(messages.map((message) => [message.id, message])),
    });
    let attempts = 0;
    const f = setup(
      () => {
        if (++attempts === 1) throw new Error("lost after acceptance");
        return new Response(null, { status: 202 });
      },
      { agent: { ...agent, model: model(earlier) } },
    );
    f.attach(new File(["x"], "totals.csv"));
    await screen.findByText("Uploaded to Downloads");
    f.input("Also add a chart");
    f.submit();
    await screen.findByText(/Not sure dot got that/);
    expect(f.requests[0]?.body).toEqual({ kind: "followup", text });
    f.update({ agent: { ...agent, model: model(earlier) } });
    expect(screen.getByText(/Not sure dot got that/)).toBeTruthy();
    f.update({
      agent: { ...agent, model: model(earlier, user("01JXYZ00000000000000000M02", text)) },
    });
    expect(screen.queryByRole("region", { name: "Message delivery" })).toBeNull();
    expect(f.field.value).toBe("");
    await waitFor(() => expect(screen.queryByText("Uploaded to Downloads")).toBeNull());
    expect(said()).toEqual(["Not sure dot got that.", "Sent to dot."]);
    expect(f.requests).toHaveLength(1);
    // Nothing waits on the lost message any more, so the next one goes.
    f.input("Then the totals");
    f.submit();
    await act(async () => {});
    expect(f.requests.map((request) => request.body)).toEqual([
      { kind: "followup", text },
      { kind: "followup", text: "Then the totals" },
    ]);
  });
  it("keeps what you wrote since when a lost reply settles", async () => {
    const f = setup(() => {
      throw new Error("lost after acceptance");
    });
    f.input("Also add a chart");
    f.submit();
    await screen.findByText(/Not sure dot got that/);
    f.input("Then the totals");
    f.update({
      agent: {
        ...agent,
        model: {
          ...emptyAgentModel(),
          messages: new Map([
            ["01JXYZ00000000000000000M02", user("01JXYZ00000000000000000M02", "Also add a chart")],
          ]),
        },
      },
    });
    expect(screen.queryByRole("region", { name: "Message delivery" })).toBeNull();
    expect(f.field.value).toBe("Then the totals");
    expect(f.requests).toHaveLength(1);
  });
  it("says how it went through the page's one polite region, never a live region of its own", async () => {
    const pending = Promise.withResolvers<Response>();
    let answer: () => Response | Promise<Response> = () => pending.promise;
    const f = setup(() => answer());
    const waiting = () => f.container.querySelector<HTMLElement>(".thread-pending");
    const live = () => waiting()?.querySelectorAll("[role=status], [role=alert], [aria-live]");
    f.input("Add a chart");
    f.submit();
    expect(waiting()?.dataset.phase).toBe("sending");
    expect(live()).toHaveLength(0);
    await act(async () => pending.resolve(new Response(null, { status: 202 })));
    expect(waiting()?.dataset.phase).toBe("accepted");
    expect(live()).toHaveLength(0);
    answer = () => new Response("no", { status: 409 });
    f.input("Add a table");
    f.submit();
    await waitFor(() => expect(waiting()?.dataset.phase).toBe("refused"));
    expect(live()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    answer = () => {
      throw new Error("lost");
    };
    f.submit();
    await waitFor(() => expect(waiting()?.dataset.phase).toBe("uncertain"));
    expect(live()).toHaveLength(0);
    expect(said()).toEqual(["Sent to dot.", "Not sent.", "Not sure dot got that."]);
  });
  it("brings the thread's end into view as it is sent, and leads a lost one's choice there", async () => {
    const outbox = document.createElement("div");
    document.body.append(outbox);
    const end = { slot: outbox, show: vi.fn(), needs: vi.fn(), keep: vi.fn() };
    render(
      <Outbox.Provider value={end}>
        <Composer
          api={createApi("fixture", {
            origin: "http://127.0.0.1:4790",
            fetchImpl: async () => {
              throw new Error("lost");
            },
          })}
          cell={cell}
          agent={agent}
          known
          pending={false}
          keysOpen={false}
          receiveKey={vi.fn(() => false)}
        />
      </Outbox.Provider>,
    );
    const field = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.input(field, { target: { value: "Add a chart" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(end.show).toHaveBeenCalledOnce();
    expect(end.needs).not.toHaveBeenCalled();
    await screen.findByText(/Not sure dot got that/);
    const reach = end.needs.mock.lastCall?.[0] as () => void;
    act(() => reach());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send again" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep as draft" }));
    expect(end.needs).toHaveBeenLastCalledWith(null);
    outbox.remove();
  });
});
describe("typing", () => {
  // Characters typed one at a time, as a keyboard sends them.
  const type = (field: HTMLTextAreaElement, text: string) => {
    for (const data of text) {
      field.value += data;
      fireEvent(field, new InputEvent("input", { bubbles: true, inputType: "insertText", data }));
    }
  };
  it("renders nothing per keystroke, and the task's updates leave the field alone", () => {
    const commits = vi.fn();
    const props: ComposerProps = {
      api: createApi("fixture", { origin: "http://127.0.0.1:4790" }),
      cell,
      agent,
      known: true,
      pending: false,
      keysOpen: false,
      receiveKey: vi.fn(() => false),
    };
    const view = render(
      <Profiler id="composer" onRender={commits}>
        <Composer {...props} />
      </Profiler>,
    );
    const field = screen.getByLabelText("Message") as HTMLTextAreaElement;
    const send = screen.getByRole("button", { name: "Queue message" });
    type(field, "A");
    expect(send.getAttribute("aria-disabled")).toBeNull();
    commits.mockClear();
    type(field, "dd a chart of the monthly totals");
    expect(commits).not.toHaveBeenCalled();
    const renders = counts.field;
    for (let update = 0; update < 5; update++)
      view.rerender(
        <Profiler id="composer" onRender={commits}>
          <Composer {...props} agent={{ ...agent, model: emptyAgentModel() }} />
        </Profiler>,
      );
    expect(commits).toHaveBeenCalled();
    expect(counts.field).toBe(renders);
    expect(field.value).toBe("Add a chart of the monthly totals");
  });
  it("checks typed text for keys once typing pauses, and at once on Send or leaving", async () => {
    const f = setup();
    const key = `sk-ant-api03-${"x".repeat(40)}`;
    counts.scans = 0;
    type(f.field, `token ${key}`);
    expect(counts.scans).toBe(0);
    expect(screen.queryByRole("region", { name: "Key safeguard" })).toBeNull();
    await waitFor(() => expect(f.field.value).toBe("token "));
    expect(counts.scans).toBe(1);
    expect(screen.getByRole("region", { name: "Key safeguard" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Queue message" }).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Discard key" }));

    type(f.field, key);
    fireEvent.keyDown(f.field, { key: "Enter" });
    expect(f.field.value).toBe("token ");
    expect(screen.getByRole("region", { name: "Key safeguard" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard key" }));

    type(f.field, key);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(f.field.value).toBe("token ");
    expect(f.requests).toEqual([]);
  });
});
describe("answering dot from the composer", () => {
  it("answers dot's question, turns it down before sending the message on, or holds the message", async () => {
    const reply = vi.fn<(text: string, attached: boolean) => Promise<ReplyOutcome>>();
    const f = setup(undefined, { reply });
    expect(f.field.placeholder).toBe("Answer dot");
    reply.mockResolvedValueOnce("answered");
    f.input("PDF");
    f.submit();
    await waitFor(() => expect(f.field.value).toBe(""));
    expect(reply).toHaveBeenLastCalledWith("PDF", false);
    expect(f.requests).toEqual([]);
    reply.mockResolvedValueOnce("declined");
    f.input("use my work account");
    f.submit();
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]).toEqual({
      path: `/api/agent/sessions/${sessionId}/messages`,
      body: { kind: "followup", text: "use my work account" },
    });
    reply.mockResolvedValueOnce({ hold: "Type it in dot's question above." });
    f.input("hunter2");
    f.submit();
    await screen.findByText("Type it in dot's question above.");
    expect(f.field.value).toBe("hunter2");
    expect(f.requests).toHaveLength(1);
    f.update({ reply: undefined });
    expect(f.field.placeholder).toBe("Message dot");
  });

  it("turns the question down before a message with files goes, rather than leaving it unread", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: async (url, init) => {
        const target = new URL(String(url));
        calls.push({ path: target.pathname, body: init?.body });
        return target.pathname.endsWith("/upload")
          ? Response.json({ path: "~/Downloads/plan.pdf" }, { status: 201 })
          : new Response(null, { status: 202 });
      },
    });
    const reply = vi.fn(async (_text: string, _attached: boolean): Promise<ReplyOutcome> => {
      return "declined";
    });
    const f = setup(undefined, { api, reply });
    f.input("Use this plan instead");
    f.attach(new File(["plan"], "plan.pdf"));
    await waitFor(() => expect(screen.getByText("Uploaded to Downloads")).toBeTruthy());
    f.submit();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(reply).toHaveBeenCalledExactlyOnceWith("Use this plan instead", true);
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      kind: "followup",
      text: "Use this plan instead\n\nAttached files on this computer:\n- ~/Downloads/plan.pdf",
    });
  });
});

describe("revising a result file", () => {
  const link = { sessionId, name: "totals.csv", version: 1 };
  it("fills the composer, keeps what was typed and focuses it", () => {
    const f = setup();
    f.input("add a total row");
    act(() => {
      requestRevise({ link, label: 1, newest: true });
    });
    expect(f.field.value).toBe("Revise totals.csv: add a total row");
    expect(document.activeElement).toBe(f.field);
    expect(screen.getByRole("button", { name: "Stop revising totals.csv" })).toBeTruthy();
  });
  it("sends a revision of an ended task to the revise route with the link", async () => {
    const next = "01JXYZ0000000000000000NEXT";
    const ended = { ...agent, model: { ...emptyAgentModel(), ended: { reason: "done" as const } } };
    const f = setup(() => Response.json({ sessionId: next }, { status: 202 }), {
      agent: ended,
      configured: true,
    });
    act(() => {
      requestRevise({ link, label: 1, newest: true });
    });
    f.input("Revise totals.csv: add a total row");
    f.submit();
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]).toEqual({
      path: `/api/agent/sessions/${sessionId}/files/totals.csv/revise`,
      body: { cellId, version: 1, text: "Revise totals.csv: add a total row" },
    });
  });
  it("sends a revision of an open task as a plain follow-up, and a removed chip drops the link", async () => {
    const idle = { ...agent, snapshot: { ...snapshot, status: "idle" as const } };
    const f = setup(undefined, { agent: idle });
    act(() => {
      requestRevise({ link, label: 1, newest: true });
    });
    f.input("Revise totals.csv: bigger chart");
    f.submit();
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]?.path).toBe(`/api/agent/sessions/${sessionId}/messages`);
    act(() => {
      requestRevise({ link, label: 1, newest: false });
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop revising totals.csv" }));
    f.input("Revise totals.csv: from the first one");
    f.submit();
    await waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.requests[1]?.path).toBe(`/api/agent/sessions/${sessionId}/messages`);
  });
  it("revises an older version of an open task in a new linked task", async () => {
    const next = "01JXYZ0000000000000000NEXT";
    const idle = { ...agent, snapshot: { ...snapshot, status: "idle" as const } };
    const f = setup(() => Response.json({ sessionId: next }, { status: 202 }), {
      agent: idle,
      configured: true,
    });
    act(() => {
      requestRevise({ link, label: 1, newest: false });
    });
    f.input("Revise totals.csv: start again from this one");
    f.submit();
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]?.path).toBe(`/api/agent/sessions/${sessionId}/files/totals.csv/revise`);
  });
  it("revises an earlier task's newest file in a new task linked to it, not as a follow-up", async () => {
    const next = "01JXYZ0000000000000000NEXT";
    const idle = { ...agent, snapshot: { ...snapshot, status: "idle" as const } };
    const f = setup(() => Response.json({ sessionId: next }, { status: 202 }), {
      agent: idle,
      configured: true,
    });
    act(() => {
      requestRevise({ link: { ...link, sessionId: otherSession }, label: 1, newest: true });
    });
    f.input("Revise totals.csv: add a total row");
    f.submit();
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]).toEqual({
      path: `/api/agent/sessions/${otherSession}/files/totals.csv/revise`,
      body: { cellId, version: 1, text: "Revise totals.csv: add a total row" },
    });
  });
  it("asks to wait before revising an earlier task's file while dot is working", async () => {
    const f = setup();
    act(() => {
      requestRevise({ link: { ...link, sessionId: otherSession }, label: 2, newest: true });
    });
    f.input("Revise totals.csv: x");
    f.submit();
    expect(await screen.findByText("Wait for dot to finish, then revise v2.")).toBeTruthy();
    expect(f.requests).toEqual([]);
  });
  it("lets the revising chip go once a message that no longer names the file is sent", async () => {
    const idle = { ...agent, snapshot: { ...snapshot, status: "idle" as const } };
    const f = setup(undefined, { agent: idle });
    act(() => {
      requestRevise({ link, label: 1, newest: true });
    });
    f.input("Thanks, that's all");
    f.submit();
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]?.path).toBe(`/api/agent/sessions/${sessionId}/messages`);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop revising totals.csv" })).toBeNull(),
    );
  });
  it("asks to wait before revising an older version while dot is working", async () => {
    const f = setup();
    act(() => {
      requestRevise({ link, label: 1, newest: false });
    });
    f.input("Revise totals.csv: x");
    f.submit();
    expect(await screen.findByText("Wait for dot to finish, then revise v1.")).toBeTruthy();
    expect(f.requests).toEqual([]);
  });
});
