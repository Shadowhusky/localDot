// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action } from "../actions/actions.ts";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";
import { emptyAgentModel } from "./model.ts";
import { researchQuestion } from "./research.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

vi.mock("../ui/Announcer.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/Announcer.tsx")>()),
  announce: vi.fn(),
}));

const cellId = "01JXYZ0000000000000000CE11";
const sessionId = "01JXYZ0000000000000000SESS";
const cell: CellSummary = {
  id: cellId,
  state: "ready",
  scale: 2,
  createdAt: "t",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
const working: AgentSessionView = {
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
  localStorage.clear();
  cleanup();
  vi.unstubAllGlobals();
});

function setup(actions: Action[], over: Partial<ComposerProps> = {}) {
  const requests: { path: string; body: unknown }[] = [];
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/voice") return Response.json({ onMac: { available: false } });
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return path.endsWith("/agent")
        ? Response.json({ sessionId }, { status: 202 })
        : new Response(null, { status: 202 });
    },
  });
  const props: ComposerProps = {
    api,
    cell,
    agent: working,
    known: true,
    pending: false,
    keysOpen: false,
    receiveKey: vi.fn(() => false),
    actions,
    ...over,
  };
  render(<Composer {...props} />);
  const field =
    (screen.queryByLabelText("Message") as HTMLTextAreaElement | null) ??
    (screen.getByLabelText("New task") as HTMLTextAreaElement);
  const type = (text: string) => fireEvent.input(field, { target: { value: text } });
  const key = (name: string, extra: Partial<KeyboardEventInit> = {}) =>
    fireEvent.keyDown(field, { key: name, ...extra });
  const options = () => screen.queryAllByRole("option").map((row) => row.textContent);
  const active = () =>
    document.getElementById(field.getAttribute("aria-activedescendant") ?? "")?.textContent;
  return { field, type, key, options, active, requests };
}
const command = (over: Partial<Action> & Pick<Action, "id">): Action => ({
  title: over.id,
  command: over.id,
  description: `About ${over.id}`,
  group: "Task",
  run: vi.fn(),
  ...over,
});

describe("slash commands", () => {
  it('lists every command at "/", filters as the name is typed, and leaves other text alone', () => {
    const f = setup([
      command({ id: "btw", hint: "<question>", input: "required" }),
      command({ id: "stop" }),
      command({ id: "resume" }),
      command({ id: "rename", input: "optional" }),
    ]);
    expect(f.field.getAttribute("aria-autocomplete")).toBe("list");
    f.type("/");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    expect(f.options()).toEqual([
      "/btw<question>About btw",
      "/stopAbout stop",
      "/resumeAbout resume",
      "/renameAbout rename",
    ]);
    expect(f.field.getAttribute("aria-controls")).toBe(
      screen.getByRole("listbox", { name: "Commands" }).id,
    );
    f.type("/re");
    expect(f.options()).toEqual(["/resumeAbout resume", "/renameAbout rename"]);
    for (const message of ["/usr/bin is slow", "hello /btw", " /stop"]) {
      f.type(message);
      expect(screen.queryByRole("listbox")).toBeNull();
    }
  });

  it("moves with the arrows, completes with Tab, runs with Enter and never sends a command to dot", async () => {
    const stop = command({ id: "stop" });
    const btw = command({ id: "btw", hint: "<question>", input: "required" });
    const f = setup([stop, command({ id: "status" }), btw]);
    f.type("/st");
    expect(f.active()).toBe("/stopAbout stop");
    f.key("ArrowDown");
    expect(f.active()).toBe("/statusAbout status");
    f.key("ArrowDown");
    expect(f.active()).toBe("/stopAbout stop");
    f.key("ArrowUp");
    expect(f.active()).toBe("/statusAbout status");
    f.type("/b");
    f.key("Tab");
    expect(f.field.value).toBe("/btw ");
    expect(screen.getByRole("option").textContent).toBe("/btw<question>About btw");
    // A command that needs words says so and stays.
    f.key("Enter");
    expect(await screen.findByText("Write the question after /btw.")).toBeTruthy();
    expect(f.field.value).toBe("/btw ");
    f.type("/btw is it nearly done?");
    expect(f.options()).toEqual(["btw“is it nearly done?”"]);
    f.key("Enter");
    await waitFor(() => expect(btw.run).toHaveBeenCalledOnce());
    expect(btw.run).toHaveBeenCalledWith(
      expect.objectContaining({ text: "is it nearly done?", trigger: f.field }),
    );
    await waitFor(() => expect(f.field.value).toBe(""));
    f.type("/sto");
    f.key("Enter", { metaKey: true });
    await waitFor(() => expect(stop.run).toHaveBeenCalledOnce());
    expect(f.requests).toEqual([]);
    expect(JSON.parse(localStorage.getItem("localdot.recent-actions.v1") ?? "[]")).toEqual([
      "stop",
      "btw",
    ]);
  });

  it("closes on Escape keeping the words, and Send still runs the command", async () => {
    const btw = command({ id: "btw", hint: "<question>", input: "required" });
    const f = setup([btw]);
    f.type("/btw why?");
    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      f.field.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(f.field.value).toBe("/btw why?");
    const send = screen.getByRole("button", { name: "Run /btw" });
    fireEvent.click(send);
    await waitFor(() =>
      expect(btw.run).toHaveBeenCalledWith(expect.objectContaining({ text: "why?" })),
    );
    expect(f.requests).toEqual([]);
    f.type("/b");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("sends words that only look like a command once the user sends them a second time", async () => {
    const f = setup([command({ id: "btw" })]);
    f.type("/imagine a cat");
    expect(screen.getByRole("status").textContent).toContain("There's no /imagine command");
    f.key("Enter");
    expect(await screen.findByText(/Send again to send it to dot as you wrote it/)).toBeTruthy();
    expect(f.requests).toEqual([]);
    f.key("Enter");
    await waitFor(() =>
      expect(f.requests).toEqual([
        {
          path: `/api/agent/sessions/${sessionId}/messages`,
          body: { kind: "followup", text: "/imagine a cat" },
        },
      ]),
    );
  });

  it("says why a command can't run now, and keeps the words", async () => {
    const stop = command({ id: "stop", unavailable: "Nothing is running" });
    const f = setup([stop]);
    f.type("/stop");
    expect(f.options()).toEqual(["/stopNothing is running"]);
    expect(screen.getByRole("option").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Run /stop" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    f.key("Enter");
    expect((await screen.findByRole("alert")).textContent).toBe("Nothing is running");
    expect(stop.run).not.toHaveBeenCalled();
    expect(f.field.value).toBe("/stop");
  });

  it("offers a command's choices, loaded when it asks, and runs the one picked by key or press", async () => {
    let finish!: (rows: { value: string; label: string }[]) => void;
    const resume = command({
      id: "resume",
      choices: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const model = command({
      id: "model",
      choices: [
        { value: "gpt", label: "GPT-6", detail: "ChatGPT plan" },
        { value: "opus", label: "Claude Opus", detail: "Claude Code", current: true },
      ],
    });
    const f = setup([resume, model]);
    f.type("/model");
    f.key("Enter");
    expect(f.field.value).toBe("/model ");
    expect(f.options()).toEqual(["GPT-6ChatGPT plan", "Claude OpusClaude Code"]);
    f.key("ArrowDown");
    f.key("Enter");
    await waitFor(() =>
      expect(model.run).toHaveBeenCalledWith(
        expect.objectContaining({ choice: expect.objectContaining({ value: "opus" }) }),
      ),
    );
    f.type("/resume trip");
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    await act(async () =>
      finish([
        { value: "a", label: "Trip to Lisbon" },
        { value: "b", label: "Taxes" },
      ]),
    );
    expect(f.options()).toEqual(["Trip to Lisbon"]);
    const row = screen.getByRole("option");
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    row.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    fireEvent.click(row);
    await waitFor(() =>
      expect(resume.run).toHaveBeenCalledWith(
        expect.objectContaining({ choice: { value: "a", label: "Trip to Lisbon" } }),
      ),
    );
  });

  it("shows a failed command's reason and keeps what was written", async () => {
    const remember = command({
      id: "remember",
      input: "required",
      run: vi.fn(async () => "Memory can't change right now."),
    });
    const f = setup([remember]);
    f.type("/remember I take my coffee black");
    f.key("Enter");
    expect(await screen.findByText("Memory can't change right now.")).toBeTruthy();
    expect(f.field.value).toBe("/remember I take my coffee black");
  });

  it("asks the composer to research a question at once", async () => {
    const f = setup([], {
      agent: { ...working, sessionId: null, snapshot: null },
    });
    act(() => researchQuestion("Compare the three cheapest e-bikes"));
    await waitFor(() =>
      expect(f.requests).toEqual([
        {
          path: `/api/cells/${cellId}/agent`,
          body: { task: "Compare the three cheapest e-bikes", continues: null, mode: "research" },
        },
      ]),
    );
  });
});
