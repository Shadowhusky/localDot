// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import type { LiveSession } from "../session/useLiveSession.ts";
import { memoryUndoEligible } from "./activity.ts";
import { KnowledgeView } from "./KnowledgeView.tsx";
import { type AgentFeed, emptyAgentModel } from "./model.ts";
import { useAgentSession } from "./useAgentSession.ts";
import { useKnowledge } from "./useKnowledge.ts";
import { useTaskControls } from "./useTaskControls.ts";

const CELL = "01JXYZ0000000000000000CE11";
const SESSION = "01JXYZ0000000000000000SESS";
const CHANGE = "01JXYZ00000000000000000001";
const EVENT = "01JXYZ00000000000000000002";
const ready: CellSummary = {
  id: CELL,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "live", viewers: 0, lastUpstreamAt: null },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function terminal(status: 200 | 404) {
  const model = {
    ...emptyAgentModel(),
    ended: { reason: "done" as const },
    changes: [
      {
        id: EVENT,
        type: "memory" as const,
        path: "MEMORY.md",
        changeId: CHANGE,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        truncated: false,
      },
    ],
  };
  const feed: AgentFeed = {
    read: () => ({
      cellId: CELL,
      sessionId: SESSION,
      epoch: 2,
      connection: "ended",
      replayed: true,
      streamError: null,
      model,
    }),
    subscribe: () => () => {},
  };
  const api = createApi("inert-review-token", {
    origin: "https://owned.invalid",
    fetchImpl: async () =>
      status === 200
        ? Response.json({ sessionId: SESSION, cellId: CELL, status: "ended", toolCalls: 0 })
        : new Response("no such live task", { status: 404 }),
  });
  // useAgentSession reads only these existing owner fields; no socket/decoder is created.
  const live = { sessionId: SESSION, agentFeed: feed } as LiveSession;
  return renderHook(() => {
    const agent = useAgentSession(api, ready, live);
    const controls = useTaskControls({
      api,
      cell: ready,
      cellPending: null,
      agent,
      feed,
      suspended: false,
      manualVisible: false,
      refreshCell() {},
    });
    return { agent, controls };
  });
}
it("positive control permits finished-history Undo with the author fixture's synthetic ended snapshot", async () => {
  const view = terminal(200);
  await waitFor(() => expect(view.result.current.agent.availability).toBe("ready"));
  expect(view.result.current.controls.canUndoMemory).toBe(true);
  expect(view.result.current.controls.canResumeTask).toBe(false);
  expect(view.result.current.controls.canInput).toBe(false);
});
it("refuses an arbitrary terminal 404 even when retained history contains an eligible change", async () => {
  const view = terminal(404);
  await waitFor(() => expect(view.result.current.agent.availability).toBe("missing"));
  const { agent, controls } = view.result.current;
  expect(agent.model.ended?.reason).toBe("done");
  expect(agent.model.changes).toHaveLength(1);
  expect(memoryUndoEligible(agent.model.changes[0]!, agent.model.changes)).toBe(true);
  expect(controls.canResumeTask).toBe(false);
  expect(controls.canInput).toBe(false);
  expect(
    controls.canUndoMemory,
    "missing terminal authority never becomes mutation permission",
  ).toBe(false);
});

function KnowledgeFixture({ api }: { api: ReturnType<typeof createApi> }) {
  return <KnowledgeView knowledge={useKnowledge(api, SESSION, true)} />;
}
it.each(["hidden", "offline"] as const)(
  "re-enables explicit memory reread after an in-flight %s cancellation",
  async (kind) => {
    let hidden = false,
      online = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const late = Promise.withResolvers<Response>();
    const requests: { path: string; signal?: AbortSignal | null }[] = [];
    const api = createApi("inert-review-token", {
      origin: "https://owned.invalid",
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, signal: init?.signal });
        return path.endsWith("/skills") ? Response.json([]) : late.promise;
      },
    });
    render(<KnowledgeFixture api={api} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check skills" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    act(() => screen.getByRole("button", { name: "Read current memory" }).click());
    expect(screen.getByRole("button", { name: "Read current memory" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(requests).toHaveLength(2);
    await act(async () => {
      if (kind === "hidden") {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        online = false;
        window.dispatchEvent(new Event("offline"));
      }
    });
    expect(requests[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      hidden = false;
      online = true;
      if (kind === "hidden") document.dispatchEvent(new Event("visibilitychange"));
      else window.dispatchEvent(new Event("online"));
      late.resolve(Response.json({ user: "stale retired result", memory: "stale" }));
    });
    expect(document.body.textContent).not.toContain("stale retired result");
    expect(requests, "no automatic replay of cancelled read").toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Read current memory" }),
      "the cancelled request must leave a usable explicit retry",
    ).toHaveProperty("disabled", false);
  },
);
