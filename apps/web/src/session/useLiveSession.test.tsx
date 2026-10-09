// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { useLiveSession } from "./useLiveSession.ts";

const CELL = "01JXYZ0000000000000000CELL",
  SESSION = "01JXYZ0000000000000000SESS",
  NEXT = "01JXYZ0000000000000000NEXT";
const ready: CellSummary = {
  id: CELL,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup(seen?: (view: ReturnType<typeof useLiveSession>) => void) {
  let live: string | null = null;
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/live"))
      return live ? Response.json({ sessionId: live }) : new Response(null, { status: 204 });
    return Response.json({ originMicros: 0, serverMicros: 0 });
  });
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
  const stage = { current: null };
  const view = renderHook(() => {
    const session = useLiveSession(api, ready, stage);
    seen?.(session);
    return session;
  });
  return {
    view,
    polls: () =>
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith(`/cells/${CELL}/live`))
        .length,
    start: (id: string) => {
      live = id;
    },
  };
}
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it("slows to one look every five seconds while the computer has no task", async () => {
  const error = vi.spyOn(console, "error");
  const f = setup();
  await wait(5_000);
  const quick = f.polls();
  expect(quick).toBeGreaterThanOrEqual(5);
  await wait(55_000);
  expect(f.polls() - quick).toBeLessThanOrEqual(11);
  expect(f.view.result.current.sessionId).toBeNull();
  expect(error).not.toHaveBeenCalled();
});

it("looks again at once when a task is started from this page", async () => {
  const f = setup();
  await wait(30_000);
  f.start(SESSION);
  const before = f.polls();
  await act(async () => {
    f.view.result.current.check();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(f.polls()).toBe(before + 1);
  expect(f.view.result.current.sessionId).toBe(SESSION);
});

it("never shows the previous task's activity under a new task's id", async () => {
  const shown: { sessionId: string | null; title: string | null }[] = [];
  const f = setup((session) =>
    shown.push({ sessionId: session.sessionId, title: session.model.title }),
  );
  f.start(SESSION);
  await wait(1_000);
  const event = (seq: number, type: string, data: unknown) =>
    JSON.stringify(
      LocalDotEvent.parse({
        v: 1,
        id: String(seq + 1).padStart(26, "0"),
        seq,
        t: seq * 1000,
        agent: "main",
        type,
        data,
      }),
    );
  const socket = FakeWebSocket.instances[0];
  await act(async () => {
    socket?.onopen?.();
    socket?.onmessage?.({
      data: event(0, "session.start", {
        screen: { w: 1280, h: 800, scale: 1 },
        os: "linux",
        title: "First task",
      }),
    });
    socket?.onmessage?.({ data: event(1, "session.end", { reason: "stopped" }) });
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(f.view.result.current.model.title).toBe("First task");
  f.start(NEXT);
  await wait(1_000);
  expect(f.view.result.current.sessionId).toBe(NEXT);
  const next = shown.filter((entry) => entry.sessionId === NEXT);
  expect(next.length).toBeGreaterThan(0);
  expect(next.every((entry) => entry.title === null)).toBe(true);
});

const EARLIER = "01JXYZ00000000000000EARLY1";
function event(seq: number, type: string, data: unknown) {
  return JSON.stringify(
    LocalDotEvent.parse({
      v: 1,
      id: String(seq + 1).padStart(26, "0"),
      seq,
      t: seq * 1000,
      agent: "main",
      type,
      data,
    }),
  );
}
const START = { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: "Draw a dog" };
// The conversation's latest task (`resting`) and the computer change between renders.
function conversing(initial: { resting?: string | null; cell?: CellSummary | null } = {}) {
  let live: string | null = null;
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/live"))
      return live ? Response.json({ sessionId: live }) : new Response(null, { status: 204 });
    return Response.json({ originMicros: 0, serverMicros: 0 });
  });
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
  const stage = { current: null };
  const view = renderHook(
    ({ cell, resting }: { cell: CellSummary | null; resting?: string | null }) =>
      useLiveSession(api, cell, stage, resting),
    { initialProps: { cell: initial.cell === undefined ? ready : initial.cell, ...initial } },
  );
  const socketFor = (id: string) =>
    FakeWebSocket.instances.findLast((socket) => socket.url.includes(`/sessions/${id}/`));
  return {
    view,
    run: (id: string | null) => {
      live = id;
    },
    socketFor,
    play: async (id: string, ...events: string[]) => {
      const socket = socketFor(id);
      await act(async () => {
        socket?.onopen?.();
        for (const data of events) socket?.onmessage?.({ data });
        await vi.advanceTimersByTimeAsync(100);
      });
    },
  };
}

it("reopens the conversation's latest task, at rest, when the computer runs none", async () => {
  const f = conversing({ resting: EARLIER });
  await wait(1_000);
  expect(f.view.result.current).toMatchObject({ sessionId: EARLIER, resting: true, ended: true });
  await f.play(EARLIER, event(0, "session.start", START));
  expect(f.view.result.current.model.title).toBe("Draw a dog");
  expect(f.view.result.current.ended).toBe(true);
});

it("shows the conversation with the computer off, and gives way to a task the computer starts", async () => {
  const off = { ...ready, state: "stopped" as const };
  const f = conversing({ resting: EARLIER, cell: off });
  await wait(1_000);
  expect(f.view.result.current.sessionId).toBe(EARLIER);
  f.run(SESSION);
  f.view.rerender({ cell: ready, resting: EARLIER });
  await wait(1_000);
  expect(f.view.result.current).toMatchObject({ sessionId: SESSION, resting: false, ended: false });
});

it("keeps a task the daemon lost on show, at rest, so the next message starts a task", async () => {
  const f = conversing({ resting: EARLIER });
  f.run(SESSION);
  await wait(1_000);
  await f.play(SESSION, event(0, "session.start", START));
  expect(f.view.result.current).toMatchObject({ sessionId: SESSION, ended: false });
  // The daemon restarted: no end was recorded and the computer runs no task.
  f.run(null);
  await wait(5_000);
  expect(f.view.result.current).toMatchObject({ sessionId: SESSION, resting: true, ended: true });
  expect(f.view.result.current.model.ended).toEqual({ t: 0, reason: "stopped" });
});

it("clears the page for a new conversation once the live task has ended, and never brings it back", async () => {
  const f = conversing({ resting: SESSION });
  f.run(SESSION);
  await wait(1_000);
  f.view.rerender({ cell: ready, resting: null });
  await wait(100);
  // The finished task waits for a follow-up until the daemon ends it.
  expect(f.view.result.current.sessionId).toBe(SESSION);
  await f.play(
    SESSION,
    event(0, "session.start", START),
    event(1, "session.end", { reason: "done" }),
  );
  await wait(100);
  expect(f.view.result.current.sessionId).toBeNull();
  // An answer sent before the daemon ended it still names it.
  await wait(5_000);
  expect(f.view.result.current.sessionId).toBeNull();
});

it("shows an older conversation chosen to continue in place of the one at rest", async () => {
  const f = conversing({ resting: SESSION });
  await wait(1_000);
  expect(f.view.result.current.sessionId).toBe(SESSION);
  f.view.rerender({ cell: ready, resting: EARLIER });
  await wait(100);
  expect(f.view.result.current).toMatchObject({ sessionId: EARLIER, resting: true });
  expect(f.socketFor(EARLIER)).toBeDefined();
});

it("pays no heed to an answer about the computer's task asked before a new conversation was chosen", async () => {
  const answers: ((response: Response) => void)[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/live"))
      return new Promise<Response>((resolve) => {
        answers.push(resolve);
      });
    return Response.json({ originMicros: 0, serverMicros: 0 });
  });
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
  const view = renderHook(
    ({ resting, choice }: { resting: string | null; choice: number }) =>
      useLiveSession(api, ready, { current: null }, resting, choice),
    { initialProps: { resting: SESSION as string | null, choice: 0 } },
  );
  await wait(100);
  await act(async () => answers.shift()?.(new Response(null, { status: 204 })));
  await wait(1_000);
  expect(view.result.current.sessionId).toBe(SESSION);
  expect(answers).toHaveLength(1);
  view.rerender({ resting: null, choice: 1 });
  await wait(100);
  expect(view.result.current.sessionId).toBeNull();
  // The daemon answered before it ended the finished task for the new conversation.
  await act(async () => answers.shift()?.(Response.json({ sessionId: SESSION })));
  await wait(0);
  expect(view.result.current.sessionId).toBeNull();
  // and is asked again straight away.
  expect(answers).toHaveLength(1);
});

it("on opening, shows a task the computer still runs as running, never as stopped meanwhile", async () => {
  let answer!: (response: Response) => void;
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/live"))
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    return Response.json({ originMicros: 0, serverMicros: 0 });
  });
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
  const shown: { sessionId: string | null; ended: boolean }[] = [];
  const view = renderHook(
    ({ resting }: { resting?: string }) => {
      const session = useLiveSession(api, ready, { current: null }, resting);
      shown.push({ sessionId: session.sessionId, ended: session.ended });
      return session;
    },
    { initialProps: {} },
  );
  // The conversation is read back while the computer's answer is on its way.
  await wait(100);
  view.rerender({ resting: SESSION });
  await wait(200);
  await act(async () => answer(Response.json({ sessionId: SESSION })));
  await wait(100);
  expect(view.result.current).toMatchObject({ sessionId: SESSION, resting: false, ended: false });
  expect(shown.filter((entry) => entry.sessionId === SESSION && entry.ended)).toEqual([]);
});
