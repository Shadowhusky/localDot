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
