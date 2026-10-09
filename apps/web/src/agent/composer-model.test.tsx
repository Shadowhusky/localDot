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
const cell: CellSummary = {
  id: cellId,
  state: "ready",
  scale: 2,
  createdAt: "t",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
const task = (status: "idle" | "running"): AgentSessionView => ({
  sessionId,
  model: emptyAgentModel(),
  snapshot: { sessionId, cellId, status, toolCalls: 3 },
  availability: "ready",
  error: null,
  fresh: true,
  connection: "live",
  reconcile: vi.fn(),
});
afterEach(cleanup);

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
  const view = render(
    <Composer
      api={api}
      cell={cell}
      agent={agent}
      known
      pending={false}
      keysOpen={false}
      receiveKey={vi.fn(() => false)}
      {...over}
    />,
  );
  const field = view.container.querySelector("textarea") as HTMLTextAreaElement;
  return {
    requests,
    send: async (text: string) => {
      fireEvent.input(field, { target: { value: text } });
      await act(async () => fireEvent.submit(screen.getByRole("form", { name: "Message dot" })));
    },
  };
}

describe("a model chosen since the task started", () => {
  it("starts the conversation's next task on it, rather than following up on the old model", async () => {
    const f = setup(task("idle"), { modelChanged: true });
    screen.getByRole("button", { name: "Send" });
    await f.send("Now do March");
    expect(f.requests).toEqual([
      { path: `/api/cells/${cellId}/agent`, body: { task: "Now do March" } },
    ]);
  });

  it("follows up as before when the model is the task's own", async () => {
    const f = setup(task("idle"));
    screen.getByRole("button", { name: "Send follow-up" });
    await f.send("Now do March");
    expect(f.requests[0]?.path).toBe(`/api/agent/sessions/${sessionId}/messages`);
  });

  it("leaves a task at work alone: a message still steers it", async () => {
    const f = setup(task("running"), { modelChanged: true });
    await f.send("Use the blue theme");
    expect(f.requests).toEqual([
      {
        path: `/api/agent/sessions/${sessionId}/messages`,
        body: { kind: "steer", text: "Use the blue theme" },
      },
    ]);
  });

  it("shows the model chip in a card's row, and keeps a phone's field to its words", () => {
    setup(task("idle"), { model: <button type="button">Claude Opus</button> });
    screen.getByRole("button", { name: "Claude Opus" });
    cleanup();
    setup(task("idle"), { layout: "pill", model: <button type="button">Claude Opus</button> });
    expect(screen.queryByRole("button", { name: "Claude Opus" })).toBeNull();
  });
});
