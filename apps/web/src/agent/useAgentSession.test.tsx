// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { useLiveSession } from "../session/useLiveSession.ts";
import type { StageHandle } from "../stage/Stage.tsx";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { useAgentSession } from "./useAgentSession.ts";

const CELL = "01JXYZ0000000000000000ABCD",
  NEXT_CELL = "01JXYZ0000000000000000ABCE";
const SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
  NEXT_SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0P",
  ASK = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0Q";
const id = (n: number) => String(n).padStart(26, "0");
const cell = (id = CELL): CellSummary => ({
  id,
  state: "ready",
  scale: 2,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
});
const snapshot = (sessionId = SESSION, cellId = CELL, status = "running", pendingAsk?: string) => ({
  sessionId,
  cellId,
  status,
  toolCalls: 0,
  ...(pendingAsk ? { pendingAsk } : {}),
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const ev = (seq: number, type: string, data: unknown) =>
  JSON.stringify(
    LocalDotEvent.parse({
      v: 1,
      id: id(seq + 1),
      seq: seq + 1,
      t: (seq + 1) * 1000,
      agent: "main",
      type,
      data,
    }),
  );
const flush = () => act(async () => {});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
function server(
  status: (session: string, signal?: AbortSignal | null) => Response | Promise<Response>,
) {
  const calls: string[] = [],
    signals: (AbortSignal | null | undefined)[] = [];
  const api = createApi("inert", {
    origin: "http://fixture",
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith("/live"))
        return json({ sessionId: path.includes(NEXT_CELL) ? NEXT_SESSION : SESSION });
      if (path.startsWith("/api/agent/sessions/")) {
        signals.push(init?.signal);
        return status(path.split("/").at(-1) ?? "", init?.signal);
      }
      return json({ originMicros: 0, t: 0 });
    },
  });
  return { api, calls, signals };
}
function hook(api: ReturnType<typeof createApi>, currentCell = cell()) {
  return renderHook(
    ({ api, currentCell }) => {
      const stage = useRef<StageHandle | null>(null);
      const live = useLiveSession(api, currentCell, stage);
      return { live, agent: useAgentSession(api, currentCell, live) };
    },
    { initialProps: { api, currentCell } },
  );
}
function socket() {
  const s = FakeWebSocket.instances.at(-1);
  expect(s).toBeDefined();
  return s as FakeWebSocket;
}
const open = () =>
  act(() => {
    socket().onopen?.();
    socket().onmessage?.({
      data: JSON.stringify(
        LocalDotEvent.parse({
          v: 1,
          id: id(0),
          seq: 0,
          t: 0,
          agent: "main",
          type: "session.start",
          data: { screen: { w: 1280, h: 800, scale: 1 }, os: "linux" },
        }),
      ),
    });
  });
const send = (data: string) => act(() => socket().onmessage?.({ data }));

it("requires the selected screen event and snapshot to agree before any manual control", async () => {
  const selected = {
    screen: "browser",
    cellId: NEXT_CELL,
    revision: 1,
    geometry: { w: 1280, h: 800, scale: 1 },
  };
  let current = {
    ...snapshot(),
    screen: { ...selected, screen: "desktop", cellId: CELL, revision: 0 },
  };
  const f = server(() => json(current));
  const { result } = hook(f.api);
  await flush();
  open();
  await flush();
  expect(result.current.agent.fresh).toBe(true);
  send(ev(0, "screen.switch", { ...selected, by: "agent" }));
  await flush();
  expect(result.current.agent.fresh).toBe(false);
  expect(result.current.agent.model.screen?.cellId).toBe(NEXT_CELL);
  current = { ...snapshot(), screen: selected };
  await advance(1000);
  expect(result.current.agent.fresh).toBe(true);
  current = { ...snapshot(), screen: { ...selected, revision: 2 } };
  await advance(1000);
  expect(result.current.agent.fresh).toBe(false);
  send(ev(1, "screen.switch", { ...selected, revision: 2, by: "daemon" }));
  await flush();
  expect(result.current.agent.fresh).toBe(true);
});
beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("requires the replacement API socket and its duplicate replay while retaining one history", async () => {
  const first = server(() => json(snapshot()));
  const next = server(() => json(snapshot()));
  const { result, rerender } = hook(first.api);
  await flush();
  open();
  await flush();
  const message = ev(0, "message.user", { messageId: ASK, text: "Retained history", kind: "task" });
  send(message);
  await advance(100);
  expect(result.current.agent.fresh).toBe(true);
  const previous = socket();
  rerender({ api: next.api, currentCell: cell() });
  await flush();
  expect(previous.closed).toBe(true);
  expect(result.current.agent.connection).toBe("connecting");
  expect(result.current.agent.fresh).toBe(false);
  act(() => socket().onopen?.());
  await flush();
  expect(result.current.agent.fresh).toBe(false);
  send(message);
  await flush();
  expect(result.current.agent.fresh).toBe(true);
  expect(result.current.agent.model.messages.size).toBe(1);
  expect(FakeWebSocket.instances).toHaveLength(2);
});
it("waits for this connection's replay and repairs a gap before readiness", async () => {
  const { api } = server(() => json(snapshot()));
  const { result } = hook(api);
  await flush();
  open();
  await flush();
  act(() => socket().onclose?.());
  await advance(500);
  act(() => socket().onopen?.());
  await flush();
  expect(result.current.agent.fresh).toBe(false);
  send(ev(1, "agent.state", { state: "acting" }));
  await flush();
  expect(result.current.agent.fresh).toBe(false);
  send(ev(0, "agent.state", { state: "thinking" }));
  await flush();
  expect(result.current.agent.fresh).toBe(false);
  send(ev(1, "agent.state", { state: "acting" }));
  await flush();
  expect(result.current.agent.fresh).toBe(true);
  expect(result.current.agent.model.lastSeq).toBe(2);
});
it("does not count malformed replacement replay as current readiness", async () => {
  const { api } = server(() => json(snapshot()));
  const { result } = hook(api);
  await flush();
  open();
  await flush();
  act(() => socket().onclose?.());
  await advance(500);
  act(() => socket().onopen?.());
  send("bad-json");
  await flush();
  expect(result.current.agent.fresh).toBe(false);
  expect(result.current.agent.error).not.toBeNull();
});

it("owns one socket, publishes deltas on the existing flush, and retains results for idle follow-ups", async () => {
  const { api } = server(() => json(snapshot()));
  const { result } = hook(api);
  await flush();
  open();
  await flush();
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(result.current.agent.fresh).toBe(true);
  send(ev(0, "message.delta", { messageId: ASK, text: "Hello" }));
  await advance(100);
  expect(result.current.agent.model.messages.get(ASK)?.text).toBe("Hello");
  send(ev(1, "task.result", { summary: "First result", files: [] }));
  send(ev(2, "agent.state", { state: "idle" }));
  await advance(100);
  expect(result.current.agent.model.results).toHaveLength(1);
  expect(result.current.live.ended).toBe(false);
  send(ev(3, "message.user", { messageId: NEXT_SESSION, text: "Follow up", kind: "followup" }));
  await advance(100);
  expect(result.current.agent.model.messages.size).toBe(2);
  expect(FakeWebSocket.instances).toHaveLength(1);
});
it("discards a late snapshot that predates a newer question, then reads the matching epoch", async () => {
  const first = Promise.withResolvers<Response>(),
    second = Promise.withResolvers<Response>();
  let reads = 0;
  const { api } = server(() => (++reads === 1 ? first.promise : second.promise));
  const { result } = hook(api);
  await flush();
  open();
  send(ev(0, "ask.request", { askId: ASK, question: "Which?", options: [], allowText: true }));
  expect(result.current.agent.fresh).toBe(false);
  await act(async () => {
    first.resolve(json(snapshot()));
  });
  expect(result.current.agent.snapshot).toBeNull();
  expect(result.current.agent.model.pendingAsk).toBe(ASK);
  expect(reads).toBe(2);
  await act(async () => {
    second.resolve(json(snapshot(SESSION, CELL, "waiting_user", ASK)));
  });
  expect(result.current.agent.snapshot?.pendingAsk).toBe(ASK);
  expect(result.current.agent.fresh).toBe(true);
});
it("invalidates an already applied question snapshot when the answer arrives, without clearing history", async () => {
  let answered = false;
  const slow = Promise.withResolvers<Response>();
  const { api } = server(() =>
    answered ? slow.promise : json(snapshot(SESSION, CELL, "waiting_user", ASK)),
  );
  const { result } = hook(api);
  await flush();
  open();
  await flush();
  send(ev(0, "ask.request", { askId: ASK, question: "Which?", options: [], allowText: true }));
  await flush();
  expect(result.current.agent.fresh).toBe(true);
  answered = true;
  send(ev(1, "ask.answer", { askId: ASK, text: "One", by: "user" }));
  expect(result.current.agent.model.pendingAsk).toBeNull();
  expect(result.current.agent.fresh).toBe(false);
  await act(async () => {
    slow.resolve(json(snapshot()));
  });
  expect(result.current.agent.fresh).toBe(true);
  expect(result.current.agent.snapshot?.pendingAsk).toBeUndefined();
  expect(result.current.agent.model.questions.get(ASK)?.answer?.text).toBe("One");
});
it("cancels old-cell reads and rejects their late reply after the identity changes", async () => {
  const stale = Promise.withResolvers<Response>();
  const { api, signals } = server((session) =>
    session === SESSION ? stale.promise : json(snapshot(NEXT_SESSION, NEXT_CELL)),
  );
  const { result, rerender } = hook(api);
  await flush();
  open();
  send(ev(0, "message.user", { messageId: ASK, text: "Old task", kind: "task" }));
  rerender({ api, currentCell: cell(NEXT_CELL) });
  await flush();
  open();
  await flush();
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => {
    stale.resolve(json(snapshot()));
  });
  expect(result.current.agent.sessionId).toBe(NEXT_SESSION);
  expect(result.current.agent.snapshot?.cellId).toBe(NEXT_CELL);
  expect(result.current.agent.model.messages.size).toBe(0);
  expect(FakeWebSocket.instances).toHaveLength(2);
});
it("keeps history on reconnect and ignores answered-question replay with duplicate seq", async () => {
  const { api } = server(() => json(snapshot()));
  const { result } = hook(api);
  await flush();
  open();
  await flush();
  const request = ev(0, "ask.request", {
    askId: ASK,
    question: "Which?",
    options: [],
    allowText: true,
  });
  send(request);
  send(ev(1, "ask.answer", { askId: ASK, text: "One", by: "user" }));
  await flush();
  act(() => socket().onclose?.());
  expect(result.current.agent.fresh).toBe(false);
  expect(result.current.agent.connection).toBe("lost");
  await advance(500);
  open();
  send(request);
  await flush();
  expect(result.current.agent.model.pendingAsk).toBeNull();
  expect(result.current.agent.model.questions.size).toBe(1);
  expect(result.current.agent.fresh).toBe(true);
  expect(FakeWebSocket.instances).toHaveLength(2);
});
it("never lets a ready task snapshot override a paused cell or a malformed stream", async () => {
  const { api } = server(() => json(snapshot()));
  const { result, rerender } = hook(api);
  await flush();
  open();
  await flush();
  send(ev(0, "message.user", { messageId: ASK, text: "Keep history", kind: "task" }));
  await advance(100);
  rerender({ api, currentCell: { ...cell(), paused: true } });
  expect(result.current.agent.fresh).toBe(false);
  expect(result.current.agent.model.messages.size).toBe(1);
  expect(FakeWebSocket.instances).toHaveLength(1);
  rerender({ api, currentCell: cell() });
  send('{"token":"inert-do-not-echo"}');
  await flush();
  expect(result.current.agent.error).toBe(
    "Activity could not be verified. Reconnect to load it again.",
  );
  expect(result.current.agent.fresh).toBe(false);
  expect(result.current.agent.model.messages.size).toBe(1);
});
it("preserves history on status404 and reports fixed errors for unsafe status bodies", async () => {
  let mode = "ready";
  const { api } = server(() =>
    mode === "missing"
      ? json({}, 404)
      : mode === "bad"
        ? json({ credential: "inert-do-not-echo" })
        : json(snapshot()),
  );
  const { result } = hook(api);
  await flush();
  open();
  await flush();
  send(ev(0, "message.assistant", { messageId: ASK, text: "History" }));
  await advance(100);
  mode = "missing";
  await advance(1000);
  expect(result.current.agent.availability).toBe("missing");
  expect(result.current.agent.fresh).toBe(false);
  expect(result.current.agent.model.messages.get(ASK)?.text).toBe("History");
  mode = "bad";
  await advance(1000);
  expect(result.current.agent.error).toBe(
    "Task status is unavailable. Check the connection and try again.",
  );
  expect(result.current.agent.fresh).toBe(false);
});
it("fences stale thinking after Stop/session.end and aborts status reads on unmount", async () => {
  const { api, signals, calls } = server(() => json(snapshot()));
  const { result, unmount } = hook(api);
  await flush();
  open();
  await flush();
  send(ev(0, "agent.state", { state: "thinking" }));
  send(ev(1, "session.end", { reason: "stopped" }));
  send(ev(2, "agent.state", { state: "acting" }));
  await flush();
  expect(result.current.agent.model.ended?.reason).toBe("stopped");
  expect(result.current.agent.model.state?.state).toBe("thinking");
  expect(result.current.agent.fresh).toBe(false);
  expect(socket().closed).toBe(true);
  unmount();
  const count = calls.length;
  await advance(2000);
  expect(calls).toHaveLength(count);
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});

it("waits for an actual replay event as well as a valid snapshot before trusting task controls", async () => {
  const { api } = server(() => json(snapshot()));
  const { result } = hook(api);
  await flush();
  act(() => socket().onopen?.());
  await flush();
  expect(result.current.agent.snapshot?.status).toBe("running");
  expect(result.current.agent.fresh).toBe(false);
  open();
  await advance(100);
  expect(result.current.agent.fresh).toBe(true);
});
it("holds controls until snapshot pending ownership and replayed request details agree", async () => {
  const { api } = server(() => json(snapshot(SESSION, CELL, "waiting_user", ASK)));
  const { result } = hook(api);
  await flush();
  open();
  await flush();
  expect(result.current.agent.fresh).toBe(false);
  send(ev(0, "ask.request", { askId: ASK, question: "Which?", options: [], allowText: true }));
  await flush();
  expect(result.current.agent.fresh).toBe(true);
});

it("requires a fresh terminal snapshot for memory history, then stops automatic polling", async () => {
  const terminal = Promise.withResolvers<void>();
  let ended = false;
  const { api, calls } = server(() =>
    ended ? terminal.promise.then(() => json(snapshot(SESSION, CELL, "ended"))) : json(snapshot()),
  );
  const { result } = hook(api);
  await flush();
  open();
  await flush();
  expect(result.current.agent.readFresh).toBe(true);
  ended = true;
  send(ev(0, "session.end", { reason: "done" }));
  expect(result.current.agent.fresh).toBe(false);
  expect(result.current.agent.readFresh).toBe(false);
  await act(async () => terminal.resolve());
  expect(result.current.agent.readFresh).toBe(true);
  expect(result.current.agent.fresh).toBe(false);
  const count = calls.filter((path) => path.startsWith("/api/agent/sessions/")).length;
  await advance(3000);
  expect(calls.filter((path) => path.startsWith("/api/agent/sessions/"))).toHaveLength(count);
  act(() => result.current.agent.reconcile());
  await flush();
  expect(calls.filter((path) => path.startsWith("/api/agent/sessions/"))).toHaveLength(count + 1);
});

it("reads a task at rest as ended, whatever status the daemon can still give for it", async () => {
  for (const reply of [
    () => new Response("no such live task", { status: 404 }),
    // It ran on a computer that has since been replaced.
    () => json(snapshot(SESSION, NEXT_CELL, "ended")),
  ]) {
    const api = createApi("inert", {
      origin: "http://fixture",
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/live")) return new Response(null, { status: 204 });
        if (path.startsWith("/api/agent/sessions/")) return reply();
        return json({ originMicros: 0, t: 0 });
      },
    });
    const view = renderHook(() => {
      const stage = useRef<StageHandle | null>(null);
      const live = useLiveSession(api, cell(), stage, SESSION);
      return useAgentSession(api, cell(), live);
    });
    await advance(1000);
    open();
    await advance(1000);
    expect(view.result.current.snapshot?.status).toBe("ended");
    expect(view.result.current.model.ended).toEqual({ reason: "stopped" });
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.fresh).toBe(false);
    view.unmount();
  }
});
it("does not render the app again for a status poll that brings the same answer", async () => {
  const f = server(() => json(snapshot()));
  let commits = 0;
  renderHook(() => {
    const stage = useRef<StageHandle | null>(null);
    const live = useLiveSession(f.api, cell(), stage);
    const agent = useAgentSession(f.api, cell(), live);
    useEffect(() => {
      commits++;
    });
    return agent;
  });
  await flush();
  open();
  await advance(4000);
  const settled = commits;
  const polls = f.calls.filter((path) => path.startsWith("/api/agent/sessions/")).length;
  await advance(3000);
  expect(f.calls.filter((path) => path.startsWith("/api/agent/sessions/")).length).toBe(polls + 3);
  expect(commits).toBe(settled);
});
