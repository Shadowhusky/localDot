// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { Action } from "./actions.ts";
import { onComposerFill } from "./actions.ts";
import { type ActionsInput, useActions } from "./useActions.ts";

const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../ui/Toast.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/Toast.tsx")>()),
  showToast: toasts.showToast,
}));
vi.mock("../ui/Announcer.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/Announcer.tsx")>()),
  announce: vi.fn(),
}));
afterEach(() => {
  cleanup();
  toasts.showToast.mockClear();
});

const SESSION = "01JXYZ0000000000000000SESS";
const OLDER = "01JXYZ0000000000000000AAA1";
type Reply = (method: string, path: string, body: unknown) => Response | Promise<Response>;

function setup(
  over: Partial<ActionsInput> = {},
  reply: Reply = () => new Response(null, { status: 204 }),
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async (url, init) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      return reply(method, path, body);
    },
  });
  const doable = (reason?: string) => ({ reason, run: vi.fn() });
  const input: ActionsInput = {
    api,
    phone: false,
    sessionId: SESSION,
    stop: doable(),
    continue: doable("Nothing is paused"),
    take: doable(),
    handBack: doable("dot has the computer"),
    aside: { aside: null, ask: vi.fn(), retry: vi.fn(), showUsage: vi.fn(), dismiss: vi.fn() },
    newConversation: doable(),
    conversations: {
      current: SESSION,
      facts: { live: SESSION, idle: false, needsYou: new Set() },
      pick: vi.fn(),
      renamed: vi.fn(),
    },
    replay: doable(),
    watch: doable("You're watching already"),
    models: {
      groups: [
        {
          label: "Claude Code",
          options: [
            {
              id: "cc:opus",
              name: "Claude Opus",
              choice: { provider: "claude-code", model: "opus" },
            },
            {
              id: "cc:haiku",
              name: "Claude Haiku",
              choice: { provider: "claude-code", model: "haiku" },
            },
          ],
        },
      ],
      current: "cc:opus",
      choose: vi.fn(),
    },
    persona: { value: "everyday", choose: vi.fn() },
    plans: true,
    refreshUsage: vi.fn(),
    report: vi.fn(),
    view: vi.fn(),
    files: doable("No files yet"),
    previews: doable(),
    chatPanel: { shown: true, toggle: vi.fn() },
    fullScreen: { ...doable(), on: false },
    settings: vi.fn(),
    appearance: { value: "graphite", change: vi.fn() },
    otherDots: [],
    stopAll: doable(),
    newRoutine: vi.fn(),
    shortcuts: vi.fn(),
    ...over,
  };
  const view = renderHook((props: ActionsInput) => useActions(props), { initialProps: input });
  const find = (id: string) => view.result.current.actions.find((each) => each.id === id) as Action;
  const run = (id: string, given: Partial<Parameters<Action["run"]>[0]> = {}) =>
    find(id).run({ text: "", trigger: null, ...given });
  return { input, view, find, run, calls };
}

describe("the actions", () => {
  it("offers the commands localDot has, each saying when it can't run", () => {
    const f = setup();
    expect(f.view.result.current.actions.flatMap((each) => each.command ?? [])).toEqual([
      "btw",
      "stop",
      "continue",
      "takeover",
      "handback",
      "new",
      "resume",
      "rename",
      "replay",
      "research",
      "model",
      "dot",
      "remember",
      "usage",
      "report",
      "help",
      "shortcuts",
    ]);
    expect(f.find("continue").unavailable).toBe("Nothing is paused");
    expect(f.find("handback").unavailable).toBe("dot has the computer");
    expect(f.find("files").unavailable).toBe("No files yet");
    expect(f.view.result.current.suggested.slice(0, 3)).toEqual(["stop", "btw", "takeover"]);
    const none = setup({
      sessionId: null,
      conversations: { ...f.input.conversations, current: null },
    });
    expect(none.find("btw").unavailable).toBe("Start a task first");
    expect(none.find("rename").unavailable).toBe("Start a conversation first");
  });

  it("runs what each stands for, and only when it can", () => {
    const f = setup();
    f.run("stop");
    expect(f.input.stop.run).toHaveBeenCalledOnce();
    f.run("continue");
    expect(f.input.continue.run).not.toHaveBeenCalled();
    f.run("btw", { text: "Which flight is cheaper?" });
    expect(f.input.aside.ask).toHaveBeenCalledWith("Which flight is cheaper?");
    f.run("usage");
    expect(f.input.refreshUsage).toHaveBeenCalledOnce();
    expect(f.input.aside.showUsage).toHaveBeenCalledOnce();
    f.run("model", { choice: { value: "cc:haiku", label: "Claude Haiku" } });
    expect(f.input.models.choose).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cc:haiku", name: "Claude Haiku" }),
    );
    expect(f.find("model").choices).toEqual([
      { value: "cc:opus", label: "Claude Opus", detail: "Claude Code", current: true },
      { value: "cc:haiku", label: "Claude Haiku", detail: "Claude Code", current: false },
    ]);
    f.run("dot", { choice: { value: "coder", label: "Coder" } });
    expect(f.input.persona.choose).toHaveBeenCalledWith("coder");
    const trigger = document.createElement("button");
    f.run("report", { text: "It stopped on the login page", trigger });
    expect(f.input.report).toHaveBeenCalledWith(trigger, "It stopped on the login page");
    f.run("settings-section", { choice: { value: "models", label: "Models" }, trigger });
    expect(f.input.settings).toHaveBeenCalledWith(trigger, "models");
    f.run("appearance", { choice: { value: "midnight", label: "Midnight" } });
    expect(f.input.appearance.change).toHaveBeenCalledWith("midnight");
    f.run("appearance", { choice: { value: "system", label: "System" } });
    expect(f.input.appearance.change).toHaveBeenCalledWith("system");
    f.run("appearance", { choice: { value: "daylight", label: "Daylight" } });
    expect(f.input.appearance.change).toHaveBeenCalledWith("daylight");
    f.run("view-activity");
    expect(f.input.view).toHaveBeenCalledWith("activity");
    const fill = vi.fn();
    const stop = onComposerFill(fill);
    f.run("help");
    stop();
    expect(fill).toHaveBeenCalledWith("/");
  });

  it("renames the conversation through its title route, or gives it back its automatic title", async () => {
    const f = setup();
    await expect(f.run("rename", { text: " Trip to Lisbon " })).resolves.toBeUndefined();
    await expect(
      f.run("rename", { choice: { value: "auto", label: "Use the automatic title" } }),
    ).resolves.toBeUndefined();
    expect(f.calls).toEqual([
      {
        method: "POST",
        path: `/api/conversations/${SESSION}/title`,
        body: { title: "Trip to Lisbon" },
      },
      { method: "POST", path: `/api/conversations/${SESSION}/title`, body: { title: null } },
    ]);
    expect(f.input.conversations.renamed).toHaveBeenCalledTimes(2);
    await expect(f.run("rename", { text: "x".repeat(81) })).resolves.toBe(
      "Use a name of 1–80 characters.",
    );
    expect(f.calls).toHaveLength(2);
    const refused = setup({}, () => new Response("no", { status: 404 }));
    await expect(refused.run("rename", { text: "Taxes" })).resolves.toBe(
      "Couldn't rename the conversation. Try again.",
    );
    expect(refused.input.conversations.renamed).not.toHaveBeenCalled();
  });

  it("remembers a fact in dot's notes, saying why when it can't", async () => {
    const f = setup({}, () => Response.json({ changeId: SESSION }, { status: 201 }));
    await expect(f.run("remember", { text: "I take my coffee black" })).resolves.toBeUndefined();
    expect(f.calls).toEqual([
      {
        method: "POST",
        path: "/api/agent/memory/entries",
        body: { file: "MEMORY.md", text: "I take my coffee black" },
      },
    ]);
    expect(toasts.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "dot will remember that" }),
    );
    const busy = setup({}, () => new Response("busy", { status: 503 }));
    await expect(busy.run("remember", { text: "x" })).resolves.toBe(
      "Memory can't change right now. Try again in a moment.",
    );
  });

  it("lists the conversations to switch to, and opens the one picked with its tasks", async () => {
    const f = setup({}, () =>
      Response.json({
        conversations: [
          {
            sessionId: SESSION,
            sessions: [SESSION],
            title: "Trip to Lisbon",
            said: "Find flights",
            startedAt: new Date().toISOString(),
            ended: null,
          },
          {
            sessionId: OLDER,
            sessions: [OLDER, SESSION],
            title: null,
            said: "Do my taxes",
            startedAt: "2026-01-02T10:00:00Z",
            ended: "done",
          },
        ],
      }),
    );
    const load = f.find("resume").choices as (signal: AbortSignal) => Promise<unknown>;
    const choices = await load(new AbortController().signal);
    expect(f.calls).toEqual([{ method: "GET", path: "/api/conversations", body: undefined }]);
    expect(choices).toMatchObject([
      { value: SESSION, label: "Trip to Lisbon", current: true, keywords: "Find flights" },
      {
        value: OLDER,
        label: "Do my taxes",
        detail: expect.stringMatching(/^Done · /),
        current: false,
      },
    ]);
    f.run("resume", { choice: { value: OLDER, label: "Do my taxes" } });
    expect(f.input.conversations.pick).toHaveBeenCalledWith(OLDER, [OLDER, SESSION]);
  });

  it("draws its users again only when what the actions show changes", async () => {
    const f = setup();
    const first = f.view.result.current.actions;
    f.view.rerender({ ...f.input, stop: { reason: undefined, run: vi.fn() }, report: vi.fn() });
    expect(f.view.result.current.actions).toBe(first);
    f.view.rerender({ ...f.input, stop: { reason: "Stopping…", run: vi.fn() } });
    await waitFor(() => expect(f.view.result.current.actions).not.toBe(first));
    expect(f.find("stop").unavailable).toBe("Stopping…");
  });
});
