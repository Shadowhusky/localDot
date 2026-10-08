// @vitest-environment jsdom
import type { PauseSnapshot } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { type ApiClient, createApi } from "../lib/api.ts";
import type { LiveSession } from "../session/useLiveSession.ts";
import { type AgentFeed, type AgentFeedState, type AgentModel, emptyAgentModel } from "./model.ts";
import { SafetyControls } from "./SafetyControls.tsx";
import { TaskRecovery } from "./TaskRecovery.tsx";
import { useAgentSession } from "./useAgentSession.ts";
import { useSafety } from "./useSafety.ts";
import { useTaskControls } from "./useTaskControls.ts";

const CELL = "01JXYZ0000000000000000CE11";
const SESSION = "01JXYZ0000000000000000SESS";
const PAUSE: PauseSnapshot = {
  requestId: "01JXYZ00000000000000000003",
  revision: 2,
  phase: "paused",
  reason: "user",
  atStepBoundary: true,
  resumeAvailable: true,
};
const cell: CellSummary = {
  id: CELL,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// A daemon that holds a Paused task at a spending limit: Resume is refused until the task's budget
// is raised, as the real route does.
function daemon(scope: "task" | "day") {
  const state = {
    hold: scope as "task" | "day" | undefined,
    pause: PAUSE as PauseSnapshot | undefined,
    raises: [] as number[],
    resumes: [] as number[],
  };
  let model: AgentModel = {
    ...emptyAgentModel(),
    state: { state: "paused", reason: "budget" },
    budget: {
      id: "01JXYZ00000000000000000002",
      at: 1,
      data:
        scope === "task"
          ? { scope, taskId: SESSION, limitUSD: 5, spentUSD: 5, needUSD: 1 }
          : { scope, limitUSD: 20, spentUSD: 20 },
    },
    safetyPause: PAUSE,
  };
  let feedState: AgentFeedState = {
    cellId: CELL,
    sessionId: SESSION,
    epoch: 3,
    connection: "live",
    replayed: true,
    streamError: null,
    model,
  };
  const listeners = new Set<() => void>();
  const feed: AgentFeed = {
    read: () => feedState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const publish = (next: Partial<AgentModel>) => {
    model = { ...model, ...next };
    feedState = { ...feedState, epoch: feedState.epoch + 1, model };
    for (const listener of listeners) listener();
  };
  const path = `/api/agent/sessions/${SESSION}`;
  const api = createApi("budget-pause-token", {
    origin: "https://owned.invalid",
    fetchImpl: async (url, init) => {
      const route = new URL(String(url)).pathname;
      if (route === path && (init?.method ?? "GET") === "GET")
        return Response.json({
          sessionId: SESSION,
          cellId: CELL,
          status: "paused",
          toolCalls: 3,
          models: { kind: "api", roles: [{ role: "main", provider: "anthropic", model: "m" }] },
          ...(state.pause ? { pause: state.pause } : {}),
          ...(state.hold ? { budgetHold: state.hold } : {}),
        });
      if (route === `${path}/budget`) {
        state.raises.push(JSON.parse(String(init?.body)).budgetUSD);
        state.hold = undefined;
        return new Response(null, { status: 204 });
      }
      if (route === `${path}/resume`) {
        state.resumes.push(JSON.parse(String(init?.body)).revision);
        if (state.hold === "task")
          return new Response("Raise this task's budget before resuming it.", { status: 409 });
        state.pause = undefined;
        queueMicrotask(() => publish({ safetyPause: undefined, state: { state: "thinking" } }));
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    },
  });
  return { api, feed, state };
}
function Task({ api, feed }: { api: ApiClient; feed: AgentFeed }) {
  const live = { sessionId: SESSION, agentFeed: feed } as LiveSession;
  const agent = useAgentSession(api, cell, live);
  const controls = useTaskControls({
    api,
    cell,
    cellPending: null,
    agent,
    feed,
    suspended: false,
    manualVisible: false,
    refreshCell() {},
  });
  const safety = useSafety({
    api,
    cell,
    agent,
    feed,
    blocked: false,
    visible: true,
    selectReady: async () => true,
  });
  return (
    <>
      <SafetyControls safety={safety} agent={agent} cell={cell} />
      <TaskRecovery agent={agent} controls={controls} onSettings={() => {}} />
    </>
  );
}
function open(scope: "task" | "day") {
  document.body.tabIndex = -1;
  document.body.focus();
  const fake = daemon(scope);
  render(<Task api={fake.api} feed={fake.feed} />);
  return fake;
}
const resume = () => screen.getByRole("button", { name: "Resume task" }) as HTMLButtonElement;

it("a Pause held at the task's spending limit offers the budget form, then Resume once it is raised", async () => {
  const fake = open("task");
  const recovery = await screen.findByRole("region", { name: "Task recovery" });
  const ceiling = screen.getByLabelText("New task ceiling (USD)") as HTMLInputElement;
  await waitFor(() => expect(ceiling.disabled).toBe(false));
  expect(recovery.textContent).toContain("reached its spending limit");
  expect(document.body.textContent).toContain("set a new task budget in Conversation, then resume");
  expect(resume().disabled, "Resume waits for the budget").toBe(true);
  fireEvent.change(ceiling, { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "Set task budget" }));
  await waitFor(() => expect(fake.state.raises).toEqual([8]));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Task recovery" })).toBeNull());
  await waitFor(() => expect(resume().disabled).toBe(false));
  expect(fake.state.resumes, "no Resume was sent before the raise").toEqual([]);
  await act(async () => {
    fireEvent.click(resume());
  });
  expect(fake.state.resumes).toEqual([PAUSE.revision]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Resume task" })).toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a Pause held at the shared daily limit explains it and keeps Resume available", async () => {
  const fake = open("day");
  const recovery = await screen.findByRole("region", { name: "Task recovery" });
  expect(recovery.textContent).toContain("today's is used up. It resets at midnight");
  expect(screen.queryByLabelText("New task ceiling (USD)")).toBeNull();
  await waitFor(() => expect(resume().disabled).toBe(false));
  await act(async () => {
    fireEvent.click(resume());
  });
  expect(fake.state.resumes).toEqual([PAUSE.revision]);
  expect(fake.state.raises).toEqual([]);
});
